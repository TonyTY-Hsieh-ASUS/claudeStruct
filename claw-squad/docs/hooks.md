# Lifecycle hooks

Hooks let you intercept the orchestrator's flow without forking it. Pass a JS/TS module path via `--hooks /path/to/hooks.mjs`. The module exports either `default` or a named `hooks` object implementing the `Hooks` interface (`src/hooks.ts`).

## Hook surface

```ts
interface Hooks {
  preAgent?(role: "planner" | "coder" | "reviewer" | "subagent"): Promise<void> | void;
  postAgent?(role, result): Promise<void> | void;
  preCommit?(args: { taskId, files, message }): Promise<void> | void;
  postCommit?(args: { taskId, sha, files }): Promise<void> | void;
  onBudgetExceeded?(reason: string): Promise<void> | void;
}
```

Each is optional; the orchestrator no-ops on missing hooks.

## Aborting from a hook

Throw `HookAbort` (from `src/hooks.ts`) inside any `pre*` hook to cancel that step:

- `preAgent` throws → that agent call is skipped; orchestrator continues with the next step (usually exits the loop).
- `preCommit` throws → no commit is made; if `rollbackOnHardFail` is true (default), the task's branch is reset to the starting ref.

`post*` hooks throwing `HookAbort` trigger the same aborts but after the side effect already landed — useful for `postCommit` audit failures, less useful for ordinary runtime errors. Prefer signaling via return value when possible.

## Concrete recipes

### Block commits that touch sensitive paths

```js
// .claw-squad/hooks.mjs
import { HookAbort } from "claw-squad/hooks";

export const hooks = {
  preCommit({ files }) {
    const blocked = files.find((f) => f.startsWith("infra/secrets/"));
    if (blocked) throw new HookAbort(`refused to commit ${blocked}`);
  },
};
```

### Stream every commit SHA to your own service

```js
export const hooks = {
  async postCommit({ taskId, sha }) {
    await fetch("https://internal/audit", {
      method: "POST",
      body: JSON.stringify({ taskId, sha, ts: Date.now() }),
    });
  },
};
```

### Notify when budget caps trip

```js
export const hooks = {
  onBudgetExceeded(reason) {
    // Slack / Discord / pagerduty — your choice.
    console.error(`[budget] ${reason}`);
  },
};
```

## Ordering

Hooks fire **before** the corresponding orchestrator action (`pre*`) or **after** it lands (`post*`). They run sequentially with respect to the orchestrator — an `await`ed hook blocks the run. Don't do long-running work inline; queue it to a background process if it might take more than a few seconds.

## Combining with `--log-json`

`--log-json` is the read-only observability path; hooks are the write-side. Use `--log-json` when you want a feed of what happened; use hooks when you want to *change* what happens. Both can be active simultaneously.
