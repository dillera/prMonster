// Stats row (DESIGN.md 7.2): decision counts double as filters, plus spend.

import type { DecisionKind } from "../../shared/types";
import type { ScanProgress, StatsSummary } from "../lib/api";
import { decisionLabel, decisionSlug, formatNumber, formatUsd } from "../format";
import { Skeleton } from "./ui";

export type DecisionFilter = DecisionKind | "UNEVALUATED";

const ORDER: DecisionFilter[] = ["READY", "NEEDS_REVIEW", "BLOCKED", "UNEVALUATED"];

export function StatsRow({
  stats,
  filters,
  onToggle,
  progress,
}: {
  stats: StatsSummary | null;
  filters: Set<DecisionFilter>;
  onToggle: (filter: DecisionFilter) => void;
  progress: ScanProgress;
}) {
  if (!stats) {
    return (
      <section className="stats" aria-label="Triage counts">
        <Skeleton lines={2} className="skeleton--stats" />
      </section>
    );
  }

  return (
    <section className="stats" aria-label="Triage counts">
      <div className="stats__cards" role="group" aria-label="Filter by decision">
        {ORDER.map((kind) => {
          const on = filters.has(kind);
          const count = stats.counts[kind];
          return (
            <button
              key={kind}
              type="button"
              className={`statcard statcard--${decisionSlug(kind)}${on ? " statcard--on" : ""}`}
              aria-pressed={on}
              onClick={() => onToggle(kind)}
            >
              <span className="statcard__count mono">{count}</span>
              <span className="statcard__label">{decisionLabel(kind)}</span>
              <span className="statcard__bar" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <dl className="stats__usage">
        <div className="stats__usageitem">
          <dt>Tokens</dt>
          <dd className="mono">{formatNumber(stats.tokensUsed)}</dd>
        </div>
        <div className="stats__usageitem">
          <dt>Estimated cost</dt>
          <dd className="mono">{formatUsd(stats.estCostUsd)}</dd>
        </div>
        <div className="stats__usageitem">
          <dt>Scan</dt>
          <dd className="mono">
            {progress.running ? `${progress.done}/${progress.total} in flight` : "idle"}
          </dd>
        </div>
      </dl>

      {/* Single live region for scan progress: visible while a scan runs, and always
          announced to assistive technology. */}
      <div className={`scanstrip${progress.running ? " scanstrip--on" : ""}`} aria-live="polite">
        {progress.running ? (
          <>
            <div className="scanstrip__track" aria-hidden="true">
              <div
                className="scanstrip__fill"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 6}%` }}
              />
            </div>
            <p className="scanstrip__text mono">{progress.message}</p>
          </>
        ) : (
          <p className="visually-hidden">{progress.message}</p>
        )}
      </div>
    </section>
  );
}
