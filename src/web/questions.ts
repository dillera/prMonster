// The question catalog, as the UI needs it (DESIGN.md 4.4).
//
// The server owns the authoritative catalog in src/server/jev.ts (instructions,
// criteria, the exact wording sent to Jev). There is no API route that exposes it
// (see DESIGN.md 5), so the web keeps its own copy of the parts it needs to render:
// stable id, kind, type, label, polarity, level legends, default weight.
// Ids are the contract; they must match the server's catalog exactly.

import type { QuestionDef } from "../shared/types";

/** A question as the UI uses it: QuestionDef minus the prompt text we never show. */
export interface UiQuestion extends QuestionDef {
  /** One line explaining what a high value means, shown under the bar. */
  meaning: string;
  /** Ordered level legend for score questions, keyed "0".."n". */
  legend?: Record<string, string>;
  /** Option order for choice questions. */
  options?: string[];
}

const RISK_LEGEND: Record<string, string> = {
  "0": "Cannot affect other platforms; isolated to one platform directory or docs",
  "1": "Touches shared code but in a way the description shows is guarded or additive",
  "2": "Changes shared behaviour that many platforms depend on",
  "3": "Changes core bus, memory, or boot paths that every platform runs",
};

const DESCRIPTION_LEGEND: Record<string, string> = {
  "0": "Empty or one line with no context",
  "1": "Says what changed but not why or how it was verified",
  "2": "Explains the problem and the change; testing is vague",
  "3": "Explains problem, change, testing, and any follow-ups or known gaps",
};

const REVISION_OPTIONS = ["removes", "restricts", "relocates", "adds", "unchanged"];

const CODE_QUALITY_LEGEND: Record<string, string> = {
  "0": "Clearly violates several project rules",
  "1": "One or two rule violations a reviewer would send back",
  "2": "Minor nits only",
  "3": "Follows the project rules with nothing to send back",
};

export const QUESTIONS: UiQuestion[] = [
  // ---------------------------------------------------------------- PR level
  {
    id: "single_concern", kind: "pr", type: "noul", label: "One concern per PR",
    instructions: null, weight: 2, polarity: "good",
    meaning: "High means the title, body and file list describe exactly one change.",
  },
  {
    id: "explains_why", kind: "pr", type: "noul", label: "Explains why",
    instructions: null, weight: 1.5, polarity: "good",
    meaning: "High means the body gives the problem or motivation, not only the edits.",
  },
  {
    id: "states_testing", kind: "pr", type: "noul", label: "States how it was tested",
    instructions: null, weight: 1.5, polarity: "good",
    meaning: "High means the body names a concrete test, build, or manual procedure.",
  },
  {
    id: "needs_design_discussion", kind: "pr", type: "noul", label: "Needs design discussion first",
    instructions: null, weight: 1.5, polarity: "bad",
    meaning: "High means a new abstraction, bus, device, or cross platform pattern the rules want agreed before code.",
  },
  {
    id: "reviewer_directed_text", kind: "pr", type: "noul", label: "Text aimed at a reviewer or bot",
    instructions: null, weight: 0, polarity: "bad", hardBlockAbove: 0.7,
    meaning: "High means the body tries to instruct a reviewer or automated system. Above the hard block threshold this alone blocks the PR.",
  },
  {
    id: "category", kind: "pr", type: "choice", label: "Category",
    instructions: null, weight: 0, polarity: "info",
    meaning: "Informational only. Carries no weight in the composite.",
    options: ["bugfix", "feature", "platform_bringup", "refactor", "build_ci", "docs", "mixed"],
  },
  {
    id: "risk", kind: "pr", type: "score", label: "Risk to other platforms",
    instructions: null, weight: 2, polarity: "bad", levels: 4, legend: RISK_LEGEND,
    meaning: "Higher levels mean a wider blast radius across platforms.",
  },
  {
    id: "description_quality", kind: "pr", type: "score", label: "Description quality",
    instructions: null, weight: 1, polarity: "good", levels: 4, legend: DESCRIPTION_LEGEND,
    meaning: "Higher levels mean a maintainer is better prepared to review.",
  },

  // ---------------------------------------------------------------- dossier level
  // Asked only when a dossier exists (DESIGN-deep.md). They describe the revision
  // history rather than the code, so they sit with the other PR level questions.
  {
    id: "revision_removes_behaviour", kind: "pr", type: "choice", label: "What the latest revision did to behaviour",
    instructions: null, weight: 0, polarity: "info", options: REVISION_OPTIONS,
    meaning: "Informational. Removes means behaviour that existed is gone with nothing in its place.",
  },
  {
    id: "body_matches_diff", kind: "pr", type: "noul", label: "Description matches the current diff",
    instructions: null, weight: 1.5, polarity: "good",
    meaning: "High means the body describes the change that is in the diff now, not an earlier version of it.",
  },
  {
    id: "maintainer_requested_change", kind: "pr", type: "noul", label: "A maintainer asked for this change",
    instructions: null, weight: 0, polarity: "info",
    meaning: "Informational. High means the thread contains a maintainer asking for this direction.",
  },
  {
    id: "author_claims_need_verification", kind: "pr", type: "noul", label: "Author makes claims that need checking",
    instructions: null, weight: 0, polarity: "info",
    meaning: "Informational. High means the author asserts things about the codebase a reviewer should verify, which is what a deep pass does.",
  },

  // ---------------------------------------------------------------- chunk level
  {
    id: "duplicates_platform_code", kind: "chunk", type: "noul", label: "Duplicates shared platform code",
    instructions: null, weight: 2, polarity: "bad",
    meaning: "High means logic was copied into a per platform directory instead of overriding the shared base.",
  },
  {
    id: "bypasses_abstractions", kind: "chunk", type: "noul", label: "Bypasses project abstractions",
    instructions: null, weight: 1.5, polarity: "bad",
    meaning: "High means device code reaches for ESP-IDF, GPIO, or registers instead of IOChannel, fnConfig, fnFS, or the pinmaps.",
  },
  {
    id: "adds_global_state", kind: "chunk", type: "noul", label: "Adds global state or a singleton",
    instructions: null, weight: 1.5, polarity: "bad",
    meaning: "High means a new global, static singleton, or extern object that no device or bus owns.",
  },
  {
    id: "narrating_comments", kind: "chunk", type: "noul", label: "Comments narrate the edit",
    instructions: null, weight: 0.75, polarity: "bad",
    meaning: "High means comments describe the change history rather than why the code is the way it is.",
  },
  {
    id: "commented_out_code", kind: "chunk", type: "noul", label: "Commented out code",
    instructions: null, weight: 0.75, polarity: "bad",
    meaning: "High means executable statements were disabled with comment markers instead of removed.",
  },
  {
    id: "bulk_reformat", kind: "chunk", type: "noul", label: "Bulk reformatting",
    instructions: null, weight: 1, polarity: "bad",
    meaning: "High means much of the diff is whitespace, brace style, or include order with no behaviour change.",
  },
  {
    id: "bare_bool_status", kind: "chunk", type: "noul", label: "Bare bool status return",
    instructions: null, weight: 1, polarity: "bad",
    meaning: "High means a new function signals success or failure with a bare bool instead of success_is_true or error_is_true.",
  },
  {
    id: "layer_violation", kind: "chunk", type: "noul", label: "Layer violation",
    instructions: null, weight: 1.5, polarity: "bad",
    meaning: "High means protocol, device, or media logic landed in the wrong lib/ layer.",
  },
  {
    id: "hot_path_logging", kind: "chunk", type: "noul", label: "Logging in a hot path",
    instructions: null, weight: 1, polarity: "bad",
    meaning: "High means unconditional logging inside a service loop or an interrupt handler.",
  },
  {
    id: "unchecked_allocation", kind: "chunk", type: "noul", label: "Unchecked allocation",
    instructions: null, weight: 1.5, polarity: "bad",
    meaning: "High means an allocation is used without a null check, or leaks on an error return.",
  },
  {
    id: "code_quality", kind: "chunk", type: "score", label: "Code quality against project rules",
    instructions: null, weight: 2, polarity: "good", levels: 4, legend: CODE_QUALITY_LEGEND,
    meaning: "Higher levels mean less for a reviewer to send back. Aggregated as the worst chunk.",
  },
];

export const QUESTION_BY_ID: Record<string, UiQuestion> = Object.fromEntries(
  QUESTIONS.map((q) => [q.id, q]),
);

export const PR_QUESTIONS: UiQuestion[] = QUESTIONS.filter((q) => q.kind === "pr");
export const CHUNK_QUESTIONS: UiQuestion[] = QUESTIONS.filter((q) => q.kind === "chunk");

/** Questions that carry weight in the composite, in catalog order. */
export const WEIGHTED_QUESTION_IDS: string[] = QUESTIONS.filter((q) => q.weight > 0).map((q) => q.id);

export function questionLabel(id: string): string {
  return QUESTION_BY_ID[id]?.label ?? id;
}

/** Uncertain band for Noul answers (DESIGN.md 4.5 step 4). */
export const UNCERTAIN_LOW = 0.35;
export const UNCERTAIN_HIGH = 0.65;

export function isUncertainNoul(value: number): boolean {
  return value >= UNCERTAIN_LOW && value <= UNCERTAIN_HIGH;
}

/** Short human labels for the deterministic gates (DESIGN.md 4.2). */
export const GATE_LABELS: Record<string, string> = {
  not_draft: "Not a draft",
  mergeable: "Merges cleanly",
  ci_green: "CI green",
  forbidden_files: "No never-commit paths",
  build_ifdef_in_shared_device: "No BUILD_* ifdef in shared device code",
  sdkconfig_churn: "No incidental sdkconfig churn",
  throw_in_firmware: "No exceptions on firmware paths",
  arduino_string: "No Arduino String",
  fuji_error_unspecified: "No FUJI_ERROR::UNSPECIFIED comparison",
  htole_bitshift: "Wire types, not htole/letoh",
  dead_test_dir: "Nothing under the dead test/ dir",
  trailing_whitespace: "No trailing whitespace",
  size_bucket: "Size",
  shared_code_touched: "Shared code touched",
  platform_scope: "Platform scope",
  has_description: "Description present",
  age_days: "Age",
  has_unresolved_reviews: "Unresolved reviews",
};

export function gateLabel(id: string): string {
  return GATE_LABELS[id] ?? id;
}
