// OpenRouter client for deep analysis (DESIGN-deep.md "OpenRouter client").
//
// One interface, two implementations: the real HTTP client and a scripted mock
// that plays a fixed tool sequence. Everything above this file is written
// against `LlmBackend`, so the loop, the caps and the tests never care which
// one is in play.

import type { DeepModel } from "../shared/types.js";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const REFERER = "https://github.com/dillera/prMonster";
const TITLE = "prMonster";

// --- OpenAI-compatible wire shapes ------------------------------------------

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LlmToolCall[];
  /** Set on role "tool" replies, matching the call being answered. */
  tool_call_id?: string;
  name?: string;
}

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ChatResponse {
  message: LlmMessage;
  usage: ChatUsage;
  finishReason: string | null;
  model: string;
}

export interface LlmBackend {
  readonly label: string;
  readonly mock: boolean;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

export class LlmError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

// --- env --------------------------------------------------------------------

export function openRouterKey(): string | null {
  const k = process.env["OPENROUTER_API_KEY"]?.trim();
  return k ? k : null;
}

export function configuredModel(): string {
  return process.env["OPENROUTER_MODEL"]?.trim() || DEFAULT_MODEL;
}

function envNumber(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function maxSteps(): number {
  return Math.floor(envNumber("DEEP_MAX_STEPS", 30));
}

export function maxCostUsd(): number {
  return envNumber("DEEP_MAX_COST_USD", 0.5);
}

export function dailyCapUsd(): number {
  return envNumber("DEEP_DAILY_CAP_USD", 5);
}

// --- the HTTP client --------------------------------------------------------

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class OpenRouterBackend implements LlmBackend {
  readonly label = "openrouter";
  readonly mock = false;
  readonly #opts: Required<Omit<OpenRouterOptions, "fetchImpl" | "sleep">> & {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };

  constructor(opts: OpenRouterOptions) {
    this.#opts = {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? OPENROUTER_BASE,
      maxAttempts: opts.maxAttempts ?? 4,
      timeoutMs: opts.timeoutMs ?? 120_000,
      fetchImpl: opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const { apiKey, baseUrl, maxAttempts, timeoutMs, fetchImpl, sleep } = this.#opts;
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      tool_choice: "auto",
      max_tokens: req.maxTokens ?? 4096,
      temperature: 0.2,
      // Asks OpenRouter to return the real USD cost of the call, which is what
      // the per-run and per-day caps are enforced against.
      usage: { include: true },
    });

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw new LlmError("aborted");
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": REFERER,
            "X-Title": TITLE,
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new LlmError("aborted");
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxAttempts) break;
        await sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      if (res.ok) return parseChatResponse(await res.json(), req.model);

      const text = await res.text().catch(() => "");
      lastError = new LlmError(`OpenRouter ${res.status}: ${text.slice(0, 500)}`, res.status);
      if (!(res.status === 429 || res.status >= 500) || attempt === maxAttempts) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(60_000, retryAfter * 1000) : backoff(attempt));
    }
    throw lastError ?? new LlmError("OpenRouter request failed");
  }
}

function backoff(attempt: number): number {
  return Math.round(Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.25));
}

export function parseChatResponse(raw: unknown, fallbackModel: string): ChatResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(r["choices"]) ? (r["choices"] as Array<Record<string, unknown>>) : [];
  const first = choices[0] ?? {};
  const msg = (first["message"] ?? {}) as Record<string, unknown>;
  const usage = (r["usage"] ?? {}) as Record<string, unknown>;

  const toolCalls: LlmToolCall[] = Array.isArray(msg["tool_calls"])
    ? (msg["tool_calls"] as Array<Record<string, unknown>>).map((t, i) => {
        const fn = (t["function"] ?? {}) as Record<string, unknown>;
        return {
          id: typeof t["id"] === "string" ? t["id"] : `call_${i}`,
          type: "function",
          function: {
            name: typeof fn["name"] === "string" ? fn["name"] : "",
            arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "{}",
          },
        };
      })
    : [];

  const message: LlmMessage = {
    role: "assistant",
    content: typeof msg["content"] === "string" ? msg["content"] : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    message,
    usage: {
      promptTokens: num(usage["prompt_tokens"]),
      completionTokens: num(usage["completion_tokens"]),
      costUsd: num(usage["cost"]),
    },
    finishReason: typeof first["finish_reason"] === "string" ? first["finish_reason"] : null,
    model: typeof r["model"] === "string" ? r["model"] : fallbackModel,
  };
}

// --- model catalogue --------------------------------------------------------

interface CachedModels {
  at: number;
  models: DeepModel[];
}

let modelCache: CachedModels | null = null;
export const MODEL_CACHE_MS = 60 * 60 * 1000;

/** Test seam. */
export function resetModelCache(): void {
  modelCache = null;
}

/**
 * The public model list, filtered to models that can call tools. No key is
 * needed for this endpoint. Cached for an hour; a failure falls back to the
 * last good list, or to just the default model.
 */
export async function listModels(fetchImpl: typeof fetch = fetch): Promise<DeepModel[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
  try {
    const res = await fetchImpl(`${OPENROUTER_BASE}/models`, {
      headers: { Accept: "application/json", "HTTP-Referer": REFERER, "X-Title": TITLE },
    });
    if (!res.ok) throw new LlmError(`OpenRouter models ${res.status}`, res.status);
    const body = (await res.json()) as { data?: unknown };
    const models = parseModels(body);
    if (models.length > 0) {
      modelCache = { at: Date.now(), models };
      return models;
    }
  } catch (err) {
    console.warn(`[deep] could not list OpenRouter models: ${(err as Error).message}`);
  }
  if (modelCache) return modelCache.models;
  return [
    { id: DEFAULT_MODEL, name: DEFAULT_MODEL, contextLength: 200_000, promptUsdPerM: 0, completionUsdPerM: 0 },
  ];
}

/** Keep tool-capable models and convert per-token prices to per-million. */
export function parseModels(body: unknown): DeepModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: DeepModel[] = [];
  for (const raw of data as Array<Record<string, unknown>>) {
    const supported = raw["supported_parameters"];
    if (!Array.isArray(supported) || !supported.includes("tools")) continue;
    const pricing = (raw["pricing"] ?? {}) as Record<string, unknown>;
    const id = typeof raw["id"] === "string" ? raw["id"] : "";
    if (!id) continue;
    out.push({
      id,
      name: typeof raw["name"] === "string" ? raw["name"] : id,
      contextLength: num(raw["context_length"]),
      promptUsdPerM: Number(pricing["prompt"] ?? 0) * 1_000_000,
      completionUsdPerM: Number(pricing["completion"] ?? 0) * 1_000_000,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// --- the scripted mock ------------------------------------------------------

export interface MockTurn {
  /** Tool calls this turn asks for, as {name, args}. */
  toolCalls?: Array<{ name: string; args: unknown }>;
  /** Plain assistant text for this turn. */
  content?: string;
}

/**
 * Plays a fixed script. Used when there is no key, in tests, and for fixtures.
 * Costs nothing and reports nothing, so cost caps are never hit in mock mode.
 */
export class MockLlmBackend implements LlmBackend {
  readonly label = "mock";
  readonly mock = true;
  readonly #turns: MockTurn[];
  #index = 0;
  /** Every request the loop made, for tests. */
  readonly requests: ChatRequest[] = [];

  constructor(turns: MockTurn[]) {
    this.#turns = turns;
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const turn = this.#turns[this.#index++];
    if (!turn) {
      return Promise.resolve({
        message: { role: "assistant", content: "(mock script exhausted)" },
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
        finishReason: "stop",
        model: req.model,
      });
    }
    const message: LlmMessage = { role: "assistant", content: turn.content ?? null };
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      message.tool_calls = turn.toolCalls.map((t, i) => ({
        id: `mock_call_${this.#index}_${i}`,
        type: "function" as const,
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      }));
    }
    return Promise.resolve({
      message,
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      finishReason: message.tool_calls ? "tool_calls" : "stop",
      model: req.model,
    });
  }
}

export function makeLlmBackend(): LlmBackend | null {
  const key = openRouterKey();
  return key ? new OpenRouterBackend({ apiKey: key }) : null;
}
