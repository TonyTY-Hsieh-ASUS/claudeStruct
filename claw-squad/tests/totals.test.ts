/**
 * Per-role totals unit tests.
 *
 * These lock in the accounting primitives that the CLI summary, TUI
 * header, and dashboard all read. The cases intentionally stay narrow —
 * addUsage + the silent-invalidator detector — since that's the full
 * surface area of totals.ts.
 */

import { describe, expect, it } from "vitest";
import {
  addUsage,
  emptyRoleTotals,
  emptyRunTotals,
  isSilentCacheInvalidator,
} from "../src/totals.js";
import type { InvokeResult } from "../src/providers/types.js";

function makeUsage(partial: Partial<InvokeResult> = {}): InvokeResult {
  return {
    provider: "anthropic",
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...partial,
  };
}

describe("addUsage", () => {
  it("splits tokens into the right role bucket and updates overall", () => {
    const t = emptyRunTotals();
    addUsage(t, "planner", makeUsage({ inputTokens: 100, outputTokens: 50 }));
    addUsage(t, "coder", makeUsage({ inputTokens: 200, outputTokens: 75 }));

    expect(t.perRole.planner.inputTokens).toBe(100);
    expect(t.perRole.coder.inputTokens).toBe(200);
    expect(t.perRole.reviewer.inputTokens).toBe(0);
    expect(t.overall.inputTokens).toBe(300);
    expect(t.overall.outputTokens).toBe(125);
    expect(t.overall.calls).toBe(2);
  });

  it("tracks Anthropic calls only for anthropic provider", () => {
    const t = emptyRunTotals();
    addUsage(t, "coder", makeUsage({ provider: "anthropic" }));
    addUsage(t, "coder", makeUsage({ provider: "openai" }));
    expect(t.perRole.coder.calls).toBe(2);
    expect(t.perRole.coder.anthropicCalls).toBe(1);
    expect(t.overall.anthropicCalls).toBe(1);
  });

  it("accumulates cache savings on Anthropic cache reads", () => {
    const t = emptyRunTotals();
    addUsage(
      t,
      "planner",
      makeUsage({ provider: "anthropic", cacheReadTokens: 1_000_000 }),
    );
    // Expect ~$4.50 saved per 1M cached-read tokens vs no-cache baseline.
    expect(t.overall.cacheSavedUsd).toBeCloseTo(4.5, 3);
  });

  it("records zero savings for non-Anthropic calls", () => {
    const t = emptyRunTotals();
    addUsage(
      t,
      "coder",
      makeUsage({ provider: "openai", cacheReadTokens: 1_000_000 }),
    );
    expect(t.overall.cacheSavedUsd).toBe(0);
  });
});

describe("addUsage with subagent name", () => {
  it("populates bySubagent[name] in addition to perRole.subagent and overall", () => {
    const t = emptyRunTotals();
    addUsage(
      t,
      "subagent",
      makeUsage({ inputTokens: 100, outputTokens: 50 }),
      "research-helper",
    );
    expect(t.perRole.subagent.calls).toBe(1);
    expect(t.overall.calls).toBe(1);
    expect(t.bySubagent["research-helper"]?.calls).toBe(1);
    expect(t.bySubagent["research-helper"]?.inputTokens).toBe(100);
  });

  it("keeps separate buckets per subagent name", () => {
    const t = emptyRunTotals();
    addUsage(t, "subagent", makeUsage({ inputTokens: 10 }), "alpha");
    addUsage(t, "subagent", makeUsage({ inputTokens: 30 }), "beta");
    addUsage(t, "subagent", makeUsage({ inputTokens: 20 }), "alpha");
    expect(t.bySubagent.alpha?.inputTokens).toBe(30);
    expect(t.bySubagent.beta?.inputTokens).toBe(30);
    expect(t.bySubagent.alpha?.calls).toBe(2);
    expect(t.perRole.subagent.calls).toBe(3);
  });

  it("ignores subagentName when role is not 'subagent'", () => {
    const t = emptyRunTotals();
    addUsage(t, "coder", makeUsage({ inputTokens: 5 }), "should-be-ignored");
    expect(t.bySubagent).toEqual({});
    expect(t.perRole.coder.inputTokens).toBe(5);
  });

  it("falls back to subagent bucket only when name is empty", () => {
    const t = emptyRunTotals();
    addUsage(t, "subagent", makeUsage({ inputTokens: 7 }), "");
    addUsage(t, "subagent", makeUsage({ inputTokens: 7 }));
    expect(t.bySubagent).toEqual({});
    expect(t.perRole.subagent.calls).toBe(2);
  });
});

describe("isSilentCacheInvalidator", () => {
  it("fires when enough Anthropic calls landed but zero were cached", () => {
    const t = emptyRoleTotals();
    t.anthropicCalls = 5;
    t.cacheReadTokens = 0;
    expect(isSilentCacheInvalidator(t)).toBe(true);
  });

  it("does not fire when cache reads occurred", () => {
    const t = emptyRoleTotals();
    t.anthropicCalls = 5;
    t.cacheReadTokens = 1;
    expect(isSilentCacheInvalidator(t)).toBe(false);
  });

  it("does not fire under the call threshold", () => {
    const t = emptyRoleTotals();
    t.anthropicCalls = 2;
    t.cacheReadTokens = 0;
    expect(isSilentCacheInvalidator(t)).toBe(false);
  });

  it("never fires for non-Anthropic-only runs", () => {
    const t = emptyRoleTotals();
    t.calls = 100;
    t.anthropicCalls = 0;
    t.cacheReadTokens = 0;
    expect(isSilentCacheInvalidator(t)).toBe(false);
  });
});
