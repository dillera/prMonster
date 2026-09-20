// A deliberately small markdown renderer for proposal bodies and PR descriptions.
//
// It renders to React elements, never to HTML: PR bodies and generated proposals are
// untrusted text (DESIGN.md 2, jaggedness rule 5), so nothing here can inject markup.
// Supported: ATX headings, bullet lists including task boxes, blockquotes, fenced and
// indented code, horizontal rules, paragraphs, and inline code / bold / italic / links.

import type { ReactNode } from "react";

type Inline = ReactNode;

function renderInline(text: string, keyPrefix: string): Inline[] {
  const out: Inline[] = [];
  // code spans first so their contents are never re-parsed
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("`")) {
      out.push(
        <code key={key} className="md__code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const label = token.slice(1, token.indexOf("]"));
      const href = match[5] ?? "#";
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface ListItem {
  text: string;
  checked: boolean | null;
  continuation: string[];
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const flushList = (items: ListItem[]): void => {
    if (items.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`} className="md__list">
        {items.map((item, idx) => (
          <li key={idx} className={item.checked === null ? "md__li" : "md__li md__li--task"}>
            {item.checked === null ? null : (
              <span className={`md__box${item.checked ? " md__box--done" : ""}`} aria-hidden="true">
                {item.checked ? "x" : ""}
              </span>
            )}
            <span>
              {renderInline(item.text, `li-${idx}`)}
              {item.continuation.map((c, ci) => (
                <span key={ci} className="md__continuation">
                  {renderInline(c, `lic-${idx}-${ci}`)}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>,
    );
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // fenced code
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`pre-${key++}`} className="md__pre">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${key++}`} className="md__hr" />);
      i += 1;
      continue;
    }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const text = heading[2] ?? "";
      const Tag = (level <= 2 ? "h4" : "h5") as "h4" | "h5";
      blocks.push(
        <Tag key={`h-${key++}`} className={`md__h md__h--${level}`}>
          {renderInline(text, `h-${key}`)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    // blockquote
    if (line.trimStart().startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith(">")) {
        body.push((lines[i] ?? "").trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={`bq-${key++}`} className="md__quote">
          {renderInline(body.join(" "), `bq-${key}`)}
        </blockquote>,
      );
      continue;
    }

    // list (bullets, numbers, task boxes)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(current);
        if (bullet) {
          let text = bullet[2] ?? "";
          let checked: boolean | null = null;
          const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
          if (task) {
            checked = (task[1] ?? " ").toLowerCase() === "x";
            text = task[2] ?? "";
          }
          items.push({ text, checked, continuation: [] });
          i += 1;
          continue;
        }
        // indented continuation of the previous item
        if (/^\s{2,}\S/.test(current) && items.length > 0) {
          items[items.length - 1]?.continuation.push(current.trim());
          i += 1;
          continue;
        }
        break;
      }
      flushList(items);
      continue;
    }

    // paragraph
    const para: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (
        current.trim() === "" ||
        /^\s*([-*+]|\d+\.)\s+/.test(current) ||
        /^#{1,6}\s+/.test(current) ||
        current.trimStart().startsWith("```") ||
        current.trimStart().startsWith(">")
      ) {
        break;
      }
      para.push(current.trim());
      i += 1;
    }
    blocks.push(
      <p key={`p-${key++}`} className="md__p">
        {renderInline(para.join(" "), `p-${key}`)}
      </p>,
    );
  }

  return <div className={`md ${className}`}>{blocks}</div>;
}
