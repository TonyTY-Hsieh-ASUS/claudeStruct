package dev.claudestruct.jetbrains.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.project.Project
import com.intellij.util.xmlb.XmlSerializerUtil

/**
 * Project-scoped settings — `cliPath`, `effort`, `maxBytes`,
 * `extraArgs`. Same shape as the VS Code extension's
 * `claudestruct.*` config keys so an operator switching editors can
 * reuse the same mental model.
 *
 * Project-scoped (not application-scoped) so a polyglot dev with
 * three IDE windows open against three different repos can run
 * each against a different `cs` extra (`[server]` for the daemon
 * repo, `[smart-context]` for the local-LLM repo, etc.).
 */
@Service(Service.Level.PROJECT)
@State(name = "ClaudeStructSettings", storages = [Storage("claudestruct.xml")])
class CsSettingsState : PersistentStateComponent<CsSettingsState> {
    /** `cs` binary on PATH or absolute path. Default reads PATH. */
    var cliPath: String = "cs"

    /** `--effort low|medium|high|xhigh|max`. Empty = task default. */
    var effort: String = ""

    /** `--max-bytes`. 0 = task default. */
    var maxBytes: Int = 0

    /** Forwarded verbatim after every command. e.g.
     *  `--log-json /tmp/run.jsonl --redact` */
    var extraArgs: MutableList<String> = mutableListOf()

    override fun getState(): CsSettingsState = this

    override fun loadState(state: CsSettingsState) {
        XmlSerializerUtil.copyBean(state, this)
    }

    companion object {
        fun get(project: Project): CsSettingsState =
            project.getService(CsSettingsState::class.java)
    }
}
