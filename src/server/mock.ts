// Deterministic fake Jev answers (DESIGN.md §4.4 "Mock mode").
//
// Same JevBackend interface as the real transports, same answer shapes, same
// confidence arithmetic the API uses:
//   Choice confidence = (n * peak - 1) / (n - 1), clamped to [0,1]
//   Score  confidence = the same formula over the level probabilities
//
// Seeded from hash(prNumber, questionId, chunkSalt) so a given PR always
// produces the same dashboard. Answers are *biased* by the PR's size bucket and
// description length so a small well-described PR reads as good and a 78-file
// one-sentence PR reads as bad — the demo needs all three decision kinds.

import type { JevAnswer, SizeBucket } from "../shared/types.js";
import type { JevBackend, JevRequest, JevResponse } from "./jev.js";
import { estimateTokens, } from "./chunk.js";
import { QUESTIONS_BY_ID } from "./jev.js";

export const MOCK_MODEL = "jev-1.13.0-mock";

// --- deterministic PRNG -----------------------------------------------------

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(x: number, lo = 0, hi = 1): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// --- answer shaping ---------------------------------------------------------

/** Probability mass peaked on `peak`, sharpness from the rng. */
function distribution(n: number, peak: number, sharpness: number): number[] {
  const raw = Array.from({ length: n }, (_, i) => Math.exp(-Math.abs(i - peak) * sharpness));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / sum);
}

/** The API's reported confidence for a categorical distribution. */
export function confidenceFromProbabilities(p: readonly number[]): number {
  const n = p.length;
  if (n <= 1) return 1;
  const peak = Math.max(...p);
  return clamp((n * peak - 1) / (n - 1));
}

function choiceAnswer(labels: string[], peakIndex: number, sharpness: number): JevAnswer {
  const probs = distribution(labels.length, peakIndex, sharpness);
  const probabilities: Record<string, number> = {};
  labels.forEach((l, i) => {
    probabilities[l] = round3(probs[i] ?? 0);
  });
  let best = 0;
  probs.forEach((p, i) => {
    if (p > (probs[best] ?? 0)) best = i;
  });
  return {
    type: "choice",
    choice: labels[best] ?? (labels[0] ?? ""),
    probabilities,
    confidence: round3(confidenceFromProbabilities(probs)),
  };
}

function scoreAnswer(levels: string[], peakIndex: number, sharpness: number): JevAnswer {
  const probs = distribution(levels.length, peakIndex, sharpness);
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  levels.forEach((l, i) => {
    probabilities[String(i)] = round3(probs[i] ?? 0);
    legend[String(i)] = l;
  });
  const score = probs.reduce((acc, p, i) => acc + p * i, 0);
  return {
    type: "score",
    score: round3(score),
    legend,
    probabilities,
    confidence: round3(confidenceFromProbabilities(probs)),
  };
}

// --- PR flavour -------------------------------------------------------------

export interface MockContext {
  prNumber: number;
  title: string;
  body: string;
  sizeBucket: SizeBucket;
  filesChanged: number;
  draft: boolean;
}

const SIZE_ADJUST: Record<SizeBucket, number> = {
  tiny: 0.22,
  small: 0.12,
  medium: 0,
  large: -0.16,
  huge: -0.3,
};

/** 0 = everything about this PR looks bad, 1 = everything looks good. */
export function mockQuality(ctx: MockContext): number {
  const bodyLen = (ctx.body ?? "").replace(/\s+/g, " ").trim().length;
  let q = 0.5;
  if (bodyLen >= 400) q += 0.28;
  else if (bodyLen >= 200) q += 0.18;
  else if (bodyLen >= 80) q += 0.05;
  else if (bodyLen >= 40) q -= 0.08;
  else q -= 0.28;
  q += SIZE_ADJUST[ctx.sizeBucket];
  if (ctx.draft) q -= 0.12;
  if (ctx.filesChanged > 30) q -= 0.08;
  return clamp(q, 0.04, 0.96);
}

const REVIEWER_DIRECTED = [
  /ignore (all )?(previous|prior) (instructions|rules)/i,
  /\b(approve|merge) this (pr|pull request)\b/i,
  /\bdo not (review|block|reject)\b/i,
  /\bautomated (reviewer|system)\b/i,
  /\bas an ai\b/i,
  /\brate this (pr|change) (as )?(ready|high)/i,
];

function looksReviewerDirected(body: string): boolean {
  return REVIEWER_DIRECTED.some((re) => re.test(body));
}

// --- the backend ------------------------------------------------------------

export class MockJevBackend implements JevBackend {
  readonly label = "mock";
  readonly #ctx: MockContext;

  constructor(ctx: MockContext) {
    this.#ctx = ctx;
  }

  systemOne(req: JevRequest): Promise<JevResponse> {
    const ctx = this.#ctx;
    const quality = mockQuality(ctx);
    // The chunk state's file list is the stable per-chunk salt; the PR-level
    // state has no `files` key and salts to 0.
    const state = req.state as { files?: Array<{ path: string }> } | undefined;
    const salt = state?.files ? hashString(state.files.map((f) => f.path).join("|")) : 0;

    const answers: Record<string, JevAnswer> = {};
    for (const id of Object.keys(req.questions)) {
      const def = QUESTIONS_BY_ID[id];
      if (!def) continue;
      const rng = mulberry32(hashString(`${ctx.prNumber}:${id}:${salt}`));
      const jitter = (rng() - 0.5) * 0.24;
      const sharpness = 0.9 + rng() * 1.8;

      if (id === "reviewer_directed_text") {
        const hit = looksReviewerDirected(ctx.body ?? "");
        answers[id] = { type: "noul", noul: round3(hit ? 0.82 + rng() * 0.14 : 0.02 + rng() * 0.1) };
        continue;
      }

      if (def.type === "noul") {
        const good = clamp(quality + jitter, 0.02, 0.98);
        answers[id] = {
          type: "noul",
          noul: round3(def.polarity === "bad" ? clamp(1 - good, 0.02, 0.98) : good),
        };
        continue;
      }

      if (def.type === "choice") {
        const labels = Object.keys((def.criteria ?? {}) as Record<string, unknown>);
        if (labels.length === 0) continue;
        // Bigger, vaguer PRs drift toward "mixed"; focused ones toward bugfix.
        const peak = quality > 0.6
          ? labels.indexOf("bugfix")
          : quality < 0.35
            ? labels.indexOf("mixed")
            : Math.floor(rng() * labels.length);
        answers[id] = choiceAnswer(labels, peak < 0 ? 0 : peak, sharpness);
        continue;
      }

      const levels = (def.criteria as string[] | undefined) ?? [];
      if (levels.length < 2) continue;
      const goodness = clamp(quality + jitter, 0.02, 0.98);
      const target = def.polarity === "bad" ? 1 - goodness : goodness;
      const peak = Math.round(target * (levels.length - 1));
      answers[id] = scoreAnswer(levels, peak, sharpness);
    }

    const input = estimateTokens(JSON.stringify(req.state)) + estimateTokens(JSON.stringify(req.questions));
    return Promise.resolve({
      model: MOCK_MODEL,
      answers,
      usage: { input_tokens: input, output_tokens: 0 },
    });
  }
}
