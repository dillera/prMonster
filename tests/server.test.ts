import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRecord, Evaluation, PrListItem, PrSnapshot } from "../src/shared/types.js";
import { file, policy, snapshot } from "./fixtures.js";

// --- module doubles ---------------------------------------------------------
// The routes under test are about *ordering and validation*, so GitHub and the
// JSON store are replaced; everything else (proposals, decide, gates) is real.

// Deep runs persist to data/deep.json; point that at a scratch file so these
// tests never add runs to the real log or the real day's spend.
vi.hoisted(() => {
  process.env["DEEP_STORE_PATH"] = `/tmp/prmonster-deep-test-${process.pid}.json`;
});

const state = vi.hoisted(() => ({
  liveHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  evaluation: null as Evaluation | null,
  actions: [] as ActionRecord[],
  labels: [] as string[],
  writes: false,
  snapshotError: null as string | null,
  listFailures: new Set<number>(),
  /** PR number -> state the live fetch reports. */
  prState: new Map<number, "open" | "closed" | "merged">(),
  knownPrs: [] as number[],
  cachedSnapshots: new Map<number, PrSnapshot>(),
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
        snapshot: snapshot({ number: n, headSha: state.liveHeadSha, state: state.prState.get(n) ?? "open" }),
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
    knownPrNumbers: () => state.knownPrs,
    latestCachedSnapshot: (n: number) => state.cachedSnapshots.get(n) ?? null,
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

// --- deep analysis routes (DESIGN-deep.md) ----------------------------------

describe("deep analysis routes", () => {
  beforeEach(async () => {
    state.liveHeadSha = "a".repeat(40);
    state.listFailures = new Set();
    state.snapshotError = null;
    const deep = await import("../src/server/deep.js");
    for (const run of deep.readRuns()) {
      if (run.status === "running") deep.abortRun(run.prNumber, run.id);
    }
  });

  async function postJson(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("refuses a run with no requestedBy", async () => {
    const { status, json } = await postJson("/api/prs/1650/deep", { model: "anthropic/claude-haiku-4.5" });
    expect(status).toBe(400);
    expect(String(json["error"])).toContain("requestedBy is required");
  });

  it("refuses a bad model id and a bad PR number", async () => {
    expect((await postJson("/api/prs/1650/deep", { requestedBy: "d", model: 42 })).status).toBe(400);
    expect((await postJson("/api/prs/abc/deep", { requestedBy: "d" })).status).toBe(400);
  });

  it("is 409 while a run for that PR is already in progress", async () => {
    const deep = await import("../src/server/deep.js");
    const llm = await import("../src/server/llm.js");
    const snap = snapshot({ number: 4242, headSha: state.liveHeadSha });

    // A backend that never answers keeps the run in flight.
    const hanging = {
      label: "hanging",
      mock: true,
      chat: (_req: unknown, signal?: AbortSignal) =>
        new Promise<never>((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    };
    const started = deep.runDeep({
      prNumber: 4242,
      requestedBy: "d",
      snapshot: snap,
      backend: hanging as never,
      dossier: {
        prNumber: 4242,
        headSha: snap.headSha,
        baseSha: "b".repeat(40),
        builtAt: new Date().toISOString(),
        revisions: [],
        latestDelta: null,
        deletedLineOrigins: [],
        originPrs: [],
        thread: [],
        maintainers: [],
        crossRefs: [],
        drift: [],
        availability: { git: false, provenance: false, crossRefs: false, notes: [] },
      },
    });
    await vi.waitFor(() => {
      expect(deep.runningFor(4242)).not.toBeNull();
    });

    const { status, json } = await postJson("/api/prs/4242/deep", { requestedBy: "someone else" });
    expect(status).toBe(409);
    expect(String(json["error"])).toContain("already in progress");
    expect(json["runId"]).toBe(deep.runningFor(4242));

    // …and the stop route aborts it, leaving a persisted partial run.
    const stop = await postJson("/api/prs/4242/deep/stop", { runId: String(json["runId"]) });
    expect(stop.status).toBe(200);
    expect(stop.json["stopped"]).toBe(true);
    const run = await started;
    expect(run.status).toBe("aborted");
    void llm;
  });

  it("stop is 404 when nothing is running, and 400 without a runId", async () => {
    expect((await postJson("/api/prs/1650/deep/stop", { runId: "deep_nope" })).status).toBe(404);
    expect((await postJson("/api/prs/1650/deep/stop", {})).status).toBe(400);
  });

  it("is 402 once the daily cap is reached", async () => {
    const deep = await import("../src/server/deep.js");
    const previous = process.env["DEEP_DAILY_CAP_USD"];
    process.env["DEEP_DAILY_CAP_USD"] = "0.01";
    deep.saveRun({
      id: "deep_expensive",
      prNumber: 1650,
      headSha: "a".repeat(40),
      evaluationId: null,
      dossierBuiltAt: new Date().toISOString(),
      model: "m",
      mock: false,
      startedAt: new Date().toISOString(),
      status: "done",
      steps: [],
      brief: null,
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0.5, calls: 1 },
      requestedBy: "d",
    });
    try {
      const { status, json } = await postJson("/api/prs/1650/deep", { requestedBy: "d" });
      expect(status).toBe(402);
      expect(String(json["error"])).toContain("daily deep-analysis cap");
    } finally {
      if (previous === undefined) delete process.env["DEEP_DAILY_CAP_USD"];
      else process.env["DEEP_DAILY_CAP_USD"] = previous;
    }
  });

  it("lists models and spend in the shape the UI expects", async () => {
    const llm = await import("../src/server/llm.js");
    llm.resetModelCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-haiku-4.5",
                name: "Claude Haiku 4.5",
                context_length: 200000,
                supported_parameters: ["tools"],
                pricing: { prompt: "0.000001", completion: "0.000005" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    try {
      const res = await app.request("/api/deep/models");
      const body = (await res.json()) as { models: unknown[]; default: string; keyPresent: boolean };
      expect(res.status).toBe(200);
      expect(Array.isArray(body.models)).toBe(true);
      expect(body.models[0]).toMatchObject({ id: "anthropic/claude-haiku-4.5", promptUsdPerM: 1 });
      expect(body.default).toBe("anthropic/claude-haiku-4.5");

      // keyPresent mirrors the environment, and the UI keys its mock banner off
      // it, so assert both branches rather than whatever this machine has.
      const saved = process.env["OPENROUTER_API_KEY"];
      try {
        delete process.env["OPENROUTER_API_KEY"];
        llm.resetModelCache();
        const without = (await (await app.request("/api/deep/models")).json()) as { keyPresent: boolean };
        expect(without.keyPresent).toBe(false);

        process.env["OPENROUTER_API_KEY"] = "sk-test";
        llm.resetModelCache();
        const with_ = (await (await app.request("/api/deep/models")).json()) as { keyPresent: boolean };
        expect(with_.keyPresent).toBe(true);
      } finally {
        if (saved === undefined) delete process.env["OPENROUTER_API_KEY"];
        else process.env["OPENROUTER_API_KEY"] = saved;
      }
    } finally {
      vi.unstubAllGlobals();
      llm.resetModelCache();
    }

    const spend = (await (await app.request("/api/deep/spend")).json()) as Record<string, number>;
    expect(typeof spend["todayUsd"]).toBe("number");
    expect(typeof spend["capUsd"]).toBe("number");
    expect(typeof spend["runsToday"]).toBe("number");
  });

  it("returns the NEW run in the 202 body, not a previously completed one", async () => {
    const deep = await import("../src/server/deep.js");
    const llm = await import("../src/server/llm.js");

    // A completed run already exists for this PR, as it did when this broke.
    deep.saveRun({
      id: "deep_previous",
      prNumber: 1651,
      headSha: "a".repeat(40),
      evaluationId: null,
      dossierBuiltAt: new Date().toISOString(),
      model: "m (mock)",
      mock: true,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 30_000).toISOString(),
      status: "done",
      steps: [],
      brief: null,
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 1 },
      requestedBy: "someone",
    });

    // Building the dossier is slow; that delay is what exposed the bug.
    const slowChat = vi.spyOn(llm.MockLlmBackend.prototype, "chat").mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                message: { role: "assistant", content: "done thinking" },
                usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
                finishReason: "stop",
                model: "m",
              }),
            50,
          ),
        ),
    );
    try {
      const { status, json } = await postJson("/api/prs/1651/deep", { requestedBy: "dillera" });
      expect(status).toBe(202);
      expect(json["id"]).not.toBe("deep_previous");
      expect(json["status"]).toBe("running");
      expect(json["requestedBy"]).toBe("dillera");
      expect(json["prNumber"]).toBe(1651);
      // The returned id is the one actually in flight.
      expect(deep.runningFor(1651)).toBe(json["id"]);
      await vi.waitFor(() => {
        expect(deep.runningFor(1651)).toBeNull();
      });
      expect(deep.runById(String(json["id"]))).not.toBeNull();
    } finally {
      slowChat.mockRestore();
    }
  });

  it("returns the run history for a PR", async () => {
    const res = await app.request("/api/prs/1650/deep");
    const body = (await res.json()) as { latest: unknown; history: unknown[] };
    expect(res.status).toBe(200);
    expect(Array.isArray(body.history)).toBe(true);
  });
});

describe("closed pull requests stay reachable", () => {
  beforeEach(() => {
    state.liveHeadSha = "a".repeat(40);
    state.listFailures = new Set();
    state.snapshotError = null;
    state.prState = new Map();
    state.knownPrs = [];
    state.cachedSnapshots = new Map();
  });

  it("serves GET /api/prs/:n for a PR that is closed", async () => {
    state.prState.set(1650, "closed");
    const res = await app.request("/api/prs/1650");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: PrSnapshot };
    expect(body.snapshot.state).toBe("closed");
    expect(body.snapshot.number).toBe(1650);
  });

  it("does not 404 the dossier or deep routes for a closed PR", async () => {
    state.prState.set(1650, "merged");
    // GET deep history is pure store access and must answer for any number.
    const history = await app.request("/api/prs/1650/deep");
    expect(history.status).toBe(200);
    // The proposal route only needs an evaluation, not an open PR.
    state.evaluation = evaluationFor(snapshot({ number: 1650, headSha: state.liveHeadSha }));
    const proposal = await app.request("/api/prs/1650/proposal");
    expect(proposal.status).toBe(200);
  });

  it("lists PRs the store knows that are no longer open, newest first", async () => {
    // 1650 and 1605 are open (the listing mock); these two are not.
    state.knownPrs = [1650, 1605, 1359, 1404, 999];
    state.prState.set(1359, "closed");
    state.prState.set(1404, "merged");
    state.cachedSnapshots.set(1359, snapshot({ number: 1359, state: "closed" }));
    state.cachedSnapshots.set(1404, snapshot({ number: 1404, state: "merged" }));
    state.cachedSnapshots.set(999, snapshot({ number: 999 })); // still reports open, so excluded

    const res = await app.request("/api/prs/closed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { closedWithHistory: PrListItem[] };
    expect(body.closedWithHistory.map((i) => i.snapshot.number)).toEqual([1404, 1359]);
    expect(body.closedWithHistory[0]!.snapshot.state).toBe("merged");
    expect(body.closedWithHistory[1]!.snapshot.state).toBe("closed");
    // Open PRs are never in this list, even though the store knows them.
    expect(body.closedWithHistory.some((i) => i.snapshot.number === 1650)).toBe(false);
  });

  it("falls back to the stored snapshot when the PR can no longer be fetched", async () => {
    state.knownPrs = [1359];
    state.listFailures = new Set([1359]);
    state.cachedSnapshots.set(1359, snapshot({ number: 1359, state: "closed", title: "from the cache" }));

    const body = (await (await app.request("/api/prs/closed")).json()) as { closedWithHistory: PrListItem[] };
    expect(body.closedWithHistory).toHaveLength(1);
    expect(body.closedWithHistory[0]!.snapshot.title).toBe("from the cache");
    expect(body.closedWithHistory[0]!.fetchError).toContain("GitHub 502");
    expect(body.closedWithHistory[0]!.stale).toBe(true);
  });

  it("caps the list at 20", async () => {
    state.knownPrs = Array.from({ length: 40 }, (_, i) => 1000 + i);
    for (const n of state.knownPrs) {
      state.prState.set(n, "closed");
      state.cachedSnapshots.set(n, snapshot({ number: n, state: "closed" }));
    }
    const body = (await (await app.request("/api/prs/closed")).json()) as { closedWithHistory: PrListItem[] };
    expect(body.closedWithHistory).toHaveLength(20);
    expect(body.closedWithHistory[0]!.snapshot.number).toBe(1039); // newest first
  });
});

describe("deep analysis is never triggered by anything but its own route", () => {
  it("a scan makes no LLM call", async () => {
    const llm = await import("../src/server/llm.js");
    const deep = await import("../src/server/deep.js");
    const pipeline = await import("../src/server/pipeline.js");

    // Any attempt to reach a model during a scan fails loudly.
    const tripwire = vi.fn(() => {
      throw new Error("a scan must never call a model");
    });
    const chatSpy = vi.spyOn(llm.MockLlmBackend.prototype, "chat").mockImplementation(tripwire as never);
    const openRouterSpy = vi.spyOn(llm.OpenRouterBackend.prototype, "chat").mockImplementation(tripwire as never);
    const runsBefore = deep.readRuns().length;

    try {
      const job = pipeline.startScan({ numbers: [] });
      await vi.waitFor(() => {
        expect(pipeline.runningJob()).toBeNull();
      });
      expect(job.status).toBe("done");
      expect(chatSpy).not.toHaveBeenCalled();
      expect(openRouterSpy).not.toHaveBeenCalled();
      expect(deep.readRuns()).toHaveLength(runsBefore);
      expect(deep.runningFor(1650)).toBeNull();
    } finally {
      chatSpy.mockRestore();
      openRouterSpy.mockRestore();
    }
  });

  it("reconnecting to the event stream starts nothing", async () => {
    const deep = await import("../src/server/deep.js");
    const before = deep.readRuns().length;
    const { recentEvents } = await import("../src/server/events.js");
    recentEvents();
    recentEvents();
    expect(deep.readRuns()).toHaveLength(before);
  });
});
