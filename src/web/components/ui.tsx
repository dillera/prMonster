// Small presentational primitives shared across the dashboard.

import type { ReactNode } from "react";

import type { CiState, DecisionKind, Policy } from "../../shared/types";
import { ciLabel, clamp, decisionLabel, decisionSlug } from "../format";

// ---------------------------------------------------------------- badges
export function DecisionBadge({
  kind,
  size = "md",
}: {
  kind: DecisionKind | "UNEVALUATED";
  size?: "sm" | "md";
}) {
  return (
    <span className={`badge badge--${decisionSlug(kind)} badge--${size}`}>
      <span className="badge__dot" aria-hidden="true" />
      {decisionLabel(kind)}
    </span>
  );
}

export function Pill({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
  title?: string;
}) {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

export function CiDot({ ci }: { ci: CiState }) {
  return (
    <span className={`ci ci--${ci}`} title={ciLabel(ci)}>
      <span className="ci__dot" aria-hidden="true" />
      <span className="ci__label">{ciLabel(ci)}</span>
    </span>
  );
}

// ---------------------------------------------------------------- meters
/**
 * Composite meter, 0 to 100, with the two policy thresholds marked as ticks so
 * the score can be read against the route boundaries at a glance.
 */
export function CompositeMeter({
  value,
  policy,
  kind,
  size = "md",
  showTicks = true,
}: {
  value: number;
  policy: Pick<Policy, "readyThreshold" | "reviewThreshold">;
  kind: DecisionKind | "UNEVALUATED";
  size?: "sm" | "md" | "lg";
  showTicks?: boolean;
}) {
  const pct = clamp(value);
  return (
    <div
      className={`meter meter--${size} meter--${decisionSlug(kind)}`}
      role="meter"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Composite score ${value.toFixed(1)} of 100`}
    >
      <div className="meter__track">
        <div className="meter__fill" style={{ width: `${pct}%` }} />
        {showTicks ? (
          <>
            <span
              className="meter__tick meter__tick--review"
              style={{ left: `${clamp(policy.reviewThreshold)}%` }}
              title={`Review threshold ${policy.reviewThreshold}`}
            />
            <span
              className="meter__tick meter__tick--ready"
              style={{ left: `${clamp(policy.readyThreshold)}%` }}
              title={`Ready threshold ${policy.readyThreshold}`}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- states
export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton__line" style={{ width: `${92 - i * 11}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__glyph" aria-hidden="true">
        &#9633;
      </div>
      <p className="empty__title">{title}</p>
      {detail ? <p className="empty__detail">{detail}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="errornote" role="alert">
      <p className="errornote__text">{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner__ring" aria-hidden="true" />
      {label ? <span className="spinner__label">{label}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------- misc
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      onClick={(e) => {
        const button = e.currentTarget;
        const restore = button.textContent ?? label;
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            button.textContent = "Copied";
          })
          .catch(() => {
            button.textContent = "Copy failed";
          })
          .finally(() => {
            window.setTimeout(() => {
              button.textContent = restore;
            }, 1400);
          });
      }}
    >
      {label}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="sectiontitle">
      <h3 className="sectiontitle__text">{children}</h3>
      {aside ? <div className="sectiontitle__aside">{aside}</div> : null}
    </div>
  );
}
