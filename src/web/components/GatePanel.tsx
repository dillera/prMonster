// Gates tab (DESIGN.md 7.4): every gate with severity, outcome, detail and evidence.

import type { Evaluation, GateResult } from "../../shared/types";
import { gateLabel } from "../questions";
import { Pill } from "./ui";

const SEVERITY_ORDER: Record<string, number> = { hard: 0, soft: 1, info: 2, off: 3 };

export function GatePanel({ evaluation }: { evaluation: Evaluation }) {
  const gates = [...evaluation.gates].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 9;
    const sb = SEVERITY_ORDER[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.passed !== b.passed) return a.passed ? 1 : -1;
    return a.id.localeCompare(b.id);
  });

  const failedHard = gates.filter((g) => g.severity === "hard" && !g.passed).length;
  const failedSoft = gates.filter((g) => g.severity === "soft" && !g.passed).length;

  return (
    <div className="gates">
      <p className="gates__summary">
        {failedHard === 0 ? "No hard gate failed." : `${failedHard} hard gate failures block this PR.`}{" "}
        {failedSoft === 0 ? "No soft gate failed." : `${failedSoft} soft failures cost composite points.`} Info gates
        carry values the questions and the route read.
      </p>
      <ul className="gatelist">
        {gates.map((gate) => (
          <GateRow key={gate.id} gate={gate} />
        ))}
      </ul>
    </div>
  );
}

function GateRow({ gate }: { gate: GateResult }) {
  const status = gate.severity === "info" ? "info" : gate.passed ? "pass" : gate.severity;
  const statusText =
    gate.severity === "info" ? "info" : gate.passed ? "passed" : gate.severity === "hard" ? "failed, hard" : "failed, soft";

  return (
    <li className={`gaterow gaterow--${status}`}>
      <div className="gaterow__head">
        <span className="gaterow__status mono">{statusText}</span>
        <span className="gaterow__label">{gateLabel(gate.id)}</span>
        <code className="gaterow__id mono">{gate.id}</code>
        <span className="gaterow__spacer" />
        <Pill tone={gate.severity === "hard" ? "bad" : gate.severity === "soft" ? "warn" : "neutral"}>
          {gate.severity}
        </Pill>
        {gate.value !== undefined ? (
          <Pill tone="accent">
            <span className="mono">{Array.isArray(gate.value) ? gate.value.join(" ") || "none" : String(gate.value)}</span>
          </Pill>
        ) : null}
      </div>
      <p className="gaterow__detail">{gate.detail}</p>
      {gate.evidence && gate.evidence.length > 0 ? (
        <pre className="evidence mono">
          {gate.evidence.map((line, i) => (
            <code key={i} className="evidence__line">
              {line}
            </code>
          ))}
        </pre>
      ) : null}
    </li>
  );
}
