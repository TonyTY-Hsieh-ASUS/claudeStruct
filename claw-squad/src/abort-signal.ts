/**
 * Graceful SIGINT handling for `claw-squad run`.
 *
 * The orchestrator already persists state in its `finally` block and
 * exposes a `ui.onQuit(cb)` hook that the TUI uses to signal a graceful
 * abort. This module hooks the same path to the process's SIGINT signal
 * so Ctrl-C from any UI (plain CLI, TUI, web, slack-launched run)
 * triggers the same exit path.
 *
 * Behavior:
 *   - 1st SIGINT: invoke the registered quit callback. The orchestrator
 *     finishes the in-flight LLM call, runs its `finally` block (which
 *     calls saveSnapshot), then returns; cli.ts prints the summary and
 *     exits 2 (aborted).
 *   - 2nd SIGINT: forced exit (130). The most recent saved snapshot
 *     still allows --resume; we just lose the partial in-flight call.
 *
 * The orchestrator's quit hook only sets a flag — the next checkBudget
 * fires after the current LLM call returns, so worst-case wait is one
 * model latency. Aborting mid-stream would require AbortController
 * plumbing across all 8 providers; deferred to a later wave.
 */

import type { UserInterface } from "./orchestrator.js";

export interface AbortSignalHandle {
  /** UI wrapper to pass to runOrchestrator. */
  ui: UserInterface;
  /** Detach from process.SIGINT — call from a `finally` block. */
  dispose: () => void;
}

export interface InstallAbortSignalOptions {
  /** Underlying UI (plain CLI / TUI / remote). */
  ui: UserInterface;
  /** Where to write user-facing notices. Defaults to console.error. */
  log?: (msg: string) => void;
  /** Inject a custom signal target for tests. Defaults to process. */
  signalTarget?: SignalTarget;
  /** Inject a custom forced-exit callback for tests. Defaults to process.exit. */
  forceExit?: (code: number) => void;
}

export interface SignalTarget {
  on(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
}

/**
 * Wrap a UserInterface so that:
 *   1. The orchestrator's `onQuit` callback is captured locally.
 *   2. SIGINT triggers that callback once, then forces exit if pressed
 *      a second time.
 *
 * The wrapper preserves all other UI methods unchanged.
 */
export function installAbortSignal(
  opts: InstallAbortSignalOptions,
): AbortSignalHandle {
  const target = opts.signalTarget ?? process;
  const log = opts.log ?? ((m: string) => console.error(m));
  const forceExit = opts.forceExit ?? ((code: number) => process.exit(code));

  let registeredQuit: (() => void) | undefined;
  let sigintCount = 0;

  const wrapped: UserInterface = {
    ...opts.ui,
    onQuit(fn: () => void) {
      registeredQuit = fn;
      // Forward to the underlying UI so existing TUI 'q' shortcut keeps working.
      opts.ui.onQuit?.(fn);
    },
  };

  const handler = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      log(
        "\n[orchestrator] SIGINT received — finishing the in-flight step, then aborting. State will be saved for --resume. Press Ctrl-C again to force exit.",
      );
      if (registeredQuit) {
        registeredQuit();
      } else {
        // Orchestrator hasn't subscribed yet (very early in the run);
        // best we can do is exit. State file may not exist yet.
        log(
          "\n[orchestrator] no abort hook registered yet; exiting immediately.",
        );
        forceExit(130);
      }
    } else {
      log("\n[orchestrator] forced exit; state from the previous loop iteration is on disk.");
      forceExit(130);
    }
  };

  target.on("SIGINT", handler);

  return {
    ui: wrapped,
    dispose: () => target.off("SIGINT", handler),
  };
}
