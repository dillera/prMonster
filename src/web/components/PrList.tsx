// PR list and card (DESIGN.md 7.3).

import { useState } from "react";

import type { DecisionKind, Policy, PrListItem } from "../../shared/types";
import type { ScanProgress, ScanStage } from "../lib/api";
import {
  ageDays,
  decisionSlug,
  degradations,
  fetchErrorOf,
  formatNumber,
  hints,
  isDegradationCode,
  isHintCode,
  relativeTime,
  stateOf,
  shortSha,
  sizeBucketOf,
} from "../format";
import type { DecisionFilter } from "./StatsRow";
import { CiDot, CompositeMeter, DecisionBadge, EmptyState, Pill, Skeleton } from "./ui";

export type SortKey = "decision" | "composite" | "age" | "number";

const STAGE_LABEL: Record<ScanStage, string> = {
  fetch: "fetching",
  gates: "gates",
  chunk: "chunking",
  jev: "asking Jev",
  decide: "deciding",
};

const STAGE_ORDER: ScanStage[] = ["fetch", "gates", "chunk", "jev", "decide"];

const DECISION_RANK: Record<DecisionFilter, number> = {
  BLOCKED: 0,
  NEEDS_REVIEW: 1,
  READY: 2,
  UNEVALUATED: 3,
};

export function kindOf(item: PrListItem): DecisionFilter {
  // A PR whose GitHub fetch failed carries no evaluation, so it filters, sorts and
  // counts as unevaluated rather than as a decision of its own.
  if (fetchErrorOf(item) !== null) return "UNEVALUATED";
  return item.evaluation ? item.evaluation.decision.kind : "UNEVALUATED";
}

export function sortItems(items: PrListItem[], sort: SortKey): PrListItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    switch (sort) {
      case "composite": {
        const ca = a.evaluation?.decision.composite ?? -1;
        const cb = b.evaluation?.decision.composite ?? -1;
        return cb - ca;
      }
      case "age":
        return new Date(a.snapshot.createdAt).getTime() - new Date(b.snapshot.createdAt).getTime();
      case "number":
        return b.snapshot.number - a.snapshot.number;
      case "decision":
      default: {
        const ra = DECISION_RANK[kindOf(a)];
        const rb = DECISION_RANK[kindOf(b)];
        if (ra !== rb) return ra - rb;
        return (a.evaluation?.decision.composite ?? 0) - (b.evaluation?.decision.composite ?? 0);
      }
    }
  });
  return copy;
}

export function PrList({
  items,
  loading,
  policy,
  selected,
  filters,
  onClearFilters,
  sort,
  onSortChange,
  query,
  onQueryChange,
  progress,
}: {
  items: PrListItem[];
  loading: boolean;
  policy: Policy;
  selected: number | null;
  filters: Set<DecisionFilter>;
  onClearFilters: () => void;
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
  query: string;
  onQueryChange: (value: string) => void;
  progress: ScanProgress;
}) {
  return (
    <section className="prlist" aria-label="Open pull requests">
      <div className="prlist__controls">
        <label className="search">
          <span className="visually-hidden">Filter by number, title, author, or platform</span>
          <input
            type="search"
            className="search__input mono"
            placeholder="filter: number, title, author, path"
            value={query}
            onChange={(e) => onQueryChange(e.currentTarget.value)}
          />
        </label>
        <label className="select">
          <span className="select__label">sort</span>
          <select
            className="select__input"
            value={sort}
            onChange={(e) => onSortChange(e.currentTarget.value as SortKey)}
          >
            <option value="decision">decision</option>
            <option value="composite">composite</option>
            <option value="age">age</option>
            <option value="number">number</option>
          </select>
        </label>
        {filters.size > 0 ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClearFilters}>
            Clear {filters.size} filter{filters.size === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="prlist__items">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="prcard prcard--skeleton">
              <Skeleton lines={3} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No pull requests match"
          detail={
            filters.size > 0 || query
              ? "Loosen the filters, or clear the search box."
              : "Run a scan to pull the open pull requests from GitHub."
          }
          action={
            filters.size > 0 ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={onClearFilters}>
                Clear filters
              </button>
            ) : null
          }
        />
      ) : (
        <ul className="prlist__items">
          {items.map((item) => (
            <li key={item.snapshot.number}>
              <PrCard
                item={item}
                policy={policy}
                selected={selected === item.snapshot.number}
                stage={progress.stages[item.snapshot.number]}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Pull requests that are closed or merged but still have evaluations, a dossier or a
 * deep run. Collapsed by default: this is history, not the queue.
 */
export function ClosedPrList({
  items,
  policy,
  selected,
}: {
  items: PrListItem[];
  policy: Policy;
  selected: number | null;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <section className="closedlist" aria-label="Recently closed with history">
      <button
        type="button"
        className="closedlist__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="closedlist__chev mono" aria-hidden="true">
          {open ? "-" : "+"}
        </span>
        <span className="closedlist__title">Recently closed with history</span>
        <span className="closedlist__count mono">{items.length}</span>
      </button>
      {open ? (
        <ul className="prlist__items closedlist__items">
          {items.map((item) => (
            <li key={item.snapshot.number}>
              <PrCard item={item} policy={policy} selected={selected === item.snapshot.number} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PrCard({
  item,
  policy,
  selected,
  stage,
}: {
  item: PrListItem;
  policy: Policy;
  selected: boolean;
  stage?: { stage: ScanStage; detail?: string };
}) {
  const { snapshot, evaluation, triage } = item;
  const kind: DecisionKind | "UNEVALUATED" = evaluation ? evaluation.decision.kind : "UNEVALUATED";
  const composite = evaluation?.decision.composite ?? 0;
  const size = evaluation ? sizeBucketOf(evaluation.gates) : null;
  const state = stateOf(snapshot);
  const notices = degradations(evaluation?.decision);
  const cardHints = hints(evaluation?.decision);
  const fetchError = fetchErrorOf(item);
  // Degraded states are the most important thing on the card, so they lead the
  // reason list whatever order the server sent.
  const allReasons = evaluation?.decision.reasons ?? [];
  // Degraded states lead, then ordinary findings; the hint codes are already shown
  // as pills, so they go last rather than crowding out a real finding.
  const ordered = [
    ...allReasons.filter((r) => isDegradationCode(r.code)),
    ...allReasons.filter((r) => !isDegradationCode(r.code) && !isHintCode(r.code)),
    ...allReasons.filter((r) => isHintCode(r.code)),
  ];
  const reasons = ordered.slice(0, 2);
  const fallback = evaluation?.decision.explanation.slice(0, 1) ?? [];

  return (
    <a
      className={`prcard prcard--${decisionSlug(kind)}${selected ? " prcard--selected" : ""}`}
      href={`#/pr/${snapshot.number}`}
      aria-current={selected ? "true" : undefined}
    >
      <div className="prcard__top">
        <span className="prcard__number mono">#{snapshot.number}</span>
        <DecisionBadge kind={kind} size="sm" />
        {state !== "open" ? (
          <Pill
            tone={state === "merged" ? "merged" : "neutral"}
            title={
              state === "merged"
                ? "Merged upstream. Kept here for its history; nothing can be written to it."
                : "Closed upstream. Kept here for its history; nothing can be written to it."
            }
          >
            {state}
          </Pill>
        ) : null}
        {stage ? (
          <span className="stagechip" title={stage.detail ?? STAGE_LABEL[stage.stage]}>
            <span className="stagechip__spin" aria-hidden="true" />
            <span className="stagechip__text mono">{STAGE_LABEL[stage.stage]}</span>
            {stage.detail ? <span className="stagechip__detail mono">{stage.detail}</span> : null}
            <span className="stagechip__steps" aria-hidden="true">
              {STAGE_ORDER.map((s) => (
                <span
                  key={s}
                  className={`stagechip__step${
                    STAGE_ORDER.indexOf(s) <= STAGE_ORDER.indexOf(stage.stage) ? " stagechip__step--on" : ""
                  }`}
                />
              ))}
            </span>
          </span>
        ) : null}
        {item.stale ? (
          <Pill tone="warn" title={`Evaluated against ${shortSha(evaluation?.headSha ?? "")}, head is now ${shortSha(snapshot.headSha)}`}>
            stale
          </Pill>
        ) : null}
        {fetchError ? (
          <Pill tone="neutral" title={fetchError}>
            fetch failed
          </Pill>
        ) : null}
        {notices.map((notice) => (
          <Pill key={notice.code} tone="warn" title={notice.detail}>
            {notice.pill}
          </Pill>
        ))}
        {cardHints.map((hint) => (
          <Pill key={hint.code} tone="neutral" title={hint.detail}>
            {hint.label}
          </Pill>
        ))}
        {triage && triage.status !== "untriaged" ? <Pill tone="accent">{triage.status}</Pill> : null}
      </div>

      <h3 className="prcard__title">{snapshot.title}</h3>

      <div className="prcard__meta">
        <span className="mono">{snapshot.author}</span>
        <span aria-hidden="true">·</span>
        <span className="mono" title={new Date(snapshot.createdAt).toLocaleString()}>
          {ageDays(snapshot.createdAt)}d old
        </span>
        <span aria-hidden="true">·</span>
        <span className="mono">
          {snapshot.changedFiles} files, +{formatNumber(snapshot.additions)}/-{formatNumber(snapshot.deletions)}
        </span>
        {size ? (
          <>
            <span aria-hidden="true">·</span>
            <Pill tone={size === "huge" || size === "large" ? "warn" : "neutral"}>{size}</Pill>
          </>
        ) : null}
        {snapshot.draft ? <Pill tone="warn">draft</Pill> : null}
        <CiDot ci={snapshot.ci} />
      </div>

      {evaluation ? (
        <div className="prcard__score">
          <CompositeMeter value={composite} policy={policy} kind={kind} size="sm" />
          <span className="prcard__composite mono">{composite.toFixed(1)}</span>
        </div>
      ) : (
        <p className="prcard__unevaluated">
          {fetchError
            ? `Not evaluated: ${fetchError}`
            : `Not evaluated yet. Updated ${relativeTime(snapshot.updatedAt)}.`}
        </p>
      )}

      {reasons.length > 0 ? (
        <ul className="prcard__reasons">
          {reasons.map((reason, i) => (
            <li
              key={i}
              className={`prcard__reason prcard__reason--${
                isDegradationCode(reason.code) ? "degraded" : reason.source
              }`}
            >
              {reason.text}
            </li>
          ))}
          {evaluation && evaluation.decision.reasons.length > 2 ? (
            <li className="prcard__reason prcard__reason--more">
              {evaluation.decision.reasons.length - 2} more
            </li>
          ) : null}
        </ul>
      ) : fallback.length > 0 ? (
        <ul className="prcard__reasons">
          {fallback.map((line, i) => (
            <li key={i} className="prcard__reason prcard__reason--ok">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </a>
  );
}
