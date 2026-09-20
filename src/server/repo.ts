// Local partial clone and every git read the dossier and the deep-analysis
// tools make (DESIGN-deep.md "Local checkout").
//
// Rules this module exists to enforce:
//   * one place that runs git, always execFile with fixed argv, never a shell;
//   * every path and every rev is validated before it reaches that argv;
//   * every output is capped, every call has a timeout.
//
// The model in deep.ts drives some of these calls with arguments it chose, so
// "the guards are in one place and cannot be bypassed" is the whole design.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { PROJECT_ROOT } from "./store.js";

const execFileAsync = promisify(execFile);

export const REPO_DIR = resolve(PROJECT_ROOT, "data/repo");
export const GIT_TIMEOUT_MS = 60_000;
/** Bytes of stdout we will hold for any one git call. */
export const MAX_BUFFER = 24 * 1024 * 1024;

export function repoUrl(): string {
  const full = process.env["GITHUB_REPO"] ?? "FujiNetWIFI/fujinet-firmware";
  return `https://github.com/${full}.git`;
}

export class GitError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.name = "GitError";
    this.stderr = stderr;
  }
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

// --- guards -----------------------------------------------------------------

/**
 * Revisions we will pass to git: a hex object id, one of our PR refs, or
 * origin/master.
 *
 * DESIGN-deep.md proposes `refs/pr/<n>/prev` for the previous head, but git
 * cannot hold both `refs/pr/1650` (a file) and `refs/pr/1650/prev` (a
 * directory) — the fetch fails with "cannot lock ref". The previous head lives
 * at `refs/prev/<n>` instead; the documented spelling stays accepted here so
 * nothing that learned it breaks.
 */
export const REV_RE = /^[0-9a-f]{7,40}$|^refs\/pr\/\d+(\/prev)?$|^refs\/prev\/\d+$|^origin\/master$/;

/** The ref holding the previous head of PR `n`. */
export function prevRef(n: number): string {
  return `refs/prev/${n}`;
}

/** The ref holding the current head of PR `n`. */
export function prRef(n: number): string {
  return `refs/pr/${n}`;
}

export function assertRev(rev: string): string {
  if (typeof rev !== "string" || !REV_RE.test(rev)) {
    throw new GuardError(`not an allowed revision: ${JSON.stringify(rev)}`);
  }
  return rev;
}

/**
 * Syntactic path check. Rejects absolute paths, parent traversal, NUL, leading
 * dashes (which git would read as options) and anything outside the tree.
 * `assertPathInTree` additionally proves the path exists at that rev.
 */
export function assertPathShape(path: string): string {
  if (typeof path !== "string" || path.length === 0) throw new GuardError("path is required");
  if (path.length > 1024) throw new GuardError("path is too long");
  if (path.includes("\0")) throw new GuardError("path contains NUL");
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) throw new GuardError(`absolute path rejected: ${path}`);
  if (path.startsWith("-")) throw new GuardError(`path may not start with "-": ${path}`);
  const parts = path.split("/");
  if (parts.some((p) => p === ".." || p === ".")) throw new GuardError(`path traversal rejected: ${path}`);
  return path;
}

function assertLineRange(start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new GuardError(`bad line range ${start},${end}`);
  }
  if (end - start > 20_000) throw new GuardError("line range is too wide");
}

function clampMax(max: number | undefined, dflt: number, hard: number): number {
  const n = typeof max === "number" && Number.isFinite(max) ? Math.floor(max) : dflt;
  return Math.max(1, Math.min(hard, n));
}

// --- the single exec seam ---------------------------------------------------

export interface GitRunner {
  (args: string[], opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
}

let runner: GitRunner = async (args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: opts?.cwd ?? REPO_DIR,
      timeout: opts?.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: unknown };
    throw new GitError(`git ${args[0] ?? ""} failed: ${e.message ?? String(err)}`, e.stderr ?? "");
  }
};

/** Test seam: swap the exec implementation. Returns the previous one. */
export function setGitRunner(next: GitRunner): GitRunner {
  const previous = runner;
  runner = next;
  return previous;
}

export function git(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  return runner(args, opts);
}

function cap(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n[truncated]`;
}

// --- clone / fetch ----------------------------------------------------------

let gitAvailable: boolean | null = null;

export async function gitIsAvailable(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  try {
    await git(["--version"], { cwd: PROJECT_ROOT, timeout: 10_000 });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

/** Test seam. */
export function resetRepoState(): void {
  gitAvailable = null;
  cloned = false;
  checkedOutRev = null;
  checkoutChain = Promise.resolve();
}

let cloned = false;

/** A working clone (`.git/`) or a bare one (`HEAD`) both count. */
export function repoExists(): boolean {
  return existsSync(resolve(REPO_DIR, ".git")) || existsSync(resolve(REPO_DIR, "HEAD"));
}

/** Clone on first use (blobless, no checkout); cheap no-op afterwards. */
export async function ensureRepo(): Promise<void> {
  if (cloned && repoExists()) return;
  if (!(await gitIsAvailable())) throw new GitError("git is not available on this machine");

  if (repoExists()) {
    cloned = true;
    return;
  }
  await mkdir(dirname(REPO_DIR), { recursive: true });
  await git(
    ["clone", "--filter=blob:none", "--no-checkout", repoUrl(), REPO_DIR],
    { cwd: PROJECT_ROOT, timeout: 600_000 },
  );
  cloned = true;
}

export async function fetchBase(baseRef = "master"): Promise<void> {
  await ensureRepo();
  if (!/^[\w.\-/]{1,80}$/.test(baseRef)) throw new GuardError(`bad base ref: ${baseRef}`);
  await git(["fetch", "--filter=blob:none", "origin", `${baseRef}:refs/remotes/origin/${baseRef}`, "--force"], {
    timeout: 300_000,
  });
}

/**
 * Fetch `pull/<n>/head` as `refs/pr/<n>`. When `previousHead` is given and the
 * ref already points elsewhere, the old tip is kept as `refs/pr/<n>/prev` so a
 * revision delta can still be computed after a force-push.
 */
export async function fetchPr(n: number, previousHead?: string): Promise<void> {
  await ensureRepo();
  if (!Number.isInteger(n) || n <= 0) throw new GuardError(`bad PR number: ${String(n)}`);

  await git(["fetch", "--filter=blob:none", "origin", `pull/${n}/head:${prRef(n)}`, "--force"], { timeout: 300_000 });

  if (previousHead && /^[0-9a-f]{7,40}$/.test(previousHead)) {
    try {
      if (!(await hasRev(previousHead))) {
        await git(["fetch", "--filter=blob:none", "origin", previousHead, "--force"], { timeout: 300_000 });
      }
      await git(["update-ref", prevRef(n), previousHead]);
    } catch {
      // The previous head may be unreachable after a force-push; the dossier
      // degrades to a single revision rather than failing.
    }
  }
}

/** True when the rev resolves in the local clone. */
export async function hasRev(rev: string): Promise<boolean> {
  try {
    assertRev(rev);
    await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Make a loose object available locally (blobless clones fetch on demand). */
export async function ensureSha(sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return false;
  if (await hasRev(sha)) return true;
  try {
    await git(["fetch", "--filter=blob:none", "origin", sha, "--force"], { timeout: 300_000 });
    return await hasRev(sha);
  } catch {
    return false;
  }
}

// --- reads ------------------------------------------------------------------

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
}

export async function listTree(rev: string, dir = ""): Promise<TreeEntry[]> {
  assertRev(rev);
  const args = ["ls-tree", "--name-only", "-z", "--full-tree", rev];
  if (dir !== "") {
    assertPathShape(dir);
    args.push("--", dir.endsWith("/") ? dir : `${dir}/`);
  }
  const { stdout } = await git(args);
  const names = stdout.split("\0").filter((x) => x.length > 0);

  // A second pass gives the type without parsing ls-tree's mode column.
  const typed = await git(["ls-tree", "-z", "--full-tree", rev, ...(dir === "" ? [] : ["--", dir.endsWith("/") ? dir : `${dir}/`])]);
  const types = new Map<string, "blob" | "tree">();
  for (const row of typed.stdout.split("\0")) {
    const m = /^\d+ (blob|tree) [0-9a-f]+\t(.*)$/.exec(row);
    if (m?.[1] && m[2] !== undefined) types.set(m[2], m[1] as "blob" | "tree");
  }
  return names.map((path) => ({ path, type: types.get(path) ?? "blob" }));
}

/** Path guard that also proves the path exists at that rev (spec: "not returned by ls-tree"). */
export async function assertPathInTree(rev: string, path: string): Promise<string> {
  assertRev(rev);
  assertPathShape(path);
  const { stdout } = await git(["ls-tree", "--name-only", "-z", "--full-tree", rev, "--", path]);
  const found = stdout.split("\0").some((x) => x === path);
  if (!found) throw new GuardError(`path is not in the tree at ${rev}: ${path}`);
  return path;
}

export interface BlameLine {
  sha: string;
  author: string;
  date: string;
  summary: string;
  line: number;
  text: string;
}

/** Parse `git blame --porcelain`. Header fields repeat only for new commits. */
export function parseBlamePorcelain(stdout: string): BlameLine[] {
  const out: BlameLine[] = [];
  const meta = new Map<string, { author: string; date: string; summary: string }>();
  let current: { sha: string; line: number } | null = null;
  let author = "";
  let date = "";
  let summary = "";

  for (const raw of stdout.split("\n")) {
    const header = /^([0-9a-f]{40})(?: \d+)? (\d+)(?: \d+)?$/.exec(raw);
    if (header?.[1] && header[2]) {
      const sha = header[1];
      current = { sha, line: Number(header[2]) };
      const known = meta.get(sha);
      author = known?.author ?? "";
      date = known?.date ?? "";
      summary = known?.summary ?? "";
      continue;
    }
    if (raw.startsWith("author ")) author = raw.slice(7);
    else if (raw.startsWith("author-time ")) date = new Date(Number(raw.slice(12)) * 1000).toISOString();
    else if (raw.startsWith("summary ")) summary = raw.slice(8);
    else if (raw.startsWith("\t") && current) {
      meta.set(current.sha, { author, date, summary });
      out.push({ sha: current.sha, author, date, summary, line: current.line, text: raw.slice(1) });
      current = null;
    }
  }
  return out;
}

export async function blame(path: string, rev: string, startLine: number, endLine: number): Promise<BlameLine[]> {
  assertRev(rev);
  assertPathShape(path);
  assertLineRange(startLine, endLine);
  const { stdout } = await git(["blame", "-L", `${startLine},${endLine}`, "--porcelain", rev, "--", path]);
  return parseBlamePorcelain(stdout);
}

export async function show(rev: string, path?: string, maxBytes = 200_000): Promise<string> {
  assertRev(rev);
  if (path !== undefined) {
    assertPathShape(path);
    const { stdout } = await git(["show", `${rev}:${path}`]);
    return cap(stdout, maxBytes);
  }
  const { stdout } = await git(["show", "--stat", "--patch", "--no-color", rev]);
  return cap(stdout, maxBytes);
}

export async function readFile(rev: string, path: string, startLine?: number, endLine?: number): Promise<string> {
  assertRev(rev);
  assertPathShape(path);
  const { stdout } = await git(["show", `${rev}:${path}`]);
  if (startLine === undefined && endLine === undefined) return cap(stdout, 200_000);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.max(start, endLine ?? start + 200);
  assertLineRange(start, end);
  const lines = stdout.split("\n").slice(start - 1, end);
  return cap(lines.map((l, i) => `${start + i}: ${l}`).join("\n"), 200_000);
}

export interface LogEntry {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

function parseLog(stdout: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const row of stdout.split("\n")) {
    if (!row) continue;
    const parts = row.split("\x1f");
    if (parts.length < 4) continue;
    out.push({ sha: parts[0] ?? "", date: parts[1] ?? "", author: parts[2] ?? "", subject: parts[3] ?? "" });
  }
  return out;
}

const LOG_FORMAT = "--pretty=format:%H\x1f%aI\x1f%an\x1f%s";

export async function logForPath(path: string | undefined, rev: string, max = 20): Promise<LogEntry[]> {
  assertRev(rev);
  const args = ["log", LOG_FORMAT, `--max-count=${clampMax(max, 20, 200)}`, rev];
  if (path !== undefined) {
    assertPathShape(path);
    args.push("--", path);
  }
  const { stdout } = await git(args);
  return parseLog(stdout);
}

/** `git log <from>..<to>`: the commits one revision added on top of another. */
export async function logRange(from: string, to: string, max = 50): Promise<LogEntry[]> {
  assertRev(from);
  assertRev(to);
  const { stdout } = await git(["log", LOG_FORMAT, `--max-count=${clampMax(max, 50, 200)}`, `${from}..${to}`]);
  return parseLog(stdout);
}

/** `git log -S<text>`: commits that changed the number of occurrences of `text`. */
export async function logSearch(pickaxe: string, rev: string, max = 20): Promise<LogEntry[]> {
  assertRev(rev);
  if (typeof pickaxe !== "string" || pickaxe.length === 0 || pickaxe.length > 200) {
    throw new GuardError("pickaxe text must be 1 to 200 characters");
  }
  // -S and its operand are separate argv entries, so the text can never be read
  // as an option however it is spelled.
  const { stdout } = await git(["log", LOG_FORMAT, `--max-count=${clampMax(max, 20, 200)}`, "-S", pickaxe, rev]);
  return parseLog(stdout);
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export function parseGrep(stdout: string): GrepHit[] {
  const out: GrepHit[] = [];
  for (const row of stdout.split("\n")) {
    if (!row) continue;
    const m = /^(.+?):(\d+):([\s\S]*)$/.exec(row);
    if (!m?.[1] || !m[2]) continue;
    out.push({ path: m[1], line: Number(m[2]), text: (m[3] ?? "").slice(0, 400) });
  }
  return out;
}

/**
 * `git grep <rev>` has to read every blob in that tree, and in a blobless clone
 * that means one lazy fetch per file — minutes, or a timeout. Materialising the
 * tree once with a detached checkout pulls the blobs in a single pack and makes
 * every later grep at that rev take milliseconds. Clone stays `--no-checkout`;
 * this happens only when something actually greps.
 */
let checkedOutRev: string | null = null;
let checkoutChain: Promise<unknown> = Promise.resolve();

export async function ensureBlobs(rev: string): Promise<boolean> {
  assertRev(rev);
  if (checkedOutRev === rev) return true;
  // Serialised: two greps at different revs must not fight over the work tree.
  const task = checkoutChain.then(async () => {
    if (checkedOutRev === rev) return true;
    try {
      await git(["-c", "advice.detachedHead=false", "checkout", "--force", rev], { timeout: 600_000 });
      checkedOutRev = rev;
      return true;
    } catch {
      return false;
    }
  });
  checkoutChain = task.catch(() => undefined);
  return task;
}

export async function grep(pattern: string, rev: string, pathGlob?: string, max = 50): Promise<GrepHit[]> {
  assertRev(rev);
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 200) {
    throw new GuardError("grep pattern must be 1 to 200 characters");
  }
  const limit = clampMax(max, 50, 500);
  if (!(await ensureBlobs(rev))) {
    throw new GitError(`could not materialise the tree at ${rev}, so grep is unavailable`);
  }
  const args = ["grep", "-n", "-I", "-E", `--max-count=${limit}`, "-e", pattern, rev];
  if (pathGlob !== undefined && pathGlob !== "") {
    assertPathShape(pathGlob.replace(/\*/g, "x")); // validate shape, keep the glob
    args.push("--", pathGlob);
  }
  try {
    const { stdout } = await git(args);
    // `git grep <rev>` prefixes every hit with "<rev>:".
    return parseGrep(stdout.split("\n").map((l) => (l.startsWith(`${rev}:`) ? l.slice(rev.length + 1) : l)).join("\n"))
      .slice(0, limit);
  } catch (err) {
    // git grep exits 1 when there are no matches.
    if (err instanceof GitError && !err.stderr.trim()) return [];
    throw err;
  }
}

export async function diffRange(shaA: string, shaB: string, maxBytes = 60_000): Promise<string> {
  assertRev(shaA);
  assertRev(shaB);
  const { stdout } = await git(["diff", "--no-color", `${shaA}..${shaB}`]);
  return cap(stdout, maxBytes);
}

export async function mergeBase(a: string, b: string): Promise<string | null> {
  assertRev(a);
  assertRev(b);
  try {
    const { stdout } = await git(["merge-base", a, b]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
