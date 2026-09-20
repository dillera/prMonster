// GitHub link builders and citation parsing for the deep analysis views
// (DESIGN-deep.md, UI section). Pure string work, no network.
//
// Every fact the dossier or a brief states must be checkable by one click, so every
// path, line, PR number, commit and comment turns into a URL here.

import type { Citation } from "../shared/types";

export const DEFAULT_REPO = "FujiNetWIFI/fujinet-firmware";

export function prUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/pull/${n}`;
}

export function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

/** Blob at an exact revision, with a line or a line range anchor. */
export function blobUrl(
  repo: string,
  sha: string,
  path: string,
  startLine?: number,
  endLine?: number,
): string {
  const clean = path.replace(/^\/+/, "");
  let anchor = "";
  if (startLine !== undefined && Number.isFinite(startLine)) {
    anchor = `#L${startLine}`;
    if (endLine !== undefined && Number.isFinite(endLine) && endLine !== startLine) {
      anchor += `-L${endLine}`;
    }
  }
  return `https://github.com/${repo}/blob/${sha}/${clean}${anchor}`;
}

export interface CodeRef {
  path: string;
  startLine?: number;
  endLine?: number;
  sha?: string;
}

/**
 * Parse a code citation: `lib/x.cpp:84-88@<sha>`, `lib/x.cpp:84@<sha>`,
 * `lib/x.cpp:84-88` or just `lib/x.cpp`.
 */
export function parseCodeRef(ref: string): CodeRef {
  const at = ref.lastIndexOf("@");
  let body = ref;
  let sha: string | undefined;
  if (at > 0) {
    const candidate = ref.slice(at + 1).trim();
    if (/^[0-9a-f]{7,40}$/i.test(candidate) || /^(origin\/)?[\w./-]+$/.test(candidate)) {
      sha = candidate;
      body = ref.slice(0, at);
    }
  }
  const range = /^(.*?):(\d+)(?:-(?:L)?(\d+))?$/.exec(body.trim());
  if (!range) return { path: body.trim(), ...(sha ? { sha } : {}) };
  const start = Number.parseInt(range[2] ?? "", 10);
  const end = range[3] ? Number.parseInt(range[3], 10) : undefined;
  return {
    path: (range[1] ?? "").trim(),
    ...(Number.isFinite(start) ? { startLine: start } : {}),
    ...(end !== undefined && Number.isFinite(end) ? { endLine: end } : {}),
    ...(sha ? { sha } : {}),
  };
}

export interface ResolvedCitation {
  /** What the reader sees. */
  label: string;
  /** Where it goes, or null when the reference cannot be turned into a URL. */
  href: string | null;
  kind: Citation["kind"];
  title: string;
  note?: string;
}

/**
 * Turn one citation into a label and a URL.
 * `fallbackSha` is the revision to use when a code citation omits `@sha`.
 */
export function resolveCitation(citation: Citation, repo: string, fallbackSha?: string): ResolvedCitation {
  const ref = citation.ref.trim();
  const note = citation.note ? { note: citation.note } : {};

  if (/^https?:\/\//i.test(ref)) {
    return {
      label: shortenUrl(ref),
      href: ref,
      kind: citation.kind,
      title: ref,
      ...note,
    };
  }

  switch (citation.kind) {
    case "pr": {
      const num = Number.parseInt(ref.replace(/^#/, ""), 10);
      return Number.isFinite(num)
        ? { label: `#${num}`, href: prUrl(repo, num), kind: "pr", title: `Pull request #${num}`, ...note }
        : { label: ref, href: null, kind: "pr", title: ref, ...note };
    }
    case "commit": {
      const sha = ref.replace(/^commit\s+/i, "");
      return /^[0-9a-f]{7,40}$/i.test(sha)
        ? {
            label: sha.slice(0, 7),
            href: commitUrl(repo, sha),
            kind: "commit",
            title: `Commit ${sha}`,
            ...note,
          }
        : { label: ref, href: null, kind: "commit", title: ref, ...note };
    }
    case "comment":
      // A comment citation that is not a URL cannot be linked.
      return { label: ref, href: null, kind: "comment", title: ref, ...note };
    case "code":
    default: {
      const parsed = parseCodeRef(ref);
      const sha = parsed.sha ?? fallbackSha;
      if (!parsed.path || !sha) {
        return { label: ref, href: null, kind: "code", title: ref, ...note };
      }
      const lines =
        parsed.startLine === undefined
          ? ""
          : parsed.endLine !== undefined && parsed.endLine !== parsed.startLine
            ? `:${parsed.startLine}-${parsed.endLine}`
            : `:${parsed.startLine}`;
      return {
        label: `${parsed.path}${lines}`,
        href: blobUrl(repo, sha, parsed.path, parsed.startLine, parsed.endLine),
        kind: "code",
        title: `${parsed.path}${lines} at ${sha.slice(0, 7)}`,
        ...note,
      };
    }
  }
}

function shortenUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  if (stripped === url) return url.length > 44 ? `${url.slice(0, 41)}...` : url;
  // .../pull/1650#issuecomment-123 reads better as #1650 comment
  const comment = /^([\w.-]+)\/([\w.-]+)\/pull\/(\d+)#(issuecomment|discussion_r)-?(\d+)/.exec(stripped);
  if (comment) return `#${comment[3]} comment`;
  return stripped.length > 44 ? `${stripped.slice(0, 41)}...` : stripped;
}
