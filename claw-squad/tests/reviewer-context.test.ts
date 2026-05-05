/**
 * Tests for `agents/reviewer-context.ts` (Reviewer-side smart-context
 * helpers — W10.5b follow-up).
 *
 * Two pieces:
 *  - `extractDiffPaths` parses unified-diff headers into the path
 *    set the orchestrator uses to dedupe smart-context candidates.
 *  - `readReviewerSiblings` reads files from disk under the
 *    Reviewer's tighter byte/file budget, silently skipping
 *    unreadable / over-size entries.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractDiffPaths,
  readReviewerSiblings,
} from "../src/agents/reviewer-context.js";

// --- extractDiffPaths ---------------------------------------------

describe("extractDiffPaths", () => {
  it("pulls paths from `diff --git` headers", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1234..5678 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      "-old",
      "+new",
    ].join("\n");
    const paths = extractDiffPaths(diff);
    expect(paths.has("src/foo.ts")).toBe(true);
  });

  it("handles renames (a/old b/new) by including both sides", () => {
    // The orchestrator dedupes against this set — for a rename we
    // want BOTH the old and new path so neither shows up as a
    // smart-context "sibling".
    const diff = [
      "diff --git a/old/path.ts b/new/path.ts",
      "similarity index 95%",
      "rename from old/path.ts",
      "rename to new/path.ts",
    ].join("\n");
    const paths = extractDiffPaths(diff);
    expect(paths.has("old/path.ts")).toBe(true);
    expect(paths.has("new/path.ts")).toBe(true);
  });

  it("drops /dev/null from the path set", () => {
    // git diff for create / delete uses /dev/null on one side. We
    // never want it in the exclude set.
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
    ].join("\n");
    const paths = extractDiffPaths(diff);
    expect(paths.has("new.ts")).toBe(true);
    expect(paths.has("/dev/null")).toBe(false);
  });

  it("returns empty set for an empty diff", () => {
    expect(extractDiffPaths("").size).toBe(0);
  });

  it("falls back to --- / +++ when there's no `diff --git` line", () => {
    // Some diff sources (e.g. raw `git format-patch`) include only
    // the `---`/`+++` headers. The dedupe should still work.
    const diff = ["--- a/lib/util.ts", "+++ b/lib/util.ts"].join("\n");
    const paths = extractDiffPaths(diff);
    expect(paths.has("lib/util.ts")).toBe(true);
  });
});

// --- readReviewerSiblings ----------------------------------------

describe("readReviewerSiblings", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claw-rev-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads files into the Reviewer's slot, skipping missing ones", () => {
    writeFileSync(join(root, "a.ts"), "alpha\n");
    writeFileSync(join(root, "b.ts"), "beta\n");
    const out = readReviewerSiblings(root, ["a.ts", "missing.ts", "b.ts"]);
    expect(out.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(out[0].content).toBe("alpha\n");
  });

  it("respects the 4-file cap", () => {
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(root, `f${i}.ts`), `${i}\n`);
    }
    const out = readReviewerSiblings(
      root,
      ["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts"],
    );
    expect(out.length).toBe(4);
  });

  it("skips files larger than the per-file cap (12 KB)", () => {
    writeFileSync(join(root, "big.ts"), "x".repeat(20_000));
    writeFileSync(join(root, "small.ts"), "y\n");
    const out = readReviewerSiblings(root, ["big.ts", "small.ts"]);
    expect(out.map((f) => f.path)).toEqual(["small.ts"]);
  });

  it("respects the 32 KB total budget", () => {
    // Three files at 11 KB each = 33 KB; the third should be
    // dropped (would push total over the 32 KB cap).
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      writeFileSync(join(root, name), "x".repeat(11_000));
    }
    const out = readReviewerSiblings(root, ["a.ts", "b.ts", "c.ts"]);
    expect(out.length).toBe(2);
  });

  it("skips directories silently", () => {
    // A stale index pointing at a path that's now a directory
    // (or any non-file) should not crash the Reviewer.
    mkdirSync(join(root, "subdir"));
    writeFileSync(join(root, "ok.ts"), "ok\n");
    const out = readReviewerSiblings(root, ["subdir", "ok.ts"]);
    expect(out.map((f) => f.path)).toEqual(["ok.ts"]);
  });

  it("returns empty for an empty candidate list", () => {
    expect(readReviewerSiblings(root, [])).toEqual([]);
  });
});
