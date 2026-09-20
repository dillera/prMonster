// Typed client for the harness API (DESIGN.md 5), plus the scan-progress SSE hook.
//
// Why src/web/lib/api.ts and not src/web/api.ts: the Vite dev proxy in
// vite.config.ts forwards every URL starting with "/api" to the Hono server, and
// that prefix match also catches the module URL "/api.ts", so a module at the web
// root would be proxied away and fail to load in `npm run dev`. Moving it one
// directory down keeps the documented name with a URL that does not collide. The
// alternative fix is a proxy key of "^/api/" in vite.config.ts, which this agent
// does not own.
//
// Fixtures mode: with VITE_FIXTURES=1 every call is served from src/web/fixtures.ts
// behind a small artificial latency, and "scanning" replays fake pr:stage / pr:done
// events over a few seconds so the live progress UI can be built without the server.
// The fixture module is imported dynamically so it never lands in the normal bundle.

import { useEffect, useRef, useState } from "react";

import type {
  ActionKind,
  ActionRecord,
  Decision,
  Evaluation,
  Policy,
  PrListItem,
  PrSnapshot,
  Proposal,
  ScanEvent,
  ScanJob,
  TriageState,
} from "../../shared/types";

/** True when the app runs against src/web/fixtures.ts instead of the Hono server. */
export const FIXTURES_MODE = import.meta.env.VITE_FIXTURES === "1";

// ---------------------------------------------------------------- response shapes
// GET /api/health and GET /api/stats return inline object shapes in DESIGN.md 5
// rather than named types in src/shared/types.ts, so they are named here.

export interface HealthInfo {
  ok: boolean;
  jev: "live" | "mock";
  model: string;
  repo: string;
  githubAuth: "token" | "gh" | "anon";
  /**
   * Whether ALLOW_GITHUB_WRITES=1. Not in the DESIGN.md 5 table, but the server
   * reports it and the send modal needs it to say what a confirm will really do.
   * Absent means unknown, and the modal says so rather than guessing.
   */
  writesEnabled?: boolean;
}

export interface StatsSummary {
  counts: { READY: number; NEEDS_REVIEW: number; BLOCKED: number; UNEVALUATED: number };
  tokensUsed: number;
  estCostUsd: number;
  lastScanAt: string | null;
}

export interface PrDetail {
  snapshot: PrSnapshot;
  evaluation: Evaluation | null;
}

export interface ActionRequest {
  proposalId: string;
  kind: ActionKind;
  body?: string;
  labels?: string[];
  confirmedBy: string;
  confirmText: string;
}

export interface TriageRequest {
  status: TriageState["status"];
  note?: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- transport
interface RawResponse {
  status: number;
  ok: boolean;
  parsed: unknown;
}

/** Fetch and parse, without deciding what a non-2xx status means. */
async function rawRequest(path: string, init?: RequestInit): Promise<RawResponse> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
  } catch {
    throw new ApiError(0, `Cannot reach the harness server at ${path}. Is it running on port 8787?`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      if (!res.ok) throw new ApiError(res.status, text.slice(0, 300));
      throw new ApiError(res.status, `Expected JSON from ${path}, got ${text.slice(0, 80)}`);
    }
  }
  return { status: res.status, ok: res.ok, parsed };
}

function errorFrom(res: RawResponse, path?: string): ApiError {
  const parsed = res.parsed;
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    typeof (parsed as { error: unknown }).error === "string"
  ) {
    return new ApiError(res.status, (parsed as { error: string }).error);
  }
  // No message at all usually means the dev proxy could not reach the harness, for
  // instance while the server is restarting after a file change.
  const where = path ? ` from ${path}` : "";
  return new ApiError(
    res.status,
    res.status === 502 || res.status === 504
      ? `The harness server did not respond${where} (${res.status}). It may be restarting; try again in a moment.`
      : `The server returned ${res.status}${where} with no message.`,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await rawRequest(path, init);
  if (!res.ok) throw errorFrom(res, path);
  return res.parsed as T;
}

/** An ActionRecord is a normal result even when the server refuses the write. */
function isActionRecord(value: unknown): value is ActionRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { outcome?: unknown }).outcome === "string"
  );
}

// ---------------------------------------------------------------- fixtures backend
type FixtureModule = typeof import("../fixtures");

interface FixtureDb {
  prs: PrListItem[];
  policy: Policy;
  proposals: Record<number, Proposal>;
  actions: ActionRecord[];
  stats: StatsSummary;
  health: HealthInfo;
  history: Record<number, Evaluation[]>;
  jobs: Record<string, ScanJob>;
}

let fixtureDb: FixtureDb | null = null;
let fixtureLoad: Promise<FixtureDb> | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function db(): Promise<FixtureDb> {
  if (fixtureDb) return fixtureDb;
  if (!fixtureLoad) {
    fixtureLoad = import("../fixtures").then((mod: FixtureModule) => {
      fixtureDb = {
        prs: clone(mod.FIXTURE_PRS),
        policy: clone(mod.FIXTURE_POLICY),
        proposals: clone(mod.FIXTURE_PROPOSALS),
        actions: clone(mod.FIXTURE_ACTIONS),
        stats: clone(mod.FIXTURE_STATS),
        health: clone(mod.FIXTURE_HEALTH),
        history: clone(mod.FIXTURE_EVALUATION_HISTORY),
        jobs: { [mod.FIXTURE_SCAN_JOB.id]: clone(mod.FIXTURE_SCAN_JOB) },
      };
      return fixtureDb;
    });
  }
  return fixtureLoad;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Small artificial latency so loading states are exercised in fixtures mode. */
async function latency(min = 90, max = 260): Promise<void> {
  await sleep(min + Math.random() * (max - min));
}

// ---------------------------------------------------------------- event bus
type EventHandler = (event: ScanEvent) => void;
const fixtureSubscribers = new Set<EventHandler>();

function emitFixtureEvent(event: ScanEvent): void {
  for (const handler of [...fixtureSubscribers]) handler(event);
}

/**
 * Subscribe to scan events. Returns an unsubscribe function.
 * Real mode opens an EventSource on /api/events; both data-only frames (with a
 * `type` field) and named SSE events are accepted, since either is a valid reading
 * of DESIGN.md 5.
 */
export function subscribeScanEvents(
  handler: EventHandler,
  onOpen?: () => void,
  onError?: () => void,
): () => void {
  if (FIXTURES_MODE) {
    fixtureSubscribers.add(handler);
    onOpen?.();
    return () => fixtureSubscribers.delete(handler);
  }

  const source = new EventSource("/api/events");
  const seen = new Set<string>();

  // A named SSE event never fires onmessage, so listening for both forms cannot
  // double count. `seen` only guards a server that sends the frame twice.
  const dispatch = (raw: string): void => {
    try {
      const event = JSON.parse(raw) as ScanEvent;
      if (!event || typeof event !== "object" || typeof event.type !== "string") return;
      if (seen.has(raw)) return;
      seen.add(raw);
      window.setTimeout(() => seen.delete(raw), 50);
      handler(event);
    } catch {
      /* ignore malformed frames */
    }
  };

  source.onmessage = (ev: MessageEvent<string>) => dispatch(ev.data);
  const named: ScanEvent["type"][] = ["scan:start", "pr:start", "pr:stage", "pr:done", "pr:error", "scan:done"];
  for (const name of named) {
    source.addEventListener(name, (ev) => dispatch((ev as MessageEvent<string>).data));
  }
  source.onopen = () => onOpen?.();
  source.onerror = () => onError?.();

  return () => source.close();
}

// ---------------------------------------------------------------- routes
export async function getHealth(): Promise<HealthInfo> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    return clone(store.health);
  }
  return request<HealthInfo>("/api/health");
}

export async function listPrs(): Promise<PrListItem[]> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(240, 620);
    return clone(store.prs);
  }
  return request<PrListItem[]>("/api/prs");
}

export async function getPr(n: number): Promise<PrDetail> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    const item = store.prs.find((p) => p.snapshot.number === n);
    if (!item) throw new ApiError(404, `PR #${n} is not in the open list`);
    return clone({ snapshot: item.snapshot, evaluation: item.evaluation });
  }
  return request<PrDetail>(`/api/prs/${n}`);
}

export async function startScan(options: { force?: boolean; numbers?: number[] } = {}): Promise<{ jobId: string }> {
  if (FIXTURES_MODE) return startFixtureScan(options);
  return request<{ jobId: string }>("/api/scan", { method: "POST", body: JSON.stringify(options) });
}

export async function getScanJob(jobId: string): Promise<ScanJob> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(40, 120);
    const job = store.jobs[jobId];
    if (!job) throw new ApiError(404, `No scan job ${jobId}`);
    return clone(job);
  }
  return request<ScanJob>(`/api/scan/${jobId}`);
}

export async function getPolicy(): Promise<Policy> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    return clone(store.policy);
  }
  return request<Policy>("/api/policy");
}

export async function savePolicy(policy: Policy): Promise<Policy> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(200, 420);
    store.policy = clone(policy);
    return clone(store.policy);
  }
  return request<Policy>("/api/policy", { method: "PUT", body: JSON.stringify(policy) });
}

/**
 * Re-run the decision for a stored evaluation under a trial policy.
 *
 * The decision math lives on the server and only on the server: this posts to
 * /api/decide and returns whatever it says. In fixtures mode there is no server,
 * so the fixture backend returns the stored decision with the composite nudged by
 * the threshold and penalty deltas, which is enough for the preview to visibly
 * react while developing. That approximation never runs against a real server.
 */
export async function decidePreview(evaluation: Evaluation, policy: Policy): Promise<Decision> {
  if (FIXTURES_MODE) return fixtureDecide(evaluation, policy);
  return request<Decision>("/api/decide", {
    method: "POST",
    body: JSON.stringify({ evaluationId: evaluation.id, policy }),
  });
}

export async function listEvaluations(n: number): Promise<Evaluation[]> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    return clone(store.history[n] ?? []);
  }
  return request<Evaluation[]>(`/api/evaluations?n=${n}`);
}

export async function getStats(): Promise<StatsSummary> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    return clone(store.stats);
  }
  return request<StatsSummary>("/api/stats");
}

export async function getProposal(n: number): Promise<Proposal> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(160, 380);
    const proposal = store.proposals[n];
    if (!proposal) throw new ApiError(404, `PR #${n} has no evaluation to draft an action from`);
    return clone(proposal);
  }
  return request<Proposal>(`/api/prs/${n}/proposal`);
}

/**
 * Submit one human confirmed action.
 *
 * A refusal is not a transport error: the server answers 400, 403, 409 or 502 with
 * the ActionRecord it just wrote to the audit log. Those bodies are returned as
 * normal results so the UI can show the outcome and log it, which is the whole flow
 * while ALLOW_GITHUB_WRITES is off. Only a response that carries no record at all
 * (bad JSON body, route missing, server down) throws.
 */
export async function postAction(n: number, req: ActionRequest): Promise<ActionRecord> {
  if (FIXTURES_MODE) return fixtureAction(n, req);
  const path = `/api/prs/${n}/actions`;
  const res = await rawRequest(path, { method: "POST", body: JSON.stringify(req) });
  if (isActionRecord(res.parsed)) return res.parsed;
  if (!res.ok) throw errorFrom(res, path);
  throw new ApiError(res.status, "The server did not return an action record.");
}

export async function listActions(n?: number): Promise<ActionRecord[]> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    const all = clone(store.actions);
    return n === undefined ? all : all.filter((a) => a.prNumber === n);
  }
  return request<ActionRecord[]>(n === undefined ? "/api/actions" : `/api/actions?n=${n}`);
}

export async function setTriage(n: number, req: TriageRequest): Promise<TriageState> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(140, 300);
    const item = store.prs.find((p) => p.snapshot.number === n);
    if (!item) throw new ApiError(404, `PR #${n} is not in the open list`);
    const state: TriageState = {
      prNumber: n,
      status: req.status,
      ...(req.note ? { note: req.note } : {}),
      updatedAt: new Date().toISOString(),
      by: "local",
    };
    item.triage = state;
    return clone(state);
  }
  return request<TriageState>(`/api/prs/${n}/triage`, { method: "POST", body: JSON.stringify(req) });
}

// ---------------------------------------------------------------- fixture behaviours
function fixtureDecide(evaluation: Evaluation, policy: Policy): Promise<Decision> {
  return (async () => {
    const store = await db();
    await latency(70, 180);
    const base = store.policy;
    const stored = evaluation.decision;

    const softFails = evaluation.gates.filter((g) => g.severity === "soft" && !g.passed).length;
    const penaltyDelta = softFails * (base.softGatePenalty - policy.softGatePenalty);
    const thresholdNudge = (base.readyThreshold - policy.readyThreshold) * 0.5;
    const composite = Math.max(0, Math.min(100, stored.composite + penaltyDelta + thresholdNudge));

    const hardGateFailed = evaluation.gates.some((g) => g.severity === "hard" && !g.passed);
    let hardBlocked = hardGateFailed;
    const hardBlockReasons: Decision["reasons"] = [];
    for (const [id, threshold] of Object.entries(policy.hardBlocks)) {
      const answer = evaluation.prAnswers[id] ?? evaluation.aggregated[id]?.answer;
      if (answer && answer.type === "noul" && answer.noul >= threshold) {
        hardBlocked = true;
        hardBlockReasons.push({
          code: "jev_hard_block",
          text: `${id}: Jev is ${Math.round(answer.noul * 100)}% sure, threshold ${Math.round(threshold * 100)}%`,
          source: "jev",
          questionId: id,
        });
      }
    }

    const confOk = stored.minConfidence === null || stored.minConfidence >= policy.confidenceFloor;
    const uncertainOk = stored.uncertainNouls.length <= policy.maxUncertainNouls;
    const sizeBucket = evaluation.gates.find((g) => g.id === "size_bucket")?.value;
    const sizeOk = sizeBucket !== "huge";

    let kind: Decision["kind"];
    if (hardBlocked) kind = "BLOCKED";
    else if (composite >= policy.readyThreshold && confOk && uncertainOk && sizeOk) kind = "READY";
    else kind = "NEEDS_REVIEW";

    const keptReasons = stored.reasons.filter((r) => r.code !== "jev_hard_block");
    return {
      ...stored,
      kind,
      composite: Math.round(composite * 100) / 100,
      reasons: [...hardBlockReasons, ...keptReasons],
      explanation: [
        `Preview only: trial policy puts this at ${composite.toFixed(1)} and routes it ${kind}.`,
        ...stored.explanation.slice(1),
      ],
    };
  })();
}

function fixtureAction(n: number, req: ActionRequest): Promise<ActionRecord> {
  return (async () => {
    const store = await db();
    await latency(260, 540);
    const item = store.prs.find((p) => p.snapshot.number === n);
    const proposal = store.proposals[n];
    if (!item || !proposal) throw new ApiError(404, `PR #${n} has no draft action`);

    let outcome: ActionRecord["outcome"] = "refused_writes_disabled";
    let error =
      "ALLOW_GITHUB_WRITES is not set to 1; nothing was sent to GitHub. The draft is kept in the audit log.";

    if (req.confirmText !== "CONFIRM" || req.confirmedBy.trim() === "") {
      outcome = "refused_bad_confirm";
      error = "Confirmation text did not match CONFIRM, or no name was given.";
    } else if (proposal.headSha !== item.snapshot.headSha) {
      outcome = "refused_stale";
      error = `The PR moved to head sha ${item.snapshot.headSha.slice(0, 8)} after this evaluation; re-evaluate before posting.`;
    }

    const record: ActionRecord = {
      id: `act_${Date.now().toString(36).toUpperCase()}`,
      prNumber: n,
      headSha: proposal.headSha,
      proposalId: req.proposalId,
      kind: req.kind,
      ...(req.body ? { body: req.body } : {}),
      ...(req.labels ? { labels: req.labels } : {}),
      confirmedBy: req.confirmedBy,
      requestedAt: new Date().toISOString(),
      outcome,
      error,
    };
    store.actions = [record, ...store.actions];
    return clone(record);
  })();
}

const STAGES: Array<{ stage: ScanStage; detail: (item: PrListItem) => string }> = [
  { stage: "fetch", detail: (i) => `${i.snapshot.changedFiles} files, ${(i.snapshot.diffBytes / 1024).toFixed(1)} KB diff` },
  { stage: "gates", detail: (i) => `${i.evaluation?.gates.length ?? 18} deterministic checks` },
  {
    stage: "chunk",
    detail: (i) => {
      const chunks = i.evaluation?.chunks ?? [];
      const split = chunks.find((c) => c.chunk.truncated);
      const base = `${chunks.length} chunks under the token budget`;
      return split
        ? `${base}, chunk ${split.chunk.index}/${chunks.length} too large, split into 2`
        : base;
    },
  },
  {
    stage: "jev",
    detail: (i) => {
      const chunks = i.evaluation?.chunks ?? [];
      const failed = chunks.filter((c) => typeof c.error === "string").length;
      const tokens = i.evaluation?.usage.input_tokens.toLocaleString() ?? "0";
      return failed > 0
        ? `${chunks.length + 1} requests, ${tokens} tokens, ${failed} chunk failed`
        : `${chunks.length + 1} requests, ${tokens} tokens`;
    },
  },
  { stage: "decide", detail: () => "weights, thresholds, route" },
];

let fixtureScanTimers: number[] = [];

function startFixtureScan(options: { force?: boolean; numbers?: number[] }): Promise<{ jobId: string }> {
  return (async () => {
    const store = await db();
    const running = Object.values(store.jobs).find((j) => j.status === "running");
    if (running) throw new ApiError(409, `A scan is already running (${running.id})`);

    const targets = store.prs.filter(
      (p) => !options.numbers || options.numbers.includes(p.snapshot.number),
    );
    const jobId = `job_${Date.now().toString(36).toUpperCase()}`;
    const job: ScanJob = {
      id: jobId,
      startedAt: new Date().toISOString(),
      total: targets.length,
      done: 0,
      errors: [],
      status: "running",
    };
    store.jobs[jobId] = job;

    for (const timer of fixtureScanTimers) window.clearTimeout(timer);
    fixtureScanTimers = [];

    let t = 120;
    const at = (fn: () => void, delay: number): void => {
      fixtureScanTimers.push(window.setTimeout(fn, delay));
    };

    at(() => emitFixtureEvent({ type: "scan:start", jobId, total: targets.length }), t);

    for (const item of targets) {
      const n = item.snapshot.number;
      t += 220;
      at(() => {
        job.current = n;
        emitFixtureEvent({ type: "pr:start", n, title: item.snapshot.title });
      }, t);

      for (const step of STAGES) {
        t += 150 + Math.round(Math.random() * 220);
        at(() => emitFixtureEvent({ type: "pr:stage", n, stage: step.stage, detail: step.detail(item) }), t);
      }

      t += 200;
      const evaluation = item.evaluation;
      if (evaluation) {
          // A fresh evaluation gets a fresh id, exactly as the server does, so views
        // keyed on the evaluation id refresh after a re-evaluate.
      const refreshed: Evaluation = {
        ...evaluation,
        id: `${evaluation.id.split("#")[0]}#${Date.now().toString(36)}`,
        evaluatedAt: new Date().toISOString(),
      };
        at(() => {
          item.evaluation = refreshed;
          item.stale = false;
          job.done += 1;
          emitFixtureEvent({ type: "pr:done", n, evaluation: refreshed });
        }, t);
      } else {
        at(() => {
          job.done += 1;
          job.errors.push({ n, error: "GitHub returned 422 for the diff; too large or not ready yet" });
          emitFixtureEvent({
            type: "pr:error",
            n,
            error: "GitHub returned 422 for the diff; too large or not ready yet",
          });
        }, t);
      }
    }

    t += 260;
    at(() => {
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      delete job.current;
      store.stats.lastScanAt = job.finishedAt;
      emitFixtureEvent({ type: "scan:done", jobId });
    }, t);

    return { jobId };
  })();
}

// ---------------------------------------------------------------- SSE hook
export type ScanStage = "fetch" | "gates" | "chunk" | "jev" | "decide";

export interface ScanProgress {
  connected: boolean;
  running: boolean;
  jobId: string | null;
  total: number;
  done: number;
  current: number | null;
  /** Current stage per PR number, while that PR is being evaluated. */
  stages: Record<number, { stage: ScanStage; detail?: string }>;
  errors: Array<{ n: number; error: string }>;
  /** One short sentence describing the latest event, for the aria-live region. */
  message: string;
}

const IDLE: ScanProgress = {
  connected: false,
  running: false,
  jobId: null,
  total: 0,
  done: 0,
  current: null,
  stages: {},
  errors: [],
  message: "",
};

const STAGE_WORDS: Record<ScanStage, string> = {
  fetch: "fetching from GitHub",
  gates: "running gates",
  chunk: "chunking the diff",
  jev: "asking Jev",
  decide: "deciding",
};

/**
 * Live scan progress from /api/events (or the fixture replay).
 * `onEvent` is called for every event, which is how the app folds `pr:done`
 * evaluations back into its list without refetching.
 */
export function useScanEvents(onEvent?: (event: ScanEvent) => void): ScanProgress {
  const [progress, setProgress] = useState<ScanProgress>(IDLE);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const unsubscribe = subscribeScanEvents(
      (event) => {
        handlerRef.current?.(event);
        setProgress((prev) => reduceScanEvent(prev, event));
      },
      () => setProgress((prev) => ({ ...prev, connected: true })),
      () => setProgress((prev) => ({ ...prev, connected: false })),
    );
    return unsubscribe;
  }, []);

  return progress;
}

export function reduceScanEvent(prev: ScanProgress, event: ScanEvent): ScanProgress {
  switch (event.type) {
    case "scan:start":
      return {
        ...prev,
        connected: true,
        running: true,
        jobId: event.jobId,
        total: event.total,
        done: 0,
        current: null,
        stages: {},
        errors: [],
        message: `Scan started, ${event.total} pull requests queued.`,
      };
    case "pr:start":
      return {
        ...prev,
        connected: true,
        running: true,
        current: event.n,
        stages: { ...prev.stages, [event.n]: { stage: "fetch" } },
        message: `PR ${event.n}: ${event.title}`,
      };
    case "pr:stage":
      return {
        ...prev,
        connected: true,
        running: true,
        current: event.n,
        stages: {
          ...prev.stages,
          [event.n]: { stage: event.stage, ...(event.detail ? { detail: event.detail } : {}) },
        },
        message: `PR ${event.n}: ${STAGE_WORDS[event.stage]}${event.detail ? `, ${event.detail}` : ""}`,
      };
    case "pr:done": {
      const stages = { ...prev.stages };
      delete stages[event.n];
      return {
        ...prev,
        connected: true,
        done: prev.done + 1,
        stages,
        message: `PR ${event.n} routed ${event.evaluation.decision.kind.replace("_", " ").toLowerCase()}, composite ${event.evaluation.decision.composite.toFixed(1)}.`,
      };
    }
    case "pr:error": {
      const stages = { ...prev.stages };
      delete stages[event.n];
      return {
        ...prev,
        connected: true,
        done: prev.done + 1,
        stages,
        errors: [...prev.errors, { n: event.n, error: event.error }],
        message: `PR ${event.n} failed: ${event.error}`,
      };
    }
    case "scan:done":
      return {
        ...prev,
        connected: true,
        running: false,
        current: null,
        stages: {},
        message: `Scan finished, ${prev.done} pull requests evaluated.`,
      };
    default:
      return prev;
  }
}
