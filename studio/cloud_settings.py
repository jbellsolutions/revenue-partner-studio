"""Small profile-scoped settings surface using Hermes's native config writer."""
import hashlib
import json
from pathlib import Path
import yaml
from .cloud_profiles import profile, busy

FIELDS = {'agent.max_turns', 'agent.reasoning_effort', 'agent.disabled_toolsets'}
EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']


def snapshot(home):
    raw = (home / 'config.yaml').read_bytes()
    cfg = yaml.safe_load(raw) or {}
    agent = cfg.get('agent') or {}
    from toolsets import TOOLSETS
    return {'version': hashlib.sha256(raw).hexdigest(),
            'values': {'agent.max_turns': agent.get('max_turns', cfg.get('max_turns', 90)),
                       'agent.reasoning_effort': agent.get('reasoning_effort', 'medium'),
                       'agent.disabled_toolsets': agent.get('disabled_toolsets', [])},
            'efforts': EFFORTS, 'toolsets': sorted(TOOLSETS)}


def operation(service, params):
    home = profile(service.home, params['agentId'])
    if params['operation'] == 'profile_settings_get':
        return {**snapshot(home), 'busy': busy(service, home)}
    with service.creation_lock, service.turn_lock:
        if service.importing or busy(service, home):
            raise ValueError('Wait for this agent to finish before saving its settings')
        from tools.memory_tool import MemoryStore
        with MemoryStore._file_lock(home / 'config.yaml'):
            before = snapshot(home)
            if before['version'] != params.get('version'):
                raise ValueError('These settings changed. Reload before saving your edits')
            changes = params.get('changes')
            if not isinstance(changes, dict) or not changes or set(changes) - FIELDS:
                raise ValueError('Choose supported Hermes settings')
            for key, value in changes.items():
                if key == 'agent.max_turns' and (type(value) is not int or not 1 <= value <= 1000):
                    raise ValueError('Turn limit must be between 1 and 1000')
                if key == 'agent.reasoning_effort' and value not in EFFORTS:
                    raise ValueError('Choose a supported reasoning effort')
                if key == 'agent.disabled_toolsets' and (not isinstance(value, list) or
                        any(not isinstance(v, str) or v not in before['toolsets'] for v in value)):
                    raise ValueError('Choose existing Hermes toolsets')
            # Native home overrides are context-local; never change process HERMES_HOME.
            from hermes_constants import set_hermes_home_override, reset_hermes_home_override
            token = set_hermes_home_override(str(home))
            try:
                from hermes_cli.config import read_raw_config, save_config, is_managed
                from hermes_cli import managed_scope
                if is_managed() or set(changes) & set(managed_scope.managed_config_keys()):
                    raise ValueError('These settings are managed outside Studio')
                cfg = read_raw_config()
                for key, value in changes.items():
                    section, field = key.split('.')
                    cfg.setdefault(section, {})[field] = value
                backup = home / 'studio' / 'config-versions'
                if backup.resolve() != backup: raise ValueError('Invalid settings backup path')
                backup.mkdir(parents=True, exist_ok=True, mode=0o700)
                saved = backup / (before['version'] + '.yaml')
                if not saved.exists():
                    saved.write_bytes((home / 'config.yaml').read_bytes()); saved.chmod(0o600)
                save_config(cfg, preserve_keys={tuple(k.split('.')) for k in changes})
            finally:
                reset_hermes_home_override(token)
            for session in service.server._sessions.values():
                if Path(session.get('profile_home') or service.home) == home:
                    session['studio_settings_changed'] = {**session.get('studio_settings_changed', {}), **changes}
            return {**snapshot(home), 'busy': False, 'applies': 'next_turn'}


def apply_pending(service, runtime, session):
    changes = session.get('studio_settings_changed')
    if not changes: return
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(str(session.get('profile_home') or service.home))
    try:
        agent = session.get('agent')
        if 'agent.reasoning_effort' in changes:
            service.rpc('config.set', {'session_id': runtime, 'key': 'reasoning', 'value': changes['agent.reasoning_effort']})
        if agent is not None:
            if 'agent.max_turns' in changes: agent.max_iterations = changes['agent.max_turns']
            if 'agent.disabled_toolsets' in changes:
                from tools.mcp_tool import refresh_agent_mcp_tools
                from .machine import kind
                disabled = set(changes['agent.disabled_toolsets'])
                if kind() == 'orgo': disabled.update({'browser', 'desktop_ui', 'computer_use'})
                refresh_agent_mcp_tools(agent, enabled_override=service.server._load_enabled_toolsets(),
                                        disabled_override=sorted(disabled), quiet_mode=True)
            agent._invalidate_system_prompt()
        session.pop('studio_settings_changed', None)
    finally:
        reset_hermes_home_override(token)
