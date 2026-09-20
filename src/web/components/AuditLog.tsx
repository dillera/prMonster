// Audit log view (DESIGN.md 7.7): every action attempt, including refused ones.

import { useState } from "react";

import type { ActionKind, ActionRecord } from "../../shared/types";
import { relativeTime, shortSha } from "../format";
import { Markdown } from "./Markdown";
import { EmptyState, ErrorNote, Pill, Skeleton } from "./ui";

const KIND_LABEL: Record<ActionKind, string> = {
  comment: "Comment",
  review_request_changes: "Review: request changes",
  review_approve: "Review: approve",
  labels: "Labels",
};

const OUTCOME_TEXT: Record<ActionRecord["outcome"], string> = {
  posted: "posted to GitHub",
  refused_writes_disabled: "refused, writes disabled",
  refused_stale: "refused, evaluation stale",
  refused_bad_confirm: "refused, confirmation did not match",
  failed: "failed",
};

export function AuditLog({
  records,
  loading,
  error,
  onRefresh,
}: {
  records: ActionRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "posted" | "refused">("all");

  const shown = records.filter((r) => {
    if (filter === "all") return true;
    if (filter === "posted") return r.outcome === "posted";
    return r.outcome !== "posted";
  });

  return (
    <section className="audit" aria-label="Audit log">
      <header className="audit__head">
        <div>
          <h2 className="audit__title">Audit log</h2>
          <p className="audit__lede">
            Every attempt to write to GitHub, confirmed by a human, whether it was posted or refused. Nothing reaches
            GitHub without a row here.
          </p>
        </div>
        <div className="audit__tools">
          <div className="segmented" role="group" aria-label="Filter attempts">
            {(["all", "posted", "refused"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={`segmented__btn${filter === key ? " segmented__btn--on" : ""}`}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {key}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </header>

      {/* A failed refresh must not hide records already in hand: an action just
          confirmed is prepended locally, and losing it would make a refused write
          look like it never happened. */}
      {error && records.length > 0 ? <ErrorNote message={error} onRetry={onRefresh} /> : null}

      {loading && records.length === 0 ? (
        <Skeleton lines={5} />
      ) : error && records.length === 0 ? (
        <EmptyState title="Could not load the audit log" detail={error} />
      ) : shown.length === 0 ? (
        <EmptyState
          title={records.length === 0 ? "Nothing has been sent" : "No rows match this filter"}
          detail={
            records.length === 0
              ? "Draft actions live in each pull request's detail view. Confirmed sends land here, refusals included."
              : "Try the all filter."
          }
        />
      ) : (
        <ul className="auditlist">
          {shown.map((record) => (
            <AuditRow key={record.id} record={record} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AuditRow({ record }: { record: ActionRecord }) {
  const [open, setOpen] = useState(false);
  const refused = record.outcome !== "posted";

  return (
    <li className={`auditrow auditrow--${refused ? "refused" : "posted"}`}>
      <div className="auditrow__head">
        <a className="auditrow__pr mono" href={`#/pr/${record.prNumber}`}>
          #{record.prNumber}
        </a>
        <span className="auditrow__kind">{KIND_LABEL[record.kind]}</span>
        <Pill tone={refused ? (record.outcome === "failed" ? "bad" : "warn") : "good"}>
          {OUTCOME_TEXT[record.outcome]}
        </Pill>
        <span className="auditrow__by mono">by {record.confirmedBy}</span>
        <span className="auditrow__sha mono" title={record.headSha}>
          {shortSha(record.headSha)}
        </span>
        <span className="auditrow__when mono" title={new Date(record.requestedAt).toLocaleString()}>
          {relativeTime(record.requestedAt)}
        </span>
        <span className="auditrow__spacer" />
        {record.body || record.labels ? (
          <button type="button" className="btn btn--ghost btn--xs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "What was drafted"}
          </button>
        ) : null}
        {record.githubUrl ? (
          <a className="btn btn--ghost btn--xs" href={record.githubUrl} target="_blank" rel="noreferrer noopener">
            On GitHub
          </a>
        ) : null}
      </div>

      {record.error ? <p className="auditrow__error">{record.error}</p> : null}

      {open ? (
        <div className="auditrow__body">
          {record.labels && record.labels.length > 0 ? (
            <p className="auditrow__labels">
              {record.labels.map((label) => (
                <Pill key={label} tone="neutral">
                  <span className="mono">{label}</span>
                </Pill>
              ))}
            </p>
          ) : null}
          {record.body ? <Markdown source={record.body} /> : null}
          <p className="auditrow__meta mono">
            proposal {record.proposalId} · record {record.id}
          </p>
        </div>
      ) : null}
    </li>
  );
}
