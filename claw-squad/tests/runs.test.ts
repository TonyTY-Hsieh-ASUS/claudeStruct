/**
 * Per-run JSONL log tests.
 *
 * The dashboard depends on the exact event shapes, so we lock in the
 * round-trip here: startRun → appendEvent → loadOneRun. We also test
 * that a malformed line is skipped (not fatal) — otherwise one bad
 * write would hide an entire run's history.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  loadAllRuns,
  loadOneRun,
  startRun,
  type RunLogEvent,
} from "../src/runs/log.js";

describe("run log", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-runs-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("startRun creates .claw-squad/runs/ and a dated filename", () => {
    const h = startRun(root);
    expect(h.path).toContain(".claw-squad/runs/");
    expect(h.path).toMatch(/\.jsonl$/);
    // Filename should be timestamp-based (no `:` which some FSs reject).
    expect(h.path).not.toMatch(/:/);
  });

  it("appendEvent + loadOneRun round-trip preserves types", () => {
    const h = startRun(root);
    const events: RunLogEvent[] = [
      {
        type: "run-start",
        ts: "2026-01-01T00:00:00Z",
        requirement: "do a thing",
        config: {
          repoRoot: root,
          githubEnabled: false,
          sandboxEnabled: false,
          maxLoops: 10,
          maxReviewRounds: 3,
        },
      },
      {
        type: "usage",
        ts: "2026-01-01T00:00:01Z",
        role: "planner",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
      },
      {
        type: "todo-complete",
        ts: "2026-01-01T00:00:02Z",
        id: "T1",
        title: "add foo",
        iterations: 2,
      },
      {
        type: "run-end",
        ts: "2026-01-01T00:00:03Z",
        reason: "complete",
        overall: { costUsd: 0.01, cacheSavedUsd: 0, calls: 1 },
      },
    ];
    for (const e of events) appendEvent(h, e);
    const loaded = loadOneRun(h.path);
    expect(loaded).toEqual(events);
  });

  it("loadOneRun skips malformed lines but reads the rest", () => {
    const h = startRun(root);
    appendEvent(h, {
      type: "run-start",
      ts: "t",
      requirement: "x",
      config: {
        repoRoot: root,
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 1,
        maxReviewRounds: 1,
      },
    });
    // Corrupt a line by appending garbage — real crash pattern is a
    // partial write at the end of the file.
    const raw = readFileSync(h.path, "utf-8");
    writeFileSync(h.path, raw + "{not-json\n", "utf-8");
    appendEvent(h, {
      type: "run-end",
      ts: "t",
      reason: "complete",
      overall: { costUsd: 0, cacheSavedUsd: 0, calls: 0 },
    });

    const warnings: string[] = [];
    const events = loadOneRun(h.path, (m) => warnings.push(m));
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("run-start");
    expect(events[1]?.type).toBe("run-end");
    expect(warnings).toHaveLength(1);
  });

  it("loadAllRuns returns each run sorted chronologically", async () => {
    // Two runs written in order should sort by filename → by startedAt.
    const h1 = startRun(root);
    appendEvent(h1, {
      type: "run-start",
      ts: "1",
      requirement: "first",
      config: {
        repoRoot: root,
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 1,
        maxReviewRounds: 1,
      },
    });
    // Tiny wait so the ISO timestamp differs.
    await new Promise((r) => setTimeout(r, 5));
    const h2 = startRun(root);
    appendEvent(h2, {
      type: "run-start",
      ts: "2",
      requirement: "second",
      config: {
        repoRoot: root,
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 1,
        maxReviewRounds: 1,
      },
    });
    const runs = loadAllRuns(root);
    expect(runs).toHaveLength(2);
    expect(
      (runs[0]!.events[0] as Extract<RunLogEvent, { type: "run-start" }>).requirement,
    ).toBe("first");
  });

  it("loadAllRuns returns empty when no runs dir", () => {
    const empty = mkdtempSync(join(tmpdir(), "claw-runs-empty-"));
    try {
      expect(loadAllRuns(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("ignores non-.jsonl files in the runs dir", () => {
    mkdirSync(join(root, ".claw-squad/runs"), { recursive: true });
    writeFileSync(join(root, ".claw-squad/runs/notes.txt"), "hi");
    expect(loadAllRuns(root)).toEqual([]);
  });

  it("preserves the optional subagentName field on usage events", () => {
    const h = startRun(root);
    appendEvent(h, {
      type: "usage",
      ts: "t",
      role: "subagent",
      provider: "anthropic",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.01,
      subagentName: "research-helper",
    });
    const events = loadOneRun(h.path);
    expect(events).toHaveLength(1);
    const u = events[0]!;
    expect(u.type).toBe("usage");
    if (u.type === "usage") {
      expect(u.subagentName).toBe("research-helper");
    }
  });

  it("mirrors events to a secondary path when --log-json is set", () => {
    const mirror = join(root, "downstream", "feed.jsonl");
    const h = startRun(root, { mirrorPath: mirror });
    appendEvent(h, {
      type: "phase",
      ts: new Date().toISOString(),
      label: "planner.q1",
    });
    appendEvent(h, {
      type: "run-end",
      ts: new Date().toISOString(),
      reason: "complete",
      overall: { costUsd: 0.5, cacheSavedUsd: 0.1, calls: 3 },
    });

    const canonical = loadOneRun(h.path);
    const mirrored = loadOneRun(mirror);
    expect(canonical).toHaveLength(2);
    expect(mirrored).toHaveLength(2);
    expect(mirrored[0]!.type).toBe("phase");
    expect(mirrored[1]!.type).toBe("run-end");
  });

  it("mirror failure does not abort writes to the canonical log", () => {
    // A directory at the mirror path makes appendFileSync throw EISDIR.
    const mirror = join(root, "blocked-dir");
    mkdirSync(mirror, { recursive: true });
    const h = startRun(root, { mirrorPath: mirror });
    expect(() =>
      appendEvent(h, {
        type: "phase",
        ts: new Date().toISOString(),
        label: "still-runs",
      }),
    ).not.toThrow();
    expect(loadOneRun(h.path)).toHaveLength(1);
  });
});
