# MCP server (`claw-squad mcp`)

`claw-squad` exposes a small set of read-only tools over the Model
Context Protocol so Claude Code (or any MCP client) can browse run
history without a shell hop. Mirrors the parallel surface in
claudestruct (`cs mcp`).

## Tools

| Tool name                   | Args                                            | Returns                                  |
|-----------------------------|-------------------------------------------------|------------------------------------------|
| `claw_squad_dashboard`      | `repo_root?`, `filter?`                         | `{runs: RunSummary[]}`                   |
| `claw_squad_dashboard_diff` | `repo_root?`, `run_a` (req), `run_b` (req)      | `{diff: DiffReport}` (b − a)             |
| `claw_squad_runs_list`      | `repo_root?`                                    | `{runs: [{run_id, path, size_bytes, mtime_ms, age_ms}]}` |
| `claw_squad_runs_purge`     | `repo_root?`, `older_than_days` (req), `dry_run?` | `{deleted: string[], dry_run: bool}`     |

`run_id` is the JSONL filename without the `.jsonl` extension (the
same id `claw-squad dashboard diff` accepts on the CLI).

The full `claw_squad_run` (interactive, multi-hour orchestrator
dispatch) is **not** exposed — driving it through MCP needs proper
streaming notifications and a non-interactive UI shim. Tracked as a
follow-up.

## Setup

The SDK is in `optionalDependencies` so default installs stay lean.
Install it explicitly when you want `claw-squad mcp`:

```bash
pnpm add @modelcontextprotocol/sdk
# or
npm install @modelcontextprotocol/sdk
```

Wire `claw-squad` into Claude Code via `.mcp.json`:

```json
{
  "mcpServers": {
    "claw-squad": {
      "command": "claw-squad",
      "args": ["mcp"]
    }
  }
}
```

Once Claude Code reloads, the four tools appear under the `claw-squad`
namespace and can be called with arguments matching the table above.

## Why read-only first

`runOrchestrator` is interactive (it asks Planner clarification
questions) and can take 30+ minutes. Wrapping it as a synchronous MCP
tool would either block the client for the whole run or require a
mock UI that can't ask follow-ups — both bad UX. The read-only surface
covers the high-leverage workflows (browsing run history, diffing two
runs, pruning old logs) without those tradeoffs; the interactive
`run` tool ships separately when streaming notifications are designed.

## Testing

Pure handlers live in `src/mcp/handlers.ts` and are exercised in
`tests/mcp.test.ts` without touching the MCP SDK. The protocol shim
in `src/mcp/server.ts` lazy-imports the SDK only when `claw-squad mcp`
is invoked, so it never appears in `pnpm test` runs.
