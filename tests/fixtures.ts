// Shared fixtures. Not a test file (vitest only collects *.test.ts).

import type { CheckRun, Policy, PrFile, PrSnapshot } from "../src/shared/types.js";
import { DEFAULT_POLICY } from "../src/server/store.js";

export function policy(over: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, ...over, jev: { ...DEFAULT_POLICY.jev, ...(over.jev ?? {}) } };
}

export function file(path: string, over: Partial<PrFile> = {}): PrFile {
  return { path, status: "modified", additions: 3, deletions: 1, ...over };
}

export function check(name: string, status: string, conclusion: string | null): CheckRun {
  return { name, status, conclusion };
}

export function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  const files = over.files ?? [file("lib/device/rs232/rs232Disk.cpp")];
  return {
    number: 1650,
    title: "Fix RS232 disk timing",
    body: "The RS232 disk sometimes stalls. Bisected to commit abc123. Tested on hardware with an Atari 800XL and with `./build.sh -p RS232`.",
    author: "someone",
    authorAssociation: "CONTRIBUTOR",
    url: "https://github.com/FujiNetWIFI/fujinet-firmware/pull/1650",
    draft: false,
    state: "open",
    base: "master",
    headRef: "fix-rs232",
    headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    labels: [],
    mergeable: true,
    mergeableState: "clean",
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    changedFiles: files.length,
    files,
    checks: [check("macOS 14 ARM: Target ATARI", "completed", "success")],
    ci: "green",
    reviewCount: 0,
    commentCount: 0,
    latestReviewStates: {},
    diffBytes: 925,
    fetchedAt: new Date().toISOString(),
    ...over,
    files,
  };
}

/** A minimal but real unified diff for one file. */
export function diffOf(
  path: string,
  added: string[],
  opts: { removed?: string[]; context?: string[]; status?: "added" | "modified" | "removed" } = {},
): string {
  const context = opts.context ?? ["int main(void)"];
  const removed = opts.removed ?? [];
  const oldCount = context.length + removed.length;
  const newCount = context.length + added.length;
  const head =
    opts.status === "added"
      ? [`diff --git a/${path} b/${path}`, "new file mode 100644", "index 0000000..1111111", "--- /dev/null", `+++ b/${path}`]
      : [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`];
  return [
    ...head,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...context.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    "",
  ].join("\n");
}

export function multiFileDiff(parts: Array<{ path: string; added: string[] }>): string {
  return parts.map((p) => diffOf(p.path, p.added)).join("");
}
