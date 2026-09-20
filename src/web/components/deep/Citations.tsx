// Citation links for briefs and the dossier (DESIGN-deep.md).
//
// A brief is model written, so every claim it makes has to be checkable in one
// click. Anything that cannot be turned into a URL is shown as plain text rather
// than a dead link, so the reader can tell the difference.

import type { ReactNode } from "react";

import type { Citation } from "../../../shared/types";
import { blobUrl, resolveCitation } from "../../github";

export function CitationLink({
  citation,
  repo,
  fallbackSha,
}: {
  citation: Citation;
  repo: string;
  fallbackSha?: string;
}) {
  const resolved = resolveCitation(citation, repo, fallbackSha);
  const label = (
    <>
      <span className={`cite__kind cite__kind--${resolved.kind}`} aria-hidden="true">
        {resolved.kind}
      </span>
      <span className="cite__ref mono">{resolved.label}</span>
    </>
  );

  if (!resolved.href) {
    return (
      <span className="cite cite--dead" title={`${resolved.title} (no link available)`}>
        {label}
      </span>
    );
  }

  return (
    <a className="cite" href={resolved.href} target="_blank" rel="noreferrer noopener" title={resolved.title}>
      {label}
    </a>
  );
}

export function CitationList({
  citations,
  repo,
  fallbackSha,
}: {
  citations: Citation[];
  repo: string;
  fallbackSha?: string;
}) {
  if (citations.length === 0) {
    return <span className="cite cite--none">no citation</span>;
  }
  return (
    <span className="citelist">
      {citations.map((citation, i) => (
        <CitationLink key={`${citation.kind}-${citation.ref}-${i}`} citation={citation} repo={repo} fallbackSha={fallbackSha} />
      ))}
    </span>
  );
}

/** A path and line that links to the blob at an exact revision. */
export function CodeLocation({
  repo,
  sha,
  path,
  line,
  endLine,
  children,
}: {
  repo: string;
  sha: string;
  path: string;
  line?: number;
  endLine?: number;
  children?: ReactNode;
}) {
  const label =
    children ??
    `${path}${line === undefined ? "" : endLine !== undefined && endLine !== line ? `:${line}-${endLine}` : `:${line}`}`;
  return (
    <a
      className="codeloc mono"
      href={blobUrl(repo, sha, path, line, endLine)}
      target="_blank"
      rel="noreferrer noopener"
      title={`${path} at ${sha.slice(0, 7)}`}
    >
      {label}
    </a>
  );
}
