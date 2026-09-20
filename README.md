# prMonster: FujiNet PR Triage Harness

A local dashboard that reads every open pull request on
[`FujiNetWIFI/fujinet-firmware`](https://github.com/FujiNetWIFI/fujinet-firmware/pulls),
checks it against the rules in the repo's own `CONTRIBUTING.md`, asks
[Jev](https://docs.typesafe.ai) (TypeSafe AI's decision model) a fixed set of
yes/no, pick-one and rate-this questions about the description and the diff,
and sorts the queue into three piles:

| Pile | What it means for you |
|---|---|
| **READY** | Nothing blocks it, it follows the project rules as far as the checks can tell, and Jev is confident. Worth a fast merge review today. |
| **NEEDS REVIEW** | Nothing hard blocks it, but something wants a maintainer's judgement: scope, design, a low-confidence answer, a mid score. Read the listed reasons first. |
| **BLOCKED** | Something the author has to fix before a review is worth your time: draft, merge conflict, red CI, a generated file committed, a `BUILD_*` conditional in a shared device base, or a description that tries to steer automated reviewers. |

It never touches a pull request on its own. See
[Human in the loop](#human-in-the-loop-always).

## Why this is useful to FujiNet maintainers

The firmware queue has a particular shape that makes eyeball triage expensive:

- **CI is build-only.** `autobuild.yml` compiles ten ESP32 targets and runs no
  tests; nothing lints or formats. A green check tells you it compiles, not
  that it follows `CONTRIBUTING.md`.
- **The rules are specific and easy to miss.** No bare `bool` for success, no
  `FUJI_ERROR::UNSPECIFIED` comparisons, wire types instead of bit shifts, no
  `BUILD_*` under `fujiDevice`/`fujiClock`/`NDevice`, no `throw` in firmware,
  no narrating comments, no sdkconfig churn swept into unrelated commits, one
  concern per PR, and "raise the design first" for anything beyond a contained
  fix. Each is checkable, but not at a glance across a 78-file diff.
- **PRs range from one line to 850 KB.** At the time of writing the ten open
  PRs run from a 4-line RS232 fix to a 20,000-line Astrocade bringup with a
  one-sentence description. Deciding *which* one to open first is itself work.

The harness does the mechanical part: it enforces the deterministic rules in
code, sends Jev only the parts of the diff that matter for each question, and
shows you a trace of exactly why each PR landed where it did. You still make
every call. The output is a sorted queue with reasons, plus a drafted comment
you can edit and send, not a bot that comments on its own.

It also costs almost nothing to run: a full scan of the open queue is about
two cents of Jev usage.

## What it asks about each PR

Everything below is stored raw and shown in the dashboard. Deterministic checks
run in code; only judgement calls go to Jev. Jev is never asked to count,
compare numbers, or write prose.

### Deterministic gates (code, no model)

| Gate | Severity | Rule from `CONTRIBUTING.md` |
|---|---|---|
| `not_draft` | hard | Drafts are not reviewable yet. |
| `mergeable` | hard | Merge conflicts block. |
| `ci_green` | hard | Any check-run that failed, timed out or was cancelled. |
| `forbidden_files` | hard | Touches `platformio-generated.ini`, `platformio.ini`, `platformio.common.ini`, `managed_components/`, `.pio/`, `build/`, `firmware/`, `dependencies.lock`, `data/BUILD_*/`. |
| `build_ifdef_in_shared_device` | hard | A `BUILD_*` identifier inside `#if`/`#ifdef`/`#ifndef`/`#elif` under `lib/device/fujiDevice`, `fujiClock` or `NDevice`. |
| `ci_pending` | soft | Checks still queued or running. |
| `sdkconfig_churn` | soft | `sdkconfig.*` or `include/version.h` changed alongside unrelated source. |
| `throw_in_firmware` | soft | `throw` or `try {` added under `lib/` or `src/`. |
| `arduino_string` | soft | Arduino `String` instead of `std::string`. |
| `fuji_error_unspecified` | soft | Comparison against `FUJI_ERROR::UNSPECIFIED`. |
| `htole_bitshift` | soft | `htole*`/`htobe*`/`*toh` instead of the `u16le_t` family. |
| `dead_test_dir` | soft | Adds to the stale `test/` directory instead of `tests/`. |
| `trailing_whitespace` | soft | Added lines with trailing whitespace or tabs. |
| `has_description` | soft | Body shorter than 40 characters. |
| `size_bucket`, `shared_code_touched`, `platform_scope`, `age_days`, `has_unresolved_reviews` | info | Context shown in the trace and passed to Jev as named buckets. |

Each failed gate shows up to five evidence lines (`path:line: text`) so you can
jump straight to it.

### Questions about the PR as a whole (one Jev call)

Jev sees the title, body, the list of changed paths, computed buckets (size,
platforms, CI state, whether shared code is touched), the failed gates, and a
digest of the project's design rules.

| Question | Type | Plain-language meaning |
|---|---|---|
| `single_concern` | yes/no | Is this one bug fix, one feature, or one refactor, rather than several things bundled? |
| `explains_why` | yes/no | Does the description say *why* (problem, symptom, motivation), not just what changed? |
| `states_testing` | yes/no | Does it say how it was verified: hardware, host build, ctest, a manual procedure? |
| `needs_design_discussion` | yes/no | Is this a new abstraction, bus, device, platform, or cross-platform pattern that the rules say should be agreed before code? |
| `reviewer_directed_text` | yes/no | Does the body contain instructions aimed at a reviewer, bot or automated system? **Hard block at 0.7.** |
| `category` | pick one | bugfix, feature, platform_bringup, refactor, build_ci, docs, mixed. |
| `risk` | rate 0–3 | How much could this break platforms other than the one it targets? 0 isolated, 3 touches core bus/memory/boot paths. |
| `description_quality` | rate 0–3 | How well does the body prepare a maintainer to review? |

### Questions about the code (one Jev call per chunk of the diff)

The diff is filtered (no binaries, generated files, lock files, web assets),
ordered so `lib/`, `src/` and `include/` come first, and packed into chunks
under a token budget. Each chunk is sent with a digest of the C++ rules.

| Question | Type | Plain-language meaning |
|---|---|---|
| `duplicates_platform_code` | yes/no | Copies a device or bus into a per-platform directory instead of overriding a virtual in the shared base. The single most common rejection. |
| `bypasses_abstractions` | yes/no | Calls ESP-IDF, GPIO or registers directly from `lib/device/` instead of `IOChannel`, `fnConfig`, `fnFS`, pinmap. |
| `adds_global_state` | yes/no | New global, static singleton, or `extern` not owned by a device or bus object. |
| `narrating_comments` | yes/no | Comments that describe the edit ("added to fix", dates, before/after) instead of the why. |
| `commented_out_code` | yes/no | Disabled statements left in. |
| `bulk_reformat` | yes/no | Mostly whitespace, brace or include-order churn on lines the change did not need to touch. |
| `bare_bool_status` | yes/no | A new function returns `bool` for success/failure instead of `success_is_true`/`error_is_true`. |
| `layer_violation` | yes/no | Protocol in a device, device behaviour in a bus, non-format code in `lib/media/`. |
| `hot_path_logging` | yes/no | Unconditional logging in a `service` loop or ISR. |
| `unchecked_allocation` | yes/no | Allocation used without a null check or leaked on an error path. |
| `code_quality` | rate 0–3 | Against the project rules, how ready is this code to merge? |

Across chunks, a "bad" yes/no takes its **maximum** (any chunk showing the
problem counts) and `code_quality` takes its **minimum**. The dashboard names
the chunk and files that produced each aggregated value so you can check it.

## Using it in a triage session

1. **Scan.** Click *Scan open PRs* (or `npm run scan`). Unchanged PRs are
   skipped, so re-scanning after a few pushes is cheap. Progress streams live
   per stage: fetch, gates, chunk, jev, decide.
2. **Start from the counts.** The stats row gives READY / NEEDS REVIEW /
   BLOCKED. Click a count to filter. Sort by decision, composite or age.
3. **BLOCKED first, briefly.** These need the author, not you. Each card shows
   the blocking gate. The drafted *request changes* review lists the blockers
   as a checklist; edit it and send it if you want the author nudged.
4. **READY next.** Open the *Decision trace*. The contributions bar shows which
   questions carried the score. Skim the *Questions* tab for anything near the
   shaded uncertain band. If it holds up, do the real merge review on GitHub.
5. **NEEDS REVIEW is where your judgement goes.** The card's top reasons say
   what tipped it: `needs_design_discussion` high means read the approach before
   the code; `risk` 2+ means shared bus/memory/boot paths; a low `code_quality`
   points to a specific chunk and file; a confidence below the floor means Jev
   genuinely could not tell, so look yourself.
6. **Read the description yourself when `reviewer_directed_text` fires.** PR
   text is untrusted input; that block exists so the model cannot be talked
   into a verdict.
7. **Tune, don't fight.** If pending CI is dragging every score down, lower the
   soft penalty in the *Policy* drawer. If a gate is noisy for this repo, set
   it to soft or off. The preview re-derives decisions from stored answers
   without calling Jev, so tuning is free.
8. **Track what you did.** *Mark triaged* and *Snooze* are local state. The
   *Audit log* records every send attempt, including refused ones.

### A worked example from the live queue

| PR | Decision | Composite | Why |
|---|---|---|---|
| 1650 `[rs232] limit UART RTS/CTS…` | NEEDS REVIEW | 81 | Everything scored well (one concern 93%, explains why 98%, states testing 97%), but Jev's confidence on `code_quality` was 0.36, below the 0.5 floor. Dropping the floor to 0.3 in the policy preview routes it READY. |
| 1605 `Astrocade bringup` | NEEDS REVIEW | 11 | 78 files, 12 chunks, 33-character body. `needs_design_discussion` 96%, `risk` 2.2 of 3, three soft gates. Read the approach before the code. |
| 1359 `MSX ROM types using ROM DB` | BLOCKED | 34 | Draft with a merge conflict. Nothing to do until the author moves. |

## Human in the loop, always

- The harness **drafts** a comment, a request-changes review, an approve
  review, or labels. You read it, edit it, and confirm by typing `CONFIRM`
  and your name. The modal shows the exact GitHub call before you do.
- The server re-checks the confirmation text, that the proposal matches the
  evaluated head SHA, and that the live PR head has not moved since.
- Nothing is written unless `ALLOW_GITHUB_WRITES=1` is set in `.env`. With it
  off, a confirmed action is recorded as `refused_writes_disabled` in the audit
  log and nothing leaves the machine. That is the default.
- **Merging is never offered.** There is no code path that merges.
- The write functions in `src/server/github.ts` are reachable from exactly one
  route and each re-checks the environment flag themselves.

## Setup

```sh
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173. The API runs on 8787.

| `.env` variable | Meaning |
|---|---|
| `TYPESAFE_API_KEY` | Jev key from https://console.typesafe.ai/keys. Without it the harness runs in **mock mode** with deterministic fake answers and a banner saying so. |
| `GITHUB_TOKEN` | Optional. Falls back to `gh auth token`, then unauthenticated (60 requests/hour, too few for a cold scan). |
| `GITHUB_REPO` | `owner/name`, default `FujiNetWIFI/fujinet-firmware`. |
| `JEV_MODEL` | Default `jev-latest` (currently `jev-1.13.0`). Pin a version if you tune thresholds. |
| `JEV_MOCK` | `1` forces mock answers even with a key. |
| `ALLOW_GITHUB_WRITES` | `1` lets a human-confirmed action actually post. Default off. |
| `PORT` | API port, default 8787. |

## Commands

```sh
npm run dev            # server + web with reload
npm run scan           # evaluate every open PR, print a table
npm run scan -- --force
npm run eval -- 1650   # one PR, full Evaluation JSON on stdout
npm test               # vitest
npm run typecheck
npm run build && npm start   # production: one process serving API + UI
```

## How the number is computed

1. Every weighted answer becomes a goodness in 0..1: `noul` for good yes/no
   questions, `1 - noul` for bad ones, `score / (levels - 1)` for ratings.
2. `composite = 100 × Σ(weight × goodness) / Σ(weight)`, then minus
   `softGatePenalty` per failed soft gate, floored at zero.
3. Any failed hard gate, or `reviewer_directed_text` at or above its hard-block
   threshold, is **BLOCKED**.
4. **READY** needs composite at or above `readyThreshold`, the lowest
   Choice/Score confidence at or above `confidenceFloor`, at most
   `maxUncertainNouls` yes/no answers in the 0.35..0.65 band, and a size bucket
   other than huge.
5. Everything else is **NEEDS REVIEW**, with every contributing factor listed.

All of this lives in `src/server/decide.ts`, is pure, and is unit tested. Raw
answers are stored, so changing `config/policy.json` re-derives every decision
without another Jev call.

## Tuning `config/policy.json`

```json
{
  "readyThreshold": 75,
  "reviewThreshold": 45,
  "confidenceFloor": 0.5,
  "maxUncertainNouls": 2,
  "softGatePenalty": 6,
  "weights": { "single_concern": 2, "code_quality": 2, "...": "one per question" },
  "hardBlocks": { "reviewer_directed_text": 0.7 },
  "gates": { "trailing_whitespace": "off" },
  "jev": { "model": "jev-latest", "maxStateTokens": 14000, "maxChunksPerPr": 12, "concurrency": 2 }
}
```

The *Policy* drawer edits this file and previews the effect on the selected PR
before saving. Set a weight to 0 to keep a question visible but out of the
score. Lower `maxChunksPerPr` to cap spend on huge PRs; coverage then reads
`partial` and the *Files* tab lists what went unread.

## Settings from the UI

Every environment variable the server reads has an entry in
`src/server/settings.ts`, and the *Settings* screen edits them all through
three localhost-only routes:

| Route | What it does |
|---|---|
| `GET /api/admin/settings` | The catalog, each value's state and where it came from (`dotenv`, `env` or `default`). |
| `PUT /api/admin/settings` | `{ updates: { KEY: "value" \| null } }` — validates, rewrites `.env`, applies live. |
| `POST /api/admin/settings/test` | `{ key }` — reaches the service that key configures and reports what came back. |

Four rules the server keeps to:

- **Secrets never leave the process.** A key is reported as its first five
  characters, an ellipsis and its last three (`apike…a42`), or just `(set)` if
  it is shorter than twelve. A PUT that submits exactly that mask back is a
  form round trip, not an edit, and is ignored.
- **Your `.env` is edited, not regenerated.** Every comment, blank line and
  ordering survives: a matching `KEY=` line is rewritten where it stands, a
  commented-out `#KEY=` line is revived in place, anything new is appended, and
  unsetting a key comments it out rather than deleting its documentation. The
  write is tmp-file + rename, and the file is seeded from `.env.example` if it
  does not exist yet.
- **Changes apply to the next request.** `process.env` is updated and the few
  memoised caches (the GitHub token, the cloned repo, the OpenRouter model
  list) are cleared. `PORT`, `DEEP_STORE_PATH`, `DOSSIER_CACHE_DIR` and
  `DOTENV_PATH` are read once at startup, so they are written to `.env` and
  listed in `restartRequired` instead.
- **Only this machine may ask.** Any request whose `Host` is not `localhost`,
  `127.0.0.1` or `[::1]` gets a 403. Each change is logged to stderr and to
  `data/admin-log.json` **by key only** — never a value.

`DOTENV_PATH` points the whole mechanism at another file, which is how the
tests exercise it without touching the real `.env`.

## Cost

Jev bills $0.042 per million input tokens; output is free. Measured on the
live queue: a small PR is one PR call plus one chunk call, under a tenth of a
cent; the 78-file Astrocade PR across 12 chunks is about $0.0065; a forced
scan of all ten open PRs is about $0.02. The header shows cumulative spend.

## Deep analysis

Beyond the score, a maintainer usually wants to know *what to open and what to
say*. Two extra layers answer that, and a **dossier** is built for every PR
automatically:

- **Dossier** (deterministic, no model). Revisions and what the latest push
  changed; the provenance of every deleted line, blamed at the base commit and
  traced to the pull request that added it; the review thread with maintainer
  badges; cross-references for the symbols in the deleted lines; and
  description drift — tokens the title or body names that the current diff does
  not contain. `GET /api/prs/:n/dossier`. It needs a local clone, kept at
  `data/repo/` (blobless, no checkout, cloned on first use). Without git, the
  provenance and cross-reference sections are marked unavailable and everything
  else still works.
- **Deep analysis** (a generative model, read-only, **only when a reviewer
  clicks Run**). The model gets the dossier and a set of read-only tools over
  that clone — `read_file`, `grep`, `git_blame`, `git_log`, `git_show`,
  `pr_diff`, `revision_delta`, `fetch_pr`, `list_dir` — verifies the factual
  claims people made in the thread, and returns a structured brief: what the
  revision changed, what behaviour was removed and where it came from, a verdict
  on each claim with citations, open questions with who to ask, one recommended
  action, and a draft reply.

Nothing about writes changes. The draft reply can only be loaded into the
existing proposal flow (`GET /api/prs/:n/proposal?fromDeep=<runId>`), where it
still needs `ALLOW_GITHUB_WRITES=1`, a typed `CONFIRM`, a name, and a head SHA
that still matches GitHub. **A deep run starts only from
`POST /api/prs/:n/deep` with a `requestedBy` name** — never from a scan, an
evaluation, or an SSE reconnect, and there is a test that asserts it. Every
brief is labelled with the model that produced it and its cost, and says to
check the citations.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Absent: deep analysis runs a scripted mock, labelled as such in the UI. Present: real runs through OpenRouter. |
| `OPENROUTER_MODEL` | `anthropic/claude-haiku-4.5` | Default model; the UI's picker lists every tool-capable model from OpenRouter. |
| `DEEP_MAX_STEPS` | `30` | Tool-calling rounds before the run aborts with a partial brief. |
| `DEEP_MAX_COST_USD` | `0.50` | Per-run ceiling. The loop stops as soon as the reported cost passes it. |
| `DEEP_DAILY_CAP_USD` | `5` | New runs are refused (402) once the day's runs total this much. |
| `DEEP_DOSSIER` | on | Set to `0` to skip dossier building during evaluation. |

Cost is read from OpenRouter's own `usage.cost`, summed per run and per day;
`GET /api/deep/spend` reports today against the cap, and the run panel shows it
before you start. A run is typically a few cents with the default model. Mock
runs cost nothing.

### Caveats specific to deep analysis

- **The model can be wrong.** It is instructed to cite `path:line@sha`, a PR
  number, or a comment URL for every claim about code, and to say "unverified"
  when it cannot. Read the citations, not the prose.
- **It is read-only by construction.** Tools go through one module that
  validates every path and revision before any git call, runs git with fixed
  argv and never a shell, and caps every output. There is no write tool, and no
  network access beyond OpenRouter and the GitHub reads the harness already
  makes.
- **The first dossier is slow.** It clones the repository and, the first time
  anything greps, materialises one tree so `git grep` does not fetch blobs one
  at a time. After that it is cached per head SHA.

## Caveats

- **Jev reads literally.** The question wording in `src/server/jev.ts` was
  written for that. Rewording a question changes its answers; treat the
  catalog like a rubric, not like prose.
- **Answers are calibrated probabilities, not facts.** A 90% on
  `duplicates_platform_code` means the model is confident, not that it is
  right. The trace points at the chunk and files so you can check in seconds.
- **Coverage can be partial.** Huge diffs are capped and truncated; the UI says
  exactly which files were not read. If GitHub refuses to serve a diff at all,
  the evaluation says so and can never route READY.
- **Low confidence is a feature.** A PR held in NEEDS REVIEW by the confidence
  floor is the model saying "I do not know". Look yourself before lowering the
  floor.
- **Not a substitute for building.** Only `make atari-lwm` and friends run the
  tests. The harness tells you where to spend your attention, not whether the
  firmware works.

## Layout

```
src/server/   github.ts gates.ts chunk.ts jev.ts mock.ts decide.ts
              proposals.ts pipeline.ts store.ts events.ts index.ts cli.ts
src/shared/   types.ts            API contract shared by server and web
src/web/      React dashboard (no UI kit, no chart library)
config/       policy.json, rubric/ (snapshot of upstream CONTRIBUTING.md)
data/         evaluations, triage state, audit log, GitHub cache (git-ignored)
tests/        vitest: gates, parser, chunking, decision math, Jev client
DESIGN.md     full specification
```
