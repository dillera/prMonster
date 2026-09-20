// Files tab (DESIGN.md 7.4): changed files, their chunk, and what was skipped.

import type { Evaluation, PrFile, PrSnapshot } from "../../shared/types";
import { chunkCounts, chunkFailed, formatNumber } from "../format";
import { EmptyState, Pill } from "./ui";

/** Where a file ended up: a chunk that was evaluated, a chunk that failed, or nowhere. */
interface Placement {
  index: number;
  error?: string;
}

export function FilesPanel({
  snapshot,
  evaluation,
}: {
  snapshot: PrSnapshot;
  evaluation: Evaluation | null;
}) {
  // Keyed by chunk.index, which is not the array position: a split leaves gaps.
  const chunkByPath = new Map<string, Placement>();
  for (const chunk of evaluation?.chunks ?? []) {
    for (const path of chunk.chunk.files) {
      // A file split across chunks can land in one that succeeded and one that did
      // not. The failure wins: part of that file was never read.
      const existing = chunkByPath.get(path);
      if (existing?.error !== undefined) continue;
      chunkByPath.set(path, {
        index: chunk.chunk.index,
        ...(chunkFailed(chunk) ? { error: chunk.error } : {}),
      });
    }
  }
  const skipped = new Set(evaluation?.skippedFiles ?? []);
  const counts = evaluation ? chunkCounts(evaluation) : null;
  const maxChange = Math.max(1, ...snapshot.files.map((f) => f.additions + f.deletions));

  if (snapshot.files.length === 0) {
    return <EmptyState title="No files" detail="The snapshot carries no changed files." />;
  }

  return (
    <div className="files">
      <div className="files__summary">
        <span className="mono">{snapshot.changedFiles} files</span>
        <span className="files__add mono">+{formatNumber(snapshot.additions)}</span>
        <span className="files__del mono">-{formatNumber(snapshot.deletions)}</span>
        {evaluation ? (
          <Pill tone={evaluation.coverage === "partial" ? "warn" : "good"}>coverage {evaluation.coverage}</Pill>
        ) : (
          <Pill tone="neutral">not evaluated</Pill>
        )}
        {evaluation && evaluation.skippedFiles.length > 0 ? (
          <span className="files__skippednote">{evaluation.skippedFiles.length} not sent to Jev</span>
        ) : null}
        {counts && counts.failed > 0 ? (
          <span className="files__skippednote">
            {counts.failed} of {counts.total} chunks failed, so their files were not evaluated
          </span>
        ) : null}
      </div>

      <ul className="filelist">
        {snapshot.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            placement={chunkByPath.get(file.path)}
            skipped={skipped.has(file.path)}
            evaluated={evaluation !== null}
            maxChange={maxChange}
            repoUrl={snapshot.url}
          />
        ))}
      </ul>
    </div>
  );
}

function FileRow({
  file,
  placement,
  skipped,
  evaluated,
  maxChange,
  repoUrl,
}: {
  file: PrFile;
  placement: Placement | undefined;
  skipped: boolean;
  evaluated: boolean;
  maxChange: number;
  repoUrl: string;
}) {
  const total = file.additions + file.deletions;
  const addShare = total > 0 ? (file.additions / total) * 100 : 0;
  const weight = (total / maxChange) * 100;

  const failed = placement?.error !== undefined;

  return (
    <li className={`filerow${skipped ? " filerow--skipped" : ""}${failed ? " filerow--failed" : ""}`}>
      <span className={`filerow__status mono filerow__status--${file.status}`}>{file.status.slice(0, 3)}</span>
      <a
        className="filerow__path mono"
        href={`${repoUrl}/files`}
        target="_blank"
        rel="noreferrer noopener"
        title={file.previousPath ? `renamed from ${file.previousPath}` : file.path}
      >
        {file.path}
      </a>
      <span className="filerow__counts mono">
        <span className="files__add">+{file.additions}</span>
        <span className="files__del">-{file.deletions}</span>
      </span>
      <span className="filerow__bar" aria-hidden="true" style={{ opacity: 0.35 + (weight / 100) * 0.65 }}>
        <span className="filerow__add" style={{ width: `${addShare}%` }} />
        <span className="filerow__del" style={{ width: `${100 - addShare}%` }} />
      </span>
      {placement !== undefined && placement.error !== undefined ? (
        <span
          className="filerow__chunk filerow__chunk--failed mono"
          title={`Chunk ${placement.index} failed: ${placement.error}`}
        >
          not evaluated: chunk {placement.index} failed
        </span>
      ) : placement !== undefined ? (
        <span className="filerow__chunk mono" title="Chunk this file was sent to Jev in">
          chunk {placement.index}
        </span>
      ) : skipped ? (
        <span className="filerow__chunk filerow__chunk--skip mono" title="Filtered out or over the token budget">
          not evaluated
        </span>
      ) : evaluated ? (
        <span className="filerow__chunk filerow__chunk--none mono" title="Not part of any chunk">
          no chunk
        </span>
      ) : (
        <span className="filerow__chunk filerow__chunk--none mono">pending</span>
      )}
    </li>
  );
}
