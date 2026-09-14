"""Session-only adapter around Hermes's existing model switch implementation."""
import hashlib
import json
from pathlib import Path
import re
import shlex

from .cloud_import import atomic_write
from .cloud_profiles import profile


def binding(service, params):
    home = profile(service.home, params['agentId'])
    session = service.server._sessions.get(params.get('runtimeId'))
    if not session or Path(session.get('profile_home') or service.home) != home:
        raise ValueError('Open the selected agent’s conversation before choosing a model')
    identity = session.get('session_key')
    if not identity:
        raise ValueError('Wait for this conversation to open')
    path = home / 'studio' / 'model-selections' / (hashlib.sha256(identity.encode()).hexdigest() + '.json')
    if path.resolve() != path:
        raise ValueError('Invalid model selection storage')
    return home, session, path


def status(session, path):
    saved = json.loads(path.read_text()) if path.exists() else {}
    agent = session.get('agent')
    return {'model': getattr(agent, 'model', '') or saved.get('model', ''),
            'provider': getattr(agent, 'provider', '') or saved.get('provider', ''), **saved}


def apply(service, params):
    """Called while holding the turn lock, before any next-turn model request."""
    home = profile(service.home, params['agentId'])
    if not (home / 'studio' / 'model-selections').exists():
        return {}
    home, session, path = binding(service, params)
    value = status(session, path)
    if value.get('state') == 'error':
        raise ValueError(value['error'])
    if value.get('state') != 'pending' or session.get('running'):
        return value
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
    home_token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope(build_profile_secret_scope(home))
    try:
        raw = shlex.quote(value['model']) + ' --provider ' + shlex.quote(value['provider']) + ' --session'
        result = service.rpc('config.set', {'session_id': params['runtimeId'], 'key': 'model', 'value': raw})
        if result.get('confirm_required'):
            raise ValueError(result.get('confirm_message') or 'This model requires additional cost confirmation in Hermes.')
        if result.get('deferred'):
            raise ValueError('The agent is still working. Choose the model again after this turn.')
        value = {**value, 'state': 'applied', 'error': ''}
    except Exception:
        # Provider exceptions may contain endpoint credentials. Persist only safe copy.
        value = {**value, 'state': 'error', 'error': 'The selected model could not be activated. Check its connection and choose a model again. No message was sent using a fallback.'}
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)
    atomic_write(path, json.dumps(value).encode())
    if value['state'] == 'error':
        raise ValueError(value['error'])
    return value


def operation(service, params):
    with service.turn_lock:
        if service.importing:
            raise ValueError('Wait for the profile import to finish before changing its model')
        home, session, path = binding(service, params)
        if params['operation'] == 'model_select':
            model, provider = params.get('model', ''), params.get('provider', '')
            if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@+\-]{0,199}', model):
                raise ValueError('Enter a model ID, without command flags or spaces')
            if not isinstance(provider, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:\-]{0,99}', provider):
                raise ValueError('Choose a provider')
            atomic_write(path, json.dumps({'model': model, 'provider': provider, 'state': 'pending', 'error': ''}).encode())
        if session.get('running'):
            return status(session, path)
        return apply(service, params)
