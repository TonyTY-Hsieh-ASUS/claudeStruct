/**
 * Capture-everything UserInterface for orchestrator integration tests.
 *
 * Records every `log`, `streamAgent`, `confirm`, `askClarifications`,
 * `trackUsage`, and `updateState` call in arrays so tests can assert
 * on the ordering and content. Pre-canned answers for `confirm` and
 * `askClarifications` are passed in so the orchestrator never blocks
 * on real I/O.
 */

import type { UserInterface } from "../../src/orchestrator.js";
import type { RoleBucket, SquadState } from "../../src/types.js";

export interface MockUiInputs {
  /** Pre-canned answers for confirm() — true/false in order. Defaults to all true. */
  confirmAnswers?: boolean[];
  /** Pre-canned arrays for askClarifications() — one array per question batch. Defaults to []. */
  clarificationAnswers?: string[][];
}

export interface CapturedLog {
  log: string[];
  stream: Array<{ role: string; chunk: string }>;
  confirms: string[];
  clarifications: string[][];
  trackedUsage: Array<{
    role: RoleBucket;
    delta: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
    subagentName?: string;
  }>;
  states: SquadState[];
}

export function makeMockUi(inputs: MockUiInputs = {}): UserInterface & {
  captured: CapturedLog;
  fireQuit: () => void;
} {
  const captured: CapturedLog = {
    log: [],
    stream: [],
    confirms: [],
    clarifications: [],
    trackedUsage: [],
    states: [],
  };
  const confirmQueue = [...(inputs.confirmAnswers ?? [])];
  const clarificationQueue = [...(inputs.clarificationAnswers ?? [])];
  let registeredQuit: (() => void) | undefined;

  return {
    captured,
    fireQuit: () => registeredQuit?.(),

    askClarifications: async (questions: string[]) => {
      captured.clarifications.push(questions);
      const ans = clarificationQueue.shift();
      // Default: empty answers so the orchestrator counts a clarification
      // round and exits the loop on maxClarifications. Tests that need
      // real answers preload `clarificationAnswers`.
      return ans ?? questions.map(() => "");
    },
    confirm: async (prompt: string) => {
      captured.confirms.push(prompt);
      const ans = confirmQueue.shift();
      // Default to true so destructive-confirm prompts don't block runs
      // that don't care about confirmation behavior.
      return ans ?? true;
    },
    log: (msg: string) => {
      captured.log.push(msg);
    },
    streamAgent: (role: string, chunk: string) => {
      captured.stream.push({ role, chunk });
    },
    trackUsage: (role, delta, subagentName) => {
      captured.trackedUsage.push({ role, delta, subagentName });
    },
    onQuit: (fn) => {
      registeredQuit = fn;
    },
    updateState: (state) => {
      // Snapshot the state at each push so tests can assert on transitions.
      captured.states.push(JSON.parse(JSON.stringify(state)) as SquadState);
    },
  };
}
