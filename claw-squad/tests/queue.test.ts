/**
 * Tests for the Redis-backed job queue.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  type DequeuedJob,
  type QueueJob,
  type RedisClient,
  completeJob,
  dequeueJob,
  abandonJob,
  enqueueJob,
  heartbeatWorker,
  listActiveWorkers,
  queueDepth,
  requeueDeadJobs,
  registerWorker,
  setRedisFactory,
  unregisterWorker,
  DEAD_LETTER_KEY,
  MAX_RETRIES,
  PROCESSING_KEY,
  QUEUE_KEY,
  WORKER_HEARTBEAT_KEY,
} from "../src/queue.js";

const FIXTURE_JOB: Omit<QueueJob, "id" | "createdAt" | "retries"> = {
  requirement: "fix the login bug",
  repoRoot: "/tmp/test-repo",
  agentConfig: { planner: { name: "anthropic" } },
  options: { maxLoops: 10 },
};

// ---------------------------------------------------------------------
// In-memory mock that satisfies the RedisClient interface.
// ---------------------------------------------------------------------

function makeMock(): RedisClient {
  const store: Record<string, string[]> = {
    [QUEUE_KEY]: [],
    [PROCESSING_KEY]: [],
    [DEAD_LETTER_KEY]: [],
  };
  const hashStore: Record<string, Record<string, string>> = {};

  return {
    lPush: async (key, value) => {
      store[key] ??= [];
      store[key].unshift(value);
      return store[key].length;
    },
    rPopLPush: async (src, dst) => {
      const val = store[src]?.pop() ?? null;
      if (val) {
        store[dst] ??= [];
        store[dst].push(val);
      }
      return val;
    },
    brPopLPush: async (src, _dst, _timeout) => store[src]?.pop() ?? null,
    lMove: async (src, dst, direction) => {
      if (direction === "LEFT") {
        const val = store[src]?.pop() ?? null;
        if (val) { store[dst] ??= []; store[dst].push(val); }
        return val;
      }
      const val = store[src]?.shift() ?? null;
      if (val) { store[dst] ??= []; store[dst].unshift(val); }
      return val;
    },
    lRange: async (key, start, stop) =>
      store[key]?.slice(start, stop === -1 ? undefined : stop + 1) ?? [],
    lLen: async (key) => store[key]?.length ?? 0,
    lRem: async (key, _count, value) => {
      const arr = store[key];
      if (!arr) return 0;
      const idx = arr.indexOf(value);
      if (idx === -1) return 0;
      arr.splice(idx, 1); // splice modifies the actual store array
      return 1;
    },
    expire: async () => 1,
    hSet: async (key, field, value) => {
      hashStore[key] ??= {};
      hashStore[key][field] = value;
      return 1;
    },
    hGet: async (key, field) => hashStore[key]?.[field] ?? null,
    hGetAll: async (key) => hashStore[key] ?? {},
    hDel: async (key, ...fields) => {
      let deleted = 0;
      for (const f of fields) {
        if (delete (hashStore[key] ?? {})[f]) deleted++;
      }
      return deleted;
    },
    connect: async () => {},
    disconnect: async () => {},
  };
}

describe("queue", () => {
  let mock: RedisClient;

  beforeEach(() => {
    mock = makeMock();
    // Replace the global factory each time so getRedis() picks it up fresh.
    setRedisFactory(() => Promise.resolve(mock));
  });

  // -------------------------------------------------------------------
  // enqueueJob
  // -------------------------------------------------------------------

  describe("enqueueJob", () => {
    it("creates a job with id, createdAt, retries=0", async () => {
      const job = await enqueueJob(FIXTURE_JOB);
      expect(job.id).toBeTruthy();
      expect(job.createdAt).toBeTruthy();
      expect(job.retries).toBe(0);
      expect(job.requirement).toBe(FIXTURE_JOB.requirement);
      expect(job.repoRoot).toBe(FIXTURE_JOB.repoRoot);
    });

    it("returns a unique id each call", async () => {
      const a = await enqueueJob(FIXTURE_JOB);
      const b = await enqueueJob(FIXTURE_JOB);
      expect(a.id).not.toBe(b.id);
    });
  });

  // -------------------------------------------------------------------
  // dequeueJob
  // -------------------------------------------------------------------

  describe("dequeueJob", () => {
    it("returns null when queue is empty (timeout=0)", async () => {
      const result = await dequeueJob(0);
      expect(result).toBeNull();
    });

    it("returns the job and moves it to processing (timeout=0)", async () => {
      await enqueueJob(FIXTURE_JOB);
      const result = await dequeueJob(0);
      expect(result).not.toBeNull();
      expect(result!.job.requirement).toBe(FIXTURE_JOB.requirement);
      expect(result!.processingKey).toBe(PROCESSING_KEY);
    });

    it("does not return the same job twice", async () => {
      await enqueueJob(FIXTURE_JOB);
      const first = await dequeueJob(0);
      const second = await dequeueJob(0);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // completeJob
  // -------------------------------------------------------------------

  describe("completeJob", () => {
    it("removes the job from processing", async () => {
      await enqueueJob(FIXTURE_JOB);
      const { job } = (await dequeueJob(0))!;
      await completeJob(PROCESSING_KEY, job.id);
      const depth = await queueDepth();
      expect(depth.processing).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // abandonJob
  // -------------------------------------------------------------------

  describe("abandonJob", () => {
    it("re-queues with incremented retry count", async () => {
      await enqueueJob(FIXTURE_JOB);
      const { job, processingKey } = (await dequeueJob(0))!;
      await abandonJob(processingKey, job, "test error");
      const depth = await queueDepth();
      expect(depth.pending).toBe(1);
      expect(depth.processing).toBe(0);
      // Re-dequeue and check the retry count.
      const requeued = (await dequeueJob(0))!;
      expect(requeued.job.retries).toBe(1);
      expect(requeued.job.lastError).toBe("test error");
    });

    it("dead-letters after MAX_RETRIES", async () => {
      await enqueueJob(FIXTURE_JOB);
      const { job, processingKey } = (await dequeueJob(0))!;
      job.retries = MAX_RETRIES - 1;
      await abandonJob(processingKey, job, "fatal error");
      const depth = await queueDepth();
      expect(depth.dead).toBe(1);
      expect(depth.pending).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // requeueDeadJobs
  // -------------------------------------------------------------------

  describe("requeueDeadJobs", () => {
    it("moves dead-letter jobs back to pending and resets retries", async () => {
      const freshMock = makeMock();
      setRedisFactory(() => Promise.resolve(freshMock));

      const deadJob: QueueJob = {
        id: "dead-1",
        requirement: "old requirement",
        repoRoot: "/tmp/repo",
        agentConfig: {},
        options: {},
        createdAt: new Date().toISOString(),
        retries: MAX_RETRIES,
        lastError: "max retries reached",
      };
      await freshMock.lPush(DEAD_LETTER_KEY, JSON.stringify(deadJob));

      // Track how many times lPush is called on QUEUE.
      let queuePushCount = 0;
      const origLpush = freshMock.lPush;
      freshMock.lPush = async (key, value) => {
        if (key === QUEUE_KEY) queuePushCount++;
        return origLpush.call(freshMock, key, value);
      };

      const n = await requeueDeadJobs(10);

      expect(n).toBe(1);
      expect(queuePushCount).toBe(1);
      expect(await freshMock.lLen(QUEUE_KEY)).toBe(1);
      expect(await freshMock.lLen(DEAD_LETTER_KEY)).toBe(0);
    });

    it("returns 0 when dead-letter is empty", async () => {
      const n = await requeueDeadJobs(10);
      expect(n).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // queueDepth
  // -------------------------------------------------------------------

  describe("queueDepth", () => {
    it("returns 0 for empty queues", async () => {
      const depth = await queueDepth();
      expect(depth.pending).toBe(0);
      expect(depth.processing).toBe(0);
      expect(depth.dead).toBe(0);
    });

    it("counts items in each queue", async () => {
      await enqueueJob(FIXTURE_JOB);
      await enqueueJob(FIXTURE_JOB);
      const { job } = (await dequeueJob(0))!;
      await completeJob(PROCESSING_KEY, job.id);
      const depth = await queueDepth();
      expect(depth.pending).toBe(1); // one left after first dequeue
      expect(depth.processing).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Worker heartbeat
  // -------------------------------------------------------------------

  describe("registerWorker / heartbeatWorker / unregisterWorker", () => {
    it("registers and unregisters a worker", async () => {
      const workerId = "test-worker-1";
      await registerWorker(workerId);
      const workers = await listActiveWorkers();
      expect(workers.some((w) => w.id === workerId)).toBe(true);

      await unregisterWorker(workerId);
      const after = await listActiveWorkers();
      expect(after.some((w) => w.id === workerId)).toBe(false);
    });

    it("heartbeatWorker updates lastHeartbeat and currentJobId", async () => {
      const workerId = "test-worker-2";
      await registerWorker(workerId);
      await heartbeatWorker(workerId, "job-123");
      const workers = await listActiveWorkers();
      const w = workers.find((x) => x.id === workerId);
      expect(w?.currentJobId).toBe("job-123");

      await heartbeatWorker(workerId, undefined);
      const workers2 = await listActiveWorkers();
      const w2 = workers2.find((x) => x.id === workerId);
      expect(w2?.currentJobId).toBeUndefined();
    });
  });
});
