// Decision trace (DESIGN.md 7.4): the pipeline as a vertical rail, ending in the
// composite build-up and the route. Every number here comes from the stored
// Evaluation; nothing is recomputed in the browser.

import { useState } from "react";
import type { ReactNode } from "react";

import type { Decision, Evaluation, Policy } from "../../shared/types";
import {
  chunkCounts,
  chunkFailed,
  clamp,
  decisionLabel,
  degradations,
  formatNumber,
  isDegradationCode,
  percent,
  pluralise,
} from "../format";
import { QUESTION_BY_ID, gateLabel, questionLabel } from "../questions";
import { CompositeMeter, DecisionBadge, Pill } from "./ui";

export function DecisionTrace({
  evaluation,
  policy,
  decision,
  preview,
}: {
  evaluation: Evaluation;
  policy: Policy;
  /** The decision to display: stored, or a policy preview. */
  decision: Decision;
  preview: boolean;
}) {
  const gates = evaluation.gates;
  const hardFailed = gates.filter((g) => g.severity === "hard" && !g.passed);
  const softFailed = gates.filter((g) => g.severity === "soft" && !g.passed);
  const hardTotal = gates.filter((g) => g.severity === "hard").length;
  const softTotal = gates.filter((g) => g.severity === "soft").length;

  const contributions = decision.contributions;
  const rawComposite = contributions.reduce((sum, c) => sum + c.points, 0);
  const penalty = softFailed.length * policy.softGatePenalty;
  const floored = rawComposite - penalty < 0;

  const prAnswerCount = Object.keys(evaluation.prAnswers).length;
  const chunkAnswerCount = Object.keys(evaluation.aggregated).length;
  const chunks = chunkCounts(evaluation);
  const notices = degradations(decision);

  return (
    <div className={`trace${preview ? " trace--preview" : ""}`}>
      {preview ? (
        <p className="trace__previewnote" role="status">
          Preview against the unsaved policy. The stored decision is shown again when the drawer closes.
        </p>
      ) : null}

      {notices.length > 0 ? (
        <ul className="degraded">
          {notices.map((notice) => (
            <li key={notice.code} className={`degraded__row degraded__row--${notice.code}`}>
              <Pill tone="warn">{notice.pill}</Pill>
              <div className="degraded__body">
                <p className="degraded__title">{notice.title}</p>
                <p className="degraded__detail">{notice.detail}</p>
                {notice.serverText ? <p className="degraded__server mono">{notice.serverText}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="rail">
        <RailNode
          index={1}
          title="Gates"
          summary={
            hardFailed.length > 0
              ? `${hardFailed.length} hard gate${hardFailed.length === 1 ? "" : "s"} failed`
              : `${hardTotal} hard passed, ${softFailed.length} of ${softTotal} soft failed`
          }
          tone={hardFailed.length > 0 ? "bad" : softFailed.length > 0 ? "warn" : "good"}
        >
          <ul className="tracelist">
            {gates
              .filter((g) => g.severity !== "info")
              .map((gate) => (
                <li key={gate.id} className={`tracelist__row tracelist__row--${gate.passed ? "pass" : gate.severity}`}>
                  <span className="tracelist__mark mono" aria-hidden="true">
                    {gate.passed ? "ok" : gate.severity === "hard" ? "!!" : "!"}
                  </span>
                  <span className="tracelist__label">{gateLabel(gate.id)}</span>
                  <code className="tracelist__id mono">{gate.id}</code>
                  <span className="tracelist__detail">{gate.detail}</span>
                </li>
              ))}
          </ul>
          <p className="trace__note">
            Deterministic, pure, and unit tested on the server. Hard failures block regardless of score; each soft
            failure costs {policy.softGatePenalty} points.
          </p>
        </RailNode>

        <RailNode
          index={2}
          title="Chunks"
          summary={
            chunks.failed > 0
              ? `${chunks.evaluated} of ${pluralise(chunks.total, "chunk")} evaluated, ${chunks.failed} failed, coverage ${evaluation.coverage}`
              : `${pluralise(chunks.total, "chunk")}, coverage ${evaluation.coverage}`
          }
          tone={chunks.failed > 0 ? "bad" : evaluation.coverage === "partial" ? "warn" : "good"}
          defaultOpen={chunks.failed > 0}
        >
          <ul className="tracelist">
            {evaluation.chunks.map((chunk) => {
              // chunk.index is the identity here; a split leaves gaps in the sequence,
              // so the array position means nothing.
              const failed = chunkFailed(chunk);
              return (
                <li
                  key={chunk.chunk.index}
                  className={`tracelist__row${failed ? " tracelist__row--hard" : ""}`}
                >
                  <span className="tracelist__mark mono" aria-hidden="true">
                    #{chunk.chunk.index}
                  </span>
                  <span className="tracelist__label mono">
                    {failed ? "not evaluated" : `${formatNumber(chunk.chunk.tokensEstimate)} tok`}
                  </span>
                  <span className="tracelist__detail mono">
                    {failed ? chunk.error : chunk.chunk.files.join(", ")}
                  </span>
                  {failed ? <Pill tone="bad">failed</Pill> : null}
                  {chunk.chunk.truncated ? <Pill tone="warn">truncated</Pill> : null}
                </li>
              );
            })}
          </ul>
          {chunks.failed > 0 ? (
            <p className="trace__note trace__note--warn">
              {pluralise(chunks.failed, "chunk")} failed and {chunks.failed === 1 ? "was" : "were"} excluded from the
              aggregate below. The files in {chunks.failed === 1 ? "it" : "them"} were never read, so their answers are
              unknown rather than clean.
            </p>
          ) : null}
          {evaluation.skippedFiles.length > 0 ? (
            <p className="trace__note">
              {pluralise(evaluation.skippedFiles.length, "file")} were not sent to Jev (budget, binary, or generated),
              so coverage is partial. See the Files tab for which.
            </p>
          ) : null}
        </RailNode>

        <RailNode
          index={3}
          title="Jev, pull request level"
          summary={prAnswerCount === 0 ? "no answers, the call failed" : `${prAnswerCount} answers in one request`}
          tone={prAnswerCount === 0 ? "bad" : "neutral"}
        >
          {prAnswerCount === 0 ? (
            <p className="trace__note trace__note--warn">
              The pull request level request returned nothing, so none of the description or scope questions were
              answered. Everything below rests on the gates and on whatever chunks succeeded.
            </p>
          ) : (
            <ul className="tracelist">
              {Object.entries(evaluation.prAnswers).map(([id, answer]) => (
                <AnswerLine key={id} id={id} answer={answer} />
              ))}
            </ul>
          )}
        </RailNode>

        <RailNode
          index={4}
          title="Jev, chunk level"
          summary={
            chunkAnswerCount === 0
              ? "no aggregated answers"
              : `${chunkAnswerCount} aggregated answers over ${pluralise(chunks.evaluated, "chunk")}${
                  chunks.failed > 0 ? `, ${chunks.failed} failed` : ""
                }`
          }
          tone={chunkAnswerCount === 0 ? "bad" : chunks.failed > 0 ? "warn" : "neutral"}
        >
          {chunkAnswerCount === 0 ? (
            <p className="trace__note trace__note--warn">
              No chunk produced an answer, so there is no code level evidence in this evaluation at all.
            </p>
          ) : null}
          <ul className="tracelist">
            {Object.entries(evaluation.aggregated).map(([id, aggregated]) => (
              <AnswerLine
                key={id}
                id={id}
                answer={aggregated.answer}
                from={aggregated.fromFiles && aggregated.fromFiles.length > 0 ? aggregated.fromFiles[0] : undefined}
              />
            ))}
          </ul>
          <p className="trace__note">
            Bad polarity questions aggregate as the maximum across chunks; code_quality takes the minimum. The file
            shown is the chunk that produced the value.
            {chunks.failed > 0
              ? ` Chunks that failed contribute nothing, so ${chunks.failed === 1 ? "one chunk" : `${chunks.failed} chunks`} worth of code is missing from every value above.`
              : ""}
          </p>
        </RailNode>

        <RailNode
          index={5}
          title="Composite"
          summary={`${decision.composite.toFixed(1)} of 100`}
          tone={decision.composite >= policy.readyThreshold ? "good" : decision.composite < policy.reviewThreshold ? "bad" : "warn"}
          defaultOpen
        >
          <Contributions contributions={contributions} />
          <div className="sums">
            <div className="sums__row">
              <span className="sums__label">Weighted questions</span>
              <span className="sums__value mono">{rawComposite.toFixed(2)}</span>
            </div>
            <div className="sums__row">
              <span className="sums__label">
                Soft gate penalty, {softFailed.length} x {policy.softGatePenalty}
              </span>
              <span className="sums__value mono">{penalty > 0 ? `- ${penalty.toFixed(2)}` : "0.00"}</span>
            </div>
            <div className="sums__row sums__row--total">
              <span className="sums__label">Composite{floored ? ", floored at zero" : ""}</span>
              <span className="sums__value mono">{decision.composite.toFixed(2)}</span>
            </div>
          </div>
        </RailNode>

        <RailNode
          index={6}
          title="Route"
          summary={decisionLabel(decision.kind)}
          tone={decision.kind === "READY" ? "good" : decision.kind === "BLOCKED" ? "bad" : "warn"}
          defaultOpen
        >
          <div className="route">
            <div className="route__meter">
              <CompositeMeter value={decision.composite} policy={policy} kind={decision.kind} size="lg" />
              <div className="route__ticks mono" aria-hidden="true">
                <span style={{ left: `${clamp(policy.reviewThreshold)}%` }}>review {policy.reviewThreshold}</span>
                <span style={{ left: `${clamp(policy.readyThreshold)}%` }}>ready {policy.readyThreshold}</span>
              </div>
            </div>

            <div className="route__badge">
              <DecisionBadge kind={decision.kind} />
            </div>

            <dl className="route__checks">
              <Check
                label="Hard gates"
                ok={hardFailed.length === 0}
                value={hardFailed.length === 0 ? "all pass" : `${hardFailed.length} failed`}
              />
              <Check
                label="Confidence floor"
                ok={decision.minConfidence === null || decision.minConfidence >= policy.confidenceFloor}
                value={`${decision.minConfidence === null ? "n/a" : decision.minConfidence.toFixed(2)} vs ${policy.confidenceFloor}`}
              />
              <Check
                label="Uncertain nouls"
                ok={decision.uncertainNouls.length <= policy.maxUncertainNouls}
                value={`${decision.uncertainNouls.length} vs max ${policy.maxUncertainNouls}`}
              />
              <Check
                label="Composite"
                ok={decision.composite >= policy.readyThreshold}
                value={`${decision.composite.toFixed(1)} vs ready ${policy.readyThreshold}`}
              />
              {/* Without these, every tick can read "ok" while the route is not ready,
                  which makes the panel look like it contradicts itself. */}
              {notices.map((notice) => (
                <Check
                  key={notice.code}
                  label={notice.pill}
                  ok={false}
                  value={
                    notice.code === "diff_unavailable"
                      ? "never ready unread"
                      : notice.code === "jev_unavailable"
                        ? "gates only"
                        : "evidence incomplete"
                  }
                />
              ))}
            </dl>

            {decision.uncertainNouls.length > 0 ? (
              <p className="route__uncertain">
                In the uncertain band:{" "}
                {decision.uncertainNouls.map((id) => (
                  <code key={id} className="mono">
                    {id}
                  </code>
                ))}
              </p>
            ) : null}

            {notices.length > 0 ? (
              <ul className="degraded degraded--route">
                {notices.map((notice) => (
                  <li key={notice.code} className={`degraded__row degraded__row--${notice.code}`}>
                    <Pill tone="warn">{notice.pill}</Pill>
                    <div className="degraded__body">
                      <p className="degraded__title">
                        {notice.title}. This route is less certain than the score suggests.
                      </p>
                      <p className="degraded__detail">{notice.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            {decision.reasons.length > 0 ? (
              <ul className="reasons">
                {decision.reasons.map((reason, i) => (
                  <li
                    key={i}
                    className={`reasons__row reasons__row--${reason.source}${
                      isDegradationCode(reason.code) ? " reasons__row--degraded" : ""
                    }`}
                  >
                    <span className="reasons__source mono">
                      {isDegradationCode(reason.code) ? reason.code : reason.source}
                    </span>
                    <span className="reasons__text">{reason.text}</span>
                    {reason.questionId ? <code className="reasons__id mono">{reason.questionId}</code> : null}
                    {reason.gateId ? <code className="reasons__id mono">{reason.gateId}</code> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="trace__note">No contributing factors recorded. Every check above passed.</p>
            )}

            {decision.explanation.length > 0 ? (
              <div className="explain">
                <h4 className="explain__title">In words</h4>
                <ul className="explain__list">
                  {decision.explanation.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                <p className="explain__foot">
                  Generated in code from the typed answers. Jev is never asked to write prose.
                </p>
              </div>
            ) : null}
          </div>
        </RailNode>
      </ol>
    </div>
  );
}

function Check({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className={`check check--${ok ? "ok" : "no"}`}>
      <dt className="check__label">{label}</dt>
      <dd className="check__value mono">
        <span className="check__mark" aria-hidden="true">
          {ok ? "ok" : "no"}
        </span>
        {value}
      </dd>
    </div>
  );
}

function AnswerLine({ id, answer, from }: { id: string; answer: Evaluation["prAnswers"][string]; from?: string }) {
  const question = QUESTION_BY_ID[id];
  const value =
    answer.type === "noul"
      ? percent(answer.noul)
      : answer.type === "choice"
        ? answer.choice
        : `${answer.score.toFixed(2)} / ${(question?.levels ?? 4) - 1}`;
  const width =
    answer.type === "noul"
      ? answer.noul * 100
      : answer.type === "score"
        ? (answer.score / ((question?.levels ?? 4) - 1)) * 100
        : (answer.probabilities[answer.choice] ?? 0) * 100;

  return (
    <li className="tracelist__row tracelist__row--answer">
      <span className="tracelist__label">{questionLabel(id)}</span>
      <code className="tracelist__id mono">{id}</code>
      <span className="tracelist__bar" aria-hidden="true">
        <span
          className={`tracelist__fill tracelist__fill--${question?.polarity ?? "info"}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="tracelist__value mono">{value}</span>
      {from ? (
        <span className="tracelist__from mono" title={from}>
          {from}
        </span>
      ) : null}
    </li>
  );
}

/** Stacked bar, one segment per weighted question. Hover or click a segment for the maths. */
function Contributions({ contributions }: { contributions: Decision["contributions"] }) {
  const [active, setActive] = useState<string | null>(null);
  const total = contributions.reduce((sum, c) => sum + c.points, 0);
  const sorted = [...contributions].sort((a, b) => b.points - a.points);
  const selected = contributions.find((c) => c.questionId === active) ?? null;

  if (contributions.length === 0) {
    return <p className="trace__note">No weighted answers in this evaluation, so the composite is zero.</p>;
  }

  return (
    <div className="contrib">
      <div className="contrib__stack" role="group" aria-label="Composite contributions by question">
        {contributions.map((c) => {
          const share = total > 0 ? (c.points / total) * 100 : 0;
          const question = QUESTION_BY_ID[c.questionId];
          return (
            <button
              key={c.questionId}
              type="button"
              className={`contrib__seg contrib__seg--${question?.polarity ?? "info"}${
                active === c.questionId ? " contrib__seg--on" : ""
              }`}
              style={{ width: `${share}%` }}
              onMouseEnter={() => setActive(c.questionId)}
              onFocus={() => setActive(c.questionId)}
              onClick={() => setActive((prev) => (prev === c.questionId ? null : c.questionId))}
              title={`${questionLabel(c.questionId)}: weight ${c.weight} x goodness ${c.goodness.toFixed(3)} = ${c.points.toFixed(2)} points`}
              aria-label={`${questionLabel(c.questionId)}, ${c.points.toFixed(2)} points of ${total.toFixed(1)}`}
            />
          );
        })}
      </div>

      <p className="contrib__readout mono" aria-live="polite">
        {selected
          ? `${selected.questionId}: weight ${selected.weight} x goodness ${selected.goodness.toFixed(3)} = ${selected.points.toFixed(2)} points`
          : `${contributions.length} weighted questions, ${total.toFixed(2)} points before penalties`}
      </p>

      <table className="contribtable">
        <thead>
          <tr>
            <th scope="col">Question</th>
            <th scope="col" className="num">
              Weight
            </th>
            <th scope="col" className="num">
              Goodness
            </th>
            <th scope="col" className="num">
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            const question = QUESTION_BY_ID[c.questionId];
            return (
              <tr
                key={c.questionId}
                className={active === c.questionId ? "contribtable__row--on" : undefined}
                onMouseEnter={() => setActive(c.questionId)}
                onMouseLeave={() => setActive(null)}
              >
                <th scope="row">
                  <span className="contribtable__label">{questionLabel(c.questionId)}</span>
                  <code className="mono">{c.questionId}</code>
                  <span className={`polaritydot polaritydot--${question?.polarity ?? "info"}`} aria-hidden="true" />
                </th>
                <td className="num mono">{c.weight}</td>
                <td className="num mono">{c.goodness.toFixed(3)}</td>
                <td className="num mono">{c.points.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RailNode({
  index,
  title,
  summary,
  tone,
  children,
  defaultOpen = false,
}: {
  index: number;
  title: string;
  summary: string;
  tone: "good" | "warn" | "bad" | "neutral";
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className={`rail__node rail__node--${tone}${open ? " rail__node--open" : ""}`}>
      <span className="rail__dot" aria-hidden="true">
        {index}
      </span>
      <button type="button" className="rail__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="rail__title">{title}</span>
        <span className="rail__summary mono">{summary}</span>
        <span className="rail__chev" aria-hidden="true">
          {open ? "-" : "+"}
        </span>
      </button>
      {open ? <div className="rail__body">{children}</div> : null}
    </li>
  );
}
