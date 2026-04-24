/**
 * Test runner — optional step between Coder commit and Reviewer.
 *
 * Why integrate this in the orchestrator (vs. a hook)?
 *   1. We need bidirectional flow: test failures must end up in Coder's
 *      next-round fix instructions, not just a log line. Hooks can't
 *      mutate agent context cleanly.
 *   2. On passing tests we save LLM tokens by skipping Reviewer's
 *      redundant "did you write tests?" concerns.
 *   3. Failed tests are a higher signal than any Reviewer finding —
 *      they're ground truth about whether the code works.
 *
 * The runner is a plain shell command:
 *   - `npm test`, `pytest`, `go test ./...`, `cargo test`, etc.
 *   - Runs in `cwd: repoRoot` with sandbox-aware execution.
 *   - Default: no runner configured → step is skipped.
 *   - Timeout: caller-configurable, default 5 minutes. Long test suites
 *     should be run in CI instead (see ci-wait.ts).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { GitOptions } from "./git.js";

export interface TestRunResult {
  passed: boolean;
  command: string;
  durationMs: number;
  /** Truncated output (stdout + stderr combined), newest-last. */
  output: string;
  /** Exit code; undefined if the process was killed by timeout/signal. */
  exitCode?: number;
  /** True when the runner timed out rather than running to completion. */
  timedOut: boolean;
}

export interface TestRunOptions {
  repoRoot: string;
  /**
   * The shell command to run. Passed to `/bin/sh -c` so pipes and
   * compound commands work naturally. Set to undefined to skip the
   * entire step (orchestrator short-circuits the call).
   */
  command?: string;
  /** Wall-clock cap; kills the runner if exceeded. Default 5 minutes. */
  timeoutMs?: number;
  /**
   * Cap on captured output bytes. Long test suites produce megabytes
   * of output that would blow up the Coder's next-round context.
   * Default 16 KB — enough for stack traces, not enough to derail.
   */
  maxOutputBytes?: number;
  /** If sandbox is enabled, wrap the command with claw-sandbox. */
  sandboxEnabled: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT = 16_384;

export function runTests(opts: TestRunOptions): TestRunResult | undefined {
  if (!opts.command || opts.command.trim().length === 0) return undefined;

  const start = Date.now();
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  // Sandbox wrapper honors the same --sandbox flag that applier uses.
  // The sandbox binary signature is `claw-sandbox --repo <dir> -- <cmd> [args...]`.
  // For a shell command we route through /bin/sh -c so pipes work.
  const [cmd, args] = opts.sandboxEnabled
    ? [
        findSandboxBinary(),
        ["--repo", opts.repoRoot, "--", "/bin/sh", "-c", opts.command],
      ]
    : ["/bin/sh", ["-c", opts.command]];

  let output = "";
  let exitCode: number | undefined;
  let timedOut = false;
  try {
    const buf = execFileSync(cmd, args, {
      cwd: opts.repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: maxOutput * 4, // headroom before truncation kicks in
    });
    output = truncate(buf, maxOutput);
    exitCode = 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
      signal?: string;
    };
    const combined =
      (typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "") +
      (typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "");
    output = truncate(combined || e.message, maxOutput);
    exitCode = typeof e.status === "number" ? e.status : undefined;
    timedOut = e.signal === "SIGTERM" || /timed? ?out/i.test(e.message);
  }

  return {
    passed: exitCode === 0,
    command: opts.command,
    durationMs: Date.now() - start,
    output,
    exitCode,
    timedOut,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.25));
  const tail = s.slice(-Math.floor(max * 0.75));
  return `${head}\n\n...[${s.length - max} bytes truncated]...\n\n${tail}`;
}

function findSandboxBinary(): string {
  return process.env.CLAW_SANDBOX_BIN ?? "claw-sandbox";
}

/**
 * Auto-detect a sensible default test command by sniffing the repo. Used
 * when the user passes --auto-test instead of --test-cmd. This is a
 * heuristic — prefer an explicit --test-cmd in CI or any serious project.
 */
export function detectTestCommand(repoRoot: string): string | undefined {
  // Order matters: most-specific first. If you have both package.json
  // and a Makefile, we prefer package.json because that's usually the
  // authoritative source.
  if (existsSync(`${repoRoot}/package.json`)) {
    return "npm test --silent";
  }
  if (
    existsSync(`${repoRoot}/pyproject.toml`) ||
    existsSync(`${repoRoot}/setup.py`)
  ) {
    return "pytest -q";
  }
  if (existsSync(`${repoRoot}/go.mod`)) {
    return "go test ./...";
  }
  if (existsSync(`${repoRoot}/Cargo.toml`)) {
    return "cargo test --quiet";
  }
  if (existsSync(`${repoRoot}/pom.xml`)) {
    return "mvn -q test";
  }
  if (existsSync(`${repoRoot}/build.gradle`) || existsSync(`${repoRoot}/build.gradle.kts`)) {
    return "gradle test -q";
  }
  if (existsSync(`${repoRoot}/Makefile`)) {
    return "make test";
  }
  return undefined;
}

// Re-export GitOptions for callers that share the same sandbox flag source.
export type { GitOptions };
