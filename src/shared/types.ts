// API contract between server and web. Edit only with both sides in mind.

export type DecisionKind = "READY" | "NEEDS_REVIEW" | "BLOCKED";
export type Severity = "hard" | "soft" | "info" | "off";
export type SizeBucket = "tiny" | "small" | "medium" | "large" | "huge";
export type CiState = "green" | "red" | "pending" | "none";

export interface PrFile { path: string; status: "added" | "modified" | "removed" | "renamed"; additions: number; deletions: number; previousPath?: string; }
export interface CheckRun { name: string; status: string; conclusion: string | null; url?: string; }

export interface PrSnapshot {
  number: number; title: string; body: string; author: string; authorAssociation: string;
  url: string; draft: boolean; state: "open" | "closed" | "merged"; base: string; headRef: string; headSha: string;
  createdAt: string; updatedAt: string; labels: string[];
  mergeable: boolean | null; mergeableState: string;
  additions: number; deletions: number; changedFiles: number;
  files: PrFile[]; checks: CheckRun[]; ci: CiState;
  reviewCount: number; commentCount: number; latestReviewStates: Record<string, string>;
  diffBytes: number; fetchedAt: string;
}

export interface GateResult { id: string; severity: Severity; passed: boolean; detail: string; evidence?: string[]; value?: string | number | string[]; }

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface QuestionDef { id: string; kind: "pr" | "chunk"; type: "noul" | "choice" | "score"; label: string; instructions: unknown; criteria?: unknown; weight: number; polarity: "good" | "bad" | "info"; hardBlockAbove?: number; levels?: number; }

export interface ChunkInfo { index: number; files: string[]; tokensEstimate: number; truncated: boolean; }
/** `error` is set when this chunk's Jev call failed; `answers` is then `{}` and the chunk is excluded from the aggregate. */
export interface ChunkResult { chunk: ChunkInfo; answers: Record<string, JevAnswer>; model: string; usage: { input_tokens: number; output_tokens: number }; error?: string; }
export interface AggregatedAnswer { answer: JevAnswer; fromChunk?: number; fromFiles?: string[]; }

export interface Reason { code: string; text: string; source: "gate" | "jev" | "policy"; questionId?: string; gateId?: string; severity?: Severity; }
export interface Decision { kind: DecisionKind; composite: number; minConfidence: number | null; uncertainNouls: string[]; reasons: Reason[]; explanation: string[]; contributions: Array<{ questionId: string; weight: number; goodness: number; points: number }>; }

export interface Evaluation {
  id: string; prNumber: number; headSha: string; evaluatedAt: string; mock: boolean; model: string;
  gates: GateResult[];
  prAnswers: Record<string, JevAnswer>;
  chunks: ChunkResult[]; coverage: "full" | "partial"; skippedFiles: string[];
  aggregated: Record<string, AggregatedAnswer>;
  usage: { input_tokens: number; output_tokens: number; calls: number; estCostUsd: number };
  decision: Decision; policyVersion: string; durationMs: number; error?: string;
}

/** `fetchError` is set when this PR could not be fetched from GitHub; `snapshot` is then a
 *  placeholder built from the open-PR listing and `evaluation` may be stale or null. */
export interface PrListItem { snapshot: PrSnapshot; evaluation: Evaluation | null; stale: boolean; triage: TriageState | null; fetchError?: string; }
export interface Policy { readyThreshold: number; reviewThreshold: number; confidenceFloor: number; maxUncertainNouls: number; softGatePenalty: number; skipJevWhenBlocked: boolean; weights: Record<string, number>; hardBlocks: Record<string, number>; gates: Record<string, Severity>; jev: { model: string; maxStateTokens: number; maxChunksPerPr: number; concurrency: number }; }
export interface ScanJob { id: string; startedAt: string; finishedAt?: string; total: number; done: number; current?: number; errors: Array<{ n: number; error: string }>; status: "running" | "done" | "failed"; }
export type ActionKind = "comment" | "review_request_changes" | "review_approve" | "labels";
export interface Proposal { id: string; prNumber: number; headSha: string; evaluationId: string; kind: ActionKind; title: string; body: string; labels?: string[]; rationale: string[]; generatedAt: string; }
export interface ActionRecord { id: string; prNumber: number; headSha: string; proposalId: string; kind: ActionKind; body?: string; labels?: string[]; confirmedBy: string; requestedAt: string; outcome: "posted" | "refused_writes_disabled" | "refused_stale" | "refused_bad_confirm" | "failed"; githubUrl?: string; error?: string; }
export interface TriageState { prNumber: number; status: "untriaged" | "triaged" | "snoozed"; note?: string; updatedAt: string; by?: string; }
export type ScanEvent =
  | { type: "scan:start"; jobId: string; total: number }
  | { type: "pr:start"; n: number; title: string }
  | { type: "pr:stage"; n: number; stage: "fetch" | "gates" | "chunk" | "jev" | "decide"; detail?: string }
  | { type: "pr:done"; n: number; evaluation: Evaluation }
  | { type: "pr:error"; n: number; error: string }
  | { type: "scan:done"; jobId: string };

// ---- Deep analysis (see DESIGN-deep.md) ----
export interface Revision { headSha: string; pushedAt: string; commits: Array<{ sha: string; date: string; author: string; subject: string }>; additions: number; deletions: number; changedFiles: number; }
export interface RevisionDelta { fromSha: string; toSha: string; diff: string; filesTouched: string[]; linesAddedNowRemoved: number; linesRemovedNowRestored: number; summary: string; }
export interface DeletedLineOrigin { path: string; line: number; text: string; sha: string; author: string; date: string; subject: string; pr: { number: number; title: string; url: string; author: string; mergedAt: string | null; body: string } | null; }
export interface ThreadEntry { kind: "issue_comment" | "review_comment" | "review" | "commit"; at: string; author: string; association: string; isMaintainer: boolean; body: string; path?: string; line?: number; state?: string; url: string; }
export interface CrossRef { symbol: string; fromDeletedLine: string; hits: Array<{ path: string; line: number; text: string }>; }
export interface DriftSignal { kind: "body_mentions_absent_token" | "title_mentions_absent_token" | "body_predates_push" | "commit_subject_disagrees_with_title"; detail: string; evidence: string[]; }
export interface Dossier {
  prNumber: number; headSha: string; baseSha: string; builtAt: string;
  revisions: Revision[]; latestDelta: RevisionDelta | null;
  deletedLineOrigins: DeletedLineOrigin[]; originPrs: Array<{ number: number; title: string; author: string; mergedAt: string | null; daysAgo: number; linesDeletedFromIt: number; authorInThread: boolean }>;
  thread: ThreadEntry[]; maintainers: string[];
  crossRefs: CrossRef[]; drift: DriftSignal[];
  availability: { git: boolean; provenance: boolean; crossRefs: boolean; notes: string[] };
}
export type DeepAction = "merge_review_now" | "request_design_discussion" | "request_description_or_tests" | "request_split" | "request_rebase" | "request_follow_up_issue" | "ask_original_author" | "wait_for_ci" | "close_stale";
export interface Citation { kind: "code" | "pr" | "comment" | "commit"; ref: string; note?: string; }
export interface ClaimVerdict { claim: string; by: string; verdict: "holds" | "does_not_hold" | "partially_holds" | "unverified"; evidence: string; citations: Citation[]; }
export interface RemovedBehaviour { lines: string; originPr: number | null; purpose: string; status: "replaced" | "made_opt_in" | "removed_without_replacement" | "unclear"; citations: Citation[]; }
export interface DeepBrief {
  summary: string; revisionChanges: string[]; removedBehaviour: RemovedBehaviour[]; claims: ClaimVerdict[];
  openQuestions: Array<{ question: string; toWhom: string }>; recommendedAction: DeepAction; rationale: string[];
  draftReply: string; confidence: "low" | "medium" | "high"; caveats: string[];
}
export interface DeepStep { index: number; at: string; kind: "tool" | "assistant" | "system"; name?: string; args?: unknown; resultPreview?: string; }
export interface DeepRun {
  id: string; prNumber: number; headSha: string; evaluationId: string | null; dossierBuiltAt: string;
  model: string; mock: boolean; startedAt: string; finishedAt?: string; status: "running" | "done" | "failed" | "aborted";
  steps: DeepStep[]; brief: DeepBrief | null; usage: { promptTokens: number; completionTokens: number; costUsd: number; calls: number };
  error?: string; requestedBy: string;
  /** The last brief the model attempted when validation finally failed, so the work is never lost. */
  partialBrief?: DeepBrief | null;
  /** Why each submit_brief attempt was rejected, newest last. */
  validationErrors?: string[];
}
export interface DeepModel { id: string; name: string; contextLength: number; promptUsdPerM: number; completionUsdPerM: number; }
export type DeepEvent =
  | { type: "deep:start"; n: number; runId: string; model: string }
  | { type: "deep:step"; n: number; runId: string; step: DeepStep }
  | { type: "deep:done"; n: number; runId: string; run: DeepRun }
  | { type: "deep:error"; n: number; runId: string; error: string };

// ---- Admin settings (every environment variable, managed from the UI) ----
export interface SettingDef { key: string; label: string; description: string; group: "github" | "jev" | "openrouter" | "deep" | "server"; secret: boolean; type: "string" | "number" | "boolean" | "enum"; options?: string[]; default: string | null; requiresRestart: boolean; }
export interface SettingValue { key: string; set: boolean; source: "env" | "dotenv" | "default"; value: string | null; effective: string | null; }
export interface AdminSettings { defs: SettingDef[]; values: SettingValue[]; dotenvPath: string; dotenvWritable: boolean; restartRequired: string[]; }
export interface SettingTestResult { key: string; ok: boolean; detail: string; checkedAt: string; }
