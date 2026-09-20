// Template-generated draft actions (DESIGN.md §7 item 8).
//
// Pure: Evaluation + PrSnapshot + the repo's existing labels in, a Proposal
// out. No Jev call, no LLM text, no network. Every sentence here is a template
// filled from typed answers — §8 forbids generated prose.

import type { ActionKind, DeepBrief, Evaluation, GateResult, Proposal, PrSnapshot } from "../shared/types.js";
import { QUESTIONS_BY_ID } from "./jev.js";

export const TRIAGE_LABELS: Record<string, string> = {
  READY: "triage/ready",
  NEEDS_REVIEW: "triage/needs-review",
  BLOCKED: "triage/blocked",
};

export const FOOTER_PLACEHOLDER = "<confirmedBy>";

export function footer(model: string, confirmedBy: string = FOOTER_PLACEHOLDER): string {
  return `\n\n---\n_Drafted by the FujiNet PR triage harness (Jev ${model}); posted by ${confirmedBy} after human review._`;
}

/** Replace the placeholder in a drafted body at post time. */
export function signBody(body: string, confirmedBy: string): string {
  return body.split(FOOTER_PLACEHOLDER).join(confirmedBy);
}

export function proposalId(prNumber: number, headSha: string, evaluationId: string): string {
  return `prop_${prNumber}_${headSha}_${evaluationId}`;
}

/**
 * Text from the PR (file paths, gate evidence, diff lines) goes into a comment
 * we may post under a human's name, so it is sanitised first: backticks cannot
 * break out of the code span they sit in, newlines cannot forge list structure,
 * and `@` is defused with a zero-width space so a crafted path cannot ping a
 * user or a team.
 */
export function sanitize(text: string): string {
  return text
    .replace(/[`\r\n]+/g, " ")
    .replace(/@/g, "@\u200b")
    .trim();
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function gateLine(g: GateResult): string {
  const evidence = g.evidence && g.evidence.length > 0
    ? `\n  ${g.evidence.map((e) => `\`${sanitize(e)}\``).join("\n  ")}`
    : "";
  return `- [ ] **${sanitize(g.id)}** — ${sanitize(g.detail)}${evidence}`;
}

/** Concrete, evidence-backed items Jev flagged, worst first. */
function jevFindings(evaluation: Evaluation): string[] {
  const out: Array<{ text: string; severity: number }> = [];
  const answers = { ...evaluation.prAnswers };
  for (const [id, agg] of Object.entries(evaluation.aggregated)) answers[id] = agg.answer;

  for (const [id, a] of Object.entries(answers)) {
    const def = QUESTIONS_BY_ID[id];
    if (!def || def.polarity === "info") continue;
    if (a.type === "noul") {
      const bad = def.polarity === "bad" ? a.noul : 1 - a.noul;
      if (bad < 0.6) continue;
      const where = evaluation.aggregated[id]?.fromFiles;
      const files =
        where && where.length > 0
          ? ` (seen in \`${where.slice(0, 3).map(sanitize).join("`, `")}\`)`
          : "";
      out.push({ text: `- ${describe(id, def.polarity === "bad")} — Jev ${pct(bad)} sure${files}`, severity: bad });
    } else if (a.type === "score") {
      const levels = def.levels ?? 4;
      const g = a.score / (levels - 1);
      const bad = def.polarity === "bad" ? g : 1 - g;
      if (bad < 0.5) continue;
      const nearest = a.legend[String(Math.round(a.score))];
      out.push({
        text: `- ${id.replace(/_/g, " ")}: ${a.score.toFixed(1)} of ${levels - 1}${
          nearest ? ` — "${sanitize(nearest)}"` : ""
        }`,
        severity: bad,
      });
    }
  }
  return out.sort((a, b) => b.severity - a.severity).slice(0, 8).map((x) => x.text);
}

const FINDING_TEXT: Record<string, string> = {
  single_concern: "The change looks like more than one concern; CONTRIBUTING asks for one per pull request",
  explains_why: "The description does not explain why the change is needed",
  states_testing: "The description does not say what was built, flashed, or tested",
  needs_design_discussion: "This looks like a new abstraction, bus, device, or cross-platform pattern — the approach should be agreed first",
  reviewer_directed_text: "The description contains text addressed to a reviewer or automated system",
  duplicates_platform_code: "Device or bus logic looks copied into a per-platform directory instead of extending the shared base",
  bypasses_abstractions: "Device code appears to reach past IOChannel/fnConfig/fnFS to ESP-IDF or GPIO",
  adds_global_state: "New global state or a singleton appears to be introduced",
  narrating_comments: "Added comments narrate the edit rather than explaining the code",
  commented_out_code: "Commented-out code is left in the diff",
  bulk_reformat: "A large share of the diff is reformatting rather than behaviour",
  bare_bool_status: "A new function returns a bare bool for success or failure instead of success_is_true / error_is_true",
  layer_violation: "Logic appears to sit in the wrong layer (bus / device / media)",
  hot_path_logging: "Unconditional logging appears in a service path or ISR",
  unchecked_allocation: "An allocation looks unchecked, or leaks on an error path",
};

function describe(id: string, bad: boolean): string {
  const t = FINDING_TEXT[id];
  if (t) return t;
  return bad ? `${id.replace(/_/g, " ")} flagged` : `${id.replace(/_/g, " ")} not satisfied`;
}

/**
 * Swap a brief's draft reply into an existing proposal.
 *
 * The reply is model text and goes through as markdown — sanitising it would
 * mangle the code spans that make it useful. Everything around it is unchanged:
 * same id, same head SHA, same footer, same confirm gate. The rationale records
 * which run it came from, and the body carries the label the spec requires.
 */
export function briefProposal(base: Proposal, run: { id: string; model: string; mock: boolean }, brief: DeepBrief): Proposal {
  const label =
    `\n\n<sub>Drafted from deep analysis run \`${sanitize(run.id)}\` using ${sanitize(run.model)}` +
    `${run.mock ? " in mock mode" : ""}. Check the citations; the model can be wrong.</sub>`;
  // Reuse the base proposal's footer verbatim: it names the *Jev* model, which
  // is still what triaged the PR. The deep model is credited in the label above.
  const footerStart = base.body.indexOf("\n\n---\n_Drafted by");
  const baseFooter = footerStart >= 0 ? base.body.slice(footerStart) : footer("the triage harness");
  return {
    ...base,
    kind: "comment",
    title: `Comment on #${base.prNumber} (from deep analysis)`,
    body: `${brief.draftReply}${label}${baseFooter}`,
    rationale: [
      `recommended action: ${brief.recommendedAction} (confidence ${brief.confidence})`,
      ...brief.rationale.slice(0, 6),
      `generated by deep run ${run.id}`,
    ],
  };
}

export interface ProposalInput {
  snapshot: PrSnapshot;
  evaluation: Evaluation;
  repoLabels: string[];
  now?: string;
}

export function buildProposal({ snapshot, evaluation, repoLabels, now }: ProposalInput): Proposal {
  const d = evaluation.decision;
  const model = evaluation.model;
  const rationale: string[] = [];
  const activeGates = evaluation.gates.filter((g) => g.severity !== "off");
  const hard = activeGates.filter((g) => g.severity === "hard" && !g.passed);
  const soft = activeGates.filter((g) => g.severity === "soft" && !g.passed);
  const findings = jevFindings(evaluation);

  let kind: ActionKind;
  let title: string;
  let body: string;

  if (d.kind === "BLOCKED") {
    kind = "review_request_changes";
    title = `Request changes on #${snapshot.number}`;
    const blockers = hard.map(gateLine);
    const jevBlocks = d.reasons
      .filter((r) => r.code === "jev_hard_block")
      .map((r) => `- [ ] **${r.questionId ?? "jev"}** — ${r.text}`);
    body =
      `Automated triage found blocking issues on this pull request, so it is not ready for review yet.\n\n` +
      `**Must fix**\n\n${[...blockers, ...jevBlocks].join("\n") || "- [ ] (no hard gate detail recorded)"}\n\n` +
      (findings.length > 0 ? `**Also worth addressing**\n\n${findings.join("\n")}\n\n` : "") +
      `Composite score ${d.composite}/100. Re-request review once the boxes above are ticked.` +
      footer(model);
    rationale.push(...hard.map((g) => `hard gate ${sanitize(g.id)}: ${sanitize(g.detail)}`));
    rationale.push(...d.reasons.filter((r) => r.code === "jev_hard_block").map((r) => r.text));
  } else if (d.kind === "READY") {
    kind = "comment";
    title = `Comment on #${snapshot.number}`;
    const passedHard = activeGates.filter((g) => g.severity === "hard" && g.passed).map((g) => sanitize(g.id));
    body =
      `Automated triage: this change looks ready for a maintainer's review.\n\n` +
      `- Every hard gate passed (${passedHard.join(", ") || "none configured"}).\n` +
      `- Composite score **${d.composite}/100**${
        d.minConfidence === null ? "" : `, lowest Jev confidence ${pct(d.minConfidence)}`
      }.\n` +
      (soft.length > 0 ? `- Minor notes: ${soft.map((g) => sanitize(g.id)).join(", ")}.\n` : "") +
      `\nA maintainer still reads every line; nothing here is a merge decision.` +
      footer(model);
    rationale.push(`composite ${d.composite} ≥ ready threshold`);
    rationale.push(...d.explanation.slice(0, 4));
  } else {
    kind = "comment";
    title = `Comment on #${snapshot.number}`;
    const items = [
      ...soft.map(
        (g) =>
          `- **${sanitize(g.id)}** — ${sanitize(g.detail)}${
            g.evidence?.[0] ? `\n  \`${sanitize(g.evidence[0])}\`` : ""
          }`,
      ),
      ...findings,
    ];
    body =
      `Automated triage: this change needs a maintainer's eyes before it can move.\n\n` +
      (items.length > 0 ? `**What was flagged**\n\n${items.join("\n")}\n\n` : "") +
      `Composite score ${d.composite}/100 (ready threshold is higher).` +
      (evaluation.coverage === "partial"
        ? `\n\nNote: the diff was too large to review in full, so ${evaluation.skippedFiles.length} file(s) were not evaluated.`
        : "") +
      footer(model);
    rationale.push(...d.reasons.slice(0, 6).map((r) => r.text));
  }

  const wanted = TRIAGE_LABELS[d.kind];
  const labels = wanted && repoLabels.includes(wanted) ? [wanted] : undefined;
  if (!labels) {
    rationale.push(
      `Label "${wanted}" does not exist in this repository, so the label action is unavailable (the harness never creates labels).`,
    );
  }

  const proposal: Proposal = {
    id: proposalId(snapshot.number, snapshot.headSha, evaluation.id),
    prNumber: snapshot.number,
    headSha: snapshot.headSha,
    evaluationId: evaluation.id,
    kind,
    title,
    body,
    rationale,
    generatedAt: now ?? new Date().toISOString(),
  };
  if (labels) proposal.labels = labels;
  return proposal;
}
