"""Isolated Hermes credential helper. Secrets travel through stdin, never argv."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

PROVIDERS = {'anthropic': ('Anthropic', 'ANTHROPIC_API_KEY'), 'openrouter': ('OpenRouter', 'OPENROUTER_API_KEY')}


def effective_key(home, root, provider):
    from dotenv import dotenv_values
    import yaml
    var = PROVIDERS[provider][1]
    for folder, source in [(home, 'profile'), (root, 'computer')]:
        if any((folder / name).resolve() != folder / name for name in ('config.yaml', '.env')):
            raise ValueError('Linked credential files are unavailable')
        cfg = yaml.safe_load((folder / 'config.yaml').read_text()) or {}
        model = cfg.get('model') or {}
        inline = model.get('api_key') if isinstance(model, dict) and model.get('provider') == provider else None
        key = inline or (dotenv_values(folder / '.env').get(var) if (folder / '.env').is_file() else '')
        if key: return str(key), source
        if home == root: break
    return '', 'none'


def run(home, root, params, opener=urlopen):
    home, root = Path(home), Path(root)
    for name in ('config.yaml', '.env', 'auth.json', 'studio/provider-checks.json'):
        if (home / name).resolve() != home / name: raise ValueError('Linked credential files are unavailable')
    op = params['operation']; provider = params.get('provider')
    if op in {'endpoint_configure', 'endpoint_list'}:
        # Use the original Desktop endpoint writer and its merge/key handling.
        from hermes_cli.web_server import _write_custom_endpoint, CustomEndpointUpdate
        from hermes_cli.config import load_config, save_config, get_compatible_custom_providers, is_managed
        from urllib.parse import urlsplit
        cfg = load_config()
        if op == 'endpoint_configure':
            if is_managed(): raise ValueError('This profile has read-only settings')
            url = urlsplit(params.get('baseUrl', ''))
            if url.scheme not in {'http', 'https'} or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError('Use an HTTP endpoint URL without embedded credentials')
            body = CustomEndpointUpdate(name=params.get('name', ''), base_url=params['baseUrl'],
                model=params.get('model', ''), api_key=params.get('apiKey') or None, make_default=False)
            _write_custom_endpoint(cfg, body)
            save_config(cfg)
        # Existing URLs may contain authentication; never return them here.
        return {'endpoints': [{'name': row.get('name'), 'model': row.get('model') or row.get('default_model', '')}
                              for row in get_compatible_custom_providers(cfg)],
                'message': 'Endpoint saved for this profile. Select its model to use it.'}
    if op == 'model_options':
        from hermes_cli.inventory import load_picker_context, build_model_options_payload
        from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
        token = set_secret_scope(build_profile_secret_scope(home))
        try:
            result = build_model_options_payload(load_picker_context(), include_unconfigured=True, refresh=bool(params.get('refresh')))
            # Return only picker metadata; never return custom-provider credentials.
            return {'providers': [{k: row[k] for k in ('slug','name','models','authenticated','auth_type','available','api_key_env_vars') if k in row}
                                  for row in result.get('providers', [])]}
        finally: reset_secret_scope(token)
    if op == 'skill_update':
        from hermes_cli.config import load_config, is_managed
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills
        if is_managed(): raise ValueError('This profile has read-only settings')
        identity = params.get('id', '')
        path = home / 'skills' / identity / 'SKILL.md'
        if not isinstance(identity, str) or not identity or Path(identity).is_absolute() or '..' in Path(identity).parts or path.resolve() != path or not path.is_file():
            raise ValueError('Choose an installed skill on this profile')
        if not isinstance(params.get('enabled'), bool): raise ValueError('Choose whether the skill is enabled')
        cfg = load_config(); disabled = get_disabled_skills(cfg)
        name = path.parent.name
        disabled = {item for item in disabled if item.lower() != name.lower()}
        if not params['enabled']: disabled.add(name)
        save_disabled_skills(cfg, disabled)
        return {'id': identity, 'enabled': params['enabled']}
    state = home / 'studio' / 'provider-checks.json'
    checks = json.loads(state.read_text()) if state.exists() else {}
    if op == 'provider_keys':
        result = []
        for identity, (name, _) in PROVIDERS.items():
            key, source = effective_key(home, root, identity)
            check = checks.get(identity, {})
            current = bool(key) and check.get('fingerprint') == hashlib.sha256(key.encode()).hexdigest()
            result.append({'id': identity, 'name': name, 'configured': bool(key), 'source': source,
                           'status': check.get('status') if current else 'configured' if key else 'missing',
                           'checkedAt': check.get('at') if current else None})
        return {'keys': result}
    if provider not in PROVIDERS: raise ValueError('Choose Anthropic or OpenRouter')
    if op == 'provider_configure':
        key = params.get('apiKey')
        if not isinstance(key, str) or not 8 <= len(key.strip()) <= 4096 or any(c.isspace() for c in key.strip()):
            raise ValueError('Enter a valid API key without spaces')
        from hermes_cli.config import is_managed
        if is_managed(): raise ValueError('This managed profile has read-only credentials')
        from hermes_cli.credential_lifecycle import save_provider_env_credential
        from hermes_constants import get_hermes_home
        if Path(get_hermes_home()) != home: raise ValueError('Credential helper profile binding mismatch')
        save_provider_env_credential(PROVIDERS[provider][1], key.strip())
        # Inline credentials may previously have inherited a different root key.
        # Prefer the selected profile's newly saved credential for this provider.
        import yaml
        path = home / 'config.yaml'; cfg = yaml.safe_load(path.read_text()) or {}
        if isinstance(cfg.get('model'), dict) and cfg['model'].get('provider') == provider:
            cfg['model'].pop('api_key', None)
            tmp = path.with_suffix('.studio-tmp'); tmp.write_text(yaml.safe_dump(cfg)); tmp.chmod(0o600); tmp.replace(path)
        return {'saved': True, 'provider': provider, 'message': 'Saved for this agent. Choose its model to activate the connection in this conversation.'}
    key, source = effective_key(home, root, provider)
    if not key: return {'provider': provider, 'status': 'missing', 'message': 'No API key is configured.'}
    if provider == 'anthropic':
        request = Request('https://api.anthropic.com/v1/models?limit=1', headers={'x-api-key': key, 'anthropic-version': '2023-06-01'})
    else:
        request = Request('https://openrouter.ai/api/v1/key', headers={'Authorization': 'Bearer ' + key})
    status = 'verified'
    try:
        with opener(request, timeout=20) as response: response.read(4096)
    except HTTPError as exc:
        status = {401: 'invalid', 403: 'not_permitted', 402: 'quota', 429: 'rate_limited'}.get(exc.code, 'unavailable')
    except (URLError, TimeoutError): status = 'unavailable'
    checks[provider] = {'fingerprint': hashlib.sha256(key.encode()).hexdigest(), 'status': status, 'at': int(time.time() * 1000)}
    state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = state.with_suffix('.tmp'); tmp.write_text(json.dumps(checks)); tmp.chmod(0o600); tmp.replace(state)
    return {'provider': provider, 'source': source, 'status': status,
            'message': 'API authentication verified; model and tool availability depend on the selected model.' if status == 'verified' else 'Provider check: ' + status.replace('_', ' ')}


if __name__ == '__main__':
    try:
        result = run(Path(os.environ['HERMES_HOME']), Path(os.environ['STUDIO_CREDENTIAL_ROOT']), json.load(sys.stdin))
    except Exception:
        result = {'error': 'Provider settings unavailable. Check the key and the selected profile.'}
    print(json.dumps(result))
