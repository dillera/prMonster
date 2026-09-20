// GitHub REST v3 access (DESIGN.md §4.1) plus the three write functions the
// confirmed-action route may call.
//
// Token resolution: GITHUB_TOKEN, else `gh auth token` (spawned once), else
// unauthenticated with a warning (60 req/hr).
//
// Every write function refuses unless ALLOW_GITHUB_WRITES=1. That check is
// deliberately duplicated here and in the route: this module is the last place
// before the network, and it must not be possible to reach it by accident.

import { execFileSync } from "node:child_process";

import type { CheckRun, CiState, PrFile, PrSnapshot } from "../shared/types.js";
import { readSnapshotCache, writeSnapshotCache } from "./store.js";

export type GithubAuthMode = "token" | "gh" | "anon";

const API = "https://api.github.com";

let cachedToken: string | null | undefined;
let cachedMode: GithubAuthMode = "anon";

export function githubRepo(): { owner: string; repo: string; full: string } {
  const full = process.env["GITHUB_REPO"] ?? "FujiNetWIFI/fujinet-firmware";
  const [owner = "FujiNetWIFI", repo = "fujinet-firmware"] = full.split("/");
  return { owner, repo, full: `${owner}/${repo}` };
}

/** Resolve the token once per process. */
export function githubToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  const env = process.env["GITHUB_TOKEN"]?.trim();
  if (env) {
    cachedToken = env;
    cachedMode = "token";
    return cachedToken;
  }
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) {
      cachedToken = out;
      cachedMode = "gh";
      return cachedToken;
    }
  } catch {
    // gh missing or not logged in
  }
  console.warn("[github] no token (GITHUB_TOKEN unset, `gh auth token` unavailable) — 60 requests/hour");
  cachedToken = null;
  cachedMode = "anon";
  return null;
}

export function githubAuthMode(): GithubAuthMode {
  githubToken();
  return cachedMode;
}

/** Test seam. */
export function resetGithubAuthCache(): void {
  cachedToken = undefined;
  cachedMode = "anon";
}

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

interface RequestOptions {
  accept?: string;
  method?: "GET" | "POST";
  body?: unknown;
}

let lastRateLog = 0;

function logRateLimit(res: Response): void {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining === null) return;
  const now = Date.now();
  const n = Number(remaining);
  // Log every 30s, and always when we are running low.
  if (now - lastRateLog < 30_000 && n > 50) return;
  lastRateLog = now;
  const limit = res.headers.get("x-ratelimit-limit") ?? "?";
  const reset = res.headers.get("x-ratelimit-reset");
  const resetIn = reset ? Math.max(0, Math.round(Number(reset) - now / 1000)) : null;
  // stderr: `npm run eval` writes the Evaluation JSON to stdout.
  console.error(
    `[github] rate limit ${remaining}/${limit} remaining` +
      (resetIn === null ? "" : ` (resets in ${resetIn}s)`) +
      ` [auth: ${githubAuthMode()}]`,
  );
}

async function ghFetch(path: string, opts: RequestOptions = {}): Promise<Response> {
  const token = githubToken();
  const headers: Record<string, string> = {
    Accept: opts.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fujinet-pr-harness",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  logRateLimit(res);
  return res;
}

async function ghJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await ghFetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubError(res.status, `GitHub ${res.status} for ${path}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Follow `Link: <...>; rel="next"` until exhausted. */
async function ghJsonPaged<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  let guard = 0;
  while (next && guard++ < 30) {
    const res: Response = await ghFetch(next);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GithubError(res.status, `GitHub ${res.status} for ${next}: ${text.slice(0, 300)}`);
    }
    out.push(...((await res.json()) as T[]));
    next = parseNextLink(res.headers.get("link"));
  }
  return out;
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

// --- raw API shapes we care about -------------------------------------------

interface ApiPr {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  author_association: string;
  html_url: string;
  draft?: boolean;
  state: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  review_comments?: number;
}

interface ApiFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
  /** Per-file hunks. Absent for binary files and for files GitHub deems too large. */
  patch?: string;
}

interface ApiCheckRuns {
  check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url?: string }>;
}

interface ApiReview {
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
}

// --- reads ------------------------------------------------------------------

export async function listOpenPrNumbers(): Promise<number[]> {
  const { full } = githubRepo();
  const prs = await ghJsonPaged<ApiPr>(`/repos/${full}/pulls?state=open&per_page=100`);
  return prs.map((p) => p.number).sort((a, b) => b - a);
}

export async function getPr(n: number): Promise<ApiPr> {
  const { full } = githubRepo();
  return ghJson<ApiPr>(`/repos/${full}/pulls/${n}`);
}

async function fetchPrFilesRaw(n: number): Promise<ApiFile[]> {
  const { full } = githubRepo();
  return ghJsonPaged<ApiFile>(`/repos/${full}/pulls/${n}/files?per_page=100`);
}

function toPrFiles(files: ApiFile[]): PrFile[] {
  return files.map((f) => {
    const status: PrFile["status"] =
      f.status === "added" || f.status === "removed" || f.status === "renamed" ? f.status : "modified";
    const out: PrFile = { path: f.filename, status, additions: f.additions, deletions: f.deletions };
    if (f.previous_filename) out.previousPath = f.previous_filename;
    return out;
  });
}

export async function getPrFiles(n: number): Promise<PrFile[]> {
  return toPrFiles(await fetchPrFilesRaw(n));
}

/**
 * Rebuild a unified diff from the per-file `patch` fields of /pulls/{n}/files.
 * GitHub refuses the whole-PR `.diff` above its own size limit (406
 * `too_large`), but the file listing still carries each file's hunks — except
 * for binaries and individual files it also considers too large, which are
 * simply absent. Returns null when nothing usable came back.
 */
export function diffFromFilePatches(files: ApiFile[]): string | null {
  const parts: string[] = [];
  for (const f of files) {
    if (!f.patch) continue;
    const newPath = f.filename;
    const oldPath = f.previous_filename ?? f.filename;
    const header = [`diff --git a/${oldPath} b/${newPath}`];
    if (f.status === "added") header.push("new file mode 100644", "--- /dev/null", `+++ b/${newPath}`);
    else if (f.status === "removed") header.push("deleted file mode 100644", `--- a/${oldPath}`, "+++ /dev/null");
    else {
      if (f.previous_filename) header.push(`rename from ${oldPath}`, `rename to ${newPath}`);
      header.push(`--- a/${oldPath}`, `+++ b/${newPath}`);
    }
    parts.push(`${header.join("\n")}\n${f.patch}\n`);
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * Unified diff text, or **null** when it could not be obtained at all.
 *
 * Null is load-bearing: an empty string would let the added-line gates pass
 * vacuously and the chunker report full coverage of nothing, so callers must
 * treat null as "the diff is unknown" rather than "the diff is empty".
 *
 * `rawFiles` (the already-fetched /files listing) lets the 406 fallback reuse
 * one request instead of paging the listing twice.
 */
export async function getPrDiff(n: number, rawFiles?: ApiFile[]): Promise<string | null> {
  const { full } = githubRepo();
  const res = await ghFetch(`/repos/${full}/pulls/${n}`, { accept: "application/vnd.github.v3.diff" });
  if (res.ok) return res.text();

  console.warn(`[github] whole-PR diff for #${n} refused (${res.status}) — rebuilding from per-file patches`);
  try {
    const files = rawFiles ?? (await fetchPrFilesRaw(n));
    const rebuilt = diffFromFilePatches(files);
    if (rebuilt) {
      const missing = files.filter((f) => !f.patch).length;
      console.warn(
        `[github] #${n}: rebuilt diff from ${files.length - missing}/${files.length} file patches` +
          (missing > 0 ? ` (${missing} binary or too-large file(s) have no patch)` : ""),
      );
      return rebuilt;
    }
  } catch (err) {
    console.warn(`[github] #${n}: per-file patch fallback failed: ${(err as Error).message}`);
  }
  console.warn(`[github] diff for #${n} is unavailable — the evaluation will be marked partial`);
  return null;
}

export async function getCheckRuns(sha: string): Promise<CheckRun[]> {
  const { full } = githubRepo();
  try {
    const data = await ghJson<ApiCheckRuns>(`/repos/${full}/commits/${sha}/check-runs?per_page=100`);
    return data.check_runs.map((c) => {
      const out: CheckRun = { name: c.name, status: c.status, conclusion: c.conclusion };
      if (c.html_url) out.url = c.html_url;
      return out;
    });
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return [];
    throw err;
  }
}

export async function getReviews(n: number): Promise<ApiReview[]> {
  const { full } = githubRepo();
  return ghJsonPaged<ApiReview>(`/repos/${full}/pulls/${n}/reviews?per_page=100`);
}

export async function getIssueCommentCount(n: number): Promise<number> {
  const { full } = githubRepo();
  const items = await ghJsonPaged<unknown>(`/repos/${full}/issues/${n}/comments?per_page=100`);
  return items.length;
}

export async function getReviewCommentCount(n: number): Promise<number> {
  const { full } = githubRepo();
  const items = await ghJsonPaged<unknown>(`/repos/${full}/pulls/${n}/comments?per_page=100`);
  return items.length;
}

export async function listRepoLabels(): Promise<string[]> {
  const { full } = githubRepo();
  try {
    const labels = await ghJsonPaged<{ name: string }>(`/repos/${full}/labels?per_page=100`);
    return labels.map((l) => l.name);
  } catch (err) {
    console.warn(`[github] could not list labels: ${(err as Error).message}`);
    return [];
  }
}

export function ciStateFrom(checks: CheckRun[]): CiState {
  if (checks.length === 0) return "none";
  // Mirrors gates.ts: action_required is a maintainer approval prompt, so it
  // reads as pending rather than red.
  const bad = new Set(["failure", "timed_out", "cancelled", "stale"]);
  if (checks.some((c) => c.conclusion !== null && bad.has(c.conclusion))) return "red";
  if (checks.some((c) => c.status !== "completed" || c.conclusion === null || c.conclusion === "action_required")) {
    return "pending";
  }
  return "green";
}

/**
 * A closed pull request is still readable, and anything we already evaluated
 * must stay reachable, so the real state travels with the snapshot.
 */
function prState(pr: ApiPr & { merged_at?: string | null }): PrSnapshot["state"] {
  if (pr.merged_at) return "merged";
  return pr.state === "closed" ? "closed" : "open";
}

export interface SnapshotResult {
  snapshot: PrSnapshot;
  /** null when GitHub would not give us the diff at all — never treat as empty. */
  diff: string | null;
  fromCache: boolean;
}

/**
 * Assemble a PrSnapshot plus its diff. Cached on disk as
 * data/cache/<n>-<headSha>.json; a cache hit still requires the cheap
 * `GET /pulls/{n}` that tells us the head SHA and updated_at.
 */
export async function fetchSnapshot(n: number, opts: { force?: boolean } = {}): Promise<SnapshotResult> {
  const pr = await getPr(n);
  const headSha = pr.head.sha;

  if (!opts.force) {
    const cached = readSnapshotCache(n, headSha);
    if (cached && cached.updatedAt === pr.updated_at && typeof (cached as { diff?: string }).diff === "string") {
      const { diff, ...snapshot } = cached as PrSnapshot & { diff: string };
      // The cache holds the expensive parts (files, diff, checks). The cheap PR
      // detail we just fetched is authoritative for the volatile fields, and a
      // cache entry written by an older build may not even have the right shape.
      return {
        snapshot: {
          ...snapshot,
          state: prState(pr),
          draft: pr.draft === true,
          mergeable: pr.mergeable ?? null,
          mergeableState: pr.mergeable_state ?? "unknown",
        },
        diff,
        fromCache: true,
      };
    }
  }

  // The file listing is fetched first so the diff's 406 fallback can reuse it.
  const rawFiles = await fetchPrFilesRaw(n);
  const files = toPrFiles(rawFiles);
  const [diff, checks, reviews, issueComments, reviewComments] = await Promise.all([
    getPrDiff(n, rawFiles),
    getCheckRuns(headSha),
    getReviews(n),
    getIssueCommentCount(n),
    getReviewCommentCount(n),
  ]);

  const latestReviewStates: Record<string, string> = {};
  for (const r of [...reviews].sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""))) {
    const who = r.user?.login;
    if (!who) continue;
    if (r.state === "COMMENTED") continue; // does not change a reviewer's standing verdict
    latestReviewStates[who] = r.state;
  }

  const snapshot: PrSnapshot = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? "unknown",
    authorAssociation: pr.author_association,
    url: pr.html_url,
    draft: pr.draft === true,
    state: prState(pr),
    base: pr.base.ref,
    headRef: pr.head.ref,
    headSha,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    labels: pr.labels.map((l) => l.name),
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? "unknown",
    additions: pr.additions ?? files.reduce((a, f) => a + f.additions, 0),
    deletions: pr.deletions ?? files.reduce((a, f) => a + f.deletions, 0),
    changedFiles: pr.changed_files ?? files.length,
    files,
    checks,
    ci: ciStateFrom(checks),
    reviewCount: reviews.length + reviewComments,
    commentCount: issueComments,
    latestReviewStates,
    diffBytes: diff === null ? 0 : Buffer.byteLength(diff, "utf8"),
    fetchedAt: new Date().toISOString(),
  };

  // Never cache a snapshot whose diff we failed to get: a later run would take
  // the cache hit and keep evaluating the PR as though it had no changes.
  if (diff !== null) writeSnapshotCache({ ...snapshot, diff } as PrSnapshot);
  return { snapshot, diff, fromCache: false };
}

// --- writes (human-confirmed actions only) ----------------------------------

export function writesEnabled(): boolean {
  return process.env["ALLOW_GITHUB_WRITES"] === "1";
}

function assertWritesEnabled(what: string): void {
  if (!writesEnabled()) {
    throw new Error(`refused: ALLOW_GITHUB_WRITES is not 1, so ${what} was not sent to GitHub`);
  }
}

export interface WriteResult {
  url: string;
}

export async function createIssueComment(n: number, body: string): Promise<WriteResult> {
  assertWritesEnabled(`a comment on #${n}`);
  const { full } = githubRepo();
  const res = await ghJson<{ html_url: string }>(`/repos/${full}/issues/${n}/comments`, {
    method: "POST",
    body: { body },
  });
  return { url: res.html_url };
}

export async function createReview(
  n: number,
  review: { event: "REQUEST_CHANGES" | "APPROVE"; body: string },
): Promise<WriteResult> {
  assertWritesEnabled(`a ${review.event} review on #${n}`);
  const { full } = githubRepo();
  const res = await ghJson<{ html_url?: string; pull_request_url?: string }>(
    `/repos/${full}/pulls/${n}/reviews`,
    { method: "POST", body: { event: review.event, body: review.body } },
  );
  return { url: res.html_url ?? res.pull_request_url ?? `https://github.com/${full}/pull/${n}` };
}

export async function addLabels(n: number, labels: string[]): Promise<WriteResult> {
  assertWritesEnabled(`labels on #${n}`);
  const { full } = githubRepo();
  await ghJson<unknown>(`/repos/${full}/issues/${n}/labels`, { method: "POST", body: { labels } });
  return { url: `https://github.com/${full}/pull/${n}` };
}

// --- light listing (used by /api/prs so the dashboard costs one API call) ----

export interface OpenPrRef {
  number: number;
  title: string;
  headSha: string;
  updatedAt: string;
}

export async function listOpenPrs(): Promise<OpenPrRef[]> {
  const { full } = githubRepo();
  const prs = await ghJsonPaged<ApiPr>(`/repos/${full}/pulls?state=open&per_page=100`);
  return prs
    .map((p) => ({ number: p.number, title: p.title, headSha: p.head.sha, updatedAt: p.updated_at }))
    .sort((a, b) => b.number - a.number);
}

/** A cached snapshot for this exact head SHA and updated_at, or null. */
export function cachedSnapshot(n: number, headSha: string, updatedAt: string): PrSnapshot | null {
  const cached = readSnapshotCache(n, headSha);
  if (!cached || cached.updatedAt !== updatedAt) return null;
  const { diff: _diff, ...snapshot } = cached as PrSnapshot & { diff?: string };
  void _diff;
  return snapshot;
}

// --- richer reads for the dossier (DESIGN-deep.md) --------------------------

export interface PrCommit {
  sha: string;
  date: string;
  author: string;
  subject: string;
  message: string;
  url: string;
}

interface ApiCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
    committer: { date?: string } | null;
  };
  author: { login?: string } | null;
}

export async function getPrCommits(n: number): Promise<PrCommit[]> {
  const { full } = githubRepo();
  const commits = await ghJsonPaged<ApiCommit>(`/repos/${full}/pulls/${n}/commits?per_page=100`);
  return commits.map((c) => ({
    sha: c.sha,
    date: c.commit.committer?.date ?? c.commit.author?.date ?? "",
    author: c.author?.login ?? c.commit.author?.name ?? "unknown",
    subject: (c.commit.message ?? "").split("\n")[0] ?? "",
    message: c.commit.message ?? "",
    url: c.html_url,
  }));
}

export interface CommentEntry {
  author: string;
  association: string;
  at: string;
  body: string;
  url: string;
  path?: string;
  line?: number;
  state?: string;
}

interface ApiComment {
  user: { login?: string } | null;
  author_association?: string;
  created_at?: string;
  submitted_at?: string;
  body?: string | null;
  html_url?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  state?: string;
}

function toComment(c: ApiComment): CommentEntry {
  const out: CommentEntry = {
    author: c.user?.login ?? "unknown",
    association: c.author_association ?? "NONE",
    at: c.created_at ?? c.submitted_at ?? "",
    body: c.body ?? "",
    url: c.html_url ?? "",
  };
  if (c.path) out.path = c.path;
  const line = c.line ?? c.original_line;
  if (typeof line === "number") out.line = line;
  if (c.state) out.state = c.state;
  return out;
}

export async function getIssueComments(n: number): Promise<CommentEntry[]> {
  const { full } = githubRepo();
  return (await ghJsonPaged<ApiComment>(`/repos/${full}/issues/${n}/comments?per_page=100`)).map(toComment);
}

export async function getReviewComments(n: number): Promise<CommentEntry[]> {
  const { full } = githubRepo();
  return (await ghJsonPaged<ApiComment>(`/repos/${full}/pulls/${n}/comments?per_page=100`)).map(toComment);
}

export async function getReviewsDetailed(n: number): Promise<CommentEntry[]> {
  const { full } = githubRepo();
  return (await ghJsonPaged<ApiComment>(`/repos/${full}/pulls/${n}/reviews?per_page=100`)).map(toComment);
}

/** PRs associated with a commit — the fallback when a subject carries no `(#N)`. */
export async function getCommitPulls(sha: string): Promise<number[]> {
  const { full } = githubRepo();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return [];
  try {
    const pulls = await ghJson<Array<{ number: number }>>(`/repos/${full}/commits/${sha}/pulls?per_page=10`, {
      accept: "application/vnd.github+json",
    });
    return pulls.map((p) => p.number);
  } catch {
    return [];
  }
}

export interface PrSummary {
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  mergedAt: string | null;
  files?: string[];
}

export async function getPrSummary(n: number, withFiles = false): Promise<PrSummary | null> {
  const { full } = githubRepo();
  try {
    const pr = await ghJson<ApiPr & { merged_at?: string | null }>(`/repos/${full}/pulls/${n}`);
    const out: PrSummary = {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      url: pr.html_url,
      mergedAt: pr.merged_at ?? null,
    };
    if (withFiles) out.files = (await getPrFiles(n)).map((f) => f.path);
    return out;
  } catch {
    return null;
  }
}

/** The base commit the PR is measured against. */
export async function getPrBaseSha(n: number): Promise<{ baseSha: string; baseRef: string; headSha: string }> {
  const pr = await getPr(n);
  return { baseSha: pr.base.sha, baseRef: pr.base.ref, headSha: pr.head.sha };
}
