/**
 * Dashboard tests — the folding function is the interesting part:
 * given a synthetic sequence of RunLogEvents, does `summarizeRun`
 * reproduce the expected per-role costs and todo tallies?
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatTable, loadSummaries, summarizeRun } from "../src/dashboard.js";
import {
  appendEvent,
  startRun,
  type RunLogEvent,
} from "../src/runs/log.js";

describe("summarizeRun", () => {
  it("folds usage events into per-role costs", () => {
    const events: RunLogEvent[] = [
      {
        type: "run-start",
        ts: "t",
        requirement: "r",
        config: {
          repoRoot: "/",
          githubEnabled: false,
          sandboxEnabled: false,
          maxLoops: 1,
          maxReviewRounds: 1,
        },
      },
      {
        type: "usage",
        ts: "t",
        role: "planner",
        provider: "anthropic",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
      },
      {
        type: "usage",
        ts: "t",
        role: "coder",
        provider: "anthropic",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.05,
      },
      {
        type: "usage",
        ts: "t",
        role: "coder",
        provider: "anthropic",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.03,
      },
      {
        type: "run-end",
        ts: "t",
        reason: "complete",
        overall: { costUsd: 0.09, cacheSavedUsd: 0.02, calls: 3 },
      },
    ];
    const out = summarizeRun(events, "/path");
    expect(out.overall.calls).toBe(3);
    expect(out.overall.costUsd).toBeCloseTo(0.09, 3);
    expect(out.perRole.planner.calls).toBe(1);
    expect(out.perRole.coder.calls).toBe(2);
    expect(out.perRole.coder.costUsd).toBeCloseTo(0.08, 3);
    expect(out.reason).toBe("complete");
    // Cache savings come from run-end, not from per-call.
    expect(out.overall.cacheSavedUsd).toBe(0.02);
  });

  it("counts done vs rolled-back todos", () => {
    const events: RunLogEvent[] = [
      {
        type: "todo-complete",
        ts: "t",
        id: "T1",
        title: "a",
        iterations: 1,
      },
      {
        type: "todo-complete",
        ts: "t",
        id: "T2",
        title: "b",
        iterations: 3,
        rolledBack: true,
      },
      {
        type: "todo-complete",
        ts: "t",
        id: "T3",
        title: "c",
        iterations: 2,
      },
    ];
    const out = summarizeRun(events, "/path");
    expect(out.todosDone).toBe(2);
    expect(out.todosRolledBack).toBe(1);
  });

  it("reports partial summaries for interrupted runs (no run-end)", () => {
    const events: RunLogEvent[] = [
      {
        type: "run-start",
        ts: "t",
        requirement: "r",
        config: {
          repoRoot: "/",
          githubEnabled: false,
          sandboxEnabled: false,
          maxLoops: 1,
          maxReviewRounds: 1,
        },
      },
      {
        type: "usage",
        ts: "t",
        role: "planner",
        provider: "anthropic",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.02,
      },
    ];
    const out = summarizeRun(events, "/path");
    expect(out.reason).toBeUndefined();
    expect(out.overall.costUsd).toBeCloseTo(0.02, 3);
    expect(out.overall.cacheSavedUsd).toBe(0); // no run-end means no recorded savings
  });
});

describe("formatTable + loadSummaries", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-dash-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("formatTable renders a placeholder when no runs exist", () => {
    expect(formatTable([])).toMatch(/no runs logged/);
  });

  it("loadSummaries + formatTable round-trips a real-looking run", () => {
    const h = startRun(root);
    appendEvent(h, {
      type: "run-start",
      ts: "2026-04-24T00:00:00Z",
      requirement: "migrate schema",
      config: {
        repoRoot: root,
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 1,
        maxReviewRounds: 1,
      },
    });
    appendEvent(h, {
      type: "usage",
      ts: "2026-04-24T00:00:01Z",
      role: "coder",
      provider: "anthropic",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.02,
    });
    appendEvent(h, {
      type: "run-end",
      ts: "2026-04-24T00:00:02Z",
      reason: "complete",
      overall: { costUsd: 0.02, cacheSavedUsd: 0, calls: 1 },
    });

    const summaries = loadSummaries(root);
    expect(summaries).toHaveLength(1);
    const table = formatTable(summaries);
    expect(table).toContain("migrate schema");
    expect(table).toContain("complete");
    expect(table).toContain("$0.0200");
    expect(table).toContain("TOTAL");
  });
});
