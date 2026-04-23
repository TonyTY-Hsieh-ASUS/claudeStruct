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

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CoderFileEdit } from "../agents/coder.js";

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

  // Ensure we are on the branch (create if needed, from current HEAD).
  runGit(repoRoot, sandboxEnabled, [
    "checkout",
    "-B",
    branch,
  ]);

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
  runGit(repoRoot, sandboxEnabled, ["add", "--", ...applied]);

  // Grab the staged diff BEFORE committing — this is what the Reviewer reads.
  const diff = runGit(repoRoot, sandboxEnabled, ["diff", "--cached"]);

  // Commit. If there's nothing staged (Coder returned identical content),
  // skip — git would error with "nothing to commit".
  let commitSha: string | undefined;
  if (diff.trim().length > 0) {
    runGit(repoRoot, sandboxEnabled, ["commit", "-m", commitMessage]);
    commitSha = runGit(repoRoot, sandboxEnabled, ["rev-parse", "HEAD"]).trim();
  }

  return {
    branch,
    commitSha,
    diff,
    commitMessage,
    filesApplied: applied,
  };
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

function runGit(
  repoRoot: string,
  sandboxEnabled: boolean,
  args: string[],
): string {
  const cmd = sandboxEnabled ? findSandboxBinary() : "git";
  const fullArgs = sandboxEnabled ? ["--repo", repoRoot, "--", "git", ...args] : args;
  try {
    return execFileSync(cmd, fullArgs, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderr = e.stderr?.toString?.() ?? e.message;
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

function findSandboxBinary(): string {
  // Look for `claw-sandbox` on PATH. If the user enabled --sandbox but
  // didn't build the Go binary, fail loudly.
  const candidate = process.env.CLAW_SANDBOX_BIN ?? "claw-sandbox";
  return candidate;
}
