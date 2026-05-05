/**
 * Run-log retention tests.
 *
 * Mirrors the contract in `tests/test_redact.py::purge_runs` so the
 * Python and TS retention rules stay in lockstep.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daysToMs, purgeRuns } from "../src/runs/purge.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("purgeRuns", () => {
  let root: string;
  let runsDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-purge-"));
    runsDir = join(root, ".claw-squad", "runs");
    mkdirSync(runsDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(name: string, ageDays: number, body = "{}\n"): string {
    const p = join(runsDir, name);
    writeFileSync(p, body, "utf-8");
    const t = (Date.now() - ageDays * ONE_DAY_MS) / 1000;
    utimesSync(p, t, t);
    return p;
  }

  it("returns [] when the runs dir does not exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "claw-purge-empty-"));
    try {
      expect(purgeRuns(empty, { olderThanMs: ONE_DAY_MS })).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("returns [] when no files match the cutoff", () => {
    write("recent.jsonl", 0.1);
    expect(purgeRuns(root, { olderThanMs: 30 * ONE_DAY_MS })).toEqual([]);
    expect(existsSync(join(runsDir, "recent.jsonl"))).toBe(true);
  });

  it("deletes only files older than the cutoff", () => {
    const old = write("old.jsonl", 40);
    const fresh = write("fresh.jsonl", 1);
    const victims = purgeRuns(root, { olderThanMs: 30 * ONE_DAY_MS });
    expect(victims).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("dry-run preserves files but still reports them", () => {
    const old = write("old.jsonl", 40);
    const victims = purgeRuns(root, {
      olderThanMs: 30 * ONE_DAY_MS,
      dryRun: true,
    });
    expect(victims).toEqual([old]);
    expect(existsSync(old)).toBe(true);
  });

  it("ignores non-.jsonl files even when stale", () => {
    write("notes.txt", 100, "hello");
    const victims = purgeRuns(root, { olderThanMs: ONE_DAY_MS });
    expect(victims).toEqual([]);
    expect(existsSync(join(runsDir, "notes.txt"))).toBe(true);
  });

  it("uses caller-supplied `now` to make age comparisons deterministic", () => {
    const old = write("old.jsonl", 0); // mtime = real Date.now()
    // Pretend it's 50 days from now → cutoff at 30 days makes the file old.
    const victims = purgeRuns(root, {
      olderThanMs: 30 * ONE_DAY_MS,
      now: Date.now() + 50 * ONE_DAY_MS,
      dryRun: true,
    });
    expect(victims).toEqual([old]);
  });

  it("daysToMs floors negative inputs at zero", () => {
    expect(daysToMs(0)).toBe(0);
    expect(daysToMs(-5)).toBe(0);
    expect(daysToMs(2)).toBe(2 * ONE_DAY_MS);
  });
});
