# claudeStruct — JetBrains plugin (W7.2)

Right-click any file (or selection) in IntelliJ IDEA / PyCharm /
WebStorm / GoLand / RubyMine / Android Studio to run one of the
five `cs` tasks. Mirror of the [VS Code extension](../vscode-extension/)
— same surface, same CLI invocation, same output streamed to a
dedicated console tab.

## Status

**Sideload-only.** Same posture as W7.1 took initially — build the
ZIP locally and install via Settings > Plugins > ⚙ > "Install Plugin
from Disk…". Marketplace publishing is a follow-up.

## Build

Requires JDK 17+ and Gradle 8.5+. The IntelliJ Platform plugin
bundles its own Kotlin compiler and downloads the Platform SDK on
first build (~500 MB cache; subsequent builds are incremental).

```bash
cd jetbrains-plugin
./gradlew buildPlugin
# → build/distributions/claudestruct-jetbrains-0.1.0.zip
```

(Or use the system `gradle` if you don't want a Gradle Wrapper:
`gradle buildPlugin`.)

## Install

1. Open any JetBrains IDE (2024.2+).
2. **Settings > Plugins > ⚙ > Install Plugin from Disk…**
3. Pick `build/distributions/claudestruct-jetbrains-0.1.0.zip`.
4. Restart the IDE.

## Configure

**Settings > Tools > claudeStruct.** Four fields:

| Field            | Default | Notes                                                |
|------------------|---------|------------------------------------------------------|
| `cs` binary path | `cs`    | Absolute path or PATH-resolved name.                 |
| Effort           | (empty) | `low` / `medium` / `high` / `xhigh` / `max`. Empty = task default. |
| Max bytes        | `0`     | `0` = task default (review 200k, dev 600k, …).       |
| Extra args       | (empty) | Space-delimited; forwarded verbatim. e.g. `--log-json /tmp/run.jsonl --redact`. |

Project-scoped — different windows pointing at different repos can
have different configs.

## Use

Right-click a file (or files) in the editor / project view, pick
**claudeStruct >** and one of:

- **Review** — `cs review` over the selection (or branch diff if
  no selection).
- **Dev** — prompts for a description, then `cs dev <desc> <paths>`.
- **Plan** — same shape as Dev.
- **Debug** — same shape as Dev (anchor on the failure description).
- **Dashboard** — `cs dashboard`; recent run summary in the same
  console tab.

Output streams to a `claudeStruct` tool window at the bottom; ANSI
colour preserved (`FORCE_COLOR=1` is set so Rich renders cleanly).

## Tests

```bash
./gradlew test
```

Pure unit tests for the arg-vector builder. The action classes
themselves require the IntelliJ Platform `TestFramework` which is
heavier; that lands when marketplace publish becomes the next
priority.

## Why not a single editor extension?

Editor populations don't overlap as much as you'd think — a Python
team on PyCharm, a Go team on GoLand, a polyglot team on IDEA all
benefit from a native plugin instead of being told "use VS Code
instead". Same shipping cost (one Kotlin codebase covers every
JetBrains IDE) so the plugin is worth the duplication with the
VS Code extension.
