/**
 * Cost estimator for `claw-squad run --dry-run`.
 *
 * After Planner finishes its Q&A and emits a TODO list, we know:
 *   - The real Planner spend so far (tokens + cost) — from `totals`.
 *   - The number of TODOs to grind through.
 *   - The configured Coder + Reviewer providers / models (rates).
 *   - The maxReviewRounds cap.
 *
 * What we don't know precisely is per-todo Coder / Reviewer token
 * volume — that depends on file context size, which varies by repo and
 * task. We use heuristic averages calibrated against representative
 * runs in `.claw-squad/runs/`. ±30% is the explicit accuracy goal; the
 * point is to give the user a go/no-go number, not exact accounting.
 *
 * Heuristic per TODO (values intentionally conservative):
 *   - Coder input  ≈ 40k tokens (file context + prompt)
 *   - Coder output ≈ 4k tokens (edits + commit msg)
 *   - Reviewer input  ≈ 8k tokens (diff + prompt)
 *   - Reviewer output ≈ 1k tokens (verdict)
 * Each TODO triggers `expectedRounds` Coder/Reviewer pairs. We assume
 * `min(maxReviewRounds, 1.3)` rounds on average — most tasks land on
 * round 1, a fraction need a fix-up.
 */

import { PROVIDER_RATES } from "./providers/registry.js";
import type { ProviderName } from "./providers/types.js";
import type { RunTotals } from "./totals.js";

export interface DryRunInputs {
  todoCount: number;
  maxReviewRounds: number;
  coderProvider: ProviderName;
  reviewerProvider: ProviderName;
  /** Real Planner spend so far. */
  plannerSoFarUsd: number;
}

export interface DryRunEstimate {
  todoCount: number;
  expectedRoundsPerTodo: number;
  perTodoUsd: number;
  remainingUsd: number;
  totalUsd: number;
  plannerSoFarUsd: number;
  /** Token totals projected for the remainder of the run (input / output). */
  projectedInputTokens: number;
  projectedOutputTokens: number;
}

const CODER_INPUT_TOKENS = 40_000;
const CODER_OUTPUT_TOKENS = 4_000;
const REVIEWER_INPUT_TOKENS = 8_000;
const REVIEWER_OUTPUT_TOKENS = 1_000;

export function estimateRemainingCost(inputs: DryRunInputs): DryRunEstimate {
  const expectedRounds = Math.min(inputs.maxReviewRounds, 1.3);

  const coderRate = PROVIDER_RATES[inputs.coderProvider];
  const reviewerRate = PROVIDER_RATES[inputs.reviewerProvider];

  const coderPerRound =
    (CODER_INPUT_TOKENS / 1_000_000) * coderRate.input +
    (CODER_OUTPUT_TOKENS / 1_000_000) * coderRate.output;
  const reviewerPerRound =
    (REVIEWER_INPUT_TOKENS / 1_000_000) * reviewerRate.input +
    (REVIEWER_OUTPUT_TOKENS / 1_000_000) * reviewerRate.output;

  const perTodoUsd = expectedRounds * (coderPerRound + reviewerPerRound);
  const remainingUsd = inputs.todoCount * perTodoUsd;
  const totalUsd = inputs.plannerSoFarUsd + remainingUsd;
  const projectedInputTokens =
    inputs.todoCount * expectedRounds * (CODER_INPUT_TOKENS + REVIEWER_INPUT_TOKENS);
  const projectedOutputTokens =
    inputs.todoCount * expectedRounds * (CODER_OUTPUT_TOKENS + REVIEWER_OUTPUT_TOKENS);

  return {
    todoCount: inputs.todoCount,
    expectedRoundsPerTodo: expectedRounds,
    perTodoUsd,
    remainingUsd,
    totalUsd,
    plannerSoFarUsd: inputs.plannerSoFarUsd,
    projectedInputTokens,
    projectedOutputTokens,
  };
}

export function plannerSoFarUsd(totals: RunTotals): number {
  return totals.perRole.planner.costUsd;
}

export function formatDryRunReport(
  estimate: DryRunEstimate,
  todoTitles: string[],
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Dry run: Planner finished, no Coder/Reviewer calls made ===");
  lines.push("");
  lines.push(`TODOs produced: ${estimate.todoCount}`);
  for (const t of todoTitles.slice(0, 10)) {
    lines.push(`  · ${t}`);
  }
  if (todoTitles.length > 10) {
    lines.push(`  · ... ${todoTitles.length - 10} more`);
  }
  lines.push("");
  lines.push("Projected remaining spend (heuristic, ±30%):");
  lines.push(`  expected rounds / TODO:  ${estimate.expectedRoundsPerTodo.toFixed(2)}`);
  lines.push(`  per-TODO cost:           $${estimate.perTodoUsd.toFixed(4)}`);
  lines.push(`  remaining:               $${estimate.remainingUsd.toFixed(4)}`);
  lines.push(`  planner spent so far:    $${estimate.plannerSoFarUsd.toFixed(4)}`);
  lines.push(`  estimated total run:     $${estimate.totalUsd.toFixed(4)}`);
  lines.push(
    `  projected tokens:        ${estimate.projectedInputTokens.toLocaleString()} input / ${estimate.projectedOutputTokens.toLocaleString()} output`,
  );
  lines.push("");
  lines.push("To execute, drop --dry-run.");
  return lines.join("\n");
}
