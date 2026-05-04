package dev.claudestruct.jetbrains.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import dev.claudestruct.jetbrains.CsRunner
import dev.claudestruct.jetbrains.settings.CsSettingsState

/**
 * `cs dashboard` — no description, no paths. Reuses the spawn /
 * console plumbing from CsActionBase via composition (we don't
 * inherit because the base assumes a CsTask, and dashboard isn't
 * one).
 */
class DashboardAction : AnAction() {
    private val helper = object : CsActionBase(CsRunner.CsTask.REVIEW, needsDescription = false) {
        // Public adapter so the dashboard action can reuse runCs.
        fun spawn(project: com.intellij.openapi.project.Project, cli: String, args: List<String>) {
            runCs(project, cli, args)
        }
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settings = CsSettingsState.get(project)
        val args = CsRunner.buildDashboardArgs(settings)
        helper.spawn(project, settings.cliPath, args)
    }
}
