/**
 * Tracing module tests for claw-squad.
 *
 * Mirrors the Python side. The OTel SDK is a soft dep; we don't
 * install it in test deps, so these tests cover:
 *   - Disabled-by-default contract (no env var → no-op spans)
 *   - Idempotent init
 *   - withSpan returns the inner result + ends the span on success
 *     and on thrown errors
 *   - Test injection point so other modules can verify they call into
 *     the tracer correctly
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  initTracing,
  isEnabled,
  withSpan,
  _resetForTests,
  _injectForTests,
  shutdownTracing,
} from "../src/tracing.js";

beforeEach(() => {
  _resetForTests();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe("disabled by default", () => {
  it("initTracing returns false when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
    expect(await initTracing()).toBe(false);
    expect(isEnabled()).toBe(false);
  });

  it("withSpan still runs the function and returns its value", async () => {
    await initTracing();
    const result = await withSpan("noop.test", { foo: "bar" }, async (span) => {
      // No-op span tolerates any method call.
      span.setAttribute("k", "v");
      return 42;
    });
    expect(result).toBe(42);
  });

  it("withSpan rethrows exceptions even with no-op span", async () => {
    await initTracing();
    await expect(
      withSpan("err.test", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("idempotent init", () => {
  it("calling initTracing twice returns the same flag", async () => {
    expect(await initTracing()).toBe(false);
    expect(await initTracing()).toBe(false);
  });
});

describe("with injected tracer", () => {
  it("calls startSpan + setAttribute + end on success", async () => {
    const setAttribute = vi.fn();
    const end = vi.fn();
    const startSpan = vi.fn().mockReturnValue({
      setAttribute,
      end,
      recordException: vi.fn(),
    });
    _injectForTests({ startSpan });

    const result = await withSpan(
      "clawSquad.run",
      {
        "clawSquad.requirement": "build a thing",
        "clawSquad.maxLoops": 5,
        "clawSquad.skipped": undefined,
      },
      async () => "ok",
    );

    expect(result).toBe("ok");
    expect(startSpan).toHaveBeenCalledWith("clawSquad.run");
    // undefined attributes get dropped, not passed through
    expect(setAttribute).toHaveBeenCalledWith("clawSquad.requirement", "build a thing");
    expect(setAttribute).toHaveBeenCalledWith("clawSquad.maxLoops", 5);
    expect(setAttribute).not.toHaveBeenCalledWith("clawSquad.skipped", undefined);
    expect(end).toHaveBeenCalledOnce();
  });

  it("records exception + ends span when fn throws", async () => {
    const recordException = vi.fn();
    const end = vi.fn();
    _injectForTests({
      startSpan: () => ({
        setAttribute: vi.fn(),
        end,
        recordException,
      }),
    });

    await expect(
      withSpan("err.test", {}, async () => {
        throw new Error("downstream broke");
      }),
    ).rejects.toThrow("downstream broke");

    expect(recordException).toHaveBeenCalledTimes(1);
    expect(recordException.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("shutdownTracing", () => {
  it("is safe to call when tracing is disabled", async () => {
    await initTracing();
    // Must not throw.
    await shutdownTracing();
  });
});
