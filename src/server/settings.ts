// Admin settings: the catalog of every environment variable the server reads,
// plus reading, validating, persisting and live-applying them.
//
// The .env file at the project root is the source of truth the UI edits. It is
// rewritten line by line — every comment, blank line and ordering survives — and
// written through a tmp file + rename like everything else in store.ts.
//
// Two things are deliberately conservative here:
//
//   * A secret is never returned in full. The API hands out a mask, and a PUT
//     that submits exactly that mask back is treated as "unchanged", so the UI
//     can round-trip its own form without ever holding the real value.
//   * requiresRestart keys are written to .env but never applied to the live
//     process: PORT is already bound and the path/dir seams are module-level
//     constants. They are reported in `restartRequired` instead.
//
// NodeNext resolution: relative imports need an explicit ".js" extension.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AdminSettings, SettingDef, SettingTestResult, SettingValue } from "../shared/types.js";
import { resetGithubAuthCache } from "./github.js";
import { resetModelCache } from "./llm.js";
import { resetRepoState } from "./repo.js";
import { PROJECT_ROOT } from "./store.js";

// --- the catalog ------------------------------------------------------------

/**
 * Every `process.env[...]` the server reads, in UI order. Anything not in this
 * list cannot be read or written through the admin API.
 *
 * NODE_ENV and VITEST are deliberately absent: they belong to the test runner,
 * not to the operator.
 */
export const SETTINGS: SettingDef[] = [
  // --- github ---------------------------------------------------------------
  {
    key: "GITHUB_TOKEN",
    label: "GitHub token",
    description:
      "GitHub REST v3 token. Leave unset to fall back to `gh auth token`, then to unauthenticated requests (60 per hour).",
    group: "github",
    secret: true,
    type: "string",
    default: null,
    requiresRestart: false,
  },
  {
    key: "GITHUB_REPO",
    label: "Repository",
    description: "The repository to triage, as owner/name.",
    group: "github",
    secret: false,
    type: "string",
    default: "FujiNetWIFI/fujinet-firmware",
    requiresRestart: false,
  },
  {
    key: "ALLOW_GITHUB_WRITES",
    label: "Allow GitHub writes",
    description:
      "On, a human-confirmed action may actually POST to GitHub. Off, every confirmed action is logged as refused and nothing is written.",
    group: "github",
    secret: false,
    type: "boolean",
    default: "0",
    requiresRestart: false,
  },

  // --- jev ------------------------------------------------------------------
  {
    key: "TYPESAFE_API_KEY",
    label: "TypeSafe API key",
    description: "TypeSafe AI key for Jev. Without it the server runs evaluations against the deterministic mock.",
    group: "jev",
    secret: true,
    type: "string",
    default: null,
    requiresRestart: false,
  },
  {
    key: "JEV_MODEL",
    label: "Jev model",
    description: "Jev model id sent with every System One request. Falls back to the model in config/policy.json.",
    group: "jev",
    secret: false,
    type: "string",
    default: "jev-latest",
    requiresRestart: false,
  },
  {
    key: "JEV_MOCK",
    label: "Force Jev mock",
    description: "On, never call Jev: every evaluation uses the deterministic mock answers in src/server/mock.ts.",
    group: "jev",
    secret: false,
    type: "boolean",
    default: "0",
    requiresRestart: false,
  },
  {
    key: "JEV_TRANSPORT",
    label: "Jev transport",
    description: "How live Jev calls are made: the TypeSafe SDK, or a plain HTTP client against the same endpoint.",
    group: "jev",
    secret: false,
    type: "enum",
    options: ["sdk", "http"],
    default: "sdk",
    requiresRestart: false,
  },

  // --- openrouter -----------------------------------------------------------
  {
    key: "OPENROUTER_API_KEY",
    label: "OpenRouter API key",
    description: "OpenRouter key for the tool-using deep-analysis model. Without it deep runs play a scripted mock.",
    group: "openrouter",
    secret: true,
    type: "string",
    default: null,
    requiresRestart: false,
  },
  {
    key: "OPENROUTER_MODEL",
    label: "OpenRouter model",
    description: "Default model for deep runs. Any tool-capable model from the OpenRouter listing works.",
    group: "openrouter",
    secret: false,
    type: "string",
    default: "anthropic/claude-haiku-4.5",
    requiresRestart: false,
  },

  // --- deep -----------------------------------------------------------------
  {
    key: "DEEP_MAX_STEPS",
    label: "Max tool rounds",
    description: "Tool-calling rounds a deep run may take before it aborts with a partial brief.",
    group: "deep",
    secret: false,
    type: "number",
    default: "30",
    requiresRestart: false,
  },
  {
    key: "DEEP_MAX_COST_USD",
    label: "Per-run cost cap (USD)",
    description: "Ceiling for a single deep run, enforced against the cost OpenRouter reports.",
    group: "deep",
    secret: false,
    type: "number",
    default: "0.50",
    requiresRestart: false,
  },
  {
    key: "DEEP_DAILY_CAP_USD",
    label: "Daily cost cap (USD)",
    description: "New deep runs are refused with 402 once today's runs total this much.",
    group: "deep",
    secret: false,
    type: "number",
    default: "5",
    requiresRestart: false,
  },
  {
    key: "DEEP_DOSSIER",
    label: "Build dossiers during scans",
    description: "Off, evaluation skips dossier building: faster scans, no deep questions and no dossier reasons.",
    group: "deep",
    secret: false,
    type: "boolean",
    default: "1",
    requiresRestart: false,
  },

  // --- server ---------------------------------------------------------------
  {
    key: "PORT",
    label: "Server port",
    description: "Port the Hono server listens on. The Vite dev server proxies /api here.",
    group: "server",
    secret: false,
    type: "number",
    default: "8787",
    requiresRestart: true,
  },
  {
    key: "DEEP_STORE_PATH",
    label: "Deep run store path",
    description: "Where deep runs are persisted. A test seam; the default is data/deep.json.",
    group: "server",
    secret: false,
    type: "string",
    default: null,
    requiresRestart: true,
  },
  {
    key: "DOSSIER_CACHE_DIR",
    label: "Dossier cache directory",
    description: "Where per-head-SHA dossiers are cached. A test seam; the default is data/dossier.",
    group: "server",
    secret: false,
    type: "string",
    default: null,
    requiresRestart: true,
  },
  {
    key: "DOTENV_PATH",
    label: ".env path",
    description: "The .env file the admin API reads and rewrites. A test seam; the default is .env at the project root.",
    group: "server",
    secret: false,
    type: "string",
    default: null,
    requiresRestart: true,
  },
];

const BY_KEY = new Map<string, SettingDef>(SETTINGS.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | null {
  return BY_KEY.get(key) ?? null;
}

// --- locations --------------------------------------------------------------

/** The .env this API reads and rewrites. DOTENV_PATH overrides it for tests. */
export function dotenvPath(): string {
  const override = process.env["DOTENV_PATH"]?.trim();
  return override ? resolve(override) : resolve(PROJECT_ROOT, ".env");
}

export function dotenvExamplePath(): string {
  return resolve(PROJECT_ROOT, ".env.example");
}

// --- masking ----------------------------------------------------------------

/**
 * First five characters, an ellipsis, the last three. Anything shorter than
 * twelve characters is reported only as "(set)" — a mask of a short secret
 * would give away most of it.
 */
export function maskSecret(value: string): string {
  if (value.length < 12) return "(set)";
  return `${value.slice(0, 5)}…${value.slice(-3)}`;
}

// --- .env parsing -----------------------------------------------------------

const LIVE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
// A disabled assignment (`#KEY=…`) is fair game to revive; a prose line that
// happens to mention `# KEY= …` is documentation and is only used as a last
// resort, so a comment explaining why a key is off survives the edit.
const COMMENTED_TIGHT_RE = /^\s*#(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const COMMENTED_LOOSE_RE = /^\s*#\s+(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function commentedKey(line: string): string | null {
  return COMMENTED_TIGHT_RE.exec(line)?.[1] ?? COMMENTED_LOOSE_RE.exec(line)?.[1] ?? null;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }
  // An unquoted value ends at an inline comment, the way dotenv reads it.
  const hash = v.indexOf(" #");
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/** Every KEY=value the file defines on a live (uncommented) line, last one winning. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = LIVE_RE.exec(line);
    if (m?.[1] !== undefined) out[m[1]] = unquote(m[2] ?? "");
  }
  return out;
}

export function readDotenvFile(path: string = dotenvPath()): { text: string; values: Record<string, string> } {
  if (!existsSync(path)) return { text: "", values: {} };
  const text = readFileSync(path, "utf8");
  return { text, values: parseDotenv(text) };
}

function quoteIfNeeded(value: string): string {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@+,%-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Rewrite `text` so it defines exactly the given updates, and nothing else
 * changes. A null update comments the key out rather than deleting the line, so
 * its documentation and position survive an unset/set round trip.
 *
 *   - a live `KEY=` line is rewritten where it stands (every occurrence, so a
 *     duplicate further down cannot shadow the edit);
 *   - failing that, a commented `#KEY=` line becomes the live one;
 *   - failing that, the key is appended at the end.
 */
export function renderDotenv(text: string, updates: Record<string, string | null>): string {
  const trailingNewline = text === "" || text.endsWith("\n");
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const appended: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const line = value === null ? `#${key}=` : `${key}=${quoteIfNeeded(value)}`;
    let placed = false;

    for (let i = 0; i < lines.length; i++) {
      const m = LIVE_RE.exec(lines[i] ?? "");
      if (m?.[1] === key) {
        lines[i] = line;
        placed = true;
      }
    }
    if (placed) continue;

    if (value !== null) {
      const tight = lines.findIndex((l) => COMMENTED_TIGHT_RE.exec(l)?.[1] === key);
      const loose = tight === -1 ? lines.findIndex((l) => COMMENTED_LOOSE_RE.exec(l)?.[1] === key) : -1;
      const at = tight === -1 ? loose : tight;
      if (at !== -1) {
        lines[at] = line;
        placed = true;
      }
    } else {
      // Unsetting a key the file only mentions in a comment is already true.
      placed = lines.some((l) => commentedKey(l) === key);
    }
    if (placed) continue;

    appended.push(line);
  }

  const all = appended.length > 0 ? [...lines, ...(lines.length > 0 && lines.at(-1) !== "" ? [""] : []), ...appended] : lines;
  const joined = all.join("\n");
  return joined === "" ? "" : trailingNewline || appended.length > 0 ? `${joined}\n` : joined;
}

function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Create the .env from .env.example (or empty) if it is missing, then rewrite it. */
export function writeDotenv(updates: Record<string, string | null>, path: string = dotenvPath()): void {
  let text = "";
  if (existsSync(path)) {
    text = readFileSync(path, "utf8");
  } else if (existsSync(dotenvExamplePath())) {
    text = readFileSync(dotenvExamplePath(), "utf8");
  }
  writeTextAtomic(path, renderDotenv(text, updates));
}

// --- validation -------------------------------------------------------------

/** null when the value is acceptable, else the message for the 400. */
export function validateSetting(def: SettingDef, value: string): string | null {
  if (/[\n\r]/.test(value)) return `${def.key} must not contain a newline`;
  switch (def.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return `${def.key} must be a number`;
      if (def.key === "PORT" && (!Number.isInteger(n) || n < 1 || n > 65535)) {
        return "PORT must be an integer between 1 and 65535";
      }
      if (def.key === "DEEP_MAX_STEPS" && (!Number.isInteger(n) || n < 1)) {
        return "DEEP_MAX_STEPS must be a positive integer";
      }
      if (def.key.endsWith("_USD") && n < 0) return `${def.key} must be zero or more`;
      if (n < 0) return `${def.key} must be zero or more`;
      return null;
    }
    case "boolean":
      return BOOLEANS.has(value.trim().toLowerCase()) ? null : `${def.key} must be one of 1, 0, true, false`;
    case "enum":
      return (def.options ?? []).includes(value)
        ? null
        : `${def.key} must be one of ${(def.options ?? []).join(", ")}`;
    case "string":
      if (def.key === "GITHUB_REPO" && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
        return "GITHUB_REPO must be owner/name";
      }
      return null;
  }
}

const BOOLEANS = new Map<string, string>([
  ["1", "1"],
  ["true", "1"],
  ["0", "0"],
  ["false", "0"],
]);

/** Booleans are stored as 1/0 whatever spelling came in; everything else is trimmed. */
export function normalizeSetting(def: SettingDef, value: string): string {
  if (def.type === "boolean") return BOOLEANS.get(value.trim().toLowerCase()) ?? value;
  return value.trim();
}

// --- reading ----------------------------------------------------------------

/** Keys whose requiresRestart value changed since the process started. */
const restartRequired = new Set<string>();

export function restartRequiredKeys(): string[] {
  return [...restartRequired].sort();
}

/** Test seam. */
export function resetRestartRequired(): void {
  restartRequired.clear();
}

function valueOf(def: SettingDef, dotenvValues: Record<string, string>): SettingValue {
  const live = process.env[def.key];
  const set = live !== undefined && live !== "";
  const fromFile = Object.prototype.hasOwnProperty.call(dotenvValues, def.key);
  // dotenv never overrides an existing variable, so a value that matches the
  // file's is the file's; anything else set was already in the environment.
  const source: SettingValue["source"] = !set
    ? "default"
    : fromFile && dotenvValues[def.key] === live
      ? "dotenv"
      : "env";
  const shown = !set ? null : def.secret ? maskSecret(live) : live;
  const effective = shown ?? (def.secret ? null : def.default);
  return { key: def.key, set, source, value: shown, effective };
}

export function readSettings(): AdminSettings {
  const path = dotenvPath();
  const { values } = readDotenvFile(path);
  return {
    defs: SETTINGS,
    values: SETTINGS.map((d) => valueOf(d, values)),
    dotenvPath: path,
    dotenvWritable: dotenvWritable(path),
    restartRequired: restartRequiredKeys(),
  };
}

/** Can we actually rewrite the file (or create it) without trying? */
function dotenvWritable(path: string): boolean {
  try {
    if (existsSync(path)) accessSync(path, constants.W_OK);
    else accessSync(resolve(path, ".."), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// --- applying ---------------------------------------------------------------

export class SettingsError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = "SettingsError";
    this.key = key;
  }
}

export interface ApplyResult {
  /** Keys whose stored value actually changed. */
  changed: string[];
  /** Of those, the ones that will only take effect after a restart. */
  deferred: string[];
}

/**
 * Validate, persist and (where it is safe) apply a batch of updates.
 *
 * A secret submitted as exactly the mask this API would have returned is a form
 * round-trip, not an edit, and is dropped before anything else happens.
 */
export function applySettings(updates: Record<string, string | null>): ApplyResult {
  const path = dotenvPath();
  const clean: Record<string, string | null> = {};

  for (const [key, raw] of Object.entries(updates)) {
    const def = settingDef(key);
    if (!def) throw new SettingsError(key, `unknown setting: ${key}`);
    if (raw !== null && typeof raw !== "string") throw new SettingsError(key, `${key} must be a string or null`);

    if (raw === null || raw === "") {
      clean[key] = null;
      continue;
    }
    const current = process.env[key];
    if (def.secret && current !== undefined && current !== "" && raw === maskSecret(current)) {
      continue; // the UI handed back its own mask
    }
    const message = validateSetting(def, raw);
    if (message !== null) throw new SettingsError(key, message);
    clean[key] = normalizeSetting(def, raw);
  }

  const changed: string[] = [];
  const deferred: string[] = [];
  const toWrite: Record<string, string | null> = {};
  const { values: onDisk } = readDotenvFile(path);
  for (const [key, value] of Object.entries(clean)) {
    const before = process.env[key] ?? null;
    const after = value;
    const inFile = onDisk[key] ?? null;
    if (before === after && inFile === after) continue;
    toWrite[key] = value;
    changed.push(key);
  }
  if (changed.length === 0) return { changed, deferred };

  writeDotenv(toWrite, path);

  for (const key of changed) {
    const def = settingDef(key) as SettingDef;
    if (def.requiresRestart) {
      restartRequired.add(key);
      deferred.push(key);
      continue;
    }
    const value = toWrite[key];
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  invalidateCaches(changed);
  return { changed, deferred };
}

/**
 * Everything else reads its environment variable on every call, so only the
 * caches that memoise a derived value need clearing here.
 */
export function invalidateCaches(keys: string[]): void {
  const touched = new Set(keys);
  if (touched.has("GITHUB_TOKEN") || touched.has("GITHUB_REPO")) resetGithubAuthCache();
  if (touched.has("GITHUB_REPO")) resetRepoState();
  if (touched.has("OPENROUTER_MODEL") || touched.has("OPENROUTER_API_KEY")) resetModelCache();
}

// --- connection tests -------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const TYPESAFE_MODELS = "https://api.typesafe.ai/v1/models";
const OPENROUTER_AUTH = "https://openrouter.ai/api/v1/auth/key";
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";

function result(key: string, ok: boolean, detail: string): SettingTestResult {
  return { key, ok, detail, checkedAt: new Date().toISOString() };
}

/** True when `text` carries a recognisable prefix of the secret. */
export function looksDerivedFrom(text: string, secret: string): boolean {
  for (let n = Math.min(secret.length, text.length); n >= 6; n--) {
    if (text.includes(secret.slice(0, n))) return true;
  }
  return false;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function modelIds(url: string, fetchImpl: typeof fetch, headers: Record<string, string> = {}): Promise<string[]> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown; models?: unknown };
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw === "string") out.push(raw);
    else if (raw && typeof raw === "object") {
      const id = (raw as Record<string, unknown>)["id"] ?? (raw as Record<string, unknown>)["name"];
      if (typeof id === "string") out.push(id);
    }
  }
  return out;
}

/**
 * Reach the service a setting configures and report what came back. No secret
 * value ever appears in `detail` — only what the far end says about it.
 */
export async function testSetting(key: string, fetchImpl: typeof fetch = fetch): Promise<SettingTestResult> {
  const def = settingDef(key);
  if (!def) throw new SettingsError(key, `unknown setting: ${key}`);

  switch (key) {
    case "TYPESAFE_API_KEY": {
      const jevKey = process.env["TYPESAFE_API_KEY"]?.trim();
      if (!jevKey) return result(key, false, "not set — evaluations run against the deterministic mock");
      try {
        const res = await fetchImpl(TYPESAFE_MODELS, {
          headers: { Accept: "application/json", Authorization: `Bearer ${jevKey}` },
        });
        if (!res.ok) return result(key, false, `TypeSafe returned HTTP ${res.status}`);
        const ids = await modelIds(TYPESAFE_MODELS, fetchImpl, { Authorization: `Bearer ${jevKey}` }).catch(() => []);
        return result(key, true, `key accepted; ${ids.length} model(s) available`);
      } catch (err) {
        return result(key, false, `could not reach TypeSafe: ${message(err)}`);
      }
    }

    case "GITHUB_TOKEN":
      return testGithubToken(fetchImpl);

    case "GITHUB_REPO":
      return testGithubRepo(fetchImpl);

    case "OPENROUTER_API_KEY": {
      const orKey = process.env["OPENROUTER_API_KEY"]?.trim();
      if (!orKey) return result(key, false, "not set — deep analysis plays a scripted mock");
      try {
        const res = await fetchImpl(OPENROUTER_AUTH, {
          headers: { Accept: "application/json", Authorization: `Bearer ${orKey}` },
        });
        if (!res.ok) return result(key, false, `OpenRouter returned HTTP ${res.status}`);
        const body = (await res.json()) as { data?: Record<string, unknown> };
        const data = body.data ?? {};
        const rawLabel = typeof data["label"] === "string" && data["label"] !== "" ? data["label"] : "";
        // OpenRouter often labels a key with a truncation of the key itself,
        // which must not end up in `detail`.
        const label = rawLabel === "" ? "(unlabelled key)" : looksDerivedFrom(rawLabel, orKey) ? "(key-derived label, hidden)" : `"${rawLabel}"`;
        const usage = typeof data["usage"] === "number" ? data["usage"] : 0;
        const limit = typeof data["limit"] === "number" ? `$${data["limit"].toFixed(2)}` : "no limit";
        return result(key, true, `key ${label} accepted; usage $${usage.toFixed(4)}, limit ${limit}`);
      } catch (err) {
        return result(key, false, `could not reach OpenRouter: ${message(err)}`);
      }
    }

    case "OPENROUTER_MODEL": {
      const want = process.env["OPENROUTER_MODEL"]?.trim() || (def.default ?? "");
      try {
        const ids = await modelIds(OPENROUTER_MODELS, fetchImpl);
        return ids.includes(want)
          ? result(key, true, `"${want}" is in the OpenRouter model list (${ids.length} models)`)
          : result(key, false, `"${want}" is not in the OpenRouter model list (${ids.length} models)`);
      } catch (err) {
        return result(key, false, `could not list OpenRouter models: ${message(err)}`);
      }
    }

    case "JEV_MODEL": {
      const want = process.env["JEV_MODEL"]?.trim() || (def.default ?? "");
      const jevKey = process.env["TYPESAFE_API_KEY"]?.trim();
      if (!jevKey) return result(key, false, `cannot check "${want}": TYPESAFE_API_KEY is not set`);
      try {
        const ids = await modelIds(TYPESAFE_MODELS, fetchImpl, { Authorization: `Bearer ${jevKey}` });
        return ids.includes(want)
          ? result(key, true, `"${want}" is in the TypeSafe model list (${ids.length} models)`)
          : result(key, false, `"${want}" is not in the TypeSafe model list (${ids.join(", ") || "none"})`);
      } catch (err) {
        return result(key, false, `could not list TypeSafe models: ${message(err)}`);
      }
    }

    default:
      return result(key, true, "no test for this setting");
  }
}

function githubHeaders(token: string | null): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "prMonster",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function ghTokenFallback(): { token: string | null; mode: "token" | "gh" | "anon" } {
  const env = process.env["GITHUB_TOKEN"]?.trim();
  if (env) return { token: env, mode: "token" };
  try {
    // The same fallback github.ts uses: `gh auth token`, then anonymous.
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) return { token: out, mode: "gh" };
  } catch {
    // gh missing or not logged in
  }
  return { token: null, mode: "anon" };
}

async function testGithubToken(fetchImpl: typeof fetch): Promise<SettingTestResult> {
  const key = "GITHUB_TOKEN";
  const { token, mode } = ghTokenFallback();
  const via = mode === "token" ? "GITHUB_TOKEN" : mode === "gh" ? "the `gh auth token` fallback" : "anonymous access";
  try {
    const parts: string[] = [];
    if (token === null) {
      parts.push("GITHUB_TOKEN is not set and `gh auth token` gave nothing, so requests are anonymous (60 per hour)");
    } else {
      const res = await fetchImpl(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
      if (!res.ok) return result(key, false, `GitHub /user returned HTTP ${res.status} via ${via}`);
      const user = (await res.json()) as { login?: unknown };
      const remaining = res.headers.get("x-ratelimit-remaining") ?? "?";
      const limit = res.headers.get("x-ratelimit-limit") ?? "?";
      parts.push(`authenticated as ${String(user.login ?? "?")} via ${via}; ${remaining}/${limit} requests left this hour`);
    }
    const repo = process.env["GITHUB_REPO"]?.trim() || "FujiNetWIFI/fujinet-firmware";
    const res = await fetchImpl(`${GITHUB_API}/repos/${repo}`, { headers: githubHeaders(token) });
    if (!res.ok) {
      const remaining = res.headers.get("x-ratelimit-remaining") ?? "?";
      parts.push(`but ${repo} returned HTTP ${res.status} (${remaining} requests left)`);
      return result(key, false, parts.join("; "));
    }
    parts.push(`${repo} is reachable`);
    return result(key, token !== null, parts.join("; "));
  } catch (err) {
    return result(key, false, `could not reach GitHub: ${message(err)}`);
  }
}

async function testGithubRepo(fetchImpl: typeof fetch): Promise<SettingTestResult> {
  const key = "GITHUB_REPO";
  const repo = process.env["GITHUB_REPO"]?.trim() || "FujiNetWIFI/fujinet-firmware";
  const { token } = ghTokenFallback();
  try {
    const res = await fetchImpl(`${GITHUB_API}/repos/${repo}`, { headers: githubHeaders(token) });
    if (!res.ok) return result(key, false, `${repo}: GitHub returned HTTP ${res.status}`);
    const body = (await res.json()) as { full_name?: unknown; open_issues_count?: unknown };
    const prs = await fetchImpl(`${GITHUB_API}/repos/${repo}/pulls?state=open&per_page=100`, {
      headers: githubHeaders(token),
    });
    if (!prs.ok) return result(key, false, `${repo} exists but its pull requests returned HTTP ${prs.status}`);
    const list = (await prs.json()) as unknown[];
    const count = Array.isArray(list) ? list.length : 0;
    const name = typeof body.full_name === "string" ? body.full_name : repo;
    return result(key, true, `${name} exists with ${count}${count === 100 ? "+" : ""} open pull request(s)`);
  } catch (err) {
    return result(key, false, `could not reach GitHub: ${message(err)}`);
  }
}
