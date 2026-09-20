import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MODEL,
  MockLlmBackend,
  OpenRouterBackend,
  listModels,
  parseChatResponse,
  parseModels,
  resetModelCache,
  type LlmTool,
} from "../src/server/llm.js";

const TOOLS: LlmTool[] = [
  {
    type: "function",
    function: { name: "pr_diff", description: "the diff", parameters: { type: "object", properties: {} } },
  },
];

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_abc", type: "function", function: { name: "pr_diff", arguments: "{}" } },
            {
              id: "call_def",
              type: "function",
              function: { name: "git_blame", arguments: '{"path":"lib/x.cpp","start_line":84,"end_line":88}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.0031 },
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  resetModelCache();
  vi.restoreAllMocks();
});

describe("OpenRouter chat", () => {
  it("sends the OpenAI tool format and asks for cost, then parses tool calls back", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(chatBody()));
    const backend = new OpenRouterBackend({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });

    const res = await backend.chat({
      model: "anthropic/claude-haiku-4.5",
      messages: [
        { role: "system", content: "you are a reviewer" },
        { role: "user", content: "here is the dossier" },
      ],
      tools: TOOLS,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["HTTP-Referer"]).toBe("https://github.com/dillera/prMonster");
    expect(headers["X-Title"]).toBe("prMonster");

    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent["tool_choice"]).toBe("auto");
    expect(sent["temperature"]).toBe(0.2);
    expect(sent["usage"]).toEqual({ include: true }); // without this there is no cost
    expect(sent["tools"]).toEqual(TOOLS);

    expect(res.message.tool_calls).toHaveLength(2);
    expect(res.message.tool_calls![0]).toEqual({
      id: "call_abc",
      type: "function",
      function: { name: "pr_diff", arguments: "{}" },
    });
    expect(res.usage).toEqual({ promptTokens: 1200, completionTokens: 80, costUsd: 0.0031 });
    expect(res.finishReason).toBe("tool_calls");
  });

  it("round-trips a tool reply: role tool with tool_call_id goes out unchanged", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(chatBody()))
      .mockResolvedValueOnce(
        json({
          model: "m",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "thanks" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 },
        }),
      );
    const backend = new OpenRouterBackend({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = await backend.chat({ model: "m", messages: [{ role: "user", content: "go" }], tools: TOOLS });
    const second = await backend.chat({
      model: "m",
      messages: [
        { role: "user", content: "go" },
        first.message,
        { role: "tool", tool_call_id: "call_abc", content: "diff text" },
      ],
      tools: TOOLS,
    });

    const sent = JSON.parse((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(sent.messages[1]!["tool_calls"]).toBeDefined();
    expect(sent.messages[2]).toEqual({ role: "tool", tool_call_id: "call_abc", content: "diff text" });
    expect(second.message.content).toBe("thanks");
  });

  it("retries a 429 with backoff and honours retry-after", async () => {
    const slept: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "3" } }))
      .mockResolvedValueOnce(new Response("still busy", { status: 503 }))
      .mockResolvedValueOnce(json(chatBody()));
    const backend = new OpenRouterBackend({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    const res = await backend.chat({ model: "m", messages: [], tools: TOOLS });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(slept[0]).toBe(3000);
    expect(slept).toHaveLength(2);
    expect(res.usage.costUsd).toBe(0.0031);
  });

  it("gives up after four attempts and does not retry a 400", async () => {
    const busy = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    const backend = new OpenRouterBackend({
      apiKey: "k",
      fetchImpl: busy as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    await expect(backend.chat({ model: "m", messages: [], tools: TOOLS })).rejects.toThrow(/503/);
    expect(busy).toHaveBeenCalledTimes(4);

    const bad = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    const b2 = new OpenRouterBackend({
      apiKey: "k",
      fetchImpl: bad as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    await expect(b2.chat({ model: "m", messages: [], tools: TOOLS })).rejects.toThrow(/400/);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("accumulates cost across calls the way the loop sums it", () => {
    const usages = [
      parseChatResponse(chatBody(), "m").usage,
      parseChatResponse(chatBody({ usage: { prompt_tokens: 500, completion_tokens: 40, cost: 0.0012 } }), "m").usage,
    ];
    const total = usages.reduce(
      (a, u) => ({
        promptTokens: a.promptTokens + u.promptTokens,
        completionTokens: a.completionTokens + u.completionTokens,
        costUsd: Number((a.costUsd + u.costUsd).toFixed(6)),
      }),
      { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    );
    expect(total).toEqual({ promptTokens: 1700, completionTokens: 120, costUsd: 0.0043 });
  });

  it("tolerates a response with no tool calls, no usage and no content", () => {
    const res = parseChatResponse({ choices: [{ message: { role: "assistant" } }] }, "fallback/model");
    expect(res.message.content).toBeNull();
    expect(res.message.tool_calls).toBeUndefined();
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
    expect(res.model).toBe("fallback/model");
    expect(parseChatResponse(null, "m").message.role).toBe("assistant");
  });

  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const backend = new OpenRouterBackend({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(backend.chat({ model: "m", messages: [], tools: TOOLS }, controller.signal)).rejects.toThrow(/aborted/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("model catalogue", () => {
  const body = {
    data: [
      {
        id: "anthropic/claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        context_length: 200000,
        supported_parameters: ["tools", "temperature"],
        pricing: { prompt: "0.000001", completion: "0.000005" },
      },
      {
        id: "some/no-tools-model",
        name: "No Tools",
        context_length: 8192,
        supported_parameters: ["temperature"],
        pricing: { prompt: "0.0000005", completion: "0.0000015" },
      },
    ],
  };

  it("keeps only tool-capable models and converts pricing to per-million", () => {
    const models = parseModels(body);
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "anthropic/claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      contextLength: 200000,
      promptUsdPerM: 1,
      completionUsdPerM: 5,
    });
    expect(parseModels({})).toEqual([]);
    expect(parseModels(null)).toEqual([]);
  });

  it("fetches without a key and caches for an hour", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(body));
    const first = await listModels(fetchImpl as unknown as typeof fetch);
    const second = await listModels(fetchImpl as unknown as typeof fetch);
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("falls back to the default model when the listing fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const models = await listModels(fetchImpl as unknown as typeof fetch);
    expect(models.map((m) => m.id)).toEqual([DEFAULT_MODEL]);
  });
});

describe("MockLlmBackend", () => {
  it("plays its script and reports no cost", async () => {
    const backend = new MockLlmBackend([
      { toolCalls: [{ name: "pr_diff", args: {} }] },
      { content: "thinking", toolCalls: [{ name: "submit_brief", args: { summary: "s" } }] },
    ]);
    const first = await backend.chat({ model: "m", messages: [], tools: TOOLS });
    expect(first.message.tool_calls![0]!.function.name).toBe("pr_diff");
    expect(first.usage.costUsd).toBe(0);

    const second = await backend.chat({ model: "m", messages: [], tools: TOOLS });
    expect(second.message.content).toBe("thinking");
    expect(JSON.parse(second.message.tool_calls![0]!.function.arguments)).toEqual({ summary: "s" });

    const third = await backend.chat({ model: "m", messages: [], tools: TOOLS });
    expect(third.message.tool_calls).toBeUndefined();
    expect(backend.requests).toHaveLength(3);
  });
});
