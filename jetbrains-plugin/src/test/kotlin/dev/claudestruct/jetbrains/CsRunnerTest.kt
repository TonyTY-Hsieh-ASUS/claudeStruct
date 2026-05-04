package dev.claudestruct.jetbrains

import dev.claudestruct.jetbrains.settings.CsSettingsState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Pure unit tests for the arg-vector builder. No IntelliJ Platform
 * fixture needed — these run via the standard JUnit Platform under
 * `./gradlew test`. The action classes themselves require the
 * Platform's TestFramework which is heavier; that lands when
 * marketplace publish becomes the next priority.
 */
class CsRunnerTest {
    private fun emptySettings(): CsSettingsState = CsSettingsState()

    @Test
    fun `review with no description omits the description arg`() {
        // The CLI accepts `cs review` with no description (it uses
        // the branch diff). Locking that we don't inject an empty
        // string that would be parsed as a description.
        val args = CsRunner.buildTaskArgs(
            CsRunner.CsTask.REVIEW,
            description = "",
            paths = emptyList(),
            settings = emptySettings(),
        )
        assertEquals(listOf("review"), args)
    }

    @Test
    fun `dev with description and paths produces the expected vector`() {
        val args = CsRunner.buildTaskArgs(
            CsRunner.CsTask.DEV,
            description = "add retry",
            paths = listOf("src/foo.py", "src/bar.py"),
            settings = emptySettings(),
        )
        assertEquals(listOf("dev", "add retry", "src/foo.py", "src/bar.py"), args)
    }

    @Test
    fun `effort and maxBytes appear when set`() {
        val s = CsSettingsState().apply {
            effort = "high"
            maxBytes = 200_000
        }
        val args = CsRunner.buildTaskArgs(
            CsRunner.CsTask.PLAN,
            description = "design",
            paths = emptyList(),
            settings = s,
        )
        assertEquals(
            listOf("plan", "design", "--max-bytes", "200000", "--effort", "high"),
            args,
        )
    }

    @Test
    fun `extraArgs forward verbatim and after the flag block`() {
        // Order matters: `--effort` first (built-in), then user
        // extras, so a `--redact` extra doesn't get split by an
        // intervening built-in option.
        val s = CsSettingsState().apply {
            effort = "max"
            extraArgs = mutableListOf("--log-json", "/tmp/run.jsonl", "--redact")
        }
        val args = CsRunner.buildTaskArgs(
            CsRunner.CsTask.DEBUG,
            description = "segfault",
            paths = emptyList(),
            settings = s,
        )
        assertEquals(
            listOf("debug", "segfault", "--effort", "max", "--log-json", "/tmp/run.jsonl", "--redact"),
            args,
        )
    }

    @Test
    fun `dashboard arg vector is just dashboard plus extras`() {
        val s = CsSettingsState().apply {
            extraArgs = mutableListOf("--limit", "20")
        }
        val args = CsRunner.buildDashboardArgs(s)
        assertEquals(listOf("dashboard", "--limit", "20"), args)
    }

    @Test
    fun `maxBytes of zero is omitted (task default applies)`() {
        // Sentinel value: 0 means "let the CLI pick the per-task
        // default". We never want to send `--max-bytes 0` which the
        // CLI would interpret as "no context allowed".
        val args = CsRunner.buildTaskArgs(
            CsRunner.CsTask.REVIEW,
            description = "",
            paths = emptyList(),
            settings = CsSettingsState().apply { maxBytes = 0 },
        )
        assertTrue("--max-bytes" !in args, "0 maxBytes should not surface a flag; got $args")
    }

    @Test
    fun `blank effort is omitted`() {
        // Same sentinel logic: empty string means "task default".
        val args = CsRunner.buildTaskArgs(
            CsRunner.CsTask.DEV,
            description = "x",
            paths = emptyList(),
            settings = CsSettingsState().apply { effort = "  " },
        )
        // Whitespace-only effort is treated as "blank" by isNotBlank().
        assertTrue("--effort" !in args, "blank effort should not surface a flag; got $args")
    }
}
