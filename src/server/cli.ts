// Headless entry point: `npm run scan` and `npm run eval -- 1650`.
// DESIGN.md §1 "Scripts".
import "dotenv/config";

import type { Evaluation } from "../shared/types.js";
import { githubAuthMode, githubRepo } from "./github.js";
import { evaluatePr, jevMode, scanSync } from "./pipeline.js";

function usage(): never {
  console.error(
    [
      "usage:",
      "  npm run scan -- [--force] [--json]      evaluate every open PR",
      "  npm run eval -- <number> [--force]      evaluate one PR and print its full trace",
    ].join("\n"),
  );
  process.exit(2);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function topReason(e: Evaluation): string {
  const order = [
    "hard_gate",
    "jev_hard_block",
    "ready",
    "low_composite",
    "mid_composite",
    "low_confidence",
    "uncertain_nouls",
    "huge_size",
    "soft_gate",
  ];
  for (const code of order) {
    const r = e.decision.reasons.find((x) => x.code === code);
    if (r) return r.text;
  }
  return e.decision.reasons[0]?.text ?? "";
}

function printTable(evaluations: Evaluation[]): void {
  const header =
    `${pad("PR", 7)}${pad("DECISION", 14)}${padLeft("COMP", 6)}  ${padLeft("MINCONF", 7)}  ${pad("COV", 8)}TOP REASON`;
  console.log(header);
  console.log("-".repeat(Math.min(140, header.length + 40)));
  for (const e of [...evaluations].sort((a, b) => a.decision.composite - b.decision.composite)) {
    console.log(
      pad(`#${e.prNumber}`, 7) +
        pad(e.decision.kind, 14) +
        padLeft(e.decision.composite.toFixed(1), 6) +
        "  " +
        padLeft(e.decision.minConfidence === null ? "—" : e.decision.minConfidence.toFixed(2), 7) +
        "  " +
        pad(e.coverage, 8) +
        topReason(e).slice(0, 90),
    );
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "";
  const force = args.includes("--force");
  const json = args.includes("--json");

  console.error(
    `[cli] repo ${githubRepo().full} · github auth ${githubAuthMode()} · jev ${jevMode()}${force ? " · force" : ""}`,
  );

  if (command === "scan") {
    const { job, evaluations } = await scanSync({ force });
    if (json) {
      console.log(JSON.stringify({ job, evaluations }, null, 2));
    } else {
      printTable(evaluations);
      const tokens = evaluations.reduce((a, e) => a + e.usage.input_tokens, 0);
      const cost = evaluations.reduce((a, e) => a + e.usage.estCostUsd, 0);
      console.log("");
      console.log(
        `${evaluations.length}/${job.total} PR(s) evaluated · ${tokens.toLocaleString()} input tokens · $${cost.toFixed(4)}`,
      );
      for (const e of job.errors) console.error(`[cli] #${e.n}: ${e.error}`);
    }
    return job.errors.length > 0 ? 1 : 0;
  }

  if (command === "eval") {
    const n = Number(args[1]);
    if (!Number.isInteger(n) || n <= 0) usage();
    const evaluation = await evaluatePr(n, { force });
    console.log(JSON.stringify(evaluation, null, 2));
    return evaluation.error ? 1 : 0;
  }

  usage();
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`[cli] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
