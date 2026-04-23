/**
 * 3-agent orchestrator.
 *
 * Loop invariants:
 *   1. Planner runs in Q&A mode until `planReady` is set. No Coder calls
 *      happen before that — this is what saves Coder tokens per the user's
 *      brief.
 *   2. Per task: Coder produces a diff -> Reviewer approves or requests
 *      changes -> Coder iterates. Bounded by `maxReviewRounds`.
 *   3. After a task merges, Planner is re-invoked with the updated state +
 *      memory snippet. Planner decides what's next.
 *   4. Every LLM call's usage is tallied into `totals` — visible to the
 *      user at the end for budget accountability.
 *
 * Human-in-the-loop:
 *   - Clarifying questions always go back to the user (Planner's purpose).
 *   - Destructive GitHub actions (push, merge) gate on `requireHumanApproval`.
 *     Default true until the user opts out — we err toward safety.
 *
 * Provider neutrality:
 *   - Each agent gets its own Provider instance from the registry. Users
 *     can set per-agent provider+model in .claw-squad/config.json or via
 *     CLI flags. Defaults are Anthropic (opus-4-7 / sonnet-4-6 / opus-4-7).
 */

import pc from "picocolors";
import { runPlanner, recordClarification } from "./agents/planner.js";
import { runCoder } from "./agents/coder.js";
import { runReviewer } from "./agents/reviewer.js";
import {
  appendLesson,
  lessonFromCompletedTask,
  readMemorySnippet,
} from "./memory/memory.js";
import { applyAndCommit, readFileSnapshots } from "./sandbox/applier.js";
import type { AgentConfig } from "./config.js";
import { createProvider, estimateCost } from "./providers/registry.js";
import type { InvokeResult, Provider } from "./providers/types.js";
import {
  type ReviewVerdict,
  type RunConfig,
  type SquadState,
  type TodoItem,
} from "./types.js";

export interface UserInterface {
  /** Prompt the user for answers to Planner's questions. */
  askClarifications: (questions: string[]) => Promise<string[]>;
  /** Confirm a destructive action (push / merge). */
  confirm: (prompt: string) => Promise<boolean>;
  /** Surface progress messages. */
  log: (msg: string) => void;
  /** Surface an agent's streamed output. */
  streamAgent: (role: string, chunk: string) => void;
}

export interface OrchestratorResult {
  state: SquadState;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    calls: number;
  };
  reason: "complete" | "max_loops" | "blocked" | "aborted";
}

interface Providers {
  planner: Provider;
  coder: Provider;
  reviewer: Provider;
}

function buildProviders(agentCfg: AgentConfig): Providers {
  return {
    planner: createProvider(agentCfg.planner),
    coder: createProvider(agentCfg.coder),
    reviewer: createProvider(agentCfg.reviewer),
  };
}

export async function runOrchestrator(args: {
  config: RunConfig;
  agentConfig: AgentConfig;
  requirement: string;
  ui: UserInterface;
}): Promise<OrchestratorResult> {
  const { config, requirement, ui, agentConfig } = args;
  const providers = buildProviders(agentConfig);

  const state: SquadState = {
    requirement,
    clarifications: [],
    planReady: false,
    todos: [],
    reviewHistory: [],
    loopCount: 0,
  };

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const track = (u: InvokeResult) => {
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    totals.cacheReadTokens += u.cacheReadTokens;
    totals.cacheCreationTokens += u.cacheCreationTokens;
    totals.costUsd += estimateCost(u);
    totals.calls += 1;
  };

  // --- Phase 1: Planner Q&A until ready ---
  let clarificationRounds = 0;
  while (!state.planReady) {
    if (clarificationRounds >= config.maxClarifications) {
      ui.log(
        pc.yellow(
          `Max clarifications (${config.maxClarifications}) reached. Forcing planReady.`,
        ),
      );
      state.planReady = true;
      break;
    }

    ui.log(pc.cyan("\n[Planner] thinking…"));
    const memorySnippet = config.selfLearning
      ? readMemorySnippet(config.repoRoot)
      : undefined;

    const outcome = await runPlanner({
      state,
      mode: "initial",
      memorySnippet,
      provider: providers.planner,
      onText: (c) => ui.streamAgent("planner", c),
    });
    track(outcome.usage);

    if (outcome.phase === "clarification" && outcome.questions?.length) {
      const answers = await ui.askClarifications(outcome.questions);
      for (let i = 0; i < outcome.questions.length; i++) {
        const q = outcome.questions[i];
        const a = answers[i];
        if (q !== undefined && a !== undefined) {
          recordClarification(state, q, a);
        }
      }
      clarificationRounds += 1;
    } else if (outcome.phase === "ready") {
      state.planReady = true;
      ui.log(pc.green("\n[Planner] requirements clear."));
    } else if (outcome.phase === "todos" && outcome.todos) {
      // Planner jumped straight to todos — accept.
      state.planReady = true;
      state.todos = outcome.todos;
    } else {
      // Phase unknown — force ready to prevent stall.
      state.planReady = true;
    }
  }

  // --- Phase 2: TODO list generation (if Planner didn't produce one yet) ---
  if (state.todos.length === 0) {
    ui.log(pc.cyan("\n[Planner] producing TODO list…"));
    const outcome = await runPlanner({
      state,
      mode: "initial",
      memorySnippet: config.selfLearning
        ? readMemorySnippet(config.repoRoot)
        : undefined,
      provider: providers.planner,
      onText: (c) => ui.streamAgent("planner", c),
    });
    track(outcome.usage);
    if (outcome.todos && outcome.todos.length > 0) {
      state.todos = outcome.todos;
    } else {
      return { state, totals, reason: "blocked" };
    }
  }

  // --- Phase 3: Per-task loop ---
  while (state.loopCount < config.maxLoops) {
    const next = state.todos.find((t) => t.status === "pending");
    if (!next) {
      ui.log(pc.green("\n[Orchestrator] all TODOs complete."));
      return { state, totals, reason: "complete" };
    }
    state.activeTaskId = next.id;
    next.status = "in_progress";
    state.reviewHistory = [];

    const reason = await runTaskLoop({
      task: next,
      state,
      config,
      providers,
      ui,
      track,
    });

    if (reason === "blocked" || reason === "aborted") {
      return { state, totals, reason };
    }

    next.status = "done";
    state.loopCount += 1;

    // Self-learning: append a lesson summarizing this task.
    if (config.selfLearning) {
      const lesson = lessonFromCompletedTask(next, state.reviewHistory);
      appendLesson(config.repoRoot, lesson);
    }

    // Planner re-invoked on outer loop to review TODO + plan next step.
    ui.log(pc.cyan("\n[Planner] reviewing progress…"));
    const plannerReview = await runPlanner({
      state,
      mode: "loop",
      memorySnippet: config.selfLearning
        ? readMemorySnippet(config.repoRoot)
        : undefined,
      completedTaskSummary: summarizeTask(next, state.reviewHistory),
      provider: providers.planner,
      onText: (c) => ui.streamAgent("planner", c),
    });
    track(plannerReview.usage);
    if (plannerReview.phase === "complete") {
      return { state, totals, reason: "complete" };
    }
    if (plannerReview.todos && plannerReview.todos.length > 0) {
      // Planner gave a revised TODO list — merge by id, preserving done/in-progress.
      const prevById = new Map(state.todos.map((t) => [t.id, t]));
      state.todos = plannerReview.todos.map(
        (t) => prevById.get(t.id) ?? t,
      );
    }
  }

  return { state, totals, reason: "max_loops" };
}

async function runTaskLoop(args: {
  task: TodoItem;
  state: SquadState;
  config: RunConfig;
  providers: Providers;
  ui: UserInterface;
  track: (u: InvokeResult) => void;
}): Promise<"complete" | "blocked" | "aborted"> {
  const { task, state, config, providers, ui, track } = args;
  let lastVerdict: ReviewVerdict | undefined;

  for (let round = 0; round < config.maxReviewRounds; round++) {
    task.iterations += 1;
    ui.log(
      pc.cyan(
        `\n[Coder] round ${round + 1}/${config.maxReviewRounds} on ${task.id}…`,
      ),
    );

    // Heuristic: if reviewer gave specific file paths, read those. Otherwise
    // pass no context — Coder creates files from scratch based on the TODO.
    const contextPaths = lastVerdict
      ? Array.from(
          new Set(
            lastVerdict.findings
              .map((f) => f.file)
              .filter((f): f is string => !!f),
          ),
        )
      : [];
    const fileContext = readFileSnapshots(config.repoRoot, contextPaths);

    const coderOut = await runCoder({
      requirement: state.requirement,
      todo: task,
      fileContext,
      reviewerFeedback: lastVerdict,
      provider: providers.coder,
      onText: (c) => ui.streamAgent("coder", c),
    });
    track(coderOut.usage);

    if (coderOut.blocked) {
      ui.log(pc.red(`\n[Coder] BLOCKED: ${coderOut.reason}`));
      task.status = "abandoned";
      return "blocked";
    }
    if (!coderOut.files || coderOut.files.length === 0) {
      ui.log(pc.yellow("[Coder] produced no file edits; skipping commit."));
      continue;
    }

    // Apply to working tree + commit.
    const branch = `claw-squad/${task.id.toLowerCase()}`;
    const applied = applyAndCommit({
      repoRoot: config.repoRoot,
      branch,
      edits: coderOut.files,
      commitMessage: coderOut.commitMessage ?? `chore: ${task.title}`,
      sandboxEnabled: config.sandboxEnabled,
    });

    if (applied.diff.trim().length === 0) {
      ui.log(pc.yellow("[Coder] no effective changes after apply."));
      continue;
    }

    // Reviewer reads the diff.
    ui.log(pc.cyan(`\n[Reviewer] examining diff (${applied.diff.length} bytes)…`));
    const reviewOut = await runReviewer({
      todo: task,
      diff: applied.diff,
      coderRationale: coderOut.rationale,
      provider: providers.reviewer,
      onText: (c) => ui.streamAgent("reviewer", c),
    });
    track(reviewOut.usage);

    state.reviewHistory.push(reviewOut.verdict);
    lastVerdict = reviewOut.verdict;

    if (reviewOut.verdict.decision === "approve") {
      ui.log(pc.green(`\n[Reviewer] APPROVED ${task.id}.`));
      // Phase 2 (not yet wired): push branch + open PR + merge via Octokit.
      if (config.githubEnabled && config.requireHumanApproval) {
        const ok = await ui.confirm(
          `Merge ${branch} into main for task ${task.id}?`,
        );
        if (!ok) {
          ui.log(pc.yellow("User declined merge. Aborting."));
          return "aborted";
        }
      }
      return "complete";
    }

    ui.log(
      pc.yellow(
        `\n[Reviewer] requested changes (${reviewOut.verdict.findings.length} findings).`,
      ),
    );
  }

  ui.log(
    pc.red(
      `\n[Orchestrator] max review rounds exceeded on ${task.id}. Marking abandoned.`,
    ),
  );
  task.status = "abandoned";
  return "blocked";
}

function summarizeTask(task: TodoItem, reviews: ReviewVerdict[]): string {
  const rounds = reviews.length;
  const lastSummary = reviews.at(-1)?.summary ?? "<no review>";
  return `Task ${task.id} (${task.title}): ${rounds} review round(s). Final: ${lastSummary}`;
}
