/**
 * State snapshots for resume.
 *
 * At the end of each outer-loop iteration the orchestrator dumps
 * SquadState to `.claw-squad/state.json`. Users can --resume from that
 * file instead of re-running the Planner from scratch. Handy when a
 * long run hits a budget cap, a network blip, or the user just closes
 * the terminal.
 *
 * What's persisted:
 *   - The full SquadState (requirement, clarifications, todos,
 *     reviewHistory, loopCount).
 *   - Run totals (tokens, cost) for accurate end-of-run reporting after
 *     a resume.
 *   - A schema version so future breaking changes to SquadState can be
 *     migrated or rejected cleanly.
 *
 * NOT persisted:
 *   - The provider/model config. That's by design — a user might want
 *     to resume with a different provider (e.g. the cloud model after
 *     the local Ollama server went down). Resume loads state only; the
 *     CLI re-resolves config from file + flags.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SquadState } from "./types.js";

const SCHEMA_VERSION = 1;
const SNAPSHOT_FILE = ".claw-squad/state.json";

export interface SnapshotTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  calls: number;
}

export interface Snapshot {
  schemaVersion: number;
  savedAt: string;
  state: SquadState;
  totals: SnapshotTotals;
}

export function snapshotPath(repoRoot: string): string {
  return join(repoRoot, SNAPSHOT_FILE);
}

export function saveSnapshot(
  repoRoot: string,
  state: SquadState,
  totals: SnapshotTotals,
): void {
  const path = snapshotPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const snap: Snapshot = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    state,
    totals,
  };
  writeFileSync(path, JSON.stringify(snap, null, 2) + "\n", "utf-8");
}

export function loadSnapshot(repoRoot: string): Snapshot | undefined {
  const path = snapshotPath(repoRoot);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8");
  let parsed: Snapshot;
  try {
    parsed = JSON.parse(raw) as Snapshot;
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${(err as Error).message}`);
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `snapshot schema mismatch: file=${parsed.schemaVersion} expected=${SCHEMA_VERSION}`,
    );
  }
  return parsed;
}
