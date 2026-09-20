// Header bar (DESIGN.md 7.1) and the mock-mode banner (7.6).

import type { HealthInfo, ScanProgress, StatsSummary } from "../lib/api";
import { FIXTURES_MODE } from "../lib/api";
import { formatUsd, relativeTime } from "../format";
import { Pill, Spinner } from "./ui";

export function Header({
  health,
  stats,
  progress,
  force,
  onForceChange,
  onScan,
  scanning,
  scanError,
  route,
}: {
  health: HealthInfo | null;
  stats: StatsSummary | null;
  progress: ScanProgress;
  force: boolean;
  onForceChange: (value: boolean) => void;
  onScan: () => void;
  scanning: boolean;
  scanError: string | null;
  route: string;
}) {
  const repo = health?.repo ?? "FujiNetWIFI/fujinet-firmware";
  const busy = scanning || progress.running;

  return (
    <header className="header">
      <div className="header__brand">
        <span className="header__mark" aria-hidden="true">
          FN
        </span>
        <div className="header__titles">
          <h1 className="header__title">PR Triage</h1>
          <a
            className="header__repo mono"
            href={`https://github.com/${repo}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {repo}
          </a>
        </div>
      </div>

      <nav className="header__nav" aria-label="Views">
        <a className={`navlink${route === "list" || route === "pr" ? " navlink--on" : ""}`} href="#/">
          Board
        </a>
        <a className={`navlink${route === "audit" ? " navlink--on" : ""}`} href="#/audit">
          Audit log
        </a>
        <a className={`navlink${route === "policy" ? " navlink--on" : ""}`} href="#/policy">
          Policy
        </a>
      </nav>

      <div className="header__pills">
        {health ? (
          <>
            <Pill tone={health.jev === "live" ? "good" : "warn"} title="Jev decision model status">
              <span className="mono">{health.jev === "live" ? `live ${health.model}` : `mock ${health.model}`}</span>
            </Pill>
            <Pill tone={health.githubAuth === "anon" ? "warn" : "neutral"} title="GitHub authentication">
              <span className="mono">github: {health.githubAuth}</span>
            </Pill>
          </>
        ) : (
          <Pill tone="neutral">
            <span className="mono">connecting</span>
          </Pill>
        )}
        {FIXTURES_MODE ? (
          <Pill tone="accent" title="Serving src/web/fixtures.ts, no server calls">
            <span className="mono">fixtures</span>
          </Pill>
        ) : null}
      </div>

      <div className="header__scan">
        <div className="header__meta">
          <span className="header__metaitem">
            last scan <span className="mono">{relativeTime(stats?.lastScanAt)}</span>
          </span>
          <span className="header__metaitem">
            spend <span className="mono">{formatUsd(stats?.estCostUsd ?? 0)}</span>
          </span>
        </div>
        <label className="toggle" title="Re-evaluate PRs even when the head sha has not moved">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => onForceChange(e.currentTarget.checked)}
            disabled={busy}
          />
          <span>force</span>
        </label>
        <button type="button" className="btn btn--primary" onClick={onScan} disabled={busy}>
          {busy ? <Spinner label="Scanning" /> : "Scan open PRs"}
        </button>
      </div>

      {scanError ? (
        <p className="header__error" role="alert">
          {scanError}
        </p>
      ) : null}
    </header>
  );
}

export function MockBanner({ health }: { health: HealthInfo }) {
  if (health.jev === "live" && !FIXTURES_MODE) return null;
  return (
    <div className="banner" role="note">
      <strong className="banner__title">
        {FIXTURES_MODE ? "Fixtures mode" : "Jev key missing, running in mock mode"}
      </strong>
      <p className="banner__text">
        {FIXTURES_MODE ? (
          <>
            The dashboard is serving sample data from <code className="mono">src/web/fixtures.ts</code>, including a
            replayed scan. Nothing here comes from GitHub or Jev. Start the harness with{" "}
            <code className="mono">npm run dev</code> to use the real API.
          </>
        ) : (
          <>
            Evaluations are deterministic fakes flagged <code className="mono">mock: true</code>. Put{" "}
            <code className="mono">TYPESAFE_API_KEY=...</code> in <code className="mono">.env</code> and restart the
            server for live answers.
          </>
        )}
      </p>
    </div>
  );
}
