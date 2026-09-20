// Dossier section of the Deep analysis tab (DESIGN-deep.md, UI 1).
//
// Everything here is deterministic: git and the GitHub thread, no model. Every fact
// links to its source, so a reviewer can check any line of it in one click.

import { useState } from "react";

import type { Dossier, DriftSignal, ThreadEntry } from "../../../shared/types";
import { relativeTime, shortSha } from "../../format";
import { commitUrl, prUrl } from "../../github";
import { Markdown } from "../Markdown";
import { EmptyState, Pill } from "../ui";
import { CodeLocation } from "./Citations";

const DRIFT_TITLES: Record<DriftSignal["kind"], string> = {
  body_mentions_absent_token: "The body mentions something the diff does not contain",
  title_mentions_absent_token: "The title mentions something the diff does not contain",
  body_predates_push: "The description predates the latest push",
  commit_subject_disagrees_with_title: "No commit subject matches the title",
};

const THREAD_KIND: Record<ThreadEntry["kind"], string> = {
  issue_comment: "comment",
  review_comment: "review comment",
  review: "review",
  commit: "commit",
};

export function DossierView({
  dossier,
  repo,
  prAuthor,
}: {
  dossier: Dossier;
  repo: string;
  prAuthor: string;
}) {
  const authorEntries = dossier.thread.filter((t) => t.author === prAuthor && t.kind !== "commit");
  const latestAuthorComment = authorEntries[authorEntries.length - 1] ?? null;

  return (
    <section className="dossier" aria-label="Dossier">
      <header className="dossier__head">
        <h3 className="dossier__title">Dossier</h3>
        <span className="dossier__sub mono">
          built {relativeTime(dossier.builtAt)} from git and the thread, no model involved
        </span>
        <span className="dossier__spacer" />
        <Pill tone={dossier.availability.git ? "good" : "warn"}>
          {dossier.availability.git ? "git available" : "git unavailable"}
        </Pill>
      </header>

      {dossier.availability.notes.length > 0 ? (
        <ul className="dossier__notes">
          {dossier.availability.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}

      <Revisions dossier={dossier} repo={repo} />
      <DeletedLines dossier={dossier} repo={repo} />
      <Thread dossier={dossier} latestAuthorComment={latestAuthorComment} prAuthor={prAuthor} />
      <CrossReferences dossier={dossier} repo={repo} />
      <Drift dossier={dossier} />
    </section>
  );
}

// ---------------------------------------------------------------- revisions
function Revisions({ dossier, repo }: { dossier: Dossier; repo: string }) {
  const delta = dossier.latestDelta;
  return (
    <div className="dsect">
      <h4 className="dsect__title">Revisions</h4>
      <ol className="revtimeline">
        {dossier.revisions.map((rev, i) => (
          <li key={rev.headSha} className={`revtimeline__row${i === dossier.revisions.length - 1 ? " revtimeline__row--current" : ""}`}>
            <span className="revtimeline__marker" aria-hidden="true" />
            <span className="revtimeline__label">rev {i + 1}</span>
            <a
              className="revtimeline__sha mono"
              href={commitUrl(repo, rev.headSha)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {shortSha(rev.headSha)}
            </a>
            <span className="revtimeline__when mono" title={new Date(rev.pushedAt).toLocaleString()}>
              {relativeTime(rev.pushedAt)}
            </span>
            <span className="revtimeline__stat mono">
              {rev.commits.length} commit{rev.commits.length === 1 ? "" : "s"}, +{rev.additions}/-{rev.deletions},{" "}
              {rev.changedFiles} file{rev.changedFiles === 1 ? "" : "s"}
            </span>
            <ul className="revtimeline__commits">
              {rev.commits.map((c) => (
                <li key={c.sha}>
                  <a className="mono" href={commitUrl(repo, c.sha)} target="_blank" rel="noreferrer noopener">
                    {shortSha(c.sha)}
                  </a>{" "}
                  <span className="revtimeline__subject">{c.subject}</span>{" "}
                  <span className="revtimeline__author mono">{c.author}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      {delta ? (
        <div className="delta">
          <p className="delta__summary">{delta.summary}</p>
          <p className="delta__meta mono">
            <a href={commitUrl(repo, delta.fromSha)} target="_blank" rel="noreferrer noopener">
              {shortSha(delta.fromSha)}
            </a>
            {" ... "}
            <a href={commitUrl(repo, delta.toSha)} target="_blank" rel="noreferrer noopener">
              {shortSha(delta.toSha)}
            </a>
            {" · "}
            {delta.linesAddedNowRemoved} line{delta.linesAddedNowRemoved === 1 ? "" : "s"} the previous revision added
            are gone
            {delta.linesRemovedNowRestored > 0
              ? `, ${delta.linesRemovedNowRestored} it removed are back`
              : ""}
            {" · "}
            {delta.filesTouched.join(", ")}
          </p>
          <DiffExcerpt diff={delta.diff} />
        </div>
      ) : (
        <p className="dsect__empty">
          Only one revision is known for this pull request, so there is no delta to show.
        </p>
      )}
    </div>
  );
}

function DiffExcerpt({ diff, maxLines = 40 }: { diff: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = diff.split("\n");
  const shown = expanded ? lines : lines.slice(0, maxLines);

  return (
    <div className="diffx">
      <pre className="diffx__pre mono">
        {shown.map((line, i) => (
          <code key={i} className={`diffx__line diffx__line--${diffClass(line)}`}>
            {line === "" ? " " : line}
          </code>
        ))}
      </pre>
      {lines.length > maxLines ? (
        <button type="button" className="btn btn--ghost btn--xs" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
}

function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

// ---------------------------------------------------------------- deleted lines
function DeletedLines({ dossier, repo }: { dossier: Dossier; repo: string }) {
  const [openPath, setOpenPath] = useState<string | null>(null);

  if (!dossier.availability.provenance) {
    return (
      <div className="dsect">
        <h4 className="dsect__title">Deleted lines and where they came from</h4>
        <p className="dsect__empty">
          Provenance needs a local checkout, and git is not available here, so who added the deleted lines is unknown.
        </p>
      </div>
    );
  }

  if (dossier.originPrs.length === 0 && dossier.deletedLineOrigins.length === 0) {
    return (
      <div className="dsect">
        <h4 className="dsect__title">Deleted lines and where they came from</h4>
        <p className="dsect__empty">This pull request deletes no lines that git could attribute.</p>
      </div>
    );
  }

  return (
    <div className="dsect">
      <h4 className="dsect__title">Deleted lines and where they came from</h4>
      <div className="tablewrap">
        <table className="dtable">
          <thead>
            <tr>
              <th scope="col">Origin</th>
              <th scope="col">Title</th>
              <th scope="col">Author</th>
              <th scope="col" className="num">
                Age
              </th>
              <th scope="col" className="num">
                Lines
              </th>
              <th scope="col">In thread</th>
            </tr>
          </thead>
          <tbody>
            {dossier.originPrs.map((origin) => (
              <tr key={origin.number}>
                <th scope="row">
                  <a className="mono" href={prUrl(repo, origin.number)} target="_blank" rel="noreferrer noopener">
                    #{origin.number}
                  </a>
                </th>
                <td>{origin.title}</td>
                <td className="mono">{origin.author}</td>
                <td className="num mono">{origin.daysAgo}d</td>
                <td className="num mono">{origin.linesDeletedFromIt}</td>
                <td>
                  {origin.authorInThread ? (
                    <Pill tone="neutral">yes</Pill>
                  ) : (
                    <Pill tone="warn" title="The person who wrote these lines has not commented here">
                      no
                    </Pill>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="originlines">
        {groupOrigins(dossier).map((group) => (
          <li key={`${group.path}:${group.startLine}`} className="originlines__row">
            <button
              type="button"
              className="originlines__head"
              aria-expanded={openPath === `${group.path}:${group.startLine}`}
              onClick={() =>
                setOpenPath((prev) =>
                  prev === `${group.path}:${group.startLine}` ? null : `${group.path}:${group.startLine}`,
                )
              }
            >
              <span className="originlines__loc mono">
                {group.path}:{group.startLine}
                {group.endLine !== group.startLine ? `-${group.endLine}` : ""}
              </span>
              <span className="originlines__by mono">
                {shortSha(group.sha)} {group.author} {relativeTime(group.date)}
              </span>
              <span className="originlines__subject">{group.subject}</span>
            </button>
            {openPath === `${group.path}:${group.startLine}` ? (
              <div className="originlines__body">
                <p className="originlines__link">
                  <CodeLocation
                    repo={repo}
                    sha={dossier.baseSha}
                    path={group.path}
                    line={group.startLine}
                    endLine={group.endLine}
                  >
                    open these lines at the base revision
                  </CodeLocation>
                </p>
                <pre className="diffx__pre mono">
                  {group.lines.map((l) => (
                    <code key={l.line} className="diffx__line diffx__line--del">
                      {`${l.line}  ${l.text}`}
                    </code>
                  ))}
                </pre>
                {group.pr ? (
                  <p className="originlines__pr">
                    added by{" "}
                    <a href={group.pr.url} target="_blank" rel="noreferrer noopener" className="mono">
                      #{group.pr.number}
                    </a>{" "}
                    <em>{group.pr.title}</em> by <span className="mono">{group.pr.author}</span>
                    {group.pr.mergedAt ? `, merged ${relativeTime(group.pr.mergedAt)}` : ", not merged"}
                  </p>
                ) : null}
                {group.pr?.body ? (
                  <blockquote className="originlines__purpose">{group.pr.body}</blockquote>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface OriginGroup {
  path: string;
  startLine: number;
  endLine: number;
  sha: string;
  author: string;
  date: string;
  subject: string;
  pr: Dossier["deletedLineOrigins"][number]["pr"];
  lines: Array<{ line: number; text: string }>;
}

/** Consecutive deleted lines from the same commit read as one block. */
function groupOrigins(dossier: Dossier): OriginGroup[] {
  const out: OriginGroup[] = [];
  for (const origin of dossier.deletedLineOrigins) {
    const last = out[out.length - 1];
    if (last && last.path === origin.path && last.sha === origin.sha && origin.line === last.endLine + 1) {
      last.endLine = origin.line;
      last.lines.push({ line: origin.line, text: origin.text });
      continue;
    }
    out.push({
      path: origin.path,
      startLine: origin.line,
      endLine: origin.line,
      sha: origin.sha,
      author: origin.author,
      date: origin.date,
      subject: origin.subject,
      pr: origin.pr,
      lines: [{ line: origin.line, text: origin.text }],
    });
  }
  return out;
}

// ---------------------------------------------------------------- thread
function Thread({
  dossier,
  latestAuthorComment,
  prAuthor,
}: {
  dossier: Dossier;
  latestAuthorComment: ThreadEntry | null;
  prAuthor: string;
}) {
  if (dossier.thread.length === 0) {
    return (
      <div className="dsect">
        <h4 className="dsect__title">Thread</h4>
        <p className="dsect__empty">Nobody has commented on this pull request.</p>
      </div>
    );
  }

  return (
    <div className="dsect">
      <h4 className="dsect__title">
        Thread
        <span className="dsect__sub mono">
          maintainers: {dossier.maintainers.length > 0 ? dossier.maintainers.join(", ") : "none identified"}
        </span>
      </h4>
      <ol className="thread">
        {dossier.thread.map((entry, i) => {
          const isLatestAuthor = entry === latestAuthorComment;
          return (
            <li
              key={`${entry.at}-${i}`}
              className={`thread__row thread__row--${entry.kind}${isLatestAuthor ? " thread__row--author" : ""}`}
            >
              <div className="thread__head">
                <a className="thread__who mono" href={entry.url} target="_blank" rel="noreferrer noopener">
                  {entry.author}
                </a>
                {entry.isMaintainer ? (
                  <Pill tone="accent" title={entry.association.toLowerCase()}>
                    maintainer
                  </Pill>
                ) : null}
                {entry.author === prAuthor ? <Pill tone="neutral">author</Pill> : null}
                <span className="thread__kind mono">{THREAD_KIND[entry.kind]}</span>
                {entry.state ? <Pill tone={entry.state === "APPROVED" ? "good" : "warn"}>{entry.state.toLowerCase().replace(/_/g, " ")}</Pill> : null}
                {entry.path ? (
                  <span className="thread__path mono">
                    {entry.path}
                    {entry.line !== undefined ? `:${entry.line}` : ""}
                  </span>
                ) : null}
                <span className="thread__spacer" />
                <span className="thread__when mono" title={new Date(entry.at).toLocaleString()}>
                  {relativeTime(entry.at)}
                </span>
              </div>
              {isLatestAuthor ? (
                <p className="thread__flag">
                  Latest comment from the author. The deep pass checks any claims it makes.
                </p>
              ) : null}
              <div className="thread__body">
                <Markdown source={entry.body} />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- cross refs
function CrossReferences({ dossier, repo }: { dossier: Dossier; repo: string }) {
  if (!dossier.availability.crossRefs) {
    return (
      <div className="dsect">
        <h4 className="dsect__title">Cross references</h4>
        <p className="dsect__empty">Cross references need git, which is not available here.</p>
      </div>
    );
  }
  if (dossier.crossRefs.length === 0) {
    return (
      <div className="dsect">
        <h4 className="dsect__title">Cross references</h4>
        <p className="dsect__empty">No symbols worth looking up were found in the deleted lines.</p>
      </div>
    );
  }

  return (
    <div className="dsect">
      <h4 className="dsect__title">
        Cross references
        <span className="dsect__sub mono">where the deleted symbols are used elsewhere, at the base revision</span>
      </h4>
      <ul className="xrefs">
        {dossier.crossRefs.map((ref) => (
          <li key={ref.symbol} className="xrefs__row">
            <div className="xrefs__head">
              <code className="xrefs__symbol mono">{ref.symbol}</code>
              <span className={`xrefs__count mono${ref.hits.length === 0 ? " xrefs__count--zero" : ""}`}>
                {ref.hits.length} hit{ref.hits.length === 1 ? "" : "s"}
              </span>
            </div>
            <p className="xrefs__from mono">{ref.fromDeletedLine.trim()}</p>
            {ref.hits.length === 0 ? (
              <p className="xrefs__none">
                Nothing else references this symbol, so deleting it removes its last use.
              </p>
            ) : (
              <ul className="xrefs__hits">
                {ref.hits.map((hit, i) => (
                  <li key={`${hit.path}:${hit.line}-${i}`}>
                    <CodeLocation repo={repo} sha={dossier.baseSha} path={hit.path} line={hit.line} />
                    <code className="xrefs__text mono">{hit.text.trim()}</code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- drift
function Drift({ dossier }: { dossier: Dossier }) {
  if (dossier.drift.length === 0) {
    return (
      <div className="dsect">
        <h4 className="dsect__title">Drift</h4>
        <p className="dsect__empty">The title and body match the current diff.</p>
      </div>
    );
  }

  return (
    <div className="dsect">
      <h4 className="dsect__title">Drift</h4>
      <ul className="drift">
        {dossier.drift.map((signal, i) => (
          <li key={`${signal.kind}-${i}`} className="drift__row">
            <div className="drift__head">
              <Pill tone="warn">{signal.kind.replace(/_/g, " ")}</Pill>
              <span className="drift__title">{DRIFT_TITLES[signal.kind]}</span>
            </div>
            <p className="drift__detail">{signal.detail}</p>
            {signal.evidence.length > 0 ? (
              <p className="drift__evidence">
                {signal.evidence.map((token, j) => (
                  <code key={j} className="mono">
                    {token}
                  </code>
                ))}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DossierUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="dossier" aria-label="Dossier">
      <EmptyState
        title="No dossier for this pull request"
        detail={message}
        action={
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
            Try again
          </button>
        }
      />
    </section>
  );
}
