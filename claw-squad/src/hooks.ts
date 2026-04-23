/**
 * Lifecycle hooks.
 *
 * Inspired by OpenHarness's PreToolUse/PostToolUse — a simple extension
 * point that lets a user plug in logging, redaction, custom guards, or
 * telemetry without touching orchestrator code.
 *
 * Hooks fire at 5 points per task:
 *   preAgent(role, input)     — just before calling a provider
 *   postAgent(role, result)   — right after, with usage + text
 *   preCommit(edits)          — before writing Coder's files to disk
 *   postCommit(diff, sha)     — after the git commit lands locally
 *   onBudgetExceeded(reason)  — when the hard cap trips
 *
 * All hooks are async-friendly; the orchestrator awaits each call.
 * Errors from hooks are caught and logged — a misbehaving hook should
 * not take down a run. Hooks CAN cancel an agent call by throwing a
 * `HookAbort` with a reason; the orchestrator treats this as a soft
 * abort and surfaces the reason.
 */

import type { CoderFileEdit } from "./agents/coder.js";
import type {
  InvokeArgs,
  InvokeResult,
  Provider,
} from "./providers/types.js";
import type { AgentRole } from "./types.js";

export class HookAbort extends Error {
  constructor(public readonly reason: string) {
    super(`hook abort: ${reason}`);
    this.name = "HookAbort";
  }
}

export interface HookContext {
  role: AgentRole;
  taskId?: string;
}

export interface Hooks {
  preAgent?: (ctx: HookContext, input: InvokeArgs) => void | Promise<void>;
  postAgent?: (ctx: HookContext, result: InvokeResult) => void | Promise<void>;
  preCommit?: (
    ctx: { taskId: string; branch: string },
    edits: CoderFileEdit[],
  ) => void | Promise<void>;
  postCommit?: (
    ctx: { taskId: string; branch: string },
    commit: { diff: string; sha?: string; files: string[] },
  ) => void | Promise<void>;
  onBudgetExceeded?: (reason: string) => void | Promise<void>;
}

export const NO_HOOKS: Hooks = {};

/**
 * Safely run a hook invocation. The caller passes a closure that
 * actually calls the hook; this helper catches errors consistently
 * and re-throws HookAbort. Using a closure instead of trying to infer
 * variadic args over a union sidesteps a TS generic-inference pothole.
 *
 * Usage:
 *   await runHook("preAgent", ui.log, () => hooks.preAgent?.(ctx, input));
 */
export async function runHook(
  name: keyof Hooks,
  log: (msg: string) => void,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HookAbort) throw err;
    log(
      `[hooks] ${String(name)} threw: ${
        err instanceof Error ? err.message : String(err)
      } — continuing`,
    );
  }
}

/**
 * Wrap a Provider so preAgent/postAgent hooks fire automatically around
 * each invoke. Returns a new Provider with the same surface. Agents
 * don't need to know hooks exist.
 */
export function wrapWithHooks(
  provider: Provider,
  hooks: Hooks,
  log: (msg: string) => void,
): Provider {
  return {
    name: provider.name,
    async invoke(args: InvokeArgs): Promise<InvokeResult> {
      const ctx: HookContext = { role: args.role };
      await runHook("preAgent", log, () => hooks.preAgent?.(ctx, args));
      const result = await provider.invoke(args);
      await runHook("postAgent", log, () => hooks.postAgent?.(ctx, result));
      return result;
    },
  };
}

/**
 * Load hooks from a Node module specified by path. The module must
 * default-export a Hooks object, or export named `hooks` of that shape.
 * Returns NO_HOOKS (with a warning via `log`) if the module can't be
 * loaded — again, a missing/broken hooks file should not kill the run.
 */
export async function loadHooksFromFile(
  path: string,
  log: (msg: string) => void,
): Promise<Hooks> {
  try {
    const mod = (await import(path)) as {
      default?: Hooks;
      hooks?: Hooks;
    };
    const hooks = mod.hooks ?? mod.default;
    if (hooks && typeof hooks === "object") return hooks;
    log(`[hooks] ${path}: no 'hooks' named export or default; ignoring`);
    return NO_HOOKS;
  } catch (err) {
    log(`[hooks] failed to load ${path}: ${(err as Error).message}; ignoring`);
    return NO_HOOKS;
  }
}
