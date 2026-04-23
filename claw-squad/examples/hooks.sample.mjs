/**
 * Example hooks file. Pass with `--hooks ./examples/hooks.sample.mjs`.
 *
 * All hooks are optional. Each one gets a context object + a payload.
 * Throwing HookAbort from preAgent or preCommit cleanly halts the run.
 */

export const hooks = {
  preAgent(ctx, input) {
    console.error(`> [${ctx.role}] prompt ${input.userMessage.length} chars`);
  },

  postAgent(ctx, result) {
    console.error(
      `< [${ctx.role}] ${result.model} ${result.outputTokens}t out, cache_read=${result.cacheReadTokens}`,
    );
  },

  async preCommit(ctx, edits) {
    // Guard: refuse to commit if the Coder touched more than 20 files at
    // once — that's almost always a runaway. Comment this out if you're
    // confident your TODOs really do cross 20 files.
    if (edits.length > 20) {
      const { HookAbort } = await import("claw-squad/dist/hooks.js");
      throw new HookAbort(
        `refusing commit with ${edits.length} files changed (cap=20)`,
      );
    }
  },

  postCommit(ctx, commit) {
    console.error(
      `[commit] ${commit.sha?.slice(0, 7) ?? "?"} on ${ctx.branch}: ${commit.files.length} files`,
    );
  },

  onBudgetExceeded(reason) {
    console.error(`!! budget tripped: ${reason}`);
  },
};

export default hooks;
