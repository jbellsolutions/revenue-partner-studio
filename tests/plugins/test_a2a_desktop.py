import json
import os
from pathlib import Path
import sqlite3
import uuid

import pytest

from hermes_state import SessionDB
from plugins.platforms.a2a import desktop


@pytest.fixture
def homes(tmp_path, monkeypatch):
    result = {name: tmp_path / name for name in ('source', 'receiver', 'unrelated')}
    for home in result.values():
        home.mkdir()
    monkeypatch.setattr('hermes_cli.profiles.get_profile_dir', lambda name: result[name])
    return result


def test_preview_excludes_tools_system_hidden_and_attachments(homes):
    db = SessionDB(db_path=homes['source'] / 'state.db')
    db.create_session('private-thread', source='desktop')
    db.append_message('private-thread', 'system', 'PRIVATE SYSTEM')
    db.append_message('private-thread', 'tool', 'PRIVATE TOOL')
    db.append_message('private-thread', 'user', 'Shared text')
    db.append_message('private-thread', 'assistant', [{'type': 'text', 'text': 'Shared reply'}, {'type': 'image_url', 'image_url': {'url': 'SECRET_IMAGE'}}])
    db.append_message('private-thread', 'user', 'REWOUND PRIVATE')
    db.close()
    with sqlite3.connect(homes['source'] / 'state.db') as connection:
        connection.execute("UPDATE messages SET active = 0 WHERE content = 'REWOUND PRIVATE'")
    result = desktop.preview('source', 'private-thread')
    assert result['text'] == 'user: Shared text\n\nassistant: Shared reply'
    assert not result['truncated']
    with pytest.raises((ValueError, sqlite3.OperationalError)):
        desktop.preview('unrelated', 'private-thread')


def test_explicit_handoff_stores_only_reviewed_copy_and_is_idempotent(homes, monkeypatch):
    # Any model/CLI execution would be a violation of a history-only share.
    monkeypatch.setattr('subprocess.run', lambda *a, **kw: pytest.fail('Sharing must not execute a model or tool'))
    previous_home = os.environ.get('HERMES_HOME')
    payload = {'targetProfile': 'receiver', 'requestId': str(uuid.uuid4()),
               'sender': 'computer-one/source', 'text': 'Operator-reviewed excerpt only.'}
    result = desktop.deliver(payload)
    assert result['state'] == 'TASK_STATE_COMPLETED'
    assert desktop.deliver(payload) == result
    with pytest.raises(ValueError, match='different excerpt'):
        desktop.deliver({**payload, 'text': 'A different excerpt'})
    second = desktop.deliver({**payload, 'requestId': str(uuid.uuid4())})
    assert second['state'] == 'TASK_STATE_COMPLETED'
    assert second['sessionId'] != result['sessionId']
    long_sender = desktop.deliver({**payload, 'requestId': str(uuid.uuid4()), 'sender': 'c' * 36 + '/' + 'p' * 63})
    assert long_sender['state'] == 'TASK_STATE_COMPLETED'
    assert os.environ.get('HERMES_HOME') == previous_home
    db = SessionDB(db_path=homes['receiver'] / 'state.db')
    messages = db.get_messages(result['sessionId'])
    assert [message['role'] for message in messages] == ['user', 'assistant']
    assert 'Operator-reviewed excerpt only.' in messages[0]['content']
    assert 'computer-one/source' in messages[0]['content']
    assert 'not an agent response' in messages[1]['content']
    db.close()
    assert not (homes['unrelated'] / 'state.db').exists()
    assert not (homes['source'] / 'state.db').exists()
    assert (homes['receiver'] / 'a2a_audit.jsonl').exists()
    assert not (homes['source'] / 'a2a_audit.jsonl').exists()


@pytest.mark.parametrize('name', ['../source', '/root', 'source/child', '', 'with space'])
def test_invalid_profile_cannot_escape_home(name, homes):
    with pytest.raises(ValueError):
        desktop.profile_home(name)
