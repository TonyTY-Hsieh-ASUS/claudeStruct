# claudeStruct for VS Code

Right-click a file → run `cs review` / `cs dev` / `cs plan` / `cs debug` from the editor without dropping to a terminal. Output streams to a dedicated `claudeStruct` Output Channel.

> **Status**: scaffold (W7.1). Sideload-only for now; marketplace publish lands once a publisher account is provisioned.

## Prerequisites

1. The `cs` CLI on `PATH`. Install via `pip install claudestruct` or point `claudestruct.cliPath` at a non-PATH location.
2. `ANTHROPIC_API_KEY` set in the env that VS Code inherits (typically your shell profile).

## Install (sideload)

```bash
cd vscode-extension
npm install
npm run compile
# Package and install:
npx vsce package
code --install-extension claudestruct-vscode-0.1.0.vsix
```

Reload the VS Code window. Commands appear under the `claudeStruct:` prefix in the Command Palette and on right-click.

## Commands

| Command | Where | Behavior |
|---|---|---|
| `claudeStruct: Review` | Palette · Editor context · Explorer context | Runs `cs review [paths]`. Empty description = the CLI's standard review prompt. |
| `claudeStruct: Dev` | Palette · Editor / Explorer context | Prompts for a description, runs `cs dev "<desc>" [paths]`. |
| `claudeStruct: Plan` | Palette | Prompts for a description, runs `cs plan "<desc>"`. |
| `claudeStruct: Debug` | Palette | Prompts for a description, runs `cs debug "<desc>"`. |
| `claudeStruct: Dashboard` | Palette | Runs `cs dashboard` and streams the table. |

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `claudestruct.cliPath` | `cs` | Path to the executable. Override for venvs / nix profiles. |
| `claudestruct.maxBytes` | `0` | Per-task context byte budget. `0` = use the per-task default (review 200k, dev 600k, debug 400k, plan 800k). |
| `claudestruct.effort` | `""` | Override `--effort`. Empty = inherit per-task default. |
| `claudestruct.extraArgs` | `[]` | Extra arguments appended to every invocation, e.g. `["--monthly-cap-usd", "20"]`, `["--log-json", "/tmp/cs.jsonl"]`. |

## How invocations route

1. Right-click a file in the Explorer / editor → the clicked file becomes the positional `paths` arg, the workspace folder owning that file becomes `cwd`.
2. Right-click with multi-select → all selected files are forwarded.
3. Palette without a target → `cwd` is the first workspace folder; no path arg is sent (CLI picks up changed files from git).

## Testing

Pure-logic tests run under vitest without the VS Code API:

```bash
cd vscode-extension
npm install
npx vitest run
```

13 cases cover `buildArgs` (every config knob path) + `runCs` (stdout/stderr collection, streaming order, spawn-error rejection, non-zero exit code passthrough).

## What's NOT in this scaffold

- **WebView output** — the CLI's Rich output renders fine in the OutputChannel; a WebView would 3x the activation cost for marginal value.
- **PR-style inline comments** — `cs review` results stay in the panel. Inline-comment surfacing depends on a structured-output mode the CLI doesn't expose yet (tracked under F6).
- **Marketplace publish** — needs a `publisher` account on the VS Code Marketplace + Open VSX, plus signing. This PR ships the scaffold so a future PR can `vsce publish`.
- **JetBrains plugin** — separate codebase, tracked as W7.2.
