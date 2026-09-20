import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrCommit } from "../src/server/github.js";

// The cache is redirected before the module under test is imported.
vi.hoisted(() => {
  process.env["DOSSIER_CACHE_DIR"] = `/tmp/prmonster-dossier-test-${process.pid}`;
});

const calls = vi.hoisted(() => ({ github: 0, blame: 0, thread: [] as string[], wdathingComments: false }));

vi.mock("../src/server/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/github.js")>();
  const commit: PrCommit = {
    sha: "c".repeat(40),
    date: "2026-09-20T17:04:52Z",
    author: "deltecent",
    subject: "[rs232] don't enable flow control implicitly",
    message: "x",
    url: "https://github.com/x/y/commit/c",
  };
  return {
    ...actual,
    getPrBaseSha: () =>
      Promise.resolve({ baseSha: "b".repeat(40), baseRef: "master", headSha: "a".repeat(40) }),
    getPrCommits: () => Promise.resolve([commit]),
    getIssueComments: () => {
      calls.github += 1;
      // Each call returns whatever the current script says: the thread moves on.
      const entries = calls.thread.map((body, i) => ({
        author: i === 0 ? "FozzTexx" : "deltecent",
        association: i === 0 ? "MEMBER" : "CONTRIBUTOR",
        at: `2026-09-20T1${7 + i}:00:00Z`,
        body,
        url: `https://github.com/x/y/pull/1650#c${i}`,
      }));
      if (calls.wdathingComments) {
        entries.push({
          author: "wdathing",
          association: "CONTRIBUTOR",
          at: "2026-09-20T19:00:00Z",
          body: "the board does have RTS/CTS wired",
          url: "https://github.com/x/y/pull/1650#cw",
        });
      }
      return Promise.resolve(entries);
    },
    getReviewComments: () => Promise.resolve([]),
    getReviewsDetailed: () => Promise.resolve([]),
    getPrSummary: (n: number) =>
      Promise.resolve(
        n === 1628
          ? {
              number: 1628,
              title: "Add COCO_HS_UART support",
              body: "Adds support for flow control.",
              author: "wdathing",
              url: "u1628",
              mergedAt: "2026-09-17T23:25:05Z",
            }
          : { number: n, title: "t", body: "mentions `COCO_HS_UART`", author: "deltecent", url: "u", mergedAt: null },
      ),
    getCommitPulls: () => Promise.resolve([1628]),
  };
});

vi.mock("../src/server/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/repo.js")>();
  return {
    ...actual,
    gitIsAvailable: () => Promise.resolve(true),
    ensureRepo: () => Promise.resolve(),
    fetchBase: () => Promise.resolve(),
    fetchPr: () => Promise.resolve(),
    hasRev: () => Promise.resolve(true),
    diffRange: () =>
      Promise.resolve(
        [
          "diff --git a/lib/x.cpp b/lib/x.cpp",
          "--- a/lib/x.cpp",
          "+++ b/lib/x.cpp",
          "@@ -1,2 +1,1 @@",
          " int keep;",
          "-int gone;",
          "",
        ].join("\n"),
      ),
    blame: () => {
      calls.blame += 1;
      return Promise.resolve([
        { sha: "d".repeat(40), author: "wdathing", date: "2026-09-17T00:00:00Z", summary: "add it (#1628)", line: 2, text: "int gone;" },
      ]);
    },
    grep: () => Promise.resolve([]),
    logRange: () => Promise.resolve([]),
  };
});

const { buildDossier } = await import("../src/server/dossier.js");

beforeEach(() => {
  calls.github = 0;
  calls.blame = 0;
  calls.thread = ["Do not put per platform ifdefs in this file."];
  calls.wdathingComments = false;
});

describe("dossier caching and refresh", () => {
  it("caches by head SHA, and ?refresh=1 refetches the thread without re-reading git", async () => {
    const first = await buildDossier(1650, { refresh: true });
    expect(first.thread).toHaveLength(2); // one comment + one commit
    expect(first.deletedLineOrigins).toHaveLength(1);
    const blamesAfterBuild = calls.blame;
    const githubAfterBuild = calls.github;
    expect(blamesAfterBuild).toBeGreaterThan(0);

    // A plain read is served from the cache: nothing is fetched at all.
    const cached = await buildDossier(1650);
    expect(cached.builtAt).toBe(first.builtAt);
    expect(calls.github).toBe(githubAfterBuild);
    expect(calls.blame).toBe(blamesAfterBuild);

    // The thread moves on without a push — the author says they will withdraw.
    calls.thread = [
      "Do not put per platform ifdefs in this file.",
      "ok, then I will pull this PR and post an issue instead.",
    ];

    const refreshed = await buildDossier(1650, { refresh: true });
    expect(calls.github).toBeGreaterThan(githubAfterBuild); // GitHub was read again
    expect(calls.blame).toBe(blamesAfterBuild); // git was not
    expect(refreshed.headSha).toBe(first.headSha);
    expect(refreshed.thread.map((t) => t.body)).toContain("ok, then I will pull this PR and post an issue instead.");
    expect(refreshed.builtAt).not.toBe(first.builtAt);
    // Git-derived facts survive untouched.
    expect(refreshed.deletedLineOrigins).toEqual(first.deletedLineOrigins);
    expect(refreshed.maintainers).toEqual(["FozzTexx"]);
    expect(refreshed.availability.notes.join(" ")).toContain("thread refreshed");

    // And the refreshed version is what a later plain read returns.
    const again = await buildDossier(1650);
    expect(again.builtAt).toBe(refreshed.builtAt);
    expect(again.thread).toHaveLength(3);
  });

  it("recomputes authorInThread when the origin author finally comments", async () => {
    const before = await buildDossier(1650, { refresh: true });
    expect(before.originPrs[0]!.authorInThread).toBe(false);

    // wdathing (who wrote #1628) joins the thread.
    calls.wdathingComments = true;
    const after = await buildDossier(1650, { refresh: true });
    expect(after.originPrs[0]!.authorInThread).toBe(true);
    expect(after.thread.some((t) => t.author === "wdathing")).toBe(true);
  });
});
