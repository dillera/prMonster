// When an issue counts as handled, and so is hidden from the issue board by
// default. Shared so the rule is one pure function the tests can pin down.
//
// Handled means *we were the last update*: an action this harness posted, or a
// local keep/snooze mark, and nothing on GitHub since. Any later activity — a
// reply, a new comment, a label someone else added — puts the issue back in
// front of a human.

import type { IssueListItem } from "./types.js";

/**
 * GitHub stamps `updated_at` a moment after our own write lands, and the
 * action's `requestedAt` is taken just before it is sent, so our own post looks
 * up to this much "newer" than the action that made it.
 */
export const OUR_UPDATE_SLACK_MS = 2 * 60_000;

const ACTION_TEXT: Record<string, string> = {
  close_completed: "closed as completed",
  close_not_planned: "closed as not planned",
  comment: "commented",
  labels: "labelled",
};

export function handledReason(item: IssueListItem): string | null {
  const latest = Date.parse(item.githubUpdatedAt ?? item.snapshot.updatedAt);
  if (!Number.isFinite(latest)) return null;

  const action = item.lastAction?.outcome === "posted" ? item.lastAction : null;
  if (action) {
    const at = Date.parse(action.requestedAt);
    // Someone else commenting after our action shows up here even if GitHub's
    // timestamp lands inside the slack window.
    const answered = item.snapshot.comments.some(
      (c) => c.author !== action.confirmedBy && Date.parse(c.at) > at && !/\[bot\]$/i.test(c.author),
    );
    if (!answered && latest <= at + OUR_UPDATE_SLACK_MS) {
      return `${ACTION_TEXT[action.kind] ?? action.kind} by ${action.confirmedBy}`;
    }
  }

  const mark = item.triage && item.triage.status !== "untriaged" ? item.triage : null;
  if (mark && latest <= Date.parse(mark.updatedAt)) {
    return mark.status === "kept" ? `kept open${mark.by ? ` by ${mark.by}` : ""}` : "snoozed";
  }
  return null;
}
