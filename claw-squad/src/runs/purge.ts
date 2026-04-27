/**
 * Run-log retention pruning (TS-side equivalent of `cs logs purge`).
 *
 * `appendEvent` writes one JSONL file per run under
 * `.claw-squad/runs/<iso-timestamp>.jsonl`. Without retention, that
 * directory grows forever — fine for a developer laptop, problematic
 * for shared CI runners or the daemon-mode worker. This module deletes
 * files whose mtime is older than a caller-supplied window.
 *
 * The cutoff is mtime-based on purpose: the embedded `run-start` ts
 * inside the file is user/clock controlled, but the filesystem mtime
 * is monotonic on a single host. A run-log that hasn't been touched in
 * months is stale regardless of what its contents claim.
 *
 * Mirrors `claudestruct.redact.purge_runs` line-for-line so the two
 * tools have the same retention semantics.
 */

import { readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PurgeOptions {
  /** Files older than this many milliseconds are deleted. */
  olderThanMs: number;
  /** When true, return the candidate list without unlinking. */
  dryRun?: boolean;
  /**
   * Override "now" for testability. Defaults to `Date.now()`.
   * Numbers are interpreted as ms-since-epoch.
   */
  now?: number;
}

/**
 * Delete `<repoRoot>/.claw-squad/runs/*.jsonl` files older than the
 * cutoff. Returns the absolute paths that were (or would be) deleted,
 * sorted by path. Missing directory → empty array.
 */
export function purgeRuns(repoRoot: string, options: PurgeOptions): string[] {
  const dir = join(repoRoot, ".claw-squad", "runs");
  if (!existsSync(dir)) return [];
  const now = options.now ?? Date.now();
  const cutoffMs = now - options.olderThanMs;

  const victims: string[] = [];
  // Sort the directory listing so callers (and tests) see a stable
  // order. ISO-timestamped filenames sort chronologically anyway.
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      // File vanished between readdir and stat — nothing to do.
      continue;
    }
    if (mtimeMs >= cutoffMs) continue;
    victims.push(full);
    if (options.dryRun) continue;
    try {
      rmSync(full, { force: true });
    } catch {
      // Best-effort; the next purge run will pick it up if perms change.
    }
  }
  return victims;
}

/** Convenience: convert days to milliseconds. */
export function daysToMs(days: number): number {
  return Math.max(0, days) * 24 * 60 * 60 * 1000;
}
