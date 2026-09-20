import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRecord, Evaluation, PrListItem, PrSnapshot } from "../src/shared/types.js";
import { file, policy, snapshot } from "./fixtures.js";

// --- module doubles ---------------------------------------------------------
// The routes under test are about *ordering and validation*, so GitHub and the
// JSON store are replaced; everything else (proposals, decide, gates) is real.

const state = vi.hoisted(() => ({
  liveHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  evaluation: null as Evaluation | null,
  actions: [] as ActionRecord[],
  labels: [] as string[],
  writes: false,
  snapshotError: null as string | null,
  listFailures: new Set<number>(),
}));

vi.mock("../src/server/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/github.js")>();
  return {
    ...actual,
    githubAuthMode: () => "token" as const,
    writesEnabled: () => state.writes,
    listRepoLabels: () => Promise.resolve(state.labels),
    listOpenPrs: () =>
      Promise.resolve([
        { number: 1650, title: "Fine", headSha: state.liveHeadSha, updatedAt: "2026-09-19T00:00:00Z" },
        { number: 1605, title: "Broken", headSha: "b".repeat(40), updatedAt: "2026-09-19T00:00:00Z" },
      ]),
    cachedSnapshot: () => null,
    fetchSnapshot: (n: number) => {
      if (state.listFailures.has(n)) return Promise.reject(new Error(`GitHub 502 for #${n}`));
      if (state.snapshotError) return Promise.reject(new Error(state.snapshotError));
      return Promise.resolve({
        snapshot: snapshot({ number: n, headSha: state.liveHeadSha }),
        diff: "",
        fromCache: false,
      });
    },
    createIssueComment: () => Promise.resolve({ url: "https://github.com/x/y/pull/1650#issuecomment-1" }),
  };
});

vi.mock("../src/server/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/store.js")>();
  return {
    ...actual,
    ensureDataDir: () => undefined,
    latestEvaluation: () => state.evaluation,
    latestEvaluationsByPr: () => new Map<number, Evaluation>(),
    triageFor: () => null,
    readActions: () => state.actions,
    appendAction: (r: ActionRecord) => {
      state.actions.push(r);
      return r;
    },
  };
});

const { app } = await import("../src/server/index.js");
const { decide } = await import("../src/server/decide.js");
const { runGates } = await import("../src/server/gates.js");
const { parseDiff } = await import("../src/server/chunk.js");
const { buildProposal, proposalId } = await import("../src/server/proposals.js");

function evaluationFor(snap: PrSnapshot): Evaluation {
  const gates = runGates(snap, parseDiff(""), policy());
  return {
    id: "ev_route_test",
    prNumber: snap.number,
    headSha: snap.headSha,
    evaluatedAt: new Date().toISOString(),
    mock: true,
    model: "jev-1.13.0",
    gates,
    prAnswers: {},
    chunks: [],
    coverage: "full",
    skippedFiles: [],
    aggregated: {},
    usage: { input_tokens: 1, output_tokens: 0, calls: 1, estCostUsd: 0 },
    decision: decide(gates, {}, {}, "small", policy()),
    policyVersion: "test",
    durationMs: 1,
  };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: ActionRecord }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ActionRecord };
}

describe("POST /api/prs/:n/actions", () => {
  const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  beforeEach(() => {
    state.liveHeadSha = HEAD;
    state.actions = [];
    state.labels = [];
    state.writes = false;
    state.snapshotError = null;
    state.listFailures = new Set();
    state.evaluation = evaluationFor(snapshot({ number: 1650, headSha: HEAD }));
  });

  function currentProposalId(): string {
    return proposalId(1650, state.evaluation!.headSha, state.evaluation!.id);
  }

  it("refuses with 403 and an audit record when writes are disabled", async () => {
    const { status, json } = await post("/api/prs/1650/actions", {
      proposalId: currentProposalId(),
      kind: "comment",
      confirmedBy: "dillera",
      confirmText: "CONFIRM",
    });
    expect(status).toBe(403);
    expect(json.outcome).toBe("refused_writes_disabled");
    expect(state.actions).toHaveLength(1);
  });

  it("refuses as stale when the PR head has moved on GitHub since the evaluation", async () => {
    const id = currentProposalId();
    state.liveHeadSha = "c".repeat(40); // author pushed after we evaluated

    const { status, json } = await post("/api/prs/1650/actions", {
      proposalId: id,
      kind: "comment",
      confirmedBy: "dillera",
      confirmText: "CONFIRM",
    });
    expect(status).toBe(409);
    expect(json.outcome).toBe("refused_stale");
    expect(json.error).toContain("has moved on");
    expect(state.actions.at(-1)?.outcome).toBe("refused_stale");
  });

  it("checks staleness before anything else, so a bad confirm on a stale PR still reads stale", async () => {
    const id = currentProposalId();
    state.liveHeadSha = "c".repeat(40);
    const { status, json } = await post("/api/prs/1650/actions", {
      proposalId: id,
      kind: "comment",
      confirmedBy: "dillera",
      confirmText: "definitely",
    });
    expect(status).toBe(409);
    expect(json.outcome).toBe("refused_stale");
  });

  it("still refuses a bad confirm text when the head is current", async () => {
    const { status, json } = await post("/api/prs/1650/actions", {
      proposalId: currentProposalId(),
      kind: "comment",
      confirmedBy: "dillera",
      confirmText: "confirm",
    });
    expect(status).toBe(400);
    expect(json.outcome).toBe("refused_bad_confirm");
  });

  it("compares the whole proposal id, not a substring of it", async () => {
    // Same head SHA, different evaluation: the id must not be accepted.
    const forged = proposalId(1650, state.evaluation!.headSha, "ev_somethingelse");
    const { status, json } = await post("/api/prs/1650/actions", {
      proposalId: forged,
      kind: "comment",
      confirmedBy: "dillera",
      confirmText: "CONFIRM",
    });
    expect(status).toBe(409);
    expect(json.outcome).toBe("refused_stale");

    // An id whose underscore-split happens to expose the right SHA is still rejected.
    const spoofed = `prop_1650_${state.evaluation!.headSha}_ev_route_test_extra`;
    expect((await post("/api/prs/1650/actions", {
      proposalId: spoofed,
      kind: "comment",
      confirmedBy: "dillera",
      confirmText: "CONFIRM",
    })).json.outcome).toBe("refused_stale");
  });

  it("posts when the proposal, the evaluation and the live head all agree", async () => {
    state.writes = true;
    const { status, json } = await post("/api/prs/1650/actions", {
      proposalId: currentProposalId(),
      kind: "comment",
      confirmedBy: "dillera",
      confirmText: "CONFIRM",
    });
    expect(status).toBe(201);
    expect(json.outcome).toBe("posted");
    expect(json.githubUrl).toContain("issuecomment");
    expect(json.body).toContain("posted by dillera");
  });

  it("records a failure rather than posting when the live head cannot be confirmed", async () => {
    state.writes = true;
    state.snapshotError = "GitHub 502";
    const { status, json } = await post("/api/prs/1650/actions", {
      proposalId: currentProposalId(),
      kind: "comment",
      confirmedBy: "dillera",
      confirmText: "CONFIRM",
    });
    expect(status).toBe(502);
    expect(json.outcome).toBe("failed");
    expect(json.error).toContain("could not confirm the live head SHA");
  });

  it("matches the id the proposal route hands out", async () => {
    const snap = snapshot({ number: 1650, headSha: HEAD });
    const p = buildProposal({ snapshot: snap, evaluation: state.evaluation!, repoLabels: [] });
    expect(p.id).toBe(currentProposalId());
  });
});

describe("GET /api/prs", () => {
  beforeEach(() => {
    state.liveHeadSha = "a".repeat(40);
    state.snapshotError = null;
    state.listFailures = new Set();
  });

  it("returns every open PR even when one of them cannot be fetched", async () => {
    state.listFailures = new Set([1605]);
    const res = await app.request("/api/prs");
    expect(res.status).toBe(200);
    const items = (await res.json()) as PrListItem[];
    expect(items).toHaveLength(2);

    const ok = items.find((i) => i.snapshot.number === 1650)!;
    const broken = items.find((i) => i.snapshot.number === 1605)!;
    expect(ok.fetchError).toBeUndefined();
    expect(broken.fetchError).toContain("GitHub 502 for #1605");
    expect(broken.evaluation).toBeNull();
    expect(broken.stale).toBe(true);
    // The placeholder still carries what the listing knew.
    expect(broken.snapshot.title).toBe("Broken");
    expect(broken.snapshot.headSha).toBe("b".repeat(40));
  });
});

describe("single-scan lock", () => {
  it("is claimed synchronously, so two POSTs in one tick cannot both start", async () => {
    const { startScan, ScanInProgressError, runningJob } = await import("../src/server/pipeline.js");
    const first = startScan({ numbers: [] });
    // No await in between: this is exactly the race two concurrent requests hit.
    expect(() => startScan({ numbers: [] })).toThrow(ScanInProgressError);
    expect(runningJob()?.id).toBe(first.id);

    await vi.waitFor(() => {
      expect(runningJob()).toBeNull();
    });
    expect(startScan({ numbers: [] }).id).not.toBe(first.id);
    await vi.waitFor(() => {
      expect(runningJob()).toBeNull();
    });
  });
});

describe("SSE replay", () => {
  it("replays only the running job, and only the close of a finished one", async () => {
    const { emit, recentEvents, resetEvents } = await import("../src/server/events.js");
    resetEvents();
    expect(recentEvents()).toEqual([]);

    emit({ type: "scan:start", jobId: "job1", total: 1 });
    emit({ type: "pr:start", n: 1650, title: "t" });
    emit({ type: "pr:stage", n: 1650, stage: "gates" });
    expect(recentEvents()).toHaveLength(3);

    emit({ type: "scan:done", jobId: "job1" });
    // Nothing is running: a new client is told the scan ended, not replayed it.
    expect(recentEvents()).toEqual([{ type: "scan:done", jobId: "job1" }]);

    emit({ type: "scan:start", jobId: "job2", total: 1 });
    emit({ type: "pr:start", n: 1611, title: "u" });
    const live = recentEvents();
    expect(live).toHaveLength(2);
    expect(live.every((e) => e.type !== "scan:done")).toBe(true);
    resetEvents();
  });
});

describe("cache path validation", () => {
  it("refuses a head SHA that is not a hex object id", async () => {
    const { readSnapshotCache } = await import("../src/server/store.js");
    expect(readSnapshotCache(1650, "../../etc/passwd")).toBeNull();
    expect(readSnapshotCache(1650, "not hex")).toBeNull();
    expect(readSnapshotCache(1650, "")).toBeNull();
    // A well-formed SHA with no cache file on disk is also null, but by absence.
    expect(readSnapshotCache(1650, "a".repeat(40))).toBeNull();
  });
});

describe("placeholder snapshot shape", () => {
  it("keeps files empty so nothing downstream mistakes it for a real fetch", async () => {
    state.listFailures = new Set([1605]);
    const items = (await (await app.request("/api/prs")).json()) as PrListItem[];
    const broken = items.find((i) => i.snapshot.number === 1605)!;
    expect(broken.snapshot.files).toEqual([]);
    expect(broken.snapshot.changedFiles).toBe(0);
    expect(broken.snapshot.mergeable).toBeNull();
    expect(broken.snapshot.ci).toBe("none");
    void file; // fixture import kept for symmetry with the other suites
  });
});
