// Deep analysis: a tool-using model reads the checkout and returns a brief
// (DESIGN-deep.md "Deep analysis").
//
// Non-negotiables enforced here:
//   * runs only from the explicit route, only with `requestedBy`;
//   * every tool is read-only and goes through repo.ts, which validates paths
//     and revs before any git call;
//   * the brief never posts itself — it can only be loaded into the existing
//     human-confirmed proposal flow.

import { resolve } from "node:path";

import type {
  DeepBrief,
  DeepRun,
  DeepStep,
  Dossier,
  Evaluation,
  PrSnapshot,
} from "../shared/types.js";
import { buildDossier } from "./dossier.js";
import { emit } from "./events.js";
import { getPrSummary } from "./github.js";
import { PR_PROJECT_RULES, QUESTIONS_BY_ID } from "./jev.js";
import {
  MockLlmBackend,
  configuredModel,
  dailyCapUsd,
  makeLlmBackend,
  maxCostUsd,
  maxSteps,
  type ChatRequest,
  type LlmBackend,
  type LlmMessage,
  type LlmTool,
  type LlmToolCall,
  type MockTurn,
} from "./llm.js";
import {
  blame,
  diffRange,
  grep,
  listTree,
  logForPath,
  prRef,
  prevRef,
  readFile,
  show,
  hasRev,
} from "./repo.js";
import { DATA_DIR, latestEvaluation, newId, readJson, writeJsonAtomic } from "./store.js";

/** Overridable so tests never write to the real run log. */
export const DEEP_PATH = process.env["DEEP_STORE_PATH"] ?? resolve(DATA_DIR, "deep.json");
export const MAX_RUNS_PER_PR = 10;
/** How many times the model may send an invalid brief before the run fails. */
export const MAX_BRIEF_ATTEMPTS = 3;
/** Fraction of the per-run budget at which the model is told to wrap up. */
export const BUDGET_WARNING_FRACTION = 0.6;
export const TOOL_RESULT_CAP = 12 * 1024;
const MAX_PR_DIFF = 60_000;
const MAX_COMMIT_SHOW = 20_000;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const DEEP_SYSTEM_PROMPT = `You are assisting a maintainer of the FujiNet firmware project review one pull request. You are not the reviewer; you prepare the brief the reviewer reads.

PROJECT RULES
${PR_PROJECT_RULES}

REVISIONS
Two revisions matter, and every file tool names which one it reads. "head" is this pull request as it stands now, including its changes. "base" is master as the pull request is against it, before any of those changes. Lines this PR deletes exist only at base, so blame and grep default to base; read_file and list_dir default to head. Cite code as path:line@<revision>.

HOW TO WORK
You have read-only tools over a local checkout of the repository. Use them. The dossier in the first message is deterministic and correct; your job is to verify the things it cannot check for itself — above all, the factual claims people make in the thread.

RULES OF THE BRIEF
- Every claim about code must cite path:line at a named revision, or a PR number, or a comment URL. If you cannot cite it, say "unverified".
- Verify every factual claim the author makes in the thread using the tools before judging it.
- Do not speculate about intent; quote what people wrote.
- Prefer the maintainer's stated direction where the thread contains one.
- Recommend exactly one next action from the fixed set and write a reply the maintainer could post after editing. The reply must not promise anything on the maintainer's behalf.
- Be brief. The reader is an expert on this codebase.

When you have what you need, call submit_brief exactly once. Do not answer in prose instead; only submit_brief ends the run.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const DEEP_ACTIONS = [
  "merge_review_now",
  "request_design_discussion",
  "request_description_or_tests",
  "request_split",
  "request_rebase",
  "request_follow_up_issue",
  "ask_original_author",
  "wait_for_ci",
  "close_stale",
] as const;

const citationSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["code", "pr", "comment", "commit"] },
    ref: { type: "string", description: 'e.g. "lib/x.cpp:84-88@<sha>", "#1628", a comment URL, or a commit sha' },
    note: { type: "string" },
  },
  required: ["kind", "ref"],
} as const;

export const DEEP_TOOLS: LlmTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file, returning numbered lines. Reads at the PR head (rev=head) unless rev=base, which reads master as the PR is against it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          rev: { type: "string", enum: ["head", "base"], description: "default head" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file_at_base",
      description:
        "Read a file as it is at the base commit (rev=base), before this pull request. Same as read_file with rev=base.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search the repository with an extended regular expression. Reads at the base commit (rev=base) unless rev=head, which searches the PR as it is now.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path_glob: { type: "string", description: "optional pathspec, e.g. lib/bus/*" },
          max_results: { type: "integer" },
          rev: { type: "string", enum: ["head", "base"], description: "default base" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Recent commits at the base commit (rev=base), optionally for one path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, max: { type: "integer" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_blame",
      description:
        "Who last changed each line of a file, with commit and summary. Reads at the base commit (rev=base) unless rev=head. Blame the base to find who added lines this PR deletes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          rev: { type: "string", enum: ["head", "base"], description: "default base" },
        },
        required: ["path", "start_line", "end_line"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_show",
      description: "A commit's message, stat and diff.",
      parameters: { type: "object", properties: { sha: { type: "string" } }, required: ["sha"] },
    },
  },
  {
    type: "function",
    function: {
      name: "pr_diff",
      description: "The current pull request diff, base to head.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "revision_delta",
      description: "The diff between the previous pushed head and the current one, when there is one.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_pr",
      description: "Title, body, author, merge date and file list of another pull request in this repository.",
      parameters: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List the files in a directory. Reads at the PR head (rev=head) unless rev=base.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, rev: { type: "string", enum: ["head", "base"], description: "default head" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_brief",
      description: "Submit the finished brief. This ends the run; call it exactly once.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Two or three sentences for a maintainer who has not opened the PR." },
          revisionChanges: { type: "array", items: { type: "string" }, description: "What the latest revision changed." },
          removedBehaviour: {
            type: "array",
            items: {
              type: "object",
              properties: {
                lines: { type: "string", description: 'e.g. "lib/x.cpp:84-88"' },
                originPr: { type: ["integer", "null"] },
                purpose: { type: "string" },
                status: {
                  type: "string",
                  enum: ["replaced", "made_opt_in", "removed_without_replacement", "unclear"],
                },
                citations: { type: "array", items: citationSchema },
              },
              required: ["lines", "purpose", "status", "citations"],
            },
          },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                claim: { type: "string" },
                by: { type: "string" },
                verdict: { type: "string", enum: ["holds", "does_not_hold", "partially_holds", "unverified"] },
                evidence: { type: "string" },
                citations: { type: "array", items: citationSchema },
              },
              required: ["claim", "by", "verdict", "evidence", "citations"],
            },
          },
          openQuestions: {
            type: "array",
            items: {
              type: "object",
              properties: { question: { type: "string" }, toWhom: { type: "string" } },
              required: ["question", "toWhom"],
            },
          },
          recommendedAction: { type: "string", enum: [...DEEP_ACTIONS] },
          rationale: { type: "array", items: { type: "string" } },
          draftReply: { type: "string", description: "Markdown the maintainer could post after editing." },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          caveats: { type: "array", items: { type: "string" } },
        },
        required: [
          "summary",
          "revisionChanges",
          "removedBehaviour",
          "claims",
          "openQuestions",
          "recommendedAction",
          "rationale",
          "draftReply",
          "confidence",
          "caveats",
        ],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export interface ToolContext {
  prNumber: number;
  baseSha: string;
  dossier: Dossier;
}

function capResult(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= TOOL_RESULT_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_CAP)}\n[truncated]`;
}

function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Run one tool call. Never throws: a bad path or an unknown tool comes back as
 * an error string the model can read and correct, which is much more useful
 * than killing the run.
 */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  try {
    const head = prRef(ctx.prNumber);
    /** Resolve the optional `rev` argument against each tool's own default. */
    const revOf = (dflt: "head" | "base"): string => {
      const asked = String(args["rev"] ?? dflt).trim().toLowerCase();
      return asked === "base" ? ctx.baseSha : asked === "head" ? head : dflt === "base" ? ctx.baseSha : head;
    };
    switch (name) {
      case "read_file":
        return capResult(
          await readFile(revOf("head"), asString(args["path"]) ?? "", asInt(args["start_line"]), asInt(args["end_line"])),
        );
      case "read_file_at_base":
        return capResult(
          await readFile(ctx.baseSha, asString(args["path"]) ?? "", asInt(args["start_line"]), asInt(args["end_line"])),
        );
      case "grep": {
        const hits = await grep(
          asString(args["pattern"]) ?? "",
          revOf("base"),
          asString(args["path_glob"]),
          asInt(args["max_results"]) ?? 50,
        );
        if (hits.length === 0) return "no matches";
        return capResult(hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n"));
      }
      case "git_log": {
        const entries = await logForPath(asString(args["path"]), ctx.baseSha, asInt(args["max"]) ?? 20);
        return capResult(entries.map((e) => `${e.sha.slice(0, 9)} ${e.date.slice(0, 10)} ${e.author}: ${e.subject}`).join("\n"));
      }
      case "git_blame": {
        const lines = await blame(
          asString(args["path"]) ?? "",
          revOf("base"),
          asInt(args["start_line"]) ?? 1,
          asInt(args["end_line"]) ?? 1,
        );
        return capResult(
          lines.map((l) => `${l.line}: ${l.sha.slice(0, 9)} ${l.author} ${l.date.slice(0, 10)} "${l.summary}" | ${l.text}`).join("\n"),
        );
      }
      case "git_show":
        return capResult(await show(asString(args["sha"]) ?? "", undefined, MAX_COMMIT_SHOW));
      case "pr_diff":
        return capResult(await diffRange(ctx.baseSha, head, MAX_PR_DIFF));
      case "revision_delta": {
        if (!ctx.dossier.latestDelta) return "this pull request has only one revision, so there is no delta";
        return capResult(ctx.dossier.latestDelta.diff);
      }
      case "fetch_pr": {
        const number = asInt(args["number"]);
        if (number === undefined) return "error: number must be an integer";
        const pr = await getPrSummary(number, true);
        if (!pr) return `error: pull request #${number} could not be read`;
        return capResult(
          [
            `#${pr.number} ${pr.title}`,
            `author: ${pr.author}`,
            `merged_at: ${pr.mergedAt ?? "not merged"}`,
            `url: ${pr.url}`,
            `files: ${(pr.files ?? []).join(", ")}`,
            "",
            pr.body.slice(0, 6000),
          ].join("\n"),
        );
      }
      case "list_dir": {
        const entries = await listTree(revOf("head"), asString(args["path"]) ?? "");
        return capResult(entries.map((e) => `${e.type === "tree" ? "d" : "-"} ${e.path}`).join("\n"));
      }
      default:
        return `error: no such tool "${name}"`;
    }
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// Brief validation
// ---------------------------------------------------------------------------

/** Trim every string in a structure, recursively. Models pad enum values with newlines. */
export function deepTrim<T>(value: T): T {
  if (typeof value === "string") return value.trim() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepTrim(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k.trim()] = deepTrim(v);
    return out as unknown as T;
  }
  return value;
}

function normaliseEnum(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Similarity on normalised strings, used only to rescue a near-miss enum value. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

export const ENUM_COERCE_THRESHOLD = 0.45;

interface EnumResult {
  value: string | null;
  /** Set when the value was not an exact match but was close enough to map. */
  coercion?: string;
}

/**
 * Accept an enum value the model wrote. Exact after normalisation wins; a close
 * miss is mapped to the nearest allowed value and recorded as a caveat, because
 * losing a whole run over "Close Stale" instead of "close_stale" is worse than
 * saying plainly what we mapped.
 */
function acceptEnum(raw: unknown, allowed: readonly string[], field: string): EnumResult {
  const normalised = normaliseEnum(raw);
  if (allowed.includes(normalised)) return { value: normalised };

  let best: { value: string; score: number } | null = null;
  for (const candidate of allowed) {
    const score = similarity(normalised, candidate);
    if (!best || score > best.score) best = { value: candidate, score };
  }
  if (best && best.score >= ENUM_COERCE_THRESHOLD) {
    return {
      value: best.value,
      coercion: `model wrote ${JSON.stringify(raw)} for ${field}, mapped to ${best.value}`,
    };
  }
  return { value: null };
}

const VERDICTS = ["holds", "does_not_hold", "partially_holds", "unverified"] as const;
const REMOVED_STATUSES = ["replaced", "made_opt_in", "removed_without_replacement", "unclear"] as const;
const CITATION_KINDS = ["code", "pr", "comment", "commit"] as const;

/**
 * Keep an invalid attempt in the shape of a DeepBrief. Nothing is validated —
 * this is the investigation the model did, preserved so a human can read it.
 */
export function salvageBrief(raw: unknown): DeepBrief | null {
  if (!raw || typeof raw !== "object") return null;
  const attempt = deepTrim(raw) as Record<string, unknown>;
  const text = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() !== "" ? v : fallback;
  const enumOr = (v: unknown, allowed: readonly string[], fallback: string): string => {
    const accepted = acceptEnum(v, allowed, "salvage");
    return accepted.value ?? fallback;
  };
  const repaired = validateBrief({
    ...attempt,
    summary: text(attempt["summary"], "(brief did not validate; salvaged from the model's last attempt)"),
    draftReply: text(attempt["draftReply"], "(no valid draft reply was produced)"),
    recommendedAction: enumOr(attempt["recommendedAction"], DEEP_ACTIONS, "request_design_discussion"),
    confidence: enumOr(attempt["confidence"], ["low", "medium", "high"], "low"),
  });
  if (repaired.brief) {
    return {
      ...repaired.brief,
      caveats: [...repaired.brief.caveats, "This brief failed validation; it is preserved as the model wrote it."],
    };
  }
  // Still invalid: fall back to whatever text fields we can read.
  const r = deepTrim(raw) as Record<string, unknown>;
  return {
    summary: typeof r["summary"] === "string" && r["summary"] !== "" ? r["summary"] : "(no summary)",
    revisionChanges: Array.isArray(r["revisionChanges"]) ? r["revisionChanges"].map(String) : [],
    removedBehaviour: [],
    claims: [],
    openQuestions: [],
    recommendedAction: "request_design_discussion",
    rationale: Array.isArray(r["rationale"]) ? r["rationale"].map(String) : [],
    draftReply: typeof r["draftReply"] === "string" ? r["draftReply"] : "(no draft reply)",
    confidence: "low",
    caveats: ["This brief failed validation; it is preserved as the model wrote it."],
  };
}

export interface BriefValidationResult {
  brief: DeepBrief | null;
  /** Non-empty means the attempt was rejected; each entry quotes what arrived. */
  errors: string[];
  /** What we accepted after repair, for the caveats list. */
  coercions: string[];
}

/**
 * Validate a submitted brief, repairing what can be repaired.
 *
 * Whitespace and case are never a reason to fail: the value is trimmed and
 * normalised first, and a near-miss enum is coerced with a caveat. What is left
 * — a missing summary, a missing reply, an enum nothing resembles — is reported
 * with the offending value JSON-escaped, so the model can see the newlines it
 * sent.
 */
export function validateBrief(rawInput: unknown): BriefValidationResult {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return { brief: null, errors: [`the brief must be a JSON object, received ${JSON.stringify(rawInput)}`], coercions: [] };
  }
  const asReceived = rawInput as Record<string, unknown>;
  const r = deepTrim(rawInput) as Record<string, unknown>;
  const errors: string[] = [];
  const coercions: string[] = [];
  const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  const summary = typeof r["summary"] === "string" ? r["summary"] : "";
  if (summary === "") errors.push(`summary is required, received ${JSON.stringify(asReceived["summary"])}`);
  const draftReply = typeof r["draftReply"] === "string" ? r["draftReply"] : "";
  if (draftReply === "") errors.push(`draftReply is required, received ${JSON.stringify(asReceived["draftReply"])}`);

  const action = acceptEnum(r["recommendedAction"], DEEP_ACTIONS, "recommendedAction");
  if (action.value === null) {
    errors.push(
      `recommendedAction must be one of ${DEEP_ACTIONS.join(", ")}; received ${JSON.stringify(asReceived["recommendedAction"])}`,
    );
  } else if (action.coercion) {
    coercions.push(action.coercion);
  }

  const confidence = acceptEnum(r["confidence"], ["low", "medium", "high"], "confidence");
  if (confidence.value === null) {
    errors.push(`confidence must be "low", "medium" or "high"; received ${JSON.stringify(asReceived["confidence"])}`);
  } else if (confidence.coercion) {
    coercions.push(confidence.coercion);
  }

  const citations = (v: unknown): DeepBrief["claims"][number]["citations"] =>
    Array.isArray(v)
      ? v
          .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => {
            const kind = acceptEnum(c["kind"], CITATION_KINDS, "citation kind");
            if (kind.coercion) coercions.push(kind.coercion);
            return {
              kind: (kind.value ?? "code") as "code",
              ref: String(c["ref"] ?? "").trim(),
              ...(typeof c["note"] === "string" ? { note: c["note"] } : {}),
            };
          })
          .filter((c) => c.ref !== "")
      : [];

  const brief: DeepBrief = {
    summary,
    revisionChanges: strArray(r["revisionChanges"]),
    removedBehaviour: Array.isArray(r["removedBehaviour"])
      ? (r["removedBehaviour"] as Array<Record<string, unknown>>).map((b) => {
          const status = acceptEnum(b["status"], REMOVED_STATUSES, "removedBehaviour status");
          if (status.coercion) coercions.push(status.coercion);
          return {
            lines: String(b["lines"] ?? "").trim(),
            originPr: typeof b["originPr"] === "number" ? b["originPr"] : null,
            purpose: String(b["purpose"] ?? "").trim(),
            status: (status.value ?? "unclear") as "unclear",
            citations: citations(b["citations"]),
          };
        })
      : [],
    claims: Array.isArray(r["claims"])
      ? (r["claims"] as Array<Record<string, unknown>>).map((c) => {
          const verdict = acceptEnum(c["verdict"], VERDICTS, "claim verdict");
          if (verdict.coercion) coercions.push(verdict.coercion);
          return {
            claim: String(c["claim"] ?? "").trim(),
            by: String(c["by"] ?? "").trim(),
            verdict: (verdict.value ?? "unverified") as "unverified",
            evidence: String(c["evidence"] ?? "").trim(),
            citations: citations(c["citations"]),
          };
        })
      : [],
    openQuestions: Array.isArray(r["openQuestions"])
      ? (r["openQuestions"] as Array<Record<string, unknown>>)
          .map((q) => ({ question: String(q["question"] ?? "").trim(), toWhom: String(q["toWhom"] ?? "").trim() }))
          .filter((q) => q.question !== "")
      : [],
    recommendedAction: (action.value ?? "request_design_discussion") as DeepBrief["recommendedAction"],
    rationale: strArray(r["rationale"]),
    draftReply,
    confidence: (confidence.value ?? "low") as DeepBrief["confidence"],
    caveats: [...strArray(r["caveats"]), ...coercions],
  };

  return { brief: errors.length === 0 ? brief : null, errors, coercions };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function readRuns(): DeepRun[] {
  return readJson<DeepRun[]>(DEEP_PATH, []);
}

export function saveRun(run: DeepRun): void {
  const all = readRuns().filter((r) => r.id !== run.id);
  all.push(run);
  const byPr = new Map<number, DeepRun[]>();
  for (const r of all) {
    const list = byPr.get(r.prNumber) ?? [];
    list.push(r);
    byPr.set(r.prNumber, list);
  }
  const trimmed: DeepRun[] = [];
  for (const list of byPr.values()) {
    list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    trimmed.push(...list.slice(-MAX_RUNS_PER_PR));
  }
  trimmed.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  writeJsonAtomic(DEEP_PATH, trimmed);
}

export function runsFor(n: number): DeepRun[] {
  return readRuns()
    .filter((r) => r.prNumber === n)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function runById(id: string): DeepRun | null {
  return readRuns().find((r) => r.id === id) ?? null;
}

/**
 * Today's spend across *every* run, whatever its status. A run that failed or
 * was aborted still cost money, and a run in flight is spending it right now —
 * counting only completed runs let the daily cap be walked straight past.
 */
export function spendToday(now = new Date()): { todayUsd: number; runsToday: number } {
  const day = now.toISOString().slice(0, 10);
  const runs = readRuns().filter((r) => r.startedAt.slice(0, 10) === day);
  return {
    todayUsd: Number(runs.reduce((a, r) => a + r.usage.costUsd, 0).toFixed(6)),
    runsToday: runs.length,
  };
}

// --- in-flight registry -----------------------------------------------------

const inFlight = new Map<number, { runId: string; abort: AbortController }>();

export function runningFor(n: number): string | null {
  return inFlight.get(n)?.runId ?? null;
}

/** Abort a running loop. Returns false when there is nothing to stop. */
export function abortRun(n: number, runId: string): boolean {
  const entry = inFlight.get(n);
  if (!entry || entry.runId !== runId) return false;
  entry.abort.abort();
  return true;
}

// ---------------------------------------------------------------------------
// The mock script
// ---------------------------------------------------------------------------

/**
 * What a competent pass over this PR looks like, played from the dossier. The
 * tool calls are real (they hit the same dispatcher), only the model's choices
 * are scripted — so the mock exercises the whole loop, and the brief it ends
 * with is modelled on the worked example in DESIGN-deep.md.
 */
export function buildMockScript(dossier: Dossier, snapshot: PrSnapshot): MockTurn[] {
  const origin = dossier.originPrs[0];
  const deleted = dossier.deletedLineOrigins;
  const path = deleted[0]?.path ?? snapshot.files[0]?.path ?? "README.md";
  const firstLine = deleted[0]?.line ?? 1;
  const lastLine = deleted.at(-1)?.line ?? firstLine;
  const lineRef = `${path}:${firstLine}-${lastLine}`;
  const maintainer = dossier.thread.find((t) => t.isMaintainer);
  const authorComment = [...dossier.thread]
    .reverse()
    .find((t) => t.author.toLowerCase() === snapshot.author.toLowerCase() && t.kind !== "commit" && t.body.trim() !== "");

  const turns: MockTurn[] = [
    { toolCalls: [{ name: "pr_diff", args: {} }, { name: "revision_delta", args: {} }] },
    {
      toolCalls: [
        { name: "git_blame", args: { path, start_line: firstLine, end_line: lastLine } },
        ...(origin ? [{ name: "fetch_pr", args: { number: origin.number } }] : []),
      ],
    },
    {
      toolCalls: [
        { name: "read_file_at_base", args: { path, start_line: Math.max(1, firstLine - 20), end_line: lastLine + 10 } },
        { name: "grep", args: { pattern: "uart_set_pin|uart_param_config", max_results: 20 } },
      ],
    },
  ];

  const originLabel = origin ? `#${origin.number}` : "an earlier change";
  const originPurpose = origin
    ? (deleted.find((d) => d.pr?.number === origin.number)?.pr?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
    : "";

  const brief: DeepBrief = {
    summary:
      `Revision ${dossier.revisions.length} deletes the ${deleted.length}-line block at ${lineRef} outright. ` +
      `Those lines came from ${originLabel}${origin ? ` (${origin.author}, ${origin.daysAgo} days ago)` : ""}, ` +
      `whose stated purpose was "${originPurpose || "not recorded"}". ` +
      `${maintainer ? `${maintainer.author} has asked for a config option rather than a deletion.` : "No maintainer has weighed in yet."}`,
    revisionChanges: [
      dossier.latestDelta?.summary ?? "Only one revision has been pushed, so there is nothing to compare.",
      ...(dossier.drift.length > 0 ? [`The description still describes the earlier approach: ${dossier.drift[0]?.detail ?? ""}`] : []),
    ],
    removedBehaviour: deleted.length > 0
      ? [
          {
            lines: lineRef,
            originPr: origin?.number ?? null,
            purpose: originPurpose || "not recorded",
            status: "removed_without_replacement",
            citations: [
              { kind: "code", ref: `${lineRef}@${dossier.baseSha.slice(0, 9)}`, note: "the block as it stands at the base commit" },
              ...(origin ? [{ kind: "pr" as const, ref: `#${origin.number}`, note: "added the block" }] : []),
            ],
          },
        ]
      : [],
    claims: authorComment
      ? [
          {
            claim: "uart_param_config() already applies conf.uart_config.flow_ctrl, so the removed call was redundant",
            by: snapshot.author,
            verdict: "holds",
            evidence:
              "uart_param_config is called at the top of begin() with the caller's ChannelConfig, and it sets flow_ctrl; the deleted call overrode it unconditionally.",
            citations: [{ kind: "code", ref: `${path}:60-80@${dossier.baseSha.slice(0, 9)}` }],
          },
          {
            claim: "The block never ran on CoCo boards, so removing it does not change CoCo behaviour",
            by: snapshot.author,
            verdict: "partially_holds",
            evidence:
              "The CoCo pinmap leaves rts/cts at -1, so the guard was false there. But uart_set_pin still passes UART_PIN_NO_CHANGE for RTS/CTS, so opting in through ChannelConfig alone does not route the signals: flow control is now unreachable rather than opt-in.",
            citations: [
              { kind: "code", ref: `${path}:40-58@${dossier.baseSha.slice(0, 9)}`, note: "uart_set_pin call" },
              ...(origin ? [{ kind: "pr" as const, ref: `#${origin.number}` }] : []),
            ],
          },
        ]
      : [],
    openQuestions: [
      ...(origin && !origin.authorInThread
        ? [{ question: `Does the board ${origin.author} added this for actually have RTS/CTS wired to the UART peripheral?`, toWhom: origin.author }]
        : []),
      ...(maintainer
        ? [{ question: "Is a ChannelConfig flag enough, or should the pins be plumbed in this PR?", toWhom: maintainer.author }]
        : []),
    ],
    recommendedAction: origin && !origin.authorInThread ? "ask_original_author" : "request_design_discussion",
    rationale: [
      `The ${deleted.length} deleted lines are ${origin ? `${origin.daysAgo} days` : "recently"} old and came from ${originLabel}, whose author is ${origin?.authorInThread ? "in" : "not in"} this thread.`,
      ...(maintainer ? [`${maintainer.author} asked for a config option, not a deletion.`] : []),
      ...(dossier.drift.length > 0 ? ["The description no longer matches the diff."] : []),
    ],
    draftReply:
      `Thanks for the bisect and the hardware test — the boot regression is clear.\n\n` +
      `Before this lands: the ${deleted.length} lines being removed came from ${originLabel}${origin ? ` (${origin.author})` : ""}, ` +
      `and ${origin?.authorInThread ? "they are" : "that author is not"} in this thread. ` +
      `Could we hear from them on whether the board they added it for has RTS/CTS wired to the UART peripheral?\n\n` +
      `On the fix itself: \`uart_param_config()\` does already apply \`flow_ctrl\`, so the unconditional call was wrong. ` +
      `But \`uart_set_pin()\` still passes \`UART_PIN_NO_CHANGE\` for RTS/CTS, so \`.flowControl()\` alone will not route the signals — ` +
      `as written this removes the capability rather than making it opt-in. Either plumb the pins here or open a follow-up issue and say so in the description.\n\n` +
      `Also please rewrite the description: it still discusses the \`#ifdef\` approach this revision no longer takes.`,
    confidence: "medium",
    caveats: [
      "Generated in mock mode: no model was called, so the claim verdicts are scripted rather than verified.",
      ...(dossier.availability.notes.length > 0 ? dossier.availability.notes : []),
    ],
  };

  turns.push({ toolCalls: [{ name: "submit_brief", args: brief }] });
  return turns;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface RunDeepOptions {
  prNumber: number;
  requestedBy: string;
  snapshot: PrSnapshot;
  model?: string;
  /** Injected in tests; otherwise OpenRouter when a key is set, else the mock. */
  backend?: LlmBackend;
  dossier?: Dossier;
}

function firstUserMessage(dossier: Dossier, evaluation: Evaluation | null): string {
  const compact = {
    ...dossier,
    latestDelta: dossier.latestDelta
      ? { ...dossier.latestDelta, diff: dossier.latestDelta.diff.slice(0, 40_000) }
      : null,
    thread: dossier.thread.map((t) => ({ ...t, body: t.body.slice(0, 2048) })),
    deletedLineOrigins: dossier.deletedLineOrigins.map((o) => ({
      ...o,
      ...(o.pr ? { pr: { ...o.pr, body: o.pr.body.slice(0, 2048) } } : {}),
    })),
  };

  const findings: string[] = [];
  if (evaluation) {
    for (const [id, a] of Object.entries(evaluation.prAnswers)) {
      const def = QUESTIONS_BY_ID[id];
      if (!def) continue;
      if (a.type === "noul") findings.push(`${id}: ${a.noul.toFixed(2)}`);
      else if (a.type === "score") findings.push(`${id}: ${a.score.toFixed(1)} (confidence ${a.confidence.toFixed(2)})`);
      else findings.push(`${id}: ${a.choice} (confidence ${a.confidence.toFixed(2)})`);
    }
  }

  return [
    "DOSSIER (deterministic, built from git and the GitHub API):",
    JSON.stringify(compact, null, 1),
    "",
    "LATEST AUTOMATED EVALUATION:",
    evaluation
      ? [
          `decision: ${evaluation.decision.kind}, composite ${evaluation.decision.composite}`,
          `gates failed: ${evaluation.gates.filter((g) => !g.passed && g.severity !== "info" && g.severity !== "off").map((g) => g.id).join(", ") || "none"}`,
          `jev answers: ${findings.join("; ")}`,
        ].join("\n")
      : "none yet",
    "",
    "Verify what matters, then call submit_brief.",
  ].join("\n");
}

/**
 * Create and register the run **synchronously**, then do the slow work.
 *
 * The route answers 202 with this record, so it has to exist before the first
 * await — building the dossier takes seconds, and a route that looked the run
 * up afterwards returned the *previous* completed run instead.
 */
export function beginDeepRun(opts: RunDeepOptions): { run: DeepRun; done: Promise<DeepRun> } {
  const { prNumber, requestedBy, snapshot } = opts;
  const model = opts.model?.trim() || configuredModel();
  // The backend is only known for certain once the dossier exists (the mock
  // script is built from it), but whether we are in mock mode is not.
  const mock = opts.backend ? opts.backend.mock : makeLlmBackend() === null;
  const abort = new AbortController();

  const run: DeepRun = {
    id: newId("deep"),
    prNumber,
    headSha: snapshot.headSha,
    evaluationId: latestEvaluation(prNumber)?.id ?? null,
    dossierBuiltAt: "",
    model: mock ? `${model} (mock)` : model,
    mock,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: [],
    brief: null,
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 0 },
    requestedBy,
  };

  inFlight.set(prNumber, { runId: run.id, abort });
  saveRun(run);
  emit({ type: "deep:start", n: prNumber, runId: run.id, model: run.model });

  return { run, done: driveDeepRun(opts, run, abort, model) };
}

export async function runDeep(opts: RunDeepOptions): Promise<DeepRun> {
  return beginDeepRun(opts).done;
}

async function driveDeepRun(
  opts: RunDeepOptions,
  run: DeepRun,
  abort: AbortController,
  model: string,
): Promise<DeepRun> {
  const { prNumber, snapshot } = opts;
  const evaluation = latestEvaluation(prNumber);

  let dossier: Dossier;
  let backend: LlmBackend;
  try {
    // Always fresh for a deep run: the thread can move without a push, and the
    // model's whole job is to read what people actually said.
    dossier = opts.dossier ?? (await buildDossier(prNumber, { refresh: true }));
    backend = opts.backend ?? makeLlmBackend() ?? new MockLlmBackend(buildMockScript(dossier, snapshot));
  } catch (err) {
    run.status = "failed";
    run.error = `could not build the dossier: ${(err as Error).message}`;
    run.finishedAt = new Date().toISOString();
    inFlight.delete(prNumber);
    saveRun(run);
    emit({ type: "deep:error", n: prNumber, runId: run.id, error: run.error });
    emit({ type: "deep:done", n: prNumber, runId: run.id, run });
    return run;
  }
  run.dossierBuiltAt = dossier.builtAt;
  run.mock = backend.mock;
  run.model = backend.mock ? `${model} (mock)` : model;
  saveRun(run);

  const pushStep = (step: Omit<DeepStep, "index" | "at">): void => {
    const full: DeepStep = { index: run.steps.length, at: new Date().toISOString(), ...step };
    run.steps.push(full);
    saveRun(run); // persisted as they happen, so a reload shows a running job
    emit({ type: "deep:step", n: prNumber, runId: run.id, step: full });
  };

  const ctx: ToolContext = { prNumber, baseSha: dossier.baseSha, dossier };
  const messages: LlmMessage[] = [
    { role: "system", content: DEEP_SYSTEM_PROMPT },
    { role: "user", content: firstUserMessage(dossier, evaluation) },
  ];
  pushStep({ kind: "system", name: "dossier", resultPreview: `${dossier.revisions.length} revision(s), ${dossier.thread.length} thread entries` });

  const stepCap = maxSteps();
  const costCap = maxCostUsd();
  let briefRejections = 0;
  let lastAttempt: unknown = null;
  let budgetWarned = false;

  try {
    // Make sure the PR ref is present before the model asks for a file at it.
    if (!(await hasRev(prRef(prNumber)))) {
      pushStep({ kind: "system", name: "warning", resultPreview: `refs/pr/${prNumber} is not in the local clone; file tools may fail` });
    }

    for (let step = 0; step < stepCap; step++) {
      if (abort.signal.aborted) {
        run.status = "aborted";
        run.error = "stopped by the reviewer";
        break;
      }
      if (!backend.mock && run.usage.costUsd >= costCap) {
        run.status = "aborted";
        run.error = `cost cap reached ($${run.usage.costUsd.toFixed(4)} of $${costCap.toFixed(2)})`;
        if (lastAttempt !== null) run.partialBrief = salvageBrief(lastAttempt);
        break;
      }

      // Warn before the hard cap rather than cutting the model off mid-thought:
      // an aborted run with no brief wastes everything already spent.
      if (!backend.mock && !budgetWarned && run.usage.costUsd >= costCap * BUDGET_WARNING_FRACTION) {
        budgetWarned = true;
        const remaining = Math.max(0, costCap - run.usage.costUsd);
        messages.push({
          role: "user",
          content:
            `Budget notice: this run has used $${run.usage.costUsd.toFixed(3)} of its $${costCap.toFixed(2)} limit, ` +
            `leaving about $${remaining.toFixed(3)}. Stop investigating now and call submit_brief with what you already have. ` +
            `Mark anything you could not check as "unverified" rather than looking it up.`,
        });
        pushStep({
          kind: "system",
          name: "budget",
          resultPreview: `used $${run.usage.costUsd.toFixed(3)} of $${costCap.toFixed(2)}; asked the model to submit now`,
        });
      }

      const req: ChatRequest = { model, messages, tools: DEEP_TOOLS };
      const res = await backend.chat(req, abort.signal);
      run.usage.calls += 1;
      run.usage.promptTokens += res.usage.promptTokens;
      run.usage.completionTokens += res.usage.completionTokens;
      run.usage.costUsd = Number((run.usage.costUsd + res.usage.costUsd).toFixed(6));
      // Persist immediately: money already spent must survive a crash, and
      // /api/deep/spend counts running runs too.
      saveRun(run);

      const calls: LlmToolCall[] = res.message.tool_calls ?? [];
      messages.push(res.message);
      if (res.message.content) {
        pushStep({ kind: "assistant", resultPreview: res.message.content.slice(0, 400) });
      }

      if (calls.length === 0) {
        // The model answered in prose. Only submit_brief ends a run, so say so
        // once and let it try again; a second miss ends the run.
        if (briefRejections >= MAX_BRIEF_ATTEMPTS) {
          run.status = "failed";
          run.error = "the model stopped without calling submit_brief";
          if (lastAttempt !== null) run.partialBrief = salvageBrief(lastAttempt);
          break;
        }
        briefRejections += 1;
        messages.push({
          role: "user",
          content: "Only submit_brief ends this run. Call submit_brief with the full schema.",
        });
        continue;
      }

      let submitted = false;
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch (err) {
          parseError = `error: arguments were not valid JSON (${(err as Error).message})`;
        }

        if (parseError !== null) {
          pushStep({ kind: "tool", name: call.function.name, args: call.function.arguments, resultPreview: parseError });
          messages.push({ role: "tool", tool_call_id: call.id, content: parseError });
          continue;
        }

        if (call.function.name === "submit_brief") {
          const result = validateBrief(args);
          if (result.brief) {
            run.brief = result.brief;
            run.status = "done";
            if (result.coercions.length > 0) run.validationErrors = [...(run.validationErrors ?? []), ...result.coercions];
            pushStep({
              kind: "tool",
              name: "submit_brief",
              args: { recommendedAction: result.brief.recommendedAction },
              resultPreview: result.coercions.length > 0 ? `brief accepted (${result.coercions.join("; ")})` : "brief accepted",
            });
            submitted = true;
            break;
          }

          briefRejections += 1;
          // Keep whatever the model built, even though it did not validate: a
          // run that made 38 good tool calls must not come back empty.
          lastAttempt = deepTrim(args);
          run.validationErrors = [...(run.validationErrors ?? []), ...result.errors];
          const message = `error: ${result.errors.join("; ")}`;
          pushStep({ kind: "tool", name: "submit_brief", args, resultPreview: message });

          if (briefRejections >= MAX_BRIEF_ATTEMPTS) {
            run.status = "failed";
            run.error = `submit_brief was invalid ${briefRejections} times: ${result.errors.join("; ")}`;
            run.partialBrief = salvageBrief(lastAttempt);
            submitted = true; // stop the loop
            break;
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              `${message}\n\nThe values above are quoted exactly as they arrived, including any whitespace. ` +
              `Send the enum values as bare lower-case strings with no surrounding whitespace or newlines, then call submit_brief again.`,
          });
          continue;
        }

        const output = await runTool(call.function.name, args, ctx);
        pushStep({ kind: "tool", name: call.function.name, args, resultPreview: output.slice(0, 400) });
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }

      if (submitted) break;
    }

    if (run.status === "running") {
      run.status = "aborted";
      run.error = `step cap reached (${stepCap} steps) without a brief`;
    }
  } catch (err) {
    if (abort.signal.aborted) {
      run.status = "aborted";
      run.error = "stopped by the reviewer";
    } else {
      run.status = "failed";
      run.error = (err as Error).message;
    }
  } finally {
    inFlight.delete(prNumber);
    run.finishedAt = new Date().toISOString();
    saveRun(run);
    if (run.status === "failed") {
      emit({ type: "deep:error", n: prNumber, runId: run.id, error: run.error ?? "failed" });
    }
    emit({ type: "deep:done", n: prNumber, runId: run.id, run });
  }

  return run;
}
