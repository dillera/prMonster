// Small pure formatting helpers shared by the components. No decision logic here.

import type {
  ChunkResult,
  CiState,
  Decision,
  DecisionKind,
  DeepBrief,
  DeepRun,
  Evaluation,
  GateResult,
  PrListItem,
  PrSnapshot,
  SizeBucket,
} from "../shared/types";

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}

export function ageDays(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.round((Date.now() - then) / 86400000));
}

export function decisionLabel(kind: DecisionKind | "UNEVALUATED"): string {
  switch (kind) {
    case "READY":
      return "Ready";
    case "NEEDS_REVIEW":
      return "Needs review";
    case "BLOCKED":
      return "Blocked";
    default:
      return "Not evaluated";
  }
}

/** CSS modifier suffix; colour is always paired with the text label above. */
export function decisionSlug(kind: DecisionKind | "UNEVALUATED"): string {
  switch (kind) {
    case "READY":
      return "ready";
    case "NEEDS_REVIEW":
      return "review";
    case "BLOCKED":
      return "blocked";
    default:
      return "none";
  }
}

export function ciLabel(ci: CiState): string {
  switch (ci) {
    case "green":
      return "CI green";
    case "red":
      return "CI red";
    case "pending":
      return "CI pending";
    default:
      return "No CI";
  }
}

export function sizeLabel(bucket: SizeBucket | string): string {
  return String(bucket);
}

export function percent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

/** The gate carrying the size bucket, as a plain string. */
export function sizeBucketOf(gates: GateResult[]): string | null {
  const gate = gates.find((g) => g.id === "size_bucket");
  return typeof gate?.value === "string" ? gate.value : null;
}

export function platformsOf(gates: GateResult[]): string[] {
  const gate = gates.find((g) => g.id === "platform_scope");
  return Array.isArray(gate?.value) ? gate.value : [];
}

/** Stable short sha, the way GitHub prints it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function pluralise(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---------------------------------------------------------------- degraded evaluations
// An evaluation can come back incomplete: the pull request level Jev call may have
// failed (decision made on gates alone), or individual chunks may have failed and
// been left out of the aggregate. Both show up as reason codes on the decision, and
// both must read as "we do not know", never as "nothing was found".

export type DegradationCode = "jev_unavailable" | "chunks_unevaluated" | "diff_unavailable";

export interface Degradation {
  code: DegradationCode;
  /** Short pill text, paired with colour, never colour alone. */
  pill: string;
  title: string;
  detail: string;
  /** The reason text the server sent, when it added anything beyond the code. */
  serverText?: string;
}

const DEGRADATION_COPY: Record<DegradationCode, { pill: string; title: string; detail: string }> = {
  jev_unavailable: {
    pill: "Jev unavailable",
    title: "Jev did not answer for this pull request",
    detail:
      "The pull request level questions never got answers, so this route was decided on the deterministic gates alone. Treat the score as incomplete and re-evaluate once Jev is reachable.",
  },
  chunks_unevaluated: {
    pill: "Chunks lost",
    title: "Some chunks were never evaluated",
    detail:
      "One or more diff chunks failed and were left out of the aggregate. The code level answers describe only the chunks that succeeded, so a problem could sit in the part that was never read.",
  },
  diff_unavailable: {
    pill: "Diff unavailable",
    title: "The diff could not be read from GitHub",
    detail:
      "No code was ever seen for this pull request, so only the title, the body, the file list and the gates were judged. A pull request in this state is never routed ready, whatever the score says.",
  },
};

/** Degraded states carried by a decision's reason codes, in a fixed order. */
export function degradations(decision: Decision | null | undefined): Degradation[] {
  if (!decision) return [];
  const out: Degradation[] = [];
  for (const code of ["diff_unavailable", "jev_unavailable", "chunks_unevaluated"] as DegradationCode[]) {
    const reason = decision.reasons.find((r) => r.code === code);
    if (!reason) continue;
    const copy = DEGRADATION_COPY[code];
    out.push({
      code,
      ...copy,
      ...(reason.text && reason.text !== copy.title ? { serverText: reason.text } : {}),
    });
  }
  return out;
}

export function isDegradationCode(code: string): code is DegradationCode {
  return code === "jev_unavailable" || code === "chunks_unevaluated" || code === "diff_unavailable";
}

/**
 * The GitHub fetch for this pull request failed, so there is no evaluation and the
 * snapshot may be from an earlier scan.
 *
 * `fetchError` is being added to PrListItem on the server side; reading it
 * defensively keeps the web build compiling against either version of the shared
 * contract, and an absent field simply means no error.
 */
// ---------------------------------------------------------------- pr state
// PrSnapshot.state is being widened from "open" to "open" | "closed" | "merged" on
// the server side, so it is read defensively here: an unknown or absent value reads
// as open, which is what every snapshot meant before the widening.

export type PrState = "open" | "closed" | "merged";

export function stateOf(snapshot: PrSnapshot): PrState {
  const value = (snapshot as PrSnapshot & { state?: unknown }).state;
  return value === "closed" || value === "merged" ? value : "open";
}

/** A closed or merged pull request cannot be re-evaluated or written to. */
export function isClosed(snapshot: PrSnapshot): boolean {
  return stateOf(snapshot) !== "open";
}

export function stateLabel(state: PrState): string {
  return state;
}

// ---------------------------------------------------------------- hints
// Suggestions from the dossier gates (DESIGN-deep.md). These are not failures and
// not degraded states: they tell a reviewer where to look. Grey, never amber.

export type HintCode = "revision_removed_behaviour" | "description_drift" | "deep_analysis_suggested";

const HINT_LABELS: Record<HintCode, string> = {
  revision_removed_behaviour: "revision removed behaviour",
  description_drift: "description drift",
  deep_analysis_suggested: "deep analysis suggested",
};

export function isHintCode(code: string): code is HintCode {
  return code in HINT_LABELS;
}

export interface Hint {
  code: HintCode;
  label: string;
  /** The server's own sentence, shown as the tooltip. */
  detail: string;
}

/** Hints carried by a decision's reason codes, in a fixed order. */
export function hints(decision: Decision | null | undefined): Hint[] {
  if (!decision) return [];
  const order: HintCode[] = ["revision_removed_behaviour", "description_drift", "deep_analysis_suggested"];
  const out: Hint[] = [];
  for (const code of order) {
    const reason = decision.reasons.find((r) => r.code === code);
    if (reason) out.push({ code, label: HINT_LABELS[code], detail: reason.text });
  }
  return out;
}

// ---------------------------------------------------------------- failed deep runs
// A run can fail at brief validation after doing all the work. The server then keeps
// the model's last attempt and the validation errors. Both fields are optional and
// are being added to DeepRun on the server side, so they are read defensively: the
// web build compiles against either version of the shared contract.

export function partialBriefOf(run: DeepRun | null | undefined): DeepBrief | null {
  if (!run) return null;
  const value = (run as DeepRun & { partialBrief?: unknown }).partialBrief;
  return value && typeof value === "object" ? (value as DeepBrief) : null;
}

export function validationErrorsOf(run: DeepRun | null | undefined): string[] {
  if (!run) return [];
  const value = (run as DeepRun & { validationErrors?: unknown }).validationErrors;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

export function formatUsdPrecise(value: number): string {
  if (value === 0) return "$0.000";
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function fetchErrorOf(item: PrListItem): string | null {
  const value = (item as PrListItem & { fetchError?: unknown }).fetchError;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** A chunk that failed carries an error and no answers; it is not "clean". */
export function chunkFailed(chunk: ChunkResult): boolean {
  return typeof chunk.error === "string" && chunk.error.length > 0;
}

export function chunkCounts(evaluation: Evaluation): { total: number; failed: number; evaluated: number } {
  const total = evaluation.chunks.length;
  const failed = evaluation.chunks.filter(chunkFailed).length;
  return { total, failed, evaluated: total - failed };
}
