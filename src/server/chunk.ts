// Unified-diff parser + chunk planner (DESIGN.md §4.3).
//
// Pure: no network, no fs, no env. gates.ts consumes `ParsedDiff` too, so the
// parser has to carry real line numbers for added lines.

import type { ChunkInfo, Policy } from "../shared/types.js";

/** "marker" is our own `[... N lines omitted ...]` line, never produced by the parser. */
export type DiffLineKind = "add" | "del" | "context" | "marker";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content with the leading +/-/space removed. */
  text: string;
  /** 1-based line number in the new file (add + context only). */
  newLine?: number;
  /** 1-based line number in the old file (del + context only). */
  oldLine?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "removed" | "renamed";

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface ParsedDiff {
  files: DiffFile[];
}

export interface AddedLine {
  path: string;
  line: number;
  text: string;
}

/**
 * Characters per token. DESIGN.md §2 suggests 3.5, but that is measured on
 * prose: real diffs are punctuation-dense, and a 24k-token budget estimated at
 * 3.5 produced states the API counted well past its 32k state+question limit
 * (observed as a 400 `max_tokens_exceeded` on PR 1605). 2.6 is the conservative
 * figure we budget against; the API's own `usage.input_tokens` is still what we
 * bill from.
 */
export const CHARS_PER_TOKEN = 2.6;

/** Conservative token estimate for code and diffs. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function unquotePath(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function stripPrefix(raw: string): string {
  const p = unquotePath(raw.trim());
  if (p === "/dev/null") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function splitGitHeader(line: string): { a?: string; b?: string } {
  const rest = line.slice("diff --git ".length);
  // Quoted form: "a/x" "b/y"
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(rest);
    if (m?.[1] && m[2]) return { a: stripPrefix(m[1]), b: stripPrefix(m[2]) };
  }
  // Unquoted: a/<path> b/<path>. Prefer the last " b/" so paths with spaces work.
  const idx = rest.lastIndexOf(" b/");
  if (idx > 0) {
    return { a: stripPrefix(rest.slice(0, idx)), b: stripPrefix(rest.slice(idx + 1)) };
  }
  return {};
}

/**
 * Parse a `git diff` / GitHub `application/vnd.github.v3.diff` payload.
 * Tolerant: unknown metadata lines are ignored rather than fatal.
 */
export function parseDiff(diff: string): ParsedDiff {
  const files: DiffFile[] = [];
  if (!diff) return { files };

  const lines = diff.split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let sawNewFileMode = false;
  let sawDeletedFileMode = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let headerA: string | undefined;
  let headerB: string | undefined;

  const closeFile = (): void => {
    if (!file) return;
    if (renameFrom && renameTo) {
      file.status = "renamed";
      file.oldPath = renameFrom;
      file.path = renameTo;
    } else if (sawNewFileMode) {
      file.status = "added";
    } else if (sawDeletedFileMode) {
      file.status = "removed";
    }
    files.push(file);
    file = null;
    hunk = null;
    sawNewFileMode = false;
    sawDeletedFileMode = false;
    renameFrom = undefined;
    renameTo = undefined;
    headerA = undefined;
    headerB = undefined;
  };

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line.startsWith("diff --git ")) {
      closeFile();
      const { a, b } = splitGitHeader(line);
      hunk = null;
      headerA = a;
      headerB = b;
      file = {
        path: b && b !== "/dev/null" ? b : (a ?? "unknown"),
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      if (a && b && a !== b) file.oldPath = a;
      continue;
    }

    if (!file) continue;

    if (line.startsWith("new file mode")) {
      sawNewFileMode = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      sawDeletedFileMode = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      renameFrom = stripPrefix(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      renameTo = stripPrefix(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("similarity index") ||
        line.startsWith("old mode") || line.startsWith("new mode") ||
        line.startsWith("dissimilarity index") || line.startsWith("copy from ") ||
        line.startsWith("copy to ")) {
      continue;
    }
    // `--- `/`+++ ` are file headers only *between* hunks. Inside a hunk they
    // are ordinary diff lines: a C++ `++ i;` renders as `+++ i;` and a removed
    // `-- i;` as `--- i;`. Treating those as headers used to start a bogus file
    // and misattribute every later added line, which silently defeated the hard
    // build_ifdef_in_shared_device gate.
    if (hunk === null && line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4));
      if (p === "/dev/null") sawNewFileMode = true;
      else if (!renameFrom) file.oldPath = p === file.path ? file.oldPath : p;
      continue;
    }
    if (hunk === null && line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      if (p === "/dev/null") sawDeletedFileMode = true;
      else file.path = p;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      hunk = {
        header: `@@ -${m[1]}${m[2] === undefined ? "" : `,${m[2]}`} +${m[3]}${m[4] === undefined ? "" : `,${m[4]}`} @@${m[5] ?? ""}`,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      file.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }

    if (!hunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newLine: newNo });
      newNo += 1;
      file.additions += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldLine: oldNo });
      oldNo += 1;
      file.deletions += 1;
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({ kind: "context", text: line.slice(1), oldLine: oldNo, newLine: newNo });
      oldNo += 1;
      newNo += 1;
    }
  }
  closeFile();

  // Silence "assigned but never read" for the header capture vars when a diff
  // carries no ---/+++ pair (binary-only files).
  void headerA;
  void headerB;
  return { files };
}

/** Every added line with its new-file line number, for gate evidence. */
export function addedLines(parsed: ParsedDiff): AddedLine[] {
  const out: AddedLine[] = [];
  for (const f of parsed.files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "add") out.push({ path: f.path, line: l.newLine ?? 0, text: l.text });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filtering and ordering
// ---------------------------------------------------------------------------

const KEEP_IN_WEB_DIRS = new Set([".html", ".js", ".css"]);
const IMAGE_FONT_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".bin", ".zip", ".gz", ".atr", ".po", ".dsk",
]);
const CODE_EXT = new Set([".c", ".cpp", ".cc", ".h", ".hpp", ".inl", ".py", ".s", ".asm"]);
const BUILD_EXT = new Set([".ini", ".cmake", ".sh", ".yml", ".yaml", ".json", ".mk", ".toml"]);
const DOC_EXT = new Set([".md", ".txt", ".rst"]);

function ext(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** Generated / never-hand-edited paths (CONTRIBUTING "Never hand-edit or commit these"). */
export function isGeneratedPath(path: string): boolean {
  return (
    path === "platformio-generated.ini" ||
    path === "platformio.ini" ||
    path === "dependencies.lock" ||
    path.startsWith("managed_components/") ||
    path.startsWith(".pio/") ||
    path.startsWith("build/") ||
    path.startsWith("firmware/") ||
    path.startsWith("data/BUILD_") ||
    path.includes("platformio-ini-files/platformio.common.ini") ||
    /(^|\/)sdkconfig\.[^/]*$/.test(path)
  );
}

export interface SkipDecision {
  skip: boolean;
  reason?: string;
}

/** Should this file be excluded from the Jev state entirely? */
export function skipFile(file: DiffFile): SkipDecision {
  const path = file.path;
  const e = ext(path);
  if (file.binary) return { skip: true, reason: "binary" };
  if (file.hunks.length === 0) return { skip: true, reason: "no textual hunks" };
  if (isGeneratedPath(path)) return { skip: true, reason: "generated or never-hand-edited" };
  if (e === ".lock" || path.endsWith(".lock")) return { skip: true, reason: "lock file" };
  if (e === ".csv") return { skip: true, reason: "csv partition table" };
  if (IMAGE_FONT_EXT.has(e)) return { skip: true, reason: "image, font, or binary asset" };
  if (path.startsWith("data/webui/") || path.startsWith("distfiles/")) {
    if (!KEEP_IN_WEB_DIRS.has(e)) return { skip: true, reason: "non-source file under a web asset directory" };
  }
  return { skip: false };
}

/** Lower number = reviewed first. */
export function relevanceRank(path: string): number {
  const e = ext(path);
  if ((path.startsWith("lib/") || path.startsWith("src/") || path.startsWith("include/")) && CODE_EXT.has(e)) return 0;
  if (path.startsWith("lib/") || path.startsWith("src/") || path.startsWith("include/")) return 1;
  if (path.startsWith("pico/")) return 2;
  if (path.startsWith("tests/") || path.startsWith("test/")) return 3;
  if (path.startsWith("data/webui/") || path.startsWith("distfiles/")) return 5;
  if (BUILD_EXT.has(e)) return 4;
  if (DOC_EXT.has(e)) return 6;
  return 4;
}

// ---------------------------------------------------------------------------
// Rendering + packing
// ---------------------------------------------------------------------------

function renderLine(l: DiffLine): string {
  if (l.kind === "marker") return l.text;
  return (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text;
}

function renderHunk(h: DiffHunk): string {
  return [h.header, ...h.lines.map(renderLine)].join("\n");
}

function renderFileHeader(f: DiffFile): string {
  const old = f.oldPath ?? f.path;
  return `--- a/${f.status === "added" ? "/dev/null" : old}\n+++ b/${f.status === "removed" ? "/dev/null" : f.path}`;
}

function renderFile(f: DiffFile, hunks: DiffHunk[]): string {
  return [renderFileHeader(f), ...hunks.map(renderHunk)].join("\n");
}

function omittedMarker(n: number): DiffLine {
  return { kind: "marker", text: `[... ${n} lines omitted ...]` };
}

/** Lines that came from the diff, ignoring any marker we added. */
function realLineCount(h: DiffHunk): number {
  return h.lines.reduce((a, l) => a + (l.kind === "marker" ? 0 : 1), 0);
}

/** Keep the first `keep` real lines of a hunk, replacing the rest with a marker. */
export function truncateHunkToLines(h: DiffHunk, keep: number): DiffHunk {
  const real = h.lines.filter((l) => l.kind !== "marker");
  if (keep >= real.length) return h;
  const kept = real.slice(0, Math.max(0, keep));
  return { ...h, lines: [...kept, omittedMarker(real.length - kept.length)] };
}

/** Cut a hunk down to `budgetTokens`, leaving an explicit marker. */
function truncateHunkToBudget(h: DiffHunk, budgetTokens: number): DiffHunk {
  if (estimateTokens(renderHunk(h)) <= budgetTokens) return h;
  const real = h.lines.filter((l) => l.kind !== "marker");
  let used = estimateTokens(h.header) + 20; // header + marker allowance
  let keep = 0;
  for (const l of real) {
    const t = estimateTokens(`${renderLine(l)}\n`);
    if (used + t > budgetTokens) break;
    used += t;
    keep += 1;
  }
  return truncateHunkToLines(h, keep);
}

export interface ChunkFileEntry {
  path: string;
  status: DiffFileStatus;
  /** Rendered unified diff: ---/+++ names and hunk headers, no index/diff --git. */
  diff: string;
  /**
   * The parsed slice of the file this entry renders. Kept so a chunk the API
   * rejects as too large can be split again at a hunk boundary without
   * re-parsing the rendered text.
   */
  source: DiffFile;
}

export interface PlannedChunk {
  index: number;
  files: ChunkFileEntry[];
  tokensEstimate: number;
  truncated: boolean;
}

export interface ChunkPlan {
  chunks: PlannedChunk[];
  /** Files excluded by rule or dropped past maxChunksPerPr, with the reason. */
  skippedFiles: string[];
  coverage: "full" | "partial";
  /** Path -> chunk index, for the UI's Files tab. */
  fileChunkIndex: Record<string, number>;
}

/** Tokens reserved inside a chunk request for pr_title, project_rules and JSON scaffolding. */
export const CHUNK_STATE_OVERHEAD_TOKENS = 900;

/** A chunk this small is not split again; if the API still rejects it, we give up on it. */
export const MIN_SPLIT_TOKENS = 2000;

function entryFor(f: DiffFile, hunks: DiffHunk[]): ChunkFileEntry {
  return {
    path: f.path,
    status: f.status,
    diff: renderFile(f, hunks),
    source: { ...f, hunks },
  };
}

function chunkOf(files: ChunkFileEntry[], truncated: boolean): PlannedChunk {
  return {
    index: -1,
    files,
    tokensEstimate: files.reduce((a, f) => a + estimateTokens(f.diff), 0),
    truncated,
  };
}

function hasTruncation(files: ChunkFileEntry[]): boolean {
  return files.some((f) => f.source.hunks.some((h) => h.lines.some((l) => l.kind === "marker")));
}

/**
 * Halve a chunk the API refused as too large.
 *
 * Several files -> split the file list at the token midpoint. One file, several
 * hunks -> split at a hunk boundary. One file, one hunk -> keep half its lines
 * and mark the rest omitted (a single chunk comes back, smaller than it went
 * in, so repeated calls still converge). `null` means it cannot usefully shrink
 * any further.
 *
 * Returned chunks carry index -1; the caller assigns real indices.
 */
export function splitChunk(chunk: PlannedChunk): PlannedChunk[] | null {
  if (chunk.tokensEstimate <= MIN_SPLIT_TOKENS) return null;

  if (chunk.files.length > 1) {
    const total = chunk.tokensEstimate;
    let running = 0;
    let cut = 0;
    for (; cut < chunk.files.length - 1; cut++) {
      running += estimateTokens(chunk.files[cut]!.diff);
      if (running >= total / 2) break;
    }
    const a = chunk.files.slice(0, cut + 1);
    const b = chunk.files.slice(cut + 1);
    if (a.length === 0 || b.length === 0) return null;
    return [chunkOf(a, hasTruncation(a)), chunkOf(b, hasTruncation(b))];
  }

  const entry = chunk.files[0];
  if (!entry) return null;
  const f = entry.source;

  if (f.hunks.length > 1) {
    const half = Math.max(1, Math.floor(f.hunks.length / 2));
    const a = [entryFor(f, f.hunks.slice(0, half))];
    const b = [entryFor(f, f.hunks.slice(half))];
    return [chunkOf(a, hasTruncation(a)), chunkOf(b, hasTruncation(b))];
  }

  const h = f.hunks[0];
  if (!h) return null;
  const real = realLineCount(h);
  if (real < 4) return null;
  return [chunkOf([entryFor(f, [truncateHunkToLines(h, Math.floor(real / 2))])], true)];
}

export function planChunks(parsed: ParsedDiff, policy: Pick<Policy, "jev">): ChunkPlan {
  const budget = Math.max(500, policy.jev.maxStateTokens - CHUNK_STATE_OVERHEAD_TOKENS);
  const skipped: string[] = [];
  const keep: DiffFile[] = [];

  for (const f of parsed.files) {
    const d = skipFile(f);
    if (d.skip) skipped.push(`${f.path} (${d.reason ?? "skipped"})`);
    else keep.push(f);
  }

  keep.sort((a, b) => {
    const ra = relevanceRank(a.path);
    const rb = relevanceRank(b.path);
    if (ra !== rb) return ra - rb;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const chunks: PlannedChunk[] = [];
  let current: ChunkFileEntry[] = [];
  let currentTokens = 0;
  let currentTruncated = false;

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({
      index: chunks.length,
      files: current,
      tokensEstimate: currentTokens,
      truncated: currentTruncated,
    });
    current = [];
    currentTokens = 0;
    currentTruncated = false;
  };

  for (const f of keep) {
    const whole = entryFor(f, f.hunks);
    const wholeTokens = estimateTokens(whole.diff);

    if (wholeTokens <= budget) {
      if (currentTokens + wholeTokens > budget) flush();
      current.push(whole);
      currentTokens += wholeTokens;
      continue;
    }

    // File alone is over budget: split at hunk boundaries, one part per chunk.
    flush();
    const headerTokens = estimateTokens(renderFileHeader(f));
    let part: DiffHunk[] = [];
    let partTokens = headerTokens;

    const flushPart = (): void => {
      if (part.length === 0) return;
      const entry = entryFor(f, part);
      chunks.push({
        index: chunks.length,
        files: [entry],
        tokensEstimate: partTokens,
        truncated: false,
      });
      part = [];
      partTokens = headerTokens;
    };

    for (const h of f.hunks) {
      const hTokens = estimateTokens(renderHunk(h));
      if (headerTokens + hTokens > budget) {
        // A single hunk bigger than the whole budget: emit it truncated, alone.
        flushPart();
        const entry = entryFor(f, [truncateHunkToBudget(h, budget - headerTokens)]);
        chunks.push({
          index: chunks.length,
          files: [entry],
          tokensEstimate: estimateTokens(entry.diff),
          truncated: true,
        });
        continue;
      }
      if (partTokens + hTokens > budget) flushPart();
      part.push(h);
      partTokens += hTokens;
    }
    flushPart();
  }
  flush();

  // Cap total chunks.
  const max = Math.max(1, policy.jev.maxChunksPerPr);
  let coverage: "full" | "partial" = "full";
  let kept = chunks;
  if (chunks.length > max) {
    kept = chunks.slice(0, max);
    coverage = "partial";
    const keptPaths = new Set(kept.flatMap((c) => c.files.map((f) => f.path)));
    for (const dropped of chunks.slice(max)) {
      for (const f of dropped.files) {
        if (!keptPaths.has(f.path)) skipped.push(`${f.path} (past maxChunksPerPr=${max})`);
      }
    }
  }
  if (kept.some((c) => c.truncated)) coverage = "partial";

  const fileChunkIndex: Record<string, number> = {};
  kept.forEach((c, i) => {
    c.index = i;
    for (const f of c.files) if (!(f.path in fileChunkIndex)) fileChunkIndex[f.path] = i;
  });

  return { chunks: kept, skippedFiles: skipped, coverage, fileChunkIndex };
}

export function chunkInfo(c: PlannedChunk): ChunkInfo {
  return {
    index: c.index,
    files: c.files.map((f) => f.path),
    tokensEstimate: c.tokensEstimate,
    truncated: c.truncated,
  };
}
