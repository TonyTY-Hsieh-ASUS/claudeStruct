package dev.claudestruct.jetbrains.actions

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessAdapter
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.openapi.wm.RegisterToolWindowTask
import dev.claudestruct.jetbrains.CsRunner
import dev.claudestruct.jetbrains.settings.CsSettingsState

/**
 * Base for the four task actions (review/dev/plan/debug). Handles
 * the boring shared bits — collecting the right-clicked paths,
 * resolving the project root, prompting for a description when the
 * task needs one, spawning `cs`, and streaming the output to a
 * dedicated console tab.
 *
 * Subclasses just declare which task they are + whether they need
 * a description prompt; everything else is here.
 */
abstract class CsActionBase(
    private val task: CsRunner.CsTask,
    private val needsDescription: Boolean,
) : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settings = CsSettingsState.get(project)
        val paths = collectPaths(e, project)
        val description = if (needsDescription) promptDescription() ?: return else ""
        val args = CsRunner.buildTaskArgs(task, description, paths, settings)
        runCs(project, settings.cliPath, args)
    }

    private fun collectPaths(e: AnActionEvent, project: Project): List<String> {
        val files: Array<VirtualFile> =
            e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY) ?: emptyArray()
        if (files.isEmpty()) return emptyList()
        val root = project.basePath?.let { java.nio.file.Paths.get(it) }
        return files.map { vf ->
            val abs = vf.path
            if (root == null) abs
            else {
                val rel = root.relativize(java.nio.file.Paths.get(abs))
                // Outside the project? Send the absolute path so the
                // CLI can still find it. Same fallback the VS Code
                // extension uses.
                if (rel.toString().startsWith("..")) abs else rel.toString()
            }
        }
    }

    private fun promptDescription(): String? {
        val text = Messages.showInputDialog(
            "Description for `cs ${task.cli}`:",
            "claudeStruct: ${task.name.lowercase()}",
            null,
        )
        return if (text.isNullOrBlank()) null else text
    }

    /**
     * Spawn the CLI, stream stdout/stderr into a console tab.
     * `cs` prints Rich output by default; the JetBrains console
     * preserves ANSI colours so the panel reads naturally.
     */
    protected fun runCs(project: Project, cliPath: String, args: List<String>) {
        val cmd = GeneralCommandLine(cliPath)
            .withParameters(args)
            .withCharset(Charsets.UTF_8)
            .withWorkDirectory(project.basePath)
        // ANSI colour from `cs` Rich output reads better when the
        // child knows it's talking to a terminal-like sink.
        cmd.environment["FORCE_COLOR"] = "1"

        val handler = try {
            OSProcessHandler(cmd)
        } catch (ex: ExecutionException) {
            Messages.showErrorDialog(
                project,
                "Failed to spawn `${cliPath}`: ${ex.message}\n\n" +
                    "Set the binary path in Settings > Tools > claudeStruct.",
                "claudeStruct",
            )
            return
        }

        val console = ensureConsole(project)
        console.print(
            "$ ${cliPath} ${args.joinToString(" ")}\n",
            ConsoleViewContentType.SYSTEM_OUTPUT,
        )
        handler.addProcessListener(object : ProcessAdapter() {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                val type = if (outputType.toString() == "stderr") {
                    ConsoleViewContentType.ERROR_OUTPUT
                } else {
                    ConsoleViewContentType.NORMAL_OUTPUT
                }
                console.print(event.text, type)
            }

            override fun processTerminated(event: ProcessEvent) {
                val rc = event.exitCode
                val type = if (rc == 0) {
                    ConsoleViewContentType.SYSTEM_OUTPUT
                } else {
                    ConsoleViewContentType.ERROR_OUTPUT
                }
                console.print("\n[exit $rc]\n", type)
            }
        })
        handler.startNotify()
    }

    /**
     * Get-or-create the `claudeStruct` tool-window console. Lazy
     * because most users open the IDE without ever hitting an
     * action; allocating the console up-front would waste memory.
     */
    private fun ensureConsole(project: Project): ConsoleView {
        val existing = ConsoleHolder.get(project)
        if (existing != null) return existing
        val console = TextConsoleBuilderFactory.getInstance()
            .createBuilder(project)
            .console
        ConsoleHolder.put(project, console)
        // Register a tool window if not already present. We use the
        // RIGHT side so it doesn't fight the bottom Run/Debug panes.
        val twm = ToolWindowManager.getInstance(project)
        var tw = twm.getToolWindow(TOOL_WINDOW_ID)
        if (tw == null) {
            tw = twm.registerToolWindow(
                RegisterToolWindowTask(
                    id = TOOL_WINDOW_ID,
                    anchor = com.intellij.openapi.wm.ToolWindowAnchor.BOTTOM,
                    canCloseContent = true,
                ),
            )
        }
        val contentManager = tw.contentManager
        val content = contentManager.factory.createContent(
            console.component,
            "claudeStruct",
            false,
        )
        contentManager.addContent(content)
        tw.activate(null)
        return console
    }

    companion object {
        const val TOOL_WINDOW_ID = "claudeStruct"
    }
}

/**
 * Per-project console cache. Hoisted so it's not regenerated on
 * every action invocation; the IDE reuses the same console tab
 * across runs (with a banner separator the runner appends).
 */
private object ConsoleHolder {
    private val byProject = mutableMapOf<String, ConsoleView>()
    fun get(project: Project): ConsoleView? = byProject[project.locationHash]
    fun put(project: Project, c: ConsoleView) {
        byProject[project.locationHash] = c
    }
}
