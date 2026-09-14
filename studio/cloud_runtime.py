"""Runtime-only screen routing for legacy and imported Hermes profiles.

The isolated Studio process replaces its legacy Orgo/browser connection paths.
Original profile configuration and the rollback applications are unchanged.
"""
import os
from pathlib import Path


def legacy_screen(name):
    name=str(name).lower().replace('_','-').removeprefix('mcp-')
    return name in {'orgo','orgo-agent','orgo-computer','orgo-desktop','orgocomputer'}


def browser_authorized(config):
    disabled=(config.get('agent') or {}).get('disabled_toolsets') or []
    if 'orgo-screen' in disabled:return False
    from .service import specialist_toolsets
    if 'orgo-screen' in specialist_toolsets(config):return True
    if 'browser' in disabled:return False
    grants=(config.get('tools') or {}).get('enabled_toolsets')
    if grants is None:grants=(config.get('platform_toolsets') or {}).get('cli')
    if grants is None:grants=config.get('toolsets')
    if grants is not None and not any(legacy_screen(name) for name in grants):return False
    from hermes_cli.tools_config import _parse_enabled_flag
    return any(legacy_screen(name) and isinstance(value,dict) and
        _parse_enabled_flag(value.get('enabled',True),default=True)
        for name,value in (config.get('mcp_servers') or {}).items())


def mcp_servers(config, servers):
    if os.environ.get('HERMES_STUDIO_RUNTIME')!='1':return servers
    result={name:value for name,value in servers.items() if not legacy_screen(name) and name!='orgo-screen'}
    if browser_authorized(config):
        from hermes_constants import get_hermes_home
        from .service import screen_config
        home=Path(get_hermes_home())
        profile=home.name if home.parent.name=='profiles' else 'default'
        result['orgo-screen']=screen_config(profile)
    return result


def tool_selection(config, enabled):
    if os.environ.get('HERMES_STUDIO_RUNTIME')!='1':return enabled,None
    if enabled is not None:
        enabled=[name for name in enabled if not legacy_screen(name)]
        if browser_authorized(config):enabled=sorted(set(enabled)|{'orgo-screen'})
    # Hermes applies disabled toolsets after expanding aliases such as hermes-cli.
    # Thus imported aliases cannot retain an invisible generic browser route.
    disabled=(config.get('agent') or {}).get('disabled_toolsets') or []
    return enabled,sorted(set(disabled)|{'browser','desktop_ui','computer_use'})
