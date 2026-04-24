/**
 * BatchedStreamer — the chunk-coalescer used by remote UIs.
 *
 * These tests use fake timers so flush timing is deterministic and
 * the suite stays fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchedStreamer, type FlushedGroup } from "../src/ui/throttle.js";

describe("BatchedStreamer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces chunks within one window and groups by role", async () => {
    const sinkCalls: FlushedGroup[][] = [];
    const b = new BatchedStreamer(100, (g) => {
      sinkCalls.push(g);
    });
    b.push("planner", "hel");
    b.push("planner", "lo");
    b.push("coder", "x");
    // Still within the window — nothing flushed yet.
    expect(sinkCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sinkCalls).toHaveLength(1);
    const flush = sinkCalls[0]!;
    const byRole = Object.fromEntries(flush.map((g) => [g.role, g.text]));
    expect(byRole.planner).toBe("hello");
    expect(byRole.coder).toBe("x");
  });

  it("starts a new timer on the first chunk after a flush", async () => {
    const calls: FlushedGroup[][] = [];
    const b = new BatchedStreamer(50, (g) => {
      calls.push(g);
    });
    b.push("coder", "a");
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(1);
    b.push("coder", "b");
    // Timer restarted — still within second window.
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]!.text).toBe("b");
  });

  it("shutdown flushes any buffered content immediately", async () => {
    const calls: FlushedGroup[][] = [];
    const b = new BatchedStreamer(10_000, (g) => {
      calls.push(g);
    });
    b.push("planner", "unflushed");
    await b.shutdown();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.text).toBe("unflushed");
  });

  it("swallows sink errors so the orchestrator can keep running", async () => {
    const b = new BatchedStreamer(10, () => {
      throw new Error("transport down");
    });
    b.push("coder", "x");
    // Should NOT throw when the timer fires.
    await expect(vi.advanceTimersByTimeAsync(10)).resolves.not.toThrow();
  });

  it("empty chunks are a no-op", async () => {
    const calls: FlushedGroup[][] = [];
    const b = new BatchedStreamer(10, (g) => {
      calls.push(g);
    });
    b.push("coder", "");
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toEqual([]);
  });

  it("shutdown is idempotent", async () => {
    const calls: FlushedGroup[][] = [];
    const b = new BatchedStreamer(10, (g) => {
      calls.push(g);
    });
    b.push("coder", "hi");
    await b.shutdown();
    await b.shutdown();
    expect(calls).toHaveLength(1);
  });
});
