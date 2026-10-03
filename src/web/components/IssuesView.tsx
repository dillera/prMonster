// Open-issue triage board: #/issues and #/issue/N.
//
// The left column is the backlog sorted so the likely closes come first; the
// right column is one issue with its evidence, the recommendation, a drafted
// comment, and one button per action. A button is the whole confirmation: it
// posts under the name in "Acting as", and the server still refuses anything
// that is stale, already closed, or made while ALLOW_GITHUB_WRITES is off.

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ActionRecord,
  IssueActionKind,
  IssueEvaluation,
  IssueListItem,
  IssueRecommendationKind,
  JevAnswer,
} from "../../shared/types";
import type { HarnessEvent, HealthInfo, IssueBoard } from "../lib/api";
import { ApiError, listIssues, postIssueAction, setIssueTriage, startIssueScan, subscribeEvents } from "../lib/api";
import { formatUsd, percent, relativeTime } from "../format";
import { Markdown } from "./Markdown";
import { EmptyState, ErrorNote, Pill, Skeleton, Spinner } from "./ui";
import { readStored } from "./deep/RunPanel";

const ACTOR_KEY = "prmonster.actor";
const ADVANCE_KEY = "prmonster.issues.advance";

type RecFilter = IssueRecommendationKind | "unanalysed";

const REC_ORDER: RecFilter[] = [
  "close_fixed",
  "close_obsolete",
  "close_no_response",
  "close_answered",
  "ask_still_relevant",
  "needs_human",
  "keep_open",
  "unanalysed",
];

const REC_LABEL: Record<RecFilter, string> = {
  close_fixed: "Close: fixed",
  close_obsolete: "Close: obsolete",
  close_no_response: "Close: no response",
  close_answered: "Close: answered",
  ask_still_relevant: "Ask if still relevant",
  needs_human: "Needs a human",
  keep_open: "Keep open",
  unanalysed: "Not analysed",
};

const REC_TONE: Record<RecFilter, "neutral" | "good" | "warn" | "bad" | "accent" | "merged"> = {
  close_fixed: "good",
  close_obsolete: "bad",
  close_no_response: "warn",
  close_answered: "good",
  ask_still_relevant: "accent",
  needs_human: "neutral",
  keep_open: "merged",
  unanalysed: "neutral",
};

const ACTION_LABEL: Record<IssueActionKind, string> = {
  close_completed: "Close as completed",
  close_not_planned: "Close as not planned",
  comment: "Post comment",
  labels: "Add labels",
};

const STAGE_LABEL: Record<string, string> = {
  fetch: "fetching",
  evidence: "checking code",
  jev: "asking Jev",
  decide: "deciding",
};

function recOf(item: IssueListItem): RecFilter {
  return item.evaluation?.recommendation.kind ?? "unanalysed";
}

/** Handled = something was posted, or a person marked it kept or snoozed. */
function handledOf(item: IssueListItem): string | null {
  if (item.lastAction?.outcome === "posted") return `${ACTION_LABEL[item.lastAction.kind as IssueActionKind] ?? item.lastAction.kind} by ${item.lastAction.confirmedBy}`;
  if (item.triage?.status === "kept") return `kept open${item.triage.by ? ` by ${item.triage.by}` : ""}`;
  if (item.triage?.status === "snoozed") return "snoozed";
  return null;
}

function years(iso: string): string {
  return relativeTime(iso).replace(/(\d+)mo ago/, (_, m: string) => {
    const mo = Number(m);
    return mo >= 24 ? `${Math.round(mo / 12)}y ago` : `${mo}mo ago`;
  });
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the value lasts for this page only */
  }
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return fallback;
}

// ---------------------------------------------------------------- view
export function IssuesView({ selected, health }: { selected: number | null; health: HealthInfo | null }) {
  const [board, setBoard] = useState<IssueBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [stages, setStages] = useState<Record<number, { stage: string; detail?: string }>>({});
  const [filters, setFilters] = useState<Set<RecFilter>>(new Set());
  const [hideHandled, setHideHandled] = useState(true);
  const [query, setQuery] = useState("");
  const [actor, setActor] = useState(() => readStored(ACTOR_KEY) ?? readStored("prmonster.deep.requestedBy") ?? "");
  const [advance, setAdvance] = useState(() => readStored(ADVANCE_KEY) !== "0");

  const refresh = useCallback(async (): Promise<void> => {
    const next = await listIssues();
    setBoard(next);
    setRunning(next.running !== null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listIssues()
      .then((b) => {
        if (cancelled) return;
        setBoard(b);
        setRunning(b.running !== null);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, "Could not load open issues."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live progress. The PR board has its own subscription; issue events are
  // ignored there, so this one only listens for its own.
  useEffect(() => {
    const onEvent = (event: HarnessEvent): void => {
      switch (event.type) {
        case "issues:start":
          setRunning(true);
          setProgress({ done: 0, total: event.total });
          setStages({});
          break;
        case "issue:stage":
          setStages((prev) => ({ ...prev, [event.n]: { stage: event.stage, ...(event.detail ? { detail: event.detail } : {}) } }));
          break;
        case "issue:done":
        case "issue:error": {
          setStages((prev) => {
            const next = { ...prev };
            delete next[event.n];
            return next;
          });
          setProgress((p) => ({ ...p, done: p.done + 1 }));
          if (event.type === "issue:done") {
            const evaluation: IssueEvaluation = event.evaluation;
            setBoard((prev) =>
              prev
                ? {
                    ...prev,
                    items: prev.items.map((i) =>
                      i.snapshot.number === event.n ? { ...i, evaluation, stale: false } : i,
                    ),
                  }
                : prev,
            );
          }
          break;
        }
        case "issues:done":
          setRunning(false);
          setStages({});
          void refresh().catch(() => undefined);
          break;
        default:
          break;
      }
    };
    return subscribeEvents(onEvent);
  }, [refresh]);

  const items = board?.items ?? [];

  const counts = useMemo(() => {
    const out = Object.fromEntries(REC_ORDER.map((k) => [k, 0])) as Record<RecFilter, number>;
    for (const i of items) if (!hideHandled || handledOf(i) === null) out[recOf(i)] += 1;
    return out;
  }, [items, hideHandled]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => !hideHandled || handledOf(i) === null || i.snapshot.number === selected)
      .filter((i) => filters.size === 0 || filters.has(recOf(i)))
      .filter((i) => {
        if (!q) return true;
        return [String(i.snapshot.number), i.snapshot.title, i.snapshot.author, ...i.snapshot.labels]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => {
        const ra = REC_ORDER.indexOf(recOf(a));
        const rb = REC_ORDER.indexOf(recOf(b));
        if (ra !== rb) return ra - rb;
        const ca = a.evaluation?.recommendation.confidence ?? 0;
        const cb = b.evaluation?.recommendation.confidence ?? 0;
        if (ca !== cb) return cb - ca;
        return a.snapshot.number - b.snapshot.number;
      });
  }, [items, filters, hideHandled, query, selected]);

  const selectedItem = selected === null ? null : (items.find((i) => i.snapshot.number === selected) ?? null);

  const goNext = useCallback(
    (from: number): void => {
      const idx = visible.findIndex((i) => i.snapshot.number === from);
      const next = visible.slice(idx + 1).find((i) => handledOf(i) === null) ?? visible.find((i) => i.snapshot.number !== from && handledOf(i) === null);
      window.location.hash = next ? `#/issue/${next.snapshot.number}` : "#/issues";
    },
    [visible],
  );

  const onScan = (numbers?: number[]): void => {
    setScanError(null);
    setRunning(true);
    startIssueScan({ force: numbers ? true : force, ...(numbers ? { numbers } : {}) }).catch((err: unknown) => {
      setRunning(false);
      setScanError(errorText(err, "The issue scan could not be started."));
    });
  };

  const patchItem = (n: number, patch: Partial<IssueListItem>): void => {
    setBoard((prev) =>
      prev ? { ...prev, items: prev.items.map((i) => (i.snapshot.number === n ? { ...i, ...patch } : i)) } : prev,
    );
  };

  const toggle = (f: RecFilter): void =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  const handledCount = items.filter((i) => handledOf(i) !== null).length;
  const analysed = items.filter((i) => i.evaluation !== null).length;

  return (
    <div className="issues">
      <section className="issues__bar" aria-label="Issue scan">
        <div className="issues__summary">
          <strong className="issues__total mono">{items.length}</strong> open issues
          <span className="issues__meta mono">
            {analysed} analysed · {handledCount} handled · Jev {formatUsd(board?.estCostUsd ?? 0)}
          </span>
        </div>
        <label className="issues__actor">
          <span>Acting as</span>
          <input
            className="search__input"
            value={actor}
            placeholder="your name"
            onChange={(e) => {
              setActor(e.currentTarget.value);
              writeStored(ACTOR_KEY, e.currentTarget.value);
            }}
          />
        </label>
        <label className="toggle" title="Move to the next unhandled issue after an action">
          <input
            type="checkbox"
            checked={advance}
            onChange={(e) => {
              setAdvance(e.currentTarget.checked);
              writeStored(ADVANCE_KEY, e.currentTarget.checked ? "1" : "0");
            }}
          />
          <span>auto-advance</span>
        </label>
        <label className="toggle" title="Re-analyse issues even when nothing changed on GitHub">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.currentTarget.checked)} disabled={running} />
          <span>force</span>
        </label>
        <button type="button" className="btn btn--primary" onClick={() => onScan()} disabled={running}>
          {running ? <Spinner label={`Analysing ${progress.done}/${progress.total || "…"}`} /> : "Scan open issues"}
        </button>
        {health && health.writesEnabled !== true ? (
          <p className="issues__dry" role="note">
            Dry run: <code className="mono">ALLOW_GITHUB_WRITES</code> is off, so every click is recorded in the audit log and
            nothing is sent to GitHub.
          </p>
        ) : null}
        {scanError ? <p className="header__error" role="alert">{scanError}</p> : null}
      </section>

      <div className="issues__chips" role="group" aria-label="Filter by recommendation">
        {REC_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            className={`issues__chip${filters.has(k) ? " issues__chip--on" : ""}`}
            aria-pressed={filters.has(k)}
            onClick={() => toggle(k)}
          >
            <Pill tone={REC_TONE[k]}>{REC_LABEL[k]}</Pill>
            <span className="mono">{counts[k]}</span>
          </button>
        ))}
        <label className="toggle">
          <input type="checkbox" checked={hideHandled} onChange={(e) => setHideHandled(e.currentTarget.checked)} />
          <span>hide handled</span>
        </label>
      </div>

      {error ? <ErrorNote message={error} onRetry={() => window.location.reload()} /> : null}

      <main id="main" className={`layout${selected !== null ? " layout--detail" : ""}`}>
        <div className="layout__list">
          <div className="prlist">
            <div className="prlist__controls">
              <div className="search">
                <input
                  className="search__input"
                  type="search"
                  placeholder="Filter by number, title, author, label"
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                />
              </div>
            </div>
            {loading ? (
              <Skeleton lines={8} />
            ) : visible.length === 0 ? (
              <EmptyState
                title={items.length === 0 ? "No open issues loaded" : "Nothing matches"}
                detail={items.length === 0 ? "Scan open issues to analyse the backlog." : "Clear a filter or show handled issues."}
              />
            ) : (
              <ul className="prlist__items">
                {visible.map((item) => (
                  <li key={item.snapshot.number}>
                    <IssueCard item={item} selected={item.snapshot.number === selected} stage={stages[item.snapshot.number]} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="layout__detail">
          {selectedItem ? (
            <IssueDetail
              key={selectedItem.snapshot.number}
              item={selectedItem}
              actor={actor}
              busy={running}
              onReanalyse={() => onScan([selectedItem.snapshot.number])}
              onRecord={(record) => {
                patchItem(record.prNumber, { lastAction: record });
                if (advance && record.outcome === "posted") goNext(record.prNumber);
              }}
              onTriage={async (status) => {
                const state = await setIssueTriage(selectedItem.snapshot.number, status, actor.trim() || undefined);
                patchItem(selectedItem.snapshot.number, { triage: state });
                if (advance && status !== "untriaged") goNext(selectedItem.snapshot.number);
              }}
            />
          ) : selected !== null && !loading ? (
            <EmptyState title={`Issue #${selected} is not in the open list`} detail="It may have been closed already." />
          ) : (
            <EmptyState title="Pick an issue" detail="Likely closes are listed first. Each has one button to act on it." />
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- card
function IssueCard({
  item,
  selected,
  stage,
}: {
  item: IssueListItem;
  selected: boolean;
  stage: { stage: string; detail?: string } | undefined;
}) {
  const { snapshot, evaluation } = item;
  const rec = recOf(item);
  const handled = handledOf(item);
  const ev = evaluation?.evidence;
  return (
    <a
      className={`prcard isscard isscard--${rec}${selected ? " prcard--selected" : ""}${handled ? " isscard--handled" : ""}`}
      href={`#/issue/${snapshot.number}`}
      aria-current={selected ? "true" : undefined}
    >
      <div className="prcard__top">
        <span className="prcard__number mono">#{snapshot.number}</span>
        <Pill tone={REC_TONE[rec]}>{REC_LABEL[rec]}</Pill>
        {evaluation ? <span className="mono isscard__conf">{percent(evaluation.recommendation.confidence)}</span> : null}
        {item.stale && evaluation ? <Pill tone="warn" title="New activity since this was analysed">stale</Pill> : null}
        {handled ? <Pill tone="neutral">{handled}</Pill> : null}
        {item.lastAction && item.lastAction.outcome !== "posted" ? (
          <Pill tone="warn" title={item.lastAction.error ?? item.lastAction.outcome}>{item.lastAction.outcome.replace(/_/g, " ")}</Pill>
        ) : null}
        {stage ? (
          <span className="stagechip" title={stage.detail ?? stage.stage}>
            <span className="stagechip__spin" aria-hidden="true" />
            <span className="stagechip__text mono">{STAGE_LABEL[stage.stage] ?? stage.stage}</span>
          </span>
        ) : null}
      </div>
      <div className="isscard__title">{snapshot.title}</div>
      <div className="isscard__meta mono">
        {snapshot.author !== "unknown" ? `${snapshot.author} · ` : ""}opened {years(snapshot.createdAt)}
        {ev ? ` · quiet ${ev.daysSinceActivity}d · ${ev.commentCount} comments` : ""}
        {ev && ev.codeRefsChecked > 0 ? ` · ${ev.codeRefsMissing}/${ev.codeRefsChecked} refs gone` : ""}
      </div>
      {evaluation ? <div className="isscard__why">{evaluation.recommendation.headline}</div> : null}
    </a>
  );
}

// ---------------------------------------------------------------- detail
function answerText(a: JevAnswer): string {
  if (a.type === "noul") return percent(a.noul);
  if (a.type === "score") return `${a.score.toFixed(1)} / 3`;
  return `${a.choice.replace(/_/g, " ")} (${percent(a.confidence)})`;
}

const ANSWER_LABEL: Record<string, string> = {
  issue_type: "Type",
  actionable: "Actionable",
  resolved_in_thread: "Resolved in thread",
  fixed_by_linked_work: "Fixed by linked PR",
  superseded_by_code_changes: "Superseded by code changes",
  awaiting_reporter: "Awaiting reporter",
  still_relevant: "Still relevant",
  automation_directed_text: "Text aimed at automation",
};

function IssueDetail({
  item,
  actor,
  busy,
  onReanalyse,
  onRecord,
  onTriage,
}: {
  item: IssueListItem;
  actor: string;
  busy: boolean;
  onReanalyse: () => void;
  onRecord: (record: ActionRecord) => void;
  onTriage: (status: "kept" | "snoozed" | "untriaged") => Promise<void>;
}) {
  const { snapshot, evaluation } = item;
  const rec = evaluation?.recommendation ?? null;
  const [body, setBody] = useState(rec?.body ?? "");
  const [withComment, setWithComment] = useState(true);
  const [sending, setSending] = useState<IssueActionKind | null>(null);
  const [result, setResult] = useState<ActionRecord | null>(item.lastAction);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBody(rec?.body ?? "");
  }, [evaluation?.id, rec?.body]);

  const act = async (kind: IssueActionKind): Promise<void> => {
    if (!evaluation) return;
    if (actor.trim() === "") {
      setErr("Fill in “Acting as” first: every write names the person who clicked.");
      return;
    }
    setErr(null);
    setSending(kind);
    try {
      const includeBody = kind === "comment" || (withComment && body.trim() !== "" && kind !== "labels");
      const record = await postIssueAction(snapshot.number, {
        evaluationId: evaluation.id,
        kind,
        actor: actor.trim(),
        ...(includeBody ? { body } : {}),
        ...((kind === "labels" || kind === "comment") && rec && rec.labels.length > 0 ? { labels: rec.labels } : {}),
      });
      setResult(record);
      onRecord(record);
    } catch (e: unknown) {
      setErr(errorText(e, "The action could not be sent."));
    } finally {
      setSending(null);
    }
  };

  const primary = rec?.action ?? null;
  const others: IssueActionKind[] = (["close_completed", "close_not_planned", "comment"] as IssueActionKind[]).filter((k) => k !== primary);
  const ev = evaluation?.evidence ?? null;

  return (
    <article className="detail issdetail" aria-label={`Issue ${snapshot.number}`}>
      <header className="issdetail__head">
        <a className="btn btn--ghost btn--sm issdetail__back" href="#/issues">
          ← all issues
        </a>
        <h2 className="issdetail__title">
          <a href={snapshot.url} target="_blank" rel="noreferrer noopener">
            #{snapshot.number} {snapshot.title}
          </a>
        </h2>
        <p className="issdetail__meta mono">
          {snapshot.author} ({snapshot.authorAssociation.toLowerCase()}) · opened {years(snapshot.createdAt)} · updated{" "}
          {relativeTime(snapshot.updatedAt)}
          {snapshot.reactions > 0 ? ` · ${snapshot.reactions} reactions` : ""}
        </p>
        {snapshot.labels.length > 0 ? (
          <div className="issdetail__labels">
            {snapshot.labels.map((l) => (
              <Pill key={l}>{l}</Pill>
            ))}
          </div>
        ) : null}
      </header>

      {!evaluation ? (
        <section className="action">
          <p className="action__none">Not analysed yet.</p>
          <button type="button" className="btn btn--primary" onClick={onReanalyse} disabled={busy}>
            Analyse this issue
          </button>
        </section>
      ) : (
        <section className="action issaction" aria-label="Recommended action">
          <header className="action__head">
            <h3 className="action__title">{rec?.headline}</h3>
            <Pill tone={REC_TONE[rec?.kind ?? "needs_human"]}>{REC_LABEL[rec?.kind ?? "needs_human"]}</Pill>
            <span className="mono action__generated">
              confidence {percent(rec?.confidence ?? 0)} · {evaluation.mock ? "mock Jev" : `Jev ${evaluation.model}`} ·{" "}
              {relativeTime(evaluation.evaluatedAt)}
            </span>
            {item.stale ? <Pill tone="warn">new activity since analysis</Pill> : null}
          </header>
          {rec && rec.reasons.length > 0 ? (
            <ul className="issaction__reasons">
              {rec.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}

          <div className="action__bodyhead">
            <span className="action__bodylabel">Comment posted with the action</span>
            <label className="toggle">
              <input type="checkbox" checked={withComment} onChange={(e) => setWithComment(e.currentTarget.checked)} />
              <span>include with close</span>
            </label>
          </div>
          <textarea
            className="issaction__body mono"
            rows={8}
            value={body}
            placeholder="No comment drafted for this recommendation. Write one to post it with the action."
            onChange={(e) => setBody(e.currentTarget.value)}
          />
          {rec && rec.labels.length > 0 ? (
            <p className="action__subtitle">
              Labels added with the comment: <span className="mono">{rec.labels.join(", ")}</span>
            </p>
          ) : null}

          <div className="issaction__buttons">
            {primary ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={sending !== null || item.stale}
                onClick={() => void act(primary)}
                title={item.stale ? "Re-analyse first: the issue changed after this analysis" : undefined}
              >
                {sending === primary ? <Spinner label="Sending" /> : ACTION_LABEL[primary]}
              </button>
            ) : null}
            {others.map((k) => (
              <button
                key={k}
                type="button"
                className="btn btn--ghost"
                disabled={sending !== null || item.stale || (k === "comment" && body.trim() === "")}
                onClick={() => void act(k)}
              >
                {sending === k ? <Spinner label="Sending" /> : ACTION_LABEL[k]}
              </button>
            ))}
            <span className="issaction__sep" aria-hidden="true" />
            <button type="button" className="btn btn--ghost" onClick={() => void onTriage("kept")} title="Local only: nothing is sent to GitHub">
              Keep open
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => void onTriage("snoozed")} title="Local only">
              Snooze
            </button>
            <button type="button" className="btn btn--ghost" onClick={onReanalyse} disabled={busy}>
              Re-analyse
            </button>
          </div>
          {err ? <ErrorNote message={err} /> : null}
          {result ? <ActionResult record={result} /> : null}
          {item.triage && item.triage.status !== "untriaged" ? (
            <p className="action__subtitle">
              Marked {item.triage.status} locally {relativeTime(item.triage.updatedAt)}.{" "}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onTriage("untriaged")}>
                undo
              </button>
            </p>
          ) : null}
        </section>
      )}

      {ev ? <Evidence item={item} /> : null}

      {evaluation && Object.keys(evaluation.answers).length > 0 ? (
        <section className="issdetail__section">
          <h3 className="issdetail__h">What Jev read</h3>
          <dl className="issanswers">
            {Object.entries(evaluation.answers).map(([id, a]) => (
              <div key={id} className="issanswers__row">
                <dt>{ANSWER_LABEL[id] ?? id}</dt>
                <dd className="mono">{answerText(a)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section className="issdetail__section">
        <h3 className="issdetail__h">The issue</h3>
        {snapshot.body.trim() ? <Markdown source={snapshot.body} /> : <p className="action__none">No description.</p>}
        {snapshot.comments.length > 0 ? (
          <details className="issthread">
            <summary>{snapshot.comments.length} comment(s)</summary>
            {snapshot.comments.map((c, i) => (
              <div key={i} className="issthread__c">
                <p className="issthread__who mono">
                  <a href={c.url} target="_blank" rel="noreferrer noopener">
                    {c.author}
                  </a>
                  {c.isMaintainer ? " · maintainer" : c.author === snapshot.author ? " · reporter" : ""} · {relativeTime(c.at)}
                </p>
                <Markdown source={c.body} />
              </div>
            ))}
          </details>
        ) : null}
      </section>
    </article>
  );
}

function ActionResult({ record }: { record: ActionRecord }) {
  const tone = record.outcome === "posted" ? "good" : record.outcome === "refused_writes_disabled" ? "accent" : "bad";
  return (
    <div className={`issresult issresult--${tone}`} role="status">
      <Pill tone={tone}>{record.outcome.replace(/_/g, " ")}</Pill>
      <span className="mono">
        {ACTION_LABEL[record.kind as IssueActionKind] ?? record.kind} by {record.confirmedBy} · {relativeTime(record.requestedAt)}
      </span>
      {record.githubUrl ? (
        <a href={record.githubUrl} target="_blank" rel="noreferrer noopener">
          view on GitHub
        </a>
      ) : null}
      {record.error ? <p className="issresult__err">{record.error}</p> : null}
    </div>
  );
}

function Evidence({ item }: { item: IssueListItem }) {
  const ev = item.evaluation?.evidence;
  const { snapshot } = item;
  if (!ev) return null;
  return (
    <section className="issdetail__section">
      <h3 className="issdetail__h">Evidence</h3>
      <dl className="issfacts">
        <div>
          <dt>Age</dt>
          <dd className="mono">{ev.ageDays}d</dd>
        </div>
        <div>
          <dt>Quiet for</dt>
          <dd className="mono">{ev.daysSinceActivity}d</dd>
        </div>
        <div>
          <dt>Comments</dt>
          <dd className="mono">
            {ev.commentCount} from {ev.participants} people
          </dd>
        </div>
        <div>
          <dt>Last word</dt>
          <dd className="mono">{ev.lastCommentBy}</dd>
        </div>
        <div>
          <dt>Commits since opened</dt>
          <dd className="mono">{ev.commitsSinceOpened ?? "?"}</dd>
        </div>
        <div>
          <dt>Touching named files</dt>
          <dd className="mono">{ev.commitsTouchingRefsSinceOpened ?? "–"}</dd>
        </div>
      </dl>

      {snapshot.linkedPrs.length > 0 ? (
        <>
          <h4 className="issdetail__h4">Linked pull requests</h4>
          <ul className="isslist">
            {snapshot.linkedPrs.map((p) => (
              <li key={p.number}>
                <Pill tone={p.state === "merged" ? "merged" : p.state === "open" ? "accent" : "neutral"}>{p.state}</Pill>{" "}
                <a href={p.url} target="_blank" rel="noreferrer noopener">
                  #{p.number} {p.title}
                </a>
                {p.closingKeyword ? <Pill tone="good">says it closes this</Pill> : null}
                {p.mergedAt ? <span className="mono isslist__dim"> merged {p.mergedAt.slice(0, 10)}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {ev.codeRefs.length > 0 ? (
        <>
          <h4 className="issdetail__h4">Code it names, checked against master{ev.baseSha ? ` @ ${ev.baseSha.slice(0, 9)}` : ""}</h4>
          <ul className="isslist">
            {ev.codeRefs.map((r) => (
              <li key={`${r.kind}:${r.text}`}>
                <Pill tone={r.status === "exists" ? "good" : r.status === "unchecked" ? "neutral" : "bad"}>
                  {r.status.replace(/_/g, " ")}
                </Pill>{" "}
                <code className="mono">{r.text}</code>
                {r.matches.length > 0 && r.matches[0] !== r.text ? (
                  <span className="mono isslist__dim"> → {r.matches.slice(0, 3).join(", ")}</span>
                ) : null}
                {r.commitsSince > 0 ? <span className="mono isslist__dim"> · {r.commitsSince} commits since</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="action__none">The issue names no files or identifiers, so relevance rests on the thread alone.</p>
      )}

      {ev.recentTouchingCommits.length > 0 ? (
        <>
          <h4 className="issdetail__h4">Recent commits to those files</h4>
          <ul className="isslist mono">
            {ev.recentTouchingCommits.map((c) => (
              <li key={c.sha}>
                {c.date.slice(0, 10)} {c.sha.slice(0, 9)} {c.subject}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {ev.notes.length > 0 ? <p className="action__none">{ev.notes.join(" · ")}</p> : null}
    </section>
  );
}
