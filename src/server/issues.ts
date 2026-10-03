// Open-issue triage: storage, one issue end to end, and the scan runner.
//
//   fetch → evidence (thread, linked work, code refs vs. master) → jev → recommend
//
// data/issue-evaluations.json   last 5 evaluations per issue
// data/issue-snapshots.json     latest snapshot per issue, so the list costs one API call
// data/issue-triage.json        local "kept" / "snoozed" marks

import { resolve } from "node:path";

import type {
  IssueEvaluation,
  IssueScanEvent,
  IssueSnapshot,
  IssueTriageState,
  JevAnswer,
  ScanJob,
} from "../shared/types.js";
import { emit } from "./events.js";
import { fetchIssueSnapshot, githubRepo, listOpenIssues, listRepoLabels } from "./github.js";
import { recommend } from "./issueDecide.js";
import { buildIssueEvidence } from "./issueEvidence.js";
import { askIssue, buildIssueState, MockIssueJevBackend } from "./issueJev.js";
import { createSdkBackend, estCostUsd, HttpJevBackend, type JevBackend } from "./jev.js";
import { jevKey, jevMode, jevModel } from "./pipeline.js";
import { DATA_DIR, ensureDataDir, loadPolicy, newId, readJson, writeJsonAtomic } from "./store.js";

export const ISSUE_EVALUATIONS_PATH = resolve(DATA_DIR, "issue-evaluations.json");
export const ISSUE_SNAPSHOTS_PATH = resolve(DATA_DIR, "issue-snapshots.json");
export const ISSUE_TRIAGE_PATH = resolve(DATA_DIR, "issue-triage.json");

const MAX_EVALUATIONS_PER_ISSUE = 5;

// --- storage ----------------------------------------------------------------

export function readIssueEvaluations(): IssueEvaluation[] {
  return readJson<IssueEvaluation[]>(ISSUE_EVALUATIONS_PATH, []);
}

export function appendIssueEvaluation(evaluation: IssueEvaluation): IssueEvaluation {
  const all = readIssueEvaluations();
  all.push(evaluation);
  const byIssue = new Map<number, IssueEvaluation[]>();
  for (const e of all) {
    const list = byIssue.get(e.issueNumber) ?? [];
    list.push(e);
    byIssue.set(e.issueNumber, list);
  }
  const trimmed = [...byIssue.values()].flatMap((list) => list.slice(-MAX_EVALUATIONS_PER_ISSUE));
  trimmed.sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
  writeJsonAtomic(ISSUE_EVALUATIONS_PATH, trimmed);
  return evaluation;
}

export function latestIssueEvaluations(): Map<number, IssueEvaluation> {
  const out = new Map<number, IssueEvaluation>();
  for (const e of readIssueEvaluations()) {
    const cur = out.get(e.issueNumber);
    if (!cur || cur.evaluatedAt < e.evaluatedAt) out.set(e.issueNumber, e);
  }
  return out;
}

export function latestIssueEvaluation(n: number): IssueEvaluation | null {
  return latestIssueEvaluations().get(n) ?? null;
}

export function readIssueSnapshots(): Record<string, IssueSnapshot> {
  return readJson<Record<string, IssueSnapshot>>(ISSUE_SNAPSHOTS_PATH, {});
}

export function saveIssueSnapshot(snapshot: IssueSnapshot): void {
  const all = readIssueSnapshots();
  all[String(snapshot.number)] = snapshot;
  writeJsonAtomic(ISSUE_SNAPSHOTS_PATH, all);
}

export function readIssueTriage(): Record<string, IssueTriageState> {
  return readJson<Record<string, IssueTriageState>>(ISSUE_TRIAGE_PATH, {});
}

export function setIssueTriage(state: IssueTriageState): IssueTriageState {
  const all = readIssueTriage();
  all[String(state.issueNumber)] = state;
  writeJsonAtomic(ISSUE_TRIAGE_PATH, all);
  return state;
}

/** An evaluation is stale once anyone has touched the issue since it was taken. */
export function issueIsStale(updatedAt: string, evaluation: IssueEvaluation | null): boolean {
  return !evaluation || evaluation.issueUpdatedAt !== updatedAt;
}

// --- one issue --------------------------------------------------------------

async function issueBackend(n: number): Promise<JevBackend> {
  if (jevMode() === "mock") return new MockIssueJevBackend(n);
  const key = jevKey() as string;
  if (process.env["JEV_TRANSPORT"] === "http") return new HttpJevBackend({ apiKey: key });
  return createSdkBackend(key);
}

function stage(n: number, s: "fetch" | "evidence" | "jev" | "decide", detail?: string): void {
  const e: IssueScanEvent = { type: "issue:stage", n, stage: s, ...(detail ? { detail } : {}) };
  emit(e);
}

export async function evaluateIssue(
  n: number,
  opts: { repoLabels?: string[]; snapshot?: IssueSnapshot; git?: boolean } = {},
): Promise<IssueEvaluation> {
  ensureDataDir();
  const started = Date.now();

  stage(n, "fetch");
  const snapshot = opts.snapshot ?? (await fetchIssueSnapshot(n));
  saveIssueSnapshot(snapshot);
  stage(n, "fetch", `${snapshot.comments.length} comment(s), ${snapshot.linkedPrs.length} linked PR(s)`);

  stage(n, "evidence");
  const evidence = await buildIssueEvidence(snapshot, githubRepo().full, opts.git === false ? { git: false } : {});
  stage(
    n,
    "evidence",
    evidence.git
      ? `${evidence.codeRefsChecked} code reference(s) checked, ${evidence.codeRefsMissing} missing; ${evidence.commitsSinceOpened ?? "?"} commits since opened`
      : evidence.notes[0] ?? "code references not checked",
  );

  const policy = loadPolicy();
  const model = jevModel(policy);
  const mock = jevMode() === "mock";
  let answers: Record<string, JevAnswer> = {};
  let reportedModel = mock ? "mock" : model;
  let inputTokens = 0;
  let calls = 0;
  let error: string | undefined;

  stage(n, "jev");
  try {
    const backend = await issueBackend(n);
    const res = await askIssue(backend, buildIssueState(snapshot, evidence), model);
    answers = res.answers;
    reportedModel = res.model;
    inputTokens = res.inputTokens;
    calls = 1;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    stage(n, "jev", `failed: ${error.slice(0, 160)}`);
  }

  stage(n, "decide");
  const repoLabels = opts.repoLabels ?? (await listRepoLabels());
  const recommendation = recommend({
    snapshot,
    evidence,
    answers,
    model: reportedModel,
    repoLabels,
    ...(error ? { jevError: error } : {}),
  });

  const evaluation: IssueEvaluation = {
    id: newId("iev"),
    issueNumber: n,
    issueUpdatedAt: snapshot.updatedAt,
    evaluatedAt: new Date().toISOString(),
    mock,
    model: reportedModel,
    evidence,
    answers,
    recommendation,
    usage: { input_tokens: inputTokens, calls, estCostUsd: Number(estCostUsd(inputTokens).toFixed(6)) },
    durationMs: Date.now() - started,
    ...(error ? { error } : {}),
  };
  appendIssueEvaluation(evaluation);
  return evaluation;
}

// --- scan runner ------------------------------------------------------------

const jobs = new Map<string, ScanJob>();
let runningId: string | null = null;

export function runningIssueScan(): ScanJob | null {
  return runningId ? (jobs.get(runningId) ?? null) : null;
}

export function getIssueJob(id: string): ScanJob | null {
  return jobs.get(id) ?? null;
}

export class IssueScanInProgressError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`an issue scan is already running (job ${jobId})`);
    this.name = "IssueScanInProgressError";
    this.jobId = jobId;
  }
}

/** Same shape as startScan: the lock is claimed before the first await. */
export function startIssueScan(opts: { force?: boolean; numbers?: number[] } = {}): ScanJob {
  if (runningId) throw new IssueScanInProgressError(runningId);
  const job: ScanJob = {
    id: newId("iscan"),
    startedAt: new Date().toISOString(),
    total: opts.numbers?.length ?? 0,
    done: 0,
    errors: [],
    status: "running",
  };
  jobs.set(job.id, job);
  runningId = job.id;

  void (async () => {
    const refs = await listOpenIssues();
    const wanted = opts.numbers ? refs.filter((r) => opts.numbers?.includes(r.number)) : refs;
    // A number asked for explicitly that is no longer open is still evaluated, so
    // "re-analyse" on a just-closed issue says what happened rather than nothing.
    for (const n of opts.numbers ?? []) {
      if (!wanted.some((r) => r.number === n)) wanted.push({ number: n, title: "", updatedAt: "" });
    }
    job.total = wanted.length;
    emit({ type: "issues:start", jobId: job.id, total: wanted.length });

    const latest = latestIssueEvaluations();
    const repoLabels = await listRepoLabels();
    for (const ref of wanted) {
      job.current = ref.number;
      try {
        const existing = latest.get(ref.number) ?? null;
        if (!opts.force && existing && !issueIsStale(ref.updatedAt, existing)) {
          stage(ref.number, "decide", "unchanged since last analysis — skipped");
          emit({ type: "issue:done", n: ref.number, evaluation: existing });
        } else {
          const evaluation = await evaluateIssue(ref.number, { repoLabels });
          emit({ type: "issue:done", n: ref.number, evaluation });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.errors.push({ n: ref.number, error: message });
        emit({ type: "issue:error", n: ref.number, error: message });
      }
      job.done += 1;
    }
  })()
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[issues] job ${job.id} failed: ${message}`);
      job.errors.push({ n: 0, error: message });
      job.status = "failed";
    })
    .finally(() => {
      delete job.current;
      if (job.status === "running") job.status = job.errors.length === job.total && job.total > 0 ? "failed" : "done";
      job.finishedAt = new Date().toISOString();
      runningId = null;
      emit({ type: "issues:done", jobId: job.id });
    });
  return job;
}
