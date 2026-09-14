"""Profile-bound MCP transport for the multiplexed Hermes gateway.

Hermes' general MCP registry keys connections by server name. Studio's identical
screen schemas instead require a separate process/connection per authenticated
calling agent. Execution and image handling still use Hermes' MCP machinery.
"""
from __future__ import annotations
import asyncio
import json

_connections = {}
_locks = {}


def call(tool_name: str, args: dict) -> str:
    from studio.service import current, screen_config
    from tools import mcp_tool as mcp
    from hermes_cli.orgo_screens import PROFILE
    profile = current().actor()  # Never trust an agent-supplied profile argument.
    if not PROFILE.fullmatch(profile):
        raise ValueError('Invalid calling agent')
    if tool_name not in {'browser_action', 'desktop_action'}:
        raise ValueError('Unknown Studio screen operation')

    async def invoke():
        lock = _locks.setdefault(profile, asyncio.Lock())
        async with lock:
            connection = _connections.get(profile)
            if connection is None or connection.session is None:
                if connection is not None:
                    await connection.shutdown()
                connection = await mcp._connect_server('studio-screen-' + profile, screen_config(profile))
                _connections[profile] = connection
            result = await connection.session.call_tool(tool_name, arguments=args)
            parts=[]
            for block in result.content or []:
                if getattr(block,'text',None): parts.append(block.text)
                else:
                    rendered=mcp._cache_mcp_image_block(block)
                    if rendered: parts.append(rendered)
            # MCP 1.x uses the wire alias; MCP 2.x exposes the Python field name.
            if hasattr(result, 'is_error'): failed = result.is_error
            elif hasattr(result, 'isError'): failed = result.isError
            else: raise TypeError('Unsupported MCP tool-result error field')
            return json.dumps({'error' if failed else 'result':'\n'.join(parts), 'screen_owner':profile})
    try:
        return mcp._run_on_mcp_loop(invoke, timeout=120)
    except InterruptedError:
        return json.dumps({'error':'Screen action interrupted. Inspect current screen before repeating any action.', 'screen_owner':profile})
    except Exception as exc:
        # A transport failure can arrive after a successful action. Do not
        # automatically replay clicks, typing, or navigation after uncertainty.
        return json.dumps({'error':f'Screen result uncertain: {type(exc).__name__}: {exc}. Inspect the screen before retrying.', 'screen_owner':profile})
