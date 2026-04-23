#!/usr/bin/env node
/**
 * claw-squad CLI entry.
 *
 * `claw-squad run "<requirement>"` kicks off the full 3-agent loop.
 * `claw-squad dry "<requirement>"` runs without pushing to GitHub (default).
 * `claw-squad init` scaffolds .claw-squad/ in the current repo.
 */

import { Command } from "commander";
import pc from "picocolors";
import prompts from "prompts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOrchestrator, type UserInterface } from "./orchestrator.js";
import type { RunConfig } from "./types.js";

const program = new Command();

program
  .name("claw-squad")
  .description(
    "3-agent Claude orchestrator: Planner -> Coder -> Reviewer with self-learning memory.",
  )
  .version("0.1.0");

program
  .command("run")
  .description("Run the 3-agent loop on a requirement (GitHub disabled by default).")
  .argument("<requirement>", "the feature / task / question in plain language")
  .option("--root <path>", "repo root (defaults to cwd)", process.cwd())
  .option("--max-clarifications <n>", "max Planner Q&A rounds", "3")
  .option("--max-review-rounds <n>", "max Coder↔Reviewer rounds per task", "3")
  .option("--max-loops <n>", "max tasks to complete in one run", "10")
  .option("--sandbox", "wrap Coder subprocess calls with claw-sandbox (Go binary). Default off.")
  .option("--github", "actually push and PR to GitHub. Default off (dry local run).")
  .option("--github-repo <owner/repo>", "GitHub repo target when --github is set")
  .option("--no-self-learning", "disable memory/lessons.md writing")
  .option("--no-confirm", "skip human confirmation on destructive GitHub actions")
  .action(async (requirement: string, opts) => {
    const config: RunConfig = {
      repoRoot: opts.root,
      maxClarifications: Number(opts.maxClarifications),
      maxReviewRounds: Number(opts.maxReviewRounds),
      maxLoops: Number(opts.maxLoops),
      requireHumanApproval: opts.confirm !== false,
      sandboxEnabled: Boolean(opts.sandbox),
      selfLearning: opts.selfLearning !== false,
      githubEnabled: Boolean(opts.github),
      githubRepo: opts.githubRepo,
    };

    if (config.githubEnabled && !config.githubRepo) {
      console.error(pc.red("--github requires --github-repo owner/name"));
      process.exit(1);
    }

    logConfig(config);
    const ui = buildUI();

    try {
      const result = await runOrchestrator({ config, requirement, ui });
      printSummary(result);
      if (result.reason === "complete") process.exit(0);
      if (result.reason === "blocked" || result.reason === "aborted")
        process.exit(2);
      process.exit(3);
    } catch (err) {
      console.error(pc.red(`\nFatal: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Create .claw-squad/ directory + default config.")
  .option("--root <path>", "repo root", process.cwd())
  .action((opts) => {
    const dir = join(opts.root, ".claw-squad");
    mkdirSync(join(dir, "memory"), { recursive: true });
    const cfgPath = join(dir, "config.json");
    if (!existsSync(cfgPath)) {
      writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            maxClarifications: 3,
            maxReviewRounds: 3,
            maxLoops: 10,
            sandboxEnabled: false,
            selfLearning: true,
            githubEnabled: false,
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
    }
    console.log(pc.green(`Initialized ${dir}`));
  });

function logConfig(c: RunConfig): void {
  console.log(pc.dim("─".repeat(60)));
  console.log(pc.bold("claw-squad configuration"));
  console.log(`  root:            ${c.repoRoot}`);
  console.log(`  sandbox:         ${c.sandboxEnabled ? pc.yellow("ON") : pc.dim("off (default)")}`);
  console.log(`  self-learning:   ${c.selfLearning ? pc.green("on") : pc.dim("off")}`);
  console.log(`  github:          ${c.githubEnabled ? pc.yellow("ON") : pc.dim("off (dry run)")}`);
  console.log(`  max clarifs:     ${c.maxClarifications}`);
  console.log(`  max review:      ${c.maxReviewRounds}`);
  console.log(`  max loops:       ${c.maxLoops}`);
  console.log(pc.dim("─".repeat(60)));
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
