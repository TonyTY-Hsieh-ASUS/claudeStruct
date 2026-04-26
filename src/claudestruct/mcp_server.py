"""MCP server bootstrap — wires the dict-in/dict-out handlers from
`mcp_handlers.py` to the Anthropic MCP SDK's stdio transport.

Why this is its own module: importing the `mcp` package pulls in a
non-trivial dep tree (asyncio plumbing, JSON schema, etc.). Keeping
that import inside `serve_stdio()` means tests, dashboard usage, and
the four task subcommands never pay the cost.

Wiring the server into Claude Code: see CLAUDE.md → "MCP setup".
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from claudestruct.client import ClaudestructError
from claudestruct.mcp_handlers import HANDLERS, TOOL_SCHEMAS


async def serve_stdio() -> None:
    """Run the MCP server over stdin/stdout. Blocks until the peer
    closes the stream. Raises a clear error if the `mcp` SDK isn't
    installed (the package ships with claudestruct but a user could
    have stripped it)."""
    try:
        from mcp.server import Server
        from mcp.server.stdio import stdio_server
        from mcp.types import TextContent, Tool
    except ImportError as exc:  # pragma: no cover — exercised manually
        raise ClaudestructError(
            "MCP SDK not installed. Reinstall claudestruct (`pip install -e .`) "
            "or run `pip install mcp`."
        ) from exc

    server: Server = Server("claudestruct")

    @server.list_tools()  # type: ignore[misc]
    async def list_tools() -> list[Any]:
        return [
            Tool(
                name=t["name"],
                description=t["description"],
                inputSchema=t["inputSchema"],
            )
            for t in TOOL_SCHEMAS
        ]

    @server.call_tool()  # type: ignore[misc]
    async def call_tool(name: str, arguments: dict[str, Any]) -> list[Any]:
        handler = HANDLERS.get(name)
        if handler is None:
            return [TextContent(
                type="text",
                text=json.dumps({"error": f"unknown tool: {name}"}),
            )]
        try:
            # MCP handlers are sync; run them in the default executor so
            # we don't block the event loop on the streaming SDK call.
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(None, handler, arguments)
            return [TextContent(type="text", text=json.dumps(result))]
        except (ClaudestructError, ValueError, KeyError) as err:
            # Don't crash the server on a bad request — return a
            # structured error the client can surface to the user.
            return [TextContent(
                type="text",
                text=json.dumps({"error": str(err), "tool": name}),
            )]

    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


def run() -> None:
    """Entry point used by the CLI's `cs mcp` subcommand."""
    asyncio.run(serve_stdio())


__all__ = ["run", "serve_stdio"]
