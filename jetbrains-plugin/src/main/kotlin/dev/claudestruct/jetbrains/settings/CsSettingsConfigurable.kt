package dev.claudestruct.jetbrains.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * The Settings > Tools > claudeStruct panel. Keep the surface
 * minimal — four scalar fields. `extraArgs` is a single-line
 * space-delimited string in the UI; we split on whitespace at save
 * time so an operator who wants `--effort xhigh --redact` doesn't
 * have to deal with a JList editor.
 */
class CsSettingsConfigurable(private val project: Project) : Configurable {
    private val cliPathField = JBTextField()
    private val effortField = JBTextField()
    private val maxBytesField = JBTextField()
    private val extraArgsField = JBTextField()

    private var panel: JPanel? = null

    override fun getDisplayName(): String = "claudeStruct"

    override fun createComponent(): JComponent {
        val p = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("`cs` binary path:"), cliPathField, 1, false)
            .addLabeledComponent(JBLabel("Effort (low/medium/high/xhigh/max):"), effortField, 1, false)
            .addLabeledComponent(JBLabel("Max bytes (0 = task default):"), maxBytesField, 1, false)
            .addLabeledComponent(JBLabel("Extra args (space-delimited):"), extraArgsField, 1, false)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        panel = p
        reset()
        return p
    }

    override fun isModified(): Boolean {
        val s = CsSettingsState.get(project)
        return cliPathField.text != s.cliPath
            || effortField.text != s.effort
            || maxBytesField.text != s.maxBytes.toString()
            || extraArgsField.text != s.extraArgs.joinToString(" ")
    }

    override fun apply() {
        val s = CsSettingsState.get(project)
        s.cliPath = cliPathField.text.ifBlank { "cs" }
        s.effort = effortField.text.trim()
        s.maxBytes = maxBytesField.text.toIntOrNull()?.coerceAtLeast(0) ?: 0
        s.extraArgs = extraArgsField.text
            .split(Regex("\\s+"))
            .filter { it.isNotBlank() }
            .toMutableList()
    }

    override fun reset() {
        val s = CsSettingsState.get(project)
        cliPathField.text = s.cliPath
        effortField.text = s.effort
        maxBytesField.text = s.maxBytes.toString()
        extraArgsField.text = s.extraArgs.joinToString(" ")
    }

    override fun disposeUIResources() {
        panel = null
    }
}
