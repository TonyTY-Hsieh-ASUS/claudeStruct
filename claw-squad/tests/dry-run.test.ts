/**
 * Tests for the dry-run cost estimator.
 *
 * The estimator is a pure function over PROVIDER_RATES + heuristics, so
 * we lock the math here. Tolerances are loose (multiples), since the
 * goal is order-of-magnitude correctness, not exactness — see the file
 * header in dry-run.ts for the ±30% spec.
 */

import { describe, expect, it } from "vitest";
import {
  estimateRemainingCost,
  formatDryRunReport,
  plannerSoFarUsd,
} from "../src/dry-run.js";
import { emptyRunTotals } from "../src/totals.js";

describe("estimateRemainingCost", () => {
  it("zero todos → zero remaining spend", () => {
    const e = estimateRemainingCost({
      todoCount: 0,
      maxReviewRounds: 3,
      coderProvider: "anthropic",
      reviewerProvider: "anthropic",
      plannerSoFarUsd: 0.5,
    });
    expect(e.remainingUsd).toBe(0);
    expect(e.totalUsd).toBe(0.5);
    expect(e.projectedInputTokens).toBe(0);
  });

  it("scales linearly with todo count", () => {
    const base = estimateRemainingCost({
      todoCount: 1,
      maxReviewRounds: 3,
      coderProvider: "anthropic",
      reviewerProvider: "anthropic",
      plannerSoFarUsd: 0,
    });
    const ten = estimateRemainingCost({
      todoCount: 10,
      maxReviewRounds: 3,
      coderProvider: "anthropic",
      reviewerProvider: "anthropic",
      plannerSoFarUsd: 0,
    });
    expect(ten.remainingUsd).toBeCloseTo(base.remainingUsd * 10, 6);
  });

  it("local providers (ollama) cost zero", () => {
    const e = estimateRemainingCost({
      todoCount: 5,
      maxReviewRounds: 3,
      coderProvider: "ollama",
      reviewerProvider: "ollama",
      plannerSoFarUsd: 0.1,
    });
    expect(e.remainingUsd).toBe(0);
    expect(e.totalUsd).toBe(0.1);
  });

  it("respects maxReviewRounds floor — fewer rounds, lower cost", () => {
    // expectedRounds = min(maxReviewRounds, 1.3). With maxReviewRounds=1
    // we cap at 1 round, so the estimate is strictly cheaper than the
    // default cap (1.3 rounds).
    const cheap = estimateRemainingCost({
      todoCount: 4,
      maxReviewRounds: 1,
      coderProvider: "anthropic",
      reviewerProvider: "anthropic",
      plannerSoFarUsd: 0,
    });
    const fancy = estimateRemainingCost({
      todoCount: 4,
      maxReviewRounds: 5,
      coderProvider: "anthropic",
      reviewerProvider: "anthropic",
      plannerSoFarUsd: 0,
    });
    expect(cheap.remainingUsd).toBeLessThan(fancy.remainingUsd);
    expect(cheap.expectedRoundsPerTodo).toBe(1);
    expect(fancy.expectedRoundsPerTodo).toBe(1.3);
  });

  it("planner spend is added on top of remaining estimate", () => {
    const e = estimateRemainingCost({
      todoCount: 2,
      maxReviewRounds: 3,
      coderProvider: "anthropic",
      reviewerProvider: "anthropic",
      plannerSoFarUsd: 1.5,
    });
    expect(e.totalUsd).toBeCloseTo(e.remainingUsd + 1.5, 6);
  });
});

describe("plannerSoFarUsd", () => {
  it("returns 0 for an empty totals", () => {
    expect(plannerSoFarUsd(emptyRunTotals())).toBe(0);
  });
  it("reads only the planner role bucket", () => {
    const t = emptyRunTotals();
    t.perRole.planner.costUsd = 0.42;
    t.perRole.coder.costUsd = 99.0;
    expect(plannerSoFarUsd(t)).toBe(0.42);
  });
});

describe("formatDryRunReport", () => {
  it("includes todo titles and a cost line", () => {
    const e = estimateRemainingCost({
      todoCount: 2,
      maxReviewRounds: 3,
      coderProvider: "anthropic",
      reviewerProvider: "anthropic",
      plannerSoFarUsd: 0.1,
    });
    const out = formatDryRunReport(e, ["t1: do a thing", "t2: do another"]);
    expect(out).toContain("t1: do a thing");
    expect(out).toContain("t2: do another");
    expect(out).toContain("estimated total run");
  });

  it("truncates large todo lists to 10 lines", () => {
    const titles = Array.from({ length: 15 }, (_, i) => `t${i}: thing`);
    const e = estimateRemainingCost({
      todoCount: 15,
      maxReviewRounds: 3,
      coderProvider: "anthropic",
      reviewerProvider: "anthropic",
      plannerSoFarUsd: 0,
    });
    const out = formatDryRunReport(e, titles);
    expect(out).toContain("... 5 more");
    expect(out).not.toContain("t14");
  });
});
