// Action panel and the send confirmation (DESIGN.md 7.7 and the human-in-the-loop
// rules in the intro).
//
// Nothing here writes to GitHub on its own. The panel drafts, the human edits, and a
// send needs the confirmation modal: the exact HTTP call is shown, the word CONFIRM
// must be typed, and a name must be given. Every attempt, including refusals, comes
// back as an ActionRecord for the audit log.

import { useEffect, useRef, useState } from "react";

import type { ActionKind, ActionRecord, Proposal, PrSnapshot, TriageState } from "../../shared/types";
import type { ActionRequest, HealthInfo } from "../lib/api";
import { relativeTime, shortSha } from "../format";
import { Markdown } from "./Markdown";
import { CopyButton, ErrorNote, Pill, Skeleton, Spinner } from "./ui";

const KIND_LABEL: Record<ActionKind, string> = {
  comment: "Comment",
  review_request_changes: "Review: request changes",
  review_approve: "Review: approve",
  labels: "Labels",
};

/** The GitHub REST call a confirmed action would make (DESIGN.md 1, REST v3). */
function githubCall(kind: ActionKind, repo: string, n: number, body: string, labels: string[]): {
  method: string;
  path: string;
  payload: unknown;
} {
  switch (kind) {
    case "comment":
      return { method: "POST", path: `/repos/${repo}/issues/${n}/comments`, payload: { body } };
    case "review_request_changes":
      return { method: "POST", path: `/repos/${repo}/pulls/${n}/reviews`, payload: { event: "REQUEST_CHANGES", body } };
    case "review_approve":
      return { method: "POST", path: `/repos/${repo}/pulls/${n}/reviews`, payload: { event: "APPROVE", body } };
    case "labels":
      return { method: "POST", path: `/repos/${repo}/issues/${n}/labels`, payload: { labels } };
  }
}

export function ActionPanel({
  snapshot,
  proposal,
  proposalError,
  loading,
  triage,
  health,
  onTriage,
  onSend,
  lastRecord,
}: {
  snapshot: PrSnapshot;
  proposal: Proposal | null;
  proposalError: string | null;
  loading: boolean;
  triage: TriageState | null;
  health: HealthInfo | null;
  onTriage: (status: TriageState["status"], note?: string) => Promise<void>;
  onSend: (request: ActionRequest) => Promise<ActionRecord>;
  lastRecord: ActionRecord | null;
}) {
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [modalKind, setModalKind] = useState<ActionKind | null>(null);
  const [triageBusy, setTriageBusy] = useState(false);

  useEffect(() => {
    setBody(proposal?.body ?? "");
    setEdited(false);
  }, [proposal?.id, proposal?.body]);

  if (loading) {
    return (
      <section className="action" aria-label="Proposed action">
        <Skeleton lines={4} />
      </section>
    );
  }

  if (!proposal) {
    return (
      <section className="action" aria-label="Proposed action">
        <h3 className="action__title">Proposed action</h3>
        <p className="action__none">
          {proposalError ?? "No draft action yet. Evaluate this pull request and the harness will draft one."}
        </p>
      </section>
    );
  }

  const stale = proposal.headSha !== snapshot.headSha;
  const labels = proposal.labels ?? [];
  const labelsUnavailable = proposal.rationale.some(
    (r) => /label/i.test(r) && /(missing|does not exist|do not exist|unavailable)/i.test(r),
  );

  return (
    <section className="action" aria-label="Proposed action">
      <header className="action__head">
        <h3 className="action__title">Proposed action</h3>
        <Pill tone={proposal.kind === "review_approve" ? "warn" : "accent"}>{KIND_LABEL[proposal.kind]}</Pill>
        <span
          className="action__sha mono"
          title={`head ${proposal.headSha}\nevaluation ${proposal.evaluationId}\nproposal ${proposal.id}`}
          data-proposal-id={proposal.id}
        >
          applies to {shortSha(proposal.headSha)}
        </span>
        {stale ? (
          <Pill tone="bad" title={`The PR head is now ${shortSha(snapshot.headSha)}`}>
            stale draft
          </Pill>
        ) : null}
        <span className="action__spacer" />
        <span className="action__generated mono">drafted {relativeTime(proposal.generatedAt)}</span>
      </header>

      <p className="action__subtitle">{proposal.title}</p>

      {proposal.rationale.length > 0 ? (
        <details className="action__rationale">
          <summary>Built from {proposal.rationale.length} rationale points</summary>
          <ul>
            {proposal.rationale.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="action__bodyhead">
        <span className="action__bodylabel">Body</span>
        <div className="action__bodytools">
          {edited ? <Pill tone="warn">edited</Pill> : null}
          <button type="button" className="btn btn--ghost btn--xs" onClick={() => setShowSource((v) => !v)}>
            {showSource ? "Preview" : "Edit markdown"}
          </button>
          <CopyButton text={body} label="Copy body" />
          {edited ? (
            <button
              type="button"
              className="btn btn--ghost btn--xs"
              onClick={() => {
                setBody(proposal.body);
                setEdited(false);
              }}
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>

      {showSource ? (
        <textarea
          className="action__textarea mono"
          value={body}
          rows={14}
          spellCheck={false}
          onChange={(e) => {
            setBody(e.currentTarget.value);
            setEdited(true);
          }}
          aria-label="Action body, markdown"
        />
      ) : (
        <div className="action__preview">
          <Markdown source={body} />
        </div>
      )}

      {labels.length > 0 ? (
        <div className="action__labels">
          <span className="action__labelshead">Labels</span>
          {labels.map((label) => (
            <Pill key={label} tone="neutral">
              <span className="mono">{label}</span>
            </Pill>
          ))}
          {labelsUnavailable ? (
            <span className="action__labelnote">
              One or more labels do not exist on the repo. The harness never creates labels, so this action is
              disabled.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="action__buttons">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={triageBusy}
          onClick={() => {
            setTriageBusy(true);
            void onTriage("triaged").finally(() => setTriageBusy(false));
          }}
        >
          {triage?.status === "triaged" ? "Triaged locally" : "Mark triaged locally"}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={triageBusy}
          onClick={() => {
            setTriageBusy(true);
            void onTriage("snoozed").finally(() => setTriageBusy(false));
          }}
        >
          {triage?.status === "snoozed" ? "Snoozed" : "Snooze"}
        </button>
        {triage && triage.status !== "untriaged" ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={triageBusy}
            onClick={() => {
              setTriageBusy(true);
              void onTriage("untriaged").finally(() => setTriageBusy(false));
            }}
          >
            Clear local state
          </button>
        ) : null}
        <span className="action__spacer" />
        <button type="button" className="btn btn--danger" onClick={() => setModalKind(proposal.kind)}>
          Send to GitHub...
        </button>
        {labels.length > 0 ? (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={labelsUnavailable}
            onClick={() => setModalKind("labels")}
          >
            Send labels...
          </button>
        ) : null}
      </div>

      {triage?.note ? <p className="action__triagenote">Local note: {triage.note}</p> : null}
      {triageBusy ? <Spinner label="Saving local state" /> : null}

      {lastRecord ? <ActionOutcome record={lastRecord} /> : null}

      {modalKind ? (
        <ConfirmModal
          kind={modalKind}
          proposal={proposal}
          snapshot={snapshot}
          body={body}
          labels={labels}
          health={health}
          stale={stale}
          onClose={() => setModalKind(null)}
          onSend={onSend}
        />
      ) : null}
    </section>
  );
}

function ActionOutcome({ record }: { record: ActionRecord }) {
  const refused = record.outcome !== "posted";
  return (
    <div className={`outcome outcome--${refused ? "refused" : "posted"}`} role="status">
      <span className="outcome__kind mono">{record.outcome}</span>
      <span className="outcome__text">
        {record.outcome === "posted" ? (
          <>
            Posted as {KIND_LABEL[record.kind].toLowerCase()}.{" "}
            {record.githubUrl ? (
              <a href={record.githubUrl} target="_blank" rel="noreferrer noopener">
                Open on GitHub
              </a>
            ) : null}
          </>
        ) : (
          record.error ?? "Refused."
        )}
      </span>
      <a className="outcome__link" href="#/audit">
        Audit log
      </a>
    </div>
  );
}

function ConfirmModal({
  kind,
  proposal,
  snapshot,
  body,
  labels,
  health,
  stale,
  onClose,
  onSend,
}: {
  kind: ActionKind;
  proposal: Proposal;
  snapshot: PrSnapshot;
  body: string;
  labels: string[];
  health: HealthInfo | null;
  stale: boolean;
  onClose: () => void;
  onSend: (request: ActionRequest) => Promise<ActionRecord>;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          "button, input, textarea, a[href], select",
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const repo = health?.repo ?? "FujiNetWIFI/fujinet-firmware";
  const call = githubCall(kind, repo, snapshot.number, body, labels);
  const harnessBody: ActionRequest = {
    proposalId: proposal.id,
    kind,
    ...(kind === "labels" ? { labels } : { body }),
    confirmedBy: name || "<your name>",
    confirmText: confirmText || "<type CONFIRM>",
  };
  const ready = confirmText === "CONFIRM" && name.trim().length > 0 && !busy;
  const writesDisabled = health?.writesEnabled === false;
  const writesUnknown = health?.writesEnabled === undefined;

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        ref={dialogRef}
      >
        <h3 className="modal__title" id="confirm-title">
          Send to GitHub
        </h3>
        <p className="modal__lede">
          This is the only place the harness writes anything. Read the call, then confirm. Merging is never offered.
        </p>

        {kind === "review_approve" ? (
          <p className="modal__warn" role="alert">
            This posts an approving review in your name. An approval is a human judgement: only send it if you have
            read the diff yourself.
          </p>
        ) : null}

        {stale ? (
          <p className="modal__warn" role="alert">
            The draft was built for {shortSha(proposal.headSha)} but the pull request is now at{" "}
            {shortSha(snapshot.headSha)}. The server will refuse this as stale; re-evaluate first.
          </p>
        ) : null}

        <div className="modal__callout">
          <h4>Harness call</h4>
          <pre className="mono">
            <code>{`POST /api/prs/${snapshot.number}/actions\n${JSON.stringify(harnessBody, null, 2)}`}</code>
          </pre>
          <h4>Which becomes this GitHub call</h4>
          <pre className="mono">
            <code>{`${call.method} https://api.github.com${call.path}\n${JSON.stringify(call.payload, null, 2)}`}</code>
          </pre>
        </div>

        <p className={`modal__writes${writesDisabled ? " modal__writes--off" : ""}`}>
          {writesDisabled
            ? "ALLOW_GITHUB_WRITES is off. Sending will be refused by the server and recorded in the audit log as refused_writes_disabled, so the flow stays testable without touching GitHub."
            : writesUnknown
              ? "If ALLOW_GITHUB_WRITES is not set to 1 the server refuses the write and records it in the audit log instead. Either way the attempt is logged."
              : "ALLOW_GITHUB_WRITES is on. Confirming will really post to GitHub."}
        </p>

        <div className="modal__fields">
          <label className="field">
            <span className="field__label">Type CONFIRM to proceed</span>
            <input
              ref={firstFieldRef}
              className="input mono"
              value={confirmText}
              onChange={(e) => setConfirmText(e.currentTarget.value)}
              placeholder="CONFIRM"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field__label">Your name, recorded in the audit log and the comment footer</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. mozzwald"
              autoComplete="off"
            />
          </label>
        </div>

        {error ? <ErrorNote message={error} /> : null}

        <div className="modal__buttons">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={!ready}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onSend({
                proposalId: proposal.id,
                kind,
                ...(kind === "labels" ? { labels } : { body }),
                confirmedBy: name.trim(),
                confirmText,
              })
                .then(() => onClose())
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : "The send failed.");
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <Spinner label="Sending" /> : "Confirm and send"}
          </button>
        </div>
      </div>
    </div>
  );
}
