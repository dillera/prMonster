// Policy editor drawer (DESIGN.md 7.5).
//
// Editing never re-runs Jev. Preview posts the trial policy to /api/decide for the
// selected pull request, so the composite and the route come from the server's pure
// decide(); saving writes config/policy.json and re-derives every stored decision.

import { useEffect, useMemo, useState } from "react";

import type { Decision, Policy, PrListItem, Severity } from "../../shared/types";
import { decisionLabel } from "../format";
import { GATE_LABELS, QUESTIONS, gateLabel } from "../questions";
import { CompositeMeter, DecisionBadge, ErrorNote, Pill, Spinner } from "./ui";

const SEVERITIES: Severity[] = ["hard", "soft", "info", "off"];

/**
 * Hard block thresholds are capped below 1.00. At 1.00 the block can never fire,
 * which silently disables the prompt injection guard (DESIGN.md 4.4,
 * reviewer_directed_text) while still reading as "enabled" in the editor.
 */
const HARD_BLOCK_MAX = 0.95;
const HARD_BLOCK_WARN = 0.85;

export function PolicyEditor({
  policy,
  previewItem,
  previewDecision,
  previewing,
  previewError,
  onPreview,
  onDraftChange,
  onSave,
  onClose,
  saving,
  saveError,
}: {
  policy: Policy;
  previewItem: PrListItem | null;
  previewDecision: Decision | null;
  previewing: boolean;
  previewError: string | null;
  onPreview: (draft: Policy) => void;
  onDraftChange: (draft: Policy | null) => void;
  onSave: (draft: Policy) => Promise<void>;
  onClose: () => void;
  saving: boolean;
  saveError: string | null;
}) {
  const [draft, setDraft] = useState<Policy>(() => structuredClone(policy));

  useEffect(() => {
    setDraft(structuredClone(policy));
  }, [policy]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(policy), [draft, policy]);

  // Debounced preview: one request per pause, not one per keystroke.
  useEffect(() => {
    if (!dirty) {
      onDraftChange(null);
      return;
    }
    onDraftChange(draft);
    const timer = window.setTimeout(() => onPreview(draft), 260);
    return () => window.clearTimeout(timer);
    // onPreview and onDraftChange are stable callbacks from App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty]);

  const update = (patch: Partial<Policy>): void => setDraft((prev) => ({ ...prev, ...patch }));
  const setWeight = (id: string, value: number): void =>
    setDraft((prev) => ({ ...prev, weights: { ...prev.weights, [id]: value } }));
  const setGate = (id: string, severity: Severity): void =>
    setDraft((prev) => ({ ...prev, gates: { ...prev.gates, [id]: severity } }));
  const setHardBlock = (id: string, value: number): void =>
    setDraft((prev) => ({ ...prev, hardBlocks: { ...prev.hardBlocks, [id]: value } }));

  const stored = previewItem?.evaluation?.decision ?? null;
  const gateIds = Array.from(
    new Set([...Object.keys(GATE_LABELS), ...Object.keys(draft.gates)]),
  ).filter((id) => !["size_bucket", "platform_scope", "age_days", "shared_code_touched", "has_unresolved_reviews"].includes(id));

  return (
    <aside className="drawer" aria-label="Policy editor">
      <div className="drawer__head">
        <h2 className="drawer__title">Policy</h2>
        <p className="drawer__lede">
          Weights and thresholds only. Changing them re-derives decisions from the stored answers; Jev is never called
          again.
        </p>
        <button type="button" className="drawer__close btn btn--ghost btn--sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="drawer__preview">
        <h3 className="drawer__sectiontitle">Live preview</h3>
        {previewItem ? (
          <>
            <p className="drawer__previewpr mono">
              #{previewItem.snapshot.number} {previewItem.snapshot.title}
            </p>
            {previewError ? (
              <ErrorNote message={previewError} />
            ) : (
              <div className="preview">
                <div className="preview__col">
                  <span className="preview__label">Saved policy</span>
                  {stored ? (
                    <>
                      <DecisionBadge kind={stored.kind} size="sm" />
                      <CompositeMeter value={stored.composite} policy={policy} kind={stored.kind} size="sm" />
                      <span className="preview__value mono">{stored.composite.toFixed(1)}</span>
                    </>
                  ) : (
                    <span className="preview__value mono">not evaluated</span>
                  )}
                </div>
                <span className="preview__arrow" aria-hidden="true">
                  &rarr;
                </span>
                <div className="preview__col">
                  <span className="preview__label">Trial policy</span>
                  {previewing ? (
                    <Spinner label="Deciding" />
                  ) : previewDecision ? (
                    <>
                      <DecisionBadge kind={previewDecision.kind} size="sm" />
                      <CompositeMeter
                        value={previewDecision.composite}
                        policy={draft}
                        kind={previewDecision.kind}
                        size="sm"
                      />
                      <span className="preview__value mono">
                        {previewDecision.composite.toFixed(1)}
                        {stored ? (
                          <span className="preview__delta">
                            {" "}
                            {previewDecision.composite - stored.composite >= 0 ? "+" : ""}
                            {(previewDecision.composite - stored.composite).toFixed(1)}
                          </span>
                        ) : null}
                      </span>
                    </>
                  ) : (
                    <span className="preview__value mono">{dirty ? "waiting" : "unchanged"}</span>
                  )}
                </div>
              </div>
            )}
            {previewDecision && stored && previewDecision.kind !== stored.kind ? (
              <p className="drawer__routechange">
                Route changes from {decisionLabel(stored.kind)} to {decisionLabel(previewDecision.kind)} for this pull
                request.
              </p>
            ) : null}
          </>
        ) : (
          <p className="drawer__previewnone">Select a pull request to preview a policy change against it.</p>
        )}
      </div>

      <div className="drawer__body">
        <section className="drawer__section">
          <h3 className="drawer__sectiontitle">Thresholds</h3>
          <Slider
            label="Ready threshold"
            hint="Composite at or above this, with confidence and certainty satisfied, routes READY."
            min={0}
            max={100}
            step={1}
            value={draft.readyThreshold}
            onChange={(v) => update({ readyThreshold: v })}
          />
          <Slider
            label="Review threshold"
            hint="Below this the decision is NEEDS_REVIEW for low composite alone."
            min={0}
            max={100}
            step={1}
            value={draft.reviewThreshold}
            onChange={(v) => update({ reviewThreshold: v })}
          />
          <Slider
            label="Confidence floor"
            hint="Lowest acceptable Jev confidence across weighted Choice and Score answers."
            min={0}
            max={1}
            step={0.01}
            value={draft.confidenceFloor}
            onChange={(v) => update({ confidenceFloor: v })}
          />
          <Slider
            label="Max uncertain nouls"
            hint="Weighted yes or no answers allowed to sit between 35% and 65%."
            min={0}
            max={10}
            step={1}
            value={draft.maxUncertainNouls}
            onChange={(v) => update({ maxUncertainNouls: v })}
          />
          <Slider
            label="Soft gate penalty"
            hint="Points subtracted per failed soft gate, floored at zero."
            min={0}
            max={25}
            step={1}
            value={draft.softGatePenalty}
            onChange={(v) => update({ softGatePenalty: v })}
          />
          <label className="toggle toggle--row">
            <input
              type="checkbox"
              checked={draft.skipJevWhenBlocked}
              onChange={(e) => update({ skipJevWhenBlocked: e.currentTarget.checked })}
            />
            <span>Skip Jev when a hard gate already blocks</span>
          </label>
        </section>

        <section className="drawer__section">
          <h3 className="drawer__sectiontitle">Weights</h3>
          <p className="drawer__note">
            Weight times goodness gives the points each question puts into the composite. Zero drops a question out of
            the score entirely.
          </p>
          {QUESTIONS.filter((q) => q.polarity !== "info" && q.hardBlockAbove === undefined).map((question) => (
            <Slider
              key={question.id}
              label={question.label}
              id={question.id}
              polarity={question.polarity}
              kind={question.kind}
              min={0}
              max={3}
              step={0.25}
              value={draft.weights[question.id] ?? 0}
              onChange={(v) => setWeight(question.id, v)}
            />
          ))}
        </section>

        <section className="drawer__section">
          <h3 className="drawer__sectiontitle">Hard blocks</h3>
          <p className="drawer__note">
            A question whose probability reaches this value blocks the pull request whatever the composite says. The
            slider stops at {HARD_BLOCK_MAX.toFixed(2)}: a threshold of 1.00 would need total certainty and so would
            turn the block off without saying so.
          </p>
          {Object.entries(draft.hardBlocks).map(([id, value]) => (
            <div key={id} className="hardblock">
              <Slider
                label={id}
                id={id}
                min={0}
                max={HARD_BLOCK_MAX}
                step={0.01}
                value={Math.min(value, HARD_BLOCK_MAX)}
                onChange={(v) => setHardBlock(id, v)}
              />
              {value > HARD_BLOCK_WARN ? (
                <p className="hardblock__warn" role="note">
                  {id === "reviewer_directed_text"
                    ? `At ${value.toFixed(2)} only a near certain match blocks the pull request, so a description that tries to instruct a reviewer or an automated system can slip through. The project treats that as an attack on the triage itself; keep this low.`
                    : `At ${value.toFixed(2)} this block almost never fires. Lower it if you mean it to catch anything.`}
                </p>
              ) : null}
            </div>
          ))}
        </section>

        <section className="drawer__section">
          <h3 className="drawer__sectiontitle">Gate severity</h3>
          <p className="drawer__note">
            Override what a gate costs. Hard blocks outright, soft costs {draft.softGatePenalty} points, info records a
            value, off skips the gate.
          </p>
          <ul className="gateoverrides">
            {gateIds.map((id) => (
              <li key={id} className="gateoverrides__row">
                <span className="gateoverrides__label">{gateLabel(id)}</span>
                <code className="mono">{id}</code>
                <select
                  className="select__input"
                  value={draft.gates[id] ?? "default"}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    if (value === "default") {
                      setDraft((prev) => {
                        const next = { ...prev.gates };
                        delete next[id];
                        return { ...prev, gates: next };
                      });
                    } else {
                      setGate(id, value as Severity);
                    }
                  }}
                  aria-label={`Severity for ${id}`}
                >
                  <option value="default">default</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>

        <section className="drawer__section">
          <h3 className="drawer__sectiontitle">Jev request budget</h3>
          <div className="numgrid">
            <label className="field">
              <span className="field__label">Model</span>
              <input
                className="input mono"
                value={draft.jev.model}
                onChange={(e) => update({ jev: { ...draft.jev, model: e.currentTarget.value } })}
              />
            </label>
            <NumberField
              label="Max state tokens"
              value={draft.jev.maxStateTokens}
              min={1000}
              max={32000}
              step={500}
              onChange={(v) => update({ jev: { ...draft.jev, maxStateTokens: v } })}
            />
            <NumberField
              label="Max chunks per PR"
              value={draft.jev.maxChunksPerPr}
              min={1}
              max={40}
              step={1}
              onChange={(v) => update({ jev: { ...draft.jev, maxChunksPerPr: v } })}
            />
            <NumberField
              label="Concurrency"
              value={draft.jev.concurrency}
              min={1}
              max={8}
              step={1}
              onChange={(v) => update({ jev: { ...draft.jev, concurrency: v } })}
            />
          </div>
          <p className="drawer__note">
            These take effect on the next scan. jev-1.13 allows 32k tokens for state plus the longest question.
          </p>
        </section>
      </div>

      {saveError ? <ErrorNote message={saveError} /> : null}

      <div className="drawer__foot">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!dirty || saving}
          onClick={() => setDraft(structuredClone(policy))}
        >
          Revert
        </button>
        <span className="drawer__dirty">
          {dirty ? <Pill tone="warn">unsaved changes</Pill> : <Pill tone="neutral">saved</Pill>}
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || saving}
          onClick={() => void onSave(draft)}
        >
          {saving ? <Spinner label="Saving" /> : "Save policy"}
        </button>
      </div>
    </aside>
  );
}

function Slider({
  label,
  hint,
  id,
  polarity,
  kind,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  id?: string;
  polarity?: "good" | "bad" | "info";
  kind?: "pr" | "chunk";
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const inputId = `policy-${id ?? label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="slider">
      <div className="slider__head">
        <label className="slider__label" htmlFor={inputId}>
          {label}
        </label>
        {polarity ? (
          <span className={`polaritydot polaritydot--${polarity}`} title={`${polarity} polarity`} aria-hidden="true" />
        ) : null}
        {kind ? <span className="slider__kind mono">{kind}</span> : null}
        {id && id !== label ? <code className="slider__id mono">{id}</code> : null}
        <span className="slider__value mono">{step < 1 ? value.toFixed(2) : value}</span>
      </div>
      <input
        id={inputId}
        className="slider__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      {hint ? <p className="slider__hint">{hint}</p> : null}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="input mono"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </label>
  );
}
