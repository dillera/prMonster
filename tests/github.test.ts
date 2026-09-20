import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseDiff } from "../src/server/chunk.js";
import {
  ciStateFrom,
  diffFromFilePatches,
  getPrDiff,
  parseNextLink,
  resetGithubAuthCache,
} from "../src/server/github.js";
import { check } from "./fixtures.js";

const FILES_JSON = [
  {
    filename: "lib/device/fujiDevice/fujiDevice.cpp",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: "@@ -10,3 +10,4 @@ void fujiDevice::service()\n int keep = 1;\n-int gone = 2;\n+int fresh = 3;\n+int extra = 4;",
  },
  {
    filename: "lib/device/rs232/new.cpp",
    status: "added",
    additions: 1,
    deletions: 0,
    patch: "@@ -0,0 +1,1 @@\n+int added = 1;",
  },
  { filename: "docs/logo.png", status: "modified", additions: 0, deletions: 0 }, // binary: no patch
];

describe("github diff fetching", () => {
  beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "test-token"; // avoid spawning `gh auth token`
    resetGithubAuthCache();
  });
  afterEach(() => {
    delete process.env["GITHUB_TOKEN"];
    resetGithubAuthCache();
    vi.unstubAllGlobals();
  });

  it("returns the whole-PR diff when GitHub serves it", async () => {
    const body = "diff --git a/a.cpp b/a.cpp\n--- a/a.cpp\n+++ b/a.cpp\n@@ -1,1 +1,1 @@\n+int a;\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(getPrDiff(1605)).resolves.toBe(body);
  });

  it("falls back to per-file patches when the diff is refused as too large", async () => {
    const fetchMock = vi
      .fn()
      // the .diff request
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "too_large" }), { status: 406 }))
      // the /files listing the fallback pages through
      .mockResolvedValueOnce(
        new Response(JSON.stringify(FILES_JSON), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const diff = await getPrDiff(1359);
    expect(diff).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The rebuilt text must survive our own parser with real line numbers.
    const parsed = parseDiff(diff as string);
    expect(parsed.files.map((f) => [f.path, f.status])).toEqual([
      ["lib/device/fujiDevice/fujiDevice.cpp", "modified"],
      ["lib/device/rs232/new.cpp", "added"],
    ]);
    expect(parsed.files[0]!.additions).toBe(2);
    expect(parsed.files[0]!.hunks[0]!.lines.filter((l) => l.kind === "add").map((l) => l.newLine)).toEqual([11, 12]);
  });

  it("reuses an already-fetched file listing instead of paging it again", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 406 }));
    vi.stubGlobal("fetch", fetchMock);
    const diff = await getPrDiff(1359, FILES_JSON as never);
    expect(diff).toContain("lib/device/rs232/new.cpp");
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the .diff attempt
  });

  it("returns null — never an empty string — when no patch can be recovered", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 406 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ filename: "big.bin", status: "modified", additions: 0, deletions: 0 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPrDiff(1359)).resolves.toBeNull();
  });

  it("returns null when the fallback request itself fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 406 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPrDiff(1359)).resolves.toBeNull();
  });

  it("marks added and removed files with /dev/null so the parser sees the status", () => {
    const diff = diffFromFilePatches([
      { filename: "gone.cpp", status: "removed", additions: 0, deletions: 1, patch: "@@ -1,1 +0,0 @@\n-int gone;" },
      {
        filename: "new.h",
        status: "renamed",
        additions: 1,
        deletions: 0,
        previous_filename: "old.h",
        patch: "@@ -1,1 +1,1 @@\n-int old;\n+int renamed;",
      },
    ] as never);
    const files = parseDiff(diff as string).files;
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["gone.cpp", "removed"],
      ["new.h", "renamed"],
    ]);
    expect(files[1]!.oldPath).toBe("old.h");
  });

  it("returns null for a listing with no patches at all", () => {
    expect(diffFromFilePatches([] as never)).toBeNull();
  });
});

describe("ciStateFrom", () => {
  it("treats action_required as pending, not red", () => {
    expect(ciStateFrom([check("macOS 14 ARM: Target ATARI", "completed", "action_required")])).toBe("pending");
    expect(ciStateFrom([check("macOS 14 ARM: Target ATARI", "completed", "failure")])).toBe("red");
    expect(ciStateFrom([check("macOS 14 ARM: Target ATARI", "queued", null)])).toBe("pending");
    expect(ciStateFrom([check("macOS 14 ARM: Target ATARI", "completed", "success")])).toBe("green");
    expect(ciStateFrom([])).toBe("none");
  });
});

describe("parseNextLink", () => {
  it("finds rel=next and nothing else", () => {
    expect(
      parseNextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'),
    ).toBe("https://api.github.com/x?page=2");
    expect(parseNextLink('<https://api.github.com/x?page=9>; rel="last"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});
