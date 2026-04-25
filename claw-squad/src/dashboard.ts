/**
 * Cost dashboard.
 *
 * Folds every JSONL run log under `.claw-squad/runs/` back into a
 * one-row-per-run summary: date, requirement, outcome, cost, cache
 * ROI, per-role cost. This is the "what did claw-squad spend?" view
 * the CLI reports on demand via `claw-squad dashboard`.
 *
 * Kept intentionally read-only — the run log is the source of truth;
 * this module never mutates state. That makes it safe to run in the
 * background (later: `--watch`) without worrying about races.
 */

import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import {
  loadAllRuns,
  loadOneRun,
  pathFromRunId,
  type RunLogEvent,
} from "./runs/log.js";
import { ROLE_BUCKETS, type RoleBucket } from "./types.js";

export interface RunSummary {
  path: string;
  startedAt?: string;
  requirement?: string;
  reason?: string;
  overall: {
    costUsd: number;
    cacheSavedUsd: number;
    calls: number;
  };
  perRole: Record<RoleBucket, { costUsd: number; calls: number }>;
  /**
   * Per-named-subagent rollup. Keys are subagent names from
   * AgentConfig.subagents[*].name. Empty for runs that didn't use
   * subagents or that predate the per-name attribution (PR-A).
   */
  bySubagent: Record<string, { costUsd: number; calls: number }>;
  todosDone: number;
  todosRolledBack: number;
}

function emptyPerRole(): RunSummary["perRole"] {
  const out = {} as RunSummary["perRole"];
  for (const b of ROLE_BUCKETS) out[b] = { costUsd: 0, calls: 0 };
  return out;
}

/** Collapse a single run's events into a summary row. */
export function summarizeRun(
  events: RunLogEvent[],
  path: string,
): RunSummary {
  const out: RunSummary = {
    path,
    overall: { costUsd: 0, cacheSavedUsd: 0, calls: 0 },
    perRole: emptyPerRole(),
    bySubagent: {},
    todosDone: 0,
    todosRolledBack: 0,
  };
  for (const e of events) {
    switch (e.type) {
      case "run-start":
        out.startedAt = e.ts;
        out.requirement = e.requirement;
        break;
      case "usage":
        out.overall.costUsd += e.costUsd;
        out.overall.calls += 1;
        out.perRole[e.role].costUsd += e.costUsd;
        out.perRole[e.role].calls += 1;
        if (e.subagentName) {
          const cur = out.bySubagent[e.subagentName] ?? { costUsd: 0, calls: 0 };
          out.bySubagent[e.subagentName] = {
            costUsd: cur.costUsd + e.costUsd,
            calls: cur.calls + 1,
          };
        }
        break;
      case "todo-complete":
        if (e.rolledBack) out.todosRolledBack += 1;
        else out.todosDone += 1;
        break;
      case "run-end":
        out.reason = e.reason;
        // run-end carries the authoritative cacheSavedUsd — we can't
        // reconstruct it from per-call usage events without replaying
        // the provider rate table.
        out.overall.cacheSavedUsd = e.overall.cacheSavedUsd;
        break;
    }
  }
  return out;
}

export interface LoadSummariesOptions {
  /**
   * Case-insensitive substring filter applied to `requirement`. Runs
   * with no requirement (interrupted before run-start landed) are
   * always excluded when this is set.
   */
  filter?: string;
}

export function loadSummaries(
  repoRoot: string,
  opts: LoadSummariesOptions = {},
): RunSummary[] {
  const all = loadAllRuns(repoRoot).map((r) => summarizeRun(r.events, r.path));
  if (!opts.filter) return all;
  const needle = opts.filter.toLowerCase();
  return all.filter(
    (s) => s.requirement && s.requirement.toLowerCase().includes(needle),
  );
}

/**
 * Machine-readable rendering. Stable shape: an array of RunSummary in
 * the same order as the human table. Consumers can pipe it into jq /
 * a spreadsheet / a regression script.
 */
export function formatJson(summaries: RunSummary[]): string {
  return JSON.stringify(summaries, null, 2);
}

/**
 * Build the "top N subagents by cost" string we tuck into the human
 * table. Returns "" when no subagents ran.
 */
function topSubagentsHint(s: RunSummary, n = 2): string {
  const names = Object.keys(s.bySubagent);
  if (names.length === 0) return "";
  const sorted = names
    .map((name) => ({ name, ...s.bySubagent[name]! }))
    .sort((a, b) => b.costUsd - a.costUsd);
  return (
    " · " +
    sorted
      .slice(0, n)
      .map((r) => `${r.name}:$${r.costUsd.toFixed(3)}`)
      .join(",")
  );
}

/**
 * Render the summaries as a plain terminal table. One line per run,
 * plus a totals row at the bottom. Kept picocolors-minimal so copying
 * the output into an email or a PR comment doesn't glue escape codes
 * onto the reader.
 */
export function formatTable(summaries: RunSummary[]): string {
  if (summaries.length === 0) {
    return pc.dim("no runs logged yet (.claw-squad/runs/ is empty)");
  }
  const lines: string[] = [];
  lines.push(
    pc.bold(
      fmtRow(
        "started",
        "outcome",
        "cost",
        "saved",
        "calls",
        "todos",
        "requirement",
      ),
    ),
  );
  lines.push(pc.dim("─".repeat(100)));
  const totals = { costUsd: 0, cacheSavedUsd: 0, calls: 0, done: 0, rolled: 0 };
  for (const s of summaries) {
    const reqWithSubagents =
      (s.requirement ?? "").slice(0, 50) + topSubagentsHint(s);
    lines.push(
      fmtRow(
        formatTimestamp(s.startedAt),
        s.reason ?? pc.yellow("…running"),
        "$" + s.overall.costUsd.toFixed(4),
        "$" + s.overall.cacheSavedUsd.toFixed(4),
        String(s.overall.calls),
        `${s.todosDone}✓ ${s.todosRolledBack}↺`,
        reqWithSubagents,
      ),
    );
    totals.costUsd += s.overall.costUsd;
    totals.cacheSavedUsd += s.overall.cacheSavedUsd;
    totals.calls += s.overall.calls;
    totals.done += s.todosDone;
    totals.rolled += s.todosRolledBack;
  }
  lines.push(pc.dim("─".repeat(100)));
  lines.push(
    pc.bold(
      fmtRow(
        "TOTAL",
        "",
        "$" + totals.costUsd.toFixed(4),
        "$" + totals.cacheSavedUsd.toFixed(4),
        String(totals.calls),
        `${totals.done}✓ ${totals.rolled}↺`,
        "",
      ),
    ),
  );
  return lines.join("\n");
}

function fmtRow(...cols: string[]): string {
  const widths = [24, 10, 11, 11, 7, 10, 50];
  return cols.map((c, i) => c.padEnd(widths[i] ?? 10)).join(" ");
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "—";
  // Short human form: "2026-04-24 05:27:03"
  return iso.replace("T", " ").slice(0, 19);
}

// ---------- Run-vs-run diff (PR-B) ----------

/**
 * Load a single run by its ID (filename without `.jsonl`). Returns
 * undefined if not found — callers can decide whether that's an
 * error or a stale reference.
 */
export function loadSummaryById(
  repoRoot: string,
  runId: string,
): RunSummary | undefined {
  const path = pathFromRunId(repoRoot, runId);
  if (!existsSync(path)) return undefined;
  return summarizeRun(loadOneRun(path), path);
}

export interface DiffReport {
  /** The run we measured against (older / baseline). */
  a: { runId: string; startedAt?: string; requirement?: string; reason?: string };
  /** The run we're comparing (newer / candidate). */
  b: { runId: string; startedAt?: string; requirement?: string; reason?: string };
  /** Cost delta on the overall bucket (b - a). Positive = regression. */
  overallCostDeltaUsd: number;
  /** Per-role deltas keyed by RoleBucket. */
  perRoleDelta: Record<RoleBucket, number>;
  /** Per-named-subagent deltas. Keys appearing in either run land here. */
  bySubagentDelta: Record<string, number>;
  /** Outcome change, e.g. "complete → blocked", or undefined when same. */
  outcomeChange?: string;
  /** Diff in TODO completion counts. */
  todosDoneDelta: number;
  todosRolledBackDelta: number;
}

/** Build a structured diff between two runs. b is the "newer" side. */
export function diffRuns(a: RunSummary, b: RunSummary): DiffReport {
  const perRoleDelta = {} as Record<RoleBucket, number>;
  for (const r of ROLE_BUCKETS) {
    perRoleDelta[r] = b.perRole[r].costUsd - a.perRole[r].costUsd;
  }
  const bySubagentDelta: Record<string, number> = {};
  const subagentNames = new Set<string>([
    ...Object.keys(a.bySubagent),
    ...Object.keys(b.bySubagent),
  ]);
  for (const name of subagentNames) {
    bySubagentDelta[name] =
      (b.bySubagent[name]?.costUsd ?? 0) - (a.bySubagent[name]?.costUsd ?? 0);
  }
  return {
    a: {
      runId: runIdFromSummary(a),
      startedAt: a.startedAt,
      requirement: a.requirement,
      reason: a.reason,
    },
    b: {
      runId: runIdFromSummary(b),
      startedAt: b.startedAt,
      requirement: b.requirement,
      reason: b.reason,
    },
    overallCostDeltaUsd: b.overall.costUsd - a.overall.costUsd,
    perRoleDelta,
    bySubagentDelta,
    outcomeChange:
      a.reason !== b.reason ? `${a.reason ?? "—"} → ${b.reason ?? "—"}` : undefined,
    todosDoneDelta: b.todosDone - a.todosDone,
    todosRolledBackDelta: b.todosRolledBack - a.todosRolledBack,
  };
}

function runIdFromSummary(s: RunSummary): string {
  const base = s.path.split("/").pop() ?? s.path;
  return base.replace(/\.jsonl$/, "");
}

export function formatDiff(report: DiffReport): string {
  const lines: string[] = [];
  lines.push(pc.bold(`A: ${report.a.runId}`));
  lines.push(pc.dim(`   ${report.a.requirement ?? ""}  (${report.a.reason ?? "—"})`));
  lines.push(pc.bold(`B: ${report.b.runId}`));
  lines.push(pc.dim(`   ${report.b.requirement ?? ""}  (${report.b.reason ?? "—"})`));
  lines.push("");
  if (report.outcomeChange) {
    lines.push(pc.yellow(`outcome: ${report.outcomeChange}`));
  }
  lines.push(
    `overall cost: ${signedDollars(report.overallCostDeltaUsd)}`,
  );
  lines.push(`todos done:   ${signedInt(report.todosDoneDelta)}`);
  lines.push(`rolled back:  ${signedInt(report.todosRolledBackDelta)}`);
  lines.push("");
  lines.push(pc.bold("per-role cost delta"));
  for (const r of ROLE_BUCKETS) {
    const d = report.perRoleDelta[r];
    if (d === 0) continue;
    lines.push(`  ${r.padEnd(10)} ${signedDollars(d)}`);
  }
  const subNames = Object.keys(report.bySubagentDelta).filter(
    (n) => report.bySubagentDelta[n] !== 0,
  );
  if (subNames.length > 0) {
    lines.push("");
    lines.push(pc.bold("per-subagent cost delta"));
    // Sort so the worst regression sits at the top — that's the row
    // the operator actually wants to look at.
    subNames.sort(
      (a, b) =>
        (report.bySubagentDelta[b] ?? 0) - (report.bySubagentDelta[a] ?? 0),
    );
    for (const n of subNames) {
      lines.push(`  ${n.padEnd(20)} ${signedDollars(report.bySubagentDelta[n]!)}`);
    }
  }
  return lines.join("\n");
}

export function formatDiffJson(report: DiffReport): string {
  return JSON.stringify(report, null, 2);
}

function signedDollars(n: number): string {
  const sign = n > 0 ? pc.red("+") : n < 0 ? pc.green("-") : " ";
  return `${sign}$${Math.abs(n).toFixed(4)}`;
}

function signedInt(n: number): string {
  if (n > 0) return pc.red(`+${n}`);
  if (n < 0) return pc.green(`${n}`);
  return ` ${n}`;
}

// ---------- Watch mode (PR-B) ----------

export interface WatchHandle {
  /** Stop the watcher and clear any pending interval. */
  stop: () => void;
}

/**
 * Re-fold the runs directory on a regular cadence and call `sink`
 * with the latest summaries. Combines `fs.watch` (for low-latency
 * reaction to new files) with a polling interval (for in-flight
 * append-only writes that don't trigger a directory event).
 *
 * Returns a `stop()` handle so the CLI can clean up on Ctrl-C.
 */
export function watchSummaries(
  repoRoot: string,
  intervalMs: number,
  sink: (summaries: RunSummary[]) => void,
): WatchHandle {
  const dir = join(repoRoot, ".claw-squad", "runs");
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    try {
      sink(loadSummariesSafe(repoRoot));
    } catch {
      // The dashboard view should never crash the watcher — a
      // half-written line will be picked up on the next tick.
    }
  };

  // Fire once immediately so the user sees current state without
  // waiting a full interval.
  tick();
  const timer = setInterval(tick, intervalMs);
  // Keep timer from blocking process exit when the orchestrator finishes.
  timer.unref?.();

  // fs.watch is best-effort across platforms; some return ENOENT
  // until the directory exists. Wrap in try/catch.
  let fsWatcher: ReturnType<typeof watch> | undefined;
  try {
    if (existsSync(dir)) {
      fsWatcher = watch(dir, { persistent: false }, () => tick());
    }
  } catch {
    // Polling alone is sufficient — fs.watch is a latency optimization.
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      try {
        fsWatcher?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function loadSummariesSafe(repoRoot: string): RunSummary[] {
  try {
    return loadAllRuns(repoRoot).map((r) => summarizeRun(r.events, r.path));
  } catch {
    return [];
  }
}
