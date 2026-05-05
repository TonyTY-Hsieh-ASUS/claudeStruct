/**
 * Pure CLI argument builder + child-process runner.
 *
 * Kept separate from `extension.ts` so vitest can drive it without
 * pulling in the `vscode` API surface. The extension entry point is
 * a thin adapter: gather user input → build args here → spawn → pipe
 * output to a VS Code `OutputChannel`.
 */

import { spawn, type SpawnOptions } from "node:child_process";

export interface CliConfig {
  /** Path to the `cs` executable, e.g. "cs" or "/usr/local/bin/cs". */
  cliPath: string;
  /** Per-task max-bytes override. 0 = use the CLI's per-task default. */
  maxBytes: number;
  /** Per-task effort override. Empty string = inherit the CLI default. */
  effort: string;
  /** Extra args appended verbatim (e.g. ["--monthly-cap-usd", "20"]). */
  extraArgs: string[];
}

export type CsTask = "review" | "dev" | "plan" | "debug";

export interface BuildArgsInput {
  task: CsTask;
  /**
   * Free-form description for `cs <task> "<description>"`. For review
   * we synthesize a sensible default if the caller didn't ask.
   */
  description?: string;
  /** Optional path arguments (file or directory). Forwarded as positional args. */
  paths?: string[];
  config: CliConfig;
}

export interface SpawnedRun {
  args: string[];
  cwd: string;
}

const DEFAULT_REVIEW_DESCRIPTION =
  "Review the code below for bugs, security issues, and maintainability concerns.";


export function buildArgs(input: BuildArgsInput): string[] {
  const args: string[] = [input.task];

  // Description: required for dev/plan/debug; defaulted for review.
  if (input.description && input.description.trim().length > 0) {
    args.push(input.description);
  } else if (input.task === "review") {
    args.push(DEFAULT_REVIEW_DESCRIPTION);
  } else {
    // dev/plan/debug without a description is a bug at the call site —
    // surface it loudly rather than spawning `cs dev` with no prompt.
    throw new Error(
      `claudestruct.${input.task} requires a description; got empty string`,
    );
  }

  // Per-task config overrides. Order is "args first, paths last" so
  // any positional path forwarding lands after the flags.
  if (input.config.maxBytes > 0) {
    args.push("--max-bytes", String(input.config.maxBytes));
  }
  if (input.config.effort && input.config.effort.trim().length > 0) {
    args.push("--effort", input.config.effort);
  }
  for (const extra of input.config.extraArgs) {
    args.push(extra);
  }

  for (const p of input.paths ?? []) {
    args.push(p);
  }

  return args;
}


export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the cs CLI and collect its output.
 *
 * `onChunk` lets the caller stream stdout into a VS Code OutputChannel
 * without buffering the entire run in memory — useful for `cs plan`
 * runs that may stream tens of KB of text.
 */
export function runCs(
  cliPath: string,
  args: string[],
  cwd: string,
  onChunk?: (text: string, source: "stdout" | "stderr") => void,
  options: { spawn?: typeof spawn; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const spawnFn = options.spawn ?? spawn;
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const spawnOpts: SpawnOptions = {
      cwd,
      env: options.env ?? process.env,
      // Inherit stdin so the user can answer Click prompts (e.g.
      // `cs review` on an unsaved branch with no diff). Without this,
      // any `prompts.confirm()` in the CLI hangs forever.
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
    };
    let child;
    try {
      child = spawnFn(cliPath, args, spawnOpts);
    } catch (err) {
      reject(err);
      return;
    }
    child.stdout?.on("data", (buf: Buffer) => {
      const text = buf.toString("utf-8");
      stdout.push(text);
      onChunk?.(text, "stdout");
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const text = buf.toString("utf-8");
      stderr.push(text);
      onChunk?.(text, "stderr");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
  });
}
