/**
 * MCP tool handlers for `claw-squad mcp`.
 *
 * Pure dict-in / dict-out so the bootstrap in `mcp/server.ts` stays
 * a thin protocol shim and tests can drive these directly without
 * touching the MCP SDK.
 *
 * Mirrors the shape claudestruct ships under `cs mcp` (see
 * `claudestruct/src/claudestruct/mcp_handlers.py`). Tools exposed:
 *   - `claw_squad_dashboard`       — list runs as JSON
 *   - `claw_squad_dashboard_diff`  — diff two runs (b - a)
 *   - `claw_squad_runs_list`       — list run-log files with size + age
 *   - `claw_squad_runs_purge`      — delete runs older than N days
 *
 * Read-only by design: the full `claw_squad_run` orchestrator dispatch
 * is intentionally NOT exposed in this PR. Driving runOrchestrator
 * through MCP needs proper streaming notifications + a non-interactive
 * UI shim (no Planner clarifications); tracked as a follow-up.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  diffRuns,
  type DiffReport,
  formatJson,
  loadSummaries,
  type RunSummary,
} from "../dashboard.js";
import { runIdFromPath } from "../runs/log.js";
import { purgeRuns } from "../runs/purge.js";

/** Generic shape every handler accepts so the protocol-shim layer can
 * dispatch by tool name without per-tool type plumbing. */
export type HandlerArgs = Record<string, unknown>;

/** All handlers return a JSON-serialisable object so the SDK can wrap
 * it in a `tools/call` response without further translation. */
export type HandlerResult = Record<string, unknown>;

// --- helpers --------------------------------------------------------

function _resolveRoot(args: HandlerArgs): string {
  const v = args["repo_root"];
  if (typeof v === "string" && v.length > 0) return v;
  return process.cwd();
}

function _string(args: HandlerArgs, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string arg: ${key}`);
  }
  return v;
}

function _optionalString(args: HandlerArgs, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new Error(`arg ${key} must be a string, got ${typeof v}`);
  }
  return v.length > 0 ? v : undefined;
}

function _optionalNumber(args: HandlerArgs, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new Error(`arg ${key} must be a number`);
  }
  return v;
}

function _optionalBool(args: HandlerArgs, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new Error(`arg ${key} must be a boolean`);
  }
  return v;
}

// --- claw_squad_dashboard -------------------------------------------

/**
 * List rolled-up runs from `<repoRoot>/.claw-squad/runs/`.
 *
 * Args:
 *   - `repo_root` (optional, default cwd)
 *   - `filter` (optional substring on the requirement column)
 *
 * Returns ``{runs: RunSummary[]}``. JSON shape parity with
 * `claw-squad dashboard --json`, so consumers can pipe identical
 * downstream tools.
 */
export function handleDashboard(args: HandlerArgs): HandlerResult {
  const root = _resolveRoot(args);
  const filter = _optionalString(args, "filter");
  const summaries: RunSummary[] = loadSummaries(root, { filter });
  // formatJson returns the canonical wire format; parse so we hand
  // back a structured object instead of a string.
  return { runs: JSON.parse(formatJson(summaries)) };
}

// --- claw_squad_dashboard_diff --------------------------------------

/**
 * Compare two run summaries by run id (filename without ``.jsonl``).
 *
 * Args:
 *   - `repo_root` (optional, default cwd)
 *   - `run_a` (required, "earlier" run)
 *   - `run_b` (required, "later" run; the diff is b − a)
 *
 * Returns ``{diff: DiffReport}``. Empty diff (b structurally
 * identical to a) returns the same shape with all-zero fields.
 */
export function handleDashboardDiff(args: HandlerArgs): HandlerResult {
  const root = _resolveRoot(args);
  const runA = _string(args, "run_a");
  const runB = _string(args, "run_b");
  const all = loadSummaries(root);
  const a = all.find((s) => runIdFromPath(s.path) === runA);
  const b = all.find((s) => runIdFromPath(s.path) === runB);
  if (!a) {
    throw new Error(`run_a not found: ${runA}`);
  }
  if (!b) {
    throw new Error(`run_b not found: ${runB}`);
  }
  const diff: DiffReport = diffRuns(a, b);
  return { diff };
}

// --- claw_squad_runs_list -------------------------------------------

/**
 * List run-log files with mtime + size, sorted by mtime descending.
 *
 * Args:
 *   - `repo_root` (optional, default cwd)
 *
 * Returns ``{runs: [{run_id, path, size_bytes, mtime_ms, age_ms}]}``.
 * Mirrors the table shape ``claw-squad runs list`` already emits
 * but without the human-formatting (consumers want raw numbers).
 */
export function handleRunsList(args: HandlerArgs): HandlerResult {
  const root = _resolveRoot(args);
  const dir = join(root, ".claw-squad", "runs");
  if (!existsSync(dir)) return { runs: [] };
  const now = Date.now();
  const entries: {
    run_id: string;
    path: string;
    size_bytes: number;
    mtime_ms: number;
    age_ms: number;
  }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      // Race: file vanished between readdir and stat. Skip.
      continue;
    }
    entries.push({
      run_id: name.replace(/\.jsonl$/, ""),
      path: full,
      size_bytes: st.size,
      mtime_ms: st.mtimeMs,
      age_ms: now - st.mtimeMs,
    });
  }
  entries.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return { runs: entries };
}

// --- claw_squad_runs_purge ------------------------------------------

const _MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Delete (or with `dry_run=true`, list) run-log files older than
 * ``older_than_days`` days. Mirrors `claw-squad runs purge`.
 *
 * Args:
 *   - `repo_root` (optional, default cwd)
 *   - `older_than_days` (required positive number)
 *   - `dry_run` (optional, default false; when true, returns the
 *     candidate list without deleting)
 *
 * Returns ``{deleted: string[], dry_run: boolean}``. ``deleted`` is
 * the list of absolute paths the call removed (or would remove).
 */
export function handleRunsPurge(args: HandlerArgs): HandlerResult {
  const root = _resolveRoot(args);
  const days = _optionalNumber(args, "older_than_days");
  if (days === undefined || days < 0) {
    throw new Error("older_than_days must be a non-negative number");
  }
  const dryRun = _optionalBool(args, "dry_run") ?? false;
  const deleted = purgeRuns(root, {
    olderThanMs: days * _MS_PER_DAY,
    dryRun,
  });
  return { deleted, dry_run: dryRun };
}

// --- registry -------------------------------------------------------

/**
 * Tool descriptor passed to the SDK in `mcp/server.ts`. Keeping
 * descriptions / input schemas in code means MCP clients see the
 * same surface the handlers actually accept.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: HandlerArgs) => HandlerResult;
}

export const MCP_TOOLS: ToolDescriptor[] = [
  {
    name: "claw_squad_dashboard",
    description:
      "List rolled-up claw-squad runs (read-only). Same shape as `claw-squad dashboard --json`.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: {
          type: "string",
          description:
            "Repo root containing `.claw-squad/runs/`. Defaults to cwd.",
        },
        filter: {
          type: "string",
          description:
            "Case-insensitive substring filter on the requirement.",
        },
      },
    },
    handler: handleDashboard,
  },
  {
    name: "claw_squad_dashboard_diff",
    description:
      "Diff two run summaries by run id (b − a). Mirrors `claw-squad dashboard diff`.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string" },
        run_a: {
          type: "string",
          description: "Run id of the earlier run (filename without .jsonl).",
        },
        run_b: {
          type: "string",
          description: "Run id of the later run.",
        },
      },
      required: ["run_a", "run_b"],
    },
    handler: handleDashboardDiff,
  },
  {
    name: "claw_squad_runs_list",
    description:
      "List run-log files under `.claw-squad/runs/` with size + age (mtime descending).",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string" },
      },
    },
    handler: handleRunsList,
  },
  {
    name: "claw_squad_runs_purge",
    description:
      "Delete run-log files older than N days. Set `dry_run=true` to preview without deleting.",
    inputSchema: {
      type: "object",
      properties: {
        repo_root: { type: "string" },
        older_than_days: {
          type: "number",
          description: "Files older than this many days are deleted.",
        },
        dry_run: {
          type: "boolean",
          description:
            "When true, returns candidates without unlinking. Default false.",
        },
      },
      required: ["older_than_days"],
    },
    handler: handleRunsPurge,
  },
];
