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
import { gatherInitialContext } from "./context-gather.js";
import {
  HookAbort,
  runHook,
  wrapWithHooks,
  type Hooks,
} from "./hooks.js";
import { saveSnapshot } from "./snapshot.js";
import { runTests, type TestRunResult } from "./test-runner.js";
import {
  loadSkills,
  renderSkillCatalog,
  renderSkillsForCoder,
  selectSkillsForTask,
  type Skill,
} from "./skills.js";
import { summarizeChecks } from "./github/octokit.js";
import {
  parseDelegates,
  renderSubagentAnswers,
  runSubagent,
  type SubagentResponse,
  type SubagentSpec,
} from "./agents/subagent.js";
import {
  makeGithubClient,
  parseOwnerRepo,
  type GithubClient,
} from "./github/octokit.js";
import { detectDefaultBranch } from "./git.js";
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

function buildProviders(
  agentCfg: AgentConfig,
  hooks: Hooks,
  log: (m: string) => void,
): Providers {
  return {
    planner: wrapWithHooks(createProvider(agentCfg.planner), hooks, log),
    coder: wrapWithHooks(createProvider(agentCfg.coder), hooks, log),
    reviewer: wrapWithHooks(createProvider(agentCfg.reviewer), hooks, log),
  };
}

export async function runOrchestrator(args: {
  config: RunConfig;
  agentConfig: AgentConfig;
  requirement: string;
  ui: UserInterface;
  hooks?: Hooks;
  /** Resume from this state instead of starting from scratch. */
  resumeFrom?: SquadState;
  /** Resume totals — lets end-of-run reporting include prior spend. */
  resumeTotals?: OrchestratorResult["totals"];
}): Promise<OrchestratorResult> {
  const { config, requirement, ui, agentConfig } = args;
  const hooks: Hooks = args.hooks ?? {};
  const providers = buildProviders(agentConfig, hooks, ui.log);

  // Skills catalog is loaded once up front. Planner sees compact
  // (name, description) list; activated skills get pasted into Coder's
  // user turn per task.
  const allSkills: Skill[] = loadSkills(config.repoRoot, ui.log);
  const skillCatalog = renderSkillCatalog(allSkills);

  // Subagents (optional). Build providers for each declared subagent
  // once up front — same approach as the three primaries, so hooks +
  // caching apply uniformly.
  const subagents: SubagentSpec[] = (agentConfig.subagents ?? []).map((s) => ({
    name: s.name,
    description: s.description,
    systemPrompt: s.systemPrompt,
    provider: wrapWithHooks(createProvider(s.provider), hooks, ui.log),
  }));
  const subagentCatalog = renderSubagentCatalog(subagents);

  // Answers from subagents accumulate here between Planner turns. The
  // next Planner invocation folds them into its user message and the
  // buffer is cleared.
  let pendingSubagentAnswers: SubagentResponse[] = [];

  /**
   * After a Planner response, scan for `## Delegate <name>` directives
   * and run the matching subagents. Their answers are queued for the
   * *next* Planner turn. Returns the number of delegations actually
   * executed (for logging).
   */
  const dispatchDelegates = async (plannerText: string): Promise<number> => {
    if (subagents.length === 0) return 0;
    const requested = parseDelegates(plannerText);
    if (requested.length === 0) return 0;
    const byName = new Map(subagents.map((s) => [s.name, s]));
    let dispatched = 0;
    for (const r of requested) {
      const spec = byName.get(r.name);
      if (!spec) {
        ui.log(
          pc.yellow(
            `  [subagent] Planner asked for "${r.name}" which isn't in the catalog — ignoring`,
          ),
        );
        continue;
      }
      ui.log(pc.cyan(`\n[subagent:${r.name}] answering…`));
      try {
        const resp = await runSubagent(spec, {
          name: r.name,
          prompt: r.prompt,
          requestedBy: "planner",
        });
        track(resp.usage);
        pendingSubagentAnswers.push(resp);
        dispatched += 1;
      } catch (err) {
        ui.log(
          pc.red(
            `  [subagent:${r.name}] failed: ${(err as Error).message}`,
          ),
        );
      }
      if (!checkBudget()) break;
    }
    return dispatched;
  };

  // GitHub client is optional. When disabled, runTaskLoop simply skips
  // the push/PR/merge calls — the local commit still happens.
  let github: GithubClient | undefined;
  let ownerRepo: { owner: string; repo: string } | undefined;
  let baseBranch = "main";
  if (config.githubEnabled) {
    if (!config.githubRepo) {
      throw new Error("githubEnabled=true requires githubRepo (owner/name)");
    }
    github = makeGithubClient();
    ownerRepo = parseOwnerRepo(config.githubRepo);
    baseBranch = detectDefaultBranch({
      repoRoot: config.repoRoot,
      sandboxEnabled: config.sandboxEnabled,
    });
  }

  const state: SquadState = args.resumeFrom ?? {
    requirement,
    clarifications: [],
    planReady: false,
    todos: [],
    reviewHistory: [],
    loopCount: 0,
  };

  const totals = args.resumeTotals ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const persist = () => saveSnapshot(config.repoRoot, state, totals);
  let budgetExceeded: string | undefined;
  const track = (u: InvokeResult) => {
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    totals.cacheReadTokens += u.cacheReadTokens;
    totals.cacheCreationTokens += u.cacheCreationTokens;
    totals.costUsd += estimateCost(u);
    totals.calls += 1;

    // Hard caps — checked AFTER each call so we trip as soon as we're
    // over. The orchestrator polls `budgetExceeded` between stages and
    // aborts with reason=aborted if set.
    if (
      config.maxCostUsd !== undefined &&
      totals.costUsd > config.maxCostUsd
    ) {
      budgetExceeded = `cost cap $${config.maxCostUsd.toFixed(4)} exceeded (used $${totals.costUsd.toFixed(4)})`;
    }
    const totalTokens =
      totals.inputTokens +
      totals.outputTokens +
      totals.cacheReadTokens +
      totals.cacheCreationTokens;
    if (config.maxTokens !== undefined && totalTokens > config.maxTokens) {
      budgetExceeded = `token cap ${config.maxTokens.toLocaleString()} exceeded (used ${totalTokens.toLocaleString()})`;
    }

    // Fire the budget-exceeded hook once, on the transition from ok -> over.
    if (budgetExceeded) {
      void runHook("onBudgetExceeded", ui.log, () =>
        hooks.onBudgetExceeded?.(budgetExceeded!),
      );
    }
  };

  const checkBudget = (): boolean => {
    if (!budgetExceeded) return true;
    ui.log(pc.red(`\n[Orchestrator] ${budgetExceeded}. Aborting.`));
    return false;
  };

  try {
    return await runPhases();
  } finally {
    // Always persist — even on exception — so --resume can pick up.
    try {
      persist();
    } catch (err) {
      ui.log(`[snapshot] save failed: ${(err as Error).message}`);
    }
  }

  async function runPhases(): Promise<OrchestratorResult> {
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
    const memorySnippet = composePlannerSnippet({
      memory: config.selfLearning ? readMemorySnippet(config.repoRoot) : undefined,
      skillCatalog,
      subagentCatalog,
      subagentAnswers: pendingSubagentAnswers,
    });
    pendingSubagentAnswers = [];

    const outcome = await runPlanner({
      state,
      mode: "initial",
      memorySnippet,
      provider: providers.planner,
      onText: (c) => ui.streamAgent("planner", c),
    });
    track(outcome.usage);
    if (!checkBudget()) return { state, totals, reason: "aborted" };

    // If Planner delegated any work, run it now — answers feed into
    // the next Planner turn via pendingSubagentAnswers.
    await dispatchDelegates(outcome.message);

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
      memorySnippet: composePlannerSnippet({
        memory: config.selfLearning ? readMemorySnippet(config.repoRoot) : undefined,
        skillCatalog,
        subagentCatalog,
        subagentAnswers: pendingSubagentAnswers,
      }),
      provider: providers.planner,
      onText: (c) => ui.streamAgent("planner", c),
    });
    track(outcome.usage);
    if (!checkBudget()) return { state, totals, reason: "aborted" };
    await dispatchDelegates(outcome.message);
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
      github,
      ownerRepo,
      baseBranch,
      ui,
      track,
      checkBudget,
      hooks,
      allSkills,
    });

    if (reason === "blocked" || reason === "aborted") {
      return { state, totals, reason };
    }
    if (!checkBudget()) return { state, totals, reason: "aborted" };

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
      memorySnippet: composePlannerSnippet({
        memory: config.selfLearning ? readMemorySnippet(config.repoRoot) : undefined,
        skillCatalog,
        subagentCatalog,
        subagentAnswers: pendingSubagentAnswers,
      }),
      completedTaskSummary: summarizeTask(next, state.reviewHistory),
      provider: providers.planner,
      onText: (c) => ui.streamAgent("planner", c),
    });
    track(plannerReview.usage);
    if (!checkBudget()) return { state, totals, reason: "aborted" };
    await dispatchDelegates(plannerReview.message);
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

    // Snapshot at the end of each outer loop so --resume picks up here.
    persist();
  }

  return { state, totals, reason: "max_loops" };
  } // end runPhases
}

async function runTaskLoop(args: {
  task: TodoItem;
  state: SquadState;
  config: RunConfig;
  providers: Providers;
  github?: GithubClient;
  ownerRepo?: { owner: string; repo: string };
  baseBranch: string;
  ui: UserInterface;
  track: (u: InvokeResult) => void;
  checkBudget: () => boolean;
  hooks: Hooks;
  allSkills: Skill[];
}): Promise<"complete" | "blocked" | "aborted"> {
  const {
    task,
    state,
    config,
    providers,
    github,
    ownerRepo,
    baseBranch,
    ui,
    track,
    checkBudget,
    hooks,
    allSkills,
  } = args;
  let lastVerdict: ReviewVerdict | undefined;
  let prNumber: number | undefined;

  for (let round = 0; round < config.maxReviewRounds; round++) {
    task.iterations += 1;
    ui.log(
      pc.cyan(
        `\n[Coder] round ${round + 1}/${config.maxReviewRounds} on ${task.id}…`,
      ),
    );

    // Context selection:
    //   - Rounds 2+: read exactly the files Reviewer pointed at. That's
    //     the cheapest, most-focused context shape.
    //   - Round 1:  ask context-gather to scan tracked files for keyword
    //     matches against the TODO. This replaces the old "no context"
    //     behavior that forced the Coder to invent file contents blind.
    let fileContext: Array<{ path: string; content: string }>;
    if (lastVerdict) {
      const contextPaths = Array.from(
        new Set(
          lastVerdict.findings
            .map((f) => f.file)
            .filter((f): f is string => !!f),
        ),
      );
      fileContext = readFileSnapshots(config.repoRoot, contextPaths);
    } else {
      const gathered = gatherInitialContext({
        git: {
          repoRoot: config.repoRoot,
          sandboxEnabled: config.sandboxEnabled,
        },
        todoTitle: task.title,
        todoDescription: task.description,
      });
      fileContext = gathered.files;
      if (gathered.files.length > 0) {
        ui.log(
          pc.dim(
            `  [context] round 1 preloaded ${gathered.files.length} file(s): ${gathered.files.map((f) => f.path).join(", ")}`,
          ),
        );
      }
    }

    // Select skills: explicit tags from Planner plus apply_to globs
    // matching any file in the Coder's context. Rendered once per
    // round so the Coder sees current context-derived activations.
    const activeSkills = selectSkillsForTask({
      allSkills,
      taggedNames: task.skills,
      contextFilePaths: fileContext.map((f) => f.path),
    });
    const skillsBlock = renderSkillsForCoder(activeSkills);
    if (activeSkills.length > 0) {
      ui.log(
        pc.dim(
          `  [skills] active: ${activeSkills.map((s) => s.name).join(", ")}`,
        ),
      );
    }

    const coderOut = await runCoder({
      requirement: state.requirement,
      todo: task,
      fileContext,
      reviewerFeedback: lastVerdict,
      skillsBlock,
      provider: providers.coder,
      onText: (c) => ui.streamAgent("coder", c),
    });
    track(coderOut.usage);
    if (!checkBudget()) return "aborted";

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
    try {
      await runHook("preCommit", ui.log, () =>
        hooks.preCommit?.(
          { taskId: task.id, branch },
          coderOut.files ?? [],
        ),
      );
    } catch (err) {
      if (err instanceof HookAbort) {
        ui.log(pc.red(`\n[hook] ${err.reason} — aborting task`));
        task.status = "abandoned";
        return "blocked";
      }
      throw err;
    }
    const applied = applyAndCommit({
      repoRoot: config.repoRoot,
      branch,
      edits: coderOut.files,
      commitMessage: coderOut.commitMessage ?? `chore: ${task.title}`,
      sandboxEnabled: config.sandboxEnabled,
    });
    await runHook("postCommit", ui.log, () =>
      hooks.postCommit?.(
        { taskId: task.id, branch },
        {
          diff: applied.diff,
          sha: applied.commitSha,
          files: applied.filesApplied,
        },
      ),
    );

    if (applied.diff.trim().length === 0) {
      ui.log(pc.yellow("[Coder] no effective changes after apply."));
      continue;
    }

    // Test runner — between Coder and Reviewer. Cheap bug-catcher:
    // if the tests already fail, we skip Reviewer entirely (saves
    // real money on the Reviewer LLM call) and send Coder back to
    // fix the failure.
    if (config.testCommand) {
      ui.log(pc.cyan(`\n[Tests] running: ${config.testCommand}`));
      const testResult = runTests({
        repoRoot: config.repoRoot,
        command: config.testCommand,
        timeoutMs: config.testTimeoutMs,
        sandboxEnabled: config.sandboxEnabled,
      });
      if (testResult && !testResult.passed) {
        ui.log(
          pc.red(
            `[Tests] FAILED (exit=${testResult.exitCode ?? "?"}${testResult.timedOut ? ", timed out" : ""}, ${testResult.durationMs}ms)`,
          ),
        );
        // Synthesize a Reviewer-style verdict so the next Coder round
        // has concrete fix instructions. Marked as `critical` so it
        // jumps the Coder's attention.
        const synthetic: ReviewVerdict = {
          decision: "request_changes",
          summary: `Automated tests failed (${config.testCommand}). Fix the failures before requesting review.`,
          findings: [
            {
              severity: "critical",
              issue: "Test suite failed after this commit",
              suggestion: `Read the output below and fix the failing assertions. Do not mask failures.\n\n\`\`\`\n${testResult.output}\n\`\`\``,
            },
          ],
        };
        state.reviewHistory.push(synthetic);
        lastVerdict = synthetic;
        continue;
      }
      if (testResult) {
        ui.log(pc.green(`[Tests] passed in ${testResult.durationMs}ms`));
      }
    }

    // Push to GitHub + ensure PR exists (first round) or just push (later
    // rounds). We do this BEFORE Reviewer runs so the GitHub review we
    // post later anchors on an existing PR.
    if (github && ownerRepo) {
      try {
        await github.pushBranch({
          git: {
            repoRoot: config.repoRoot,
            sandboxEnabled: config.sandboxEnabled,
          },
          branch,
        });
        if (prNumber === undefined) {
          const pr = await github.ensurePr({
            owner: ownerRepo.owner,
            repo: ownerRepo.repo,
            branch,
            base: baseBranch,
            title: `[${task.id}] ${task.title}`,
            body: buildPrBody(task, state),
          });
          prNumber = pr.number;
          ui.log(pc.cyan(`\n[GitHub] draft PR #${prNumber}: ${pr.html_url}`));
        } else {
          ui.log(pc.dim(`\n[GitHub] pushed commit to PR #${prNumber}`));
        }
      } catch (err) {
        ui.log(pc.red(`\n[GitHub] push/PR failed: ${(err as Error).message}`));
        // GitHub errors shouldn't kill the run — we still have the local
        // commit. Continue to Reviewer so the user at least sees the
        // verdict.
      }
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
    if (!checkBudget()) return "aborted";

    state.reviewHistory.push(reviewOut.verdict);
    lastVerdict = reviewOut.verdict;

    // Mirror the verdict onto GitHub as a PR review.
    if (github && ownerRepo && prNumber !== undefined) {
      try {
        await github.postReview({
          owner: ownerRepo.owner,
          repo: ownerRepo.repo,
          prNumber,
          verdict: reviewOut.verdict,
        });
      } catch (err) {
        ui.log(
          pc.red(
            `\n[GitHub] posting review failed: ${(err as Error).message}`,
          ),
        );
      }
    }

    if (reviewOut.verdict.decision === "approve") {
      ui.log(pc.green(`\n[Reviewer] APPROVED ${task.id}.`));

      // CI wait — block until GitHub checks are green before merging.
      // Only active when we have a PR AND --wait-for-ci is set. On CI
      // failure we loop back to Coder with the failure summary as
      // Reviewer feedback, exactly like the test-runner path.
      if (
        config.waitForCi &&
        github &&
        ownerRepo &&
        prNumber !== undefined
      ) {
        ui.log(pc.cyan(`\n[CI] waiting for checks on PR #${prNumber}…`));
        try {
          const ci = await github.waitForCi({
            owner: ownerRepo.owner,
            repo: ownerRepo.repo,
            prNumber,
            timeoutMs: config.ciTimeoutMs,
            onProgress: (checks) =>
              ui.log(pc.dim(`  [CI] ${summarizeChecks(checks)}`)),
          });
          if (ci.outcome === "failed") {
            const failed = ci.checks
              .filter(
                (c) =>
                  c.status === "completed" &&
                  (c.conclusion === "failure" ||
                    c.conclusion === "timed_out" ||
                    c.conclusion === "cancelled"),
              )
              .map((c) => `- ${c.name} (${c.conclusion}) ${c.detailsUrl ?? ""}`)
              .join("\n");
            ui.log(pc.red(`[CI] failed:\n${failed}`));
            const synthetic: ReviewVerdict = {
              decision: "request_changes",
              summary: `CI failed on PR #${prNumber}. Address the failing checks before approval.`,
              findings: [
                {
                  severity: "critical",
                  issue: "GitHub CI reported failures",
                  suggestion: `Fix these checks:\n${failed}`,
                },
              ],
            };
            state.reviewHistory.push(synthetic);
            lastVerdict = synthetic;
            continue;
          }
          if (ci.outcome === "pending_timeout") {
            ui.log(
              pc.yellow(
                `[CI] still pending after ${Math.round(ci.elapsedMs / 1000)}s — not merging`,
              ),
            );
            return "blocked";
          }
          ui.log(pc.green(`[CI] passed (${ci.checks.length} checks)`));
        } catch (err) {
          ui.log(pc.red(`[CI] wait failed: ${(err as Error).message}`));
          // Don't merge if we couldn't verify CI — surface and stop.
          return "blocked";
        }
      }

      if (github && ownerRepo && prNumber !== undefined) {
        if (config.requireHumanApproval) {
          const ok = await ui.confirm(
            `Merge PR #${prNumber} (${branch} → ${baseBranch}) for task ${task.id}?`,
          );
          if (!ok) {
            ui.log(pc.yellow("User declined merge. Aborting."));
            return "aborted";
          }
        }
        try {
          const merge = await github.markReadyAndMerge({
            owner: ownerRepo.owner,
            repo: ownerRepo.repo,
            prNumber,
            commitTitle: `${task.id}: ${task.title}`,
          });
          if (merge.merged) {
            task.mergedPrNumber = prNumber;
            ui.log(
              pc.green(
                `\n[GitHub] merged PR #${prNumber}${merge.sha ? ` (${merge.sha.slice(0, 7)})` : ""}`,
              ),
            );
          } else {
            ui.log(
              pc.yellow(`\n[GitHub] merge returned merged=false for PR #${prNumber}`),
            );
          }
        } catch (err) {
          ui.log(pc.red(`\n[GitHub] merge failed: ${(err as Error).message}`));
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

function buildPrBody(task: TodoItem, state: SquadState): string {
  const lines = [
    `## Task ${task.id}`,
    `**${task.title}**`,
    "",
    task.description,
    "",
    "### Requirement (original)",
    state.requirement,
    "",
    "---",
    "This PR is managed by `claw-squad`. Reviewer comments below are posted by the Reviewer agent.",
  ];
  return lines.join("\n");
}

function summarizeTask(task: TodoItem, reviews: ReviewVerdict[]): string {
  const rounds = reviews.length;
  const lastSummary = reviews.at(-1)?.summary ?? "<no review>";
  return `Task ${task.id} (${task.title}): ${rounds} review round(s). Final: ${lastSummary}`;
}

/**
 * Join memory + skill catalog + subagent catalog + last-turn delegate
 * answers into the Planner's memorySnippet slot. Everything here is
 * volatile relative to the cached system prompt, so it lives in the
 * user turn. Any subset can be empty.
 */
function composePlannerSnippet(args: {
  memory?: string;
  skillCatalog: string;
  subagentCatalog: string;
  subagentAnswers: SubagentResponse[];
}): string | undefined {
  const parts: string[] = [];
  if (args.memory && args.memory.trim().length > 0) parts.push(args.memory.trim());
  if (args.skillCatalog && args.skillCatalog.trim().length > 0) {
    parts.push(args.skillCatalog.trim());
  }
  if (args.subagentCatalog && args.subagentCatalog.trim().length > 0) {
    parts.push(args.subagentCatalog.trim());
  }
  const answers = renderSubagentAnswers(args.subagentAnswers);
  if (answers.trim().length > 0) parts.push(answers.trim());
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Render the compact catalog the Planner sees for subagents. */
function renderSubagentCatalog(subagents: SubagentSpec[]): string {
  if (subagents.length === 0) return "";
  const lines = [
    "## Available subagents (delegate via `## Delegate <name>` followed by your prompt)",
  ];
  for (const s of subagents) {
    lines.push(`- \`${s.name}\`: ${s.description || "<no description>"}`);
  }
  return lines.join("\n");
}
