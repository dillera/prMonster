// Jev answers (DESIGN.md 7.4, Questions tab).
//
// Noul  -> 0 to 100% bar with the 35 to 65% uncertain band shaded.
// Choice-> one bar per option, winner emphasised, confidence shown.
// Score -> one bar per level with its legend, diamond marker at the weighted score.

import { useState } from "react";
import type { ReactNode } from "react";

import type {
  ChoiceAnswer,
  ChunkResult,
  Evaluation,
  JevAnswer,
  NoulAnswer,
  ScoreAnswer,
} from "../../shared/types";
import { chunkCounts, chunkFailed, percent } from "../format";
import type { UiQuestion } from "../questions";
import { CHUNK_QUESTIONS, PR_QUESTIONS, QUESTION_BY_ID, UNCERTAIN_HIGH, UNCERTAIN_LOW, isUncertainNoul } from "../questions";
import { Pill } from "./ui";

// ---------------------------------------------------------------- noul
export function NoulBar({ question, answer }: { question: UiQuestion; answer: NoulAnswer }) {
  const value = answer.noul;
  const uncertain = isUncertainNoul(value);
  const good = question.polarity === "good" ? value : 1 - value;
  const tone = question.polarity === "info" ? "info" : good >= 0.65 ? "good" : good <= 0.35 ? "bad" : "mid";

  return (
    <div className={`qbar qbar--noul qbar--${tone}`}>
      <div className="qbar__track" role="img" aria-label={`${question.label}: ${percent(value)} yes`}>
        <span
          className="qbar__band"
          style={{ left: `${UNCERTAIN_LOW * 100}%`, width: `${(UNCERTAIN_HIGH - UNCERTAIN_LOW) * 100}%` }}
          title="Uncertain band, 35% to 65%"
          aria-hidden="true"
        />
        <span className="qbar__fill" style={{ width: `${value * 100}%` }} aria-hidden="true" />
        <span className="qbar__needle" style={{ left: `${value * 100}%` }} aria-hidden="true" />
      </div>
      <div className="qbar__scale mono" aria-hidden="true">
        <span>no</span>
        <span className="qbar__scalemid">uncertain</span>
        <span>yes</span>
      </div>
      <div className="qbar__readout">
        <span className="qbar__value mono">{percent(value)}</span>
        {uncertain ? <Pill tone="warn">uncertain</Pill> : null}
        {question.hardBlockAbove !== undefined ? (
          <Pill tone={value >= question.hardBlockAbove ? "bad" : "neutral"}>
            hard block above {percent(question.hardBlockAbove)}
          </Pill>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- choice
export function ChoiceBars({ question, answer }: { question: UiQuestion; answer: ChoiceAnswer }) {
  const options = question.options ?? Object.keys(answer.probabilities);
  const entries = options
    .map((option) => ({ option, p: answer.probabilities[option] ?? 0 }))
    .sort((a, b) => b.p - a.p);

  return (
    <div className="qbar qbar--choice">
      <ul className="choicelist">
        {entries.map(({ option, p }) => {
          const won = option === answer.choice;
          return (
            <li key={option} className={`choicelist__row${won ? " choicelist__row--won" : ""}`}>
              <span className="choicelist__label mono">{option}</span>
              <span className="choicelist__track" aria-hidden="true">
                <span className="choicelist__fill" style={{ width: `${p * 100}%` }} />
              </span>
              <span className="choicelist__value mono">{percent(p, 1)}</span>
            </li>
          );
        })}
      </ul>
      <div className="qbar__readout">
        <span className="qbar__value mono">{answer.choice}</span>
        <Pill tone={answer.confidence >= 0.7 ? "good" : answer.confidence >= 0.5 ? "warn" : "bad"}>
          confidence {answer.confidence.toFixed(2)}
        </Pill>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- score
export function ScoreBars({ question, answer }: { question: UiQuestion; answer: ScoreAnswer }) {
  const legend = question.legend ?? answer.legend;
  const levels = Object.keys(legend).sort((a, b) => Number(a) - Number(b));
  const max = levels.length - 1;
  const markerPct = max > 0 ? (answer.score / max) * 100 : 0;

  return (
    <div className="qbar qbar--score">
      <ul className="levellist">
        {levels.map((level) => {
          const p = answer.probabilities[level] ?? 0;
          const isNearest = Math.round(answer.score) === Number(level);
          return (
            <li key={level} className={`levellist__row${isNearest ? " levellist__row--near" : ""}`}>
              <span className="levellist__index mono">{level}</span>
              <span className="levellist__track" aria-hidden="true">
                <span className="levellist__fill" style={{ width: `${p * 100}%` }} />
              </span>
              <span className="levellist__value mono">{percent(p, 1)}</span>
              <span className="levellist__legend">{legend[level]}</span>
            </li>
          );
        })}
      </ul>
      <div className="scoreaxis" aria-hidden="true">
        <span className="scoreaxis__track" />
        <span className="scoreaxis__marker" style={{ left: `${markerPct}%` }} />
      </div>
      <div className="qbar__readout">
        <span className="qbar__value mono">
          {answer.score.toFixed(2)} / {max}
        </span>
        <Pill tone={question.polarity === "good" ? "good" : "bad"}>
          {question.polarity === "good" ? "higher is better" : "higher is worse"}
        </Pill>
        <Pill tone={answer.confidence >= 0.7 ? "good" : answer.confidence >= 0.5 ? "warn" : "bad"}>
          confidence {answer.confidence.toFixed(2)}
        </Pill>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dispatcher
export function AnswerView({ question, answer }: { question: UiQuestion; answer: JevAnswer }) {
  if (answer.type === "noul") return <NoulBar question={question} answer={answer} />;
  if (answer.type === "choice") return <ChoiceBars question={question} answer={answer} />;
  return <ScoreBars question={question} answer={answer} />;
}

function QuestionRow({
  question,
  answer,
  children,
}: {
  question: UiQuestion;
  answer: JevAnswer;
  children?: ReactNode;
}) {
  return (
    <li className="qrow">
      <div className="qrow__head">
        <h4 className="qrow__label">{question.label}</h4>
        <code className="qrow__id mono">{question.id}</code>
        <span className="qrow__spacer" />
        {question.weight > 0 ? (
          <Pill tone="neutral" title="Default weight from the question catalog">
            weight {question.weight}
          </Pill>
        ) : (
          <Pill tone="neutral">{question.hardBlockAbove !== undefined ? "gate only" : "info only"}</Pill>
        )}
        <Pill tone={question.polarity === "good" ? "good" : question.polarity === "bad" ? "bad" : "neutral"}>
          {question.polarity}
        </Pill>
      </div>
      <p className="qrow__meaning">{question.meaning}</p>
      <AnswerView question={question} answer={answer} />
      {children}
    </li>
  );
}

// ---------------------------------------------------------------- tab
export function QuestionsTab({ evaluation }: { evaluation: Evaluation }) {
  const counts = chunkCounts(evaluation);
  const prAnswered = Object.keys(evaluation.prAnswers).length > 0;

  return (
    <div className="questions">
      <section className="questions__section">
        <h3 className="questions__heading">
          Pull request level
          <span className="questions__sub mono">one Jev request over title, body, paths, gates</span>
        </h3>
        {prAnswered ? null : (
          <p className="questions__degraded" role="note">
            Jev never answered the pull request level questions for this evaluation, so there is nothing to show here.
            The route was decided on the deterministic gates alone.
          </p>
        )}
        <ul className="qlist">
          {PR_QUESTIONS.map((question) => {
            const answer = evaluation.prAnswers[question.id];
            if (!answer) return <MissingRow key={question.id} question={question} />;
            return <QuestionRow key={question.id} question={question} answer={answer} />;
          })}
        </ul>
      </section>

      <section className="questions__section">
        <h3 className="questions__heading">
          Chunk level
          <span className="questions__sub mono">
            aggregated over {counts.evaluated} of {counts.total} chunk{counts.total === 1 ? "" : "s"}: worst value wins
          </span>
        </h3>
        {counts.failed > 0 ? (
          <p className="questions__degraded" role="note">
            {counts.failed} chunk{counts.failed === 1 ? "" : "s"} failed and {counts.failed === 1 ? "was" : "were"} left
            out of these aggregates. A problem could sit in the code that was never read; expand a question to see which
            chunks are missing.
          </p>
        ) : null}
        <ul className="qlist">
          {CHUNK_QUESTIONS.map((question) => {
            const aggregated = evaluation.aggregated[question.id];
            if (!aggregated) return <MissingRow key={question.id} question={question} />;
            return (
              <QuestionRow key={question.id} question={question} answer={aggregated.answer}>
                <ChunkDrill
                  questionId={question.id}
                  question={question}
                  chunks={evaluation.chunks}
                  fromChunk={aggregated.fromChunk}
                  fromFiles={aggregated.fromFiles}
                />
              </QuestionRow>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function MissingRow({ question }: { question: UiQuestion }) {
  return (
    <li className="qrow qrow--missing">
      <div className="qrow__head">
        <h4 className="qrow__label">{question.label}</h4>
        <code className="qrow__id mono">{question.id}</code>
      </div>
      <p className="qrow__meaning">No answer in this evaluation. The question may have been added after the scan.</p>
    </li>
  );
}

function ChunkDrill({
  questionId,
  question,
  chunks,
  fromChunk,
  fromFiles,
}: {
  questionId: string;
  question: UiQuestion;
  chunks: ChunkResult[];
  fromChunk?: number;
  fromFiles?: string[];
}) {
  const [open, setOpen] = useState(false);
  const failedCount = chunks.filter(chunkFailed).length;
  if (chunks.length === 0) return null;

  return (
    <div className="chunkdrill">
      <div className="chunkdrill__source">
        <span className="chunkdrill__from">
          worst in{" "}
          <span className="mono">
            chunk {fromChunk ?? 0}
            {fromFiles && fromFiles.length > 0 ? `: ${fromFiles.join(", ")}` : ""}
          </span>
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--xs"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Per chunk"} ({chunks.length}
          {failedCount > 0 ? `, ${failedCount} failed` : ""})
        </button>
      </div>
      {open ? (
        <ul className="chunkdrill__list">
          {chunks.map((chunk) => {
            // A failed chunk has no answers at all. It must never render as a clean
            // zero, so it gets its own row saying what went wrong.
            if (chunkFailed(chunk)) {
              return (
                <li key={chunk.chunk.index} className="chunkrow chunkrow--failed">
                  <span className="chunkrow__index mono">#{chunk.chunk.index}</span>
                  <span className="chunkrow__failed mono">not evaluated: {chunk.error}</span>
                  <span className="chunkrow__files mono" title={chunk.chunk.files.join("\n")}>
                    {chunk.chunk.files[0]}
                    {chunk.chunk.files.length > 1 ? ` +${chunk.chunk.files.length - 1}` : ""}
                  </span>
                </li>
              );
            }
            const answer = chunk.answers[questionId];
            if (!answer) return null;
            const value =
              answer.type === "noul"
                ? percent(answer.noul)
                : answer.type === "score"
                  ? answer.score.toFixed(2)
                  : answer.choice;
            const width =
              answer.type === "noul"
                ? answer.noul * 100
                : answer.type === "score"
                  ? (answer.score / ((question.levels ?? 4) - 1)) * 100
                  : 100;
            const isSource = chunk.chunk.index === fromChunk;
            return (
              <li key={chunk.chunk.index} className={`chunkrow${isSource ? " chunkrow--source" : ""}`}>
                <span className="chunkrow__index mono">#{chunk.chunk.index}</span>
                <span className="chunkrow__bar" aria-hidden="true">
                  <span className="chunkrow__fill" style={{ width: `${width}%` }} />
                </span>
                <span className="chunkrow__value mono">{value}</span>
                <span className="chunkrow__files mono" title={chunk.chunk.files.join("\n")}>
                  {chunk.chunk.files[0]}
                  {chunk.chunk.files.length > 1 ? ` +${chunk.chunk.files.length - 1}` : ""}
                </span>
                {chunk.chunk.truncated ? <Pill tone="warn">truncated</Pill> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Used by the trace to render one answer without the surrounding row chrome. */
export function answerSummary(id: string, answer: JevAnswer): string {
  const question = QUESTION_BY_ID[id];
  if (answer.type === "noul") return `${percent(answer.noul)} yes`;
  if (answer.type === "choice") return `${answer.choice} at ${percent(answer.probabilities[answer.choice] ?? 0)}`;
  return `${answer.score.toFixed(2)} of ${(question?.levels ?? 4) - 1}`;
}
