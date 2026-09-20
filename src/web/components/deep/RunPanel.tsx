// Run panel of the Deep analysis tab (DESIGN-deep.md, UI 2).
//
// A deep run costs money and calls a generative model, so it happens only when a
// reviewer clicks this button and gives a name. The panel says up front what it will
// cost, what has been spent today, which model will run, and whether the run will be
// real or mock.

import { useEffect, useState } from "react";

import type { DeepModel, DeepRun, DeepStep } from "../../../shared/types";
import type { DeepModelsResponse, DeepSpend } from "../../lib/api";
import { formatNumber, formatUsdPrecise, relativeTime } from "../../format";
import { ErrorNote, Pill, Skeleton, Spinner } from "../ui";

const MODEL_STORAGE_KEY = "prmonster.deep.model";
const NAME_STORAGE_KEY = "prmonster.deep.requestedBy";

/** Remembered model choice. Browser storage can throw, so every access is guarded. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private window or blocked storage: the picker still works for this session */
  }
}

/** Rough cost of a typical run, for the estimate line. */
function estimateRange(model: DeepModel | undefined): string {
  if (!model) return "cost depends on the model";
  // A typical run reads the dossier plus a handful of files: roughly 40k to 120k
  // prompt tokens and 2k to 6k completion tokens.
  const low = (40_000 / 1e6) * model.promptUsdPerM + (2_000 / 1e6) * model.completionUsdPerM;
  const high = (120_000 / 1e6) * model.promptUsdPerM + (6_000 / 1e6) * model.completionUsdPerM;
  return `typically ${formatUsdPrecise(low)} to ${formatUsdPrecise(high)} with this model`;
}

export function RunPanel({
  prNumber,
  models,
  modelsError,
  spend,
  gitAvailable,
  gitReason,
  run,
  liveSteps,
  onRun,
  onStop,
  starting,
  runError,
  history,
  onSelectRun,
  selectedRunId,
}: {
  prNumber: number;
  models: DeepModelsResponse | null;
  modelsError: string | null;
  spend: DeepSpend | null;
  gitAvailable: boolean;
  gitReason: string | null;
  run: DeepRun | null;
  /** Steps streamed since the page loaded, merged with the stored ones. */
  liveSteps: DeepStep[];
  onRun: (model: string, requestedBy: string) => void;
  onStop: () => void;
  starting: boolean;
  runError: string | null;
  history: DeepRun[];
  onSelectRun: (runId: string) => void;
  selectedRunId: string | null;
}) {
  const [model, setModel] = useState<string>("");
  const [name, setName] = useState<string>(() => readStored(NAME_STORAGE_KEY) ?? "");

  useEffect(() => {
    if (!models) return;
    const stored = readStored(MODEL_STORAGE_KEY);
    const known = models.models.some((m) => m.id === stored);
    setModel(known && stored ? stored : (models.default ?? models.models[0]?.id ?? ""));
  }, [models]);

  const chosen = models?.models.find((m) => m.id === model);
  const running = run?.status === "running";
  const overCap = spend !== null && spend.todayUsd >= spend.capUsd;
  const keyMissing = models !== null && !models.keyPresent;

  const blocked = !gitAvailable
    ? (gitReason ?? "git is not available on the server, so the analysis tools cannot read the checkout.")
    : overCap
      ? `Today's spend of ${formatUsdPrecise(spend?.todayUsd ?? 0)} has reached the cap of ${formatUsdPrecise(spend?.capUsd ?? 0)}.`
      : name.trim() === ""
        ? "Enter your name first: every run is attributed to the person who asked for it."
        : model === ""
          ? "Pick a model first."
          : null;

  const steps = mergeSteps(run?.steps ?? [], liveSteps);

  return (
    <section className="runpanel" aria-label="Deep analysis run">
      <header className="runpanel__head">
        <h3 className="runpanel__title">Deep analysis</h3>
        <span className="runpanel__sub">
          Reads the checkout with read only tools and writes a brief. Runs only when you click.
        </span>
        <span className="runpanel__spacer" />
        {history.length > 0 ? (
          <label className="select">
            <span className="select__label">run</span>
            <select
              className="select__input"
              value={selectedRunId ?? ""}
              onChange={(e) => onSelectRun(e.currentTarget.value)}
            >
              {history.map((r) => (
                <option key={r.id} value={r.id}>
                  {/* A run that failed or was stopped still cost money, so the
                      dropdown says how much rather than hiding it. */}
                  {r.status === "done"
                    ? `${relativeTime(r.startedAt)} · ${r.status} · ${r.model}`
                    : `${relativeTime(r.startedAt)} · ${r.status} · ${formatUsdPrecise(r.usage.costUsd)} · ${r.model}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {keyMissing ? (
        <p className="runpanel__mock" role="note">
          No OpenRouter key is configured, so a run here is a mock: it plays a scripted tool sequence and returns a
          canned brief. Everything is labelled mock and costs nothing.
        </p>
      ) : null}

      <div className="runpanel__controls">
        <label className="field runpanel__model">
          <span className="field__label">Model</span>
          {modelsError !== null ? (
            <ErrorNote message={modelsError} />
          ) : models === null ? (
            <Skeleton lines={1} />
          ) : (
            <select
              className="select__input"
              value={model}
              onChange={(e) => {
                setModel(e.currentTarget.value);
                writeStored(MODEL_STORAGE_KEY, e.currentTarget.value);
              }}
              disabled={running}
            >
              {models.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {`${m.name} · in $${m.promptUsdPerM}/M, out $${m.completionUsdPerM}/M`}
                </option>
              ))}
            </select>
          )}
          <span className="field__hint">
            {chosen
              ? `${formatNumber(chosen.contextLength)} token context · ${estimateRange(chosen)}`
              : estimateRange(chosen)}
          </span>
        </label>

        <label className="field runpanel__name">
          <span className="field__label">Your name</span>
          <input
            className="input"
            value={name}
            placeholder="e.g. FozzTexx"
            autoComplete="off"
            disabled={running}
            onChange={(e) => {
              setName(e.currentTarget.value);
              writeStored(NAME_STORAGE_KEY, e.currentTarget.value);
            }}
          />
          <span className="field__hint">Recorded on the run. Required.</span>
        </label>

        <div className="runpanel__spend">
          <span className="field__label">Spend today</span>
          {spend ? (
            <>
              <div className="spendbar" aria-hidden="true">
                <div
                  className={`spendbar__fill${overCap ? " spendbar__fill--over" : ""}`}
                  style={{ width: `${Math.min(100, (spend.todayUsd / Math.max(spend.capUsd, 0.0001)) * 100)}%` }}
                />
              </div>
              <span className="runpanel__spendtext mono">
                {formatUsdPrecise(spend.todayUsd)} of {formatUsdPrecise(spend.capUsd)} · {spend.runsToday} run
                {spend.runsToday === 1 ? "" : "s"}
              </span>
            </>
          ) : (
            <span className="runpanel__spendtext mono">unknown</span>
          )}
        </div>
      </div>

      <div className="runpanel__actions">
        {running ? (
          <>
            <Spinner label={`Running on ${run?.model ?? "the model"}`} />
            <span className="runpanel__cost mono">
              {formatUsdPrecise(run?.usage.costUsd ?? 0)} so far · {run?.usage.calls ?? 0} calls ·{" "}
              {formatNumber((run?.usage.promptTokens ?? 0) + (run?.usage.completionTokens ?? 0))} tokens
            </span>
            <span className="runpanel__spacer" />
            <button type="button" className="btn btn--danger" onClick={onStop}>
              Stop
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--primary"
              disabled={blocked !== null || starting}
              title={blocked ?? undefined}
              onClick={() => onRun(model, name.trim())}
            >
              {starting ? <Spinner label="Starting" /> : `Run deep analysis on #${prNumber}`}
            </button>
            {blocked ? <span className="runpanel__blocked">{blocked}</span> : null}
            {run && run.status !== "running" ? (
              <span className="runpanel__last mono">
                last run {relativeTime(run.startedAt)} by {run.requestedBy} · {run.status} ·{" "}
                {formatUsdPrecise(run.usage.costUsd)}
                {run.mock ? " · mock" : ""}
              </span>
            ) : null}
          </>
        )}
      </div>

      {runError ? <ErrorNote message={runError} /> : null}
      {run?.error && run.status !== "running" ? (
        <p className="runpanel__runerror">
          <Pill tone={run.status === "aborted" ? "warn" : "bad"}>{run.status}</Pill> {run.error}
        </p>
      ) : null}

      {steps.length > 0 ? <StepLog steps={steps} running={running} /> : null}
    </section>
  );
}

/** Stored steps plus anything that arrived over SSE, de-duplicated by index. */
export function mergeSteps(stored: DeepStep[], live: DeepStep[]): DeepStep[] {
  const byIndex = new Map<number, DeepStep>();
  for (const step of stored) byIndex.set(step.index, step);
  for (const step of live) byIndex.set(step.index, step);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function StepLog({ steps, running }: { steps: DeepStep[]; running: boolean }) {
  return (
    <div className="steplog">
      <div className="steplog__head">
        <h4 className="steplog__title">Steps</h4>
        <span className="steplog__count mono">{steps.length}</span>
      </div>
      <ol className="steplog__list" aria-live={running ? "polite" : "off"}>
        {steps.map((step) => (
          <li key={step.index} className={`steplog__row steplog__row--${step.kind}`}>
            <span className="steplog__index mono">{step.index}</span>
            <span className="steplog__name mono">{step.name ?? step.kind}</span>
            <span className="steplog__args mono">{formatArgs(step.args)}</span>
            {step.resultPreview ? <span className="steplog__result">{step.resultPreview}</span> : null}
          </li>
        ))}
        {running ? (
          <li className="steplog__row steplog__row--pending">
            <span className="steplog__index mono">...</span>
            <span className="steplog__name mono">waiting for the model</span>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "()";
  const text = entries
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
