package dev.claudestruct.jetbrains

import dev.claudestruct.jetbrains.settings.CsSettingsState

/**
 * Pure logic for building a `cs` invocation. Hoisted out of the
 * action classes so it can be unit-tested without spinning up the
 * IntelliJ Platform test fixture.
 *
 * Mirrors `vscode-extension/src/runner.ts#buildArgs` so the two
 * extensions produce identical CLI calls — operators get the same
 * behaviour switching between editors.
 */
object CsRunner {
    /** The four task subcommands `cs` accepts. `dashboard` is
     *  separate because it has no description argument. */
    enum class CsTask(val cli: String) {
        REVIEW("review"),
        DEV("dev"),
        PLAN("plan"),
        DEBUG("debug"),
    }

    /**
     * Build the arg vector for a task invocation.
     *
     * @param task           which `cs` subcommand to run.
     * @param description    user-supplied text. May be empty for
     *                       `review` (it uses the branch diff
     *                       implicitly); required for the others.
     * @param paths          relative or absolute paths the user
     *                       right-clicked on. Empty list = let cs
     *                       decide (changed files / branch diff).
     * @param settings       loaded plugin settings (effort, max-bytes,
     *                       extra-args).
     */
    fun buildTaskArgs(
        task: CsTask,
        description: String,
        paths: List<String>,
        settings: CsSettingsState,
    ): List<String> {
        val out = mutableListOf<String>()
        out.add(task.cli)
        // Tasks other than `review` require a description; if empty,
        // let the CLI's own validation fail with a clear message.
        if (description.isNotBlank()) out.add(description)
        out.addAll(paths)
        if (settings.maxBytes > 0) {
            out.add("--max-bytes")
            out.add(settings.maxBytes.toString())
        }
        if (settings.effort.isNotBlank()) {
            out.add("--effort")
            out.add(settings.effort)
        }
        // Extra args forward unmodified — same posture as the VS
        // Code extension. Operator owns validation.
        out.addAll(settings.extraArgs)
        return out
    }

    /**
     * Args for `cs dashboard`. No description / paths; just config
     * passthrough so an operator's `--limit` / `--task` filters can
     * apply via `extraArgs`.
     */
    fun buildDashboardArgs(settings: CsSettingsState): List<String> {
        val out = mutableListOf<String>("dashboard")
        out.addAll(settings.extraArgs)
        return out
    }
}
