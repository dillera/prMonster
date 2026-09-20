// Brief section of the Deep analysis tab (DESIGN-deep.md, UI 3).
//
// This is the only model written thing in the product, so it says so permanently,
// names the model, shows what it cost, and every claim carries citations the reader
// can open. The draft reply can only leave here through the existing human confirmed
// action panel.

import { useEffect, useState } from "react";

import type { ClaimVerdict, DeepAction, DeepBrief, DeepRun, RemovedBehaviour } from "../../../shared/types";
import { formatNumber, formatUsdPrecise, partialBriefOf, relativeTime, validationErrorsOf } from "../../format";
import { prUrl } from "../../github";
import { Markdown } from "../Markdown";
import { CopyButton, EmptyState, Pill } from "../ui";
import { CitationList } from "./Citations";

const ACTION_LABELS: Record<DeepAction, string> = {
  merge_review_now: "Review for merge now",
  request_design_discussion: "Ask for a design discussion",
  request_description_or_tests: "Ask for a description or tests",
  request_split: "Ask for the change to be split",
  request_rebase: "Ask for a rebase",
  request_follow_up_issue: "Ask for a follow up issue",
  ask_original_author: "Ask the original author",
  wait_for_ci: "Wait for CI",
  close_stale: "Close as stale",
};

type PillTone = "neutral" | "good" | "warn" | "bad" | "accent";

const ACTION_TONE: Record<DeepAction, PillTone> = {
  merge_review_now: "good",
  request_design_discussion: "warn",
  request_description_or_tests: "warn",
  request_split: "warn",
  request_rebase: "warn",
  request_follow_up_issue: "accent",
  ask_original_author: "accent",
  wait_for_ci: "neutral",
  close_stale: "bad",
};

const VERDICT_LABELS: Record<ClaimVerdict["verdict"], string> = {
  holds: "holds",
  does_not_hold: "does not hold",
  partially_holds: "partially holds",
  unverified: "unverified",
};

const STATUS_LABELS: Record<RemovedBehaviour["status"], string> = {
  replaced: "replaced",
  made_opt_in: "made opt in",
  removed_without_replacement: "removed without replacement",
  unclear: "unclear",
};

export function BriefView({
  run,
  repo,
  baseSha,
  onUseAsProposal,
  usingProposal,
  usedRunId,
}: {
  run: DeepRun | null;
  repo: string;
  /** Revision used for code citations that omit their own sha. */
  baseSha: string | undefined;
  onUseAsProposal: (runId: string, reply: string) => void;
  usingProposal: boolean;
  usedRunId: string | null;
}) {
  // A failed run may still carry the model's last attempt. It is shown, clearly
  // marked, because 38 good tool steps are worth reading even when the final
  // envelope did not validate.
  const partial = partialBriefOf(run);
  const validationErrors = validationErrorsOf(run);
  const brief = run?.brief ?? partial;
  const isPartial = run?.brief == null && partial !== null;

  const [reply, setReply] = useState(brief?.draftReply ?? "");
  const [edited, setEdited] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    setReply(brief?.draftReply ?? "");
    setEdited(false);
  }, [run?.id, brief?.draftReply]);

  if (!run) {
    return (
      <section className="brief" aria-label="Brief">
        <EmptyState
          title="No deep analysis yet"
          detail="Run one above to get a brief: what the latest revision changed, whose behaviour it removed, whether the author's claims survive checking, and what to say next."
        />
      </section>
    );
  }

  if (!brief) {
    if (run.status === "running") {
      return (
        <section className="brief" aria-label="Brief">
          <EmptyState
            title="The brief is still being written"
            detail="Steps appear above as the model works. The brief lands here when it calls submit_brief."
          />
        </section>
      );
    }
    return (
      <section className="brief" aria-label="Brief">
        <div className={`brieffail brieffail--${run.status}`} role="alert">
          <div className="brieffail__head">
            <Pill tone={run.status === "failed" ? "bad" : "warn"}>{run.status}</Pill>
            <span className="brieffail__title">
              {run.status === "failed"
                ? "This run did not produce a brief"
                : "This run was stopped before it produced a brief"}
            </span>
          </div>
          <p className="brieffail__error">{run.error ?? "The run ended before it submitted a brief."}</p>
          {validationErrors.length > 0 ? (
            <ul className="brieffail__errors">
              {validationErrors.map((e, i) => (
                <li key={i} className="mono">
                  {e}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="brieffail__spend mono">
            {run.steps.length} step{run.steps.length === 1 ? "" : "s"} ran and{" "}
            {formatUsdPrecise(run.usage.costUsd)} was spent on {run.usage.calls} call
            {run.usage.calls === 1 ? "" : "s"} and{" "}
            {formatNumber(run.usage.promptTokens + run.usage.completionTokens)} tokens. The step log above shows what
            the model read.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="brief" aria-label="Brief">
      <header className="brief__head">
        <Pill tone={ACTION_TONE[brief.recommendedAction]}>{ACTION_LABELS[brief.recommendedAction]}</Pill>
        <span className={`brief__confidence brief__confidence--${brief.confidence}`}>
          {brief.confidence} confidence
        </span>
        {isPartial ? <Pill tone="bad">unvalidated</Pill> : null}
        <span className="brief__spacer" />
        <span className="brief__meta mono">
          {relativeTime(run.startedAt)} · {run.requestedBy} · {formatUsdPrecise(run.usage.costUsd)} ·{" "}
          {formatNumber(run.usage.promptTokens + run.usage.completionTokens)} tokens
        </span>
      </header>

      {isPartial ? (
        <div className="brieffail brieffail--partial" role="alert">
          <div className="brieffail__head">
            <Pill tone="bad">failed validation</Pill>
            <span className="brieffail__title">
              This run failed validation; showing the model's last attempt.
            </span>
          </div>
          {validationErrors.length > 0 ? (
            <>
              <p className="brieffail__error">Errors:</p>
              <ul className="brieffail__errors">
                {validationErrors.map((e, i) => (
                  <li key={i} className="mono">
                    {e}
                  </li>
                ))}
              </ul>
            </>
          ) : run.error ? (
            <p className="brieffail__error">Errors: {run.error}</p>
          ) : null}
          <p className="brieffail__spend mono">
            {run.steps.length} steps ran and {formatUsdPrecise(run.usage.costUsd)} was spent. Read the fields below
            with more suspicion than usual: nothing checked that they are complete.
          </p>
        </div>
      ) : null}

      <p className="brief__label" role="note">
        Generated by <code className="mono">{run.model}</code>
        {run.mock ? " in mock mode" : ""} from the dossier above. Check the citations; the model can be wrong.
      </p>

      <p className="brief__summary">{brief.summary}</p>

      {brief.revisionChanges.length > 0 ? (
        <div className="bsect">
          <h4 className="bsect__title">What the latest revision changed</h4>
          <ul className="bsect__bullets">
            {brief.revisionChanges.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief.removedBehaviour.length > 0 ? (
        <div className="bsect">
          <h4 className="bsect__title">Removed behaviour</h4>
          <ul className="removed">
            {brief.removedBehaviour.map((item, i) => (
              <li key={i} className={`removed__card removed__card--${item.status}`}>
                <div className="removed__head">
                  <code className="removed__lines mono">{item.lines}</code>
                  {item.originPr !== null ? (
                    <a
                      className="removed__pr mono"
                      href={prUrl(repo, item.originPr)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      #{item.originPr}
                    </a>
                  ) : (
                    <span className="removed__pr mono">origin unknown</span>
                  )}
                  <span className="removed__spacer" />
                  <Pill tone={item.status === "removed_without_replacement" ? "bad" : item.status === "unclear" ? "warn" : "neutral"}>
                    {STATUS_LABELS[item.status]}
                  </Pill>
                </div>
                <p className="removed__purpose">{item.purpose}</p>
                <CitationList citations={item.citations} repo={repo} fallbackSha={baseSha} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief.claims.length > 0 ? (
        <div className="bsect">
          <h4 className="bsect__title">
            Claims
            <span className="bsect__sub mono">what the thread asserts, checked against the code</span>
          </h4>
          <ul className="claims">
            {brief.claims.map((claim, i) => (
              <li key={i} className={`claims__row claims__row--${claim.verdict}`}>
                <div className="claims__head">
                  <Pill
                    tone={
                      claim.verdict === "holds"
                        ? "good"
                        : claim.verdict === "does_not_hold"
                          ? "bad"
                          : claim.verdict === "partially_holds"
                            ? "warn"
                            : "neutral"
                    }
                  >
                    {VERDICT_LABELS[claim.verdict]}
                  </Pill>
                  <span className="claims__by mono">{claim.by}</span>
                </div>
                <blockquote className="claims__claim">{claim.claim}</blockquote>
                <p className="claims__evidence">{claim.evidence}</p>
                <CitationList citations={claim.citations} repo={repo} fallbackSha={baseSha} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief.openQuestions.length > 0 ? (
        <div className="bsect">
          <h4 className="bsect__title">Open questions</h4>
          <ul className="questionsgroup">
            {groupQuestions(brief).map((group) => (
              <li key={group.toWhom} className="questionsgroup__row">
                <span className="questionsgroup__who mono">{group.toWhom}</span>
                <ul className="questionsgroup__list">
                  {group.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief.rationale.length > 0 ? (
        <div className="bsect">
          <h4 className="bsect__title">Why</h4>
          <ul className="bsect__bullets">
            {brief.rationale.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief.caveats.length > 0 ? (
        <div className="bsect bsect--caveats">
          <h4 className="bsect__title">Caveats</h4>
          <ul className="bsect__bullets">
            {brief.caveats.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="bsect">
        <div className="brief__replyhead">
          <h4 className="bsect__title">Draft reply</h4>
          {edited ? <Pill tone="warn">edited</Pill> : null}
          {usedRunId === run.id ? <Pill tone="accent">loaded into the action panel</Pill> : null}
          <span className="brief__spacer" />
          <button type="button" className="btn btn--ghost btn--xs" onClick={() => setShowSource((v) => !v)}>
            {showSource ? "Preview" : "Edit markdown"}
          </button>
          <CopyButton text={reply} label="Copy reply" />
          {edited ? (
            <button
              type="button"
              className="btn btn--ghost btn--xs"
              onClick={() => {
                setReply(brief.draftReply);
                setEdited(false);
              }}
            >
              Reset
            </button>
          ) : null}
        </div>

        {showSource ? (
          <textarea
            className="action__textarea mono"
            value={reply}
            rows={14}
            spellCheck={false}
            aria-label="Draft reply, markdown"
            onChange={(e) => {
              setReply(e.currentTarget.value);
              setEdited(true);
            }}
          />
        ) : (
          <div className="action__preview">
            <Markdown source={reply} />
          </div>
        )}

        <div className="brief__replyactions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={usingProposal || run.status === "running"}
            onClick={() => onUseAsProposal(run.id, reply)}
          >
            {usingProposal ? "Loading into the action panel" : "Use as proposal"}
          </button>
          <span className="brief__replynote">
            This only fills the action panel below. Posting still needs the confirmation modal, your name, and
            ALLOW_GITHUB_WRITES.
            {isPartial ? " This reply comes from a run that failed validation, so read it line by line first." : ""}
          </span>
        </div>
      </div>
    </section>
  );
}

function groupQuestions(brief: DeepBrief): Array<{ toWhom: string; questions: string[] }> {
  const map = new Map<string, string[]>();
  for (const q of brief.openQuestions) {
    const list = map.get(q.toWhom) ?? [];
    list.push(q.question);
    map.set(q.toWhom, list);
  }
  return [...map.entries()].map(([toWhom, questions]) => ({ toWhom, questions }));
}
