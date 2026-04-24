/**
 * Path validation is the main security boundary in TS land. Tests make sure
 * Coder can't walk out of the repo or write to sensitive files.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAndCommit,
  revertBranch,
  validatePath,
} from "../src/sandbox/applier.js";

describe("validatePath", () => {
  const repo = "/home/user/repo";

  it("allows a simple relative path", () => {
    expect(() => validatePath(repo, "src/foo.ts")).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => validatePath(repo, "/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects .. escapes", () => {
    expect(() => validatePath(repo, "../outside.txt")).toThrow(/outside/);
  });

  it("rejects .git writes", () => {
    expect(() => validatePath(repo, ".git/config")).toThrow(/sensitive/);
  });

  it("rejects .env writes", () => {
    expect(() => validatePath(repo, ".env")).toThrow(/sensitive/);
    expect(() => validatePath(repo, ".env.production")).toThrow(/sensitive/);
  });

  it("rejects .ssh writes", () => {
    expect(() => validatePath(repo, ".ssh/id_rsa")).toThrow(/sensitive/);
  });

  it("rejects nested .git", () => {
    expect(() => validatePath(repo, "subrepo/.git/HEAD")).toThrow(/sensitive/);
  });
});

describe("applyAndCommit + revertBranch", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "claw-revert-"));
    execSync("git init -q", { cwd: repoRoot });
    execSync("git config user.email test@example.com", { cwd: repoRoot });
    execSync("git config user.name test", { cwd: repoRoot });
    // Some CI envs force-enable commit signing via a gitconfig helper
    // that rejects unsigned writes. Our temp repo is throwaway — keep
    // it local, no signing.
    execSync("git config commit.gpgsign false", { cwd: repoRoot });
    execSync("git config tag.gpgsign false", { cwd: repoRoot });
    execSync("git config gpg.format openpgp", { cwd: repoRoot });
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n", "utf-8");
    execSync("git add seed.txt && git commit -q -m seed", { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("applyAndCommit reports the starting ref (pre-checkout HEAD)", () => {
    const before = execSync("git rev-parse HEAD", { cwd: repoRoot })
      .toString()
      .trim();
    const r = applyAndCommit({
      repoRoot,
      branch: "claw-squad/t1",
      edits: [{ path: "a.txt", action: "create", content: "a\n" }],
      commitMessage: "add a",
      sandboxEnabled: false,
    });
    expect(r.startingRef).toBe(before);
    expect(r.commitSha).toBeDefined();
    expect(readFileSync(join(repoRoot, "a.txt"), "utf-8")).toBe("a\n");
  });

  it("revertBranch resets HEAD to startingRef and deletes the branch", () => {
    const r = applyAndCommit({
      repoRoot,
      branch: "claw-squad/t1",
      edits: [{ path: "a.txt", action: "create", content: "a\n" }],
      commitMessage: "add a",
      sandboxEnabled: false,
    });

    revertBranch({
      repoRoot,
      branch: "claw-squad/t1",
      startingRef: r.startingRef,
      sandboxEnabled: false,
    });

    // Branch should be gone.
    const branches = execSync("git branch --list", { cwd: repoRoot }).toString();
    expect(branches).not.toMatch(/claw-squad\/t1/);

    // HEAD should be back at the starting ref (detached is fine).
    const head = execSync("git rev-parse HEAD", { cwd: repoRoot })
      .toString()
      .trim();
    expect(head).toBe(r.startingRef);

    // The commit's file should be gone from the working tree.
    expect(existsSync(join(repoRoot, "a.txt"))).toBe(false);
  });

  it("revertBranch is best-effort when the branch was never created", () => {
    // No applyAndCommit first — the branch doesn't exist. We still need
    // the function to leave HEAD on startingRef (which is the current
    // HEAD), i.e. be a no-op without throwing.
    const startingRef = execSync("git rev-parse HEAD", { cwd: repoRoot })
      .toString()
      .trim();
    expect(() =>
      revertBranch({
        repoRoot,
        branch: "claw-squad/never-existed",
        startingRef,
        sandboxEnabled: false,
      }),
    ).not.toThrow();
    const head = execSync("git rev-parse HEAD", { cwd: repoRoot })
      .toString()
      .trim();
    expect(head).toBe(startingRef);
  });
});
