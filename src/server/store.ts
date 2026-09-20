// JSON-file persistence (DESIGN.md §1, §5). No database.
//
// data/evaluations.json   append-only array, last 20 kept per PR
// data/triage.json        local human triage state
// data/actions.json       audit log of every attempted GitHub write
// data/cache/<n>-<sha>.json   GitHub snapshot cache
//
// Every write goes through a tmp file + rename so a crash mid-write cannot
// leave a half-parsed JSON file behind.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ActionRecord, Evaluation, Policy, PrSnapshot, Severity, TriageState } from "../shared/types.js";

// --- locations --------------------------------------------------------------

function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = resolve(PROJECT_ROOT, "data");
export const CACHE_DIR = resolve(DATA_DIR, "cache");
export const EVALUATIONS_PATH = resolve(DATA_DIR, "evaluations.json");
export const TRIAGE_PATH = resolve(DATA_DIR, "triage.json");
export const ACTIONS_PATH = resolve(DATA_DIR, "actions.json");
export const POLICY_PATH = resolve(PROJECT_ROOT, "config/policy.json");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- atomic json io ---------------------------------------------------------

export function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

// --- policy -----------------------------------------------------------------

export const DEFAULT_POLICY: Policy = {
  readyThreshold: 75,
  reviewThreshold: 45,
  confidenceFloor: 0.5,
  maxUncertainNouls: 2,
  softGatePenalty: 6,
  skipJevWhenBlocked: false,
  // Only the weighted deep question needs a default here; the rest of the
  // weights come from config/policy.json and fall back to the catalog.
  weights: { body_matches_diff: 1.5 },
  hardBlocks: { reviewer_directed_text: 0.7 },
  gates: {},
  jev: { model: "jev-latest", maxStateTokens: 14_000, maxChunksPerPr: 12, concurrency: 2 },
};

const SEVERITIES: Severity[] = ["hard", "soft", "info", "off"];

/** Coerce arbitrary JSON into a valid Policy; throws with a field name on bad input. */
export function validatePolicy(raw: unknown): Policy {
  if (!raw || typeof raw !== "object") throw new Error("policy must be an object");
  const r = raw as Record<string, unknown>;

  const numberField = (name: keyof Policy, min: number, max: number, dflt: number): number => {
    const v = r[name as string];
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`policy.${String(name)} must be a number`);
    if (v < min || v > max) throw new Error(`policy.${String(name)} must be between ${min} and ${max}`);
    return v;
  };

  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries((r["weights"] as Record<string, unknown>) ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`policy.weights.${k} must be a number >= 0`);
    weights[k] = v;
  }

  const hardBlocks: Record<string, number> = {};
  for (const [k, v] of Object.entries((r["hardBlocks"] as Record<string, unknown>) ?? DEFAULT_POLICY.hardBlocks)) {
    if (typeof v !== "number" || v < 0 || v > 1) throw new Error(`policy.hardBlocks.${k} must be between 0 and 1`);
    hardBlocks[k] = v;
  }

  const gates: Record<string, Severity> = {};
  for (const [k, v] of Object.entries((r["gates"] as Record<string, unknown>) ?? {})) {
    if (typeof v !== "string" || !SEVERITIES.includes(v as Severity)) {
      throw new Error(`policy.gates.${k} must be one of ${SEVERITIES.join(", ")}`);
    }
    gates[k] = v as Severity;
  }

  const jevRaw = (r["jev"] as Record<string, unknown>) ?? {};
  const jev = {
    model: typeof jevRaw["model"] === "string" ? jevRaw["model"] : DEFAULT_POLICY.jev.model,
    maxStateTokens: typeof jevRaw["maxStateTokens"] === "number"
      ? Math.max(1000, Math.min(31_000, jevRaw["maxStateTokens"]))
      : DEFAULT_POLICY.jev.maxStateTokens,
    maxChunksPerPr: typeof jevRaw["maxChunksPerPr"] === "number"
      ? Math.max(1, Math.min(200, Math.floor(jevRaw["maxChunksPerPr"])))
      : DEFAULT_POLICY.jev.maxChunksPerPr,
    concurrency: typeof jevRaw["concurrency"] === "number"
      ? Math.max(1, Math.min(16, Math.floor(jevRaw["concurrency"])))
      : DEFAULT_POLICY.jev.concurrency,
  };

  return {
    readyThreshold: numberField("readyThreshold", 0, 100, DEFAULT_POLICY.readyThreshold),
    reviewThreshold: numberField("reviewThreshold", 0, 100, DEFAULT_POLICY.reviewThreshold),
    confidenceFloor: numberField("confidenceFloor", 0, 1, DEFAULT_POLICY.confidenceFloor),
    maxUncertainNouls: numberField("maxUncertainNouls", 0, 50, DEFAULT_POLICY.maxUncertainNouls),
    softGatePenalty: numberField("softGatePenalty", 0, 100, DEFAULT_POLICY.softGatePenalty),
    skipJevWhenBlocked: r["skipJevWhenBlocked"] === true,
    weights,
    hardBlocks,
    gates,
    jev,
  };
}

export function loadPolicy(): Policy {
  const raw = readJson<unknown>(POLICY_PATH, DEFAULT_POLICY);
  try {
    return validatePolicy(raw);
  } catch {
    return DEFAULT_POLICY;
  }
}

export function savePolicy(policy: Policy): Policy {
  const clean = validatePolicy(policy);
  writeJsonAtomic(POLICY_PATH, clean);
  return clean;
}

export function policyVersion(policy: Policy): string {
  return createHash("sha1").update(JSON.stringify(policy)).digest("hex").slice(0, 12);
}

// --- evaluations ------------------------------------------------------------

const MAX_EVALUATIONS_PER_PR = 20;

export function readEvaluations(): Evaluation[] {
  return readJson<Evaluation[]>(EVALUATIONS_PATH, []);
}

export function appendEvaluation(evaluation: Evaluation): Evaluation {
  const all = readEvaluations();
  all.push(evaluation);
  const byPr = new Map<number, Evaluation[]>();
  for (const e of all) {
    const list = byPr.get(e.prNumber) ?? [];
    list.push(e);
    byPr.set(e.prNumber, list);
  }
  const trimmed: Evaluation[] = [];
  for (const list of byPr.values()) {
    trimmed.push(...list.slice(-MAX_EVALUATIONS_PER_PR));
  }
  trimmed.sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
  writeJsonAtomic(EVALUATIONS_PATH, trimmed);
  return evaluation;
}

/** Newest first. */
export function evaluationsFor(n: number): Evaluation[] {
  return readEvaluations()
    .filter((e) => e.prNumber === n)
    .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
}

export function latestEvaluation(n: number): Evaluation | null {
  return evaluationsFor(n)[0] ?? null;
}

export function evaluationById(id: string): Evaluation | null {
  return readEvaluations().find((e) => e.id === id) ?? null;
}

export function latestEvaluationsByPr(): Map<number, Evaluation> {
  const out = new Map<number, Evaluation>();
  for (const e of readEvaluations()) {
    const cur = out.get(e.prNumber);
    if (!cur || cur.evaluatedAt < e.evaluatedAt) out.set(e.prNumber, e);
  }
  return out;
}

// --- triage -----------------------------------------------------------------

export function readTriage(): Record<string, TriageState> {
  return readJson<Record<string, TriageState>>(TRIAGE_PATH, {});
}

export function setTriage(state: TriageState): TriageState {
  const all = readTriage();
  all[String(state.prNumber)] = state;
  writeJsonAtomic(TRIAGE_PATH, all);
  return state;
}

export function triageFor(n: number): TriageState | null {
  return readTriage()[String(n)] ?? null;
}

// --- actions ----------------------------------------------------------------

export function readActions(): ActionRecord[] {
  return readJson<ActionRecord[]>(ACTIONS_PATH, []);
}

export function appendAction(record: ActionRecord): ActionRecord {
  const all = readActions();
  all.push(record);
  writeJsonAtomic(ACTIONS_PATH, all);
  return record;
}

// --- github snapshot cache --------------------------------------------------

/** The head SHA is the only caller-supplied part of a cache filename. */
const SHA_RE = /^[0-9a-f]{7,64}$/;

function cachePath(n: number, headSha: string): string | null {
  if (!Number.isInteger(n) || n <= 0 || !SHA_RE.test(headSha)) return null;
  return resolve(CACHE_DIR, `${n}-${headSha}.json`);
}

export function readSnapshotCache(n: number, headSha: string): PrSnapshot | null {
  const path = cachePath(n, headSha);
  return path === null ? null : readJson<PrSnapshot | null>(path, null);
}

export function writeSnapshotCache(snapshot: PrSnapshot): void {
  const path = cachePath(snapshot.number, snapshot.headSha);
  if (path === null) {
    console.warn(`[store] refusing to cache PR #${snapshot.number}: head SHA is not a hex object id`);
    return;
  }
  ensureDir(CACHE_DIR);
  // One cache file per head SHA; drop the PR's older SHAs so data/cache does
  // not grow without bound.
  try {
    for (const f of readdirSync(CACHE_DIR)) {
      if (f.startsWith(`${snapshot.number}-`) && f !== `${snapshot.number}-${snapshot.headSha}.json`) {
        unlinkSync(resolve(CACHE_DIR, f));
      }
    }
  } catch {
    // best effort
  }
  writeJsonAtomic(path, snapshot);
}

/**
 * The most recent cached snapshot for a PR, whichever head it was taken at.
 * Used to keep closed pull requests reachable: the open listing no longer
 * carries them, but we still hold everything we learned while they were open.
 */
export function latestCachedSnapshot(n: number): PrSnapshot | null {
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    const files = readdirSync(CACHE_DIR)
      .filter((f) => f.startsWith(`${n}-`) && f.endsWith(".json"))
      .map((f) => {
        const full = resolve(CACHE_DIR, f);
        return { full, at: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
    for (const f of files) {
      const cached = readJson<(PrSnapshot & { diff?: string }) | null>(f.full, null);
      if (cached) {
        const { diff: _diff, ...snapshot } = cached;
        void _diff;
        return snapshot;
      }
    }
  } catch {
    // no cache directory yet
  }
  return null;
}

/** Every PR number the store knows anything about. */
export function knownPrNumbers(): number[] {
  const out = new Set<number>();
  for (const e of readEvaluations()) out.add(e.prNumber);
  for (const t of Object.values(readTriage())) out.add(t.prNumber);
  for (const a of readActions()) out.add(a.prNumber);
  try {
    for (const f of readdirSync(CACHE_DIR)) {
      const m = /^(\d+)-[0-9a-f]+\.json$/.exec(f);
      if (m?.[1]) out.add(Number(m[1]));
    }
  } catch {
    // no cache directory yet
  }
  return [...out];
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function ensureDataDir(): void {
  ensureDir(DATA_DIR);
  ensureDir(CACHE_DIR);
}
