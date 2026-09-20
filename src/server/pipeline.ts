// One PR end to end, plus the scan runner (DESIGN.md §4, §5).
//
//   fetch → gates → chunk → jev(pr) + jev(chunk_i)… → aggregate → decide
//
// Emits pr:stage events at every step so the dashboard can show progress live.

import type {
  ChunkResult,
  Dossier,
  Evaluation,
  JevAnswer,
  Policy,
  PrSnapshot,
  ScanJob,
  SizeBucket,
} from "../shared/types.js";
import { parseDiff, planChunks } from "./chunk.js";
import { decide, DIFF_UNAVAILABLE_GATE } from "./decide.js";
import { buildDossier, dossierGates } from "./dossier.js";
import { emit } from "./events.js";
import { runGates, sizeBucketFromGates } from "./gates.js";
import { fetchSnapshot, listOpenPrNumbers } from "./github.js";
import {
  aggregateChunkAnswers,
  askChunkWithSplitting,
  askPr,
  buildPrState,
  createSdkBackend,
  estCostUsd,
  HttpJevBackend,
  mapWithConcurrency,
  type JevBackend,
} from "./jev.js";
import { MockJevBackend } from "./mock.js";
import {
  appendEvaluation,
  ensureDataDir,
  latestEvaluation,
  loadPolicy,
  newId,
  policyVersion,
} from "./store.js";

// --- backend selection ------------------------------------------------------

export function jevKey(): string | null {
  const k = process.env["TYPESAFE_API_KEY"]?.trim();
  return k ? k : null;
}

export function jevMode(): "live" | "mock" {
  if (process.env["JEV_MOCK"] === "1") return "mock";
  return jevKey() ? "live" : "mock";
}

export function jevModel(policy: Policy): string {
  return process.env["JEV_MODEL"]?.trim() || policy.jev.model;
}

/** Mock when JEV_MOCK=1 or the key is missing; never crash on a missing key. */
export async function makeBackend(snapshot: PrSnapshot, sizeBucket: SizeBucket): Promise<JevBackend> {
  if (jevMode() === "mock") {
    return new MockJevBackend({
      prNumber: snapshot.number,
      title: snapshot.title,
      body: snapshot.body,
      sizeBucket,
      filesChanged: snapshot.changedFiles,
      draft: snapshot.draft,
    });
  }
  const key = jevKey() as string;
  if (process.env["JEV_TRANSPORT"] === "http") return new HttpJevBackend({ apiKey: key });
  return createSdkBackend(key);
}

// --- one PR -----------------------------------------------------------------

export interface EvaluateOptions {
  force?: boolean;
  policy?: Policy;
}

export async function evaluatePr(n: number, opts: EvaluateOptions = {}): Promise<Evaluation> {
  ensureDataDir();
  const policy = opts.policy ?? loadPolicy();
  const started = Date.now();

  emit({ type: "pr:stage", n, stage: "fetch" });
  const { snapshot, diff, fromCache } = await fetchSnapshot(n, { force: opts.force === true });
  emit({
    type: "pr:stage",
    n,
    stage: "fetch",
    detail: `${snapshot.changedFiles} files, ${snapshot.diffBytes} diff bytes${fromCache ? " (cached)" : ""}`,
  });

  const diffUnavailable = diff === null;
  if (diffUnavailable) {
    emit({ type: "pr:stage", n, stage: "fetch", detail: "diff unavailable — gates will see no hunks" });
  }
  const parsed = parseDiff(diff ?? "");

  emit({ type: "pr:stage", n, stage: "gates" });
  const gates = runGates(snapshot, parsed, policy);
  if (diffUnavailable) {
    // decide() blocks READY on this gate whatever the policy says, because every
    // added-line gate above passed only for want of anything to look at.
    gates.push({
      id: DIFF_UNAVAILABLE_GATE,
      severity: "info",
      passed: false,
      detail:
        "GitHub would not serve the diff for this pull request, so no line-level gate or code question could run",
    });
  }
  const sizeBucket = sizeBucketFromGates(gates);
  const hardFailed = gates.filter((g) => g.severity === "hard" && !g.passed);
  emit({
    type: "pr:stage",
    n,
    stage: "gates",
    detail: `${gates.length} gates, ${hardFailed.length} hard failure(s)`,
  });

  // The dossier is deterministic context for the four deep PR questions. It is
  // best-effort: a PR still evaluates fine without one, just without those
  // questions and their reasons. Cached per head SHA, so re-scans are cheap.
  let dossier: Dossier | null = null;
  if (process.env["DEEP_DOSSIER"] !== "0") {
    try {
      dossier = await buildDossier(n, { refresh: opts.force === true });
      gates.push(...dossierGates(dossier));
      emit({
        type: "pr:stage",
        n,
        stage: "gates",
        detail: `dossier: ${dossier.revisions.length} revision(s), ${dossier.deletedLineOrigins.length} traced deleted line(s), ${dossier.drift.length} drift signal(s)`,
      });
    } catch (err) {
      emit({ type: "pr:stage", n, stage: "gates", detail: `dossier unavailable: ${(err as Error).message}` });
    }
  }

  emit({ type: "pr:stage", n, stage: "chunk" });
  const plan = planChunks(parsed, policy);
  emit({
    type: "pr:stage",
    n,
    stage: "chunk",
    detail: `${plan.chunks.length} chunk(s), coverage ${plan.coverage}, ${plan.skippedFiles.length} file(s) skipped`,
  });

  const model = jevModel(policy);
  const mock = jevMode() === "mock";
  const backend = await makeBackend(snapshot, sizeBucket);

  let prAnswers: Record<string, JevAnswer> = {};
  let chunkResults: ChunkResult[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  let reportedModel = mock ? "mock" : model;
  let error: string | undefined;

  const skipJev = policy.skipJevWhenBlocked && hardFailed.length > 0;
  if (skipJev) {
    emit({ type: "pr:stage", n, stage: "jev", detail: "skipped: hard gate failed and skipJevWhenBlocked is set" });
  } else {
    emit({ type: "pr:stage", n, stage: "jev", detail: `1 PR call + ${plan.chunks.length} chunk call(s)` });

    // The PR-level call is the only one whose failure costs us the evaluation.
    try {
      const prState = buildPrState(
        snapshot,
        gates,
        { count: plan.chunks.length, coverage: plan.coverage },
        policy,
        dossier,
      );
      const prRes = await askPr(backend, prState, model);
      prAnswers = prRes.answers;
      reportedModel = prRes.model;
      inputTokens += prRes.usage.input_tokens;
      outputTokens += prRes.usage.output_tokens;
      calls += 1;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      emit({ type: "pr:stage", n, stage: "jev", detail: `PR-level call failed: ${error}` });
    }

    // Chunk calls are isolated: one chunk the API refuses is split and retried,
    // and if it still fails only that chunk is lost.
    let nextChunkIndex = plan.chunks.length;
    const nested = await mapWithConcurrency(plan.chunks, policy.jev.concurrency, async (chunk) => {
      const label = `chunk ${chunk.index + 1}/${plan.chunks.length}`;
      const results = await askChunkWithSplitting(backend, snapshot, chunk, model, {
        nextIndex: () => nextChunkIndex++,
        label,
        onNote: (detail) => emit({ type: "pr:stage", n, stage: "jev", detail }),
      });
      const failed = results.filter((r) => r.error);
      emit({
        type: "pr:stage",
        n,
        stage: "jev",
        detail:
          failed.length > 0
            ? `${label} failed: ${failed[0]?.error?.slice(0, 160) ?? "unknown error"}`
            : `${label}: ${chunk.files.map((f) => f.path).join(", ").slice(0, 120)}`,
      });
      return results;
    });

    chunkResults = nested.flat();
    for (const r of chunkResults) {
      inputTokens += r.usage.input_tokens;
      outputTokens += r.usage.output_tokens;
      if (!r.error) calls += 1;
    }
  }

  emit({ type: "pr:stage", n, stage: "decide" });
  const aggregated = aggregateChunkAnswers(chunkResults);
  const decision = decide(gates, prAnswers, aggregated, sizeBucket, policy);

  const failedChunks = chunkResults.filter((r) => r.error);
  const coverage: "full" | "partial" =
    diffUnavailable || failedChunks.length > 0 ? "partial" : plan.coverage;

  if (error) {
    // The deterministic gates still stand; say plainly that Jev did not.
    decision.reasons.unshift({
      code: "jev_unavailable",
      text: `Jev was unavailable for the PR-level questions (${error}) — this decision comes from the gates alone`,
      source: "policy",
    });
    decision.explanation.unshift(
      `Jev was unavailable (${error}); the decision below comes from the deterministic gates alone.`,
    );
  }
  if (failedChunks.length > 0) {
    decision.reasons.push({
      code: "chunks_unevaluated",
      text: `${failedChunks.length} of ${chunkResults.length} diff chunk(s) could not be evaluated, so the code-level questions cover only part of the change`,
      source: "policy",
    });
  }

  const evaluation: Evaluation = {
    id: newId("ev"),
    prNumber: n,
    headSha: snapshot.headSha,
    evaluatedAt: new Date().toISOString(),
    mock,
    model: reportedModel,
    gates,
    prAnswers,
    chunks: chunkResults,
    coverage,
    skippedFiles: plan.skippedFiles,
    aggregated,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      calls,
      estCostUsd: Number(estCostUsd(inputTokens).toFixed(6)),
    },
    decision,
    policyVersion: policyVersion(policy),
    durationMs: Date.now() - started,
    ...(error ? { error } : {}),
  };

  appendEvaluation(evaluation);
  return evaluation;
}

export function isStale(snapshot: PrSnapshot, evaluation: Evaluation | null): boolean {
  if (!evaluation) return true;
  if (evaluation.headSha !== snapshot.headSha) return true;
  return evaluation.evaluatedAt < snapshot.updatedAt;
}

// --- scan runner ------------------------------------------------------------

const jobs = new Map<string, ScanJob>();
let runningJobId: string | null = null;

export function getJob(id: string): ScanJob | null {
  return jobs.get(id) ?? null;
}

export function runningJob(): ScanJob | null {
  return runningJobId ? (jobs.get(runningJobId) ?? null) : null;
}

export class ScanInProgressError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`a scan is already running (job ${jobId})`);
    this.name = "ScanInProgressError";
    this.jobId = jobId;
  }
}

export interface ScanOptions {
  force?: boolean;
  numbers?: number[];
}

/**
 * Starts the scan and returns immediately with the job record.
 *
 * Synchronous on purpose: the single-scan lock is claimed before any await, so
 * two POSTs that arrive in the same tick cannot both get past the check.
 */
export function startScan(opts: ScanOptions = {}): ScanJob {
  if (runningJobId) throw new ScanInProgressError(runningJobId);

  const job: ScanJob = {
    id: newId("scan"),
    startedAt: new Date().toISOString(),
    total: opts.numbers?.length ?? 0,
    done: 0,
    errors: [],
    status: "running",
  };
  jobs.set(job.id, job);
  runningJobId = job.id; // claimed before the first await

  void (async () => {
    const numbers = opts.numbers ?? (await listOpenPrNumbers());
    job.total = numbers.length;
    await runScan(job, numbers, opts.force === true);
  })()
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scan] job ${job.id} failed: ${message}`);
      job.errors.push({ n: 0, error: message });
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      delete job.current;
      emit({ type: "scan:done", jobId: job.id });
    })
    .finally(() => {
      runningJobId = null;
    });
  return job;
}

async function runScan(job: ScanJob, numbers: number[], force: boolean): Promise<void> {
  emit({ type: "scan:start", jobId: job.id, total: numbers.length });
  const policy = loadPolicy();

  for (const n of numbers) {
    job.current = n;
    try {
      const { snapshot } = await fetchSnapshot(n, { force });
      emit({ type: "pr:start", n, title: snapshot.title });

      if (!force && !isStale(snapshot, latestEvaluation(n))) {
        const existing = latestEvaluation(n);
        if (existing) {
          emit({ type: "pr:stage", n, stage: "decide", detail: "unchanged since last evaluation — skipped" });
          emit({ type: "pr:done", n, evaluation: existing });
          job.done += 1;
          continue;
        }
      }

      const evaluation = await evaluatePr(n, { force, policy });
      emit({ type: "pr:done", n, evaluation });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.errors.push({ n, error: message });
      emit({ type: "pr:error", n, error: message });
    }
    job.done += 1;
  }

  delete job.current;
  job.finishedAt = new Date().toISOString();
  job.status = job.errors.length === numbers.length && numbers.length > 0 ? "failed" : "done";
  emit({ type: "scan:done", jobId: job.id });
}

/** Synchronous variant for the CLI: runs to completion and returns evaluations. */
export async function scanSync(opts: ScanOptions = {}): Promise<{ job: ScanJob; evaluations: Evaluation[] }> {
  const numbers = opts.numbers ?? (await listOpenPrNumbers());
  const job: ScanJob = {
    id: newId("scan"),
    startedAt: new Date().toISOString(),
    total: numbers.length,
    done: 0,
    errors: [],
    status: "running",
  };
  const policy = loadPolicy();
  const evaluations: Evaluation[] = [];

  for (const n of numbers) {
    job.current = n;
    try {
      const { snapshot } = await fetchSnapshot(n, { force: opts.force === true });
      if (!opts.force) {
        const existing = latestEvaluation(n);
        if (existing && !isStale(snapshot, existing)) {
          evaluations.push(existing);
          job.done += 1;
          continue;
        }
      }
      evaluations.push(await evaluatePr(n, { force: opts.force === true, policy }));
    } catch (err) {
      job.errors.push({ n, error: err instanceof Error ? err.message : String(err) });
    }
    job.done += 1;
  }
  delete job.current;
  job.finishedAt = new Date().toISOString();
  job.status = "done";
  return { job, evaluations };
}
