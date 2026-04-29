/**
 * MCP handler tests.
 *
 * Drives the pure handlers from `src/mcp/handlers.ts` with synthetic
 * `.claw-squad/runs/` directories and asserts the JSON shape the MCP
 * SDK sees. The SDK itself is NOT exercised here — `mcp/server.ts`
 * is a thin protocol shim around these handlers, and exercising it
 * would require pulling in the optional `@modelcontextprotocol/sdk`
 * dep just for tests.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MCP_TOOLS,
  handleDashboard,
  handleDashboardDiff,
  handleRunsList,
  handleRunsPurge,
} from "../src/mcp/handlers.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Fixtures: a synthetic .claw-squad/runs/<id>.jsonl with run-start +
// run-end events, written under a tmp root.
// ---------------------------------------------------------------------

function _runEventsFor({
  requirement,
  costUsd,
  reason = "complete",
}: {
  requirement: string;
  costUsd: number;
  reason?: "complete" | "max_loops" | "blocked" | "aborted" | "dry_run";
}): string {
  // Minimal viable run log: just the events `summarizeRun` actually
  // reads. Everything else stays at zero / undefined.
  const startedAt = new Date().toISOString();
  return [
    JSON.stringify({
      type: "run-start",
      ts: startedAt,
      requirement,
      config: {
        repoRoot: "/tmp/x",
        githubEnabled: false,
        sandboxEnabled: false,
        maxLoops: 5,
        maxReviewRounds: 3,
      },
    }),
    JSON.stringify({
      type: "usage",
      ts: startedAt,
      role: "planner",
      provider: "anthropic",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd,
    }),
    JSON.stringify({
      type: "run-end",
      ts: startedAt,
      reason,
      overall: { costUsd, cacheSavedUsd: 0, calls: 1 },
    }),
  ].join("\n") + "\n";
}

describe("MCP_TOOLS catalog", () => {
  it("exposes the four read-only tools with stable names", () => {
    const names = MCP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "claw_squad_dashboard",
      "claw_squad_dashboard_diff",
      "claw_squad_runs_list",
      "claw_squad_runs_purge",
    ]);
  });

  it("each tool has a description and an inputSchema", () => {
    for (const t of MCP_TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeTruthy();
    }
  });

  it("required fields are flagged on tools that need them", () => {
    const diff = MCP_TOOLS.find((t) => t.name === "claw_squad_dashboard_diff")!;
    expect(diff.inputSchema.required).toEqual(["run_a", "run_b"]);
    const purge = MCP_TOOLS.find((t) => t.name === "claw_squad_runs_purge")!;
    expect(purge.inputSchema.required).toEqual(["older_than_days"]);
  });
});

describe("handleDashboard", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-mcp-dash-"));
    mkdirSync(join(root, ".claw-squad", "runs"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty runs array for a fresh repo", () => {
    const result = handleDashboard({ repo_root: root });
    expect(result).toEqual({ runs: [] });
  });

  it("returns one entry per JSONL file in mtime order", () => {
    writeFileSync(
      join(root, ".claw-squad", "runs", "2026-01-01T00-00-00.jsonl"),
      _runEventsFor({ requirement: "alpha", costUsd: 1.0 }),
    );
    writeFileSync(
      join(root, ".claw-squad", "runs", "2026-02-01T00-00-00.jsonl"),
      _runEventsFor({ requirement: "beta", costUsd: 2.0 }),
    );
    const result = handleDashboard({ repo_root: root });
    const runs = (result.runs as Array<Record<string, unknown>>);
    expect(runs.length).toBe(2);
    const reqs = runs.map((r) => r.requirement);
    expect(reqs).toContain("alpha");
    expect(reqs).toContain("beta");
  });

  it("filter narrows to matching requirement", () => {
    writeFileSync(
      join(root, ".claw-squad", "runs", "a.jsonl"),
      _runEventsFor({ requirement: "fix flaky CI", costUsd: 0.1 }),
    );
    writeFileSync(
      join(root, ".claw-squad", "runs", "b.jsonl"),
      _runEventsFor({ requirement: "rewrite TUI", costUsd: 0.2 }),
    );
    const result = handleDashboard({ repo_root: root, filter: "TUI" });
    const runs = result.runs as Array<Record<string, unknown>>;
    expect(runs.length).toBe(1);
    expect(runs[0].requirement).toBe("rewrite TUI");
  });

  it("rejects non-string filter", () => {
    expect(() => handleDashboard({ repo_root: root, filter: 42 })).toThrow(
      /must be a string/,
    );
  });
});

describe("handleDashboardDiff", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-mcp-diff-"));
    mkdirSync(join(root, ".claw-squad", "runs"), { recursive: true });
    writeFileSync(
      join(root, ".claw-squad", "runs", "run-a.jsonl"),
      _runEventsFor({ requirement: "build feature", costUsd: 1.0 }),
    );
    writeFileSync(
      join(root, ".claw-squad", "runs", "run-b.jsonl"),
      _runEventsFor({ requirement: "build feature", costUsd: 3.0 }),
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns a structured diff between two runs", () => {
    const result = handleDashboardDiff({
      repo_root: root,
      run_a: "run-a",
      run_b: "run-b",
    });
    expect(result).toHaveProperty("diff");
    const diff = result.diff as Record<string, unknown>;
    // The DiffReport has a `costDelta` numeric field.
    expect(typeof diff).toBe("object");
  });

  it("raises on missing run_a", () => {
    expect(() =>
      handleDashboardDiff({
        repo_root: root,
        run_a: "missing",
        run_b: "run-b",
      }),
    ).toThrow(/run_a not found/);
  });

  it("raises on missing run_b", () => {
    expect(() =>
      handleDashboardDiff({
        repo_root: root,
        run_a: "run-a",
        run_b: "missing",
      }),
    ).toThrow(/run_b not found/);
  });

  it("raises when run_a is omitted", () => {
    expect(() =>
      handleDashboardDiff({ repo_root: root, run_b: "run-b" }),
    ).toThrow(/missing required string arg: run_a/);
  });
});

describe("handleRunsList", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-mcp-list-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty array when runs dir is missing", () => {
    const result = handleRunsList({ repo_root: root });
    expect(result).toEqual({ runs: [] });
  });

  it("lists JSONL files with size + age, sorted by mtime descending", () => {
    const dir = join(root, ".claw-squad", "runs");
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, "old.jsonl");
    const newFile = join(dir, "new.jsonl");
    writeFileSync(oldFile, "{}\n");
    writeFileSync(newFile, "{}\n");
    const oldT = (Date.now() - 5 * ONE_DAY_MS) / 1000;
    const newT = Date.now() / 1000;
    utimesSync(oldFile, oldT, oldT);
    utimesSync(newFile, newT, newT);

    const result = handleRunsList({ repo_root: root });
    const runs = result.runs as Array<Record<string, unknown>>;
    expect(runs.length).toBe(2);
    // Newest first.
    expect(runs[0].run_id).toBe("new");
    expect(runs[1].run_id).toBe("old");
    // age_ms makes sense.
    expect(typeof runs[0].age_ms).toBe("number");
    expect((runs[1].age_ms as number)).toBeGreaterThan(
      (runs[0].age_ms as number),
    );
    // size_bytes populated.
    expect((runs[0].size_bytes as number)).toBeGreaterThan(0);
  });

  it("ignores non-JSONL files in the runs dir", () => {
    const dir = join(root, ".claw-squad", "runs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ok.jsonl"), "{}\n");
    writeFileSync(join(dir, "README.md"), "ignore me\n");
    const result = handleRunsList({ repo_root: root });
    const runs = result.runs as Array<Record<string, unknown>>;
    expect(runs.length).toBe(1);
    expect(runs[0].run_id).toBe("ok");
  });
});

describe("handleRunsPurge", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-mcp-purge-"));
    mkdirSync(join(root, ".claw-squad", "runs"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function _ageFile(name: string, ageDays: number): string {
    const p = join(root, ".claw-squad", "runs", name);
    writeFileSync(p, "{}\n");
    const t = (Date.now() - ageDays * ONE_DAY_MS) / 1000;
    utimesSync(p, t, t);
    return p;
  }

  it("rejects negative or missing older_than_days", () => {
    expect(() => handleRunsPurge({ repo_root: root })).toThrow(
      /older_than_days/,
    );
    expect(() =>
      handleRunsPurge({ repo_root: root, older_than_days: -1 }),
    ).toThrow(/non-negative/);
  });

  it("dry_run lists candidates without deleting", () => {
    const oldP = _ageFile("old.jsonl", 30);
    _ageFile("new.jsonl", 1);
    const result = handleRunsPurge({
      repo_root: root,
      older_than_days: 7,
      dry_run: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.deleted).toContain(oldP);
    // File still exists.
    expect(() => writeFileSync(oldP, "still here\n")).not.toThrow();
  });

  it("non-dry-run actually deletes old files", () => {
    const oldP = _ageFile("old.jsonl", 30);
    const newP = _ageFile("new.jsonl", 1);
    const result = handleRunsPurge({
      repo_root: root,
      older_than_days: 7,
    });
    expect(result.dry_run).toBe(false);
    expect(result.deleted).toContain(oldP);
    expect(result.deleted).not.toContain(newP);
  });

  it("returns empty deleted list when runs dir is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "claw-empty-"));
    try {
      const result = handleRunsPurge({
        repo_root: empty,
        older_than_days: 1,
      });
      expect(result.deleted).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
