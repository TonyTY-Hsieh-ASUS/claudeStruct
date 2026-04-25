/**
 * State snapshots for resume.
 *
 * At the end of each outer-loop iteration the orchestrator dumps
 * SquadState to `.claw-squad/state.json`. Users can --resume from that
 * file instead of re-running the Planner from scratch. Handy when a
 * long run hits a budget cap, a network blip, or the user just closes
 * the terminal.
 *
 * Schema versions:
 *   v1 — flat totals (one bucket). Pre-observability.
 *   v2 — per-role totals via `RunTotals.perRole` + `overall`.
 *   v3 — adds `RunTotals.bySubagent` for per-named-subagent attribution.
 *
 * v1 → v3 and v2 → v3 auto-migrate on load:
 *   - v1: flat totals fold into `overall`, per-role + bySubagent stay
 *     empty (we can't retroactively split historical data).
 *   - v2: totals shape is intact; we just initialize `bySubagent` to
 *     an empty record. Past runs that used subagents will show zero
 *     per-name attribution but everything else is preserved.
 * We warn once on load so the user knows the migrated view is
 * incomplete, not that data vanished.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SquadState } from "./types.js";
import {
  emptyRoleTotals,
  emptyRunTotals,
  type RoleTotals,
  type RunTotals,
} from "./totals.js";

const CURRENT_SCHEMA_VERSION = 3;
const SNAPSHOT_FILE = ".claw-squad/state.json";

/** Legacy v1 totals shape — only used by the migration path. */
interface LegacyV1Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  calls: number;
}

/** Legacy v2 RunTotals — same as current minus `bySubagent`. */
interface LegacyV2RunTotals {
  perRole: Record<string, RoleTotals>;
  overall: RoleTotals;
}

export interface Snapshot {
  schemaVersion: number;
  savedAt: string;
  state: SquadState;
  totals: RunTotals;
}

export function snapshotPath(repoRoot: string): string {
  return join(repoRoot, SNAPSHOT_FILE);
}

export function saveSnapshot(
  repoRoot: string,
  state: SquadState,
  totals: RunTotals,
): void {
  const path = snapshotPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const snap: Snapshot = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    state,
    totals,
  };
  writeFileSync(path, JSON.stringify(snap, null, 2) + "\n", "utf-8");
}

export interface LoadSnapshotOptions {
  onMigrate?: (from: number, to: number) => void;
}

export function loadSnapshot(
  repoRoot: string,
  options: LoadSnapshotOptions = {},
): Snapshot | undefined {
  const path = snapshotPath(repoRoot);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
  return normalizeSnapshot(parsed, options);
}

/** Exposed for unit tests. */
export function normalizeSnapshot(
  raw: unknown,
  options: LoadSnapshotOptions = {},
): Snapshot {
  if (!raw || typeof raw !== "object") {
    throw new Error("snapshot: root must be an object");
  }
  const s = raw as Partial<Snapshot> & { totals?: unknown };
  const version = typeof s.schemaVersion === "number" ? s.schemaVersion : 1;

  if (version === CURRENT_SCHEMA_VERSION) {
    return s as Snapshot;
  }
  if (version === 2) {
    options.onMigrate?.(2, CURRENT_SCHEMA_VERSION);
    // v2 → v3: only `bySubagent` is new. Keep totals intact.
    const legacy = s.totals as LegacyV2RunTotals | undefined;
    const migrated: RunTotals = legacy
      ? { ...legacy, bySubagent: {} }
      : emptyRunTotals();
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      savedAt: s.savedAt ?? new Date().toISOString(),
      state: s.state as SquadState,
      totals: migrated,
    };
  }
  if (version === 1) {
    options.onMigrate?.(1, CURRENT_SCHEMA_VERSION);
    const legacy = s.totals as LegacyV1Totals | undefined;
    const migrated = emptyRunTotals();
    if (legacy) {
      migrated.overall = {
        ...emptyRoleTotals(),
        inputTokens: legacy.inputTokens ?? 0,
        outputTokens: legacy.outputTokens ?? 0,
        cacheReadTokens: legacy.cacheReadTokens ?? 0,
        cacheCreationTokens: legacy.cacheCreationTokens ?? 0,
        costUsd: legacy.costUsd ?? 0,
        calls: legacy.calls ?? 0,
        // v1 didn't track anthropicCalls or cacheSavedUsd — leave zero.
      };
    }
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      savedAt: s.savedAt ?? new Date().toISOString(),
      state: s.state as SquadState,
      totals: migrated,
    };
  }
  throw new Error(
    `snapshot schema mismatch: file=${version} expected=${CURRENT_SCHEMA_VERSION} (no migration path)`,
  );
}
