"""Provider credentials stay isolated, including SDK-created client copies."""
import httpx
import pytest

from agent.anthropic_adapter import build_anthropic_client


@pytest.mark.parametrize('bearer', [False, True])
def test_unused_environment_credential_never_reaches_request(monkeypatch, bearer):
    pytest.importorskip('anthropic')
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'unrelated-env-api-key')
    monkeypatch.setenv('ANTHROPIC_AUTH_TOKEN', 'unrelated-env-bearer')
    endpoint = 'https://api.minimax.io/anthropic' if bearer else 'https://provider.invalid'
    captured = []

    def respond(request):
        captured.append(dict(request.headers))
        return httpx.Response(200, json={
            'id': 'msg_test', 'type': 'message', 'role': 'assistant',
            'content': [{'type': 'text', 'text': 'ok'}], 'model': 'test',
            'stop_reason': 'end_turn', 'usage': {'input_tokens': 1, 'output_tokens': 1},
        })

    original = build_anthropic_client('selected-provider-secret', base_url=endpoint)
    try:
        # Both an ordinary copy and a copy of that copy re-run SDK construction.
        with httpx.Client(transport=httpx.MockTransport(respond)) as transport:
            with original.with_options(http_client=transport) as first:
                first.messages.create(model='test', max_tokens=8, messages=[{'role': 'user', 'content': 'test'}])
                with first.with_options(timeout=30) as second:
                    second.messages.create(model='test', max_tokens=8, messages=[{'role': 'user', 'content': 'test'}])
    finally:
        original.close()
    assert len(captured) == 2
    for headers in captured:
        if bearer:
            assert headers['authorization'] == 'Bearer selected-provider-secret'
            assert 'x-api-key' not in headers
        else:
            assert headers['x-api-key'] == 'selected-provider-secret'
            assert 'authorization' not in headers
        assert not any('unrelated-env-' in value for value in headers.values())
