/**
 * Per-run event log.
 *
 * Every orchestrator run writes a single JSONL file under
 * `.claw-squad/runs/<iso-timestamp>.jsonl`. Each line is one event:
 *
 *   {"type":"run-start","ts":"...","requirement":"...","config":{...}}
 *   {"type":"usage","ts":"...","role":"planner","costUsd":0.01,...}
 *   {"type":"todo-complete","ts":"...","id":"T1","iterations":2}
 *   {"type":"run-end","ts":"...","reason":"complete","totals":{...}}
 *
 * JSONL (one JSON object per line) is chosen because:
 *   - Crash-safe: an interrupted run still has a valid, tail-readable
 *     log. No "we never wrote the closing bracket" pathology.
 *   - Append-only: each event is a single fsync-able line.
 *   - Tailable: `tail -f runs/<latest>.jsonl | jq .` works today.
 *
 * The dashboard subcommand folds this stream back into a per-run
 * summary. Tests round-trip append → load → fold.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RoleBucket } from "../types.js";

export interface RunLogHandle {
  /** Absolute path to the .jsonl file. */
  path: string;
  /** When this run started (used as filename base). */
  startedAt: string;
}

export type RunLogEvent =
  | {
      type: "run-start";
      ts: string;
      requirement: string;
      /** Lightweight config snapshot for later audit. */
      config: {
        repoRoot: string;
        githubEnabled: boolean;
        sandboxEnabled: boolean;
        maxLoops: number;
        maxReviewRounds: number;
      };
    }
  | {
      type: "usage";
      ts: string;
      role: RoleBucket;
      /** Provider name from the underlying Provider ("anthropic", "openai", ...). */
      provider: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number;
      /**
       * Set when role is "subagent" and the call targeted a named
       * subagent. The dashboard uses this to attribute spend per
       * subagent. Omitted for role calls (planner/coder/reviewer).
       */
      subagentName?: string;
    }
  | {
      type: "phase";
      ts: string;
      /** Free-form phase label ("planner.clarification", "coder.round.2", ...). */
      label: string;
      message?: string;
    }
  | {
      type: "todo-complete";
      ts: string;
      id: string;
      title: string;
      iterations: number;
      rolledBack?: boolean;
    }
  | {
      type: "run-end";
      ts: string;
      reason: "complete" | "max_loops" | "blocked" | "aborted";
      overall: {
        costUsd: number;
        cacheSavedUsd: number;
        calls: number;
      };
    };

/**
 * Open a run log. Creates the runs directory if missing and returns a
 * handle with the file path. First write to the file happens on the
 * first appendEvent call — we don't touch disk until there's content.
 */
export function startRun(repoRoot: string): RunLogHandle {
  const dir = join(repoRoot, ".claw-squad", "runs");
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  // Filesystems hate `:` in filenames — flatten to something safe.
  const slug = startedAt.replace(/[:.]/g, "-");
  const path = join(dir, `${slug}.jsonl`);
  return { path, startedAt };
}

export function appendEvent(handle: RunLogHandle, event: RunLogEvent): void {
  appendFileSync(handle.path, JSON.stringify(event) + "\n", "utf-8");
}

/**
 * Load every JSONL file under `.claw-squad/runs/` and return the
 * parsed events keyed by path. Malformed lines are skipped with a
 * warning — one bad line shouldn't hide the rest of history.
 */
export function loadAllRuns(
  repoRoot: string,
  log?: (msg: string) => void,
): Array<{ path: string; events: RunLogEvent[] }> {
  const dir = join(repoRoot, ".claw-squad", "runs");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort(); // ISO-timestamped filenames sort chronologically.
  return files.map((f) => ({
    path: join(dir, f),
    events: loadOneRun(join(dir, f), log),
  }));
}

export function loadOneRun(
  path: string,
  log?: (msg: string) => void,
): RunLogEvent[] {
  const raw = readFileSync(path, "utf-8");
  const out: RunLogEvent[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as RunLogEvent);
    } catch {
      log?.(`skipping malformed line ${i + 1} in ${path}`);
    }
  }
  return out;
}
