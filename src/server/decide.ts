// Composite scoring and confidence-gated routing (DESIGN.md §4.5).
//
// Pure. The UI re-derives decisions from stored raw answers by calling
// POST /api/decide with a trial policy, so nothing in here may touch the
// network, the clock, or the filesystem.

import type {
  AggregatedAnswer,
  Decision,
  GateResult,
  JevAnswer,
  Policy,
  QuestionDef,
  Reason,
  SizeBucket,
} from "../shared/types.js";
import { QUESTIONS, QUESTIONS_BY_ID } from "./jev.js";

/**
 * Pseudo-gate the pipeline appends when GitHub would not serve the diff. It is
 * checked here whatever severity the policy gives it (even "off"): with no diff
 * every added-line gate passed for want of anything to read, so the evidence a
 * READY would rest on does not exist.
 */
export const DIFF_UNAVAILABLE_GATE = "diff_unavailable";

const UNCERTAIN_LOW = 0.35;
const UNCERTAIN_HIGH = 0.65;

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function weightOf(q: QuestionDef, policy: Policy): number {
  const w = policy.weights[q.id];
  return typeof w === "number" && Number.isFinite(w) ? w : q.weight;
}

function levelsOf(q: QuestionDef): number {
  if (typeof q.levels === "number") return q.levels;
  return Array.isArray(q.criteria) ? q.criteria.length : 4;
}

/** Normalised "goodness" in [0,1] for one answer (DESIGN.md §4.5 step 3). */
export function goodness(answer: JevAnswer, q: QuestionDef): number | null {
  if (answer.type === "noul") {
    return q.polarity === "bad" ? 1 - answer.noul : answer.noul;
  }
  if (answer.type === "score") {
    const levels = levelsOf(q);
    if (levels < 2) return null;
    const g = answer.score / (levels - 1);
    return q.polarity === "bad" ? 1 - g : g;
  }
  return null; // Choice answers do not contribute to the composite.
}

// --- explanation templates --------------------------------------------------

interface Phrases {
  yes: string;
  no: string;
}

const NOUL_PHRASES: Record<string, Phrases> = {
  single_concern: {
    yes: "the pull request describes exactly one concern",
    no: "the pull request bundles more than one concern",
  },
  explains_why: {
    yes: "the description explains why the change is needed",
    no: "the description does not explain why the change is needed",
  },
  states_testing: {
    yes: "the description states how the change was tested",
    no: "the description does not say how the change was tested",
  },
  needs_design_discussion: {
    yes: "this change needs its design agreed before code",
    no: "this is a contained change that needs no design discussion first",
  },
  reviewer_directed_text: {
    yes: "the description contains text aimed at a reviewer or automated system",
    no: "the description contains no text aimed at a reviewer or automated system",
  },
  duplicates_platform_code: {
    yes: "the diff copies platform code instead of extending the shared base",
    no: "the diff extends the shared base rather than copying platform code",
  },
  bypasses_abstractions: {
    yes: "device code reaches past IOChannel/fnConfig/fnFS to ESP-IDF or GPIO",
    no: "the code goes through the existing abstractions",
  },
  adds_global_state: {
    yes: "the change adds new global state or a singleton",
    no: "the change adds no new global state",
  },
  narrating_comments: {
    yes: "added comments narrate the edit instead of explaining the code",
    no: "added comments explain the code rather than the edit",
  },
  commented_out_code: {
    yes: "the diff leaves commented-out code behind",
    no: "the diff leaves no commented-out code",
  },
  bulk_reformat: {
    yes: "much of the diff is reformatting rather than behaviour",
    no: "the changed lines are substantive rather than reformatting",
  },
  bare_bool_status: {
    yes: "a new function returns a bare bool for success or failure",
    no: "status is returned with the typed success_is_true/error_is_true results",
  },
  layer_violation: {
    yes: "logic is placed in the wrong layer (bus / device / media)",
    no: "each change sits in the layer that owns it",
  },
  hot_path_logging: {
    yes: "unconditional logging is added to a service path or ISR",
    no: "no unconditional logging is added to a hot path",
  },
  unchecked_allocation: {
    yes: "an allocation is unchecked or leaks on an error path",
    no: "allocations are checked and owned",
  },
};

const SCORE_LABEL: Record<string, string> = {
  risk: "cross-platform risk",
  description_quality: "description quality",
  code_quality: "code quality",
};

function explainAnswer(id: string, answer: JevAnswer, q: QuestionDef): string | null {
  if (answer.type === "noul") {
    const p = NOUL_PHRASES[id];
    if (!p) return null;
    const lean = answer.noul >= 0.5;
    const conf = lean ? answer.noul : 1 - answer.noul;
    return `Jev is ${pct(conf)} sure ${lean ? p.yes : p.no} (${id}).`;
  }
  if (answer.type === "score") {
    const levels = levelsOf(q);
    const nearest = String(Math.round(answer.score));
    const legend = answer.legend[nearest];
    const label = SCORE_LABEL[id] ?? id;
    return `Jev puts ${label} at ${answer.score.toFixed(1)} of ${levels - 1}${
      legend ? ` — "${legend}"` : ""
    } (${pct(answer.confidence)} confident, ${id}).`;
  }
  return `Jev categorises this pull request as "${answer.choice}" (${pct(answer.confidence)} confident, ${id}).`;
}

// --- the decision -----------------------------------------------------------

export function decide(
  gates: GateResult[],
  prAnswers: Record<string, JevAnswer>,
  aggregated: Record<string, AggregatedAnswer>,
  sizeBucket: SizeBucket,
  policy: Policy,
): Decision {
  const reasons: Reason[] = [];
  const explanation: string[] = [];

  const answers: Record<string, JevAnswer> = { ...prAnswers };
  for (const [id, agg] of Object.entries(aggregated)) answers[id] = agg.answer;

  // Policy-independent: a missing diff can never be argued into a READY.
  const diffUnavailable = gates.some((g) => g.id === DIFF_UNAVAILABLE_GATE && !g.passed);

  // 1. Hard gates.
  const active = gates.filter((g) => g.severity !== "off" && g.id !== DIFF_UNAVAILABLE_GATE);
  const hardFailed = active.filter((g) => g.severity === "hard" && !g.passed);
  const softFailed = active.filter((g) => g.severity === "soft" && !g.passed);

  for (const g of hardFailed) {
    reasons.push({ code: "hard_gate", text: `${g.id}: ${g.detail}`, source: "gate", gateId: g.id, severity: "hard" });
    explanation.push(`Hard gate ${g.id} failed: ${g.detail}.`);
  }

  // 2. Hard Jev blocks.
  const hardBlocked: string[] = [];
  for (const q of QUESTIONS) {
    const threshold = policy.hardBlocks[q.id] ?? q.hardBlockAbove;
    if (typeof threshold !== "number") continue;
    const a = answers[q.id];
    if (!a || a.type !== "noul") continue;
    if (a.noul >= threshold) {
      hardBlocked.push(q.id);
      reasons.push({
        code: "jev_hard_block",
        text: `${q.id}: Jev is ${pct(a.noul)} sure, at or above the ${pct(threshold)} hard-block threshold`,
        source: "jev",
        questionId: q.id,
        severity: "hard",
      });
      const line = explainAnswer(q.id, a, q);
      if (line) explanation.push(line);
    }
  }

  // 3. Composite.
  const contributions: Decision["contributions"] = [];
  let weightSum = 0;
  let weighted = 0;
  for (const q of QUESTIONS) {
    const w = weightOf(q, policy);
    if (w <= 0) continue;
    const a = answers[q.id];
    if (!a) continue;
    const g = goodness(a, q);
    if (g === null) continue;
    weightSum += w;
    weighted += w * g;
    contributions.push({ questionId: q.id, weight: w, goodness: Number(g.toFixed(4)), points: 0 });
  }
  let composite = weightSum > 0 ? (100 * weighted) / weightSum : 0;
  for (const c of contributions) {
    c.points = weightSum > 0 ? Number(((100 * c.weight * c.goodness) / weightSum).toFixed(2)) : 0;
  }
  if (weightSum === 0) {
    reasons.push({ code: "no_jev_answers", text: "No weighted Jev answers were available", source: "policy" });
  }

  const penalty = softFailed.length * policy.softGatePenalty;
  composite = Math.max(0, composite - penalty);
  composite = Number(composite.toFixed(1));

  for (const g of softFailed) {
    reasons.push({
      code: "soft_gate",
      text: `${g.id}: ${g.detail} (-${policy.softGatePenalty})`,
      source: "gate",
      gateId: g.id,
      severity: "soft",
    });
  }

  // 4. Confidence.
  let minConfidence: number | null = null;
  const uncertainNouls: string[] = [];
  for (const q of QUESTIONS) {
    const w = weightOf(q, policy);
    if (w <= 0) continue;
    const a = answers[q.id];
    if (!a) continue;
    if (a.type === "choice" || a.type === "score") {
      minConfidence = minConfidence === null ? a.confidence : Math.min(minConfidence, a.confidence);
    } else if (a.noul >= UNCERTAIN_LOW && a.noul <= UNCERTAIN_HIGH) {
      uncertainNouls.push(q.id);
    }
  }

  // 5. Route.
  let kind: Decision["kind"];
  if (hardFailed.length > 0 || hardBlocked.length > 0) {
    kind = "BLOCKED";
    if (diffUnavailable) {
      reasons.push({
        code: DIFF_UNAVAILABLE_GATE,
        text: "GitHub would not serve the diff, so no line-level gate or code question could run",
        source: "gate",
        gateId: DIFF_UNAVAILABLE_GATE,
      });
    }
  } else {
    const confidenceOk = minConfidence !== null && minConfidence >= policy.confidenceFloor;
    const uncertainOk = uncertainNouls.length <= policy.maxUncertainNouls;
    const sizeOk = sizeBucket !== "huge";
    if (composite >= policy.readyThreshold && confidenceOk && uncertainOk && sizeOk && !diffUnavailable) {
      kind = "READY";
      reasons.push({
        code: "ready",
        text: `Composite ${composite} is at or above the ready threshold ${policy.readyThreshold} with no blockers`,
        source: "policy",
      });
    } else {
      kind = "NEEDS_REVIEW";
      if (composite < policy.reviewThreshold) {
        reasons.push({
          code: "low_composite",
          text: `Composite ${composite} is below the review threshold ${policy.reviewThreshold}`,
          source: "policy",
        });
      } else if (composite < policy.readyThreshold) {
        reasons.push({
          code: "mid_composite",
          text: `Composite ${composite} is below the ready threshold ${policy.readyThreshold}`,
          source: "policy",
        });
      }
      if (!confidenceOk) {
        reasons.push({
          code: "low_confidence",
          text: minConfidence === null
            ? "No Choice or Score answer carried a confidence value"
            : `Lowest Jev confidence ${pct(minConfidence)} is below the floor ${pct(policy.confidenceFloor)}`,
          source: "policy",
        });
      }
      if (!uncertainOk) {
        reasons.push({
          code: "uncertain_nouls",
          text: `${uncertainNouls.length} question(s) landed in the uncertain band: ${uncertainNouls.join(", ")}`,
          source: "jev",
        });
      }
      if (!sizeOk) {
        reasons.push({ code: "huge_size", text: "Change is in the huge size bucket", source: "gate", gateId: "size_bucket" });
      }
      if (diffUnavailable) {
        reasons.push({
          code: DIFF_UNAVAILABLE_GATE,
          text: "GitHub would not serve the diff, so no line-level gate or code question could run — a human must read the change",
          source: "gate",
          gateId: DIFF_UNAVAILABLE_GATE,
        });
      }
    }
  }

  // Contributing factors worth naming whatever the route (§4.5 step 5).
  const design = answers["needs_design_discussion"];
  if (design?.type === "noul" && design.noul >= 0.6) {
    reasons.push({
      code: "needs_design",
      text: `Jev is ${pct(design.noul)} sure the approach should be agreed before code`,
      source: "jev",
      questionId: "needs_design_discussion",
    });
  }
  const risk = answers["risk"];
  const riskDef = QUESTIONS_BY_ID["risk"];
  if (risk?.type === "score" && riskDef && risk.score >= 2.0) {
    reasons.push({
      code: "high_risk",
      text: `Cross-platform risk scored ${risk.score.toFixed(1)} of ${levelsOf(riskDef) - 1}`,
      source: "jev",
      questionId: "risk",
    });
  }

  // Explanation: the worst contributors first, then the informational choice.
  const ranked = [...contributions].sort((a, b) => a.goodness - b.goodness).slice(0, 5);
  for (const c of ranked) {
    const q = QUESTIONS_BY_ID[c.questionId];
    const a = answers[c.questionId];
    if (!q || !a) continue;
    const line = explainAnswer(c.questionId, a, q);
    if (line && !explanation.includes(line)) explanation.push(line);
  }
  const category = answers["category"];
  const categoryDef = QUESTIONS_BY_ID["category"];
  if (category && categoryDef) {
    const line = explainAnswer("category", category, categoryDef);
    if (line) explanation.push(line);
  }
  if (softFailed.length > 0) {
    explanation.push(
      `${softFailed.length} soft gate(s) cost ${penalty} points: ${softFailed.map((g) => g.id).join(", ")}.`,
    );
  }
  if (diffUnavailable) {
    explanation.push(
      "GitHub would not serve this pull request's diff, so the code-level questions and every added-line gate had nothing to read.",
    );
  }
  explanation.push(
    `Composite ${composite} of 100 against ready ${policy.readyThreshold} / review ${policy.reviewThreshold} → ${kind}.`,
  );

  return { kind, composite, minConfidence, uncertainNouls, reasons, explanation, contributions };
}
