import { describe, expect, it } from "vitest";

import { decide, DIFF_UNAVAILABLE_GATE } from "../src/server/decide.js";
import { QUESTIONS } from "../src/server/jev.js";
import type { AggregatedAnswer, GateResult, JevAnswer } from "../src/shared/types.js";
import { policy } from "./fixtures.js";

const LEVELS = ["a", "b", "c", "d"];

function scoreAnswer(score: number, confidence = 0.9): JevAnswer {
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  LEVELS.forEach((l, i) => {
    legend[String(i)] = l;
    probabilities[String(i)] = i === Math.round(score) ? 0.85 : 0.05;
  });
  return { type: "score", score, legend, probabilities, confidence };
}

function choiceAnswer(choice: string, confidence = 0.8): JevAnswer {
  return { type: "choice", choice, probabilities: { [choice]: 0.9, mixed: 0.1 }, confidence };
}

/** All weighted answers at their best (or worst) value. */
function answers(quality: "good" | "bad", over: Record<string, JevAnswer> = {}): {
  pr: Record<string, JevAnswer>;
  aggregated: Record<string, AggregatedAnswer>;
} {
  const pr: Record<string, JevAnswer> = {};
  const aggregated: Record<string, AggregatedAnswer> = {};
  for (const q of QUESTIONS) {
    let a: JevAnswer;
    if (q.id === "reviewer_directed_text") {
      a = { type: "noul", noul: 0.02 };
    } else if (q.type === "noul") {
      const good = quality === "good" ? 0.95 : 0.05;
      a = { type: "noul", noul: q.polarity === "bad" ? 1 - good : good };
    } else if (q.type === "choice") {
      a = choiceAnswer("bugfix");
    } else {
      const goodLevel = quality === "good" ? 3 : 0;
      a = scoreAnswer(q.polarity === "bad" ? 3 - goodLevel : goodLevel);
    }
    const final = over[q.id] ?? a;
    if (q.kind === "pr") pr[q.id] = final;
    else aggregated[q.id] = { answer: final, fromChunk: 0, fromFiles: ["lib/x.cpp"] };
  }
  for (const [id, a] of Object.entries(over)) {
    if (id in pr) pr[id] = a;
    else if (id in aggregated) aggregated[id] = { answer: a, fromChunk: 1, fromFiles: ["lib/y.cpp"] };
  }
  return { pr, aggregated };
}

function gate(id: string, severity: GateResult["severity"], passed: boolean): GateResult {
  return { id, severity, passed, detail: `${id} detail` };
}

const CLEAN_GATES: GateResult[] = [
  gate("not_draft", "hard", true),
  gate("mergeable", "hard", true),
  gate("ci_green", "hard", true),
  gate("ci_pending", "soft", true),
  gate("forbidden_files", "hard", true),
  gate("size_bucket", "info", true),
];

describe("decide", () => {
  it("routes a clean, confident, high-scoring PR to READY", () => {
    const { pr, aggregated } = answers("good");
    const d = decide(CLEAN_GATES, pr, aggregated, "small", policy());
    expect(d.kind).toBe("READY");
    expect(d.composite).toBeGreaterThanOrEqual(75);
    expect(d.minConfidence).toBeCloseTo(0.9, 5);
    expect(d.uncertainNouls).toEqual([]);
    expect(d.reasons.some((r) => r.code === "ready")).toBe(true);
  });

  it("BLOCKS on any failed hard gate and still computes the composite", () => {
    const { pr, aggregated } = answers("good");
    const gates = [...CLEAN_GATES, gate("not_draft", "hard", false)];
    const d = decide(gates, pr, aggregated, "small", policy());
    expect(d.kind).toBe("BLOCKED");
    expect(d.composite).toBeGreaterThan(0);
    expect(d.reasons.filter((r) => r.code === "hard_gate")).toHaveLength(1);
    expect(d.explanation[0]).toContain("Hard gate not_draft failed");
  });

  it("BLOCKS on a hard Jev block above the policy threshold", () => {
    const { pr, aggregated } = answers("good", { reviewer_directed_text: { type: "noul", noul: 0.8 } });
    const d = decide(CLEAN_GATES, pr, aggregated, "small", policy());
    expect(d.kind).toBe("BLOCKED");
    const r = d.reasons.find((x) => x.code === "jev_hard_block");
    expect(r?.questionId).toBe("reviewer_directed_text");
    expect(d.explanation.join(" ")).toContain("text aimed at a reviewer or automated system");
  });

  it("does not block just below the threshold", () => {
    const { pr, aggregated } = answers("good", { reviewer_directed_text: { type: "noul", noul: 0.69 } });
    expect(decide(CLEAN_GATES, pr, aggregated, "small", policy()).kind).toBe("READY");
  });

  it("routes a low-scoring PR to NEEDS_REVIEW with a low composite reason", () => {
    const { pr, aggregated } = answers("bad");
    const d = decide(CLEAN_GATES, pr, aggregated, "small", policy());
    expect(d.kind).toBe("NEEDS_REVIEW");
    expect(d.composite).toBeLessThan(45);
    expect(d.reasons.some((r) => r.code === "low_composite")).toBe(true);
  });

  it("subtracts softGatePenalty per failed soft gate, floored at 0", () => {
    const { pr, aggregated } = answers("good");
    const base = decide(CLEAN_GATES, pr, aggregated, "small", policy()).composite;
    const withSoft = decide(
      [...CLEAN_GATES, gate("trailing_whitespace", "soft", false), gate("has_description", "soft", false)],
      pr,
      aggregated,
      "small",
      policy(),
    );
    expect(withSoft.composite).toBeCloseTo(base - 12, 5);
    expect(withSoft.reasons.filter((r) => r.code === "soft_gate")).toHaveLength(2);

    const bad = answers("bad");
    const floored = decide(
      [...CLEAN_GATES, ...Array.from({ length: 20 }, (_, i) => gate(`soft${i}`, "soft", false))],
      bad.pr,
      bad.aggregated,
      "small",
      policy(),
    );
    expect(floored.composite).toBe(0);
  });

  it("ignores gates the policy turned off", () => {
    const { pr, aggregated } = answers("good");
    const gates = [...CLEAN_GATES, gate("trailing_whitespace", "off", false), gate("not_draft", "off", false)];
    expect(decide(gates, pr, aggregated, "small", policy()).kind).toBe("READY");
  });

  it("keeps READY off when the confidence floor is not met", () => {
    const { pr, aggregated } = answers("good", { code_quality: scoreAnswer(3, 0.2) });
    const d = decide(CLEAN_GATES, pr, aggregated, "small", policy());
    expect(d.kind).toBe("NEEDS_REVIEW");
    expect(d.minConfidence).toBeCloseTo(0.2, 5);
    expect(d.reasons.some((r) => r.code === "low_confidence")).toBe(true);
  });

  it("counts uncertain nouls and blocks READY past maxUncertainNouls", () => {
    const uncertain: Record<string, JevAnswer> = {
      single_concern: { type: "noul", noul: 0.5 },
      explains_why: { type: "noul", noul: 0.4 },
      layer_violation: { type: "noul", noul: 0.6 },
    };
    const { pr, aggregated } = answers("good", uncertain);
    const d = decide(CLEAN_GATES, pr, aggregated, "small", policy());
    expect(d.uncertainNouls.sort()).toEqual(["explains_why", "layer_violation", "single_concern"]);
    expect(d.kind).toBe("NEEDS_REVIEW");
    expect(d.reasons.some((r) => r.code === "uncertain_nouls")).toBe(true);
    // Raising the allowance restores READY without re-calling Jev.
    expect(decide(CLEAN_GATES, pr, aggregated, "small", policy({ maxUncertainNouls: 5 })).kind).toBe("READY");
  });

  it("never routes a huge change to READY", () => {
    const { pr, aggregated } = answers("good");
    const d = decide(CLEAN_GATES, pr, aggregated, "huge", policy());
    expect(d.kind).toBe("NEEDS_REVIEW");
    expect(d.reasons.some((r) => r.code === "huge_size")).toBe(true);
  });

  it("weights the composite and reports contributions that sum to it", () => {
    const { pr, aggregated } = answers("good");
    const d = decide(CLEAN_GATES, pr, aggregated, "small", policy());
    const sum = d.contributions.reduce((a, c) => a + c.points, 0);
    expect(sum).toBeCloseTo(d.composite, 0);
    expect(d.contributions.some((c) => c.questionId === "category")).toBe(false);
    expect(d.contributions.some((c) => c.questionId === "reviewer_directed_text")).toBe(false);
  });

  it("honours policy weight overrides", () => {
    const { pr, aggregated } = answers("good", { code_quality: scoreAnswer(0) });
    const normal = decide(CLEAN_GATES, pr, aggregated, "small", policy()).composite;
    const heavier = decide(
      CLEAN_GATES,
      pr,
      aggregated,
      "small",
      policy({ weights: { code_quality: 20 } }),
    ).composite;
    expect(heavier).toBeLessThan(normal);
  });

  it("names contributing factors even on a NEEDS_REVIEW route", () => {
    const { pr, aggregated } = answers("good", {
      needs_design_discussion: { type: "noul", noul: 0.8 },
      risk: scoreAnswer(3),
    });
    const d = decide(CLEAN_GATES, pr, aggregated, "small", policy());
    expect(d.reasons.some((r) => r.code === "needs_design")).toBe(true);
    expect(d.reasons.some((r) => r.code === "high_risk")).toBe(true);
  });

  it("never routes READY when the diff could not be fetched, whatever the policy says", () => {
    const { pr, aggregated } = answers("good");
    const gates = [
      ...CLEAN_GATES,
      { id: DIFF_UNAVAILABLE_GATE, severity: "info" as const, passed: false, detail: "GitHub would not serve the diff" },
    ];
    const d = decide(gates, pr, aggregated, "small", policy());
    expect(d.kind).toBe("NEEDS_REVIEW");
    expect(d.reasons.some((r) => r.code === DIFF_UNAVAILABLE_GATE && r.source === "gate")).toBe(true);
    expect(d.explanation.join(" ")).toContain("would not serve");

    // Policy cannot argue it away: not by a threshold of 0, nor by "off".
    const lenient = decide(gates, pr, aggregated, "small", policy({ readyThreshold: 0, confidenceFloor: 0 }));
    expect(lenient.kind).toBe("NEEDS_REVIEW");
    const silenced = decide(
      gates.map((g) => (g.id === DIFF_UNAVAILABLE_GATE ? { ...g, severity: "off" as const } : g)),
      pr,
      aggregated,
      "small",
      policy(),
    );
    expect(silenced.kind).toBe("NEEDS_REVIEW");

    // It is a note, not a blocker: a hard gate failure still reads as BLOCKED.
    const blocked = decide([...gates, gate("not_draft", "hard", false)], pr, aggregated, "small", policy());
    expect(blocked.kind).toBe("BLOCKED");
    expect(blocked.reasons.some((r) => r.code === DIFF_UNAVAILABLE_GATE)).toBe(true);

    // And it costs no composite points of its own.
    expect(d.composite).toBe(decide(CLEAN_GATES, pr, aggregated, "small", policy()).composite);
  });

  it("reports the risk ceiling from the catalog, not a hardcoded 3", () => {
    const levels = (QUESTIONS.find((q) => q.id === "risk")?.criteria as string[]).length;
    const { pr, aggregated } = answers("good", { risk: scoreAnswer(3) });
    const d = decide(CLEAN_GATES, pr, aggregated, "small", policy());
    expect(d.reasons.find((r) => r.code === "high_risk")?.text).toContain(`of ${levels - 1}`);
  });

  it("scores 0 and says so when there are no Jev answers at all", () => {
    const d = decide(CLEAN_GATES, {}, {}, "small", policy());
    expect(d.composite).toBe(0);
    expect(d.minConfidence).toBeNull();
    expect(d.reasons.some((r) => r.code === "no_jev_answers")).toBe(true);
    expect(d.kind).toBe("NEEDS_REVIEW");
  });
});
