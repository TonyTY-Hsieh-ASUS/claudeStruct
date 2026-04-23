/**
 * Git primitives shared between the file applier and the GitHub client.
 *
 * Everything goes through `runGit` so a single sandbox check covers all
 * git invocations. If the user passes --sandbox, every git call runs
 * inside the claw-sandbox Go binary with rlimits + path validation.
 */

import { execFileSync } from "node:child_process";

export interface GitOptions {
  repoRoot: string;
  sandboxEnabled: boolean;
}

export function runGit(
  opts: GitOptions,
  args: string[],
): string {
  const cmd = opts.sandboxEnabled ? findSandboxBinary() : "git";
  const fullArgs = opts.sandboxEnabled
    ? ["--repo", opts.repoRoot, "--", "git", ...args]
    : args;
  try {
    return execFileSync(cmd, fullArgs, {
      cwd: opts.repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : (e.stderr?.toString?.() ?? e.message);
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

function findSandboxBinary(): string {
  return process.env.CLAW_SANDBOX_BIN ?? "claw-sandbox";
}

/** Return the default base branch of origin, or "main" as fallback. */
export function detectDefaultBranch(opts: GitOptions): string {
  // symbolic-ref returns e.g. "refs/remotes/origin/HEAD -> refs/remotes/origin/main"
  // on a freshly-cloned repo. If the remote HEAD isn't set, we fall back
  // to "main" which is the modern default.
  try {
    const sym = runGit(opts, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
    const parts = sym.split("/");
    const last = parts[parts.length - 1];
    if (last && last.length > 0) return last;
  } catch {
    // ignored — fall through
  }
  return "main";
}

/** Return the short SHA of HEAD. */
export function headSha(opts: GitOptions): string {
  return runGit(opts, ["rev-parse", "--short", "HEAD"]).trim();
}

export function currentBranch(opts: GitOptions): string {
  return runGit(opts, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

/**
 * Push a branch to origin. First push sets upstream. Idempotent.
 * Returns true if the push actually moved the remote (new commits were
 * sent), false if everything was already up to date.
 */
export function pushBranch(
  opts: GitOptions,
  branch: string,
): { pushed: boolean; output: string } {
  const output = runGit(opts, ["push", "-u", "origin", branch]);
  const pushed = !output.includes("Everything up-to-date");
  return { pushed, output };
}
