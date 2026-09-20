import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeepBrief, DeepRun, Dossier } from "../src/shared/types.js";
import { snapshot } from "./fixtures.js";

// deep.ts persists to data/deep.json and reads the evaluation store; both are
// replaced so the tests neither touch the real files nor need a clone.
const state = vi.hoisted(() => ({ runs: [] as DeepRun[] }));

vi.mock("../src/server/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/store.js")>();
  return {
    ...actual,
    latestEvaluation: () => null,
    readJson: <T,>(path: string, fallback: T): T =>
      path.endsWith("deep.json") ? (state.runs as unknown as T) : actual.readJson(path, fallback),
    writeJsonAtomic: (path: string, value: unknown) => {
      if (path.endsWith("deep.json")) state.runs = value as DeepRun[];
      else actual.writeJsonAtomic(path, value);
    },
  };
});

// The tools are exercised against a fake git runner, so no checkout is needed.
vi.mock("../src/server/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/repo.js")>();
  return {
    ...actual,
    hasRev: () => Promise.resolve(true),
    diffRange: () => Promise.resolve("diff --git a/lib/x.cpp b/lib/x.cpp\n-int gone;\n"),
    readFile: (rev: string, path: string) => {
      if (path.includes("..")) return Promise.reject(new actual.GuardError(`path traversal rejected: ${path}`));
      return Promise.resolve(`84: int keep;\n85: int also;`);
    },
    blame: () => Promise.resolve([
      { sha: "b3dcff67d", author: "wdathing", date: "2026-09-17", summary: "Add flow control (#1628)", line: 84, text: "if (x)" },
    ]),
    grep: () => Promise.resolve([{ path: "lib/y.cpp", line: 12, text: "uart_param_config(...)" }]),
    logForPath: () => Promise.resolve([]),
    listTree: () => Promise.resolve([{ path: "lib/x.cpp", type: "blob" as const }]),
    show: () => Promise.resolve("commit b3dcff67d\n\nAdd flow control\n"),
  };
});

vi.mock("../src/server/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/github.js")>();
  return {
    ...actual,
    getPrSummary: (n: number) =>
      Promise.resolve({
        number: n,
        title: "Add COCO_HS_UART support",
        body: "Adds support for flow control.",
        author: "wdathing",
        url: `https://github.com/x/y/pull/${n}`,
        mergedAt: "2026-09-17T23:25:05Z",
        files: ["lib/hardware/ESP32UARTChannel.cpp"],
      }),
  };
});

const { MockLlmBackend } = await import("../src/server/llm.js");
const {
  DEEP_SYSTEM_PROMPT,
  DEEP_TOOLS,
  MAX_BRIEF_ATTEMPTS,
  TOOL_RESULT_CAP,
  abortRun,
  beginDeepRun,
  buildMockScript,
  deepTrim,
  runDeep,
  runTool,
  runningFor,
  salvageBrief,
  saveRun,
  spendToday,
  validateBrief,
} = await import("../src/server/deep.js");

function dossierFixture(over: Partial<Dossier> = {}): Dossier {
  return {
    prNumber: 1650,
    headSha: "164fa795df5dcd787b2fc685873c83abca723ca3",
    baseSha: "209b0e0e158f1244b52e8b04ecfdda94ede8cb94",
    builtAt: "2026-09-20T17:20:00Z",
    revisions: [
      { headSha: "e9d16d00", pushedAt: "2026-09-20T15:03:13Z", commits: [], additions: 4, deletions: 0, changedFiles: 1 },
      { headSha: "164fa795", pushedAt: "2026-09-20T17:04:52Z", commits: [], additions: 0, deletions: 5, changedFiles: 1 },
    ],
    latestDelta: {
      fromSha: "e9d16d00",
      toSha: "164fa795",
      diff: "diff --git a/lib/hardware/ESP32UARTChannel.cpp\n-#ifdef COCO_HS_UART\n",
      filesTouched: ["lib/hardware/ESP32UARTChannel.cpp"],
      linesAddedNowRemoved: 3,
      linesRemovedNowRestored: 0,
      summary: "Revision 2 removed the 3 guard lines revision 1 had added (#ifdef COCO_HS_UART) and the 5 lines they wrapped.",
    },
    deletedLineOrigins: [84, 85, 86, 87, 88].map((line) => ({
      path: "lib/hardware/ESP32UARTChannel.cpp",
      line,
      text: "    uart_set_hw_flow_ctrl(...)",
      sha: "b3dcff67d",
      author: "wdathing",
      date: "2026-09-17T23:25:05Z",
      subject: "Add COCO_HS_UART support (#1628)",
      pr: {
        number: 1628,
        title: "Add COCO_HS_UART support",
        url: "https://github.com/x/y/pull/1628",
        author: "wdathing",
        mergedAt: "2026-09-17T23:25:05Z",
        body: "Adds support for flow control.",
      },
    })),
    originPrs: [
      {
        number: 1628,
        title: "Add COCO_HS_UART support",
        author: "wdathing",
        mergedAt: "2026-09-17T23:25:05Z",
        daysAgo: 3,
        linesDeletedFromIt: 5,
        authorInThread: false,
      },
    ],
    thread: [
      {
        kind: "review_comment",
        at: "2026-09-20T16:12:22Z",
        author: "FozzTexx",
        association: "MEMBER",
        isMaintainer: true,
        body: "Do not put per platform ifdefs in this file.",
        url: "https://github.com/x/y/pull/1650#discussion_r1",
      },
      {
        kind: "review_comment",
        at: "2026-09-20T16:40:24Z",
        author: "someone",
        association: "CONTRIBUTOR",
        isMaintainer: false,
        body: "uart_param_config() already applies conf.uart_config.flow_ctrl, so the call was redundant. ".repeat(4),
        url: "https://github.com/x/y/pull/1650#discussion_r2",
      },
    ],
    maintainers: ["FozzTexx"],
    crossRefs: [],
    drift: [{ kind: "body_mentions_absent_token", detail: "names #ifdef and COCO_HS_UART", evidence: ["#ifdef", "COCO_HS_UART"] }],
    availability: { git: true, provenance: true, crossRefs: true, notes: [] },
    ...over,
  };
}

const VALID_BRIEF: DeepBrief = {
  summary: "Revision 2 deletes the block outright.",
  revisionChanges: ["removed the guard and the block"],
  removedBehaviour: [
    {
      lines: "lib/hardware/ESP32UARTChannel.cpp:84-88",
      originPr: 1628,
      purpose: "flow control",
      status: "removed_without_replacement",
      citations: [{ kind: "code", ref: "lib/hardware/ESP32UARTChannel.cpp:84-88@209b0e0e1" }],
    },
  ],
  claims: [
    {
      claim: "uart_param_config already applies flow_ctrl",
      by: "someone",
      verdict: "holds",
      evidence: "it is called at the top of begin()",
      citations: [{ kind: "code", ref: "lib/hardware/ESP32UARTChannel.cpp:60@209b0e0e1" }],
    },
  ],
  openQuestions: [{ question: "Is RTS/CTS wired?", toWhom: "wdathing" }],
  recommendedAction: "ask_original_author",
  rationale: ["the lines are 3 days old"],
  draftReply: "Thanks for the bisect.",
  confidence: "medium",
  caveats: [],
};

beforeEach(() => {
  state.runs = [];
  delete process.env["DEEP_MAX_STEPS"];
  delete process.env["OPENROUTER_API_KEY"];
});

describe("tools", () => {
  const ctx = { prNumber: 1650, baseSha: "209b0e0e158f1244b52e8b04ecfdda94ede8cb94", dossier: dossierFixture() };

  it("exposes exactly the documented tool set, submit_brief included", () => {
    expect(DEEP_TOOLS.map((t) => t.function.name)).toEqual([
      "read_file",
      "read_file_at_base",
      "grep",
      "git_log",
      "git_blame",
      "git_show",
      "pr_diff",
      "revision_delta",
      "fetch_pr",
      "list_dir",
      "submit_brief",
    ]);
    // Every tool reads; none of them writes, and none of them shells out.
    expect(DEEP_TOOLS.every((t) => !/write|post|delete|exec|shell/i.test(t.function.name))).toBe(true);
  });

  it("returns an error string to the model rather than throwing on a bad path", async () => {
    const out = await runTool("read_file", { path: "../../etc/passwd" }, ctx);
    expect(out).toMatch(/^error: /);
    expect(out).toContain("path traversal rejected");
  });

  it("returns an error string for an unknown tool", async () => {
    expect(await runTool("rm_rf", { path: "/" }, ctx)).toBe('error: no such tool "rm_rf"');
  });

  it("caps every result", async () => {
    const huge = "x".repeat(TOOL_RESULT_CAP * 2);
    const { setGitRunner } = await import("../src/server/repo.js");
    const restore = setGitRunner(() => Promise.resolve({ stdout: huge, stderr: "" }));
    try {
      const out = await runTool("git_log", {}, ctx);
      expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_CAP + 32);
    } finally {
      setGitRunner(restore);
    }
  });

  it("answers revision_delta from the dossier, and says so when there is none", async () => {
    expect(await runTool("revision_delta", {}, ctx)).toContain("#ifdef COCO_HS_UART");
    const single = { ...ctx, dossier: dossierFixture({ latestDelta: null }) };
    expect(await runTool("revision_delta", {}, single)).toContain("only one revision");
  });

  it("fetches another PR through the GitHub reader", async () => {
    const out = await runTool("fetch_pr", { number: 1628 }, ctx);
    expect(out).toContain("#1628");
    expect(out).toContain("Adds support for flow control");
    expect(await runTool("fetch_pr", {}, ctx)).toContain("error: number must be an integer");
  });
});

describe("brief validation", () => {
  it("accepts a well-formed brief", () => {
    const result = validateBrief(VALID_BRIEF);
    expect(result.errors).toEqual([]);
    expect(result.brief).not.toBeNull();
  });

  it("does not fail over whitespace or case in enum fields", () => {
    // Exactly what the first live run sent, and what lost 38 good tool steps.
    const result = validateBrief({
      ...VALID_BRIEF,
      recommendedAction: "\n  close_stale\n",
      confidence: "\n  medium\n",
    });
    expect(result.errors).toEqual([]);
    expect(result.brief!.recommendedAction).toBe("close_stale");
    expect(result.brief!.confidence).toBe("medium");
    expect(result.coercions).toEqual([]); // trimming is not a coercion

    const cased = validateBrief({
      ...VALID_BRIEF,
      recommendedAction: "  Ask Original Author ",
      confidence: "HIGH",
      claims: [{ ...VALID_BRIEF.claims[0], verdict: " Partially Holds " }],
      removedBehaviour: [{ ...VALID_BRIEF.removedBehaviour[0], status: "Removed Without Replacement" }],
    });
    expect(cased.errors).toEqual([]);
    expect(cased.brief!.recommendedAction).toBe("ask_original_author");
    expect(cased.brief!.confidence).toBe("high");
    expect(cased.brief!.claims[0]!.verdict).toBe("partially_holds");
    expect(cased.brief!.removedBehaviour[0]!.status).toBe("removed_without_replacement");
  });

  it("trims every string field, however deep", () => {
    expect(deepTrim({ a: "  x \n", b: [{ c: " y " }] })).toEqual({ a: "x", b: [{ c: "y" }] });
    const result = validateBrief({ ...VALID_BRIEF, summary: "  a real summary  ", rationale: ["  padded  "] });
    expect(result.brief!.summary).toBe("a real summary");
    expect(result.brief!.rationale).toEqual(["padded"]);
  });

  it("coerces a near-miss enum and says so in the caveats", () => {
    const result = validateBrief({ ...VALID_BRIEF, recommendedAction: "ask-original-authors" });
    expect(result.errors).toEqual([]);
    expect(result.brief!.recommendedAction).toBe("ask_original_author");
    expect(result.coercions[0]).toContain("mapped to ask_original_author");
    expect(result.brief!.caveats.join(" ")).toContain("model wrote");
  });

  it("still rejects what nothing resembles, quoting the value as it arrived", () => {
    const missing = validateBrief({ ...VALID_BRIEF, summary: "" });
    expect(missing.brief).toBeNull();
    expect(missing.errors[0]).toContain("summary is required");

    const nonsense = validateBrief({ ...VALID_BRIEF, recommendedAction: "\n  xyzzy  \n" });
    expect(nonsense.brief).toBeNull();
    // JSON-escaped, so the model can see the whitespace it sent.
    expect(nonsense.errors[0]).toContain('"\\n  xyzzy  \\n"');

    expect(validateBrief({ ...VALID_BRIEF, draftReply: "  " }).brief).toBeNull();
    expect(validateBrief(null).brief).toBeNull();
    expect(validateBrief([]).errors[0]).toContain("must be a JSON object");
  });

  it("repairs soft fields instead of failing", () => {
    const result = validateBrief({ ...VALID_BRIEF, rationale: "not an array", claims: [{ claim: "c" }] });
    expect(result.brief).not.toBeNull();
    expect(result.brief!.rationale).toEqual([]);
    expect(result.brief!.claims[0]!.verdict).toBe("unverified");
  });

  it("salvages an attempt that cannot be validated", () => {
    const salvaged = salvageBrief({ summary: " partial thoughts ", rationale: ["a", "b"], recommendedAction: "???" });
    expect(salvaged).not.toBeNull();
    expect(salvaged!.summary).toBe("partial thoughts");
    expect(salvaged!.rationale).toEqual(["a", "b"]);
    expect(salvageBrief(null)).toBeNull();
  });
});

describe("the loop", () => {
  const snap = snapshot({ number: 1650, headSha: "164fa795df5dcd787b2fc685873c83abca723ca3", author: "someone" });

  it("ends on submit_brief, records every step, and emits deep events", async () => {
    const { resetEvents, subscribe } = await import("../src/server/events.js");
    resetEvents();
    const seen: string[] = [];
    const unsubscribe = subscribe((e) => seen.push(e.type));

    const dossier = dossierFixture();
    const backend = new MockLlmBackend(buildMockScript(dossier, snap));
    const run = await runDeep({ prNumber: 1650, requestedBy: "dillera", snapshot: snap, backend, dossier });
    unsubscribe();

    expect(run.status).toBe("done");
    expect(run.brief).not.toBeNull();
    expect(run.brief!.recommendedAction).toBe("ask_original_author");
    expect(run.requestedBy).toBe("dillera");
    expect(run.mock).toBe(true);
    expect(run.usage.calls).toBeGreaterThan(1);
    expect(run.usage.costUsd).toBe(0);

    const toolSteps = run.steps.filter((s) => s.kind === "tool");
    expect(toolSteps.map((s) => s.name)).toContain("pr_diff");
    expect(toolSteps.map((s) => s.name)).toContain("git_blame");
    expect(toolSteps.at(-1)!.name).toBe("submit_brief");

    expect(seen[0]).toBe("deep:start");
    expect(seen).toContain("deep:step");
    expect(seen.at(-1)).toBe("deep:done");

    // Persisted as it went, so a reload during the run shows it.
    expect(state.runs.at(-1)!.id).toBe(run.id);
    expect(runningFor(1650)).toBeNull();
  });

  it("sends the system prompt and the dossier as the first two messages", async () => {
    const dossier = dossierFixture();
    const backend = new MockLlmBackend(buildMockScript(dossier, snap));
    await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend, dossier });

    const first = backend.requests[0]!;
    expect(first.messages[0]!.role).toBe("system");
    expect(first.messages[0]!.content).toBe(DEEP_SYSTEM_PROMPT);
    expect(first.messages[0]!.content).toContain("If you cannot cite it");
    expect(first.messages[1]!.role).toBe("user");
    expect(first.messages[1]!.content).toContain("DOSSIER");
    expect(first.messages[1]!.content).toContain("1628");
    expect(first.tools.map((t) => t.function.name)).toContain("submit_brief");
  });

  it("aborts with a partial run when the step cap is reached", async () => {
    process.env["DEEP_MAX_STEPS"] = "2";
    const backend = new MockLlmBackend([
      { toolCalls: [{ name: "pr_diff", args: {} }] },
      { toolCalls: [{ name: "pr_diff", args: {} }] },
      { toolCalls: [{ name: "pr_diff", args: {} }] },
    ]);
    const run = await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend, dossier: dossierFixture() });
    expect(run.status).toBe("aborted");
    expect(run.error).toContain("step cap");
    expect(run.brief).toBeNull();
    expect(run.steps.length).toBeGreaterThan(0); // partial run is kept
    expect(backend.requests).toHaveLength(2);
  });

  it("asks the model to submit before the budget runs out", async () => {
    process.env["DEEP_MAX_COST_USD"] = "0.10";
    const seen: string[] = [];
    let call = 0;
    const costly = {
      label: "costly",
      mock: false,
      chat: (req: { messages: Array<{ role: string; content: string | null }> }) => {
        call += 1;
        seen.push(...req.messages.filter((m) => m.role === "user").map((m) => String(m.content)));
        const submit = seen.some((m) => m.includes("Budget notice"));
        return Promise.resolve({
          message: {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              submit
                ? { id: `c${call}`, type: "function" as const, function: { name: "submit_brief", arguments: JSON.stringify(VALID_BRIEF) } }
                : { id: `c${call}`, type: "function" as const, function: { name: "pr_diff", arguments: "{}" } },
            ],
          },
          usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.035 },
          finishReason: "tool_calls",
          model: "m",
        });
      },
    };
    try {
      const run = await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend: costly as never, dossier: dossierFixture() });
      // Warned at 60% of $0.10, submitted before the hard cap.
      expect(run.status).toBe("done");
      expect(run.brief).not.toBeNull();
      expect(run.error).toBeUndefined(); // it finished rather than being cut off
      expect(seen.some((m) => m.includes("Budget notice"))).toBe(true);
      expect(run.steps.some((st) => st.name === "budget")).toBe(true);
    } finally {
      delete process.env["DEEP_MAX_COST_USD"];
    }
  });

  it("aborts when the cost cap is exceeded", async () => {
    process.env["DEEP_MAX_COST_USD"] = "0.01";
    const expensive = {
      label: "expensive",
      mock: false,
      chat: () =>
        Promise.resolve({
          message: { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", type: "function" as const, function: { name: "pr_diff", arguments: "{}" } }] },
          usage: { promptTokens: 1000, completionTokens: 100, costUsd: 0.009 },
          finishReason: "tool_calls",
          model: "m",
        }),
    };
    try {
      const run = await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend: expensive, dossier: dossierFixture() });
      expect(run.status).toBe("aborted");
      expect(run.error).toContain("cost cap");
      expect(run.usage.costUsd).toBeGreaterThanOrEqual(0.01);
      // Spend is recorded even though the run produced no brief.
      expect(spendToday().todayUsd).toBeGreaterThan(0);
    } finally {
      delete process.env["DEEP_MAX_COST_USD"];
    }
  });

  it("bounces an invalid brief back with the offending value, and accepts the retry", async () => {
    const bad = { ...VALID_BRIEF, recommendedAction: "\n  xyzzy  \n" };
    const backend = new MockLlmBackend([
      { toolCalls: [{ name: "submit_brief", args: bad }] },
      { toolCalls: [{ name: "submit_brief", args: VALID_BRIEF }] },
    ]);
    const good = await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend, dossier: dossierFixture() });
    expect(good.status).toBe("done");
    expect(good.brief!.recommendedAction).toBe("ask_original_author");

    const replies = backend.requests.at(-1)!.messages.filter((m) => m.role === "tool");
    const bounce = replies.find((m) => String(m.content).includes("recommendedAction must be one of"));
    expect(bounce).toBeDefined();
    expect(String(bounce!.content)).toContain('"\\n  xyzzy  \\n"'); // quoted as received
    expect(String(bounce!.content)).toContain("quoted exactly as they arrived");
    expect(good.validationErrors!.length).toBeGreaterThan(0);
  });

  it("allows three attempts, then fails but keeps the last attempt as partialBrief", async () => {
    const bad = { ...VALID_BRIEF, recommendedAction: "xyzzy", summary: "a real investigation happened here" };
    const backend = new MockLlmBackend(
      Array.from({ length: 4 }, () => ({ toolCalls: [{ name: "submit_brief", args: bad }] })),
    );
    const failed = await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend, dossier: dossierFixture() });

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("invalid 3 times");
    expect(backend.requests).toHaveLength(MAX_BRIEF_ATTEMPTS);
    // The work is not lost.
    expect(failed.brief).toBeNull();
    expect(failed.partialBrief).not.toBeNull();
    expect(failed.partialBrief!.summary).toBe("a real investigation happened here");
    expect(failed.partialBrief!.claims).toHaveLength(1);
    expect(failed.validationErrors!.length).toBe(MAX_BRIEF_ATTEMPTS);
  });

  it("creates and persists the run record before any slow work, so the route can return it", async () => {
    const dossier = dossierFixture();
    const backend = new MockLlmBackend(buildMockScript(dossier, snap));
    const before = state.runs.length;
    const { run, done } = beginDeepRun({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend, dossier });

    // Synchronously: the record exists, is persisted, and holds the lock.
    expect(run.status).toBe("running");
    expect(runningFor(1650)).toBe(run.id);
    expect(state.runs).toHaveLength(before + 1);
    expect(state.runs.at(-1)!.id).toBe(run.id);

    const finished = await done;
    expect(finished.id).toBe(run.id); // the same run, not a previous one
    expect(finished.status).toBe("done");
  });

  it("counts running, failed and aborted runs in today's spend", async () => {
    const now = new Date();
    const base = {
      prNumber: 1650,
      headSha: "a".repeat(40),
      evaluationId: null,
      dossierBuiltAt: now.toISOString(),
      model: "m",
      mock: false,
      startedAt: now.toISOString(),
      steps: [],
      brief: null,
      requestedBy: "d",
    };
    saveRun({ ...base, id: "deep_running", status: "running", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0.12, calls: 3 } });
    saveRun({ ...base, id: "deep_failed", status: "failed", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0.34, calls: 19 } });
    saveRun({ ...base, id: "deep_aborted", status: "aborted", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0.05, calls: 2 } });
    saveRun({ ...base, id: "deep_done", status: "done", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0.01, calls: 4 } });

    const spend = spendToday(now);
    expect(spend.runsToday).toBe(4);
    expect(spend.todayUsd).toBeCloseTo(0.52, 6);
  });

  it("persists usage as soon as a call returns, so a crash still records the spend", async () => {
    let seenMidRun = 0;
    const costly = {
      label: "costly",
      mock: false,
      calls: 0,
      chat: () => {
        costly.calls += 1;
        if (costly.calls === 2) {
          // Between calls, the persisted record already carries call 1's cost.
          seenMidRun = (state.runs.find((r) => r.status === "running")?.usage.costUsd ?? 0);
        }
        return Promise.resolve({
          message: {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              costly.calls >= 2
                ? { id: "c", type: "function" as const, function: { name: "submit_brief", arguments: JSON.stringify(VALID_BRIEF) } }
                : { id: "c", type: "function" as const, function: { name: "pr_diff", arguments: "{}" } },
            ],
          },
          usage: { promptTokens: 10, completionTokens: 1, costUsd: 0.07 },
          finishReason: "tool_calls",
          model: "m",
        });
      },
    };
    await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend: costly as never, dossier: dossierFixture() });
    expect(seenMidRun).toBeCloseTo(0.07, 6);
  });

  it("tells the model that only submit_brief ends the run when it answers in prose", async () => {
    const backend = new MockLlmBackend([
      { content: "I think this looks fine." },
      { toolCalls: [{ name: "submit_brief", args: VALID_BRIEF }] },
    ]);
    const run = await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend, dossier: dossierFixture() });
    expect(run.status).toBe("done");
    const nudge = backend.requests.at(-1)!.messages.find((m) => String(m.content).includes("Only submit_brief ends"));
    expect(nudge).toBeDefined();
  });

  it("hands a malformed tool-call argument string back to the model as an error", async () => {
    // MockLlmBackend serialises its args, so a malformed string needs a backend
    // of its own; this is exactly what a model emitting truncated JSON looks like.
    let turn = 0;
    const malformed = {
      label: "malformed",
      mock: true,
      chat: () => {
        turn += 1;
        return Promise.resolve({
          message: {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              turn === 1
                ? { id: "c1", type: "function" as const, function: { name: "read_file", arguments: '{"path": "lib/x.cpp"' } }
                : { id: "c2", type: "function" as const, function: { name: "submit_brief", arguments: JSON.stringify(VALID_BRIEF) } },
            ],
          },
          usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
          finishReason: "tool_calls",
          model: "m",
        });
      },
    };
    const run = await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend: malformed, dossier: dossierFixture() });
    expect(run.status).toBe("done");
    const badStep = run.steps.find((st) => st.name === "read_file");
    expect(badStep!.resultPreview).toContain("not valid JSON");
  });

  it("can be stopped from outside, leaving an aborted run", async () => {
    let resolveFirst: (() => void) | null = null;
    const slow = {
      label: "slow",
      mock: true,
      calls: 0,
      chat(_req: unknown, signal?: AbortSignal): Promise<never> {
        return new Promise((_resolve, reject) => {
          resolveFirst = () => reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const started = runDeep({
      prNumber: 1650,
      requestedBy: "d",
      snapshot: snap,
      backend: slow as never,
      dossier: dossierFixture(),
    });
    await vi.waitFor(() => {
      expect(runningFor(1650)).not.toBeNull();
    });
    const runId = runningFor(1650)!;
    expect(abortRun(1650, runId)).toBe(true);
    expect(abortRun(1650, "not-this-run")).toBe(false);
    const run = await started;
    expect(run.status).toBe("aborted");
    expect(run.error).toContain("stopped by the reviewer");
    expect(resolveFirst).not.toBeNull();
  });

  it("reports today's spend from the persisted runs", async () => {
    const dossier = dossierFixture();
    const backend = new MockLlmBackend(buildMockScript(dossier, snap));
    await runDeep({ prNumber: 1650, requestedBy: "d", snapshot: snap, backend, dossier });
    const spend = spendToday();
    expect(spend.runsToday).toBe(1);
    expect(spend.todayUsd).toBe(0); // mock runs are free
  });
});

describe("the mock brief", () => {
  it("is built from the dossier and reads like the worked example", () => {
    const dossier = dossierFixture();
    const snap = snapshot({ number: 1650, author: "someone" });
    const script = buildMockScript(dossier, snap);
    const submit = script.at(-1)!.toolCalls![0]!;
    expect(submit.name).toBe("submit_brief");

    const brief = submit.args as DeepBrief;
    expect(brief.summary).toContain("#1628");
    expect(brief.summary).toContain("wdathing");
    expect(brief.summary).toContain("FozzTexx");
    expect(brief.removedBehaviour[0]!.lines).toBe("lib/hardware/ESP32UARTChannel.cpp:84-88");
    expect(brief.removedBehaviour[0]!.status).toBe("removed_without_replacement");
    expect(brief.claims.some((c) => c.verdict === "partially_holds")).toBe(true);
    expect(brief.openQuestions.some((q) => q.toWhom === "wdathing")).toBe(true);
    expect(brief.recommendedAction).toBe("ask_original_author");
    expect(brief.draftReply).toContain("bisect");
    expect(brief.caveats[0]).toContain("mock mode");
  });
});
