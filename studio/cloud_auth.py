"""Profile-bound proxy for supported Hermes provider sign-in flows."""
import asyncio
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
import uuid

CLAUDE_NOTICE = ('Claude OAuth requires a Claude Max plan with extra-usage credits. '
                 'It does not use the included Pro/Max allowance. Studio never enables paid API fallback.')


async def provider_flow(connector, method, agent, params):
    connector.profile(agent)
    def request(route, body=None):
        base = connector.config['hermesUrl'].replace('ws:', 'http:').rstrip('/')
        token = Path(connector.config['hermesTokenFile']).read_text().strip()
        url = base + '/api/providers/oauth' + route + '?' + urlencode({'profile': agent})
        req = Request(url, data=json.dumps(body).encode() if body is not None else None,
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                               'Origin': connector.config.get('hermesOrigin', 'http://localhost:8787')})
        try:
            with urlopen(req, timeout=35) as response:
                return json.load(response)
        except HTTPError as exc:
            # Do not propagate provider responses that might contain tokens.
            raise RuntimeError(f'Provider connection unavailable on this computer (HTTP {exc.code}).') from None

    if method == 'providers.list':
        result = await asyncio.to_thread(request, '')
        return {'providers': [{'id': p['id'], 'name': p['name'], 'flow': p['flow'],
                    'connected': bool(p.get('status', {}).get('logged_in')),
                    'expiresAt': p.get('status', {}).get('expires_at'),
                    'notice': CLAUDE_NOTICE if p['id'] == 'anthropic' else ''}
                    for p in result.get('providers', [])]}
    if method == 'providers.begin':
        provider = params.get('provider')
        if provider not in {'openai-codex', 'anthropic'}:
            raise ValueError('This provider does not have a supported Studio sign-in flow')
        if provider == 'anthropic' and params.get('acknowledgeExtraUsage') is not True:
            return {'provider': provider, 'status': 'acknowledgment_required', 'message': CLAUDE_NOTICE}
        result = await asyncio.to_thread(request, '/' + provider + '/start', {})
        flow = uuid.uuid4().hex
        connector.auth_flows[flow] = {'agent': agent, 'provider': provider,
            'session': result['session_id'], 'expires': time.time() + result.get('expires_in', 600)}
        return {'flowId': flow, 'provider': provider, 'status': 'pending', 'flow': result['flow'],
                'url': result.get('verification_url') or result.get('auth_url'),
                'code': result.get('user_code'), 'message': 'Complete sign-in with the provider.'}
    flow = connector.auth_flows.get(params.get('flowId'))
    if not flow or flow['agent'] != agent or flow['expires'] < time.time():
        raise ValueError('This sign-in has expired or belongs to another agent. Start a new sign-in.')
    if method == 'providers.submit':
        code = params.get('code', '')
        if not isinstance(code, str) or not code or len(code) > 4096:
            raise ValueError('A valid provider authorization code is required')
        result = await asyncio.to_thread(request, '/' + flow['provider'] + '/submit',
                                       {'session_id': flow['session'], 'code': code})
    else:
        result = await asyncio.to_thread(request, '/' + flow['provider'] + '/poll/' + quote(flow['session'], safe=''))
    return {'flowId': params['flowId'], 'provider': flow['provider'], 'status': result.get('status'),
            'message': 'Connected on this computer.' if result.get('status') == 'approved' else
                       'Sign-in failed or expired. Start again.' if result.get('status') == 'error' else 'Waiting for provider sign-in.'}
