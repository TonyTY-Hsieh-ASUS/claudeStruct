/**
 * Long-running worker daemon for claw-squad.
 *
 * Run as:  claw-squad worker [--poll-interval <seconds>] [--worker-id <id>]
 *
 * Each running instance is a "worker" that:
 *   1. Polls Redis for the next job (BRPOPLPUSH — atomic steal).
 *   2. Runs `runOrchestrator` with the job's config.
 *   3. On success: removes the job from the processing list (LMOVE back,
 *      then DELETE — or just LREM since we control the value).
 *   4. On ClaudestructError / non-2 exit: re-queues with incremented retry
 *      count (or dead-letter after MAX_RETRIES).
 *   5. Heartbeats its identity every 15s so a monitor can see who's alive.
 *
 * Multiple workers can run simultaneously — BRPOPLPUSH is atomic so no
 * two workers will claim the same job.
 *
 * Graceful shutdown: SIGTERM/SIGINT sets `_stop = true`. The worker
 * finishes any in-flight orchestrator call, then exits. In-flight
 * jobs are left in the processing list; another worker or cron job
 * must reap them (tracked via `_orphaned_jobs` at shutdown).
 */

import pc from "picocolors";
import { randomUUID } from "node:crypto";
import { setRedisFactory, type DequeuedJob } from "./queue.js";
import {
  completeJob,
  abandonJob,
  dequeueJob,
  enqueueJob,
  heartbeatWorker,
  registerWorker,
  unregisterWorker,
  MAX_RETRIES,
  type QueueJob,
} from "./queue.js";
import { loadAgentConfig, loadReposFromFile } from "./config.js";
import { loadSnapshot } from "./snapshot.js";
import {
  runOrchestrator,
  type OrchestratorResult,
  type UserInterface,
} from "./orchestrator.js";
import { loadHooksFromFile, NO_HOOKS, type Hooks } from "./hooks.js";
import { installAbortSignal } from "./abort-signal.js";
import type { AgentConfig } from "./config.js";
import type { RunConfig } from "./types.js";

// ---------------------------------------------------------------------
// Minimal TUI-less UserInterface for worker mode
// ---------------------------------------------------------------------

const NOP_UI = {
  askClarifications: async () => [],
  confirm: async () => false,
  log: (msg: string) => console.log(pc.dim(`[worker] ${msg}`)),
  streamAgent: () => {},
  setInflightSubagent: () => {},
  setActiveSkills: () => {},
  updateState: () => {},
} satisfies UserInterface;

// ---------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------

export interface DaemonOptions {
  /** Unique id for this worker instance. Auto-generated if absent. */
  workerId?: string;
  /** Redis URL. Default: REDIS_URL env or redis://localhost:6379. */
  redisUrl?: string;
  /** How long to sleep between dequeue attempts when the queue is empty. */
  pollIntervalS?: number;
  /** Called with the job's QueueJob before running. */
  onJobStart?: (job: QueueJob) => void;
  /** Called after runOrchestrator resolves. */
  onJobComplete?: (job: QueueJob, result: OrchestratorResult) => void;
  /** Called when a job fails and is re-queued or dead-lettered. */
  onJobFailed?: (job: QueueJob, error: string) => void;
}

interface DaemonState {
  stop: boolean;
  orphanedJobs: DequeuedJob[];
}

// ---------------------------------------------------------------------
// Run one job's orchestrator
// ---------------------------------------------------------------------

async function runJob(
  job: QueueJob,
  opts: DaemonOptions,
): Promise<OrchestratorResult> {
  // Validate required fields.
  if (!job.requirement || !job.repoRoot) {
    throw new Error(`job missing required field: requirement=${!!job.requirement} repoRoot=${!!job.repoRoot}`);
  }

  // Rebuild config from job fields (all the same shapes as CLI).
  const repos = job.options?.repos as RunConfig["repos"] | undefined;
  const runConfig: RunConfig = {
    repoRoot: job.repoRoot as string,
    maxClarifications: (job.options?.maxClarifications as number) ?? 3,
    maxReviewRounds: (job.options?.maxReviewRounds as number) ?? 3,
    maxLoops: (job.options?.maxLoops as number) ?? 10,
    requireHumanApproval: (job.options?.requireHumanApproval as boolean) ?? false,
    sandboxEnabled: (job.options?.sandboxEnabled as boolean) ?? false,
    selfLearning: (job.options?.selfLearning as boolean) ?? true,
    githubEnabled: (job.options?.githubEnabled as boolean) ?? false,
    githubRepo: job.options?.githubRepo as string | undefined,
    repos,
    rollbackOnMaxRounds: job.options?.rollbackOnMaxRounds as boolean ?? true,
    rollbackOnHardFail: job.options?.rollbackOnHardFail as boolean ?? true,
    maxCostUsd: job.options?.maxCostUsd as number | undefined,
    maxTokens: job.options?.maxTokens as number | undefined,
    testCommand: job.options?.testCommand as string | undefined,
    testTimeoutMs: job.options?.testTimeoutMs as number | undefined,
    waitForCi: job.options?.waitForCi as boolean ?? false,
    ciTimeoutMs: job.options?.ciTimeoutMs as number | undefined,
    dryRun: job.options?.dryRun as boolean | undefined,
    logJsonPath: job.options?.logJsonPath as string | undefined,
    smartContext: job.options?.smartContext as boolean ?? false,
  };

  // Agent config.
  const agentConfig = (job.agentConfig ?? {}) as AgentConfig;
  const mergedAgentConfig = Object.keys(agentConfig).length > 0
    ? agentConfig
    : loadAgentConfig({ repoRoot: runConfig.repoRoot });

  // Hooks (if a hooks path was stored in the job).
  let hooks: Hooks = NO_HOOKS;
  if (job.options?.hooksPath && typeof job.options.hooksPath === "string") {
    hooks = await loadHooksFromFile(job.options.hooksPath, (m) =>
      console.error(pc.red(`[worker hooks] ${m}`)),
    );
  }

  // Resume from snapshot if the job's repo has one.
  const snap = loadSnapshot(runConfig.repoRoot);
  const resumeFrom = snap?.state;
  const resumeTotals = snap?.totals;

  const abort = installAbortSignal({ ui: NOP_UI });
  try {
    return await runOrchestrator({
      config: runConfig,
      agentConfig: mergedAgentConfig,
      requirement: job.requirement,
      ui: NOP_UI,
      hooks,
      resumeFrom,
      resumeTotals,
    });
  } finally {
    abort.dispose();
  }
}

// ---------------------------------------------------------------------
// Main daemon loop
// ---------------------------------------------------------------------

export async function runWorkerDaemon(opts: DaemonOptions = {}): Promise<void> {
  const workerId = opts.workerId ?? randomUUID().slice(0, 8);
  const pollIntervalMs = (opts.pollIntervalS ?? 1) * 1000;

  // Set up Redis factory using the provided URL.
  if (opts.redisUrl) {
    setRedisFactory(async () => {
      const { createClient } = await import("redis");
      const { default: Redis } = await import("redis");
      const client = createClient({ url: opts.redisUrl });
      await client.connect();
      return client as unknown as import("./queue.js").RedisClient;
    });
  }

  const state: DaemonState = { stop: false, orphanedJobs: [] };

  // Signal handlers for graceful shutdown.
  const stop = () => {
    state.stop = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  console.log(pc.cyan(`[worker:${workerId}] starting — pid=${process.pid}`));
  console.log(pc.dim(`  poll interval: ${pollIntervalMs}ms`));

  await registerWorker(workerId);
  console.log(pc.dim(`  registered worker heartbeat`));

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let currentJobId: string | undefined;

  // Heartbeat every 15s.
  heartbeatTimer = setInterval(async () => {
    try {
      await heartbeatWorker(workerId, currentJobId);
    } catch (err) {
      console.error(pc.yellow(`[worker:${workerId}] heartbeat failed: ${(err as Error).message}`));
    }
  }, 15_000);

  try {
    main: while (!state.stop) {
      // Dequeue with a timeout shorter than the poll interval so we can
      // check the stop flag promptly.
      let dequeued: DequeuedJob | null = null;
      try {
        dequeued = await dequeueJob(Math.ceil(pollIntervalMs / 1000));
      } catch (err) {
        console.error(pc.red(`[worker:${workerId}] dequeue error: ${(err as Error).message}`));
        await sleep(pollIntervalMs);
        continue;
      }

      if (!dequeued) {
        // Queue empty — sleep then re-check.
        await sleep(pollIntervalMs);
        continue;
      }

      const { job, processingKey } = dequeued;
      currentJobId = job.id;
      opts.onJobStart?.(job);

      console.log(
        pc.green(`[worker:${workerId}] got job ${job.id} — "${job.requirement.slice(0, 60)}"`),
      );
      console.log(pc.dim(`  repoRoot: ${job.repoRoot}  retries: ${job.retries}/${MAX_RETRIES}`));

      let result: OrchestratorResult;
      try {
        result = await runJob(job, opts);
      } catch (err) {
        const message = (err as Error).message ?? "unknown error";
        console.error(pc.red(`[worker:${workerId}] job ${job.id} threw: ${message}`));
        opts.onJobFailed?.(job, message);
        try {
          await abandonJob(processingKey, job, message);
        } catch (e2) {
          console.error(pc.red(`[worker:${workerId}] abandonJob failed: ${(e2 as Error).message}`));
        }
        currentJobId = undefined;
        await heartbeatWorker(workerId, undefined);
        if (state.stop) break;
        await sleep(pollIntervalMs);
        continue;
      }

      // Determine outcome.
      const ok =
        result.reason === "complete" ||
        result.reason === "dry_run";

      if (ok) {
        console.log(
          pc.green(`[worker:${workerId}] job ${job.id} done (${result.reason}) — cost $${result.totals.overall.costUsd.toFixed(4)}`),
        );
        try {
          await completeJob(processingKey, job.id);
        } catch (e) {
          console.error(pc.red(`[worker:${workerId}] completeJob failed: ${(e as Error).message}`));
        }
        opts.onJobComplete?.(job, result);
      } else {
        const reason = `orchestrator returned ${result.reason}`;
        console.error(pc.red(`[worker:${workerId}] job ${job.id} failed: ${reason}`));
        opts.onJobFailed?.(job, reason);
        try {
          await abandonJob(processingKey, job, reason);
        } catch (e2) {
          console.error(pc.red(`[worker:${workerId}] abandonJob failed: ${(e2 as Error).message}`));
        }
      }

      currentJobId = undefined;
      await heartbeatWorker(workerId, undefined);

      if (state.stop) break;
    } // end main loop

    console.log(pc.cyan(`[worker:${workerId}] shutting down…`));

    // -----------------------------------------------------------------
    // Graceful drain: if we have an in-flight job, it will complete and
    // completeJob will be called. No special handling needed because the
    // orchestrator call is already running to completion.
    // -----------------------------------------------------------------

  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      await unregisterWorker(workerId);
    } catch {
      /* ignore — we're shutting down */
    }
    console.log(pc.cyan(`[worker:${workerId}] stopped`));
  }
}

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------
// Cron / once mode: drain all currently queued jobs and exit.
// ---------------------------------------------------------------------

export interface OnceOptions {
  /** Redis URL. Default: REDIS_URL env or redis://localhost:6379. */
  redisUrl?: string;
  /** Max number of jobs to drain. Default 1000. */
  maxJobs?: number;
  /** Called per processed job. */
  onJobStart?: (job: QueueJob) => void;
  /** Called after runOrchestrator resolves. */
  onJobComplete?: (job: QueueJob, result: OrchestratorResult) => void;
  /** Called when a job fails and is re-queued or dead-lettered. */
  onJobFailed?: (job: QueueJob, error: string) => void;
}

export async function drainQueueOnce(opts: OnceOptions = {}): Promise<number> {
  if (opts.redisUrl) {
    setRedisFactory(async () => {
      const { createClient } = await import("redis");
      const client = createClient({ url: opts.redisUrl });
      await client.connect();
      return client as unknown as import("./queue.js").RedisClient;
    });
  }

  const maxJobs = opts.maxJobs ?? 1000;
  let processed = 0;

  for (let i = 0; i < maxJobs; i++) {
    const dequeued = await dequeueJob(0); // non-blocking
    if (!dequeued) break;

    const { job, processingKey } = dequeued;
    opts.onJobStart?.(job);

    console.log(pc.cyan(`[drain] job ${job.id} — "${job.requirement.slice(0, 60)}"`));

    let result: OrchestratorResult;
    try {
      result = await runJob(job, opts);
    } catch (err) {
      const message = (err as Error).message ?? "unknown error";
      console.error(pc.red(`[drain] job ${job.id} threw: ${message}`));
      opts.onJobFailed?.(job, message);
      try {
        await abandonJob(processingKey, job, message);
      } catch {
        /* ignore */
      }
      continue;
    }

    const ok = result.reason === "complete" || result.reason === "dry_run";
    if (ok) {
      try {
        await completeJob(processingKey, job.id);
      } catch {
        /* ignore */
      }
      opts.onJobComplete?.(job, result);
    } else {
      const reason = `orchestrator returned ${result.reason}`;
      opts.onJobFailed?.(job, reason);
      try {
        await abandonJob(processingKey, job, reason);
      } catch {
        /* ignore */
      }
    }
    processed++;
  }

  return processed;
}

// ---------------------------------------------------------------------
// Enqueue helper — used by external callers to submit work via CLI/REST.
// ---------------------------------------------------------------------

export async function submitJob(input: {
  requirement: string;
  repoRoot: string;
  agentConfig?: AgentConfig;
  options?: Partial<RunConfig>;
  hooksPath?: string;
}): Promise<QueueJob> {
  return enqueueJob({
    requirement: input.requirement,
    repoRoot: input.repoRoot,
    agentConfig: (input.agentConfig ?? {}) as Record<string, unknown>,
    options: {
      ...(input.options ?? {}),
      ...(input.hooksPath ? { hooksPath: input.hooksPath } : {}),
    },
  });
}
