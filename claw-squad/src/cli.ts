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
import { loadAgentConfig, type AgentCliOverride } from "./config.js";
import { loadSnapshot } from "./snapshot.js";
import { loadHooksFromFile, NO_HOOKS, type Hooks } from "./hooks.js";
import { detectTestCommand } from "./test-runner.js";
import type { AgentRole, RunConfig } from "./types.js";

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
  .option("--tui", "use the Ink-based terminal UI instead of plain streaming output");

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
    };

    if (config.githubEnabled && !config.githubRepo) {
      console.error(pc.red("--github requires --github-repo owner/name"));
      process.exit(1);
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

    // TUI or plain CLI? The TUI is opt-in AND requires a TTY — if
    // stdout is redirected (CI, pipe) we fall back silently.
    let ui: UserInterface;
    let tuiInstance: { unmount(): void } | undefined;
    if (opts.tui && process.stdout.isTTY) {
      const { TuiUi } = await import("./tui/tui.js");
      const tui = new TuiUi();
      tui.mount();
      ui = tui;
      tuiInstance = tui;
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
          `Resuming from ${snap.savedAt} — ${snap.state.todos.length} todos, loopCount=${snap.state.loopCount}, prior spend $${snap.totals.costUsd.toFixed(4)}`,
        ),
      );
    }

    try {
      const result = await runOrchestrator({
        config,
        agentConfig,
        requirement,
        ui,
        hooks,
        resumeFrom,
        resumeTotals,
      });
      tuiInstance?.unmount();
      printSummary(result);
      if (result.reason === "complete") process.exit(0);
      if (result.reason === "blocked" || result.reason === "aborted")
        process.exit(2);
      process.exit(3);
    } catch (err) {
      tuiInstance?.unmount();
      console.error(pc.red(`\nFatal: ${(err as Error).message}`));
      process.exit(1);
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
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    calls: number;
  };
  reason: string;
}): void {
  const t = result.totals;
  console.log(pc.dim("\n" + "─".repeat(60)));
  console.log(pc.bold("Usage summary"));
  console.log(`  LLM calls:            ${t.calls}`);
  console.log(`  input tokens:         ${t.inputTokens.toLocaleString()}`);
  console.log(`  output tokens:        ${t.outputTokens.toLocaleString()}`);
  console.log(`  cache reads (~10%):   ${t.cacheReadTokens.toLocaleString()}`);
  console.log(`  cache writes:         ${t.cacheCreationTokens.toLocaleString()}`);
  console.log(`  estimated cost:       $${t.costUsd.toFixed(4)}`);
  console.log(`  outcome:              ${result.reason}`);
}

program.parseAsync().catch((err) => {
  console.error(pc.red((err as Error).message));
  process.exit(1);
});
