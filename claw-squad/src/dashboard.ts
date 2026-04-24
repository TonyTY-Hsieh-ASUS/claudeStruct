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

import pc from "picocolors";
import {
  loadAllRuns,
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

export function loadSummaries(repoRoot: string): RunSummary[] {
  return loadAllRuns(repoRoot).map((r) => summarizeRun(r.events, r.path));
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
    lines.push(
      fmtRow(
        formatTimestamp(s.startedAt),
        s.reason ?? pc.yellow("…running"),
        "$" + s.overall.costUsd.toFixed(4),
        "$" + s.overall.cacheSavedUsd.toFixed(4),
        String(s.overall.calls),
        `${s.todosDone}✓ ${s.todosRolledBack}↺`,
        (s.requirement ?? "").slice(0, 50),
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
