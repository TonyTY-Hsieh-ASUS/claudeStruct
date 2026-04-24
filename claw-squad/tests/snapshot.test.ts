import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSnapshot, saveSnapshot, snapshotPath } from "../src/snapshot.js";
import { emptyRunTotals } from "../src/totals.js";
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
  const totals = emptyRunTotals();
  totals.overall.inputTokens = 100;
  totals.overall.outputTokens = 200;
  totals.overall.cacheReadTokens = 50;
  totals.overall.costUsd = 0.01;
  totals.overall.calls = 1;
  totals.perRole.coder.inputTokens = 100;
  totals.perRole.coder.costUsd = 0.01;
  totals.perRole.coder.calls = 1;

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

  it("round-trips state and totals (v2)", () => {
    saveSnapshot(root, state, totals);
    const loaded = loadSnapshot(root);
    expect(loaded?.schemaVersion).toBe(2);
    expect(loaded?.state.requirement).toBe(state.requirement);
    expect(loaded?.state.todos[0]?.id).toBe("T1");
    expect(loaded?.totals.overall.costUsd).toBe(0.01);
    expect(loaded?.totals.perRole.coder.calls).toBe(1);
    expect(loaded?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns undefined when no snapshot exists", () => {
    expect(loadSnapshot(root)).toBeUndefined();
  });

  it("migrates a v1 snapshot and folds flat totals into overall", () => {
    // Hand-craft a v1 on disk — the flat totals shape predates per-role.
    const path = snapshotPath(root);
    mkdirSync(join(root, ".claw-squad"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        savedAt: "2026-01-01T00:00:00.000Z",
        state,
        totals: {
          inputTokens: 500,
          outputTokens: 300,
          cacheReadTokens: 200,
          cacheCreationTokens: 100,
          costUsd: 0.25,
          calls: 7,
        },
      }),
    );

    let migrated: { from: number; to: number } | undefined;
    const loaded = loadSnapshot(root, {
      onMigrate: (from, to) => {
        migrated = { from, to };
      },
    });

    expect(migrated).toEqual({ from: 1, to: 2 });
    expect(loaded?.schemaVersion).toBe(2);
    expect(loaded?.totals.overall.inputTokens).toBe(500);
    expect(loaded?.totals.overall.costUsd).toBe(0.25);
    expect(loaded?.totals.overall.calls).toBe(7);
    // Per-role stays empty — we can't retroactively attribute.
    expect(loaded?.totals.perRole.planner.calls).toBe(0);
    expect(loaded?.totals.perRole.coder.calls).toBe(0);
  });

  it("rejects a snapshot from an unknown future schema version", () => {
    const path = snapshotPath(root);
    mkdirSync(join(root, ".claw-squad"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 999, savedAt: "x", state, totals }),
    );
    expect(() => loadSnapshot(root)).toThrow(/schema mismatch/);
  });
});
