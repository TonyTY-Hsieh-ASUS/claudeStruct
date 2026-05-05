/**
 * Redis-backed job queue for the claw-squad worker daemon.
 *
 * Each job is a JSON blob stored in a Redis list. Workers use
 * BRPOPLPUSH to atomically claim a job, process it, then delete it
 * from the processing list on success — or move it to a dead-letter
 * queue on repeated failure.
 *
 * Queue key:    `claw-squad:queue`
 * Processing:   `claw-squad:processing`  (stolen jobs pending completion)
 * Dead-letter:  `claw-squad:dead`        (jobs that failed after MAX_RETRIES)
 *
 * Job shape:
 *   {
 *     "id": "<uuid>",
 *     "requirement": "fix the login bug",
 *     "repoRoot": "/path/to/repo",
 *     "agentConfig": { "planner": {...}, "coder": {...}, "reviewer": {...} },
 *     "options": { "githubEnabled": false, "maxLoops": 10, ... },
 *     "createdAt": "2026-05-05T...",
 *     "retries": 0,
 *   }
 */

import { randomUUID } from "node:crypto";

export const QUEUE_KEY = "claw-squad:queue";
export const PROCESSING_KEY = "claw-squad:processing";
export const DEAD_LETTER_KEY = "claw-squad:dead";
export const WORKER_HEARTBEAT_KEY = "claw-squad:workers";

export const MAX_RETRIES = 3;
export const JOB_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface QueueJob {
  id: string;
  requirement: string;
  repoRoot: string;
  agentConfig: Record<string, unknown>;
  options: Record<string, unknown>;
  createdAt: string;
  retries: number;
  /** Last error message if the job previously failed. */
  lastError?: string;
}

export interface WorkerInfo {
  id: string;
  startedAt: string;
  lastHeartbeat: string;
  currentJobId?: string;
}

/** Result of dequeuing a job. */
export interface DequeuedJob {
  job: QueueJob;
  /** The processing-list key this job was moved to. Used to complete/abandon. */
  processingKey: string;
}

// ---------------------------------------------------------------------
// Redis client factory (lazy so tests can inject a mock).
// ---------------------------------------------------------------------

let _redisFactory: (() => Promise<unknown>) | null = null;

export function setRedisFactory(factory: () => Promise<unknown>): void {
  _redisFactory = factory;
}

export async function getRedis(): Promise<RedisClient> {
  if (!_redisFactory) {
    const { createClient } = await import("redis");
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    _redisFactory = async () => {
      const client = createClient({ url });
      await client.connect();
      return client as unknown as RedisClient;
    };
  }
  return _redisFactory() as Promise<RedisClient>;
}

// ---------------------------------------------------------------------
// Queue operations (all return early on null client for testability).
// ---------------------------------------------------------------------

export async function enqueueJob(
  job: Omit<QueueJob, "id" | "createdAt" | "retries">,
): Promise<QueueJob> {
  const redis = await getRedis();
  const full: QueueJob = {
    ...job,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    retries: 0,
  };
  await redis.lPush(QUEUE_KEY, JSON.stringify(full));
  await redis.expire(QUEUE_KEY, JOB_TTL_SECONDS);
  return full;
}

export async function dequeueJob(timeoutS = 5): Promise<DequeuedJob | null> {
  const redis = await getRedis();

  // For zero timeout (batch/cron mode), use the non-blocking rPopLPush.
  // Otherwise loop with a short blocking rPopLPush so we can wake on stop.
  let raw: string | null = null;

  if (timeoutS === 0) {
    raw = await redis.rPopLPush(QUEUE_KEY, PROCESSING_KEY);
  } else {
    // Poll in small increments so the daemon loop can check _stop between each.
    const pollIntervalMs = 250;
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      raw = await redis.rPopLPush(QUEUE_KEY, PROCESSING_KEY);
      if (raw) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  if (!raw) return null;

  let job: QueueJob;
  try {
    job = JSON.parse(raw) as QueueJob;
  } catch {
    // Malformed JSON — move to dead letter immediately.
    await redis.lPush(DEAD_LETTER_KEY, raw);
    return null;
  }

  return {
    job,
    processingKey: PROCESSING_KEY,
  };
}

export async function completeJob(processingKey: string, jobId: string): Promise<void> {
  const redis = await getRedis();
  // Remove this specific job from the processing list.
  // We stored the raw JSON there, so scan and remove by id.
  const items = await redis.lRange(processingKey, 0, -1);
  for (const item of items) {
    let parsed: QueueJob;
    try {
      parsed = JSON.parse(item) as QueueJob;
    } catch {
      continue;
    }
    if (parsed.id === jobId) {
      await redis.lRem(processingKey, 1, item);
      break;
    }
  }
}

export async function abandonJob(
  processingKey: string,
  job: QueueJob,
  error: string,
): Promise<void> {
  const redis = await getRedis();

  // Remove from processing.
  const items = await redis.lRange(processingKey, 0, -1);
  for (const item of items) {
    try {
      const parsed = JSON.parse(item) as QueueJob;
      if (parsed.id === job.id) {
        await redis.lRem(processingKey, 1, item);
        break;
      }
    } catch {
      continue;
    }
  }

  // Re-queue with incremented retry count, or send to dead letter.
  const updated: QueueJob = {
    ...job,
    retries: job.retries + 1,
    lastError: error,
  };

  if (updated.retries >= MAX_RETRIES) {
    await redis.lPush(DEAD_LETTER_KEY, JSON.stringify(updated));
  } else {
    await redis.lPush(QUEUE_KEY, JSON.stringify(updated));
  }
}

export async function requeueDeadJobs(count = 100): Promise<number> {
  const redis = await getRedis();
  let requeued = 0;
  for (let i = 0; i < count; i++) {
    const raw = await redis.rPopLPush(DEAD_LETTER_KEY, QUEUE_KEY);
    if (!raw) break;
    try {
      const job = JSON.parse(raw) as QueueJob;
      // Reset retries so the job gets a fresh set of attempts.
      job.retries = 0;
      job.lastError = undefined;
      // rPopLPush already moved the item to QUEUE; update it in-place by
      // removing the copy we just moved and pushing the updated version.
      // This is simpler than trying to update the item in the middle of
      // the list — lRem+LPush achieves the same effect cleanly.
      await redis.lRem(QUEUE_KEY, 1, raw);
      await redis.lPush(QUEUE_KEY, JSON.stringify(job));
      requeued++;
    } catch {
      // Malformed entry — discard.
    }
  }
  return requeued;
}

export async function queueDepth(): Promise<{ pending: number; processing: number; dead: number }> {
  const redis = await getRedis();
  const [pending, processing, dead] = await Promise.all([
    redis.lLen(QUEUE_KEY),
    redis.lLen(PROCESSING_KEY),
    redis.lLen(DEAD_LETTER_KEY),
  ]);
  return { pending, processing, dead };
}

// ---------------------------------------------------------------------
// Worker heartbeat — registers this worker so a monitor can see who's alive.
// ---------------------------------------------------------------------

export async function registerWorker(workerId: string): Promise<void> {
  const redis = await getRedis();
  const info: WorkerInfo = {
    id: workerId,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  };
  await redis.hSet(WORKER_HEARTBEAT_KEY, workerId, JSON.stringify(info));
  // Workers expire after 30s of silence — indicates crash.
  await redis.expire(WORKER_HEARTBEAT_KEY, 30);
}

export async function heartbeatWorker(workerId: string, currentJobId?: string): Promise<void> {
  const redis = await getRedis();
  const existing = await redis.hGet(WORKER_HEARTBEAT_KEY, workerId);
  let info: WorkerInfo;
  if (existing) {
    try {
      info = { ...(JSON.parse(existing) as WorkerInfo), lastHeartbeat: new Date().toISOString(), currentJobId };
    } catch {
      info = {
        id: workerId,
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        currentJobId,
      };
    }
  } else {
    info = {
      id: workerId,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      currentJobId,
    };
  }
  await redis.hSet(WORKER_HEARTBEAT_KEY, workerId, JSON.stringify(info));
  await redis.expire(WORKER_HEARTBEAT_KEY, 30);
}

export async function unregisterWorker(workerId: string): Promise<void> {
  const redis = await getRedis();
  await redis.hDel(WORKER_HEARTBEAT_KEY, workerId);
}

export async function listActiveWorkers(): Promise<WorkerInfo[]> {
  const redis = await getRedis();
  const raw = await redis.hGetAll(WORKER_HEARTBEAT_KEY);
  return Object.values(raw)
    .map((v) => {
      try { return JSON.parse(v) as WorkerInfo; } catch { return null; }
    })
    .filter((w): w is WorkerInfo => w !== null);
}

// ---------------------------------------------------------------------
// Mock Redis client type (used by tests without a real Redis).
//
// We use a loose structural契约 so tests can inject a plain-object mock
// without matching the full redis v5 client surface.
// ---------------------------------------------------------------------

export interface RedisClient {
  lPush(key: string, value: string): Promise<number>;
  rPopLPush(source: string, destination: string): Promise<string | null>;
  brPopLPush(source: string, destination: string, timeout: number): Promise<string | null>;
  lMove(source: string, destination: string, direction: "LEFT" | "RIGHT"): Promise<string | null>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lLen(key: string): Promise<number>;
  lRem(key: string, count: number, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  hSet(key: string, field: string, value: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | null>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, ...fields: string[]): Promise<number>;
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
}
