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
  AdminSettings,
  Decision,
  DeepBrief,
  DeepEvent,
  DeepModel,
  DeepRun,
  DeepStep,
  Dossier,
  Evaluation,
  Policy,
  PrListItem,
  PrSnapshot,
  Proposal,
  ScanEvent,
  ScanJob,
  SettingTestResult,
  SettingValue,
  TriageState,
} from "../../shared/types";

/** Everything that arrives on /api/events: scan progress and deep analysis. */
export type HarnessEvent = ScanEvent | DeepEvent;

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

export interface DeepModelsResponse {
  models: DeepModel[];
  /** Model id preselected when the reviewer has no stored preference. */
  default: string | null;
  /** False when OPENROUTER_API_KEY is absent: runs are mock and labelled. */
  keyPresent: boolean;
}

export interface DeepSpend {
  todayUsd: number;
  capUsd: number;
  runsToday: number;
}

export interface DeepRuns {
  latest: DeepRun | null;
  history: DeepRun[];
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
  closedPrs: PrListItem[];
  dossiers: Record<number, Dossier>;
  deepRuns: Record<number, DeepRun[]>;
  deepModels: DeepModelsResponse;
  deepSpend: DeepSpend;
  policy: Policy;
  proposals: Record<number, Proposal>;
  actions: ActionRecord[];
  stats: StatsSummary;
  health: HealthInfo;
  history: Record<number, Evaluation[]>;
  jobs: Record<string, ScanJob>;
  admin: AdminSettings;
  adminTests: Record<string, SettingTestResult>;
}

let fixtureDb: FixtureDb | null = null;
let fixtureLoad: Promise<FixtureDb> | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Open PRs first, then the closed ones that still have stored history. */
function findFixtureItem(store: FixtureDb, n: number): PrListItem | undefined {
  return (
    store.prs.find((p) => p.snapshot.number === n) ??
    store.closedPrs.find((p) => p.snapshot.number === n)
  );
}

async function db(): Promise<FixtureDb> {
  if (fixtureDb) return fixtureDb;
  if (!fixtureLoad) {
    fixtureLoad = import("../fixtures").then((mod: FixtureModule) => {
      fixtureDb = {
        prs: clone(mod.FIXTURE_PRS),
        closedPrs: clone(mod.FIXTURE_CLOSED_PRS),
        policy: clone(mod.FIXTURE_POLICY),
        proposals: clone(mod.FIXTURE_PROPOSALS),
        actions: clone(mod.FIXTURE_ACTIONS),
        stats: clone(mod.FIXTURE_STATS),
        health: clone(mod.FIXTURE_HEALTH),
        history: clone(mod.FIXTURE_EVALUATION_HISTORY),
        dossiers: clone(mod.FIXTURE_DOSSIERS),
        deepRuns: clone(mod.FIXTURE_DEEP_RUNS),
        deepModels: clone(mod.FIXTURE_DEEP_MODELS),
        deepSpend: clone(mod.FIXTURE_DEEP_SPEND),
        jobs: { [mod.FIXTURE_SCAN_JOB.id]: clone(mod.FIXTURE_SCAN_JOB) },
        admin: clone(mod.FIXTURE_ADMIN_SETTINGS),
        adminTests: clone(mod.FIXTURE_ADMIN_TESTS),
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
type EventHandler = (event: HarnessEvent) => void;
const fixtureSubscribers = new Set<EventHandler>();

function emitFixtureEvent(event: HarnessEvent): void {
  for (const handler of [...fixtureSubscribers]) handler(event);
}

/**
 * Subscribe to scan events. Returns an unsubscribe function.
 * Real mode opens an EventSource on /api/events; both data-only frames (with a
 * `type` field) and named SSE events are accepted, since either is a valid reading
 * of DESIGN.md 5.
 */
export function subscribeEvents(
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
      const event = JSON.parse(raw) as HarnessEvent;
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
  const named: HarnessEvent["type"][] = [
    "scan:start",
    "pr:start",
    "pr:stage",
    "pr:done",
    "pr:error",
    "scan:done",
    "deep:start",
    "deep:step",
    "deep:done",
    "deep:error",
  ];
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

/**
 * Pull requests that are closed or merged but still have stored history.
 *
 * The route is additive, and older servers answer 400 or 404 for it because
 * /api/prs/:n matches first. That is treated as "no closed list" rather than an
 * error, so the board simply does not show the section.
 */
export async function listClosedPrs(): Promise<PrListItem[]> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(180, 420);
    return clone(store.closedPrs);
  }
  const res = await rawRequest("/api/prs/closed");
  if (res.ok) return normaliseClosedPrs(res.parsed);
  if (res.status === 400 || res.status === 404) return [];
  throw errorFrom(res, "/api/prs/closed");
}

/**
 * The closed list is specified as `PrListItem[]`, but the live server currently
 * wraps it as `{ closedWithHistory: [...] }`. Both are accepted, and anything else
 * reads as an empty list: a secondary section must never be able to blank the board.
 */
export function normaliseClosedPrs(raw: unknown): PrListItem[] {
  const candidate = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as Record<string, unknown>).closedWithHistory ??
        (raw as Record<string, unknown>).items ??
        (raw as Record<string, unknown>).prs)
      : null;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (item): item is PrListItem =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as PrListItem).snapshot?.number === "number",
  );
}

export async function getPr(n: number): Promise<PrDetail> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    const item = findFixtureItem(store, n);
    if (!item) throw new ApiError(404, `PR #${n} is not known to the harness`);
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

/**
 * The drafted action for a PR. With `fromDeep` the server builds the draft from that
 * deep run's reply instead of the template (DESIGN-deep.md, proposal route).
 */
export async function getProposal(n: number, fromDeep?: string): Promise<Proposal> {
  if (FIXTURES_MODE) return fixtureProposal(n, fromDeep);
  const query = fromDeep ? `?fromDeep=${encodeURIComponent(fromDeep)}` : "";
  return request<Proposal>(`/api/prs/${n}/proposal${query}`);
}

// ---------------------------------------------------------------- deep analysis
/** The dossier for a PR: deterministic, built from git and the GitHub thread. */
export async function getDossier(n: number, refresh = false): Promise<Dossier> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(220, 520);
    const dossier = store.dossiers[n];
    if (!dossier) {
      throw new ApiError(503, `No dossier was built for PR #${n} in fixtures mode.`);
    }
    return clone(dossier);
  }
  return request<Dossier>(`/api/prs/${n}/dossier${refresh ? "?refresh=1" : ""}`);
}

export async function getDeepRuns(n: number): Promise<DeepRuns> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(120, 300);
    const runs = store.deepRuns[n] ?? [];
    advanceFixtureRun(n);
    const [latest = null, ...history] = runs;
    return clone({ latest, history });
  }
  return request<DeepRuns>(`/api/prs/${n}/deep`);
}

export async function getDeepModels(): Promise<DeepModelsResponse> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    return clone(store.deepModels);
  }
  // DESIGN-deep.md describes this route as an array "plus { default, keyPresent }",
  // which can be read two ways, so both shapes are accepted.
  const raw = await request<unknown>("/api/deep/models");
  return normaliseModels(raw);
}

export function normaliseModels(raw: unknown): DeepModelsResponse {
  const empty: DeepModelsResponse = { models: [], default: null, keyPresent: false };
  if (Array.isArray(raw)) return { ...empty, models: raw as DeepModel[] };
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.models) ? obj.models : Array.isArray(obj.data) ? obj.data : [];
  return {
    models: list as DeepModel[],
    default: typeof obj.default === "string" ? obj.default : null,
    keyPresent: obj.keyPresent === true,
  };
}

export async function getDeepSpend(): Promise<DeepSpend> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    return clone(store.deepSpend);
  }
  return request<DeepSpend>("/api/deep/spend");
}

/**
 * Start a deep run. This is the only way a run ever starts: a reviewer clicked, and
 * gave a name (DESIGN-deep.md non-negotiables).
 */
export async function startDeepRun(
  n: number,
  options: { model?: string; requestedBy: string },
): Promise<DeepRun> {
  if (FIXTURES_MODE) return startFixtureDeepRun(n, options);
  return request<DeepRun>(`/api/prs/${n}/deep`, { method: "POST", body: JSON.stringify(options) });
}

/**
 * Ask the server to abort the running analysis.
 *
 * DESIGN-deep.md describes a stop button but its route table has no stop route, so
 * this posts to the obvious path and reports clearly when the server has none.
 */
export async function stopDeepRun(n: number, runId: string): Promise<DeepRun | null> {
  if (FIXTURES_MODE) return stopFixtureDeepRun(n, runId);
  const res = await rawRequest(`/api/prs/${n}/deep/stop`, {
    method: "POST",
    body: JSON.stringify({ runId }),
  });
  if (res.ok) return (res.parsed as DeepRun) ?? null;
  if (res.status === 404 || res.status === 405) {
    throw new ApiError(res.status, "This server has no stop route for deep runs; the run will stop at its own step or cost cap.");
  }
  throw errorFrom(res, `/api/prs/${n}/deep/stop`);
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
    const item = findFixtureItem(store, n);
    if (!item) throw new ApiError(404, `PR #${n} is not known to the harness`);
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


// ---------------------------------------------------------------- admin settings
// The .env editor behind #/admin. A secret is never sent to the browser in full:
// the server replaces it with a short mask, and a PUT that echoes that mask back is
// ignored server side, so an untouched secret field can never overwrite the key.

export async function getAdminSettings(): Promise<AdminSettings> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency();
    return clone(store.admin);
  }
  return request<AdminSettings>("/api/admin/settings");
}

/**
 * Write the changed keys only. A value of null or "" unsets the key, which drops
 * the line from .env and lets the built in default take over again.
 */
export async function saveAdminSettings(updates: Record<string, string | null>): Promise<AdminSettings> {
  if (FIXTURES_MODE) return fixtureSaveAdminSettings(updates);
  return request<AdminSettings>("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ updates }),
  });
}

export async function testAdminSetting(key: string): Promise<SettingTestResult> {
  if (FIXTURES_MODE) {
    const store = await db();
    await latency(260, 620);
    const canned = store.adminTests[key];
    if (canned) return { ...clone(canned), checkedAt: new Date().toISOString() };
    // Same answer the server gives for a key it cannot check: ok, with a detail
    // the page renders as a neutral "no test" rather than as a pass.
    return { key, ok: true, detail: "no test for this setting", checkedAt: new Date().toISOString() };
  }
  return request<SettingTestResult>("/api/admin/settings/test", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

/** Mirror of the server's write rules, good enough to develop the page against. */
async function fixtureSaveAdminSettings(updates: Record<string, string | null>): Promise<AdminSettings> {
  const store = await db();
  await latency(280, 520);
  const restart = new Set(store.admin.restartRequired);
  for (const [key, raw] of Object.entries(updates)) {
    const def = store.admin.defs.find((d) => d.key === key);
    if (!def) continue;
    const current = store.admin.values.find((v) => v.key === key);
    // A secret echoed back as its own mask is a field the reviewer never touched.
    if (def.secret && current?.value && raw === current.value) continue;
    const value = raw === null || raw === "" ? null : raw;
    const shown = value !== null && def.secret ? maskSecret(value) : value;
    const next: SettingValue = {
      key,
      set: value !== null,
      source: value !== null ? "dotenv" : "default",
      value: shown,
      effective: value !== null ? shown : def.default,
    };
    const at = store.admin.values.findIndex((v) => v.key === key);
    if (at >= 0) store.admin.values[at] = next;
    else store.admin.values.push(next);
    if (def.requiresRestart) restart.add(key);
  }
  store.admin.restartRequired = [...restart];
  return clone(store.admin);
}

/** Same shape the server uses: a short prefix, an ellipsis, the last four. */
function maskSecret(value: string): string {
  if (value.length <= 8) return "\u2026";
  const head = value.startsWith("sk-or-") ? "sk-or-" : value.slice(0, 4);
  return `${head}\u2026${value.slice(-3)}`;
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

// ---------------------------------------------------------------- fixture deep runs
/** The tool sequence a mock run plays, mirroring the tools in DESIGN-deep.md. */
function fixtureToolScript(n: number): Array<{ name: string; args: unknown; resultPreview: string }> {
  return FIXTURE_TOOL_SCRIPT.map((step) => ({
    ...step,
    resultPreview: step.resultPreview.replace("<pr>", `refs/pr/${n}`),
  }));
}

const FIXTURE_TOOL_SCRIPT: Array<{ name: string; args: unknown; resultPreview: string }> = [
  {
    name: "revision_delta",
    args: {},
    resultPreview: "diff --git a/lib/hardware/ESP32UARTChannel.cpp ... 5 lines removed, 0 added",
  },
  {
    name: "git_blame",
    args: { path: "lib/hardware/ESP32UARTChannel.cpp", start_line: 84, end_line: 88 },
    resultPreview: "4b91c02 wdathing 2026-09-14 Add UART flow control support (#1628)",
  },
  {
    name: "fetch_pr",
    args: { number: 1628 },
    resultPreview: '#1628 "Adds support for flow control" by wdathing, merged 2026-09-14',
  },
  {
    name: "read_file_at_base",
    args: { path: "lib/hardware/ESP32UARTChannel.cpp", start: 60, end: 120 },
    resultPreview: "uart_param_config(_uart_num, &uart_config); ... uart_set_pin(_uart_num, tx, rx, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);",
  },
  {
    name: "grep",
    args: { pattern: "UART_PIN_NO_CHANGE", path_glob: "lib/**" },
    resultPreview: "lib/hardware/ESP32UARTChannel.cpp:141 ... 3 hits",
  },
  {
    name: "grep",
    args: { pattern: "COCO_HS_UART", path_glob: "**" },
    resultPreview: "0 hits at <pr>",
  },
  {
    name: "submit_brief",
    args: { recommendedAction: "ask_original_author" },
    resultBrief: true,
    resultPreview: "brief accepted",
  } as unknown as { name: string; args: unknown; resultPreview: string },
];

const fixtureRunTimers = new Map<string, number[]>();

function fixtureStepAt(index: number, script: (typeof FIXTURE_TOOL_SCRIPT)[number]): DeepStep {
  return {
    index,
    at: new Date().toISOString(),
    kind: "tool",
    name: script.name,
    args: script.args,
    resultPreview: script.resultPreview,
  };
}

/** Drive a fixture run forwards, emitting deep:step and finally deep:done. */
function runFixtureSteps(n: number, run: DeepRun, brief: DeepBrief | null, startAt: number): void {
  const timers: number[] = [];
  const steps = fixtureToolScript(n);
  let t = 700;
  for (let i = startAt; i < steps.length; i += 1) {
    const script = steps[i];
    if (!script) continue;
    const isLast = i === steps.length - 1;
    t += 900 + Math.round(Math.random() * 700);
    timers.push(
      window.setTimeout(() => {
        const step = fixtureStepAt(i, script);
        run.steps = [...run.steps, step];
        run.usage = {
          promptTokens: run.usage.promptTokens + 2400 + i * 300,
          completionTokens: run.usage.completionTokens + 160,
          costUsd: Math.round((run.usage.costUsd + 0.0042 + i * 0.0011) * 100000) / 100000,
          calls: run.usage.calls + 1,
        };
        emitFixtureEvent({ type: "deep:step", n, runId: run.id, step });

        if (isLast) {
          run.status = "done";
          run.finishedAt = new Date().toISOString();
          run.brief = brief;
          emitFixtureEvent({ type: "deep:done", n, runId: run.id, run: clone(run) });
        }
      }, t),
    );
  }
  fixtureRunTimers.set(run.id, timers);
}

/** The in-progress fixture run resumes the first time its PR is opened. */
let advanced = new Set<number>();
function advanceFixtureRun(n: number): void {
  if (!fixtureDb || advanced.has(n)) return;
  const run = fixtureDb.deepRuns[n]?.[0];
  if (!run || run.status !== "running") return;
  advanced.add(n);
  runFixtureSteps(n, run, fixtureDb.deepRuns[n]?.[1]?.brief ?? null, run.steps.length);
}

async function startFixtureDeepRun(
  n: number,
  options: { model?: string; requestedBy: string },
): Promise<DeepRun> {
  const store = await db();
  await latency(240, 520);
  if (options.requestedBy.trim() === "") {
    throw new ApiError(400, "requestedBy is required: a deep run is always attributed to a person.");
  }
  const runs = store.deepRuns[n] ?? [];
  if (runs[0]?.status === "running") {
    throw new ApiError(409, `A deep run is already in progress for PR #${n}.`);
  }
  if (store.deepSpend.todayUsd >= store.deepSpend.capUsd) {
    throw new ApiError(402, `Today's deep analysis spend has reached the cap of $${store.deepSpend.capUsd}.`);
  }

  const item = findFixtureItem(store, n);
  const model = options.model ?? store.deepModels.default ?? "anthropic/claude-haiku-4.5";
  const run: DeepRun = {
    id: `deep_${Date.now().toString(36)}`,
    prNumber: n,
    headSha: item?.snapshot.headSha ?? "unknown",
    evaluationId: item?.evaluation?.id ?? null,
    dossierBuiltAt: store.dossiers[n]?.builtAt ?? new Date().toISOString(),
    model,
    mock: !store.deepModels.keyPresent,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
    brief: null,
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 0 },
    requestedBy: options.requestedBy.trim(),
  };
  store.deepRuns[n] = [run, ...runs];
  store.deepSpend = {
    ...store.deepSpend,
    runsToday: store.deepSpend.runsToday + 1,
  };

  emitFixtureEvent({ type: "deep:start", n, runId: run.id, model });
  // Replay the canned brief from the completed 1650 run, retargeted at this PR.
  const canned = store.deepRuns[1650]?.find((r) => r.brief)?.brief ?? null;
  const brief = canned
    ? {
        ...clone(canned),
        summary:
          n === 1650
            ? canned.summary
            : `Fixture brief replayed from the PR 1650 example, so the detail below describes that case rather than #${n}. ${canned.summary}`,
      }
    : null;
  runFixtureSteps(n, run, brief, 0);
  return clone(run);
}

async function stopFixtureDeepRun(n: number, runId: string): Promise<DeepRun | null> {
  const store = await db();
  await latency(120, 260);
  const run = store.deepRuns[n]?.find((r) => r.id === runId);
  if (!run) throw new ApiError(404, `No deep run ${runId} for PR #${n}.`);
  for (const timer of fixtureRunTimers.get(runId) ?? []) window.clearTimeout(timer);
  fixtureRunTimers.delete(runId);
  run.status = "aborted";
  run.finishedAt = new Date().toISOString();
  run.error = "Stopped by the reviewer.";
  emitFixtureEvent({ type: "deep:done", n, runId, run: clone(run) });
  return clone(run);
}

async function fixtureProposal(n: number, fromDeep?: string): Promise<Proposal> {
  const store = await db();
  await latency(160, 380);
  const base = store.proposals[n];
  if (!fromDeep) {
    if (!base) throw new ApiError(404, `PR #${n} has no evaluation to draft an action from`);
    return clone(base);
  }
  const run = store.deepRuns[n]?.find((r) => r.id === fromDeep);
  // A failed run can still have the model's last attempt, and the reviewer may want
  // to edit that into a reply.
  const brief = run?.brief ?? ((run as (DeepRun & { partialBrief?: DeepBrief | null }) | undefined)?.partialBrief ?? null);
  if (!run || !brief) throw new ApiError(404, `Deep run ${fromDeep} has no brief to draft from.`);
  const item = findFixtureItem(store, n);
  return clone({
    id: `prop_${n}_${fromDeep}`,
    prNumber: n,
    headSha: run.headSha,
    evaluationId: run.evaluationId ?? item?.evaluation?.id ?? "",
    kind: "comment",
    title: "Reply drafted from the deep analysis brief",
    body: `${brief.draftReply}\n\nDrafted by the FujiNet PR triage harness from deep run ${run.id} (${run.model}); posted by {{confirmedBy}} after human review.`,
    labels: base?.labels ?? [],
    rationale: brief.rationale,
    generatedAt: new Date().toISOString(),
  });
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
export function useScanEvents(onEvent?: (event: HarnessEvent) => void): ScanProgress {
  const [progress, setProgress] = useState<ScanProgress>(IDLE);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const unsubscribe = subscribeEvents(
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

export function reduceScanEvent(prev: ScanProgress, event: HarnessEvent): ScanProgress {
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
