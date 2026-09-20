import { describe, expect, it } from "vitest";

import { parseDiff } from "../src/server/chunk.js";
import { decide } from "../src/server/decide.js";
import { runGates } from "../src/server/gates.js";
import { buildProposal, proposalId, sanitize, signBody } from "../src/server/proposals.js";
import type { Evaluation, GateResult, JevAnswer } from "../src/shared/types.js";
import { diffOf, file, policy, snapshot } from "./fixtures.js";

function evaluationFor(gates: GateResult[], prAnswers: Record<string, JevAnswer>): Evaluation {
  const snap = snapshot();
  return {
    id: "ev_test",
    prNumber: snap.number,
    headSha: snap.headSha,
    evaluatedAt: new Date().toISOString(),
    mock: true,
    model: "jev-1.13.0",
    gates,
    prAnswers,
    chunks: [],
    coverage: "full",
    skippedFiles: [],
    aggregated: {},
    usage: { input_tokens: 10, output_tokens: 0, calls: 1, estCostUsd: 0 },
    decision: decide(gates, prAnswers, {}, "small", policy()),
    policyVersion: "test",
    durationMs: 1,
  };
}

describe("buildProposal", () => {
  const goodAnswers: Record<string, JevAnswer> = {
    single_concern: { type: "noul", noul: 0.95 },
    explains_why: { type: "noul", noul: 0.95 },
    states_testing: { type: "noul", noul: 0.95 },
    needs_design_discussion: { type: "noul", noul: 0.05 },
    reviewer_directed_text: { type: "noul", noul: 0.02 },
    risk: { type: "score", score: 0, legend: { "0": "isolated" }, probabilities: { "0": 0.9 }, confidence: 0.9 },
    description_quality: { type: "score", score: 3, legend: { "3": "thorough" }, probabilities: { "3": 0.9 }, confidence: 0.9 },
  };

  it("drafts a request-changes review for a BLOCKED PR with the blockers as a checklist", () => {
    const snap = snapshot({ draft: true, files: [file("platformio.ini")] });
    const gates = runGates(snap, parseDiff(""), policy());
    const evaluation = { ...evaluationFor(gates, goodAnswers), prNumber: snap.number, headSha: snap.headSha };
    const p = buildProposal({ snapshot: snap, evaluation, repoLabels: ["triage/blocked"] });

    expect(evaluation.decision.kind).toBe("BLOCKED");
    expect(p.kind).toBe("review_request_changes");
    expect(p.body).toContain("- [ ] **not_draft**");
    expect(p.body).toContain("- [ ] **forbidden_files**");
    expect(p.labels).toEqual(["triage/blocked"]);
    expect(p.rationale.some((r) => r.includes("not_draft"))).toBe(true);
  });

  it("drafts a friendly comment for a READY PR", () => {
    const snap = snapshot();
    const gates = runGates(snap, parseDiff(diffOf("lib/a.cpp", ["int a;"])), policy());
    const evaluation = evaluationFor(gates, goodAnswers);
    const p = buildProposal({ snapshot: snap, evaluation, repoLabels: ["triage/ready"] });
    expect(p.kind).toBe("comment");
    expect(p.body).toContain("ready for a maintainer's review");
    expect(p.labels).toEqual(["triage/ready"]);
  });

  it("sanitises untrusted evidence so a crafted path cannot escape or ping", () => {
    // A forbidden path, so it reaches the checklist as gate evidence.
    const hostile = "managed_components/@maintainer/`;rm -rf /`.c";
    const snap = snapshot({ draft: true, files: [file(hostile)] });
    const gates = runGates(snap, parseDiff(""), policy());
    const p = buildProposal({ snapshot: snap, evaluation: evaluationFor(gates, goodAnswers), repoLabels: [] });

    // No backtick from the PR survives into the body, so the code spans hold.
    const spanDelimiters = (p.body.match(/`/g) ?? []).length;
    expect(spanDelimiters % 2).toBe(0);
    // The path's own backticks are gone, so they cannot close our code span,
    // and the mention is defused.
    expect(p.body).not.toContain("/" + "`");
    expect(p.body).not.toContain("@maintainer");
    expect(p.body).toContain("@\u200bmaintainer");

    expect(sanitize("a`b")).toBe("a b");
    expect(sanitize("line1\nline2")).toBe("line1 line2");
    expect(sanitize("ping @team")).toBe("ping @\u200bteam");
  });

  it("never proposes a label that does not exist and says why", () => {
    const snap = snapshot();
    const gates = runGates(snap, parseDiff(""), policy());
    const p = buildProposal({ snapshot: snap, evaluation: evaluationFor(gates, goodAnswers), repoLabels: [] });
    expect(p.labels).toBeUndefined();
    expect(p.rationale.join(" ")).toContain("does not exist in this repository");
  });

  it("carries the head SHA in the proposal id and signs the footer at post time", () => {
    const snap = snapshot();
    const gates = runGates(snap, parseDiff(""), policy());
    const evaluation = evaluationFor(gates, goodAnswers);
    const p = buildProposal({ snapshot: snap, evaluation, repoLabels: [] });
    // The whole id is the staleness token, not a substring of it.
    expect(p.id).toBe(proposalId(snap.number, snap.headSha, evaluation.id));
    expect(p.id).toContain(snap.headSha);
    expect(p.body).toContain("<confirmedBy>");
    const signed = signBody(p.body, "dillera");
    expect(signed).toContain("posted by dillera after human review");
    expect(signed).not.toContain("<confirmedBy>");
  });
});
