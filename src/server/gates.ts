// Deterministic policy gates (DESIGN.md §4.2).
//
// Pure functions over (PrSnapshot, ParsedDiff). No network, no fs, no env.
// Every gate returns a GateResult; policy.gates may override severity or turn
// a gate "off" (decide.ts ignores "off" gates but the UI still lists them).

import type { GateResult, Policy, PrSnapshot, Severity, SizeBucket } from "../shared/types.js";
import { addedLines, type AddedLine, type ParsedDiff } from "./chunk.js";

const MAX_EVIDENCE = 5;

function evidence(lines: AddedLine[]): string[] {
  return lines.slice(0, MAX_EVIDENCE).map((l) => `${l.path}:${l.line}: ${l.text.trim()}`);
}

function gate(
  id: string,
  severity: Severity,
  passed: boolean,
  detail: string,
  extra?: { evidence?: string[]; value?: string | number | string[] },
): GateResult {
  const g: GateResult = { id, severity, passed, detail };
  if (extra?.evidence && extra.evidence.length > 0) g.evidence = extra.evidence;
  if (extra?.value !== undefined) g.value = extra.value;
  return g;
}

// --- path helpers -----------------------------------------------------------

const FORBIDDEN_PATTERNS: RegExp[] = [
  /platformio-generated\.ini/,
  /^platformio\.ini$/,
  /platformio-ini-files\/platformio\.common\.ini/,
  /^managed_components\//,
  /^\.pio\//,
  /^build\//,
  /^firmware\//,
  /dependencies\.lock/,
  /^data\/BUILD_/,
];

const SHARED_DEVICE_DIRS = [
  "lib/device/fujiDevice/",
  "lib/device/fujiClock/",
  "lib/device/NDevice/",
];

const KNOWN_PLATFORMS = new Set([
  "adam", "apple", "atari", "coco", "cx16", "h89", "iec", "lynx", "mac",
  "rc2014", "rs232", "s100", "astrocade", "iwm", "sio", "drivewire", "adamnet",
  "apple2", "new_target",
]);

const SHARED_DIR_NAMES = new Set(["fujidevice", "fujiclock", "ndevice", "fuji", "common"]);

function isFirmwarePath(path: string): boolean {
  if (!(path.startsWith("lib/") || path.startsWith("src/"))) return false;
  if (path.startsWith("tests/") || path.startsWith("test/")) return false;
  if (path.includes("components_pc/") || path.startsWith("pico/")) return false;
  return true;
}

function isCppPath(path: string): boolean {
  return /\.(cpp|cc|c|h|hpp|inl)$/i.test(path);
}

/** A `//` or block-comment line is prose, not code: gates must not fire on it. */
function isCommentLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

function platformFromPath(path: string): string | null {
  const m = /^lib\/(?:bus|device|media)\/([^/]+)\//.exec(path);
  if (m?.[1]) {
    const seg = m[1].toLowerCase();
    if (!SHARED_DIR_NAMES.has(seg)) return seg;
    return null;
  }
  const p = /^pico\/([^/]+)\//.exec(path);
  if (p?.[1]) return p[1].toLowerCase();
  const pin = /^include\/pinmap\/([^/]+)\./.exec(path);
  if (pin?.[1]) return pin[1].toLowerCase();
  return null;
}

// --- individual gates -------------------------------------------------------

function notDraft(pr: PrSnapshot): GateResult {
  return gate("not_draft", "hard", pr.draft === false,
    pr.draft ? "Pull request is still a draft" : "Not a draft");
}

function mergeable(pr: PrSnapshot): GateResult {
  if (pr.mergeable === null) {
    return gate("mergeable", "info", true,
      `Mergeability not yet computed by GitHub (state "${pr.mergeableState}")`);
  }
  return gate("mergeable", "hard", pr.mergeable !== false,
    pr.mergeable ? "Merges cleanly" : `Cannot merge (state "${pr.mergeableState}")`);
}

// `action_required` usually means a maintainer must approve a first-time
// contributor's workflow run, so it belongs with "pending", not "failed".
const BAD_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "stale"]);

function ciGreen(pr: PrSnapshot): GateResult {
  const failed = pr.checks.filter((c) => c.conclusion !== null && BAD_CONCLUSIONS.has(c.conclusion));
  return gate("ci_green", "hard", failed.length === 0,
    failed.length === 0
      ? pr.checks.length === 0 ? "No check-runs reported" : `All ${pr.checks.length} check-runs are non-failing`
      : `${failed.length} check-run(s) failed`,
    { evidence: failed.slice(0, MAX_EVIDENCE).map((c) => `${c.name}: ${c.conclusion}`) });
}

function ciPending(pr: PrSnapshot): GateResult {
  const pending = pr.checks.filter(
    (c) => c.conclusion === null || c.conclusion === "action_required" || c.status !== "completed",
  );
  return gate("ci_pending", "soft", pending.length === 0,
    pending.length === 0
      ? "No check-runs are pending"
      : `${pending.length} check-run(s) still queued, running, or waiting for maintainer approval`,
    { evidence: pending.slice(0, MAX_EVIDENCE).map((c) => `${c.name}: ${c.conclusion ?? c.status}`) });
}

function forbiddenFiles(pr: PrSnapshot): GateResult {
  const hits = pr.files.map((f) => f.path).filter((p) => FORBIDDEN_PATTERNS.some((re) => re.test(p)));
  return gate("forbidden_files", "hard", hits.length === 0,
    hits.length === 0 ? "No generated or never-hand-edited file touched"
      : `${hits.length} never-hand-edited path(s) touched`,
    { evidence: hits.slice(0, MAX_EVIDENCE), value: hits });
}

function buildIfdefInSharedDevice(added: AddedLine[]): GateResult {
  const re = /^\s*#\s*(if|ifdef|ifndef|elif)\b.*\bBUILD_[A-Z0-9_]+/;
  const hits = added.filter((l) => SHARED_DEVICE_DIRS.some((d) => l.path.startsWith(d)) && re.test(l.text));
  return gate("build_ifdef_in_shared_device", "hard", hits.length === 0,
    hits.length === 0 ? "No BUILD_* conditional added to a shared device base"
      : `${hits.length} BUILD_* conditional(s) added under a shared device base (fails the no_build_ifdefs_in_fujidevice ctest)`,
    { evidence: evidence(hits) });
}

function sdkconfigChurn(pr: PrSnapshot): GateResult {
  const paths = pr.files.map((f) => f.path);
  const config = paths.filter((p) => /(^|\/)sdkconfig\./.test(p) || p === "include/version.h");
  const source = paths.filter((p) => isCppPath(p) && !/(^|\/)sdkconfig\./.test(p) && p !== "include/version.h");
  const bad = config.length > 0 && source.length > 0;
  return gate("sdkconfig_churn", "soft", !bad,
    bad ? `Build-rewritten files (${config.join(", ")}) are mixed into a source change`
      : "No incidental sdkconfig / version.h churn",
    { evidence: config.slice(0, MAX_EVIDENCE), value: config });
}

function throwInFirmware(added: AddedLine[]): GateResult {
  const re = /\bthrow\b|\btry\s*\{/;
  const hits = added.filter(
    (l) => isFirmwarePath(l.path) && isCppPath(l.path) && !isCommentLine(l.text) && re.test(l.text),
  );
  return gate("throw_in_firmware", "soft", hits.length === 0,
    hits.length === 0 ? "No exceptions added on firmware paths"
      : `${hits.length} added line(s) use throw/try on a firmware path (exceptions are disabled)`,
    { evidence: evidence(hits) });
}

function arduinoString(added: AddedLine[]): GateResult {
  const re = /\bString\s+\w+\s*[=;({]|\bString\(/;
  const hits = added.filter(
    (l) => isFirmwarePath(l.path) && isCppPath(l.path) && !isCommentLine(l.text) && re.test(l.text),
  );
  return gate("arduino_string", "soft", hits.length === 0,
    hits.length === 0 ? "No Arduino String introduced"
      : `${hits.length} added line(s) use Arduino String instead of std::string`,
    { evidence: evidence(hits) });
}

function fujiErrorUnspecified(added: AddedLine[]): GateResult {
  const re = /[=!]=\s*FUJI_ERROR::UNSPECIFIED|FUJI_ERROR::UNSPECIFIED\s*[=!]=/;
  const hits = added.filter((l) => re.test(l.text));
  return gate("fuji_error_unspecified", "soft", hits.length === 0,
    hits.length === 0 ? "No comparison against FUJI_ERROR::UNSPECIFIED"
      : `${hits.length} added line(s) compare against FUJI_ERROR::UNSPECIFIED instead of FUJI_ERROR::NONE`,
    { evidence: evidence(hits) });
}

function htoleBitshift(added: AddedLine[]): GateResult {
  const re = /\b(?:hto(?:le|be)(?:16|32|64)|(?:le|be)(?:16|32|64)toh)\b/;
  const hits = added.filter((l) => re.test(l.text));
  return gate("htole_bitshift", "soft", hits.length === 0,
    hits.length === 0 ? "No hand-rolled endian conversion"
      : `${hits.length} added line(s) call htole*/htobe* instead of the u*le_t / u*be_t wire types`,
    { evidence: evidence(hits) });
}

function deadTestDir(pr: PrSnapshot): GateResult {
  const hits = pr.files.map((f) => f.path).filter((p) => p.startsWith("test/"));
  return gate("dead_test_dir", "soft", hits.length === 0,
    hits.length === 0 ? "No change under the stale test/ directory"
      : `${hits.length} path(s) under test/ (singular), which is dead; new tests belong in tests/`,
    { evidence: hits.slice(0, MAX_EVIDENCE), value: hits });
}

function trailingWhitespace(added: AddedLine[]): GateResult {
  const hits = added.filter((l) => {
    if (/[ \t]$/.test(l.text)) return true;
    return isCppPath(l.path) && l.text.includes("\t");
  });
  return gate("trailing_whitespace", "soft", hits.length === 0,
    hits.length === 0 ? "No trailing whitespace or tabs added"
      : `${hits.length} added line(s) carry trailing whitespace or a tab`,
    { evidence: hits.slice(0, MAX_EVIDENCE).map((l) => `${l.path}:${l.line}: ${JSON.stringify(l.text)}`), value: hits.length });
}

export function sizeBucketOf(total: number): SizeBucket {
  if (total <= 20) return "tiny";
  if (total <= 150) return "small";
  if (total <= 600) return "medium";
  if (total <= 2000) return "large";
  return "huge";
}

function sizeBucketGate(pr: PrSnapshot): GateResult {
  const total = pr.additions + pr.deletions;
  const bucket = sizeBucketOf(total);
  return gate("size_bucket", "info", true,
    `${total} changed lines across ${pr.changedFiles} file(s) — ${bucket}`, { value: bucket });
}

function sharedCodeTouched(pr: PrSnapshot): GateResult {
  const hits = pr.files.map((f) => f.path).filter((p) => {
    if (p === "src/main.cpp") return true;
    if (!p.startsWith("lib/")) return false;
    return platformFromPath(p) === null;
  });
  return gate("shared_code_touched", "info", true,
    hits.length === 0 ? "No shared code touched" : `${hits.length} shared file(s) touched`,
    { evidence: hits.slice(0, MAX_EVIDENCE), value: hits.length > 0 ? "yes" : "no" });
}

function platformScope(pr: PrSnapshot, added: AddedLine[]): GateResult {
  const set = new Set<string>();
  for (const f of pr.files) {
    const p = platformFromPath(f.path);
    if (p) set.add(p);
  }
  for (const l of added) {
    for (const m of l.text.matchAll(/\bBUILD_([A-Z0-9_]+)\b/g)) {
      const tok = (m[1] ?? "").toLowerCase();
      if (KNOWN_PLATFORMS.has(tok)) set.add(tok);
    }
  }
  const platforms = [...set].sort();
  return gate("platform_scope", "info", true,
    platforms.length === 0 ? "No platform inferred from paths" : `Platforms: ${platforms.join(", ")}`,
    { value: platforms });
}

function hasDescription(pr: PrSnapshot): GateResult {
  const len = pr.body.replace(/\s+/g, " ").trim().length;
  return gate("has_description", "soft", len >= 40,
    len >= 40 ? `Description is ${len} characters` : `Description is only ${len} characters`,
    { value: len });
}

function ageDays(pr: PrSnapshot, now: number): GateResult {
  const created = Date.parse(pr.createdAt);
  const days = Number.isFinite(created) ? Math.floor((now - created) / 86_400_000) : 0;
  return gate("age_days", "info", true,
    days > 90 ? `Opened ${days} days ago — stale` : `Opened ${days} days ago`, { value: days });
}

function hasUnresolvedReviews(pr: PrSnapshot): GateResult {
  const blocking = Object.entries(pr.latestReviewStates)
    .filter(([, s]) => s === "CHANGES_REQUESTED")
    .map(([who]) => who);
  return gate("has_unresolved_reviews", "info", blocking.length === 0,
    blocking.length === 0 ? "No outstanding change requests"
      : `Changes requested by ${blocking.join(", ")}`,
    { value: blocking });
}

// --- runner -----------------------------------------------------------------

export function runGates(
  snapshot: PrSnapshot,
  diff: ParsedDiff,
  policy: Pick<Policy, "gates">,
  now: number = Date.now(),
): GateResult[] {
  const added = addedLines(diff);

  const results: GateResult[] = [
    notDraft(snapshot),
    mergeable(snapshot),
    ciGreen(snapshot),
    ciPending(snapshot),
    forbiddenFiles(snapshot),
    buildIfdefInSharedDevice(added),
    sdkconfigChurn(snapshot),
    throwInFirmware(added),
    arduinoString(added),
    fujiErrorUnspecified(added),
    htoleBitshift(added),
    deadTestDir(snapshot),
    trailingWhitespace(added),
    sizeBucketGate(snapshot),
    sharedCodeTouched(snapshot),
    platformScope(snapshot, added),
    hasDescription(snapshot),
    ageDays(snapshot, now),
    hasUnresolvedReviews(snapshot),
  ];

  const overrides = policy.gates ?? {};
  return results.map((g) => {
    const o = overrides[g.id];
    return o ? { ...g, severity: o } : g;
  });
}

/** The size bucket a gate run recorded, for decide.ts and the Jev state. */
export function sizeBucketFromGates(gates: GateResult[]): SizeBucket {
  const g = gates.find((x) => x.id === "size_bucket");
  const v = typeof g?.value === "string" ? g.value : "medium";
  return (["tiny", "small", "medium", "large", "huge"] as const).includes(v as SizeBucket)
    ? (v as SizeBucket)
    : "medium";
}

export function platformsFromGates(gates: GateResult[]): string[] {
  const g = gates.find((x) => x.id === "platform_scope");
  return Array.isArray(g?.value) ? (g.value as string[]) : [];
}

export function sharedCodeFromGates(gates: GateResult[]): boolean {
  const g = gates.find((x) => x.id === "shared_code_touched");
  return g?.value === "yes";
}
