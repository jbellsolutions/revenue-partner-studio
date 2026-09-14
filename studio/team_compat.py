"""Compatibility for inherited team workers with an explicit Studio screen grant.

The original worker boundary remains authoritative outside authenticated Studio
turns. Catalog reads expose only Hermes' already scoped tools; execution still
passes its native permission hooks and Studio's profile-bound screen bridge.
"""
import ast
import os


def explicit_screen_grant(config):
    grants = (config.get('tools') or {}).get('enabled_toolsets')
    if grants is None: grants = (config.get('platform_toolsets') or {}).get('cli')
    if grants is None: grants = config.get('toolsets', [])
    return ('orgo-screen' in grants and
            'orgo-screen' not in ((config.get('agent') or {}).get('disabled_toolsets') or []))


def allows_managed_screen(tool_name):
    if os.environ.get('HERMES_STUDIO_RUNTIME') != '1' or os.environ.get('HERMES_KANBAN_TASK'):
        return False
    if tool_name not in {'mcp__orgo_screen__browser_action', 'mcp__orgo_screen__desktop_action',
                         'tool_search', 'tool_describe'}:
        return False
    # Native catalog lookup runs before execution context is fully bound on
    # some providers. It reads only the session's scoped catalog and cannot
    # execute a tool. The underlying call still requires the live actor below.
    if tool_name in {'tool_search', 'tool_describe'}: return True
    try:
        from gateway.session_context import get_session_env
        if get_session_env('HERMES_SESSION_SOURCE', '') != 'studio': return False
        from studio.service import current
        from hermes_cli.config import read_user_config_raw
        service = current()
        actor = service.actor()  # Verified native session; never supplied tool arguments.
        home = service.home if actor == 'default' else service.home/'profiles'/actor
        if home.resolve() != home: return False
        return explicit_screen_grant(read_user_config_raw(home/'config.yaml'))
    except Exception:
        return False  # Missing context/configuration never expands worker permissions.


_BASE = """        def boundary(tool_name,**kwargs):
            if tool_name not in {'team_execute','team_submit_work','team_check_status','team_submit_results','team_request_corrections'}:
                return {'action':'block','message':'Team workers are limited to research, verification, QA, files, and preparation through the scoped team tools.'}
"""
_DESKTOP = """            # orgo-owner-computer-access: desktop only, never scheduled workers.
            from gateway.session_context import get_session_env
            if (get_session_env("HERMES_SESSION_SOURCE", "") == "desktop"
                    and not os.environ.get("HERMES_KANBAN_TASK")
                    and tool_name == "mcp__orgo_agent__orgo_agent_run"):
                return None
"""
_INSERT = """            # studio-managed-screen-access: explicit profile grant, no scheduled workers.
            try:
                from studio.team_compat import allows_managed_screen
                if allows_managed_screen(tool_name): return None
            except ImportError:
                pass  # Older rollback clients retain the original boundary.
"""


def patch_boundary(text):
    marker = '        def boundary(tool_name,**kwargs):\n'
    # Recognize only the inherited boundary and its two previous desktop-only
    # adaptations. An unfamiliar policy must be reviewed rather than weakened.
    alternatives = [_BASE, _BASE.replace(marker, marker + _DESKTOP),
                    _BASE.replace(marker, marker + _DESKTOP.replace(
                        'tool_name == "mcp__orgo_agent__orgo_agent_run"',
                        'tool_name in {"mcp__orgo_agent__orgo_agent_run", "tool_search", "tool_describe"}'))]
    nodes = [n for n in ast.walk(ast.parse(text)) if isinstance(n, ast.FunctionDef) and n.name == 'boundary']
    if len(nodes) != 1: raise ValueError('Unknown team boundary; no permissions changed')
    node = nodes[0]
    body = ''.join(text.splitlines(keepends=True)[node.lineno-1:node.end_lineno])
    for original in alternatives:
        updated = original.replace(marker, marker + _INSERT)
        if body == updated: return text
        if body == original:
            result = text.replace(original, updated, 1)
            ast.parse(result)
            return result
    raise ValueError('Unknown team boundary; no permissions changed')


def boundary_updates(home):
    from hermes_cli.config import read_user_config_raw
    changes = {}
    for profile in [home, *sorted((home/'profiles').glob('*'))]:
        plugin = profile/'plugins/agent-team/__init__.py'
        config = profile/'config.yaml'
        if not plugin.is_file() or not config.is_file(): continue
        if not explicit_screen_grant(read_user_config_raw(config)): continue
        if plugin.resolve() != plugin or config.resolve() != config:
            raise ValueError('Linked team files cannot be repaired')
        old = plugin.read_bytes()
        new = patch_boundary(old.decode()).encode()
        if new != old: changes[plugin] = (old, new)
    return changes
