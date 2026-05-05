/**
 * Context-gather tests. These don't actually shell out to git — we test
 * the pure keyword/path extraction, since that's where the real logic
 * lives. The git.ls-files integration is exercised via the orchestrator
 * path (which tests cover indirectly through snapshot + applier tests).
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractKeywords,
  extractPathTokens,
  gatherInitialContext,
} from "../src/context-gather.js";

describe("extractKeywords", () => {
  it("returns lowercase tokens longer than 2 chars", () => {
    const kws = extractKeywords("Add a login handler to the auth module");
    expect(kws).toContain("login");
    expect(kws).toContain("handler");
    expect(kws).toContain("auth");
    expect(kws).toContain("module");
  });

  it("filters stopwords and short tokens", () => {
    const kws = extractKeywords("the add of in to on at a an or and but");
    expect(kws).toEqual([]);
  });

  it("deduplicates", () => {
    const kws = extractKeywords("login login Login LOGIN");
    expect(kws).toEqual(["login"]);
  });

  it("handles identifiers with underscores and dots", () => {
    const kws = extractKeywords("update user_profile.ts with validate_email()");
    expect(kws).toContain("user_profile.ts");
    expect(kws).toContain("validate_email");
  });
});

describe("extractPathTokens", () => {
  it("finds .ts file references", () => {
    const paths = extractPathTokens("edit src/api/users.ts to add caching");
    expect(paths).toContain("src/api/users.ts");
  });

  it("finds multiple paths and dedups", () => {
    const paths = extractPathTokens(
      "update a.ts and b.ts, then retouch a.ts",
    );
    expect(paths).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
    expect(paths).toHaveLength(2);
  });

  it("recognizes common source extensions", () => {
    const paths = extractPathTokens(
      "touch main.go, lib/util.py, Cargo.toml, README.md, style.css",
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "main.go",
        "lib/util.py",
        "Cargo.toml",
        "README.md",
        "style.css",
      ]),
    );
  });

  it("returns empty for prose with no paths", () => {
    expect(extractPathTokens("fix the bug in the login flow")).toEqual([]);
  });
});

// --- Smart-context integration (extraExplicitPaths) ---------------
//
// These tests pin the W10.5b orchestrator integration: the index's
// top-K hits land in the candidate list ahead of keyword-rank
// results, while paths that aren't tracked by git get silently
// dropped (defensive — a stale index after a `git rm` shouldn't
// blow up the run).

describe("gatherInitialContext extraExplicitPaths", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "claw-ctx-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    writeFileSync(join(repo, "alpha.ts"), "export function alpha() {}\n");
    writeFileSync(join(repo, "beta.ts"), "export function beta() {}\n");
    writeFileSync(join(repo, "gamma.ts"), "export function gamma() {}\n");
    execSync("git add -A && git -c commit.gpgsign=false commit -q -m init", {
      cwd: repo,
    });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("biases extra paths to the front of the candidate list", () => {
    // Without smart-context, a description with no keywords matching
    // any file lands all three with low rank. Smart-context jumping
    // gamma.ts to the top means gamma.ts shows up in the small file
    // budget when the keyword rank wouldn't favour it.
    const out = gatherInitialContext({
      git: { repoRoot: repo, sandboxEnabled: false },
      todoTitle: "do the thing",
      todoDescription: "irrelevant prose",
      maxFiles: 1,
      extraExplicitPaths: ["gamma.ts"],
    });
    expect(out.files.map((f) => f.path)).toEqual(["gamma.ts"]);
  });

  it("silently drops extra paths that aren't tracked", () => {
    // A stale index could point at a file that was later `git rm`'d.
    // The gatherer must not crash and must not fabricate a "missing
    // file" entry — just skip and move on to keyword-rank.
    const out = gatherInitialContext({
      git: { repoRoot: repo, sandboxEnabled: false },
      todoTitle: "alpha",
      todoDescription: "",
      maxFiles: 2,
      extraExplicitPaths: ["does-not-exist.ts", "alpha.ts"],
    });
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain("alpha.ts");
    expect(paths).not.toContain("does-not-exist.ts");
  });

  it("dedupes against literal-mention paths", () => {
    // If the user typed `alpha.ts` in the description AND the index
    // also returned alpha.ts, the file should appear once — not
    // twice with a duplicated content body.
    const out = gatherInitialContext({
      git: { repoRoot: repo, sandboxEnabled: false },
      todoTitle: "edit alpha.ts",
      todoDescription: "",
      maxFiles: 5,
      extraExplicitPaths: ["alpha.ts"],
    });
    const alphaCount = out.files.filter((f) => f.path === "alpha.ts").length;
    expect(alphaCount).toBe(1);
  });
});
