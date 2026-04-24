/**
 * Apply Coder output to the working tree and produce a diff for the Reviewer.
 *
 * This is the security-sensitive boundary. If `sandboxEnabled` is true, every
 * write and every git command runs through the Go `claw-sandbox` binary which
 * enforces path allowlists and rlimits. Default OFF per the user's spec.
 *
 * All write paths are validated against:
 *   - Must be under repoRoot (no absolute paths, no `..` escapes).
 *   - Must not match a hardcoded deny-list (.git/, .env, .ssh/, /etc/, ...).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CoderFileEdit } from "../agents/coder.js";
import { runGit } from "../git.js";

const DENY_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)id_rsa(\.|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
];

export function validatePath(repoRoot: string, p: string): string {
  if (isAbsolute(p)) {
    throw new Error(`refusing absolute path: ${p}`);
  }
  const abs = resolve(repoRoot, p);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing path outside repo: ${p}`);
  }
  for (const deny of DENY_PATTERNS) {
    if (deny.test(rel)) {
      throw new Error(`refusing sensitive path: ${rel}`);
    }
  }
  return abs;
}

export interface ApplyResult {
  branch: string;
  commitSha?: string;
  diff: string;
  commitMessage: string;
  filesApplied: string[];
  /**
   * HEAD sha *before* we switched to the task branch. If the
   * orchestrator later needs to abandon this task (max rounds exceeded,
   * hook abort), it resets the branch to this ref and deletes it so
   * no trace is left. Captured once per applyAndCommit — the first
   * call establishes it; later calls on the same branch reuse the
   * value the orchestrator already has.
   */
  startingRef: string;
}

/**
 * Apply file edits in-place, stage them, commit, return the diff.
 *
 * Returns the **staged** diff (vs HEAD parent) so the Reviewer sees only
 * what this commit changed — not any dirty files the user already had.
 */
export function applyAndCommit(args: {
  repoRoot: string;
  branch: string;
  edits: CoderFileEdit[];
  commitMessage: string;
  sandboxEnabled: boolean;
}): ApplyResult {
  const { repoRoot, branch, edits, commitMessage, sandboxEnabled } = args;

  const gitOpts = { repoRoot, sandboxEnabled };

  // Capture the pre-checkout HEAD so a later rollback knows what to
  // reset to. `checkout -B` silently discards the old branch state,
  // which is the whole point, but we still want a well-defined
  // "before" ref for `revertBranch`.
  const startingRef = runGit(gitOpts, ["rev-parse", "HEAD"]).trim();

  // Ensure we are on the branch (create if needed, from current HEAD).
  runGit(gitOpts, ["checkout", "-B", branch]);

  const applied: string[] = [];
  for (const edit of edits) {
    const abs = validatePath(repoRoot, edit.path);
    if (edit.action === "delete") {
      if (existsSync(abs)) {
        rmSync(abs, { force: true });
      }
    } else {
      if (edit.content === undefined) {
        throw new Error(
          `Coder edit for ${edit.path} has action=${edit.action} but no content`,
        );
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, edit.content, "utf-8");
    }
    applied.push(edit.path);
  }

  // Stage everything the Coder touched.
  runGit(gitOpts, ["add", "--", ...applied]);

  // Grab the staged diff BEFORE committing — this is what the Reviewer reads.
  const diff = runGit(gitOpts, ["diff", "--cached"]);

  // Commit. If there's nothing staged (Coder returned identical content),
  // skip — git would error with "nothing to commit".
  let commitSha: string | undefined;
  if (diff.trim().length > 0) {
    runGit(gitOpts, ["commit", "-m", commitMessage]);
    commitSha = runGit(gitOpts, ["rev-parse", "HEAD"]).trim();
  }

  return {
    branch,
    commitSha,
    diff,
    commitMessage,
    filesApplied: applied,
    startingRef,
  };
}

/**
 * Abandon a task's branch. Checks out `startingRef` on whatever branch
 * the caller was on (usually the repo default branch we branched from)
 * and deletes the task branch so repeated runs don't accumulate dead
 * branches.
 *
 * Intentionally best-effort: if the branch was never created (e.g.
 * rollback requested in round 1 before any commit landed), the
 * `branch -D` step will fail loudly — callers should catch and log.
 */
export function revertBranch(args: {
  repoRoot: string;
  branch: string;
  startingRef: string;
  sandboxEnabled: boolean;
}): void {
  const { repoRoot, branch, startingRef, sandboxEnabled } = args;
  const gitOpts = { repoRoot, sandboxEnabled };

  // Step off the task branch first — can't delete the branch you're on.
  runGit(gitOpts, ["checkout", startingRef]);

  // Drop the task branch. Use -D (force) because it's likely divergent
  // from any base — that's the whole reason we're reverting.
  try {
    runGit(gitOpts, ["branch", "-D", branch]);
  } catch {
    // Branch might not exist yet (rollback in round 1 before any
    // commit). Swallow — being on startingRef is the only outcome
    // that matters.
  }
}

/**
 * Gather current file contents for files the Coder will likely touch.
 * The orchestrator uses a heuristic (Planner's TODO description + grep) to
 * decide which files; this helper just reads them back.
 */
export function readFileSnapshots(
  repoRoot: string,
  paths: string[],
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  for (const p of paths) {
    try {
      const abs = validatePath(repoRoot, p);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, "utf-8");
      out.push({ path: p, content });
    } catch {
      // Skip unreadable or denied paths silently — they'll be missing from
      // the Coder's context but the Coder can still create new files.
    }
  }
  return out;
}

