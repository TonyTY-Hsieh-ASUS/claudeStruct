/**
 * Dashboard tests — the folding function is the interesting part:
 * given a synthetic sequence of RunLogEvents, does `summarizeRun`
 * reproduce the expected per-role costs and todo tallies?
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffRuns,
  formatDiff,
  formatDiffJson,
  formatJson,
  formatTable,
  loadSummaries,
  loadSummaryById,
  summarizeRun,
  watchSummaries,
} from "../src/dashboard.js";
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

  it("attributes cost to bySubagent[name] when usage events carry subagentName", () => {
    const events: RunLogEvent[] = [
      {
        type: "usage",
        ts: "t",
        role: "subagent",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.05,
        subagentName: "research-helper",
      },
      {
        type: "usage",
        ts: "t",
        role: "subagent",
        provider: "anthropic",
        inputTokens: 50,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.02,
        subagentName: "doc-writer",
      },
      {
        type: "usage",
        ts: "t",
        role: "subagent",
        provider: "anthropic",
        inputTokens: 20,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
        subagentName: "research-helper",
      },
    ];
    const out = summarizeRun(events, "/path");
    expect(out.perRole.subagent.calls).toBe(3);
    expect(out.bySubagent["research-helper"]?.calls).toBe(2);
    expect(out.bySubagent["research-helper"]?.costUsd).toBeCloseTo(0.06, 4);
    expect(out.bySubagent["doc-writer"]?.calls).toBe(1);
  });

  it("does not populate bySubagent for legacy events without subagentName", () => {
    const events: RunLogEvent[] = [
      {
        type: "usage",
        ts: "t",
        role: "subagent",
        provider: "anthropic",
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
      },
    ];
    const out = summarizeRun(events, "/path");
    expect(out.bySubagent).toEqual({});
    expect(out.perRole.subagent.calls).toBe(1);
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

  it("formatJson emits valid parseable JSON of the summaries", () => {
    const h = startRun(root);
    appendEvent(h, {
      type: "usage",
      ts: "t",
      role: "subagent",
      provider: "anthropic",
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.02,
      subagentName: "x-helper",
    });
    const summaries = loadSummaries(root);
    const parsed = JSON.parse(formatJson(summaries));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].bySubagent["x-helper"].costUsd).toBeCloseTo(0.02, 4);
  });

  it("loadSummaries --filter excludes runs whose requirement does not match", async () => {
    const h1 = startRun(root);
    appendEvent(h1, {
      type: "run-start",
      ts: "1",
      requirement: "fix the auth bug",
      config: {
        repoRoot: root,
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 1,
        maxReviewRounds: 1,
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    const h2 = startRun(root);
    appendEvent(h2, {
      type: "run-start",
      ts: "2",
      requirement: "add a docs page",
      config: {
        repoRoot: root,
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 1,
        maxReviewRounds: 1,
      },
    });
    expect(loadSummaries(root, { filter: "auth" })).toHaveLength(1);
    expect(loadSummaries(root, { filter: "AUTH" })).toHaveLength(1);
    expect(loadSummaries(root, { filter: "Z" })).toHaveLength(0);
    expect(loadSummaries(root)).toHaveLength(2);
  });

  it("formatTable shows top subagents in the requirement column", () => {
    const events: RunLogEvent[] = [
      {
        type: "run-start",
        ts: "t",
        requirement: "build something",
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
        role: "subagent",
        provider: "anthropic",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.5,
        subagentName: "expensive-one",
      },
    ];
    const summary = summarizeRun(events, "/path");
    const table = formatTable([summary]);
    expect(table).toContain("expensive-one");
  });
});

describe("diffRuns + formatDiff (PR-B)", () => {
  function fakeSummary(opts: {
    runId: string;
    requirement?: string;
    reason?: string;
    perRoleCost?: Partial<Record<"planner" | "coder" | "reviewer" | "subagent", number>>;
    bySubagent?: Record<string, number>;
    todosDone?: number;
    todosRolledBack?: number;
  }) {
    const perRole = {
      planner: { calls: 0, costUsd: opts.perRoleCost?.planner ?? 0 },
      coder: { calls: 0, costUsd: opts.perRoleCost?.coder ?? 0 },
      reviewer: { calls: 0, costUsd: opts.perRoleCost?.reviewer ?? 0 },
      subagent: { calls: 0, costUsd: opts.perRoleCost?.subagent ?? 0 },
    };
    const bySubagent: Record<string, { calls: number; costUsd: number }> = {};
    for (const [k, v] of Object.entries(opts.bySubagent ?? {})) {
      bySubagent[k] = { calls: 1, costUsd: v };
    }
    const overallCost =
      (opts.perRoleCost?.planner ?? 0) +
      (opts.perRoleCost?.coder ?? 0) +
      (opts.perRoleCost?.reviewer ?? 0) +
      (opts.perRoleCost?.subagent ?? 0);
    return {
      path: `/runs/${opts.runId}.jsonl`,
      requirement: opts.requirement,
      reason: opts.reason,
      overall: { costUsd: overallCost, cacheSavedUsd: 0, calls: 0 },
      perRole,
      bySubagent,
      todosDone: opts.todosDone ?? 0,
      todosRolledBack: opts.todosRolledBack ?? 0,
    };
  }

  it("computes overall + per-role + per-subagent deltas (b - a)", () => {
    const a = fakeSummary({
      runId: "A",
      reason: "complete",
      perRoleCost: { planner: 0.1, coder: 0.2 },
      bySubagent: { research: 0.05 },
    });
    const b = fakeSummary({
      runId: "B",
      reason: "complete",
      perRoleCost: { planner: 0.15, coder: 0.5 },
      bySubagent: { research: 0.1, "doc-writer": 0.04 },
    });
    const r = diffRuns(a, b);
    expect(r.overallCostDeltaUsd).toBeCloseTo(0.35, 4);
    expect(r.perRoleDelta.planner).toBeCloseTo(0.05, 4);
    expect(r.perRoleDelta.coder).toBeCloseTo(0.3, 4);
    expect(r.bySubagentDelta.research).toBeCloseTo(0.05, 4);
    expect(r.bySubagentDelta["doc-writer"]).toBeCloseTo(0.04, 4);
    expect(r.outcomeChange).toBeUndefined();
  });

  it("flags an outcome change", () => {
    const a = fakeSummary({ runId: "A", reason: "complete" });
    const b = fakeSummary({ runId: "B", reason: "blocked" });
    const r = diffRuns(a, b);
    expect(r.outcomeChange).toBe("complete → blocked");
  });

  it("identical runs produce zero deltas", () => {
    const a = fakeSummary({
      runId: "A",
      reason: "complete",
      perRoleCost: { coder: 0.1 },
      bySubagent: { research: 0.05 },
    });
    const r = diffRuns(a, a);
    expect(r.overallCostDeltaUsd).toBe(0);
    expect(r.perRoleDelta.coder).toBe(0);
    expect(r.bySubagentDelta.research).toBe(0);
    expect(r.outcomeChange).toBeUndefined();
  });

  it("counts subagents that exist on only one side", () => {
    const a = fakeSummary({
      runId: "A",
      bySubagent: { gone: 0.5 },
    });
    const b = fakeSummary({
      runId: "B",
      bySubagent: { added: 0.3 },
    });
    const r = diffRuns(a, b);
    expect(r.bySubagentDelta.gone).toBeCloseTo(-0.5, 4);
    expect(r.bySubagentDelta.added).toBeCloseTo(0.3, 4);
  });

  it("formatDiff includes the regression headlines", () => {
    const a = fakeSummary({
      runId: "A",
      reason: "complete",
      perRoleCost: { coder: 0.1 },
      todosDone: 1,
    });
    const b = fakeSummary({
      runId: "B",
      reason: "blocked",
      perRoleCost: { coder: 0.4 },
      todosDone: 0,
      todosRolledBack: 1,
    });
    const out = formatDiff(diffRuns(a, b));
    expect(out).toContain("complete → blocked");
    expect(out).toContain("overall cost:");
    expect(out).toContain("coder");
  });

  it("formatDiffJson is parseable JSON", () => {
    const a = fakeSummary({ runId: "A" });
    const b = fakeSummary({ runId: "B" });
    const parsed = JSON.parse(formatDiffJson(diffRuns(a, b)));
    expect(parsed.a.runId).toBe("A");
    expect(parsed.b.runId).toBe("B");
  });
});

describe("loadSummaryById + watchSummaries (PR-B)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-watch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loadSummaryById returns undefined for unknown runs", () => {
    expect(loadSummaryById(root, "nope")).toBeUndefined();
  });

  it("loadSummaryById round-trips a synthetic run", () => {
    const h = startRun(root);
    appendEvent(h, {
      type: "run-start",
      ts: "2026-01-01T00:00:00Z",
      requirement: "test req",
      config: {
        repoRoot: root,
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 1,
        maxReviewRounds: 1,
      },
    });
    const id = (h.path.split("/").pop() ?? "").replace(/\.jsonl$/, "");
    const summary = loadSummaryById(root, id);
    expect(summary?.requirement).toBe("test req");
  });

  it("watchSummaries fires the sink immediately and again after a tick", async () => {
    const sinkCalls: number[] = [];
    const handle = watchSummaries(root, 50, (s) => {
      sinkCalls.push(s.length);
    });
    // Immediate fire — empty initial state.
    expect(sinkCalls.length).toBe(1);
    expect(sinkCalls[0]).toBe(0);

    // Add a run and wait for the next interval.
    const h = startRun(root);
    appendEvent(h, {
      type: "run-start",
      ts: "t",
      requirement: "added mid-watch",
      config: {
        repoRoot: root,
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 1,
        maxReviewRounds: 1,
      },
    });
    await new Promise((r) => setTimeout(r, 120));
    handle.stop();
    expect(sinkCalls[sinkCalls.length - 1]).toBeGreaterThanOrEqual(1);
  });

  it("watchSummaries.stop() prevents further sink calls", async () => {
    let calls = 0;
    const handle = watchSummaries(root, 30, () => {
      calls += 1;
    });
    handle.stop();
    const before = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(before);
  });
});
