import { describe, expect, it } from "vitest";

import {
  CHARS_PER_TOKEN,
  addedLines,
  estimateTokens,
  parseDiff,
  planChunks,
  relevanceRank,
  skipFile,
} from "../src/server/chunk.js";
import { diffOf, multiFileDiff, policy } from "./fixtures.js";

describe("parseDiff", () => {
  it("parses paths, hunks and line numbers for added lines", () => {
    const diff = [
      "diff --git a/lib/device/rs232/rs232Disk.cpp b/lib/device/rs232/rs232Disk.cpp",
      "index 1111111..2222222 100644",
      "--- a/lib/device/rs232/rs232Disk.cpp",
      "+++ b/lib/device/rs232/rs232Disk.cpp",
      "@@ -10,3 +10,5 @@ void rs232Disk::service()",
      " int keep = 1;",
      "-int gone = 2;",
      "+int fresh = 3;",
      "+int newer = 4;",
      " int tail = 5;",
      "",
    ].join("\n");

    const parsed = parseDiff(diff);
    expect(parsed.files).toHaveLength(1);
    const f = parsed.files[0]!;
    expect(f.path).toBe("lib/device/rs232/rs232Disk.cpp");
    expect(f.status).toBe("modified");
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
    expect(f.hunks).toHaveLength(1);

    const added = addedLines(parsed);
    expect(added.map((a) => [a.line, a.text])).toEqual([
      [11, "int fresh = 3;"],
      [12, "int newer = 4;"],
    ]);
  });

  it("recognises added, removed, renamed and binary files", () => {
    const diff = [
      "diff --git a/a.cpp b/a.cpp",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/a.cpp",
      "@@ -0,0 +1,1 @@",
      "+int a;",
      "diff --git a/b.cpp b/b.cpp",
      "deleted file mode 100644",
      "--- a/b.cpp",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-int b;",
      "diff --git a/old.h b/new.h",
      "similarity index 98%",
      "rename from old.h",
      "rename to new.h",
      "--- a/old.h",
      "+++ b/new.h",
      "@@ -1,1 +1,1 @@",
      "-int old;",
      "+int renamed;",
      "diff --git a/logo.png b/logo.png",
      "index 3333333..4444444 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");

    const files = parseDiff(diff).files;
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["a.cpp", "added", false],
      ["b.cpp", "removed", false],
      ["new.h", "renamed", false],
      ["logo.png", "modified", true],
    ]);
    expect(files[2]!.oldPath).toBe("old.h");
  });

  it("does not mistake ++/-- code lines inside a hunk for file headers", () => {
    // `++ i;` renders as `+++ i;` and `-- i;` as `--- i;`. Treating those as
    // file headers started a bogus file and misattributed every later added
    // line, which silently defeated build_ifdef_in_shared_device.
    const diff = [
      "diff --git a/lib/device/fujiDevice/fujiDevice.cpp b/lib/device/fujiDevice/fujiDevice.cpp",
      "index 1111111..2222222 100644",
      "--- a/lib/device/fujiDevice/fujiDevice.cpp",
      "+++ b/lib/device/fujiDevice/fujiDevice.cpp",
      "@@ -10,4 +10,7 @@ void fujiDevice::service()",
      " int i = 0;",
      "+++ i;",
      "--- i;",
      "+#ifdef BUILD_ATARI",
      "+    atariOnly();",
      "+#endif",
      "",
    ].join("\n");

    const parsed = parseDiff(diff);
    expect(parsed.files).toHaveLength(1);
    const f = parsed.files[0]!;
    expect(f.path).toBe("lib/device/fujiDevice/fujiDevice.cpp");
    expect(f.hunks).toHaveLength(1);

    const added = addedLines(parsed);
    expect(added.map((a) => a.text)).toEqual(["++ i;", "#ifdef BUILD_ATARI", "    atariOnly();", "#endif"]);
    // Every added line still belongs to the shared-base file.
    expect(new Set(added.map((a) => a.path))).toEqual(
      new Set(["lib/device/fujiDevice/fujiDevice.cpp"]),
    );
    expect(f.deletions).toBe(1);
  });

  it("returns no files for an empty diff", () => {
    expect(parseDiff("").files).toEqual([]);
  });
});

describe("skip rules", () => {
  const skipOf = (diff: string): ReturnType<typeof skipFile> => skipFile(parseDiff(diff).files[0]!);

  it("skips binaries, lock files, csv, images and generated paths", () => {
    expect(skipOf(diffOf("dependencies.lock", ["x"])).skip).toBe(true);
    expect(skipOf(diffOf("partitions.csv", ["x"])).skip).toBe(true);
    expect(skipOf(diffOf("data/webui/config/logo.png", ["x"])).skip).toBe(true);
    expect(skipOf(diffOf("managed_components/espressif__x/foo.c", ["x"])).skip).toBe(true);
    expect(skipOf(diffOf("platformio-generated.ini", ["x"])).skip).toBe(true);
    expect(skipOf(diffOf("sdkconfig.fujinet-atari-v1", ["x"])).skip).toBe(true);
  });

  it("keeps html/js/css under data/webui and ordinary source", () => {
    expect(skipOf(diffOf("data/webui/template/index.html", ["<p>"])).skip).toBe(false);
    expect(skipOf(diffOf("lib/device/rs232/rs232Disk.cpp", ["int x;"])).skip).toBe(false);
  });

  it("orders source under lib/src/include ahead of docs", () => {
    expect(relevanceRank("lib/bus/iec/iec.cpp")).toBeLessThan(relevanceRank("pico/coco/main.c"));
    expect(relevanceRank("pico/coco/main.c")).toBeLessThan(relevanceRank("README.md"));
    expect(relevanceRank("build-platforms/platformio-x.ini")).toBeLessThan(relevanceRank("docs/notes.md"));
  });
});

describe("planChunks", () => {
  it("packs whole files greedily and orders by relevance", () => {
    const diff = multiFileDiff([
      { path: "README.md", added: ["docs"] },
      { path: "lib/bus/iec/iec.cpp", added: ["int a;"] },
      { path: "pico/coco/main.c", added: ["int b;"] },
    ]);
    const plan = planChunks(parseDiff(diff), policy());
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]!.files.map((f) => f.path)).toEqual([
      "lib/bus/iec/iec.cpp",
      "pico/coco/main.c",
      "README.md",
    ]);
    expect(plan.coverage).toBe("full");
    expect(plan.fileChunkIndex["lib/bus/iec/iec.cpp"]).toBe(0);
  });

  it("opens a new chunk when the token budget is reached", () => {
    const big = Array.from({ length: 200 }, (_, i) => `int filler_${i} = ${i};`);
    const diff = multiFileDiff([
      { path: "lib/a.cpp", added: big },
      { path: "lib/b.cpp", added: big },
      { path: "lib/c.cpp", added: big },
    ]);
    const plan = planChunks(parseDiff(diff), policy({ jev: { ...policy().jev, maxStateTokens: 2000 } }));
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const c of plan.chunks) expect(c.tokensEstimate).toBeLessThanOrEqual(2000);
  });

  it("truncates a single hunk that is larger than the whole budget", () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `int filler_${i} = ${i};`);
    const plan = planChunks(parseDiff(diffOf("lib/huge.cpp", huge)), policy({
      jev: { ...policy().jev, maxStateTokens: 1500 },
    }));
    expect(plan.chunks.some((c) => c.truncated)).toBe(true);
    expect(plan.chunks[0]!.files[0]!.diff).toContain("lines omitted ...]");
    expect(plan.coverage).toBe("partial");
  });

  it("splits an oversized file at hunk boundaries before truncating", () => {
    const hunk = (start: number): string =>
      [`@@ -${start},1 +${start},60 @@`, ...Array.from({ length: 60 }, (_, i) => `+int v${start}_${i} = ${i};`)].join("\n");
    const diff = [
      "diff --git a/lib/multi.cpp b/lib/multi.cpp",
      "--- a/lib/multi.cpp",
      "+++ b/lib/multi.cpp",
      hunk(1),
      hunk(200),
      hunk(400),
      "",
    ].join("\n");
    const plan = planChunks(parseDiff(diff), policy({ jev: { ...policy().jev, maxStateTokens: 900 } }));
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.every((c) => c.files.every((f) => f.path === "lib/multi.cpp"))).toBe(true);
    // Hunk-boundary splits keep whole hunks, so nothing is truncated here.
    expect(plan.chunks.some((c) => c.truncated)).toBe(false);
  });

  it("caps chunks at maxChunksPerPr and marks coverage partial", () => {
    const big = Array.from({ length: 300 }, (_, i) => `int filler_${i} = ${i};`);
    const parts = Array.from({ length: 10 }, (_, i) => ({ path: `lib/f${i}.cpp`, added: big }));
    const plan = planChunks(parseDiff(multiFileDiff(parts)), policy({
      jev: { ...policy().jev, maxStateTokens: 2000, maxChunksPerPr: 3 },
    }));
    expect(plan.chunks).toHaveLength(3);
    expect(plan.coverage).toBe("partial");
    expect(plan.skippedFiles.some((s) => s.includes("past maxChunksPerPr=3"))).toBe(true);
  });

  it("records rule-skipped files without failing coverage", () => {
    const diff = multiFileDiff([
      { path: "lib/a.cpp", added: ["int a;"] },
      { path: "vendor/foo.lock", added: ["x"] },
    ]);
    const plan = planChunks(parseDiff(diff), policy());
    expect(plan.coverage).toBe("full");
    expect(plan.skippedFiles).toEqual(["vendor/foo.lock (lock file)"]);
  });
});

describe("estimateTokens", () => {
  it("budgets at the conservative CHARS_PER_TOKEN, not DESIGN's prose figure", () => {
    // 3.5 chars/token under-counted real diffs badly enough that the API
    // rejected a 24k-token-budget chunk as max_tokens_exceeded.
    expect(CHARS_PER_TOKEN).toBe(2.6);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("1234567")).toBe(Math.ceil(7 / 2.6));
    expect(estimateTokens("x".repeat(26))).toBe(10);
    expect(estimateTokens("x".repeat(1000))).toBeGreaterThan(Math.ceil(1000 / 3.5));
  });
});
