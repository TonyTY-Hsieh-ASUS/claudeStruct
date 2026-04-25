#!/usr/bin/env node
/**
 * claw-squad CLI entry.
 *
 * `claw-squad run "<requirement>"` kicks off the full 3-agent loop.
 * `claw-squad init` scaffolds .claw-squad/ in the current repo.
 *
 * Each agent's provider/model/baseURL can be set in three ways (highest
 * precedence last):
 *   1. Built-in defaults (all Anthropic)
 *   2. .claw-squad/config.json file
 *   3. CLI flags: --<role>-provider / --<role>-model / --<role>-base-url /
 *      --<role>-effort
 */

import { Command } from "commander";
import pc from "picocolors";
import prompts from "prompts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOrchestrator, type UserInterface } from "./orchestrator.js";
import { installAbortSignal } from "./abort-signal.js";
import {
  loadAgentConfig,
  loadReposFromFile,
  type AgentCliOverride,
} from "./config.js";
import { loadSnapshot } from "./snapshot.js";
import {
  diffRuns,
  formatDiff,
  formatDiffJson,
  formatJson,
  formatTable,
  loadSummaries,
  loadSummaryById,
  watchSummaries,
} from "./dashboard.js";
import { loadHooksFromFile, NO_HOOKS, type Hooks } from "./hooks.js";
import { detectTestCommand } from "./test-runner.js";
import { ROLE_BUCKETS, type AgentRole, type RunConfig } from "./types.js";
import { loadPromptVersion } from "./prompts.js";
import {
  isSilentCacheInvalidator,
  type RunTotals,
} from "./totals.js";

const program = new Command();

const ROLES: AgentRole[] = ["planner", "coder", "reviewer"];

program
  .name("claw-squad")
  .description(
    "3-agent Claude orchestrator: Planner -> Coder -> Reviewer. Supports Anthropic / OpenAI / Ollama / vLLM / SGLang / Gemini / MiniMax.",
  )
  .version("0.2.0");

const runCmd = program
  .command("run")
  .description(
    "Run the 3-agent loop on a requirement (GitHub disabled by default).",
  )
  .argument("<requirement>", "the feature / task / question in plain language")
  .option("--root <path>", "repo root (defaults to cwd)", process.cwd())
  .option("--config <path>", "path to .claw-squad/config.json (otherwise auto-detected)")
  .option("--max-clarifications <n>", "max Planner Q&A rounds", "3")
  .option("--max-review-rounds <n>", "max Coder↔Reviewer rounds per task", "3")
  .option("--max-loops <n>", "max tasks to complete in one run", "10")
  .option(
    "--sandbox",
    "wrap Coder subprocess calls with claw-sandbox (Go binary). Default off.",
  )
  .option("--github", "actually push and PR to GitHub. Default off (dry local run).")
  .option("--github-repo <owner/repo>", "GitHub repo target when --github is set")
  .option("--no-self-learning", "disable memory/lessons.md writing")
  .option("--no-confirm", "skip human confirmation on destructive GitHub actions")
  .option(
    "--max-cost <usd>",
    "abort when estimated spend exceeds this many USD",
  )
  .option(
    "--max-tokens-total <n>",
    "abort when total tokens (input+output+cache) exceeds n",
  )
  .option("--resume", "resume from .claw-squad/state.json")
  .option(
    "--hooks <path>",
    "load a JS/TS module exporting lifecycle hooks (default export or `hooks` named export)",
  )
  .option(
    "--test-cmd <cmd>",
    "shell command to run after each Coder commit; failure feeds back to Coder",
  )
  .option(
    "--auto-test",
    "auto-detect a test command (npm test / pytest / go test / cargo test / ...)",
  )
  .option(
    "--test-timeout <ms>",
    "wall-clock cap for the test command (default 300000)",
  )
  .option(
    "--wait-for-ci",
    "after Reviewer approves, block on GitHub CI before merging",
  )
  .option(
    "--ci-timeout <ms>",
    "wall-clock cap for CI wait (default 900000)",
  )
  .option("--tui", "use the Ink-based terminal UI instead of plain streaming output")
  .option(
    "--slack-channel <id>",
    "post activity to a Slack channel (thread) instead of stdout. Needs SLACK_BOT_TOKEN env.",
  )
  .option(
    "--slack-mode <mode>",
    "Slack receiving transport: 'polling' (default) or 'socket'. Socket needs SLACK_APP_TOKEN env and gives real-time replies + Block Kit confirm buttons.",
  )
  .option(
    "--web-ui [port]",
    "serve a localhost web UI on the given port (default 3737)",
  )
  .option(
    "--no-rollback-on-max-rounds",
    "keep the task branch + PR when the Coder↔Reviewer loop hits max rounds (default: revert + close)",
  )
  .option(
    "--no-rollback-on-hard-fail",
    "keep the task branch on a preCommit hook abort (default: revert to starting ref)",
  )
  .option(
    "--dry-run",
    "stop after Planner finishes its TODO list and print a cost estimate; no Coder/Reviewer calls",
  );

// Per-role provider flags. Commander can't easily do templated option
// names, so we add each explicitly. Keeping the name pattern stable
// (<role>-<knob>) so docs and completions are predictable.
for (const role of ROLES) {
  runCmd.option(
    `--${role}-provider <name>`,
    `provider for ${role} (anthropic | openai | gemini | minimax | ollama | vllm | sglang | openai-compat)`,
  );
  runCmd.option(`--${role}-model <id>`, `model for ${role}`);
  runCmd.option(`--${role}-base-url <url>`, `override base URL for ${role}'s provider`);
  runCmd.option(`--${role}-api-key <key>`, `override API key for ${role}'s provider`);
  runCmd.option(
    `--${role}-effort <level>`,
    `effort for ${role} (low | medium | high | xhigh | max)`,
  );
}

runCmd.action(async (requirement: string, opts: Record<string, unknown>) => {
    const config: RunConfig = {
      repoRoot: String(opts.root ?? process.cwd()),
      maxClarifications: Number(opts.maxClarifications),
      maxReviewRounds: Number(opts.maxReviewRounds),
      maxLoops: Number(opts.maxLoops),
      requireHumanApproval: opts.confirm !== false,
      sandboxEnabled: Boolean(opts.sandbox),
      selfLearning: opts.selfLearning !== false,
      githubEnabled: Boolean(opts.github),
      githubRepo: opts.githubRepo as string | undefined,
      maxCostUsd:
        opts.maxCost !== undefined ? Number(opts.maxCost) : undefined,
      maxTokens:
        opts.maxTokensTotal !== undefined
          ? Number(opts.maxTokensTotal)
          : undefined,
      testCommand: resolveTestCommand(opts),
      testTimeoutMs:
        opts.testTimeout !== undefined ? Number(opts.testTimeout) : undefined,
      waitForCi: Boolean(opts.waitForCi),
      ciTimeoutMs:
        opts.ciTimeout !== undefined ? Number(opts.ciTimeout) : undefined,
      // Commander sets opts.rollbackOnMaxRounds=false when --no-rollback-on-max-rounds
      // is passed. Default is undefined → treated as "on" by the orchestrator.
      rollbackOnMaxRounds: opts.rollbackOnMaxRounds !== false,
      rollbackOnHardFail: opts.rollbackOnHardFail !== false,
      dryRun: Boolean(opts.dryRun),
    };

    // Pull multi-repo spec out of the config file if present. When
    // unset, the orchestrator falls back to the legacy single-repo
    // shape, so this is purely opt-in.
    try {
      const repos = loadReposFromFile({
        repoRoot: config.repoRoot,
        configPath: opts.config as string | undefined,
      });
      if (repos) config.repos = repos;
    } catch (err) {
      console.error(pc.red(`config error: ${(err as Error).message}`));
      process.exit(1);
    }

    // --github validation: when multi-repo is set, every repo must name
    // its githubRepo. Otherwise the legacy single-repo flag applies.
    if (config.githubEnabled) {
      if (config.repos && config.repos.length > 0) {
        const missing = config.repos.filter((r) => !r.githubRepo);
        if (missing.length > 0) {
          console.error(
            pc.red(
              `--github with multi-repo config requires githubRepo on each repo (missing: ${missing.map((r) => r.alias).join(", ")})`,
            ),
          );
          process.exit(1);
        }
      } else if (!config.githubRepo) {
        console.error(pc.red("--github requires --github-repo owner/name"));
        process.exit(1);
      }
    }

    let agentConfig;
    try {
      agentConfig = loadAgentConfig({
        repoRoot: config.repoRoot,
        configPath: opts.config as string | undefined,
        cliOverrides: extractCliOverrides(opts),
      });
    } catch (err) {
      console.error(pc.red(`config error: ${(err as Error).message}`));
      process.exit(1);
    }

    logConfig(config, agentConfig);

    // UI selection: TUI, Slack, Web UI, or plain CLI. At most one
    // remote/rich UI at a time — combining them creates confusing
    // behavior (whose `confirm` wins?) and we don't need it yet.
    const uiFlags = [
      opts.tui ? "--tui" : undefined,
      opts.slackChannel ? "--slack-channel" : undefined,
      opts.webUi !== undefined ? "--web-ui" : undefined,
    ].filter(Boolean);
    if (uiFlags.length > 1) {
      console.error(
        pc.red(
          `Pick one UI: ${uiFlags.join(", ")} are mutually exclusive.`,
        ),
      );
      process.exit(1);
    }

    let ui: UserInterface;
    let tuiInstance: { unmount(): void } | undefined;
    let remoteUi: { shutdown(): Promise<void> } | undefined;
    if (opts.tui && process.stdout.isTTY) {
      const { TuiUi } = await import("./tui/tui.js");
      const tui = new TuiUi();
      tui.mount();
      ui = tui;
      tuiInstance = tui;
    } else if (opts.slackChannel) {
      const { SlackUi, autodetectSlackMode } = await import("./ui/slack.js");
      // Honor --slack-mode if given; otherwise autodetect based on
      // which env tokens are set.
      let mode: "polling" | "socket";
      if (opts.slackMode === "polling" || opts.slackMode === "socket") {
        mode = opts.slackMode;
      } else if (opts.slackMode !== undefined) {
        console.error(
          pc.red(`--slack-mode must be 'polling' or 'socket' (got ${opts.slackMode})`),
        );
        process.exit(1);
      } else {
        mode = autodetectSlackMode();
      }
      if (mode === "socket" && !process.env.SLACK_APP_TOKEN) {
        console.error(
          pc.red(`--slack-mode socket requires SLACK_APP_TOKEN env`),
        );
        process.exit(1);
      }
      const slack = new SlackUi({
        channel: String(opts.slackChannel),
        openerText: `claw-squad starting: ${requirement.slice(0, 200)}`,
        mode,
      });
      await slack.ready();
      ui = slack;
      remoteUi = slack;
    } else if (opts.webUi !== undefined) {
      // `--web-ui` alone → default port 3737. `--web-ui 8080` →
      // Commander hands us "8080" as a string.
      const portArg =
        typeof opts.webUi === "string" ? Number(opts.webUi) : undefined;
      const { WebUi } = await import("./ui/web.js");
      const web = new WebUi({ port: portArg });
      try {
        const addr = await web.start();
        console.log(
          pc.cyan(`web UI listening on http://${addr.host}:${addr.port}`),
        );
      } catch (err) {
        console.error(
          pc.red(`web UI failed to start: ${(err as Error).message}`),
        );
        process.exit(1);
      }
      ui = web;
      remoteUi = web;
    } else {
      if (opts.tui && !process.stdout.isTTY) {
        console.log(pc.yellow("[tui] stdout is not a TTY; falling back to plain CLI"));
      }
      ui = buildUI();
    }

    // Hooks (optional — defaults to no-op).
    let hooks: Hooks = NO_HOOKS;
    if (typeof opts.hooks === "string") {
      hooks = await loadHooksFromFile(opts.hooks, (m) => console.error(m));
    }

    // --resume: rehydrate SquadState from disk.
    let resumeFrom;
    let resumeTotals;
    if (opts.resume) {
      const snap = loadSnapshot(config.repoRoot);
      if (!snap) {
        console.error(
          pc.red(`no snapshot at .claw-squad/state.json — nothing to resume`),
        );
        process.exit(1);
      }
      resumeFrom = snap.state;
      resumeTotals = snap.totals;
      console.log(
        pc.cyan(
          `Resuming from ${snap.savedAt} — ${snap.state.todos.length} todos, loopCount=${snap.state.loopCount}, prior spend $${snap.totals.overall.costUsd.toFixed(4)}`,
        ),
      );
    }

    const abort = installAbortSignal({ ui });
    try {
      const result = await runOrchestrator({
        config,
        agentConfig,
        requirement,
        ui: abort.ui,
        hooks,
        resumeFrom,
        resumeTotals,
      });
      tuiInstance?.unmount();
      await remoteUi?.shutdown();
      printSummary(result);
      if (result.reason === "complete" || result.reason === "dry_run")
        process.exit(0);
      if (result.reason === "blocked" || result.reason === "aborted")
        process.exit(2);
      process.exit(3);
    } catch (err) {
      tuiInstance?.unmount();
      await remoteUi?.shutdown();
      console.error(pc.red(`\nFatal: ${(err as Error).message}`));
      process.exit(1);
    } finally {
      abort.dispose();
    }
  });

program
  .command("init")
  .description(
    "Create .claw-squad/ with a sample config.json showing provider options.",
  )
  .option("--root <path>", "repo root", process.cwd())
  .action((opts: { root: string }) => {
    const dir = join(opts.root, ".claw-squad");
    mkdirSync(join(dir, "memory"), { recursive: true });
    const cfgPath = join(dir, "config.json");
    if (!existsSync(cfgPath)) {
      writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            agents: {
              planner: {
                name: "anthropic",
                model: "claude-opus-4-7",
                effort: "max",
              },
              coder: {
                // Example: point Coder at a local Ollama server.
                // Remove this comment and fill in your model name.
                // name: "ollama",
                // model: "qwen2.5-coder:14b",
                // baseURL: "http://localhost:11434/v1",
                name: "anthropic",
                model: "claude-sonnet-4-6",
                effort: "high",
              },
              reviewer: {
                name: "anthropic",
                model: "claude-opus-4-7",
                effort: "xhigh",
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
    }
    console.log(pc.green(`Initialized ${dir}`));
    console.log(pc.dim(`Edit ${cfgPath} to change provider/model per agent.`));
  });

function extractCliOverrides(
  opts: Record<string, unknown>,
): Partial<Record<AgentRole, AgentCliOverride>> {
  const out: Partial<Record<AgentRole, AgentCliOverride>> = {};
  for (const role of ROLES) {
    const o: AgentCliOverride = {};
    const p = opts[`${role}Provider`];
    const m = opts[`${role}Model`];
    const b = opts[`${role}BaseUrl`];
    const k = opts[`${role}ApiKey`];
    const e = opts[`${role}Effort`];
    if (typeof p === "string") o.provider = p;
    if (typeof m === "string") o.model = m;
    if (typeof b === "string") o.baseURL = b;
    if (typeof k === "string") o.apiKey = k;
    if (typeof e === "string") o.effort = e;
    if (Object.keys(o).length > 0) out[role] = o;
  }
  return out;
}

function logConfig(
  c: RunConfig,
  agents: Awaited<ReturnType<typeof loadAgentConfig>>,
): void {
  console.log(pc.dim("─".repeat(60)));
  console.log(pc.bold("claw-squad run configuration"));
  console.log(`  root:            ${c.repoRoot}`);
  console.log(
    `  sandbox:         ${c.sandboxEnabled ? pc.yellow("ON") : pc.dim("off (default)")}`,
  );
  console.log(
    `  self-learning:   ${c.selfLearning ? pc.green("on") : pc.dim("off")}`,
  );
  console.log(
    `  github:          ${c.githubEnabled ? pc.yellow("ON") : pc.dim("off (dry run)")}`,
  );
  console.log(`  max clarifs:     ${c.maxClarifications}`);
  console.log(`  max review:      ${c.maxReviewRounds}`);
  console.log(`  max loops:       ${c.maxLoops}`);
  console.log("");
  console.log(pc.bold("agents"));
  for (const role of ROLES) {
    const a = agents[role];
    console.log(
      `  ${role.padEnd(9)} ${pc.cyan(a.name)} ${a.model} ${a.baseURL ? pc.dim(`(${a.baseURL})`) : ""}${a.effort ? pc.dim(` effort=${a.effort}`) : ""}`,
    );
  }
  console.log(pc.dim("─".repeat(60)));
}

function resolveTestCommand(opts: Record<string, unknown>): string | undefined {
  // Explicit --test-cmd wins. Fall back to --auto-test detection.
  if (typeof opts.testCmd === "string" && opts.testCmd.length > 0) {
    return opts.testCmd;
  }
  if (opts.autoTest) {
    const detected = detectTestCommand(String(opts.root ?? process.cwd()));
    if (detected) {
      console.log(pc.dim(`[auto-test] detected: ${detected}`));
    }
    return detected;
  }
  return undefined;
}

function buildUI(): UserInterface {
  return {
    async askClarifications(questions) {
      const answers: string[] = [];
      console.log(pc.cyan("\n[Planner asks:]"));
      for (const q of questions) {
        const { answer } = await prompts({
          type: "text",
          name: "answer",
          message: q,
        });
        answers.push(typeof answer === "string" ? answer : "");
      }
      return answers;
    },
    async confirm(prompt) {
      const { ok } = await prompts({
        type: "confirm",
        name: "ok",
        message: prompt,
        initial: false,
      });
      return Boolean(ok);
    },
    log(msg) {
      console.log(msg);
    },
    streamAgent(_role, chunk) {
      process.stdout.write(chunk);
    },
  };
}

function printSummary(result: {
  totals: RunTotals;
  reason: string;
}): void {
  const t = result.totals;
  const overall = t.overall;
  console.log(pc.dim("\n" + "─".repeat(72)));
  console.log(pc.bold("Usage summary"));

  // Per-role table. Only show rows with actual traffic so the output
  // stays readable for short runs.
  const col = (s: string, w: number) => s.padEnd(w);
  const num = (n: number, w: number) => n.toLocaleString().padStart(w);
  const dollars = (n: number, w: number) => ("$" + n.toFixed(4)).padStart(w);
  const header =
    col("  role", 14) +
    col("calls", 8) +
    col("in", 12) +
    col("out", 12) +
    col("cacheR", 12) +
    col("cost", 12);
  console.log(pc.dim(header));
  for (const role of ROLE_BUCKETS) {
    const r = t.perRole[role];
    if (r.calls === 0) continue;
    console.log(
      col(`  ${role}`, 14) +
        num(r.calls, 8).padEnd(8) +
        num(r.inputTokens, 12).padEnd(12) +
        num(r.outputTokens, 12).padEnd(12) +
        num(r.cacheReadTokens, 12).padEnd(12) +
        dollars(r.costUsd, 12).padEnd(12),
    );
  }
  console.log(
    pc.bold(
      col("  total", 14) +
        num(overall.calls, 8).padEnd(8) +
        num(overall.inputTokens, 12).padEnd(12) +
        num(overall.outputTokens, 12).padEnd(12) +
        num(overall.cacheReadTokens, 12).padEnd(12) +
        dollars(overall.costUsd, 12).padEnd(12),
    ),
  );

  // Cache ROI. cacheSavedUsd is computed per-call in totals.ts using
  // the provider rate table — only Anthropic contributes today.
  if (overall.cacheSavedUsd > 0) {
    const baseline = overall.costUsd + overall.cacheSavedUsd;
    const pct =
      baseline > 0 ? ((overall.cacheSavedUsd / baseline) * 100).toFixed(1) : "0.0";
    console.log(
      pc.green(
        `  cache savings:        $${overall.cacheSavedUsd.toFixed(4)} (${pct}% vs. no-cache)`,
      ),
    );
  }

  // Silent-cache-invalidator detector: many Anthropic calls, zero
  // reads. Either a nondeterministic prefix (timestamp/UUID) or the
  // tool set / system prompt is shifting between calls.
  if (isSilentCacheInvalidator(overall)) {
    console.log(
      pc.yellow(
        `  warning:              ${overall.anthropicCalls} Anthropic calls, 0 cache reads — prompt prefix may be invalidating the cache`,
      ),
    );
  }

  // Prompt versions — content hash of each role's system prompt,
  // shown so a cache regression or behavior shift can be tied to a
  // specific prompt revision.
  const planner = loadPromptVersion("planner");
  const coder = loadPromptVersion("coder");
  const reviewer = loadPromptVersion("reviewer");
  console.log(
    pc.dim(
      `  prompts:              planner=${planner} coder=${coder} reviewer=${reviewer}`,
    ),
  );

  console.log(`  outcome:              ${result.reason}`);
}

const dashboardCmd = program
  .command("dashboard")
  .description(
    "Print a cost/outcome table for every run logged under .claw-squad/runs/",
  )
  .option("--root <path>", "repo root", process.cwd())
  .option(
    "--filter <substring>",
    "case-insensitive filter on the requirement column",
  )
  .option(
    "--json",
    "emit machine-readable JSON instead of the human table (good for jq / spreadsheets)",
  )
  .option(
    "--watch [interval]",
    "re-render every N seconds (default 5). Ctrl-C to exit.",
  )
  .action(
    (opts: {
      root: string;
      filter?: string;
      json?: boolean;
      watch?: string | boolean;
    }) => {
      // --watch [interval] is a Commander variadic-ish optional arg.
      // Boolean true means the flag was passed without a value.
      if (opts.watch !== undefined) {
        const intervalMs =
          typeof opts.watch === "string" ? Number(opts.watch) * 1000 : 5_000;
        if (Number.isNaN(intervalMs) || intervalMs < 200) {
          console.error(pc.red(`--watch interval must be ≥ 0.2 seconds`));
          process.exit(1);
        }
        const handle = watchSummaries(opts.root, intervalMs, (summaries) => {
          // Clear screen + move cursor home; portable enough for any
          // ANSI-aware terminal. Plain stdout if NO_COLOR is set.
          if (!process.env.NO_COLOR) {
            process.stdout.write("c");
          }
          const rendered = opts.json
            ? formatJson(opts.filter ? filterByRequirement(summaries, opts.filter) : summaries)
            : formatTable(opts.filter ? filterByRequirement(summaries, opts.filter) : summaries);
          console.log(rendered);
          console.log(
            pc.dim(`\nwatching ${opts.root}/.claw-squad/runs/  •  Ctrl-C to exit`),
          );
        });
        process.on("SIGINT", () => {
          handle.stop();
          process.exit(0);
        });
        return;
      }

      const summaries = loadSummaries(opts.root, { filter: opts.filter });
      if (opts.json) {
        console.log(formatJson(summaries));
      } else {
        console.log(formatTable(summaries));
      }
    },
  );

dashboardCmd
  .command("diff <a> <b>")
  .description(
    "Compare two run IDs (filename without .jsonl). Shows cost / outcome / per-role / per-subagent deltas (b - a).",
  )
  .option("--root <path>", "repo root", process.cwd())
  .option(
    "--json",
    "emit a structured JSON diff instead of the human report",
  )
  .action(
    (
      a: string,
      b: string,
      opts: { root: string; json?: boolean },
    ) => {
      const aSummary = loadSummaryById(opts.root, a);
      const bSummary = loadSummaryById(opts.root, b);
      if (!aSummary) {
        console.error(pc.red(`run ${a} not found under ${opts.root}/.claw-squad/runs/`));
        process.exit(1);
      }
      if (!bSummary) {
        console.error(pc.red(`run ${b} not found under ${opts.root}/.claw-squad/runs/`));
        process.exit(1);
      }
      const report = diffRuns(aSummary, bSummary);
      console.log(opts.json ? formatDiffJson(report) : formatDiff(report));
    },
  );

// Local helper kept off the dashboard module because it's a pure
// rendering convenience — `loadSummaries` already supports filtering
// for the non-watch path, but watchSummaries returns the full set
// (cheaper than re-running the filter logic on every tick).
function filterByRequirement<T extends { requirement?: string }>(
  rows: T[],
  needle: string,
): T[] {
  const n = needle.toLowerCase();
  return rows.filter((r) => r.requirement && r.requirement.toLowerCase().includes(n));
}

program.parseAsync().catch((err) => {
  console.error(pc.red((err as Error).message));
  process.exit(1);
});
