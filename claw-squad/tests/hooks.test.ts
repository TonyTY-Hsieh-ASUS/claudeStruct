/**
 * Hooks lifecycle tests — we verify:
 *   - wrapWithHooks invokes pre/post around invoke()
 *   - errors in hooks don't leak (get logged, not thrown)
 *   - HookAbort DOES propagate (that's the one explicit escape hatch)
 */

import { describe, expect, it } from "vitest";
import {
  HookAbort,
  NO_HOOKS,
  runHook,
  wrapWithHooks,
  type Hooks,
} from "../src/hooks.js";
import type { InvokeArgs, InvokeResult, Provider } from "../src/providers/types.js";

function fakeResult(text = ""): InvokeResult {
  return {
    text,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    stopReason: "end_turn",
    model: "test",
    provider: "anthropic",
    role: "planner",
  };
}

function fakeProvider(): Provider & { calls: InvokeArgs[] } {
  const calls: InvokeArgs[] = [];
  return {
    name: "anthropic",
    calls,
    async invoke(args: InvokeArgs) {
      calls.push(args);
      return fakeResult(`answer to ${args.userMessage}`);
    },
  };
}

describe("wrapWithHooks", () => {
  it("invokes preAgent before and postAgent after", async () => {
    const events: string[] = [];
    const hooks: Hooks = {
      preAgent: (ctx) => {
        events.push(`pre:${ctx.role}`);
      },
      postAgent: (ctx, r) => {
        events.push(`post:${ctx.role}:${r.model}`);
      },
    };
    const p = fakeProvider();
    const wrapped = wrapWithHooks(p, hooks, () => {});
    await wrapped.invoke({
      role: "planner",
      systemPrompt: "s",
      userMessage: "hi",
    });
    expect(events).toEqual(["pre:planner", "post:planner:test"]);
  });

  it("swallows non-abort hook errors and logs them", async () => {
    const logs: string[] = [];
    const hooks: Hooks = {
      preAgent: () => {
        throw new Error("oops");
      },
    };
    const p = fakeProvider();
    const wrapped = wrapWithHooks(p, hooks, (m) => logs.push(m));
    const r = await wrapped.invoke({
      role: "planner",
      systemPrompt: "s",
      userMessage: "hi",
    });
    expect(r.text).toContain("answer to hi");
    expect(logs[0]).toMatch(/preAgent/);
    expect(logs[0]).toMatch(/oops/);
  });

  it("propagates HookAbort to the caller", async () => {
    const hooks: Hooks = {
      preAgent: () => {
        throw new HookAbort("go away");
      },
    };
    const p = fakeProvider();
    const wrapped = wrapWithHooks(p, hooks, () => {});
    await expect(
      wrapped.invoke({
        role: "planner",
        systemPrompt: "s",
        userMessage: "hi",
      }),
    ).rejects.toBeInstanceOf(HookAbort);
  });

  it("NO_HOOKS is a no-op wrapper", async () => {
    const p = fakeProvider();
    const wrapped = wrapWithHooks(p, NO_HOOKS, () => {});
    const r = await wrapped.invoke({
      role: "coder",
      systemPrompt: "s",
      userMessage: "hi",
    });
    expect(r.text).toContain("answer");
    expect(p.calls).toHaveLength(1);
  });
});

describe("runHook", () => {
  it("returns normally when the closure succeeds", async () => {
    await expect(runHook("preAgent", () => {}, () => "ok")).resolves.toBeUndefined();
  });
  it("logs on closure error and does not throw", async () => {
    const logs: string[] = [];
    await runHook(
      "preAgent",
      (m) => logs.push(m),
      () => {
        throw new Error("boom");
      },
    );
    expect(logs[0]).toMatch(/boom/);
  });
  it("re-throws HookAbort", async () => {
    await expect(
      runHook(
        "preAgent",
        () => {},
        () => {
          throw new HookAbort("nope");
        },
      ),
    ).rejects.toBeInstanceOf(HookAbort);
  });
});
