// Detail panel (DESIGN.md 7.4): tabs over one pull request, with the action panel
// underneath.

import { useEffect, useRef, useState } from "react";

import type { ActionRecord, Decision, Policy, PrListItem, Proposal, TriageState } from "../../shared/types";
import type { ActionRequest, HealthInfo } from "../lib/api";
import {
  ageDays,
  fetchErrorOf,
  formatBytes,
  formatNumber,
  formatUsd,
  relativeTime,
  shortSha,
  stateOf,
} from "../format";
import { ActionPanel } from "./ActionPanel";
import { DecisionTrace } from "./DecisionTrace";
import { DeepPanel } from "./DeepPanel";
import { FilesPanel } from "./FilesPanel";
import { GatePanel } from "./GatePanel";
import { Markdown } from "./Markdown";
import { QuestionsTab } from "./QuestionBars";
import { CiDot, CopyButton, DecisionBadge, EmptyState, Pill, Skeleton } from "./ui";

const TABS = ["trace", "questions", "gates", "files", "deep", "raw"] as const;
export type TabId = (typeof TABS)[number];

const TAB_LABEL: Record<TabId, string> = {
  trace: "Decision trace",
  questions: "Questions",
  gates: "Gates",
  files: "Files",
  deep: "Deep analysis",
  raw: "Raw",
};

export function DetailPanel({
  item,
  loading,
  policy,
  previewDecision,
  health,
  proposal,
  proposalLoading,
  proposalError,
  lastRecord,
  onReevaluate,
  onTriage,
  onSend,
  scanning,
  repo,
  onUseAsProposal,
  usingDeepProposal,
  deepProposalRunId,
}: {
  item: PrListItem | null;
  loading: boolean;
  policy: Policy;
  /** Set while the policy drawer is previewing an unsaved policy. */
  previewDecision: Decision | null;
  health: HealthInfo | null;
  proposal: Proposal | null;
  proposalLoading: boolean;
  proposalError: string | null;
  lastRecord: ActionRecord | null;
  onReevaluate: (n: number) => void;
  onTriage: (n: number, status: TriageState["status"], note?: string) => Promise<void>;
  onSend: (n: number, request: ActionRequest) => Promise<ActionRecord>;
  scanning: boolean;
  repo: string;
  /** Load a deep run's draft reply into the action panel below. */
  onUseAsProposal: (n: number, runId: string) => void;
  usingDeepProposal: boolean;
  /** The deep run whose reply is currently in the action panel, if any. */
  deepProposalRunId: string | null;
}) {
  const [tab, setTab] = useState<TabId>("trace");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setTab("trace");
  }, [item?.snapshot.number]);

  if (loading) {
    return (
      <section className="detail" aria-label="Pull request detail">
        <Skeleton lines={5} />
      </section>
    );
  }

  if (!item) {
    return (
      <section className="detail detail--empty" aria-label="Pull request detail">
        <EmptyState
          title="Nothing selected"
          detail="Pick a pull request on the left to see its gates, its Jev answers, and exactly how the route was reached."
        />
      </section>
    );
  }

  const { snapshot, evaluation, triage } = item;
  const decision = previewDecision ?? evaluation?.decision ?? null;
  const fetchError = fetchErrorOf(item);
  const state = stateOf(snapshot);
  const closed = state !== "open";

  return (
    <section className="detail" aria-label={`Pull request ${snapshot.number}`}>
      <header className="detail__head">
        <a className="detail__back" href="#/">
          Back to the board
        </a>
        <div className="detail__titlerow">
          <span className="detail__number mono">#{snapshot.number}</span>
          <h2 className="detail__title">{snapshot.title}</h2>
        </div>

        <div className="detail__meta">
          <span className="mono">{snapshot.author}</span>
          <Pill tone="neutral">{snapshot.authorAssociation.toLowerCase().replace(/_/g, " ")}</Pill>
          <span className="mono" title={new Date(snapshot.createdAt).toLocaleString()}>
            opened {ageDays(snapshot.createdAt)}d ago
          </span>
          <span className="mono">updated {relativeTime(snapshot.updatedAt)}</span>
          <span className="mono" title={snapshot.headSha}>
            {snapshot.headRef}@{shortSha(snapshot.headSha)}
          </span>
          {closed ? (
            <Pill
              tone={state === "merged" ? "merged" : "neutral"}
              title={`This pull request is ${state} upstream. Its history stays here; the harness cannot write to it.`}
            >
              {state}
            </Pill>
          ) : null}
          <CiDot ci={snapshot.ci} />
          {snapshot.draft ? <Pill tone="warn">draft</Pill> : null}
          {snapshot.mergeable === false ? <Pill tone="bad">conflicts</Pill> : null}
          {snapshot.labels.map((label) => (
            <Pill key={label} tone="neutral">
              {label}
            </Pill>
          ))}
        </div>

        <div className="detail__statline">
          <span className="mono">
            {snapshot.changedFiles} files, +{formatNumber(snapshot.additions)}/-{formatNumber(snapshot.deletions)},{" "}
            {formatBytes(snapshot.diffBytes)} diff
          </span>
          <span className="mono">
            {snapshot.reviewCount} reviews, {snapshot.commentCount} comments
          </span>
          {evaluation ? (
            <span className="mono">
              {formatNumber(evaluation.usage.input_tokens)} tokens, {formatUsd(evaluation.usage.estCostUsd)},{" "}
              {evaluation.usage.calls} calls, {(evaluation.durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}
          {fetchError ? <Pill tone="neutral" title={fetchError}>fetch failed</Pill> : null}
          {evaluation?.mock ? <Pill tone="warn">mock answers</Pill> : null}
          {item.stale ? <Pill tone="warn">head moved since evaluation</Pill> : null}
          {triage && triage.status !== "untriaged" ? <Pill tone="accent">{triage.status}</Pill> : null}
        </div>

        <div className="detail__actions">
          {decision ? <DecisionBadge kind={decision.kind} /> : <DecisionBadge kind="UNEVALUATED" />}
          <span className="detail__spacer" />
          {closed ? (
            <span className="detail__closednote">
              {state} upstream, so it is read only here. The dossier and any deep analysis stay available.
            </span>
          ) : (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onReevaluate(snapshot.number)}
              disabled={scanning}
            >
              Re-evaluate
            </button>
          )}
          <a className="btn btn--ghost" href={snapshot.url} target="_blank" rel="noreferrer noopener">
            Open on GitHub
          </a>
        </div>

        {snapshot.body ? (
          <details className="detail__body">
            <summary>Description as the author wrote it</summary>
            <div className="detail__bodytext">
              <Markdown source={snapshot.body} />
            </div>
            <p className="detail__bodynote">
              Untrusted text. It is sent to Jev only as state, never as instructions, and a question asks whether it
              tries to direct a reviewer.
            </p>
          </details>
        ) : null}
      </header>

      <>
          <div className="tabs" role="tablist" aria-label="Evaluation views">
            {TABS.map((id, index) => (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className={`tabs__tab${tab === id ? " tabs__tab--on" : ""}`}
                onClick={() => setTab(id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  e.preventDefault();
                  const dir = e.key === "ArrowRight" ? 1 : -1;
                  const next = (index + dir + TABS.length) % TABS.length;
                  const nextId = TABS[next];
                  if (nextId) {
                    setTab(nextId);
                    tabRefs.current[next]?.focus();
                  }
                }}
              >
                {TAB_LABEL[id]}
              </button>
            ))}
          </div>

          <div className="tabs__panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
            {/* The deep analysis tab and the file list work without an evaluation;
                the scoring tabs need one. */}
            {tab === "deep" ? (
              <DeepPanel
                snapshot={snapshot}
                repo={repo}
                onUseAsProposal={(runId) => onUseAsProposal(snapshot.number, runId)}
                usingProposal={usingDeepProposal}
                usedRunId={deepProposalRunId}
              />
            ) : tab === "files" ? (
              <FilesPanel snapshot={snapshot} evaluation={evaluation} />
            ) : !evaluation ? (
              <EmptyState
                title={fetchError ? "Could not be fetched from GitHub" : "Not evaluated yet"}
                detail={
                  fetchError
                    ? `${fetchError} Nothing here has been judged, and the snapshot may be older than the pull request.`
                    : "No gates have run and no questions have been asked for this head sha. The dossier under Deep analysis does not need one."
                }
                action={
                  closed ? null : (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => onReevaluate(snapshot.number)}
                      disabled={scanning}
                    >
                      Evaluate this pull request
                    </button>
                  )
                }
              />
            ) : (
              <>
                {tab === "trace" && decision ? (
                  <DecisionTrace
                    evaluation={evaluation}
                    policy={policy}
                    decision={decision}
                    preview={previewDecision !== null}
                  />
                ) : null}
                {tab === "questions" ? <QuestionsTab evaluation={evaluation} /> : null}
                {tab === "gates" ? <GatePanel evaluation={evaluation} /> : null}
                {tab === "raw" ? <RawPanel evaluation={evaluation} /> : null}
              </>
            )}
          </div>
        </>

      <ActionPanel
        snapshot={snapshot}
        proposal={proposal}
        proposalError={proposalError}
        loading={proposalLoading}
        triage={triage}
        health={health}
        onTriage={(status, note) => onTriage(snapshot.number, status, note)}
        onSend={(request) => onSend(snapshot.number, request)}
        lastRecord={lastRecord}
        fromDeepRunId={deepProposalRunId}
        readOnly={closed}
        readOnlyReason={`This pull request is ${state} upstream, so the harness will not post to it.`}
      />
    </section>
  );
}

function RawPanel({ evaluation }: { evaluation: PrListItem["evaluation"] }) {
  if (!evaluation) return null;
  const json = JSON.stringify(evaluation, null, 2);
  return (
    <div className="raw">
      <div className="raw__head">
        <span className="raw__label mono">
          Evaluation {evaluation.id}, {formatNumber(json.length)} chars
        </span>
        <CopyButton text={json} label="Copy JSON" />
      </div>
      <pre className="raw__json mono">
        <code>{json}</code>
      </pre>
    </div>
  );
}
