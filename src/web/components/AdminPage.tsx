// Admin view (#/admin): the .env editor.
//
// Every value shown here is what the server reports, and the server is the only
// thing that reads or writes .env. Secrets never arrive in full: a set secret is
// sent as a short mask, which this page shows as a placeholder only. The input
// starts empty, so the only secret text in the DOM is text the reviewer just typed,
// and the reveal toggle can therefore never reveal a stored key.
//
// Saving sends only the fields that changed, and a field cleared with "Clear" is
// sent as null, which unsets the key and lets the built in default take over.
//
// Every save is followed by a server restart (when the server runs under
// scripts/supervise.mjs), so what the page shows is always what a fresh process
// read from .env. On/off settings are switches that save and restart on click.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AdminSettings, SettingDef, SettingTestResult, SettingValue } from "../../shared/types";
import type { HealthInfo } from "../lib/api";
import {
  ApiError,
  getAdminSettings,
  getHealth,
  restartServer,
  saveAdminSettings,
  testAdminSetting,
  waitForRestart,
} from "../lib/api";
import { relativeTime } from "../format";
import { EmptyState, ErrorNote, Pill, Skeleton, Spinner } from "./ui";

const GROUP_ORDER: SettingDef["group"][] = ["github", "jev", "openrouter", "deep", "server"];

const GROUP_LABEL: Record<SettingDef["group"], string> = {
  github: "GitHub",
  jev: "Jev",
  openrouter: "OpenRouter",
  deep: "Deep analysis",
  server: "Server",
};

const GROUP_LEDE: Record<SettingDef["group"], string> = {
  github: "Reading pull requests, and the switch that lets a confirmed action reach GitHub.",
  jev: "The model that answers the per question evaluations during a scan.",
  openrouter: "Credentials for the deep analysis runs.",
  deep: "Defaults and limits for a deep analysis run.",
  server: "How the harness itself starts up and where it keeps its data.",
};

const SOURCE_LABEL: Record<SettingValue["source"], string> = {
  env: "env",
  dotenv: ".env",
  default: "default",
};

const SOURCE_TITLE: Record<SettingValue["source"], string> = {
  env: "Set in the process environment, which wins over .env until the server is restarted without it",
  dotenv: "Set in the .env file on disk",
  default: "Not set anywhere, so the built in default is in use",
};

/**
 * True for the answer the server gives when a key has no test of its own. It
 * reports that as ok with a "no test" detail, so the flag cannot be read off `ok`
 * alone, and such a result is shown as neutral rather than as a pass.
 */
function isNoTest(result: SettingTestResult): boolean {
  return result.detail.trim().toLowerCase().startsWith("no test");
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** "" and null both mean unset, so both compare equal when looking for changes. */
function normalise(value: string | null): string {
  return value === null ? "" : value;
}

/** What on and off mean, for the switches that matter most. Others use their description. */
const SWITCH_COPY: Record<string, { on: string; off: string; danger?: "on" | "off" }> = {
  ALLOW_GITHUB_WRITES: {
    on: "Live: a clicked action posts to GitHub (comments, reviews, labels, closing issues).",
    off: "Dry run: nothing is written to GitHub. Every click is recorded in the audit log as refused.",
    danger: "on",
  },
  JEV_MOCK: {
    on: "Jev is never called. Every evaluation uses deterministic mock answers.",
    off: "Jev is called live whenever a TypeSafe key is set.",
    danger: "on",
  },
  DEEP_DOSSIER: {
    on: "Each pull-request evaluation builds a dossier (git history, thread, drift) and asks the four deep questions.",
    off: "No dossier during evaluation: faster scans, no deep questions.",
  },
};

type ApplyPhase = "saving" | "restarting" | "waiting" | "done" | "blocked" | "error";
interface ApplyState {
  phase: ApplyPhase;
  keys: string[];
  message: string;
  busy?: string[];
}

function isTruthy(value: string | null): boolean {
  const v = normalise(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function AdminPage({
  health,
  onHealth,
}: {
  health: HealthInfo | null;
  onHealth: (next: HealthInfo) => void;
}) {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Queued changes, keyed by setting. null means "unset this key". */
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [apply, setApply] = useState<ApplyState | null>(null);
  const busyApplying = apply !== null && ["saving", "restarting", "waiting"].includes(apply.phase);

  const [tests, setTests] = useState<Record<string, SettingTestResult>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testAllAt, setTestAllAt] = useState<number | null>(null);
  const [testAllDone, setTestAllDone] = useState(false);

  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const load = useCallback((): void => {
    setLoading(true);
    getAdminSettings()
      .then((next) => {
        if (cancelled.current) return;
        setSettings(next);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled.current) return;
        const api = err instanceof ApiError ? err : null;
        setLoadError(
          api && api.status === 404
            ? "This harness does not serve /api/admin/settings yet. Update the server, or run the dashboard with VITE_FIXTURES=1 to see the page with sample data."
            : errorText(err, "Could not load the settings."),
        );
      })
      .finally(() => {
        if (!cancelled.current) setLoading(false);
      });
  }, []);

  useEffect(load, [load]);

  const valueOf = useCallback(
    (key: string): SettingValue | null => settings?.values.find((v) => v.key === key) ?? null,
    [settings],
  );

  /** What the input shows: the queued edit if there is one, else the stored value. */
  const shownValue = useCallback(
    (def: SettingDef): string => {
      const edit = edits[def.key];
      if (edit !== undefined) return normalise(edit);
      if (def.secret) return "";
      return normalise(valueOf(def.key)?.value ?? null);
    },
    [edits, valueOf],
  );

  const isChanged = useCallback(
    (def: SettingDef): boolean => {
      const edit = edits[def.key];
      if (edit === undefined) return false;
      const stored = valueOf(def.key);
      if (def.secret) {
        // The field starts empty, so only typed text or an explicit clear counts.
        if (edit === null) return stored?.set === true;
        return edit.trim() !== "";
      }
      return normalise(edit) !== normalise(stored?.value ?? null);
    },
    [edits, valueOf],
  );

  const changedKeys = useMemo(
    () => (settings ? settings.defs.filter(isChanged).map((d) => d.key) : []),
    [settings, isChanged],
  );
  const dirty = changedKeys.length > 0;

  const setEdit = useCallback((key: string, value: string | null): void => {
    setSaveError(null);
    setEdits((prev) => ({ ...prev, [key]: value }));
  }, []);

  const discard = useCallback((): void => {
    setEdits({});
    setRevealed({});
    setSaveError(null);
  }, []);

  /** Restart, wait for a new process to answer, then re-read what it loaded. */
  const restartAndWait = useCallback(
    async (keys: string[], force: boolean): Promise<void> => {
      const before = Date.now();
      setApply({ phase: "restarting", keys, message: "Restarting the server…" });
      let oldPid: number | undefined;
      try {
        oldPid = (await getHealth()).pid;
        const res = await restartServer({ force, reason: keys.join(", ") });
        oldPid = res.pid;
      } catch (err: unknown) {
        const api = err instanceof ApiError ? err : null;
        if (api?.status === 409 && /^not restarting while/.test(api.message)) {
          setApply({
            phase: "blocked",
            keys,
            message: `Saved to .env, but ${api.message}. Changes that apply live are already in effect; the rest wait for a restart.`,
          });
          return;
        }
        setApply({ phase: "error", keys, message: `Saved to .env, but the restart failed: ${errorText(err, "unknown error")}` });
        return;
      }
      setApply({ phase: "waiting", keys, message: `Waiting for the server to come back (was pid ${oldPid})…` });
      try {
        const next = await waitForRestart(oldPid ?? -1);
        onHealth(next);
        const fresh = await getAdminSettings();
        if (cancelled.current) return;
        setSettings(fresh);
        const secs = ((Date.now() - before) / 1000).toFixed(1);
        const portNote =
          keys.includes("PORT") && window.location.port === "5173"
            ? " PORT changed: the dev UI still proxies to the port Vite started with, so restart npm run dev too."
            : "";
        setApply({
          phase: "done",
          keys,
          message: `Server restarted in ${secs}s (pid ${oldPid} → ${next.pid}). ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} in effect.${portNote}`,
        });
      } catch (err: unknown) {
        if (!cancelled.current) setApply({ phase: "error", keys, message: errorText(err, "The server did not come back.") });
      }
    },
    [onHealth],
  );

  /** Persist to .env, then restart so a fresh process loads it. */
  const applyChanges = useCallback(
    async (updates: Record<string, string | null>): Promise<boolean> => {
      const keys = Object.keys(updates);
      setSaving(true);
      setSaveError(null);
      setApply({ phase: "saving", keys, message: `Saving ${keys.join(", ")} to .env…` });
      let next: AdminSettings;
      try {
        next = await saveAdminSettings(updates);
      } catch (err: unknown) {
        const message = errorText(err, "The settings could not be saved.");
        if (!cancelled.current) {
          setSaveError(message);
          setApply({ phase: "error", keys, message });
          setSaving(false);
        }
        return false;
      }
      if (cancelled.current) return true;
      setSettings(next);
      setSaving(false);
      if (health?.supervised === true) {
        await restartAndWait(keys, false);
      } else {
        const pending = next.restartRequired.filter((k) => keys.includes(k));
        setApply({
          phase: "done",
          keys,
          message:
            `Saved to .env and applied to the running server.` +
            (pending.length > 0
              ? ` ${pending.join(", ")} need a restart, and this server was not started with npm run dev or npm start, so restart it by hand.`
              : ""),
        });
      }
      return true;
    },
    [health?.supervised, restartAndWait],
  );

  const onSave = useCallback((): void => {
    if (!settings || !dirty) return;
    const updates: Record<string, string | null> = {};
    for (const key of changedKeys) {
      const edit = edits[key];
      updates[key] = edit === undefined || edit === "" ? null : edit;
    }
    void applyChanges(updates).then((ok) => {
      if (ok && !cancelled.current) {
        setEdits({});
        setRevealed({});
      }
    });
  }, [settings, dirty, changedKeys, edits, applyChanges]);

  /** A switch saves and restarts on its own; other queued edits stay queued. */
  const onSwitch = useCallback(
    (key: string, on: boolean): void => {
      void applyChanges({ [key]: on ? "1" : "0" });
    },
    [applyChanges],
  );

  const runTest = useCallback(async (key: string): Promise<SettingTestResult | null> => {
    setTesting((prev) => ({ ...prev, [key]: true }));
    try {
      const result = await testAdminSetting(key);
      if (!cancelled.current) setTests((prev) => ({ ...prev, [key]: result }));
      return result;
    } catch (err: unknown) {
      const failed: SettingTestResult = {
        key,
        ok: false,
        detail: errorText(err, "The test could not be run."),
        checkedAt: new Date().toISOString(),
      };
      if (!cancelled.current) setTests((prev) => ({ ...prev, [key]: failed }));
      return failed;
    } finally {
      if (!cancelled.current) setTesting((prev) => ({ ...prev, [key]: false }));
    }
  }, []);

  const onTestAll = useCallback((): void => {
    if (!settings || testAllAt !== null) return;
    const keys = settings.defs.map((d) => d.key);
    setTests({});
    setTestAllDone(false);
    setTestAllAt(0);
    void (async () => {
      // One at a time, so a slow check never fires a dozen requests at once.
      for (let i = 0; i < keys.length; i += 1) {
        if (cancelled.current) return;
        setTestAllAt(i);
        await runTest(keys[i] as string);
      }
      if (cancelled.current) return;
      setTestAllAt(null);
      setTestAllDone(true);
    })();
  }, [settings, testAllAt, runTest]);

  const summary = useMemo(() => {
    const results = Object.values(tests);
    const skipped = results.filter((r) => isNoTest(r)).length;
    const passed = results.filter((r) => r.ok && !isNoTest(r)).length;
    return { total: results.length, passed, failed: results.length - passed - skipped, skipped };
  }, [tests]);

  // ------------------------------------------------------------ render
  if (loading && !settings) {
    return (
      <section className="admin" aria-label="Settings">
        <Skeleton lines={6} />
      </section>
    );
  }

  if (loadError && !settings) {
    return (
      <section className="admin" aria-label="Settings">
        <h2 className="admin__title">Settings</h2>
        <ErrorNote message={loadError} onRetry={load} />
      </section>
    );
  }

  if (!settings) {
    return (
      <section className="admin" aria-label="Settings">
        <EmptyState title="No settings" detail="The server returned no setting definitions." />
      </section>
    );
  }

  // Known groups in a deliberate order, then anything the server adds later, so a
  // new group is shown rather than silently dropped.
  const present = [...new Set(settings.defs.filter((d) => d.type !== "boolean").map((d) => d.group))];
  const groups = [
    ...GROUP_ORDER.filter((g) => present.includes(g)),
    ...present.filter((g) => !GROUP_ORDER.includes(g)),
  ];
  const testAllKey = testAllAt !== null ? settings.defs[testAllAt]?.key : null;

  return (
    <section className="admin" aria-label="Settings">
      <div className="admin__head">
        <div>
          <h2 className="admin__title">Settings</h2>
          <p className="admin__lede">
            These write the harness .env file, then restart the server so every value is freshly loaded. Switches
            take effect on click. Secrets are shown only as a mask: type a new value to replace one, or use Clear to
            remove it.
          </p>
        </div>
        <div className="admin__headactions">
          <button type="button" className="btn btn--sm" onClick={onTestAll} disabled={testAllAt !== null}>
            {testAllAt !== null ? <Spinner label={`Testing ${testAllKey ?? ""}`} /> : "Test all"}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={load} disabled={loading}>
            Reload
          </button>
        </div>
      </div>

      <div className="admin__env">
        <span className="admin__envpath mono" title={settings.dotenvPath}>
          {settings.dotenvPath}
        </span>
        {settings.dotenvWritable ? (
          <Pill tone="neutral">writable</Pill>
        ) : (
          <Pill tone="warn" title="The server cannot write this file, so saving will fail">
            not writable
          </Pill>
        )}
      </div>

      {!settings.dotenvWritable ? (
        <p className="admin__warn" role="note">
          The server cannot write {settings.dotenvPath}. Fix the file permissions, or edit the file by hand, before
          saving here.
        </p>
      ) : null}

      {apply ? <ApplyBanner state={apply} onForce={() => void restartAndWait(apply.keys, true)} onDismiss={() => setApply(null)} /> : null}

      {settings.restartRequired.length > 0 && !busyApplying ? (
        <p className="admin__warn" role="note">
          Saved but not yet in effect: <span className="mono">{settings.restartRequired.join(", ")}</span>.{" "}
          {health?.supervised ? (
            <button type="button" className="btn btn--sm" onClick={() => void restartAndWait(settings.restartRequired, false)}>
              Restart now
            </button>
          ) : (
            "Restart the server by hand."
          )}
        </p>
      ) : null}

      {health && health.supervised !== true ? (
        <p className="admin__warn" role="note">
          This server was not started with <code className="mono">npm run dev</code> or{" "}
          <code className="mono">npm start</code>, so it cannot restart itself. Changes are saved and applied live
          where possible.
        </p>
      ) : null}

      <Switches
        defs={settings.defs.filter((d) => d.type === "boolean")}
        valueOf={valueOf}
        disabled={busyApplying || !settings.dotenvWritable}
        onSwitch={onSwitch}
      />

      {testAllDone && summary.total > 0 ? (
        <p className="admin__summary" role="status">
          {summary.total} checked, {summary.passed} passed, {summary.failed} failed, {summary.skipped} with no test.
        </p>
      ) : null}

      {loadError ? <ErrorNote message={loadError} onRetry={load} /> : null}

      {groups.map((group) => (
        <div className="admin__group" key={group}>
          <h3 className="admin__grouptitle">{GROUP_LABEL[group] ?? group}</h3>
          {GROUP_LEDE[group] ? <p className="admin__grouplede">{GROUP_LEDE[group]}</p> : null}
          <div className="admin__cards">
            {settings.defs
              .filter((def) => def.group === group && def.type !== "boolean")
              .map((def) => (
                <SettingCard
                  key={def.key}
                  def={def}
                  value={valueOf(def.key)}
                  shown={shownValue(def)}
                  cleared={edits[def.key] === null}
                  changed={isChanged(def)}
                  revealed={revealed[def.key] === true}
                  onReveal={(on) => setRevealed((prev) => ({ ...prev, [def.key]: on }))}
                  onChange={(next) => setEdit(def.key, next)}
                  onClear={() => setEdit(def.key, null)}
                  onTest={() => void runTest(def.key)}
                  testing={testing[def.key] === true}
                  result={tests[def.key] ?? null}
                />
              ))}
          </div>
        </div>
      ))}

      <div className="adminfoot">
        <span className="adminfoot__state">
          {dirty ? `${changedKeys.length} unsaved ${changedKeys.length === 1 ? "change" : "changes"}` : "No changes"}
        </span>
        {saveError ? (
          <span className="adminfoot__error" role="alert">
            {saveError}
          </span>
        ) : null}
        <div className="adminfoot__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={discard} disabled={!dirty || saving}>
            Discard
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onSave}
            disabled={!dirty || saving || busyApplying || !settings.dotenvWritable}
          >
            {saving ? <Spinner label="Saving" /> : health?.supervised ? "Save & restart" : "Save changes"}
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- one setting
function SettingCard({
  def,
  value,
  shown,
  cleared,
  changed,
  revealed,
  onReveal,
  onChange,
  onClear,
  onTest,
  testing,
  result,
}: {
  def: SettingDef;
  value: SettingValue | null;
  shown: string;
  cleared: boolean;
  changed: boolean;
  revealed: boolean;
  onReveal: (on: boolean) => void;
  onChange: (next: string) => void;
  onClear: () => void;
  onTest: () => void;
  testing: boolean;
  result: SettingTestResult | null;
}) {
  const id = `setting-${def.key}`;
  const hintId = `${id}-hint`;
  const source = value?.source ?? "default";
  const set = value?.set === true;

  const placeholder = def.secret
    ? set
      ? `${value?.value ?? "set"} (set)`
      : "not set"
    : def.default !== null
      ? `default ${def.default}`
      : "not set";

  return (
    <div className={`setting${changed ? " setting--changed" : ""}`}>
      <div className="setting__head">
        <label className="setting__label" htmlFor={id}>
          {def.label}
        </label>
        <div className="setting__pills">
          {changed ? <Pill tone="accent">edited</Pill> : null}
          {def.requiresRestart ? <Pill tone="neutral" title="Takes effect after a restart">restart</Pill> : null}
          <Pill tone={source === "env" ? "accent" : "neutral"} title={SOURCE_TITLE[source]}>
            {SOURCE_LABEL[source]}
          </Pill>
        </div>
      </div>

      <code className="setting__key mono">{def.key}</code>
      <p className="setting__desc" id={hintId}>
        {def.description}
      </p>

      <div className="setting__control">
        {def.type === "boolean" ? (
          <label className="toggle toggle--row" htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              aria-describedby={hintId}
              checked={isTruthy(shown === "" ? (value?.effective ?? null) : shown)}
              onChange={(e) => onChange(e.currentTarget.checked ? "1" : "0")}
            />
            <span>{isTruthy(shown === "" ? (value?.effective ?? null) : shown) ? "on" : "off"}</span>
          </label>
        ) : def.type === "enum" ? (
          <select
            id={id}
            className="select__input setting__input"
            aria-describedby={hintId}
            value={shown}
            onChange={(e) => onChange(e.currentTarget.value)}
          >
            <option value="">{def.default !== null ? `default (${def.default})` : "not set"}</option>
            {(def.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <div className="setting__inputrow">
            <input
              id={id}
              className="input setting__input"
              aria-describedby={hintId}
              type={def.type === "number" ? "number" : def.secret && !revealed ? "password" : "text"}
              inputMode={def.type === "number" ? "numeric" : undefined}
              autoComplete={def.secret ? "off" : undefined}
              spellCheck={false}
              placeholder={placeholder}
              value={shown}
              onChange={(e) => onChange(e.currentTarget.value)}
            />
            {def.secret ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onReveal(!revealed)}
                aria-pressed={revealed}
                aria-label={revealed ? `Hide the typed ${def.label}` : `Reveal the typed ${def.label}`}
                title="Shows only what you have typed. A stored secret is never sent to this page."
              >
                {revealed ? "Hide" : "Reveal"}
              </button>
            ) : null}
          </div>
        )}

        <div className="setting__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onTest} disabled={testing}>
            {testing ? <Spinner label="Testing" /> : "Test"}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClear} disabled={!set && !changed}>
            Clear
          </button>
        </div>
      </div>

      {cleared ? (
        <p className="setting__note">
          Queued to be unset.{" "}
          {def.default !== null ? (
            <>
              The default <span className="mono">{def.default}</span> will be used.
            </>
          ) : (
            "There is no default, so the harness will run without it."
          )}
        </p>
      ) : null}

      {def.secret && changed && !cleared ? (
        <p className="setting__note">The typed value replaces the stored secret when you save.</p>
      ) : null}

      {result ? (
        <div className="setting__result">
          <Pill tone={isNoTest(result) ? "neutral" : result.ok ? "good" : "bad"}>
            {isNoTest(result) ? "no test" : result.ok ? "ok" : "failed"}
          </Pill>
          <span className="setting__resultdetail">{result.detail}</span>
          <span className="setting__resulttime mono" title={result.checkedAt}>
            {relativeTime(result.checkedAt)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- switches
function Switches({
  defs,
  valueOf,
  disabled,
  onSwitch,
}: {
  defs: SettingDef[];
  valueOf: (key: string) => SettingValue | null;
  disabled: boolean;
  onSwitch: (key: string, on: boolean) => void;
}) {
  if (defs.length === 0) return null;
  return (
    <div className="admin__group">
      <h3 className="admin__grouptitle">Switches</h3>
      <p className="admin__grouplede">Each switch saves to .env and restarts the server as soon as you click it.</p>
      <div className="switches">
        {defs.map((def) => {
          const value = valueOf(def.key);
          const on = isTruthy(value?.effective ?? def.default);
          const copy = SWITCH_COPY[def.key];
          const alarming = copy?.danger !== undefined && (copy.danger === "on") === on;
          return (
            <div key={def.key} className={`switchrow${alarming ? " switchrow--alarm" : ""}`}>
              <div className="switchrow__text">
                <div className="switchrow__head">
                  <span className="switchrow__label">{def.label}</span>
                  <code className="mono switchrow__key">{def.key}</code>
                  {value?.source === "env" ? (
                    <Pill tone="warn" title={SOURCE_TITLE.env}>
                      set in the shell environment
                    </Pill>
                  ) : null}
                </div>
                <p className="switchrow__desc">{copy ? (on ? copy.on : copy.off) : def.description}</p>
              </div>
              <div className="segmented" role="radiogroup" aria-label={def.label}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!on}
                  className={`segmented__opt${!on ? " segmented__opt--on segmented__opt--off" : ""}`}
                  disabled={disabled || !on}
                  onClick={() => onSwitch(def.key, false)}
                >
                  Disabled
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`segmented__opt${on ? ` segmented__opt--on${alarming ? " segmented__opt--alarm" : " segmented__opt--enabled"}` : ""}`}
                  disabled={disabled || on}
                  onClick={() => onSwitch(def.key, true)}
                >
                  Enabled
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- apply feedback
const PHASE_STEPS: ApplyPhase[] = ["saving", "restarting", "waiting", "done"];
const PHASE_LABEL: Record<ApplyPhase, string> = {
  saving: "Saving",
  restarting: "Restarting",
  waiting: "Coming back up",
  done: "Done",
  blocked: "Restart postponed",
  error: "Failed",
};

function ApplyBanner({ state, onForce, onDismiss }: { state: ApplyState; onForce: () => void; onDismiss: () => void }) {
  const running = state.phase === "saving" || state.phase === "restarting" || state.phase === "waiting";
  const at = PHASE_STEPS.indexOf(state.phase);
  return (
    <div className={`applybanner applybanner--${state.phase}`} role="status" aria-live="polite">
      <div className="applybanner__head">
        {running ? <Spinner /> : null}
        <strong>{PHASE_LABEL[state.phase]}</strong>
        <ol className="applybanner__steps" aria-hidden="true">
          {PHASE_STEPS.map((p, i) => (
            <li key={p} className={at >= i || state.phase === "done" ? "applybanner__step--on" : ""}>
              {PHASE_LABEL[p]}
            </li>
          ))}
        </ol>
        {!running ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
      <p className="applybanner__msg">{state.message}</p>
      {state.phase === "blocked" ? (
        <button type="button" className="btn btn--sm" onClick={onForce}>
          Restart anyway (stops the running work)
        </button>
      ) : null}
    </div>
  );
}
