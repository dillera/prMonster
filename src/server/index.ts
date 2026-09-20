// Hono app: every route in DESIGN.md §5.
//
// NodeNext resolution: relative imports need an explicit ".js" extension.
import "dotenv/config";

import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { ActionKind, ActionRecord, Evaluation, PrListItem, PrSnapshot } from "../shared/types.js";
import { decide } from "./decide.js";
import { recentEvents, sseFrame, subscribe } from "./events.js";
import { sizeBucketFromGates } from "./gates.js";
import {
  addLabels,
  cachedSnapshot,
  createIssueComment,
  createReview,
  fetchSnapshot,
  githubAuthMode,
  githubRepo,
  listOpenPrs,
  listRepoLabels,
  writesEnabled,
} from "./github.js";
import { mapWithConcurrency } from "./jev.js";
import { MOCK_MODEL } from "./mock.js";
import {
  evaluatePr,
  getJob,
  isStale,
  jevMode,
  jevModel,
  runningJob,
  ScanInProgressError,
  startScan,
} from "./pipeline.js";
import { buildProposal, proposalId, signBody } from "./proposals.js";
import {
  appendAction,
  ensureDataDir,
  evaluationById,
  evaluationsFor,
  latestEvaluation,
  latestEvaluationsByPr,
  loadPolicy,
  newId,
  PROJECT_ROOT,
  readActions,
  readEvaluations,
  savePolicy,
  setTriage,
  triageFor,
  validatePolicy,
} from "./store.js";

const webDist = resolve(PROJECT_ROOT, "dist/web");

export const app = new Hono();

ensureDataDir();

// --- health -----------------------------------------------------------------

app.get("/api/health", (c) => {
  const policy = loadPolicy();
  const mode = jevMode();
  return c.json({
    ok: true,
    jev: mode,
    model: mode === "mock" ? MOCK_MODEL : jevModel(policy),
    repo: githubRepo().full,
    githubAuth: githubAuthMode(),
    writesEnabled: writesEnabled(),
  });
});

// --- PR listing -------------------------------------------------------------

async function snapshotFor(ref: { number: number; headSha: string; updatedAt: string }): Promise<PrSnapshot> {
  const cached = cachedSnapshot(ref.number, ref.headSha, ref.updatedAt);
  if (cached) return cached;
  const { snapshot } = await fetchSnapshot(ref.number);
  return snapshot;
}

/** Enough of a PrSnapshot for the UI to draw a row when the real fetch failed. */
function placeholderSnapshot(ref: { number: number; title: string; headSha: string; updatedAt: string }): PrSnapshot {
  const { full } = githubRepo();
  return {
    number: ref.number,
    title: ref.title,
    body: "",
    author: "unknown",
    authorAssociation: "NONE",
    url: `https://github.com/${full}/pull/${ref.number}`,
    draft: false,
    state: "open",
    base: "master",
    headRef: "",
    headSha: ref.headSha,
    createdAt: ref.updatedAt,
    updatedAt: ref.updatedAt,
    labels: [],
    mergeable: null,
    mergeableState: "unknown",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    files: [],
    checks: [],
    ci: "none",
    reviewCount: 0,
    commentCount: 0,
    latestReviewStates: {},
    diffBytes: 0,
    fetchedAt: new Date().toISOString(),
  };
}

app.get("/api/prs", async (c) => {
  let refs;
  try {
    refs = await listOpenPrs();
  } catch (err) {
    // Only the listing itself is fatal — without it there is nothing to show.
    return c.json({ error: (err as Error).message }, 502);
  }
  const latest = latestEvaluationsByPr();
  // Per item: one PR GitHub will not serve must not cost the whole dashboard.
  const items = await mapWithConcurrency(refs, 4, async (ref): Promise<PrListItem> => {
    const evaluation = latest.get(ref.number) ?? null;
    const triage = triageFor(ref.number);
    try {
      const snapshot = await snapshotFor(ref);
      return { snapshot, evaluation, stale: isStale(snapshot, evaluation), triage };
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[server] /api/prs: #${ref.number} could not be fetched: ${message}`);
      return {
        snapshot: placeholderSnapshot(ref),
        evaluation,
        stale: true,
        triage,
        fetchError: message,
      };
    }
  });
  return c.json(items);
});

function prNumberOf(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

app.get("/api/prs/:n", async (c) => {
  const n = prNumberOf(c.req.param("n"));
  if (n === null) return c.json({ error: "pr number must be a positive integer" }, 400);
  try {
    const { snapshot } = await fetchSnapshot(n);
    return c.json({ snapshot, evaluation: latestEvaluation(n) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

// --- scanning ---------------------------------------------------------------

app.post("/api/scan", async (c) => {
  let body: { force?: unknown; numbers?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  let numbers: number[] | undefined;
  if (body.numbers !== undefined) {
    if (!Array.isArray(body.numbers) || body.numbers.some((x) => !Number.isInteger(x))) {
      return c.json({ error: "numbers must be an array of integers" }, 400);
    }
    numbers = body.numbers as number[];
  }
  try {
    const job = await startScan({
      force: body.force === true,
      ...(numbers ? { numbers } : {}),
    });
    return c.json({ jobId: job.id, job });
  } catch (err) {
    if (err instanceof ScanInProgressError) {
      return c.json({ error: err.message, jobId: err.jobId }, 409);
    }
    return c.json({ error: (err as Error).message }, 502);
  }
});

app.get("/api/scan/:jobId", (c) => {
  const job = getJob(c.req.param("jobId"));
  if (!job) return c.json({ error: "no such scan job" }, 404);
  return c.json(job);
});

app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    const queue: string[] = [];
    for (const e of recentEvents()) queue.push(sseFrame(e));
    const unsubscribe = subscribe((event) => {
      queue.push(sseFrame(event));
    });
    stream.onAbort(() => {
      open = false;
      unsubscribe();
    });
    await stream.write(": connected\n\n");
    while (open) {
      const frame = queue.shift();
      if (frame !== undefined) {
        await stream.write(frame);
      } else {
        await stream.write(": keepalive\n\n");
        await stream.sleep(1000);
      }
    }
    unsubscribe();
  }),
);

// --- policy and re-deciding --------------------------------------------------

app.get("/api/policy", (c) => c.json(loadPolicy()));

app.put("/api/policy", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  try {
    return c.json(savePolicy(validatePolicy(raw)));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/decide", async (c) => {
  let raw: { evaluationId?: unknown; policy?: unknown };
  try {
    raw = (await c.req.json()) as typeof raw;
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  if (typeof raw.evaluationId !== "string") {
    return c.json({ error: "evaluationId is required" }, 400);
  }
  const evaluation = evaluationById(raw.evaluationId);
  if (!evaluation) return c.json({ error: "no such evaluation" }, 404);
  let policy;
  try {
    policy = raw.policy === undefined ? loadPolicy() : validatePolicy(raw.policy);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  const decision = decide(
    evaluation.gates,
    evaluation.prAnswers,
    evaluation.aggregated,
    sizeBucketFromGates(evaluation.gates),
    policy,
  );
  return c.json(decision);
});

// --- evaluations and stats ---------------------------------------------------

app.get("/api/evaluations", (c) => {
  const nRaw = c.req.query("n");
  if (nRaw === undefined) {
    return c.json(readEvaluations().sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt)));
  }
  const n = prNumberOf(nRaw);
  if (n === null) return c.json({ error: "n must be a positive integer" }, 400);
  return c.json(evaluationsFor(n));
});

app.get("/api/stats", async (c) => {
  const all = readEvaluations();
  const latest = latestEvaluationsByPr();
  let openNumbers: number[];
  try {
    openNumbers = (await listOpenPrs()).map((p) => p.number);
  } catch {
    openNumbers = [...latest.keys()];
  }
  const counts = { READY: 0, NEEDS_REVIEW: 0, BLOCKED: 0, UNEVALUATED: 0 };
  for (const n of openNumbers) {
    const e = latest.get(n);
    if (!e) counts.UNEVALUATED += 1;
    else counts[e.decision.kind] += 1;
  }
  const tokensUsed = all.reduce((a, e) => a + e.usage.input_tokens, 0);
  const estCostUsd = Number(all.reduce((a, e) => a + e.usage.estCostUsd, 0).toFixed(6));
  const lastScanAt = all.reduce<string | null>(
    (acc, e) => (acc === null || e.evaluatedAt > acc ? e.evaluatedAt : acc),
    null,
  );
  return c.json({ counts, tokensUsed, estCostUsd, lastScanAt, running: runningJob() });
});

// --- proposals and confirmed actions ------------------------------------------

app.get("/api/prs/:n/proposal", async (c) => {
  const n = prNumberOf(c.req.param("n"));
  if (n === null) return c.json({ error: "pr number must be a positive integer" }, 400);
  const evaluation = latestEvaluation(n);
  if (!evaluation) return c.json({ error: `PR #${n} has no evaluation yet — run a scan first` }, 404);
  try {
    const { snapshot } = await fetchSnapshot(n);
    const repoLabels = await listRepoLabels();
    return c.json(buildProposal({ snapshot, evaluation, repoLabels }));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

const ACTION_KINDS: ActionKind[] = ["comment", "review_request_changes", "review_approve", "labels"];

app.post("/api/prs/:n/actions", async (c) => {
  const n = prNumberOf(c.req.param("n"));
  if (n === null) return c.json({ error: "pr number must be a positive integer" }, 400);

  let raw: {
    proposalId?: unknown;
    kind?: unknown;
    body?: unknown;
    labels?: unknown;
    confirmedBy?: unknown;
    confirmText?: unknown;
  };
  try {
    raw = (await c.req.json()) as typeof raw;
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }

  if (typeof raw.proposalId !== "string" || raw.proposalId.length === 0) {
    return c.json({ error: "proposalId is required" }, 400);
  }
  if (typeof raw.kind !== "string" || !ACTION_KINDS.includes(raw.kind as ActionKind)) {
    return c.json({ error: `kind must be one of ${ACTION_KINDS.join(", ")}` }, 400);
  }
  if (typeof raw.confirmedBy !== "string" || raw.confirmedBy.trim().length === 0) {
    return c.json({ error: "confirmedBy is required" }, 400);
  }
  const proposalIdIn = raw.proposalId;
  const kind = raw.kind as ActionKind;
  const confirmedBy = raw.confirmedBy.trim();

  const evaluation = latestEvaluation(n);
  const headSha = evaluation?.headSha ?? "unknown";

  const record = (outcome: ActionRecord["outcome"], extra: Partial<ActionRecord> = {}): ActionRecord =>
    appendAction({
      id: newId("act"),
      prNumber: n,
      headSha,
      proposalId: proposalIdIn,
      kind,
      confirmedBy,
      requestedAt: new Date().toISOString(),
      outcome,
      ...extra,
    });

  if (!evaluation) {
    return c.json(record("refused_stale", { error: `PR #${n} has no evaluation` }), 409);
  }

  // Staleness is checked first, and against the LIVE head: an evaluation that
  // merely agrees with the proposal proves nothing if the author has pushed
  // since. All three must agree — proposal, evaluation, and GitHub right now.
  if (proposalIdIn !== proposalId(n, evaluation.headSha, evaluation.id)) {
    return c.json(
      record("refused_stale", {
        error: `proposal does not match the latest evaluation of #${n} (expected the proposal generated for evaluation ${evaluation.id} at ${evaluation.headSha})`,
      }),
      409,
    );
  }
  let liveSnapshot: PrSnapshot;
  try {
    liveSnapshot = (await fetchSnapshot(n, { force: true })).snapshot;
  } catch (err) {
    return c.json(record("failed", { error: `could not confirm the live head SHA: ${(err as Error).message}` }), 502);
  }
  if (liveSnapshot.headSha !== evaluation.headSha) {
    return c.json(
      record("refused_stale", {
        error: `#${n} has moved on: GitHub's head is ${liveSnapshot.headSha}, the evaluation is for ${evaluation.headSha}. Re-evaluate before acting.`,
      }),
      409,
    );
  }

  if (raw.confirmText !== "CONFIRM") {
    return c.json(record("refused_bad_confirm", { error: 'confirmText must be exactly "CONFIRM"' }), 400);
  }

  // Body/labels: the human may have edited the draft in the UI.
  let body: string | null = typeof raw.body === "string" && raw.body.trim().length > 0 ? raw.body : null;
  let labels: string[] | undefined;
  if (Array.isArray(raw.labels) && raw.labels.every((l) => typeof l === "string")) {
    labels = raw.labels as string[];
  }

  if (body === null || labels === undefined) {
    try {
      const proposal = buildProposal({ snapshot: liveSnapshot, evaluation, repoLabels: await listRepoLabels() });
      if (body === null) body = proposal.body;
      if (labels === undefined) labels = proposal.labels ?? [];
    } catch (err) {
      return c.json(record("failed", { error: (err as Error).message }), 502);
    }
  }
  const signed = signBody(body, confirmedBy);

  if (kind === "labels" && (labels === undefined || labels.length === 0)) {
    return c.json(
      record("refused_bad_confirm", {
        error:
          "no labels to apply — the triage labels do not exist in this repository and the harness never creates labels",
      }),
      400,
    );
  }

  if (!writesEnabled()) {
    return c.json(
      record("refused_writes_disabled", {
        ...(kind === "labels" ? { labels } : { body: signed }),
        error:
          "ALLOW_GITHUB_WRITES is not 1, so nothing was written to GitHub. The attempt is recorded in the audit log.",
      }),
      403,
    );
  }

  try {
    let url: string;
    if (kind === "comment") {
      url = (await createIssueComment(n, signed)).url;
    } else if (kind === "review_request_changes") {
      url = (await createReview(n, { event: "REQUEST_CHANGES", body: signed })).url;
    } else if (kind === "review_approve") {
      url = (await createReview(n, { event: "APPROVE", body: signed })).url;
    } else {
      url = (await addLabels(n, labels ?? [])).url;
    }
    return c.json(
      record("posted", { ...(kind === "labels" ? { labels } : { body: signed }), githubUrl: url }),
      201,
    );
  } catch (err) {
    return c.json(
      record("failed", { ...(kind === "labels" ? { labels } : { body: signed }), error: (err as Error).message }),
      502,
    );
  }
});

app.get("/api/actions", (c) => {
  const nRaw = c.req.query("n");
  const all = readActions().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  if (nRaw === undefined) return c.json(all);
  const n = prNumberOf(nRaw);
  if (n === null) return c.json({ error: "n must be a positive integer" }, 400);
  return c.json(all.filter((a) => a.prNumber === n));
});

// --- local triage state -------------------------------------------------------

app.post("/api/prs/:n/triage", async (c) => {
  const n = prNumberOf(c.req.param("n"));
  if (n === null) return c.json({ error: "pr number must be a positive integer" }, 400);
  let raw: { status?: unknown; note?: unknown; by?: unknown };
  try {
    raw = (await c.req.json()) as typeof raw;
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  const allowed = ["triaged", "snoozed", "untriaged"];
  if (typeof raw.status !== "string" || !allowed.includes(raw.status)) {
    return c.json({ error: `status must be one of ${allowed.join(", ")}` }, 400);
  }
  const state = setTriage({
    prNumber: n,
    status: raw.status as "triaged" | "snoozed" | "untriaged",
    ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    ...(typeof raw.by === "string" ? { by: raw.by } : {}),
    updatedAt: new Date().toISOString(),
  });
  return c.json(state);
});

// --- manual re-evaluation of one PR ------------------------------------------

app.post("/api/prs/:n/evaluate", async (c) => {
  const n = prNumberOf(c.req.param("n"));
  if (n === null) return c.json({ error: "pr number must be a positive integer" }, 400);
  const running = runningJob();
  if (running) return c.json({ error: "a scan is running", jobId: running.id }, 409);
  try {
    const evaluation: Evaluation = await evaluatePr(n, { force: c.req.query("force") === "1" });
    return c.json(evaluation);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

app.all("/api/*", (c) => c.json({ error: `no such endpoint: ${c.req.path}` }, 404));

// --- static client ------------------------------------------------------------

// serveStatic resolves `root` against process.cwd(), so pass a cwd-relative path.
if (existsSync(webDist)) {
  const rel = relative(process.cwd(), webDist) || ".";
  if (rel.startsWith("..")) {
    console.warn(`[server] dist/web is outside cwd (${rel}); start the server from the project root to serve it`);
  } else {
    app.use("/*", serveStatic({ root: `./${rel}` }));
    // SPA fallback: any non-/api path that matched no file gets index.html.
    app.get("*", serveStatic({ path: `./${rel}/index.html` }));
  }
}

const port = Number(process.env["PORT"] ?? 8787);

// Guard so importing the app in tests does not open a socket.
if (process.env["NODE_ENV"] !== "test" && process.env["VITEST"] !== "true") {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`);
    console.log(`[server] repo ${githubRepo().full}, github auth ${githubAuthMode()}, jev ${jevMode()}`);
    if (jevMode() === "mock") {
      console.log("[server] Jev key missing or JEV_MOCK=1 — evaluations use deterministic mock answers");
    }
    if (!writesEnabled()) {
      console.log("[server] ALLOW_GITHUB_WRITES is not 1 — confirmed actions will be refused and logged");
    }
    if (!existsSync(webDist)) {
      console.log("[server] dist/web not built — API only (run `npm run dev:web`)");
    }
  });
}
