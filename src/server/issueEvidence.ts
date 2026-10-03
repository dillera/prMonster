// Deterministic evidence for one open issue: no model, no prose.
//
//   thread facts  — age, last activity, who spoke last, whether a maintainer
//                   asked something and was never answered
//   linked work   — pull requests that mention or close it, commits that cite it
//   code facts    — every path and symbol the issue names, checked against the
//                   default branch today, plus how much those paths have moved
//                   since the issue was opened
//
// The code facts are the ones that answer "is this still relevant": an issue
// about lib/device/sio/fuji.cpp means something different once that file has
// been deleted or rewritten forty times. Git is best-effort — without a clone
// the code half is marked unchecked and everything else still works.

import type { CodeRef, IssueEvidence, IssueSnapshot } from "../shared/types.js";
import { codeTokens } from "./dossier.js";
import {
  countSince,
  ensureRepo,
  fetchBase,
  gitIsAvailable,
  grep,
  listAllFiles,
  logSince,
  resolveRev,
} from "./repo.js";

export const MAX_PATH_REFS = 12;
export const MAX_SYMBOL_REFS = 8;
const DAY_MS = 86_400_000;

const CODE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|ino|ini|py|sh|cmake|json|ya?ml|ld|s|S|csv|txt|html|js|css)$/;

function days(fromIso: string, now: number): number {
  const t = Date.parse(fromIso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : 0;
}

/**
 * Paths an issue names, in order of first appearance. GitHub blob links are
 * unwrapped to their repo path; bare filenames are kept when they carry a
 * source extension; slashed tokens are kept when their first segment is a
 * top-level entry of the tree (so `TCP/IP` and `n/a` do not count).
 */
export function extractPaths(text: string, topLevel: Set<string>, repoFull: string): string[] {
  const out: string[] = [];
  const add = (raw: string): void => {
    const p = raw.replace(/^\.?\//, "").replace(/[#?].*$/, "").replace(/[).,:;'"`]+$/, "");
    if (p.length < 3 || p.length > 200 || p.includes("..") || p.startsWith("-")) return;
    // A bare top-level directory ("lib/") names nothing checkable.
    if (!p.includes("/") && !CODE_EXT.test(p)) return;
    if (!out.includes(p)) out.push(p);
  };

  const blob = new RegExp(`github\\.com/${repoFull.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:blob|tree)/[^/\\s]+/([^\\s)#?]+)`, "gi");
  let stripped = text;
  for (const m of text.matchAll(blob)) {
    if (m[1]) add(decodeURIComponent(m[1]));
  }
  stripped = stripped.replace(/https?:\/\/\S+/g, " ");

  for (const m of stripped.matchAll(/(?<![\w@/.-])((?:[\w.-]+\/)+[\w.-]*)/g)) {
    const token = m[1] ?? "";
    const first = token.split("/")[0] ?? "";
    if (topLevel.has(first)) add(token.replace(/\/$/, ""));
  }
  for (const m of stripped.matchAll(/(?<![\w/.-])([A-Za-z_][\w.-]*\.[A-Za-z]{1,5})(?![\w/])/g)) {
    const token = m[1] ?? "";
    if (CODE_EXT.test(token) && !/^\d/.test(token)) add(token);
  }
  return out.slice(0, MAX_PATH_REFS);
}

/**
 * Symbol-shaped tokens, minus anything that is really a path. An all-caps word
 * with no underscore counts only inside backticks: in an issue it is far more
 * often shouting ("ERROR", "DELETE") or a product name ("SIO2SD") than a macro.
 */
export function extractSymbols(text: string): string[] {
  const noUrls = text.replace(/https?:\/\/\S+/g, " ");
  const backticked = new Set<string>();
  for (const m of noUrls.matchAll(/`([^`\n]{2,120})`/g)) {
    for (const piece of (m[1] ?? "").split(/[^\w:]+/)) if (piece) backticked.add(piece);
  }
  return codeTokens(noUrls)
    .filter((t) => !t.includes("/") && !t.startsWith("#") && !CODE_EXT.test(t))
    .filter((t) => /^[A-Za-z_][\w:]*$/.test(t) && t.length >= 4)
    .filter((t) => !/^[A-Z0-9]+$/.test(t) || backticked.has(t))
    .slice(0, MAX_SYMBOL_REFS);
}

/** Check one path against the file list at the default branch. */
export function checkPath(path: string, files: string[]): Pick<CodeRef, "status" | "matches"> {
  if (files.includes(path)) return { status: "exists", matches: [path] };
  const asDir = `${path}/`;
  const under = files.filter((f) => f.startsWith(asDir));
  if (under.length > 0) return { status: "exists", matches: [`${path}/ (${under.length} files)`] };

  const base = path.split("/").pop() ?? path;
  const sameName = files.filter((f) => f === base || f.endsWith(`/${base}`));
  if (!path.includes("/")) {
    return sameName.length > 0 ? { status: "exists", matches: sameName.slice(0, 5) } : { status: "missing", matches: [] };
  }
  return sameName.length > 0
    ? { status: "renamed_or_moved", matches: sameName.slice(0, 5) }
    : { status: "missing", matches: [] };
}

/**
 * Vendored libraries and prose. A symbol that only "exists" inside expat or
 * miniaudio, or in a markdown file, says nothing about FujiNet's own code.
 */
export function isFirstPartyCode(path: string): boolean {
  if (/^(components|components_pc|managed_components|\.pio|build|docs?)\//.test(path)) return false;
  return !/\.(md|txt|rst|html?)$/i.test(path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Everything the reporter and the thread wrote, which is where the code names live. */
export function issueText(snapshot: IssueSnapshot): string {
  return [snapshot.title, snapshot.body, ...snapshot.comments.map((c) => c.body)].join("\n\n");
}

/** Thread facts and linked work: pure, no git. */
export function threadEvidence(snapshot: IssueSnapshot, now = Date.now()): Omit<
  IssueEvidence,
  "codeRefs" | "codeRefsMissing" | "codeRefsChecked" | "commitsSinceOpened" | "commitsTouchingRefsSinceOpened" | "recentTouchingCommits" | "baseSha" | "git" | "notes"
> {
  const comments = snapshot.comments.filter((c) => !/\[bot\]$/i.test(c.author));
  const last = comments.at(-1);
  const lastCommentBy: IssueEvidence["lastCommentBy"] = !last
    ? "none"
    : last.author === snapshot.author
      ? "author"
      : last.isMaintainer
        ? "maintainer"
        : "other";
  const lastMaintainer = [...comments].reverse().find((c) => c.isMaintainer && c.author !== snapshot.author);
  const lastActivity = [snapshot.createdAt, ...comments.map((c) => c.at)].sort().at(-1) ?? snapshot.createdAt;
  const participants = new Set([snapshot.author, ...comments.map((c) => c.author)]).size;

  const opened = Date.parse(snapshot.createdAt);
  const mergedAfterOpen = snapshot.linkedPrs.filter(
    (p) => p.state === "merged" && p.mergedAt !== null && Date.parse(p.mergedAt) >= opened,
  );

  return {
    ageDays: days(snapshot.createdAt, now),
    daysSinceActivity: days(lastActivity, now),
    commentCount: comments.length,
    participants,
    lastCommentBy,
    daysSinceMaintainerComment: lastMaintainer ? days(lastMaintainer.at, now) : null,
    mergedLinkedPrs: mergedAfterOpen.length,
    mergedClosingPrs: mergedAfterOpen.filter((p) => p.closingKeyword).length,
    openLinkedPrs: snapshot.linkedPrs.filter((p) => p.state === "open").length,
  };
}

let repoPrepared: Promise<string | null> | null = null;
let preparedAt = 0;
const REFETCH_MS = 10 * 60_000;

/** Clone if needed and refresh master at most every ten minutes during a scan. */
async function defaultBranchSha(): Promise<string | null> {
  if (repoPrepared && Date.now() - preparedAt < REFETCH_MS) return repoPrepared;
  preparedAt = Date.now();
  repoPrepared = (async () => {
    if (!(await gitIsAvailable())) return null;
    await ensureRepo();
    await fetchBase("master");
    return resolveRev("origin/master");
  })().catch((err: unknown) => {
    console.warn(`[issues] default branch unavailable: ${(err as Error).message}`);
    repoPrepared = null;
    return null;
  });
  return repoPrepared;
}

/** Test seam. */
export function resetIssueRepoState(): void {
  repoPrepared = null;
  preparedAt = 0;
}

export async function buildIssueEvidence(
  snapshot: IssueSnapshot,
  repoFull: string,
  opts: { now?: number; git?: boolean } = {},
): Promise<IssueEvidence> {
  const now = opts.now ?? Date.now();
  const base = threadEvidence(snapshot, now);
  const notes: string[] = [];
  const text = issueText(snapshot);
  const symbols = extractSymbols(text);

  const unchecked = (paths: string[]): IssueEvidence => ({
    ...base,
    codeRefs: [
      ...paths.map((p): CodeRef => ({ kind: "path", text: p, status: "unchecked", matches: [], commitsSince: 0 })),
      ...symbols.map((s): CodeRef => ({ kind: "symbol", text: s, status: "unchecked", matches: [], commitsSince: 0 })),
    ],
    codeRefsMissing: 0,
    codeRefsChecked: 0,
    commitsSinceOpened: null,
    commitsTouchingRefsSinceOpened: null,
    recentTouchingCommits: [],
    baseSha: null,
    git: false,
    notes,
  });

  if (opts.git === false) {
    notes.push("git disabled for this evaluation; code references were not checked");
    return unchecked(extractPaths(text, new Set(["lib", "src", "include", "components", "data"]), repoFull));
  }

  const sha = await defaultBranchSha();
  if (!sha) {
    notes.push("no local clone of the default branch, so code references were not checked");
    return unchecked(extractPaths(text, new Set(["lib", "src", "include", "components", "data"]), repoFull));
  }

  const files = await listAllFiles(sha);
  const topLevel = new Set(files.map((f) => f.split("/")[0] ?? "").filter((x) => x !== ""));
  const paths = extractPaths(text, topLevel, repoFull);
  const since = snapshot.createdAt;

  const refs: CodeRef[] = [];
  const touchedPaths: string[] = [];
  for (const p of paths) {
    const { status, matches } = checkPath(p, files);
    let commitsSince = 0;
    const target = status === "exists" ? (p.includes("/") ? p : matches[0]) : undefined;
    if (target && !target.includes(" (")) {
      touchedPaths.push(target);
      try {
        commitsSince = (await logSince(sha, since, [target], 500)).length;
      } catch {
        // a path git refuses is reported with no commit count
      }
    }
    refs.push({ kind: "path", text: p, status, matches, commitsSince });
  }

  for (const s of symbols) {
    try {
      const hits = (await grep(escapeRegex(s), sha, undefined, 40)).filter((h) => isFirstPartyCode(h.path));
      refs.push({
        kind: "symbol",
        text: s,
        status: hits.length > 0 ? "exists" : "missing",
        matches: hits.slice(0, 3).map((h) => `${h.path}:${h.line}`),
        commitsSince: 0,
      });
    } catch (err) {
      notes.push(`symbol ${s} not checked: ${(err as Error).message.slice(0, 120)}`);
      refs.push({ kind: "symbol", text: s, status: "unchecked", matches: [], commitsSince: 0 });
    }
  }

  let commitsSinceOpened: number | null = null;
  let touching: Array<{ sha: string; date: string; subject: string }> = [];
  let commitsTouching: number | null = null;
  try {
    commitsSinceOpened = await countSince(sha, since);
    if (touchedPaths.length > 0) {
      const log = await logSince(sha, since, touchedPaths, 500);
      commitsTouching = log.length;
      touching = log.slice(0, 8).map((e) => ({ sha: e.sha, date: e.date, subject: e.subject }));
    }
  } catch (err) {
    notes.push(`history since the issue opened is unavailable: ${(err as Error).message.slice(0, 120)}`);
  }

  const checked = refs.filter((r) => r.status !== "unchecked");
  return {
    ...base,
    codeRefs: refs,
    codeRefsMissing: checked.filter((r) => r.status === "missing" || r.status === "renamed_or_moved").length,
    codeRefsChecked: checked.length,
    commitsSinceOpened,
    commitsTouchingRefsSinceOpened: commitsTouching,
    recentTouchingCommits: touching,
    baseSha: sha,
    git: true,
    notes,
  };
}
