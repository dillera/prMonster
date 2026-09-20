import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSettings } from "../src/shared/types.js";

// The admin API rewrites whatever DOTENV_PATH points at, so every test here
// gets its own throwaway .env and never touches the project's own.
const scratch = mkdtempSync(resolve(tmpdir(), "prmonster-settings-"));
const ENV_PATH = resolve(scratch, ".env");
process.env["DOTENV_PATH"] = ENV_PATH;

const { app } = await import("../src/server/index.js");
const { looksDerivedFrom, maskSecret, readSettings, renderDotenv, resetRestartRequired } = await import(
  "../src/server/settings.js"
);
const { jevMode } = await import("../src/server/pipeline.js");
const { writesEnabled } = await import("../src/server/github.js");

const SAMPLE = `# Copy to .env and fill in.

# TypeSafe AI key for Jev.
TYPESAFE_API_KEY=apikey_0123456789abcdef

# GitHub REST v3 token. Optional: falls back to \`gh auth token\`.
# GITHUB_TOKEN= (removed: GitHub returned 401 for this token)
#GITHUB_TOKEN=github_pat_oldvaluehere

# Repository to triage, as owner/name.
GITHUB_REPO=FujiNetWIFI/fujinet-firmware

# Tool-calling rounds before a run aborts.
DEEP_MAX_STEPS=30
`;

/** Keys these tests move around, restored after each one. */
const TOUCHED = [
  "TYPESAFE_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_REPO",
  "DEEP_MAX_STEPS",
  "ALLOW_GITHUB_WRITES",
  "JEV_MOCK",
  "JEV_TRANSPORT",
  "PORT",
  "OPENROUTER_MODEL",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  process.env["DOTENV_PATH"] = ENV_PATH;
  writeFileSync(ENV_PATH, SAMPLE, "utf8");
  resetRestartRequired();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function put(updates: Record<string, string | null>, host = "localhost:8787") {
  const res = await app.request("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", host },
    body: JSON.stringify({ updates }),
  });
  return { status: res.status, json: (await res.json()) as AdminSettings & { error?: string; key?: string } };
}

function envText(): string {
  return readFileSync(ENV_PATH, "utf8");
}

function valueOf(settings: AdminSettings, key: string) {
  return settings.values.find((v) => v.key === key);
}

describe("renderDotenv", () => {
  it("updates a live line in place and leaves every other line untouched", () => {
    const out = renderDotenv(SAMPLE, { DEEP_MAX_STEPS: "25" });
    expect(out).toContain("DEEP_MAX_STEPS=25");
    expect(out).not.toContain("DEEP_MAX_STEPS=30");
    // Same line count, same ordering, every comment still there.
    expect(out.split("\n")).toHaveLength(SAMPLE.split("\n").length);
    expect(out.indexOf("TYPESAFE_API_KEY")).toBeLessThan(out.indexOf("GITHUB_REPO"));
    expect(out).toContain("# Copy to .env and fill in.");
    expect(out).toContain("# Tool-calling rounds before a run aborts.");
  });

  it("revives a commented #KEY= line instead of appending a second one", () => {
    const out = renderDotenv(SAMPLE, { GITHUB_TOKEN: "ghp_new" });
    expect(out).toContain("GITHUB_TOKEN=ghp_new");
    expect(out).not.toContain("#GITHUB_TOKEN=github_pat_oldvaluehere");
    // The prose comment above it survives; only the commented assignment moved.
    expect(out).toContain("# GITHUB_TOKEN= (removed: GitHub returned 401 for this token)");
    expect(out.match(/^GITHUB_TOKEN=/gm)).toHaveLength(1);
  });

  it("appends a key the file never mentions", () => {
    const out = renderDotenv(SAMPLE, { OPENROUTER_MODEL: "openai/gpt-5" });
    expect(out.trimEnd().endsWith("OPENROUTER_MODEL=openai/gpt-5")).toBe(true);
  });

  it("comments a key out when it is unset, keeping its position", () => {
    const out = renderDotenv(SAMPLE, { GITHUB_REPO: null });
    expect(out).toContain("#GITHUB_REPO=");
    expect(out).not.toMatch(/^GITHUB_REPO=/m);
    expect(out.split("\n")).toHaveLength(SAMPLE.split("\n").length);
  });

  it("quotes a value that needs it", () => {
    expect(renderDotenv("", { JEV_MODEL: "jev latest" })).toContain('JEV_MODEL="jev latest"');
  });
});

describe("maskSecret", () => {
  it("shows five characters, an ellipsis and three more", () => {
    expect(maskSecret("apikey_2126683158e1f48a4bb8")).toBe("apike…bb8");
  });

  it("refuses to reveal anything about a short value", () => {
    expect(maskSecret("short")).toBe("(set)");
    expect(maskSecret("elevenchars")).toBe("(set)");
  });
});

describe("looksDerivedFrom", () => {
  it("spots a label that is really a truncation of the key", () => {
    // OpenRouter names keys after themselves; such a label must never be shown.
    expect(looksDerivedFrom("sk-or-v1-abc...xyz", "sk-or-v1-abcdef0123456789")).toBe(true);
    expect(looksDerivedFrom("prMonster laptop", "sk-or-v1-abcdef0123456789")).toBe(false);
  });
});

describe("GET /api/admin/settings", () => {
  it("masks secrets and never returns them in full", async () => {
    process.env["TYPESAFE_API_KEY"] = "apikey_0123456789abcdef";
    const res = await app.request("/api/admin/settings", { headers: { host: "localhost:8787" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminSettings;
    const key = valueOf(body, "TYPESAFE_API_KEY");
    expect(key?.set).toBe(true);
    expect(key?.value).toBe("apike…def");
    expect(JSON.stringify(body)).not.toContain("0123456789abcdef");
  });

  it("reports dotenv as the source when the value matches the file, env otherwise", async () => {
    process.env["GITHUB_REPO"] = "FujiNetWIFI/fujinet-firmware"; // what the file says
    process.env["DEEP_MAX_STEPS"] = "99"; // the environment overrode the file
    delete process.env["JEV_TRANSPORT"];
    const settings = readSettings();
    expect(valueOf(settings, "GITHUB_REPO")?.source).toBe("dotenv");
    expect(valueOf(settings, "DEEP_MAX_STEPS")?.source).toBe("env");
    expect(valueOf(settings, "JEV_TRANSPORT")).toMatchObject({ set: false, source: "default", value: null });
  });
});

describe("PUT /api/admin/settings", () => {
  it("rewrites the matching line in place and applies the value live", async () => {
    const { status } = await put({ DEEP_MAX_STEPS: "25" });
    expect(status).toBe(200);
    expect(envText()).toContain("DEEP_MAX_STEPS=25");
    expect(envText()).toContain("# Tool-calling rounds before a run aborts.");
    expect(process.env["DEEP_MAX_STEPS"]).toBe("25");
  });

  it("rejects a bad value with 400 and names the offending key", async () => {
    for (const [updates, key] of [
      [{ GITHUB_REPO: "not-a-repo" }, "GITHUB_REPO"],
      [{ PORT: "70000" }, "PORT"],
      [{ DEEP_MAX_COST_USD: "-1" }, "DEEP_MAX_COST_USD"],
      [{ JEV_TRANSPORT: "carrier-pigeon" }, "JEV_TRANSPORT"],
      [{ JEV_MOCK: "maybe" }, "JEV_MOCK"],
      [{ NOT_A_SETTING: "x" }, "NOT_A_SETTING"],
    ] as Array<[Record<string, string>, string]>) {
      const { status, json } = await put(updates);
      expect(status).toBe(400);
      expect(json.key).toBe(key);
    }
    // Nothing was written for any of them.
    expect(envText()).toBe(SAMPLE);
  });

  it("ignores a secret submitted as its own mask, so the UI can round-trip the form", async () => {
    process.env["TYPESAFE_API_KEY"] = "apikey_0123456789abcdef";
    const { status } = await put({ TYPESAFE_API_KEY: maskSecret("apikey_0123456789abcdef") });
    expect(status).toBe(200);
    expect(process.env["TYPESAFE_API_KEY"]).toBe("apikey_0123456789abcdef");
    expect(envText()).toBe(SAMPLE);
  });

  it("accepts boolean spellings and flips the live GitHub writes flag", async () => {
    delete process.env["ALLOW_GITHUB_WRITES"];
    expect(writesEnabled()).toBe(false);
    await put({ ALLOW_GITHUB_WRITES: "true" });
    expect(process.env["ALLOW_GITHUB_WRITES"]).toBe("1");
    expect(writesEnabled()).toBe(true);
    await put({ ALLOW_GITHUB_WRITES: "false" });
    expect(writesEnabled()).toBe(false);
    expect(envText()).toContain("ALLOW_GITHUB_WRITES=0");
  });

  it("changes which Jev backend the next request would pick", async () => {
    process.env["TYPESAFE_API_KEY"] = "apikey_0123456789abcdef";
    delete process.env["JEV_MOCK"];
    expect(jevMode()).toBe("live");
    await put({ JEV_MOCK: "1" });
    expect(jevMode()).toBe("mock");
    await put({ JEV_MOCK: "0", TYPESAFE_API_KEY: null });
    expect(jevMode()).toBe("mock"); // no key left
    expect(process.env["TYPESAFE_API_KEY"]).toBeUndefined();
    expect(envText()).toContain("#TYPESAFE_API_KEY=");
  });

  it("writes a requiresRestart key but does not apply it live", async () => {
    process.env["PORT"] = "8787";
    const { json } = await put({ PORT: "9001" });
    expect(envText()).toContain("PORT=9001");
    expect(process.env["PORT"]).toBe("8787");
    expect(json.restartRequired).toContain("PORT");
  });

  it("logs a change by key and never by value", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let logged = "";
    try {
      await put({ TYPESAFE_API_KEY: "apikey_supersecretvalue" });
      // mockRestore() also clears the recorded calls, so read them first.
      logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      spy.mockRestore();
    }
    expect(logged).toContain("TYPESAFE_API_KEY");
    expect(logged).not.toContain("supersecretvalue");
  });
});

describe("the localhost guard", () => {
  it("answers only to localhost, 127.0.0.1 and [::1]", async () => {
    for (const host of ["localhost", "localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
      const res = await app.request("/api/admin/settings", { headers: { host } });
      expect(res.status, host).toBe(200);
    }
    for (const host of ["example.com", "192.168.1.9:8787", "prmonster.internal:8787"]) {
      const res = await app.request("/api/admin/settings", { headers: { host } });
      expect(res.status, host).toBe(403);
      const res2 = await app.request("/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", host },
        body: JSON.stringify({ updates: { DEEP_MAX_STEPS: "1" } }),
      });
      expect(res2.status).toBe(403);
    }
    expect(envText()).toBe(SAMPLE);
  });
});

describe("POST /api/admin/settings/test", () => {
  it("reports that untestable settings have no test", async () => {
    const res = await app.request("/api/admin/settings/test", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:8787" },
      body: JSON.stringify({ key: "DEEP_MAX_STEPS" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: "DEEP_MAX_STEPS", ok: true, detail: "no test for this setting" });
  });

  it("refuses an unknown key", async () => {
    const res = await app.request("/api/admin/settings/test", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:8787" },
      body: JSON.stringify({ key: "SUDO" }),
    });
    expect(res.status).toBe(400);
  });
});
