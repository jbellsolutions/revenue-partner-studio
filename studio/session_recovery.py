"""Recover a live runtime only within its original Hermes profile."""
from pathlib import Path
from .cloud_profiles import profile


def inspect_session(service, params):
    home = profile(service.home, params['agentId'])
    stored, conversation = params.get('sessionId'), params.get('conversationId')
    for runtime, session in list(service.server._sessions.items()):
        if Path(session.get('profile_home') or service.home) != home:
            continue
        if not ((stored and session.get('session_key') == stored) or
                (not stored and conversation and session.get('studio_conversation_id') == conversation)):
            continue
        return {'runtimeId': runtime, 'sessionId': session.get('session_key'),
                'info': {'session_id': runtime, 'stored_session_id': session.get('session_key'),
                         'running': bool(session.get('running'))}}
    return {'runtimeId': None, 'sessionId': stored}


def bind_session(service, params):
    home = profile(service.home, params['agentId'])
    session = service.server._sessions.get(params.get('runtimeId'))
    if not session or Path(session.get('profile_home') or service.home) != home:
        raise ValueError('Conversation does not belong to this agent')
    identity = params.get('conversationId')
    if not isinstance(identity, str) or not 1 <= len(identity) <= 200:
        raise ValueError('Invalid conversation identity')
    previous = session.get('studio_conversation_id')
    if previous and previous != identity:
        # Resuming the same stored history in another browser remains valid.
        return {'bound': False}
    session['studio_conversation_id'] = identity
    return {'bound': True}
