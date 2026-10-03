// From evidence + Jev answers to one recommendation per issue. Pure.
//
// The order of the rules is the order of certainty: a merged pull request that
// says "fixes #n" beats a model's reading of the thread, which beats a model's
// reading of the code evidence, which beats age alone. Age alone never closes
// anything — an old issue with no other signal gets a question, not a close.
//
// Every sentence in a drafted comment is a template filled from typed facts
// (proposals.ts rule): no generated prose is ever posted.

import type {
  IssueActionKind,
  IssueEvidence,
  IssueRecommendation,
  IssueRecommendationKind,
  IssueSnapshot,
  JevAnswer,
} from "../shared/types.js";
import { FOOTER_PLACEHOLDER, sanitize } from "./proposals.js";

export const ISSUE_THRESHOLDS = {
  /** A noul at or above this counts as "yes". */
  yes: 0.7,
  /** Text addressed to automation: never offer a one-click close. */
  automationBlock: 0.7,
  /** A maintainer question unanswered for this long reads as no response. */
  noResponseDays: 60,
  /** Quiet this long with nothing else to go on: ask whether it still applies. */
  staleDays: 365,
  /** still_relevant at or below this (0..3) reads as "no longer applies". */
  irrelevantScore: 0.9,
  /** still_relevant at or above this (0..3) reads as "still applies". */
  relevantScore: 2,
  /**
   * "The code moved on" closes only an issue that is old and has gone quiet.
   * Code being refactored is not the bug being fixed, and a fresh comment —
   * often a reproduction on current firmware — outranks any reading of the tree.
   */
  obsoleteMinAgeDays: 180,
  obsoleteQuietDays: 90,
} as const;

/** Labels the harness would add if the repository already has them. It never creates labels. */
export const STALE_LABEL_CANDIDATES = ["stale", "needs info", "needs-info", "more info needed", "awaiting response"];

const ACTION_FOR: Record<IssueRecommendationKind, IssueActionKind | null> = {
  reply_to_harness: null, // decided by what the reply says, in followupRecommendation()
  close_fixed: "close_completed",
  close_answered: "close_completed",
  close_obsolete: "close_not_planned",
  close_no_response: "close_not_planned",
  ask_still_relevant: "comment",
  keep_open: null,
  needs_human: null,
};

export const RECOMMENDATION_LABEL: Record<IssueRecommendationKind, string> = {
  reply_to_harness: "Replied to us",
  close_fixed: "Close: fixed",
  close_answered: "Close: answered",
  close_obsolete: "Close: obsolete",
  close_no_response: "Close: no response",
  ask_still_relevant: "Ask if still relevant",
  keep_open: "Keep open",
  needs_human: "Needs a human",
};

function noul(answers: Record<string, JevAnswer>, id: string): number | null {
  const a = answers[id];
  return a?.type === "noul" ? a.noul : null;
}

function score(answers: Record<string, JevAnswer>, id: string): { score: number; confidence: number } | null {
  const a = answers[id];
  return a?.type === "score" ? { score: a.score, confidence: a.confidence } : null;
}

function choice(answers: Record<string, JevAnswer>, id: string): string | null {
  const a = answers[id];
  return a?.type === "choice" ? a.choice : null;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function footer(model: string): string {
  return `\n\n---\n_Drafted by the FujiNet triage harness (Jev ${model}); posted by ${FOOTER_PLACEHOLDER} after human review._`;
}

function ago(daysN: number): string {
  if (daysN >= 730) return `about ${Math.round(daysN / 365)} years`;
  if (daysN >= 60) return `about ${Math.round(daysN / 30)} months`;
  return `${daysN} days`;
}

const REOPEN =
  "If you can still reproduce this on a current firmware build, please reopen it (or open a new issue) with the firmware version, the platform, and the steps.";

function missingRefLines(evidence: IssueEvidence): string[] {
  return evidence.codeRefs
    .filter((r) => r.status === "missing" || r.status === "renamed_or_moved")
    .slice(0, 6)
    .map((r) =>
      r.status === "missing"
        ? `- \`${sanitize(r.text)}\` no longer exists in the codebase`
        : `- \`${sanitize(r.text)}\` is no longer at that path (same name now at \`${sanitize(r.matches[0] ?? "")}\`)`,
    );
}

function mergedPrLines(snapshot: IssueSnapshot): string[] {
  const opened = Date.parse(snapshot.createdAt);
  return snapshot.linkedPrs
    .filter((p) => p.state === "merged" && p.mergedAt !== null && Date.parse(p.mergedAt) >= opened)
    .sort((a, b) => Number(b.closingKeyword) - Number(a.closingKeyword))
    .slice(0, 3)
    .map((p) => `- #${p.number} ${sanitize(p.title)}${p.mergedAt ? ` (merged ${p.mergedAt.slice(0, 10)})` : ""}`);
}

export function draftBody(
  kind: IssueRecommendationKind,
  snapshot: IssueSnapshot,
  evidence: IssueEvidence,
  model: string,
): string {
  const f = footer(model);
  switch (kind) {
    case "close_fixed": {
      const prs = mergedPrLines(snapshot);
      return (
        (prs.length > 0
          ? `This looks to have been addressed by:\n\n${prs.join("\n")}\n\n`
          : `The discussion above indicates this has been fixed.\n\n`) +
        `Closing as completed. ${REOPEN}${f}`
      );
    }
    case "close_answered":
      return `This looks to have been answered in the thread above, so closing it. Reopen if there is more to it.${f}`;
    case "close_obsolete": {
      const missing = missingRefLines(evidence);
      const churn =
        evidence.commitsTouchingRefsSinceOpened && evidence.commitsTouchingRefsSinceOpened > 0
          ? `The files it names have changed in ${evidence.commitsTouchingRefsSinceOpened} commit(s) since then.`
          : evidence.commitsSinceOpened && evidence.commitsSinceOpened > 0
            ? `There have been ${evidence.commitsSinceOpened} commits to the firmware since then.`
            : "";
      return (
        `This issue was opened ${ago(evidence.ageDays)} ago, and the code it refers to has changed since.` +
        (missing.length > 0 ? `\n\n${missing.join("\n")}` : "") +
        (churn ? `\n\n${churn}` : "") +
        `\n\nClosing as no longer applicable to the current firmware. ${REOPEN}${f}`
      );
    }
    case "close_no_response": {
      const when = evidence.daysSinceMaintainerComment ?? evidence.daysSinceActivity;
      return (
        `More information was asked for here ${ago(when)} ago and there has been no reply, so closing this for now. ` +
        `${REOPEN}${f}`
      );
    }
    case "ask_still_relevant":
      return (
        `This issue has had no activity for ${ago(evidence.daysSinceActivity)}` +
        (evidence.commitsSinceOpened && evidence.commitsSinceOpened > 0
          ? `, and there have been ${evidence.commitsSinceOpened} commits to the firmware since it was opened`
          : "") +
        `. Is this still happening on a current firmware build? If so, please add the firmware version and platform; ` +
        `if there is no update it may be closed in a later cleanup.${f}`
      );
    default:
      return "";
  }
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Someone answered a comment this harness posted. That always goes to the top
 * of a human's queue — it is a person talking to us — and the replies decide
 * the suggested action. "Still happens" wins over "fixed" when both read high:
 * keeping an issue open by mistake costs a click, closing one on a reporter who
 * just said it is broken costs their trust.
 */
function followupRecommendation(
  input: RecommendInput,
  reasons: string[],
): IssueRecommendation | null {
  const f = input.evidence.followup;
  if (!f) return null;
  const { answers } = input;
  const resolved = noul(answers, "followup_says_resolved");
  const still = noul(answers, "followup_says_still_happens");
  const info = noul(answers, "followup_provides_info");
  const T = ISSUE_THRESHOLDS;

  let verdict: NonNullable<IssueRecommendation["followupVerdict"]> = "unclear";
  if (!input.jevError) {
    if (still !== null && still >= T.yes && (resolved === null || still >= resolved)) verdict = "still_happens";
    else if (resolved !== null && resolved >= T.yes) verdict = "resolved";
    else if (info !== null && info >= T.yes) verdict = "info_provided";
  }

  const who = [...new Set(f.replies.map((r) => `${r.author} (${r.role})`))].join(", ");
  const last = f.replies.at(-1);
  const lead = [
    `${f.replies.length} repl${f.replies.length === 1 ? "y" : "ies"} from ${who} to the comment ${f.postedBy} posted through the harness on ${shortDate(f.commentAt)}`,
    ...(last ? [`latest reply: "${last.body.replace(/\s+/g, " ").slice(0, 200)}${last.body.length > 200 ? "…" : ""}"`] : []),
  ];
  if (!f.reporterReplied) lead.push("the original reporter has not replied; someone else did");
  if (still !== null) lead.push(`Jev: reply says it still happens ${pct(still)}`);
  if (resolved !== null) lead.push(`Jev: reply says it is resolved ${pct(resolved)}`);
  if (info !== null) lead.push(`Jev: reply supplies what was asked ${pct(info)}`);
  if (f.commitsTouchingRefsSinceComment !== null) {
    lead.push(`${f.commitsTouchingRefsSinceComment} commit(s) to the files it names since our comment`);
  }
  if (f.prsMergedSinceComment > 0) lead.push(`${f.prsMergedSinceComment} linked pull request(s) merged since our comment`);
  reasons.unshift(...lead);

  const foot = footer(input.model);
  const base = { kind: "reply_to_harness" as const, reasons, labels: [] as string[], followupVerdict: verdict };
  switch (verdict) {
    case "resolved":
      return {
        ...base,
        confidence: resolved ?? 0,
        headline: "Replied to our comment: says it is resolved",
        action: "close_completed",
        body: `Thanks for confirming. Closing as completed. ${REOPEN}${foot}`,
      };
    case "still_happens":
      return {
        ...base,
        confidence: still ?? 0,
        headline: "Replied to our comment: says it still happens",
        action: "comment",
        body: `Thanks for confirming this still happens on current firmware — keeping it open.${foot}`,
      };
    case "info_provided":
      return {
        ...base,
        confidence: info ?? 0,
        headline: "Replied to our comment with the details we asked for — read it",
        action: null,
        body: "",
      };
    default:
      return {
        ...base,
        confidence: 0.5,
        headline: "Replied to our comment — read the reply",
        action: null,
        body: "",
      };
  }
}

export interface RecommendInput {
  snapshot: IssueSnapshot;
  evidence: IssueEvidence;
  answers: Record<string, JevAnswer>;
  model: string;
  repoLabels: string[];
  /** Jev was unavailable: answers is empty and only the hard facts count. */
  jevError?: string;
}

export function recommend(input: RecommendInput): IssueRecommendation {
  const { snapshot, evidence, answers, model, repoLabels } = input;
  const T = ISSUE_THRESHOLDS;
  const reasons: string[] = [];

  const fixed = noul(answers, "fixed_by_linked_work");
  const resolved = noul(answers, "resolved_in_thread");
  const superseded = noul(answers, "superseded_by_code_changes");
  const awaiting = noul(answers, "awaiting_reporter");
  const actionable = noul(answers, "actionable");
  const automation = noul(answers, "automation_directed_text");
  const relevant = score(answers, "still_relevant");
  const type = choice(answers, "issue_type");

  // Facts first, for the reader, whatever the outcome.
  if (evidence.mergedClosingPrs > 0) reasons.push(`${evidence.mergedClosingPrs} merged pull request(s) say they close this issue`);
  else if (evidence.mergedLinkedPrs > 0) reasons.push(`${evidence.mergedLinkedPrs} merged pull request(s) mention this issue`);
  if (evidence.openLinkedPrs > 0) reasons.push(`${evidence.openLinkedPrs} open pull request(s) mention this issue`);
  if (evidence.codeRefsChecked > 0) {
    reasons.push(`${evidence.codeRefsMissing} of ${evidence.codeRefsChecked} file/identifier reference(s) no longer exist as named`);
  }
  if (evidence.daysSinceActivity >= T.staleDays) reasons.push(`no activity for ${ago(evidence.daysSinceActivity)}`);

  const make = (kind: IssueRecommendationKind, confidence: number, headline: string): IssueRecommendation => {
    let action = ACTION_FOR[kind];
    let labels: string[] = [];
    if (kind === "ask_still_relevant") {
      const lower = new Map(repoLabels.map((l) => [l.toLowerCase(), l]));
      const label = STALE_LABEL_CANDIDATES.map((c) => lower.get(c)).find((l): l is string => l !== undefined);
      if (label && !snapshot.labels.includes(label)) labels = [label];
    }
    if (kind === "keep_open" && snapshot.labels.length === 0) {
      const want = type === "feature_request" ? "enhancement" : type === "bug_report" ? "bug" : null;
      const match = want ? repoLabels.find((l) => l.toLowerCase() === want) : undefined;
      if (match) {
        labels = [match];
        action = "labels";
        reasons.push(`no labels yet; "${match}" fits the type Jev picked (${type})`);
      }
    }
    return {
      kind,
      confidence: Number(confidence.toFixed(3)),
      headline,
      reasons,
      action,
      body: draftBody(kind, snapshot, evidence, model),
      labels,
    };
  };

  if (automation !== null && automation >= T.automationBlock) {
    reasons.unshift(`text in the issue appears to address an automated system (${pct(automation)}); read it yourself`);
    return make("needs_human", automation, "The issue text addresses automation — no one-click action is offered");
  }

  // 0. A person answered us. Nothing below outranks that.
  const followup = followupRecommendation(input, reasons);
  if (followup) {
    if (input.jevError) reasons.unshift(`Jev was unavailable (${input.jevError}); read the reply yourself`);
    return followup;
  }

  if (input.jevError) reasons.unshift(`Jev was unavailable (${input.jevError}); only hard facts were used`);

  // 1. A merged PR that says it closes this, confirmed or not contradicted by Jev.
  if (evidence.mergedClosingPrs > 0 && (fixed === null || fixed >= 0.5)) {
    return make("close_fixed", fixed === null ? 0.8 : Math.max(0.8, fixed), "A merged pull request says it fixes this");
  }
  if (input.jevError) {
    return make("needs_human", 0, "Jev was unavailable; nothing but the hard facts to go on");
  }

  // 2. Jev reads a linked PR or the thread as having resolved it.
  if (fixed !== null && fixed >= T.yes) {
    reasons.unshift(`Jev: a merged pull request addresses this (${pct(fixed)})`);
    return make("close_fixed", fixed, "A merged pull request appears to address this");
  }
  if (resolved !== null && resolved >= T.yes) {
    reasons.unshift(`Jev: the thread says it was resolved or answered (${pct(resolved)})`);
    const answered = type === "question_or_support" || type === "hardware_or_setup";
    return make(answered ? "close_answered" : "close_fixed", resolved, answered ? "The question was answered in the thread" : "The thread says this was fixed");
  }

  // 3. A maintainer asked and the reporter went quiet.
  if (
    awaiting !== null &&
    awaiting >= T.yes &&
    (evidence.daysSinceMaintainerComment ?? 0) >= T.noResponseDays &&
    evidence.lastCommentBy === "maintainer"
  ) {
    reasons.unshift(`Jev: a maintainer asked the reporter something that was never answered (${pct(awaiting)})`);
    return make("close_no_response", awaiting, "Waiting on the reporter, who never replied");
  }

  // 4. The code moved on — only for an issue that is old and has gone quiet.
  const lowRelevance = relevant !== null && relevant.score <= T.irrelevantScore;
  const settled = evidence.ageDays >= T.obsoleteMinAgeDays && evidence.daysSinceActivity >= T.obsoleteQuietDays;
  const supersededYes = superseded !== null && superseded >= T.yes && (relevant === null || relevant.score < T.relevantScore);
  if ((supersededYes || lowRelevance) && !settled) {
    reasons.unshift(
      `Jev reads the code as having moved on${superseded !== null ? ` (${pct(superseded)})` : ""}, but the issue is ` +
        (evidence.daysSinceActivity < T.obsoleteQuietDays
          ? `still active (last activity ${evidence.daysSinceActivity} days ago)`
          : `only ${evidence.ageDays} days old`) +
        ` — a refactor is not a fix, so check it yourself`,
    );
    return make("needs_human", superseded ?? 0, "Code changed, but the issue is recent or active");
  }
  if (supersededYes && superseded !== null) {
    reasons.unshift(`Jev: the code this issue describes was removed or reworked (${pct(superseded)})`);
    return make("close_obsolete", superseded, "The code it describes has changed or gone");
  }
  if (lowRelevance && relevant && relevant.confidence >= 0.5) {
    reasons.unshift(`Jev: still relevant ${relevant.score.toFixed(1)} of 3 (confidence ${pct(relevant.confidence)})`);
    return make("close_obsolete", relevant.confidence, "Probably no longer applies to current firmware");
  }

  // 5. Still applies.
  if (relevant !== null && relevant.score >= T.relevantScore && (actionable === null || actionable >= 0.5)) {
    reasons.unshift(`Jev: still relevant ${relevant.score.toFixed(1)} of 3${actionable !== null ? `, actionable ${pct(actionable)}` : ""}`);
    return make("keep_open", relevant.confidence, "Concrete and still applies");
  }

  // 6. Old with nothing decisive: ask.
  if (evidence.daysSinceActivity >= T.staleDays) {
    if (relevant) reasons.unshift(`Jev: still relevant ${relevant.score.toFixed(1)} of 3 — not decisive either way`);
    return make("ask_still_relevant", 0.5, "Old and unclear — ask the reporter before closing");
  }

  if (relevant) reasons.unshift(`Jev: still relevant ${relevant.score.toFixed(1)} of 3 (confidence ${pct(relevant.confidence)})`);
  return make(
    relevant !== null && relevant.score >= 1.5 ? "keep_open" : "needs_human",
    relevant?.confidence ?? 0,
    relevant !== null && relevant.score >= 1.5 ? "Recent and plausibly still applies" : "No clear signal either way",
  );
}
