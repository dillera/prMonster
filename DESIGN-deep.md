# Deep analysis: actionable reviewer briefs (addendum to DESIGN.md)

## Why

"NEEDS_REVIEW, composite 80" tells a maintainer nothing about what to open or what to say. The
motivating case is PR 1650: revision 1 gated a flow-control block behind an `#ifdef`; a
maintainer said no per-platform ifdefs in that file; revision 2 deleted the block outright. The
5 deleted lines were added three days earlier by merged PR 1628 whose stated purpose was
"Adds support for flow control". The author's justification makes factual claims about the
codebase (the block never ran on CoCo boards; the call was redundant because `uart_param_config`
already applies `flow_ctrl`). One holds, one is half true (`uart_set_pin` still passes
`UART_PIN_NO_CHANGE` for RTS/CTS so opting in via config is inert). The PR title and body still
describe revision 1. A useful brief says all of that, with citations, and recommends: ask the
1628 author whether the board has RTS/CTS wired, require the body to be rewritten, and either
plumb the pins now or open a follow-up issue.

Three layers, strictly separated:

1. **Dossier (code, deterministic).** Revisions, what the latest push changed, provenance of
   every deleted line (commit and PR that added it), the review thread with maintainer badges,
   cross-references for symbols in deleted lines, description drift. Every fact exact.
2. **Jev gates (cheap, calibrated).** Four new PR-level questions over the dossier that warn the
   reviewer and suggest a deep pass. They never trigger anything automatically.
3. **Deep analysis (generative model via OpenRouter, tool-using, read-only).** Runs **only when a
   reviewer clicks**. Reads the checkout, verifies the author's claims, and returns a structured
   brief with citations. Labelled as model-generated. Its draft reply flows into the existing
   human-confirmed action panel; nothing else changes about writes.

## Local checkout (`src/server/repo.ts`)

The dossier and the deep-analysis tools both need real git. Maintain a partial clone at
`data/repo/` (git-ignored): `git clone --filter=blob:none --no-checkout <https url> data/repo`
on first use, then `git fetch origin master` and `git fetch origin pull/<n>/head:refs/pr/<n>`
per PR (plus `refs/pr/<n>/prev` kept for the previous head when known). All git access goes
through one module using `execFile("git", [...])` with fixed argv (never a shell), `cwd:
data/repo`, a 60 s timeout, and output caps. Exported helpers, all read-only:

- `ensureRepo()`, `fetchPr(n, headSha)`, `fetchBase(baseRef)`
- `blame(path, rev, startLine, endLine)` → `[{ sha, author, date, summary, line }]` via
  `git blame -L a,b --porcelain <rev> -- <path>`
- `show(rev, path?)` (capped), `logForPath(path, rev, max)`, `logSearch(pickaxe, rev, max)`
  (`git log -S<text> --oneline`), `grep(pattern, rev, pathGlob?, max)` (`git grep -n -I -E
  --max-count`), `listTree(rev, dir)`, `readFile(rev, path, startLine?, endLine?)` via
  `git show rev:path` sliced in code, `diffRange(shaA, shaB)`, `mergeBase(a, b)`.
- Path guard: reject absolute paths, `..`, and anything not returned by `git ls-tree` for that
  rev. Rev guard: `/^[0-9a-f]{7,40}$|^refs\/pr\/\d+(\/prev)?$|^origin\/master$/`.

If `git` is unavailable or the clone fails, the dossier degrades: provenance and cross-refs are
marked `unavailable`, the deep-analysis button is disabled with the reason, everything else
still works.

## Dossier (`src/server/dossier.ts`)

`buildDossier(n): Promise<Dossier>`; cached at `data/dossier/<n>-<headSha>.json`.

```ts
export interface Revision { headSha: string; pushedAt: string; commits: Array<{ sha: string; date: string; author: string; subject: string }>; additions: number; deletions: number; changedFiles: number; }
export interface RevisionDelta { fromSha: string; toSha: string; diff: string; /* git diff fromSha..toSha, capped 60 kB */ filesTouched: string[]; linesAddedNowRemoved: number; linesRemovedNowRestored: number; summary: string; /* template: "revision 2 removed the 5 lines revision 1 had wrapped in #ifdef" style, built from parsed diffs */ }
export interface DeletedLineOrigin { path: string; line: number; text: string; sha: string; author: string; date: string; subject: string; pr: { number: number; title: string; url: string; author: string; mergedAt: string | null; body: string /* capped 2 kB */ } | null; }
export interface ThreadEntry { kind: "issue_comment" | "review_comment" | "review" | "commit"; at: string; author: string; association: string; isMaintainer: boolean; body: string; path?: string; line?: number; state?: string; url: string; }
export interface CrossRef { symbol: string; fromDeletedLine: string; hits: Array<{ path: string; line: number; text: string }>; }
export interface DriftSignal { kind: "body_mentions_absent_token" | "title_mentions_absent_token" | "body_predates_push" | "commit_subject_disagrees_with_title"; detail: string; evidence: string[]; }
export interface Dossier {
  prNumber: number; headSha: string; baseSha: string; builtAt: string;
  revisions: Revision[]; latestDelta: RevisionDelta | null;
  deletedLineOrigins: DeletedLineOrigin[]; originPrs: Array<{ number: number; title: string; author: string; mergedAt: string | null; daysAgo: number; linesDeletedFromIt: number; authorInThread: boolean }>;
  thread: ThreadEntry[]; maintainers: string[];
  crossRefs: CrossRef[]; drift: DriftSignal[];
  availability: { git: boolean; provenance: boolean; crossRefs: boolean; notes: string[] };
}
```

How each part is computed:

- **Revisions.** From the PR's commits (`/pulls/{n}/commits`) grouped by the head SHAs the
  store has seen (evaluation history + snapshot cache). If only the current head is known, one
  revision. `latestDelta` = `git diff <prevHead> <head>` when a previous head exists, parsed with
  the existing `chunk.ts` parser; the summary counts lines that the previous revision added and
  the new one removed, and vice versa, per file.
- **Deleted-line origins.** For every removed line in the *current PR diff* (base..head), blame
  it at the base SHA. Group consecutive lines with the same commit. For each commit, find the
  associated PR: parse `(#NNNN)` from the subject (squash merges), else
  `GET /repos/{o}/{r}/commits/{sha}/pulls`. Fetch that PR's title/body/author/merged_at once.
  Cap at 200 blamed lines per PR (huge deletions: sample first 200 and mark `notes`).
- **Thread.** Issue comments, review comments (with path/line), reviews (state), and commits,
  merged into one time-ordered list. `isMaintainer` = `author_association` in OWNER, MEMBER,
  COLLABORATOR. `maintainers` = distinct such logins.
- **Cross-refs.** From deleted lines, extract identifiers that look like calls or macros:
  `/\b([A-Za-z_]\w{3,})\s*\(/` and `/\b[A-Z][A-Z0-9_]{4,}\b/`, drop C/C++ keywords and anything
  in a small stoplist (`if`, `for`, `return`, `printf`…), keep at most 8 distinct symbols, and
  `git grep -n` each at the base rev excluding the deleted file's own removed lines. Cap 20 hits
  per symbol.
- **Drift.** Tokens in the title and body written in backticks or that look like identifiers or
  paths (`#ifdef`, `COCO_HS_UART`, `lib/x.cpp`) that do not occur anywhere in the current diff
  text produce `*_mentions_absent_token`. If the PR body has not changed (compare with the body
  stored for the previous head) but the head moved, produce `body_predates_push`. If no commit
  subject shares three or more significant words with the title, produce
  `commit_subject_disagrees_with_title` (word overlap in code; no model).

## Jev gates (add to `QUESTIONS`, kind `"pr"`, only asked when a dossier exists)

State for these is a compact dossier view: `latestDelta.summary`, up to 30 lines of
`latestDelta.diff`, `originPrs` (number, title, purpose = first 300 chars of body, daysAgo),
`thread` bodies from maintainers (capped), the author's latest comment (capped 1500 chars),
`drift` details, `pr.title`, `pr.body`.

| id | type | instructions | criteria | weight | polarity |
|---|---|---|---|---|---|
| `revision_removes_behaviour` | choice | "Judging by `latestDelta.summary`, `latestDelta.diff` and `originPrs`, what did the latest revision do to the behaviour that the earlier revision or the base code provided?" | removes: "Deletes behaviour that existed, without replacing it", restricts: "Keeps the behaviour but limits when it applies", relocates: "Moves the behaviour elsewhere or makes it opt-in with an equivalent path", adds: "Only adds behaviour", unchanged: "No behavioural change (comments, formatting, description only)" | 0 (info) | — |
| `body_matches_diff` | noul | "Does `pr.body` describe the change that is actually in the current diff, as summarised by `latestDelta.summary` and `drift`, rather than an earlier version of the change?" | true: "The description matches the current diff", false: "The description describes an approach the current diff no longer takes" | 1.5 | good |
| `maintainer_requested_change` | noul | "Do the maintainer comments in `thread` ask for the change that `latestDelta.summary` describes?" | true: "A maintainer asked for this change or this direction", false: "No maintainer asked for it, or they asked for something different" | 0 (info) | — |
| `author_claims_need_verification` | noul | "Does `author_latest_comment` assert facts about the codebase (what code runs, what a function already does, which boards define a pin) that a reviewer would need to check against the source rather than take on trust?" | true: "Makes checkable claims about code behaviour or configuration", false: "Only describes the change or the testing done" | 0 (info) | — |

`decide.ts`: `body_matches_diff` joins the composite like any weighted Noul. Add reasons (not
blocks): `revision_removed_behaviour` when the choice is `removes` with probability ≥ 0.6;
`description_drift` when `body_matches_diff` ≤ 0.4 or `drift` is non-empty;
`deep_analysis_suggested` when any of: origin PR less than 30 days old with lines deleted,
`author_claims_need_verification` ≥ 0.6, `revision_removes_behaviour` = removes. Explanations
are templated, e.g. "Revision 2 deleted 5 lines that #1628 (wdathing, 3 days ago) added for
'Adds support for flow control'; that author is not in the thread."

## Deep analysis (`src/server/deep.ts`, `src/server/llm.ts`)

### OpenRouter client (`llm.ts`)

`POST https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer $OPENROUTER_API_KEY`,
headers `HTTP-Referer: https://github.com/dillera/prMonster`, `X-Title: prMonster`. Body:
`{ model, messages, tools, tool_choice: "auto", max_tokens, temperature: 0.2, usage: { include: true } }`.
Tool calls arrive as `choices[0].message.tool_calls[] = { id, type: "function", function: { name,
arguments: "<json string>" } }`; reply with `{ role: "tool", tool_call_id, content }` messages.
`usage` carries `prompt_tokens`, `completion_tokens`, and `cost` (USD) when `usage.include` is
set; sum them per run. `GET https://openrouter.ai/api/v1/models` (no key needed) lists models;
keep those whose `supported_parameters` includes `"tools"`, expose `id`, `name`,
`context_length`, and `pricing.prompt`/`pricing.completion` (USD per token as strings; convert to
per-million for display). Retry 429/5xx with backoff, 4 attempts. Timeout per call 120 s.
Behind one interface `LlmBackend { chat(req): Promise<res> }` with a `MockLlmBackend` that plays
a scripted tool sequence and returns a canned brief (used when no key, in tests, and in
fixtures).

Env: `OPENROUTER_API_KEY` (absent → deep analysis runs in mock mode and the UI says so),
`OPENROUTER_MODEL` default `anthropic/claude-haiku-4.5`, `DEEP_MAX_STEPS` default 30,
`DEEP_MAX_COST_USD` default 0.50 per run (abort with a partial brief when exceeded),
`DEEP_DAILY_CAP_USD` default 5 (refuse new runs when the day's sum is above it).

### Tools exposed to the model (all read-only, all through `repo.ts`)

`read_file(path, start_line?, end_line?)` at the PR head; `read_file_at_base(path, start, end)`;
`grep(pattern, path_glob?, max_results?)` at base; `git_log(path?, max?)`; `git_blame(path,
start_line, end_line)` at base; `git_show(sha)` (commit message + stat + diff capped 20 kB);
`pr_diff()` (current, capped 60 kB); `revision_delta()`; `fetch_pr(number)` (title, body,
author, merged_at, file list of another PR in this repo; cached); `list_dir(path)`;
`submit_brief(brief)` which ends the run. Each tool result is capped at 12 kB with a
`[truncated]` marker. Tool schemas are JSON Schema objects in the OpenAI `tools` format.

### Prompt

System prompt (in code, one exported string): role = assistant to a FujiNet firmware
maintainer; the project rules digest already used for Jev; the rules of the brief:

- Every claim about code must cite `path:line` at a named revision, or a PR number, or a
  comment URL. If you cannot cite it, say "unverified".
- Verify every factual claim the author makes in the thread using the tools before judging it.
- Do not speculate about intent; quote what people wrote.
- Prefer the maintainer's stated direction where the thread contains one.
- Recommend exactly one next action from the fixed set and write a reply the maintainer could
  post after editing. The reply must not promise anything on the maintainer's behalf.
- Be brief. The reader is an expert on this codebase.

First user message = the dossier as JSON (capped: thread bodies 2 kB each, diff 40 kB) plus the
latest Evaluation summary (decision, gates failed, top Jev findings with values). Then the loop:
model → tool calls → results → … until `submit_brief` or the step/cost cap.

### Brief schema (`src/shared/types.ts`, additive)

```ts
export type DeepAction = "merge_review_now" | "request_design_discussion" | "request_description_or_tests" | "request_split" | "request_rebase" | "request_follow_up_issue" | "ask_original_author" | "wait_for_ci" | "close_stale";
export interface Citation { kind: "code" | "pr" | "comment" | "commit"; ref: string; /* "lib/x.cpp:84-88@<sha>" | "#1628" | url | sha */ note?: string; }
export interface ClaimVerdict { claim: string; by: string; verdict: "holds" | "does_not_hold" | "partially_holds" | "unverified"; evidence: string; citations: Citation[]; }
export interface RemovedBehaviour { lines: string; /* "lib/x.cpp:84-88" */ originPr: number | null; purpose: string; status: "replaced" | "made_opt_in" | "removed_without_replacement" | "unclear"; citations: Citation[]; }
export interface DeepBrief {
  summary: string; revisionChanges: string[]; removedBehaviour: RemovedBehaviour[]; claims: ClaimVerdict[];
  openQuestions: Array<{ question: string; toWhom: string }>; recommendedAction: DeepAction; rationale: string[];
  draftReply: string; confidence: "low" | "medium" | "high"; caveats: string[];
}
export interface DeepStep { index: number; at: string; kind: "tool" | "assistant" | "system"; name?: string; args?: unknown; resultPreview?: string; }
export interface DeepRun {
  id: string; prNumber: number; headSha: string; evaluationId: string | null; dossierBuiltAt: string;
  model: string; mock: boolean; startedAt: string; finishedAt?: string; status: "running" | "done" | "failed" | "aborted";
  steps: DeepStep[]; brief: DeepBrief | null; usage: { promptTokens: number; completionTokens: number; costUsd: number; calls: number };
  error?: string; requestedBy: string;
}
```

Store runs in `data/deep.json` (last 10 per PR). Persist steps as they happen so a page reload
shows a running job.

### Routes (additive)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/prs/:n/dossier` | `?refresh=1` | `Dossier` (builds and caches; 503 with reason if git unavailable) |
| POST | `/api/prs/:n/deep` | `{ model?: string, requestedBy: string }` | `DeepRun` (202). 409 if a run for this PR is in progress. 402 if the daily cap is reached. Requires `requestedBy` non-empty. **Never triggered by scan or by an update; only by this route.** |
| GET | `/api/prs/:n/deep` | | `{ latest: DeepRun \| null, history: DeepRun[] }` |
| GET | `/api/deep/models` | | `Array<{ id, name, contextLength, promptUsdPerM, completionUsdPerM }>` (cached 1 h), plus `{ default: string, keyPresent: boolean }` |
| GET | `/api/deep/spend` | | `{ todayUsd, capUsd, runsToday }` |
| SSE | `/api/events` | | new events: `deep:start {n, runId, model}`, `deep:step {n, runId, step}`, `deep:done {n, runId, run}`, `deep:error {n, runId, error}` |

The proposal route gains `?fromDeep=<runId>`: when given, the proposal body is the brief's
`draftReply` (sanitised through the existing `sanitize()` for evidence, but the reply itself is
model text and is passed through as markdown) with the same footer and the same confirm gate.

## UI (additive tab and card hints)

- **PR card**: small hints from the gates when present: "revision removed behaviour",
  "description drift", "deep analysis suggested". Grey, not amber; these are hints.
- **New tab "Deep analysis"** in the detail panel, with three stacked sections:
  1. **Dossier** (always available when git is): revisions as a compact timeline (rev 1 at time,
     n commits; rev 2 …) with the latest delta rendered as a diff excerpt and its one-line
     summary; **Deleted lines and where they came from** as a table (path:lines, added by
     commit, in PR #N "title" by author, N days ago, author in thread yes/no); **Thread** with
     maintainer badges and the author's latest comment highlighted; **Cross-references** for
     the deleted symbols; **Drift** warnings with the evidence tokens. Every PR/commit/comment
     is a link to GitHub; every path:line links to the blob at that SHA.
  2. **Run panel**: model picker (from `/api/deep/models`, showing $/M in and out, default
     preselected, remembered in localStorage), estimated cost line ("typically 2 to 8 cents
     with this model"), today's spend vs cap, a required "your name" field, and the **Run deep
     analysis** button. Disabled with the reason when git or the key is unavailable (mock mode
     still runs and is labelled). While running: a live step log from SSE (tool name and
     arguments, result preview), a stop button (aborts server-side: sets status aborted and
     drops the loop), and the running cost.
  3. **Brief**: header with the recommended action as a badge and the confidence; summary;
     "What the latest revision changed"; "Removed behaviour" cards (lines, origin PR, purpose,
     status pill); **Claims** table (claim, by, verdict pill, evidence, citations as links);
     open questions grouped by whom to ask; rationale bullets; caveats; the **draft reply** in
     the same editable markdown box as the action panel with a **Use as proposal** button that
     loads it into the Action panel (the confirm modal then shows it came from deep run id).
     A persistent label: "Generated by <model> from the dossier above. Check the citations; the
     model can be wrong." History dropdown to view earlier runs.
- Fixtures: a full dossier and brief for 1650 modelled on the real case in section "Why", one PR
  with git unavailable, one run in progress with steps.

## Tests

- `repo.ts`: path and rev guards; argv never contains user text unescaped (assert on the
  execFile spy); blame parsing of porcelain output; grep output parsing.
- `dossier.ts`: deleted-line grouping and PR association from `(#1628)` subjects; drift token
  extraction (`#ifdef`, `COCO_HS_UART`, `lib/x.cpp`) against a diff that lacks them; delta
  summary for "rev 1 wrapped 5 lines in #ifdef, rev 2 deleted them"; thread merge order and
  maintainer detection.
- `llm.ts`: OpenAI-format tool-call round trip with a fetch mock; 429 retry; cost accumulation;
  `usage.include` sent.
- `deep.ts`: the loop with `MockLlmBackend` ends on `submit_brief`; step cap aborts with
  `status: aborted` and a partial run; cost cap aborts; tool results capped; a tool call with a
  bad path returns an error string to the model rather than throwing; `submit_brief` with an
  invalid schema is bounced back to the model once, then fails the run.
- Routes: POST deep is 409 while running, 402 over the daily cap, 400 without `requestedBy`;
  scan never starts a deep run (assert no LLM backend calls during `startScan`).

## Non-negotiables

- Deep analysis runs only from the explicit route, only with `requestedBy`, never from scan,
  update, or SSE reconnect.
- The model has read-only tools. No shell. No network beyond OpenRouter and the GitHub reads
  already used elsewhere. Paths and revs are validated before any git call.
- The brief never posts itself. It can only be loaded into the existing proposal flow.
- Every brief is labelled model-generated and shows the model id and cost.
