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
  formatJson,
  formatTable,
  loadSummaries,
  summarizeRun,
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
