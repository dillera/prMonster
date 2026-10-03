import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ deepRunning: false, scanRunning: false }));

vi.mock("../src/server/deep.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/deep.js")>();
  return { ...actual, anyDeepRunning: () => state.deepRunning };
});
vi.mock("../src/server/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/issues.js")>();
  return { ...actual, runningIssueScan: () => (state.scanRunning ? { id: "iscan_x" } : null) };
});
vi.mock("../src/server/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/store.js")>();
  // The restart is logged to data/admin-log.json; keep the real log clean.
  return { ...actual, ensureDataDir: () => undefined, writeJsonAtomic: () => undefined };
});

const { app, restartHooks, RESTART_EXIT_CODE } = await import("../src/server/index.js");

async function restart(body: unknown = {}, host = "localhost:8787") {
  const res = await app.request("/api/admin/restart", {
    method: "POST",
    headers: { "content-type": "application/json", host },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/admin/restart", () => {
  const exits: number[] = [];
  const realExit = restartHooks.exit;

  beforeEach(() => {
    exits.length = 0;
    restartHooks.exit = (code) => void exits.push(code);
    restartHooks.delayMs = 0;
    state.deepRunning = false;
    state.scanRunning = false;
    process.env["PRMONSTER_SUPERVISED"] = "1";
  });
  afterEach(() => {
    restartHooks.exit = realExit;
    delete process.env["PRMONSTER_SUPERVISED"];
  });

  it("answers only to localhost", async () => {
    const { status } = await restart({}, "evil.example:8787");
    expect(status).toBe(403);
  });

  it("refuses when nothing would start the server again", async () => {
    delete process.env["PRMONSTER_SUPERVISED"];
    const { status, json } = await restart();
    expect(status).toBe(409);
    expect(json["supervised"]).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(exits).toEqual([]);
  });

  it("postpones while work is in flight, and goes ahead with force", async () => {
    state.deepRunning = true;
    state.scanRunning = true;
    const blocked = await restart();
    expect(blocked.status).toBe(409);
    expect(String(blocked.json["error"])).toMatch(/^not restarting while an issue scan and a deep analysis run is running/);
    expect(blocked.json["busy"]).toEqual(["an issue scan", "a deep analysis run"]);

    const forced = await restart({ force: true });
    expect(forced.status).toBe(202);
    await new Promise((r) => setTimeout(r, 5));
    expect(exits).toEqual([RESTART_EXIT_CODE]);
  });

  it("answers 202 with its pid before exiting with the restart code", async () => {
    const { status, json } = await restart();
    expect(status).toBe(202);
    expect(json["pid"]).toBe(process.pid);
    await new Promise((r) => setTimeout(r, 5));
    expect(exits).toEqual([75]);
  });

  it("reports the process in /api/health so the UI can see a restart happen", async () => {
    const res = await app.request("/api/health");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["pid"]).toBe(process.pid);
    expect(typeof body["startedAt"]).toBe("string");
    expect(body["supervised"]).toBe(true);
  });
});

describe("scripts/supervise.mjs", () => {
  const supervisor = resolve(__dirname, "../scripts/supervise.mjs");

  it("starts the child again after exit code 75, and stops with any other code", () => {
    const dir = mkdtempSync(join(tmpdir(), "prmonster-supervise-"));
    const counter = join(dir, "count");
    writeFileSync(counter, "0");
    const child = join(dir, "child.mjs");
    writeFileSync(
      child,
      `import { readFileSync, writeFileSync } from "node:fs";
       const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
       writeFileSync(${JSON.stringify(counter)}, String(n));
       if (process.env.PRMONSTER_SUPERVISED !== "1") process.exit(9);
       process.exit(n < 3 ? 75 : 4);`,
    );
    const res = spawnSync(process.execPath, [supervisor, "--", process.execPath, child], { encoding: "utf8", timeout: 20_000 });
    expect(readFileSync(counter, "utf8")).toBe("3");
    expect(res.status).toBe(4);
    expect(res.stderr).toContain("restart requested from the admin page");
  });
});
