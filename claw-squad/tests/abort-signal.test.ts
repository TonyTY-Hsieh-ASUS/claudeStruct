/**
 * Tests for the SIGINT → graceful-quit bridge.
 *
 * We inject a fake signal target + fake force-exit so the test never
 * actually sends a real SIGINT to the test runner.
 */

import { describe, expect, it, vi } from "vitest";
import { installAbortSignal, type SignalTarget } from "../src/abort-signal.js";
import type { UserInterface } from "../src/orchestrator.js";

function makeUi(): UserInterface {
  return {
    askClarifications: async () => [],
    confirm: async () => false,
    log: () => {},
    streamAgent: () => {},
  };
}

function makeSignalTarget(): SignalTarget & { fire: () => void } {
  const listeners: Array<() => void> = [];
  return {
    on(_event, fn) {
      listeners.push(fn);
    },
    off(_event, fn) {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    fire() {
      // Snapshot first — handlers may dispose mid-iteration.
      [...listeners].forEach((fn) => fn());
    },
  };
}

describe("installAbortSignal", () => {
  it("calls the registered quit fn on first SIGINT", () => {
    const ui = makeUi();
    const target = makeSignalTarget();
    const log = vi.fn();
    const forceExit = vi.fn();
    const abort = installAbortSignal({ ui, signalTarget: target, log, forceExit });

    const quitFn = vi.fn();
    abort.ui.onQuit?.(quitFn);

    target.fire();

    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it("force-exits on second SIGINT", () => {
    const ui = makeUi();
    const target = makeSignalTarget();
    const log = vi.fn();
    const forceExit = vi.fn();
    const abort = installAbortSignal({ ui, signalTarget: target, log, forceExit });

    const quitFn = vi.fn();
    abort.ui.onQuit?.(quitFn);

    target.fire();
    target.fire();

    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(130);
  });

  it("force-exits on SIGINT before orchestrator subscribed", () => {
    const ui = makeUi();
    const target = makeSignalTarget();
    const log = vi.fn();
    const forceExit = vi.fn();
    installAbortSignal({ ui, signalTarget: target, log, forceExit });

    target.fire();

    // No quit fn was registered — fall back to immediate exit.
    expect(forceExit).toHaveBeenCalledWith(130);
  });

  it("forwards onQuit to the underlying UI so TUI 'q' keeps working", () => {
    const innerOnQuit = vi.fn();
    const ui: UserInterface = {
      ...makeUi(),
      onQuit: innerOnQuit,
    };
    const target = makeSignalTarget();
    const abort = installAbortSignal({ ui, signalTarget: target, log: () => {}, forceExit: () => {} });

    const quitFn = () => {};
    abort.ui.onQuit?.(quitFn);

    expect(innerOnQuit).toHaveBeenCalledWith(quitFn);
  });

  it("dispose detaches the signal listener", () => {
    const ui = makeUi();
    const target = makeSignalTarget();
    const log = vi.fn();
    const forceExit = vi.fn();
    const abort = installAbortSignal({ ui, signalTarget: target, log, forceExit });

    const quitFn = vi.fn();
    abort.ui.onQuit?.(quitFn);

    abort.dispose();
    target.fire();

    expect(quitFn).not.toHaveBeenCalled();
    expect(forceExit).not.toHaveBeenCalled();
  });
});
