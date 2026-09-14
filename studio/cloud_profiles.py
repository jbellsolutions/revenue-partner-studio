"""Small owner-only profile inspector; edits never target another profile."""
from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import yaml

DOCUMENTS = {'instructions': 'SOUL.md', 'memory': 'memories/MEMORY.md', 'user': 'memories/USER.md'}


def profile(home, agent):
    if not isinstance(agent, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', agent):
        raise ValueError('Invalid agent identity')
    path = Path(home) if agent == 'default' else Path(home) / 'profiles' / agent
    if path.resolve() != path or (path / 'config.yaml').is_symlink() or not (path / 'config.yaml').is_file():
        raise ValueError('Agent does not exist on this computer')
    return path


def document(home, kind):
    if kind not in DOCUMENTS: raise ValueError('Unknown profile document')
    path = home / DOCUMENTS[kind]
    if path.resolve() != path: raise ValueError('Linked documents cannot be edited')
    data = path.read_bytes() if path.exists() else b''
    if len(data) > 400000: raise ValueError('This document is too large for the compact editor')
    return {'kind': kind, 'text': data.decode('utf-8'), 'version': hashlib.sha256(data).hexdigest()}


def busy(service, home):
    return any(s.get('running') and Path(s.get('profile_home') or service.home) == home
               for s in service.server._sessions.values())


def describe(service, agent):
    home = profile(service.home, agent)
    cfg = yaml.safe_load((home / 'config.yaml').read_text()) or {}
    from hermes_cli.skills_config import get_disabled_skills
    disabled = {str(s).lower() for s in get_disabled_skills(cfg)}
    skills = []
    for path in sorted((home / 'skills').rglob('SKILL.md')):
        if path.resolve() != path or not path.is_file(): continue
        identity = str(path.parent.relative_to(home / 'skills'))
        skills.append({'id': identity, 'name': path.parent.name, 'enabled': path.parent.name.lower() not in disabled})
        if len(skills) >= 5000: break
    connections = []
    for name, entry in (cfg.get('mcp_servers') or {}).items():
        # Configuration is not proof that an external integration is healthy.
        if isinstance(entry, dict):
            connections.append({'name': name, 'status': 'disabled' if entry.get('disabled') else 'configured',
                                'message': 'Configured on this computer; not live-tested.'})
    return {'agentId': agent, 'busy': busy(service, home), 'documents': [document(home, k) for k in DOCUMENTS],
            'skills': skills, 'connections': connections}


def operation(service, op, params):
    agent = params['agentId']; home = profile(service.home, agent)
    if op == 'profile_describe': return describe(service, agent)
    # The dispatcher and imports use the same locks. No new turn starts during
    # an edit, and a running turn must finish before its cached memory is changed.
    writing = op in {'profile_update', 'provider_configure', 'skill_update', 'endpoint_configure'}
    with service.creation_lock if writing else nullcontext(), service.turn_lock if writing else nullcontext():
        if writing and (service.importing or busy(service, home)):
            raise ValueError('Wait for this agent to finish before changing its settings')
        if op == 'profile_update':
            kind = params.get('kind')
            if kind not in DOCUMENTS: raise ValueError('Unknown profile document')
            document(home, kind)  # Validate parent links before opening the lock file.
            from tools.memory_tool import MemoryStore
            with MemoryStore._file_lock(home / DOCUMENTS[kind]):
                current = document(home, kind)
                text = params.get('text')
                if not isinstance(text, str) or len(text.encode()) > 100000:
                    raise ValueError('Profile documents must contain at most 100 KB of text')
                if current['version'] != params.get('version'):
                    raise ValueError('This document changed. Reload it before saving your edit')
                path = home / DOCUMENTS[kind]
                backup = home / 'studio' / 'document-versions' / kind
                if backup.resolve() != backup: raise ValueError('Invalid version storage')
                backup.mkdir(parents=True, exist_ok=True, mode=0o700)
                previous = backup / (current['version'] + '.txt')
                if not previous.exists():
                    previous.write_text(current['text']); previous.chmod(0o600)
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                temp = path.with_name(path.name + '.studio-tmp')
                temp.write_text(text); temp.chmod(0o600); temp.replace(path)
            from hermes_constants import set_hermes_home_override, reset_hermes_home_override
            token = set_hermes_home_override(str(home))
            try:
                for session in service.server._sessions.values():
                    if Path(session.get('profile_home') or service.home) == home:
                        agent_object = session.get('agent')
                        if agent_object is not None:
                            agent_object._invalidate_system_prompt()
            finally:
                reset_hermes_home_override(token)
            return document(home, kind)
        if op in {'provider_configure', 'provider_check', 'provider_keys', 'model_options', 'skill_update', 'endpoint_configure', 'endpoint_list'}:
            env = os.environ.copy()
            env['HERMES_HOME'] = str(home)
            env['PYTHONPATH'] = str(Path(__file__).resolve().parent.parent)
            env['STUDIO_CREDENTIAL_ROOT'] = str(service.home)
            from hermes_cli.auth import PROVIDER_REGISTRY
            for key in {v for provider in PROVIDER_REGISTRY.values() for v in provider.api_key_env_vars}:
                env.pop(key, None)
            proc = subprocess.run([sys.executable, '-m', 'studio.cloud_credentials'],
                input=json.dumps({'operation': op, **params}), text=True, capture_output=True,
                env=env, timeout=75 if op == 'model_options' else 40)
            if proc.returncode: raise ValueError('Provider settings could not be updated on this computer')
            result = json.loads(proc.stdout)
            if result.get('error'): raise ValueError(result['error'])
            return result
    raise ValueError('Unknown profile operation')
