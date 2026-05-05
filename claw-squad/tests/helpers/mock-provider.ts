/**
 * Mock Provider for orchestrator integration tests.
 *
 * Returns a configurable sequence of canned `InvokeResult`s — one per
 * `invoke()` call. Tests script the agent responses by passing a list
 * of `MockTurn`s; the provider hands them out FIFO and throws if the
 * orchestrator calls more times than the script anticipated.
 *
 * Why a sequence per provider instance, not per role: the orchestrator
 * already routes to per-role providers (`providers.planner`, etc.).
 * One mock per role keeps the per-role scripts independent and easier
 * to read in test cases.
 */

import type {
  InvokeArgs,
  InvokeResult,
  Provider,
  ProviderName,
} from "../../src/providers/types.js";
import type { AgentRole } from "../../src/types.js";

export interface MockTurn {
  /** The text the mocked Claude returns. */
  text: string;
  /** Optional usage. Defaults to small non-zero numbers so totals look plausible. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export class MockProvider implements Provider {
  readonly name: ProviderName = "anthropic";
  /** Calls received so far — useful for assertions in tests. */
  readonly calls: InvokeArgs[] = [];
  private readonly script: MockTurn[];
  private readonly role: AgentRole;
  private cursor = 0;

  constructor(role: AgentRole, script: MockTurn[]) {
    this.role = role;
    this.script = script;
  }

  async invoke(args: InvokeArgs): Promise<InvokeResult> {
    this.calls.push(args);
    if (this.cursor >= this.script.length) {
      throw new Error(
        `MockProvider(${this.role}): script exhausted at call #${this.cursor + 1}; ` +
          `tests should script every expected agent invocation`,
      );
    }
    const turn = this.script[this.cursor]!;
    this.cursor += 1;
    // Forward streamed chunks if the orchestrator passed a callback —
    // matches the real provider's behavior so streamAgent assertions work.
    if (args.onText) args.onText(turn.text);
    return {
      text: turn.text,
      inputTokens: turn.inputTokens ?? 100,
      outputTokens: turn.outputTokens ?? 50,
      cacheReadTokens: turn.cacheReadTokens ?? 0,
      cacheCreationTokens: turn.cacheCreationTokens ?? 0,
      stopReason: "end_turn",
      model: "mock",
      provider: this.name,
      role: args.role,
    };
  }
}
