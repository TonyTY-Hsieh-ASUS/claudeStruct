import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSnapshot, saveSnapshot, snapshotPath } from "../src/snapshot.js";
import type { SquadState } from "../src/types.js";

describe("snapshot", () => {
  let root: string;
  const state: SquadState = {
    requirement: "do a thing",
    clarifications: [{ question: "which?", answer: "that one" }],
    planReady: true,
    todos: [
      {
        id: "T1",
        title: "first",
        description: "first task",
        status: "pending",
        iterations: 0,
      },
    ],
    reviewHistory: [],
    loopCount: 0,
  };
  const totals = {
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    calls: 1,
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-snap-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("saveSnapshot writes to .claw-squad/state.json", () => {
    saveSnapshot(root, state, totals);
    expect(snapshotPath(root)).toBe(join(root, ".claw-squad/state.json"));
  });

  it("round-trips state and totals", () => {
    saveSnapshot(root, state, totals);
    const loaded = loadSnapshot(root);
    expect(loaded?.state.requirement).toBe(state.requirement);
    expect(loaded?.state.todos[0]?.id).toBe("T1");
    expect(loaded?.totals.costUsd).toBe(0.01);
    expect(loaded?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns undefined when no snapshot exists", () => {
    expect(loadSnapshot(root)).toBeUndefined();
  });

  it("rejects a snapshot from a different schema version", () => {
    // Fake a future-schema snapshot on disk.
    const path = snapshotPath(root);
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(root, ".claw-squad"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 999, savedAt: "x", state, totals }),
    );
    expect(() => loadSnapshot(root)).toThrow(/schema mismatch/);
  });
});
