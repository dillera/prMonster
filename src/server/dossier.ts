// The deterministic layer of deep analysis (DESIGN-deep.md "Dossier").
//
// Everything here is a fact with a provenance: a blame SHA, a PR number, a
// comment URL, a token that is or is not in the diff. No model, no guessing.
// When git is missing the dossier degrades rather than failing — `availability`
// says exactly which parts are real.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type {
  CrossRef,
  GateResult,
  DeletedLineOrigin,
  Dossier,
  DriftSignal,
  Revision,
  RevisionDelta,
  ThreadEntry,
} from "../shared/types.js";
import { parseDiff, type DiffFile } from "./chunk.js";
import {
  getIssueComments,
  getPrBaseSha,
  getPrCommits,
  getPrSummary,
  getReviewComments,
  getReviewsDetailed,
  getCommitPulls,
  type PrCommit,
  type PrSummary,
} from "./github.js";
import {
  blame,
  diffRange,
  ensureRepo,
  fetchBase,
  fetchPr,
  gitIsAvailable,
  grep,
  hasRev,
  logRange,
  prRef,
  prevRef,
  type BlameLine,
} from "./repo.js";
import { DATA_DIR, evaluationsFor, readJson, writeJsonAtomic } from "./store.js";

/** Overridable so tests never write to the real cache. */
export const DOSSIER_DIR = process.env["DOSSIER_CACHE_DIR"] ?? resolve(DATA_DIR, "dossier");
export const MAX_BLAMED_LINES = 200;
export const MAX_DELTA_BYTES = 60_000;
const MAX_CROSSREF_SYMBOLS = 8;
const MAX_CROSSREF_HITS = 20;
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** Commits further apart than this are treated as separate pushes. */
export const REVISION_GAP_MS = 10 * 60 * 1000;

function dossierPath(n: number, headSha: string): string | null {
  if (!Number.isInteger(n) || n <= 0 || !/^[0-9a-f]{7,64}$/.test(headSha)) return null;
  return resolve(DOSSIER_DIR, `${n}-${headSha}.json`);
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/**
 * Group a PR's commits into the pushes that produced them.
 *
 * The heads the store has already seen are authoritative — those are pushes we
 * watched happen. Failing that (the usual case for a PR we are seeing for the
 * first time), a gap between consecutive commit timestamps is the boundary:
 * PR 1650's two commits are 95 minutes apart, which is two revisions, while a
 * batch pushed together is one.
 */
export function groupCommitsIntoRevisions(commits: PrCommit[], knownHeads: string[]): PrCommit[][] {
  if (commits.length === 0) return [];
  const heads = new Set(knownHeads.filter((h) => commits.some((c) => c.sha === h)));

  const groups: PrCommit[][] = [];
  let current: PrCommit[] = [];
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i] as PrCommit;
    current.push(commit);
    const next = commits[i + 1];
    const isKnownHead = heads.has(commit.sha);
    const gap =
      next && commit.date && next.date
        ? Date.parse(next.date) - Date.parse(commit.date) > REVISION_GAP_MS
        : false;
    if (next === undefined || isKnownHead || (heads.size === 0 && gap)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function statsFor(files: DiffFile[]): { additions: number; deletions: number; changedFiles: number } {
  return {
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    changedFiles: files.length,
  };
}

// ---------------------------------------------------------------------------
// Revision delta
// ---------------------------------------------------------------------------

function addedTexts(files: DiffFile[]): string[] {
  return files.flatMap((f) => f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text.trim())));
}

function removedTexts(files: DiffFile[]): string[] {
  return files.flatMap((f) => f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "del").map((l) => l.text.trim())));
}

function countIntersection(a: string[], b: string[]): number {
  const pool = new Map<string, number>();
  for (const x of a) {
    if (x === "") continue;
    pool.set(x, (pool.get(x) ?? 0) + 1);
  }
  let hits = 0;
  for (const y of b) {
    const left = pool.get(y);
    if (left && left > 0) {
      pool.set(y, left - 1);
      hits += 1;
    }
  }
  return hits;
}

/** `#ifdef FOO` / `#if defined(FOO)` tokens among a set of lines. */
function ifdefTokens(lines: string[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    const m = /^\s*#\s*(?:ifdef|ifndef|if\s+defined\s*\(?)\s*([A-Za-z_]\w*)/.exec(l);
    if (m?.[1]) out.add(m[1]);
  }
  return [...out];
}

export interface DeltaInput {
  fromSha: string;
  toSha: string;
  diff: string;
  /** base..fromSha, so we can tell which removed lines the previous revision had added. */
  previousDiffFiles: DiffFile[];
  revisionNumber: number;
}

/** Template the one-line summary of what the newest push did. Pure. */
export function summariseDelta(input: DeltaInput): RevisionDelta {
  const files = parseDiff(input.diff).files;
  const filesTouched = files.map((f) => f.path);
  const added = addedTexts(files);
  const removed = removedTexts(files);
  const previouslyAdded = addedTexts(input.previousDiffFiles);
  const previouslyRemoved = removedTexts(input.previousDiffFiles);

  const linesAddedNowRemoved = countIntersection(previouslyAdded, removed);
  const linesRemovedNowRestored = countIntersection(previouslyRemoved, added);

  const n = input.revisionNumber;
  const plural = (k: number, word: string): string => `${k} ${word}${k === 1 ? "" : "s"}`;
  const parts: string[] = [];
  const netAdded = added.length - linesRemovedNowRestored;
  const netRemoved = removed.length - linesAddedNowRemoved;
  // A guard the previous revision added, whose body this revision also removed,
  // is the motivating shape: say it as one sentence rather than two counts.
  const wrapped = ifdefTokens(previouslyAdded).filter((t) => removed.some((r) => r.includes(t)));

  if (linesAddedNowRemoved > 0 && wrapped.length > 0 && netRemoved > 0) {
    parts.push(
      `revision ${n} removed the ${plural(linesAddedNowRemoved, "guard line")} revision ${n - 1} had added (#ifdef ${wrapped.join("/")}) and the ${plural(netRemoved, "line")} they wrapped`,
    );
  } else {
    if (linesAddedNowRemoved > 0) {
      const guard = wrapped.length > 0 ? ` that revision ${n - 1} had wrapped in #ifdef ${wrapped.join("/")}` : "";
      parts.push(`revision ${n} removed the ${plural(linesAddedNowRemoved, "line")} revision ${n - 1} had added${guard}`);
    }
    if (netRemoved > 0) parts.push(`removed ${plural(netRemoved, "further line")}`);
  }
  if (linesRemovedNowRestored > 0) {
    parts.push(`restored ${plural(linesRemovedNowRestored, "line")} revision ${n - 1} had deleted`);
  }
  if (netAdded > 0) parts.push(`added ${plural(netAdded, "new line")}`);
  if (parts.length === 0) parts.push(`revision ${n} changed no lines`);

  const where = filesTouched.length > 0 ? ` in ${filesTouched.join(", ")}` : "";
  const summary = `${parts.join(", ")}${where}.`;

  return {
    fromSha: input.fromSha,
    toSha: input.toSha,
    diff: input.diff,
    filesTouched,
    linesAddedNowRemoved,
    linesRemovedNowRestored,
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Deleted-line provenance
// ---------------------------------------------------------------------------

export interface RemovedLineRef {
  path: string;
  line: number;
  text: string;
}

/** Removed lines of a diff with their line numbers in the *old* file. */
export function removedLineRefs(files: DiffFile[]): RemovedLineRef[] {
  const out: RemovedLineRef[] = [];
  for (const f of files) {
    const path = f.oldPath ?? f.path;
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "del" && typeof l.oldLine === "number") {
          out.push({ path, line: l.oldLine, text: l.text });
        }
      }
    }
  }
  return out;
}

/** Contiguous runs of line numbers, so one blame call covers many lines. */
export function contiguousRanges(lines: number[]): Array<[number, number]> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const n of sorted) {
    if (start === null || prev === null) {
      start = n;
    } else if (n !== prev + 1) {
      out.push([start, prev]);
      start = n;
    }
    prev = n;
  }
  if (start !== null && prev !== null) out.push([start, prev]);
  return out;
}

/** `Add flow control (#1628)` -> 1628. Squash merges carry the PR this way. */
export function prNumberFromSubject(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject.trim()) ?? /\(#(\d+)\)/.exec(subject);
  return m?.[1] ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Cross-references
// ---------------------------------------------------------------------------

const SYMBOL_STOPLIST = new Set([
  "if", "for", "while", "switch", "return", "sizeof", "printf", "sprintf", "snprintf",
  "else", "case", "break", "continue", "goto", "do", "defined", "static_cast",
  "reinterpret_cast", "const_cast", "dynamic_cast", "true", "false", "null", "nullptr",
  "int", "char", "void", "bool", "float", "double", "unsigned", "signed", "struct",
  "class", "public", "private", "protected", "virtual", "override", "template",
  "typename", "namespace", "using", "include", "define", "ifdef", "ifndef", "endif",
  "elif", "pragma", "NULL", "TRUE", "FALSE",
]);

/** Identifiers from deleted lines worth looking up elsewhere in the tree. */
export function symbolsFromDeletedLines(lines: Array<{ text: string }>): string[] {
  const seen = new Map<string, string>();
  for (const l of lines) {
    for (const m of l.text.matchAll(/\b([A-Za-z_]\w{3,})\s*\(/g)) {
      const sym = m[1] ?? "";
      if (sym && !SYMBOL_STOPLIST.has(sym) && !seen.has(sym)) seen.set(sym, l.text.trim());
    }
    for (const m of l.text.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)) {
      const sym = m[1] ?? "";
      if (sym && !SYMBOL_STOPLIST.has(sym) && !seen.has(sym)) seen.set(sym, l.text.trim());
    }
  }
  return [...seen.keys()].slice(0, MAX_CROSSREF_SYMBOLS);
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

const PROSE_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "not", "but", "are", "was",
  "has", "have", "will", "can", "all", "any", "its", "his", "her", "out", "use",
  "add", "adds", "fix", "fixes", "now", "only", "also", "when", "which", "there",
]);

/**
 * Tokens in prose that name code: backticked spans, macro-shaped words, paths,
 * and `foo()` calls. Prose words and bare English are dropped — a drift signal
 * is only useful if the token is checkable against the diff.
 */
/** How interesting a token is as drift evidence: preprocessor, then macros, then paths. */
function tokenRank(t: string): number {
  if (t.startsWith("#")) return 0;
  if (/^[A-Z][A-Z0-9_]{4,}$/.test(t)) return 1;
  if (/\.(c|cc|cpp|h|hpp|ini|md|py|sh|ya?ml)$/.test(t)) return 2;
  if (t.includes("::") || t.includes("/")) return 3;
  return 4;
}

export function codeTokens(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const t = raw.trim().replace(/^[^#\w]+|[^\w)]+$/g, "").replace(/\(\)?$/, "");
    if (t.length < 3 || t.length > 80) return;
    if (PROSE_WORDS.has(t.toLowerCase())) return;
    const looksLikeCode =
      t.startsWith("#") ||
      /^[A-Z][A-Z0-9_]{3,}$/.test(t) ||
      /_/.test(t) ||
      /::/.test(t) ||
      /\.(c|cc|cpp|h|hpp|ini|md|py|sh|ya?ml)$/.test(t) ||
      t.includes("/");
    if (!looksLikeCode) return;
    out.add(t);
  };

  // Backticked spans may hold a call, a phrase, or a whole expression; split
  // them into identifier-shaped pieces so `uart_param_config()` and
  // `.flowControl(UART_HW_FLOWCTRL_CTS_RTS)` each yield clean tokens.
  for (const m of text.matchAll(/`([^`\n]{2,120})`/g)) {
    for (const piece of (m[1] ?? "").split(/[^\w#:./]+/)) add(piece);
  }
  for (const m of text.matchAll(/(?<![`\w])(#\s*\w+|[A-Za-z_][\w]*\.[ch](?:pp)?|[A-Z][A-Z0-9_]{4,})/g)) {
    add(m[1] ?? "");
  }
  return [...out].sort((a, b) => tokenRank(a) - tokenRank(b) || a.localeCompare(b));
}

function significantWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((w) => !PROSE_WORDS.has(w));
}

export interface DriftInput {
  title: string;
  body: string;
  diffText: string;
  commitSubjects: string[];
  /** Subject of the first revision's last commit, used as "what the PR said it was". */
  firstRevisionSubject?: string;
  previousBody?: string | null;
  headMoved: boolean;
}

export function detectDrift(input: DriftInput): DriftSignal[] {
  const signals: DriftSignal[] = [];
  const haystack = input.diffText;
  const absent = (tokens: string[]): string[] => tokens.filter((t) => !haystack.includes(t)).slice(0, 12);

  const bodyAbsent = absent(codeTokens(input.body));
  if (bodyAbsent.length > 0) {
    signals.push({
      kind: "body_mentions_absent_token",
      detail: `The description names ${bodyAbsent.length} code token(s) that do not appear anywhere in the current diff`,
      evidence: bodyAbsent,
    });
  }

  // The PR title, plus what the first revision called itself: a title that was
  // rewritten still leaves revision 1's subject describing the old approach.
  const titleSources = [input.title, input.firstRevisionSubject ?? ""].filter((t) => t.length > 0);
  const titleAbsent = absent([...new Set(titleSources.flatMap(codeTokens))]);
  if (titleAbsent.length > 0) {
    const fromSubject =
      input.firstRevisionSubject !== undefined &&
      titleAbsent.some((t) => input.firstRevisionSubject?.includes(t)) &&
      !titleAbsent.some((t) => input.title.includes(t));
    signals.push({
      kind: "title_mentions_absent_token",
      detail: fromSubject
        ? `The revision 1 commit subject "${input.firstRevisionSubject}" names ${titleAbsent.join(", ")}, which the current diff does not contain`
        : `The title names ${titleAbsent.join(", ")}, which the current diff does not contain`,
      evidence: titleAbsent,
    });
  }

  if (input.headMoved && input.previousBody !== null && input.previousBody !== undefined && input.previousBody === input.body) {
    signals.push({
      kind: "body_predates_push",
      detail: "The head moved but the description is byte-for-byte what it was before the push",
      evidence: [],
    });
  }

  if (input.commitSubjects.length > 0) {
    const titleWords = new Set(significantWords(input.title));
    const agrees = input.commitSubjects.some(
      (s) => significantWords(s).filter((w) => titleWords.has(w)).length >= 3,
    );
    if (!agrees) {
      signals.push({
        kind: "commit_subject_disagrees_with_title",
        detail: "No commit subject shares three significant words with the pull request title",
        evidence: input.commitSubjects.slice(0, 5),
      });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export function buildThread(
  issueComments: Awaited<ReturnType<typeof getIssueComments>>,
  reviewComments: Awaited<ReturnType<typeof getReviewComments>>,
  reviews: Awaited<ReturnType<typeof getReviewsDetailed>>,
  commits: PrCommit[],
): ThreadEntry[] {
  const entries: ThreadEntry[] = [];

  const push = (kind: ThreadEntry["kind"], c: { author: string; association: string; at: string; body: string; url: string; path?: string; line?: number; state?: string }): void => {
    const e: ThreadEntry = {
      kind,
      at: c.at,
      author: c.author,
      association: c.association,
      isMaintainer: MAINTAINER_ASSOCIATIONS.has(c.association),
      body: c.body,
      url: c.url,
    };
    if (c.path) e.path = c.path;
    if (typeof c.line === "number") e.line = c.line;
    if (c.state) e.state = c.state;
    entries.push(e);
  };

  for (const c of issueComments) push("issue_comment", c);
  for (const c of reviewComments) push("review_comment", c);
  // A review with no body and no state beyond COMMENTED adds nothing the
  // review comments do not already carry.
  for (const r of reviews) {
    if (r.body.trim() === "" && (r.state === "COMMENTED" || r.state === undefined)) continue;
    push("review", r);
  }
  for (const c of commits) {
    push("commit", {
      author: c.author,
      association: "NONE",
      at: c.date,
      body: c.subject,
      url: c.url,
    });
  }

  entries.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  return entries;
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export interface BuildDossierOptions {
  refresh?: boolean;
}

export async function buildDossier(n: number, opts: BuildDossierOptions = {}): Promise<Dossier> {
  const { baseSha, baseRef, headSha } = await getPrBaseSha(n);

  const cachePath = dossierPath(n, headSha);
  const cached = cachePath && existsSync(cachePath) ? readJson<Dossier | null>(cachePath, null) : null;
  if (!opts.refresh && cached) return cached;

  // A refresh with the head unchanged only needs GitHub again: the thread,
  // the title and the body move without a push (someone comments, the author
  // rewrites the description), while blame, revisions and cross-references are
  // functions of the commits and cannot have changed.
  if (opts.refresh && cached && cached.headSha === headSha && cached.availability.git) {
    return refreshGithubParts(n, cached, cachePath);
  }

  const notes: string[] = [];
  const [commits, issueComments, reviewComments, reviews, self] = await Promise.all([
    getPrCommits(n),
    getIssueComments(n),
    getReviewComments(n),
    getReviewsDetailed(n),
    getPrSummary(n),
  ]);

  const thread = buildThread(issueComments, reviewComments, reviews, commits);
  const maintainers = [...new Set(thread.filter((t) => t.isMaintainer).map((t) => t.author))];

  // --- revisions ---
  // evaluationsFor is newest-first; a head we evaluated that is no longer in
  // the PR's commit list means the author force-pushed, and that head is still
  // a revision we watched happen.
  const storedHeads = [...new Set(evaluationsFor(n).map((e) => e.headSha))];
  const previousHeads = storedHeads.filter((h) => h !== headSha);
  const groups = groupCommitsIntoRevisions(commits, storedHeads);
  const forcePushed = groups.length === 1 && previousHeads.length > 0;

  // --- git ---
  const gitOk = await gitIsAvailable();
  let repoReady = false;
  if (gitOk) {
    try {
      await ensureRepo();
      await fetchBase(baseRef);
      const previousHead = groups.length > 1 ? groups[groups.length - 2]?.at(-1)?.sha : previousHeads[0];
      await fetchPr(n, previousHead);
      repoReady = true;
    } catch (err) {
      notes.push(`git is available but the clone could not be prepared: ${(err as Error).message}`);
    }
  } else {
    notes.push("git is not available, so provenance and cross-references are unavailable");
  }

  // Current PR diff, base..head, from git when we have it.
  let prDiffFiles: DiffFile[] = [];
  if (repoReady) {
    try {
      prDiffFiles = parseDiff(await diffRange(baseSha, prRef(n), 400_000)).files;
    } catch (err) {
      notes.push(`could not diff base..head: ${(err as Error).message}`);
    }
  }

  const revisions: Revision[] = [];

  // A force-pushed-away head is reconstructed from the local clone: its commits
  // come from `git log base..<sha>`, which still resolves because we kept the
  // object when we first evaluated that head.
  if (forcePushed && repoReady) {
    for (const head of [...previousHeads].reverse()) {
      const rev = (await hasRev(head)) ? head : (await hasRev(prevRef(n))) ? prevRef(n) : null;
      if (rev === null) {
        notes.push(`the previously evaluated head ${head.slice(0, 9)} is no longer fetchable, so that revision is listed without detail`);
        revisions.push({ headSha: head, pushedAt: "", commits: [], additions: 0, deletions: 0, changedFiles: 0 });
        continue;
      }
      let revCommits: Revision["commits"] = [];
      let stats = { additions: 0, deletions: 0, changedFiles: 0 };
      try {
        revCommits = (await logRange(baseSha, rev, 50))
          .reverse()
          .map((c) => ({ sha: c.sha, date: c.date, author: c.author, subject: c.subject }));
        stats = statsFor(parseDiff(await diffRange(baseSha, rev, 400_000)).files);
      } catch (err) {
        notes.push(`could not reconstruct revision ${head.slice(0, 9)}: ${(err as Error).message}`);
      }
      revisions.push({
        headSha: head,
        pushedAt: revCommits.at(-1)?.date ?? "",
        commits: revCommits,
        ...stats,
      });
    }
    notes.push(
      `the author force-pushed: ${previousHeads.length} previously evaluated head(s) are no longer in the pull request's commit list`,
    );
  }

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] as PrCommit[];
    const last = group.at(-1) as PrCommit;
    let stats = { additions: 0, deletions: 0, changedFiles: 0 };
    if (repoReady) {
      try {
        const isLast = i === groups.length - 1;
        const rev = isLast ? prRef(n) : last.sha;
        if (isLast || (await hasRev(last.sha))) {
          stats = statsFor(parseDiff(await diffRange(baseSha, rev, 400_000)).files);
        }
      } catch {
        // leave zeroes; the revision is still listed
      }
    }
    revisions.push({
      headSha: last.sha,
      pushedAt: last.date,
      commits: group.map((c) => ({ sha: c.sha, date: c.date, author: c.author, subject: c.subject })),
      ...stats,
    });
  }
  // The current head is always the last revision, whatever produced the list.

  // --- latest delta ---
  let latestDelta: RevisionDelta | null = null;
  if (repoReady && revisions.length > 1) {
    const prev = revisions[revisions.length - 2] as Revision;
    const cur = revisions[revisions.length - 1] as Revision;
    try {
      const fromRev = (await hasRev(prev.headSha)) ? prev.headSha : prevRef(n);
      const diff = await diffRange(fromRev, prRef(n), MAX_DELTA_BYTES);
      const previousDiffFiles = parseDiff(await diffRange(baseSha, fromRev, 400_000)).files;
      latestDelta = summariseDelta({
        fromSha: prev.headSha,
        toSha: cur.headSha,
        diff,
        previousDiffFiles,
        revisionNumber: revisions.length,
      });
    } catch (err) {
      notes.push(`could not compute the revision delta: ${(err as Error).message}`);
    }
  }

  // --- deleted-line provenance ---
  const deletedLineOrigins: DeletedLineOrigin[] = [];
  let provenance = false;
  if (repoReady && prDiffFiles.length > 0) {
    const refs = removedLineRefs(prDiffFiles);
    const capped = refs.slice(0, MAX_BLAMED_LINES);
    if (refs.length > capped.length) {
      notes.push(`only the first ${MAX_BLAMED_LINES} of ${refs.length} deleted lines were traced`);
    }
    const byPath = new Map<string, RemovedLineRef[]>();
    for (const r of capped) {
      const list = byPath.get(r.path) ?? [];
      list.push(r);
      byPath.set(r.path, list);
    }

    const prCache = new Map<number, PrSummary | null>();
    const blamed: Array<RemovedLineRef & { blame: BlameLine }> = [];
    for (const [path, list] of byPath) {
      for (const [from, to] of contiguousRanges(list.map((r) => r.line))) {
        try {
          const lines = await blame(path, baseSha, from, to);
          for (const b of lines) {
            const ref = list.find((r) => r.line === b.line);
            if (ref) blamed.push({ ...ref, blame: b });
          }
        } catch (err) {
          notes.push(`blame failed for ${path}:${from},${to}: ${(err as Error).message}`);
        }
      }
    }
    provenance = blamed.length > 0;

    for (const b of blamed) {
      let prNumber = prNumberFromSubject(b.blame.summary);
      if (prNumber === null) {
        const pulls = await getCommitPulls(b.blame.sha);
        prNumber = pulls[0] ?? null;
      }
      let pr: DeletedLineOrigin["pr"] = null;
      if (prNumber !== null) {
        if (!prCache.has(prNumber)) prCache.set(prNumber, await getPrSummary(prNumber));
        const summary = prCache.get(prNumber) ?? null;
        if (summary) {
          pr = {
            number: summary.number,
            title: summary.title,
            url: summary.url,
            author: summary.author,
            mergedAt: summary.mergedAt,
            body: summary.body.slice(0, 2048),
          };
        }
      }
      deletedLineOrigins.push({
        path: b.path,
        line: b.line,
        text: b.text,
        sha: b.blame.sha,
        author: b.blame.author,
        date: b.blame.date,
        subject: b.blame.summary,
        pr,
      });
    }
  }

  // --- origin PRs ---
  const originMap = new Map<number, Dossier["originPrs"][number]>();
  const threadAuthors = new Set(thread.map((t) => t.author.toLowerCase()));
  for (const o of deletedLineOrigins) {
    if (!o.pr) continue;
    const existing = originMap.get(o.pr.number);
    if (existing) {
      existing.linesDeletedFromIt += 1;
      continue;
    }
    const merged = o.pr.mergedAt ? Date.parse(o.pr.mergedAt) : Date.parse(o.date);
    const daysAgo = Number.isFinite(merged) ? Math.max(0, Math.round((Date.now() - merged) / 86_400_000)) : -1;
    originMap.set(o.pr.number, {
      number: o.pr.number,
      title: o.pr.title,
      author: o.pr.author,
      mergedAt: o.pr.mergedAt,
      daysAgo,
      linesDeletedFromIt: 1,
      authorInThread: threadAuthors.has(o.pr.author.toLowerCase()),
    });
  }
  const originPrs = [...originMap.values()].sort((a, b) => b.linesDeletedFromIt - a.linesDeletedFromIt);

  // --- cross-references ---
  const crossRefs: CrossRef[] = [];
  let crossRefsOk = false;
  if (repoReady && deletedLineOrigins.length > 0) {
    const deletedPaths = new Set(deletedLineOrigins.map((o) => o.path));
    const deletedTexts = new Set(deletedLineOrigins.map((o) => o.text.trim()));
    const symbols = symbolsFromDeletedLines(deletedLineOrigins);
    for (const symbol of symbols) {
      try {
        const hits = await grep(symbol, baseSha, undefined, MAX_CROSSREF_HITS * 2);
        const kept = hits
          .filter((h) => !(deletedPaths.has(h.path) && deletedTexts.has(h.text.trim())))
          .slice(0, MAX_CROSSREF_HITS);
        const from = deletedLineOrigins.find((o) => o.text.includes(symbol))?.text.trim() ?? "";
        if (kept.length > 0) crossRefs.push({ symbol, fromDeletedLine: from, hits: kept });
        crossRefsOk = true;
      } catch (err) {
        notes.push(`cross-reference search for ${symbol} failed: ${(err as Error).message}`);
        break;
      }
    }
  }

  // --- drift ---
  const diffText = prDiffFiles.length > 0
    ? prDiffFiles
        .flatMap((f) => [f.path, ...f.hunks.flatMap((h) => [h.header, ...h.lines.map((l) => l.text)])])
        .join("\n")
    : "";
  const previousBody = previousBodyFor(n, revisions);
  const drift = diffText === ""
    ? []
    : detectDrift({
        title: self?.title ?? "",
        body: self?.body ?? "",
        diffText,
        commitSubjects: commits.map((c) => c.subject),
        ...(revisions.length > 1 ? { firstRevisionSubject: revisions[0]?.commits.at(-1)?.subject ?? "" } : {}),
        previousBody,
        headMoved: revisions.length > 1,
      });
  if (diffText === "") notes.push("the diff was unavailable, so drift could not be checked");

  const dossier: Dossier = {
    prNumber: n,
    headSha,
    baseSha,
    builtAt: new Date().toISOString(),
    revisions,
    latestDelta,
    deletedLineOrigins,
    originPrs,
    thread,
    maintainers,
    crossRefs,
    drift,
    availability: { git: gitOk && repoReady, provenance, crossRefs: crossRefsOk, notes },
  };

  if (cachePath) writeJsonAtomic(cachePath, dossier);
  return dossier;
}

/**
 * Rebuild only the parts that come from the GitHub API, keeping the git-derived
 * ones from the cached dossier for this same head SHA.
 */
async function refreshGithubParts(n: number, cached: Dossier, cachePath: string | null): Promise<Dossier> {
  const [commits, issueComments, reviewComments, reviews, self] = await Promise.all([
    getPrCommits(n),
    getIssueComments(n),
    getReviewComments(n),
    getReviewsDetailed(n),
    getPrSummary(n),
  ]);

  const thread = buildThread(issueComments, reviewComments, reviews, commits);
  const maintainers = [...new Set(thread.filter((t) => t.isMaintainer).map((t) => t.author))];
  const threadAuthors = new Set(thread.map((t) => t.author.toLowerCase()));

  // Whether an origin PR's author has since joined the thread is exactly the
  // kind of thing that changes without a push.
  const originPrs = cached.originPrs.map((p) => ({ ...p, authorInThread: threadAuthors.has(p.author.toLowerCase()) }));

  const diffText = cached.deletedLineOrigins.length > 0 || cached.latestDelta
    ? [cached.latestDelta?.diff ?? "", ...cached.deletedLineOrigins.map((o) => `${o.path}\n${o.text}`)].join("\n")
    : "";
  const drift = diffText === ""
    ? cached.drift
    : detectDrift({
        title: self?.title ?? "",
        body: self?.body ?? "",
        diffText,
        commitSubjects: commits.map((c) => c.subject),
        ...(cached.revisions.length > 1
          ? { firstRevisionSubject: cached.revisions[0]?.commits.at(-1)?.subject ?? "" }
          : {}),
        previousBody: previousBodyFor(n, cached.revisions),
        headMoved: cached.revisions.length > 1,
      });

  const refreshed: Dossier = {
    ...cached,
    builtAt: new Date().toISOString(),
    thread,
    maintainers,
    originPrs,
    drift,
    availability: {
      ...cached.availability,
      notes: [
        ...cached.availability.notes.filter((x) => !x.startsWith("thread refreshed")),
        `thread refreshed at ${new Date().toISOString()} without re-reading git (head unchanged)`,
      ],
    },
  };
  if (cachePath) writeJsonAtomic(cachePath, refreshed);
  return refreshed;
}

/**
 * The description as it stood at the previous head, when we happen to have it.
 * Only the snapshot cache keeps bodies, and it keeps one head at a time, so
 * this is usually unknown — in which case `body_predates_push` is not claimed.
 */
function previousBodyFor(n: number, revisions: Revision[]): string | null {
  if (revisions.length < 2) return null;
  const prev = revisions[revisions.length - 2]?.headSha;
  if (!prev) return null;
  const cached = readJson<{ body?: string } | null>(resolve(DATA_DIR, "cache", `${n}-${prev}.json`), null);
  return typeof cached?.body === "string" ? cached.body : null;
}

export const DOSSIER_DRIFT_GATE = "dossier_drift";
export const DOSSIER_RECENT_ORIGIN_GATE = "dossier_recent_origin_pr";
/** An origin PR younger than this is worth a reviewer's attention. */
export const RECENT_ORIGIN_DAYS = 30;

/**
 * Dossier facts as info gates.
 *
 * decide() is pure and re-derivable from a stored Evaluation, so anything it
 * reasons about has to live in the Evaluation. These two carry the drift and
 * the recent-origin-PR facts across that boundary, already templated into the
 * sentence the explanation uses.
 */
export function dossierGates(dossier: Dossier): GateResult[] {
  const out: GateResult[] = [];

  out.push({
    id: DOSSIER_DRIFT_GATE,
    severity: "info",
    passed: dossier.drift.length === 0,
    detail:
      dossier.drift.length === 0
        ? "The description and the diff agree"
        : dossier.drift.map((d) => d.detail).join("; "),
    ...(dossier.drift.length > 0
      ? { evidence: dossier.drift.flatMap((d) => d.evidence).slice(0, 5), value: dossier.drift.map((d) => d.kind) }
      : {}),
  });

  const recent = dossier.originPrs.filter((p) => p.daysAgo >= 0 && p.daysAgo < RECENT_ORIGIN_DAYS);
  const revisionNumber = dossier.revisions.length;
  const sentences = recent.map((p) => {
    const purpose = dossier.deletedLineOrigins
      .find((o) => o.pr?.number === p.number)
      ?.pr?.body.replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const because = purpose ? ` added for "${purpose}"` : "";
    const inThread = p.authorInThread ? "that author is in the thread" : "that author is not in the thread";
    return `Revision ${revisionNumber} deleted ${p.linesDeletedFromIt} line${p.linesDeletedFromIt === 1 ? "" : "s"} that #${p.number} (${p.author}, ${p.daysAgo} day${p.daysAgo === 1 ? "" : "s"} ago)${because}; ${inThread}.`;
  });

  out.push({
    id: DOSSIER_RECENT_ORIGIN_GATE,
    severity: "info",
    passed: recent.length === 0,
    detail:
      recent.length === 0
        ? "No recently merged pull request lost lines to this change"
        : sentences.join(" "),
    ...(recent.length > 0 ? { value: recent.map((p) => `#${p.number}`) } : {}),
  });

  return out;
}

export function cachedDossier(n: number, headSha: string): Dossier | null {
  const path = dossierPath(n, headSha);
  return path === null ? null : readJson<Dossier | null>(path, null);
}
