import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActionRecord,
  IssueEvaluation,
  IssueEvidence,
  IssueSnapshot,
  JevAnswer,
} from "../src/shared/types.js";

// --- module doubles for the route tests ---------------------------------------

const state = vi.hoisted(() => ({
  writes: false,
  live: { state: "open" as "open" | "closed", updatedAt: "2026-01-01T00:00:00Z", isPr: false },
  evaluation: null as IssueEvaluation | null,
  actions: [] as ActionRecord[],
  calls: [] as string[],
  closeFails: false,
}));

vi.mock("../src/server/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/github.js")>();
  return {
    ...actual,
    githubAuthMode: () => "token" as const,
    writesEnabled: () => state.writes,
    getIssueState: () => Promise.resolve(state.live),
    createIssueComment: (n: number, body: string) => {
      state.calls.push(`comment:${n}:${body.includes("dillera") && !body.includes("<confirmedBy>") ? "signed" : "unsigned"}`);
      return Promise.resolve({ url: `https://github.com/x/y/issues/${n}#issuecomment-1` });
    },
    closeIssue: (n: number, reason: string) => {
      state.calls.push(`close:${n}:${reason}`);
      return state.closeFails
        ? Promise.reject(new Error("GitHub 500"))
        : Promise.resolve({ url: `https://github.com/x/y/issues/${n}` });
    },
    addLabels: (n: number, labels: string[]) => {
      state.calls.push(`labels:${n}:${labels.join(",")}`);
      return Promise.resolve({ url: `https://github.com/x/y/pull/${n}` });
    },
  };
});

vi.mock("../src/server/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/issues.js")>();
  return { ...actual, latestIssueEvaluation: () => state.evaluation };
});

vi.mock("../src/server/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/store.js")>();
  return {
    ...actual,
    ensureDataDir: () => undefined,
    readActions: () => state.actions,
    appendAction: (r: ActionRecord) => {
      state.actions.push(r);
      return r;
    },
  };
});

const { app } = await import("../src/server/index.js");
const { checkPath, extractPaths, extractSymbols, threadEvidence } = await import("../src/server/issueEvidence.js");
const { hasClosingKeyword, linkedPrsFromTimeline } = await import("../src/server/github.js");
const { recommend } = await import("../src/server/issueDecide.js");
const { buildIssueState, MockIssueJevBackend, askIssue } = await import("../src/server/issueJev.js");

// --- fixtures -------------------------------------------------------------------

const NOW = Date.parse("2026-10-01T00:00:00Z");

function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    number: 433,
    title: "Refactor MODEM code",
    body: "The modem code in `lib/sio/modem.cpp` is a mess.",
    author: "reporter",
    authorAssociation: "NONE",
    url: "https://github.com/FujiNetWIFI/fujinet-firmware/issues/433",
    state: "open",
    stateReason: null,
    createdAt: "2021-02-09T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    labels: [],
    assignees: [],
    reactions: 0,
    comments: [],
    linkedPrs: [],
    referencingCommits: [],
    fetchedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function evidence(over: Partial<IssueEvidence> = {}): IssueEvidence {
  return {
    ageDays: 2000,
    daysSinceActivity: 1500,
    commentCount: 0,
    participants: 1,
    lastCommentBy: "none",
    daysSinceMaintainerComment: null,
    mergedLinkedPrs: 0,
    mergedClosingPrs: 0,
    openLinkedPrs: 0,
    codeRefs: [],
    codeRefsMissing: 0,
    codeRefsChecked: 0,
    commitsSinceOpened: 4500,
    commitsTouchingRefsSinceOpened: null,
    recentTouchingCommits: [],
    baseSha: "a".repeat(40),
    git: true,
    notes: [],
    ...over,
  };
}

const noul = (n: number): JevAnswer => ({ type: "noul", noul: n });
const relevance = (score: number, confidence = 0.7): JevAnswer => ({
  type: "score",
  score,
  legend: {},
  probabilities: {},
  confidence,
});

function rec(answers: Record<string, JevAnswer>, ev = evidence(), snap = issue(), repoLabels: string[] = []) {
  return recommend({ snapshot: snap, evidence: ev, answers, model: "jev-test", repoLabels });
}

// --- evidence extraction ---------------------------------------------------------

describe("code references in issue text", () => {
  const top = new Set(["lib", "src", "include"]);

  it("finds slashed paths under real top-level dirs, bare source files, and blob links", () => {
    const text = [
      "Crash in lib/device/sio/fuji.cpp when mounting.",
      "Also see fnFsSD.cpp and TCP/IP stuff, n/a.",
      "https://github.com/FujiNetWIFI/fujinet-firmware/blob/master/src/main.cpp#L40",
    ].join("\n");
    expect(extractPaths(text, top, "FujiNetWIFI/fujinet-firmware")).toEqual([
      "src/main.cpp",
      "lib/device/sio/fuji.cpp",
      "fnFsSD.cpp",
    ]);
  });

  it("ignores a bare top-level directory", () => {
    expect(extractPaths("look in lib/ for it", top, "a/b")).toEqual([]);
  });

  it("keeps identifiers but drops shouted prose and product names outside backticks", () => {
    const text = "ERROR when OPENING on SIO2SD; `FileSystemSDFAT::dir_open` and `MAX_PATH_LEN` and `APETIME` matter";
    const symbols = extractSymbols(text);
    expect(symbols).toContain("FileSystemSDFAT::dir_open");
    expect(symbols).toContain("MAX_PATH_LEN");
    expect(symbols).toContain("APETIME");
    expect(symbols).not.toContain("ERROR");
    expect(symbols).not.toContain("SIO2SD");
  });

  it("classifies paths as exists, renamed/moved or missing", () => {
    const files = ["lib/device/sio/modem.cpp", "lib/bus/sio/sio.cpp", "src/main.cpp"];
    expect(checkPath("src/main.cpp", files).status).toBe("exists");
    expect(checkPath("lib/bus", files).status).toBe("exists");
    expect(checkPath("lib/sio/modem.cpp", files)).toEqual({ status: "renamed_or_moved", matches: ["lib/device/sio/modem.cpp"] });
    expect(checkPath("modem.cpp", files).status).toBe("exists");
    expect(checkPath("lib/sio/apetime.cpp", files).status).toBe("missing");
  });
});

describe("thread facts", () => {
  it("knows who spoke last and how long a maintainer question has waited", () => {
    const ev = threadEvidence(
      issue({
        comments: [
          { author: "reporter", association: "NONE", isMaintainer: false, at: "2021-03-01T00:00:00Z", body: "still broken", url: "" },
          { author: "tschak", association: "MEMBER", isMaintainer: true, at: "2025-10-01T00:00:00Z", body: "Can you retest?", url: "" },
          { author: "github-actions[bot]", association: "NONE", isMaintainer: false, at: "2026-01-01T00:00:00Z", body: "stale", url: "" },
        ],
      }),
      NOW,
    );
    expect(ev.lastCommentBy).toBe("maintainer");
    expect(ev.daysSinceMaintainerComment).toBe(365);
    expect(ev.commentCount).toBe(2);
    expect(ev.participants).toBe(2);
  });
});

describe("linked work from the timeline", () => {
  it("recognises GitHub's closing keywords and only those", () => {
    expect(hasClosingKeyword("This fixes #433", 433)).toBe(true);
    expect(hasClosingKeyword("Closes: #433.", 433)).toBe(true);
    expect(hasClosingKeyword("resolves FujiNetWIFI/fujinet-firmware#433", 433)).toBe(true);
    expect(hasClosingKeyword("related to #433", 433)).toBe(false);
    expect(hasClosingKeyword("fixes #4330", 433)).toBe(false);
  });

  it("keeps PRs from this repository, newest state, and drops plain issues and forks", () => {
    const events = [
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 528, title: "Modem rewrite", body: "Fixes #433", state: "closed", html_url: "u", user: { login: "a" },
            pull_request: { merged_at: "2022-01-01T00:00:00Z" }, repository: { full_name: "FujiNetWIFI/fujinet-firmware" },
          },
        },
      },
      { event: "cross-referenced", source: { issue: { number: 9, title: "an issue", state: "open", html_url: "u", user: null, repository: { full_name: "FujiNetWIFI/fujinet-firmware" } } } },
      {
        event: "cross-referenced",
        source: { issue: { number: 7, title: "fork", state: "open", html_url: "u", user: null, pull_request: {}, repository: { full_name: "someone/fork" } } },
      },
    ];
    const prs = linkedPrsFromTimeline(events as never, 433, "FujiNetWIFI/fujinet-firmware");
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 528, state: "merged", closingKeyword: true });
  });
});

// --- recommendation ---------------------------------------------------------------

describe("recommend", () => {
  it("closes as fixed when a merged PR says it closes the issue", () => {
    const snap = issue({
      linkedPrs: [{ number: 528, title: "Modem rewrite", state: "merged", mergedAt: "2022-01-01T00:00:00Z", url: "", author: "a", closingKeyword: true }],
    });
    const r = rec({ fixed_by_linked_work: noul(0.6) }, evidence({ mergedLinkedPrs: 1, mergedClosingPrs: 1 }), snap);
    expect(r.kind).toBe("close_fixed");
    expect(r.action).toBe("close_completed");
    expect(r.body).toContain("#528 Modem rewrite");
    expect(r.body).toContain("<confirmedBy>");
  });

  it("does not close on a closing PR that Jev says addresses something else", () => {
    const r = rec({ fixed_by_linked_work: noul(0.2), still_relevant: relevance(2.6) }, evidence({ mergedClosingPrs: 1, mergedLinkedPrs: 1 }));
    expect(r.kind).not.toBe("close_fixed");
  });

  it("closes as obsolete when the code moved on, and lists what is gone", () => {
    const ev = evidence({
      codeRefs: [{ kind: "path", text: "lib/sio/modem.cpp", status: "renamed_or_moved", matches: ["lib/device/sio/modem.cpp"], commitsSince: 0 }],
      codeRefsChecked: 1,
      codeRefsMissing: 1,
    });
    const r = rec({ superseded_by_code_changes: noul(0.85), still_relevant: relevance(0.8) }, ev);
    expect(r.kind).toBe("close_obsolete");
    expect(r.action).toBe("close_not_planned");
    expect(r.body).toContain("`lib/sio/modem.cpp` is no longer at that path");
    expect(r.body).toContain("4500 commits");
  });

  it("closes for no response only when a maintainer spoke last, long enough ago", () => {
    const answers = { awaiting_reporter: noul(0.9), still_relevant: relevance(1.5) };
    const waited = rec(answers, evidence({ lastCommentBy: "maintainer", daysSinceMaintainerComment: 200 }));
    expect(waited.kind).toBe("close_no_response");
    const recent = rec(answers, evidence({ lastCommentBy: "maintainer", daysSinceMaintainerComment: 10 }));
    expect(recent.kind).not.toBe("close_no_response");
  });

  it("asks rather than closes an old issue with no decisive signal, adding a stale label only if the repo has one", () => {
    const answers = { still_relevant: relevance(1.5), superseded_by_code_changes: noul(0.4) };
    const r = rec(answers, evidence(), issue(), ["bug", "Stale"]);
    expect(r.kind).toBe("ask_still_relevant");
    expect(r.action).toBe("comment");
    expect(r.labels).toEqual(["Stale"]);
    expect(rec(answers).labels).toEqual([]);
  });

  it("keeps a relevant issue open and suggests an existing type label when it has none", () => {
    const answers = {
      still_relevant: relevance(2.7),
      actionable: noul(0.8),
      issue_type: { type: "choice", choice: "feature_request", probabilities: {}, confidence: 0.8 } as JevAnswer,
    };
    const r = rec(answers, evidence({ daysSinceActivity: 20 }), issue(), ["enhancement"]);
    expect(r.kind).toBe("keep_open");
    expect(r.action).toBe("labels");
    expect(r.labels).toEqual(["enhancement"]);
  });

  it("offers no one-click action when the text addresses automation", () => {
    const r = rec({ automation_directed_text: noul(0.95), fixed_by_linked_work: noul(0.99) }, evidence({ mergedClosingPrs: 1 }));
    expect(r.kind).toBe("needs_human");
    expect(r.action).toBeNull();
  });

  it("falls back to hard facts only when Jev was unavailable", () => {
    const r = recommend({ snapshot: issue(), evidence: evidence(), answers: {}, model: "m", repoLabels: [], jevError: "503" });
    expect(r.kind).toBe("needs_human");
    expect(r.reasons[0]).toContain("Jev was unavailable");
  });
});

describe("issue state for Jev", () => {
  it("keeps a long thread's start and end, and the mock answers from the evidence", async () => {
    const comments = Array.from({ length: 30 }, (_, i) => ({
      author: i % 2 ? "reporter" : "tschak",
      association: i % 2 ? "NONE" : "MEMBER",
      isMaintainer: i % 2 === 0,
      at: "2021-03-01T00:00:00Z",
      body: `comment ${i}`,
      url: "",
    }));
    const ev = evidence({
      codeRefs: [{ kind: "path", text: "lib/x.cpp", status: "missing", matches: [], commitsSince: 0 }],
      codeRefsChecked: 1,
      codeRefsMissing: 1,
    });
    const s = buildIssueState(issue({ comments }), ev, NOW);
    expect(s.thread).toHaveLength(12);
    expect(s.thread[0]?.body).toBe("comment 0");
    expect(s.thread.at(-1)?.body).toBe("comment 29");
    expect(s.code_evidence.references[0]).toContain("does not exist");

    const { answers } = await askIssue(new MockIssueJevBackend(433), s, "m");
    expect(answers["superseded_by_code_changes"]?.type).toBe("noul");
    expect((answers["superseded_by_code_changes"] as { noul: number }).noul).toBeGreaterThan(0.6);
  });
});

// --- the one-click route -------------------------------------------------------------

function storedEvaluation(): IssueEvaluation {
  return {
    id: "iev_test",
    issueNumber: 433,
    issueUpdatedAt: "2026-01-01T00:00:00Z",
    evaluatedAt: "2026-01-02T00:00:00Z",
    mock: true,
    model: "mock",
    evidence: evidence(),
    answers: {},
    recommendation: rec({ superseded_by_code_changes: noul(0.9), still_relevant: relevance(0.5) }),
    usage: { input_tokens: 1, calls: 1, estCostUsd: 0 },
    durationMs: 1,
  };
}

async function act(body: unknown): Promise<{ status: number; json: ActionRecord }> {
  const res = await app.request("/api/issues/433/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ActionRecord };
}

describe("POST /api/issues/:n/actions", () => {
  beforeEach(() => {
    state.writes = false;
    state.live = { state: "open", updatedAt: "2026-01-01T00:00:00Z", isPr: false };
    state.evaluation = storedEvaluation();
    state.actions = [];
    state.calls = [];
    state.closeFails = false;
  });

  const close = { evaluationId: "iev_test", kind: "close_not_planned", actor: "dillera", body: "Closing. — <confirmedBy>" };

  it("needs a person", async () => {
    const { status } = await act({ ...close, actor: " " });
    expect(status).toBe(400);
    expect(state.actions).toHaveLength(0);
  });

  it("records and refuses when writes are disabled, without touching GitHub", async () => {
    const { status, json } = await act(close);
    expect(status).toBe(403);
    expect(json.outcome).toBe("refused_writes_disabled");
    expect(json.target).toBe("issue");
    expect(json.body).toContain("dillera");
    expect(state.calls).toEqual([]);
  });

  it("refuses when the issue changed after the analysis, even with writes on", async () => {
    state.writes = true;
    state.live.updatedAt = "2026-02-01T00:00:00Z";
    const { status, json } = await act(close);
    expect(status).toBe(409);
    expect(json.outcome).toBe("refused_stale");
    expect(json.error).toContain("new activity");
    expect(state.calls).toEqual([]);
  });

  it("refuses an action made against an older analysis", async () => {
    state.writes = true;
    const { status, json } = await act({ ...close, evaluationId: "iev_old" });
    expect(status).toBe(409);
    expect(json.outcome).toBe("refused_stale");
  });

  it("refuses an issue that is already closed", async () => {
    state.writes = true;
    state.live.state = "closed";
    const { json } = await act(close);
    expect(json.outcome).toBe("refused_stale");
    expect(state.calls).toEqual([]);
  });

  it("comments first, then closes with the reason, signed with the actor", async () => {
    state.writes = true;
    const { status, json } = await act(close);
    expect(status).toBe(201);
    expect(json.outcome).toBe("posted");
    expect(state.calls).toEqual(["comment:433:signed", "close:433:not_planned"]);
    expect(json.githubUrl).toContain("issuecomment");
  });

  it("closes without a comment when none is sent", async () => {
    state.writes = true;
    const { body: _b, ...noBody } = close;
    void _b;
    await act({ ...noBody, kind: "close_completed" });
    expect(state.calls).toEqual(["close:433:completed"]);
  });

  it("reports a failed close and keeps the link to the comment that did post", async () => {
    state.writes = true;
    state.closeFails = true;
    const { status, json } = await act(close);
    expect(status).toBe(502);
    expect(json.outcome).toBe("failed");
    expect(json.error).toContain("the comment did post");
  });

  it("will not post an empty comment", async () => {
    state.writes = true;
    const { status } = await act({ evaluationId: "iev_test", kind: "comment", actor: "dillera" });
    expect(status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});

describe("recent or active issues are never closed as obsolete", () => {
  const answers = { superseded_by_code_changes: noul(0.9), still_relevant: relevance(0.8) };
  const gone = {
    codeRefs: [{ kind: "path" as const, text: "lib/device/sio/network.cpp", status: "missing" as const, matches: [], commitsSince: 0 }],
    codeRefsChecked: 1,
    codeRefsMissing: 1,
  };

  it("hands a freshly reproduced issue to a human", () => {
    const r = rec(answers, evidence({ ...gone, ageDays: 400, daysSinceActivity: 0, lastCommentBy: "other" }));
    expect(r.kind).toBe("needs_human");
    expect(r.action).toBeNull();
    expect(r.reasons[0]).toContain("still active");
  });

  it("hands a young issue to a human even when it is quiet", () => {
    const r = rec(answers, evidence({ ...gone, ageDays: 100, daysSinceActivity: 95 }));
    expect(r.kind).toBe("needs_human");
    expect(r.reasons[0]).toContain("only 100 days old");
  });
});

describe("first-party code filter", () => {
  it("ignores vendored libraries and prose when checking a symbol", async () => {
    const { isFirstPartyCode } = await import("../src/server/issueEvidence.js");
    expect(isFirstPartyCode("lib/device/sio/fuji.cpp")).toBe(true);
    expect(isFirstPartyCode("components/expat/expat/lib/xmlparse.c")).toBe(false);
    expect(isFirstPartyCode("components_pc/miniaudio/miniaudio.h")).toBe(false);
    expect(isFirstPartyCode("AGENTS.md")).toBe(false);
  });
});
