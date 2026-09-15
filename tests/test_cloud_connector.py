import json
from unittest.mock import AsyncMock
import pytest
from studio.cloud_connector import Connector
from studio.cloud_ledger import Ledger


def connector(tmp_path):
    home = tmp_path / 'home'; home.mkdir()
    (home / 'config.yaml').write_text('model: test\n')
    (home / 'orgo-computer').mkdir()
    (home / 'orgo-computer/computer.json').write_text(json.dumps({'computerId': 'test-computer'}))
    return Connector({'computerId': 'test-computer', 'hermesHome': str(home),
        'stateDir': str(tmp_path / 'connector'), 'hermesUrl': 'http://127.0.0.1:8787',
        'cloudUrl': 'http://localhost:8788'})


def test_diagnostic_disk_failure_does_not_disconnect_transport(tmp_path, monkeypatch):
    c=connector(tmp_path)
    def full_disk(*args): raise OSError(28, 'No space left on device')
    monkeypatch.setattr('studio.cloud_import.atomic_write',full_disk)
    c.connection_diagnostic('hermes')
    c.connection_diagnostic('cloud',ConnectionError('offline'))
    # This exemption covers diagnostics only; durable work still uses its ledger.
    c.ledger.begin('task','chat.send',{})
    assert c.ledger.requests()[0]['state']=='dispatching'


@pytest.mark.asyncio
async def test_cloud_readiness_waits_for_authenticated_hello_and_preserves_legacy_frames(tmp_path):
    import asyncio
    c=connector(tmp_path)
    waiting=asyncio.Future()
    ws=AsyncMock()
    async def receive():
        if ws.recv.await_count == 1:return json.dumps({'type':'permissions','computerId':c.computer,'proof':{}})
        return await waiting
    ws.recv.side_effect=receive
    admission=asyncio.create_task(c.cloud_handshake(ws))
    await asyncio.sleep(0)
    assert c.cloud is None and not (c.base/'cloud-connection.json').exists()
    waiting.set_result(json.dumps({'type':'hello','computerId':c.computer,'protocol':1}))
    assert await admission == [{'type':'permissions','computerId':c.computer,'proof':{}}]
    ws.recv=AsyncMock(return_value=json.dumps({'type':'hello','computerId':'another-computer','protocol':1}))
    with pytest.raises(ValueError,match='identity'):await c.cloud_handshake(ws)
    ws.recv=AsyncMock(return_value=json.dumps({'type':'request','computerId':c.computer,'method':'chat.send'}))
    with pytest.raises(ValueError,match='admission'):await c.cloud_handshake(ws)


def test_transport_diagnostics_distinguish_local_keepalive_from_remote_rejection(tmp_path):
    from types import SimpleNamespace
    c=connector(tmp_path)
    error=ConnectionError('sensitive raw exception must not be copied')
    error.rcvd=None;error.sent=SimpleNamespace(code=1011,reason='keepalive ping timeout')
    c.connection_diagnostic('cloud',error)
    data=json.loads((c.base/'cloud-connection.json').read_text())
    assert data['closeCode']==1011 and data['closeDirection']=='sent'
    assert data['reason']=='keepalive ping timeout' and 'sensitive' not in json.dumps(data)
    error.rcvd=SimpleNamespace(code=1008,reason='A connector already owns this computer')
    c.connection_diagnostic('cloud',error)
    data=json.loads((c.base/'cloud-connection.json').read_text())
    assert data['closeCode']==1008 and data['closeDirection']=='received'


@pytest.mark.asyncio
async def test_peer_handoff_carries_selected_source_agent_to_native_outbox(tmp_path):
    c=connector(tmp_path);child=c.home/'profiles/email';child.mkdir(parents=True);(child/'config.yaml').write_text('model: test')
    c.rpc=AsyncMock(return_value={'accepted':True})
    await c.operation('peer.send',{'agentId':'email','targetComputerId':'other','targetAgentId':'worker','text':'Test'},'task')
    assert c.rpc.call_args.args[1]['agentId']=='email'
    assert c.rpc.call_args.args[1]['operation']=='owner_peer_send'


@pytest.mark.asyncio
async def test_retry_and_conflicting_request_cannot_repeat_or_corrupt_receipt(tmp_path):
    c = connector(tmp_path); c.operation = AsyncMock(return_value={'accepted': True}); c.cloud_send = AsyncMock()
    request = {'id': 'transport1', 'requestId': 'task', 'method': 'chat.send', 'params': {'text': 'one'}}
    await c.request(request); await c.request({**request, 'id': 'transport2'})
    assert c.operation.await_count == 1
    await c.request({**request, 'params': {'text': 'different'}})
    assert 'different operation' in c.cloud_send.call_args.args[0]['error']
    await c.request(request)
    assert c.operation.await_count == 1
    assert c.ledger.requests()[0]['state'] == 'accepted'


@pytest.mark.asyncio
async def test_ambiguous_dispatch_is_held_for_review_not_repeated(tmp_path):
    c = connector(tmp_path); c.operation = AsyncMock(side_effect=ConnectionError('lost')); c.cloud_send = AsyncMock()
    request = {'id': 'wire', 'requestId': 'task', 'method': 'chat.send', 'params': {}}
    await c.request(request); await c.request(request)
    assert c.operation.await_count == 1
    assert c.ledger.requests()[0]['state'] == 'needs_review'


@pytest.mark.asyncio
async def test_recovery_acknowledgment_is_reconciled_with_the_same_authorization(tmp_path):
    c=connector(tmp_path);c.operation=AsyncMock(side_effect=[ConnectionError('lost'),{'id':'task:recovery'}]);c.cloud_send=AsyncMock()
    request={'id':'wire','requestId':'resume','method':'tasks.resume','params':{'taskId':'task','inspectionToken':'reviewed'}}
    await c.request(request);await c.request(request)
    assert c.operation.await_count==2
    assert c.ledger.requests()[0]['state']=='accepted'
    await c.request(request)
    assert c.operation.await_count==2


@pytest.mark.asyncio
async def test_recovery_inspection_has_bounded_previews_and_keeps_its_token(tmp_path):
    c=connector(tmp_path);c.rpc=AsyncMock(return_value={'delivery':{'id':'task'},'inspection_token':'reviewed',
        'events':[{'kind':'tool.complete','payload':'x'*5000} for _ in range(45)],'history_tail':[{'role':'assistant','content':'y'*5000}]})
    result=await c.operation('tasks.reconcile',{'taskId':'task'},'id')
    assert result['inspectionToken']=='reviewed' and result['earlierActions']==5
    assert len(result['actions'])==40 and result['actions'][0]['truncated']
    assert len(result['history'][0]['text'])==4000


def test_second_connector_does_not_recover_the_running_owner(tmp_path):
    c = connector(tmp_path); c.ledger.begin('task', 'chat.send', {})
    with pytest.raises(RuntimeError, match='already owns'):
        Connector(c.config)
    assert c.ledger.requests()[0]['state'] == 'dispatching'


def test_restart_marks_incomplete_dispatch_for_review(tmp_path):
    db = tmp_path / 'ledger.db'; l = Ledger(db); l.begin('task', 'chat.send', {}); l.db.close()
    assert Ledger(db).requests()[0]['state'] == 'needs_review'


@pytest.mark.asyncio
async def test_new_conversation_does_not_require_history_row_before_first_prompt(tmp_path):
    c = connector(tmp_path); c.rpc = AsyncMock(return_value={'session_id': 'runtime', 'stored_session_id': 'not-yet-persisted'})
    r = await c.operation('sessions.open', {'agentId': 'default'}, 'id')
    assert r['messages'] == []
    assert c.ledger.session('runtime', 'default')['stored'] == 'not-yet-persisted'


def test_runtime_session_cannot_be_used_for_another_profile(tmp_path):
    c = connector(tmp_path); c.ledger.bind('r', 'default', 's')
    with pytest.raises(ValueError): c.ledger.session('r', 'other')


@pytest.mark.asyncio
async def test_interrupted_import_can_resume_its_hash_journal(tmp_path):
    c = connector(tmp_path); c.operation = AsyncMock(side_effect=[ConnectionError('lost'), {'profiles': []}]); c.cloud_send = AsyncMock()
    request = {'id': 'wire', 'requestId': 'archive', 'method': 'import.commit', 'params': {'uploadId': 'a' * 64}}
    await c.request(request)
    assert c.ledger.requests()[0]['state'] == 'needs_review'
    await c.request(request)
    assert c.operation.await_count == 2
    assert c.ledger.requests()[0]['state'] == 'accepted'


def test_history_follows_only_compression_parents_and_bounds_large_messages(tmp_path):
    import sqlite3
    c=connector(tmp_path)
    with sqlite3.connect(c.home/'state.db') as db:
        db.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY,parent_session_id TEXT,end_reason TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,active INTEGER);INSERT INTO sessions VALUES('parent',NULL,'compression'),('tip','parent',NULL),('unrelated',NULL,NULL);INSERT INTO messages VALUES(1,'parent','user','Before compression',1),(3,'unrelated','user','Private other history',1);")
        db.execute("INSERT INTO messages VALUES(2,'tip','assistant',?,1)",('😀'*20000,))
    history=c.history('default','tip')
    assert [m['id'] for m in history['messages']]==[1,2]
    assert len(history['messages'][1]['content'])==16000
    remainder=c.history('default','tip',message_id=2,offset=16000)
    assert len(remainder['content'])==4000 and not remainder['truncated']
    with pytest.raises(ValueError,match='belong'):c.history('default','tip',message_id=3)


def test_multimodal_history_preserves_text_without_shipping_image_payload(tmp_path):
    import sqlite3
    c=connector(tmp_path)
    structured='\x00json:'+json.dumps([{'type':'text','text':'😀'*17000},
        {'type':'image_url','image_url':{'url':'data:image/png;base64,PRIVATE_IMAGE_BYTES'}}])
    with sqlite3.connect(c.home/'state.db') as db:
        db.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT);INSERT INTO sessions VALUES('s');")
        db.execute("INSERT INTO messages VALUES(1,'s','user',?)",(structured,))
    first=c.history('default','s')['messages'][0]
    later=c.history('default','s',message_id=1,offset=16000)
    assert first['content']=='😀'*16000 and first['truncated']
    assert later['content'].startswith('😀'*1000) and 'Attachment retained' in later['content']
    assert not later['truncated'] and 'PRIVATE_IMAGE_BYTES' not in later['content']


@pytest.mark.asyncio
async def test_imported_update_history_is_browseable_but_never_resumed(tmp_path):
    import sqlite3
    c=connector(tmp_path);c.rpc=AsyncMock()
    source='a'*24;checksum='b'*10
    folder=c.home/'studio/imports'/source/'default';folder.mkdir(parents=True)
    with sqlite3.connect(folder/('state.db.'+checksum+'.incoming')) as db:
        db.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT);INSERT INTO sessions VALUES('s');INSERT INTO messages VALUES(1,'s','user','Mac update');")
    entry=c.imported_histories('default')[0]
    result=await c.operation('sessions.open',{'agentId':'default','sessionId':entry['id']},'id')
    assert result['readOnly'] and not result['runtimeId']
    assert result['messages'][0]['content']=='Mac update'
    c.rpc.assert_not_awaited()


@pytest.mark.asyncio
async def test_archived_history_pages_across_multiple_preserved_updates(tmp_path):
    import sqlite3
    c=connector(tmp_path)
    folder=c.home/'studio/imports'/('a'*24)/'default';folder.mkdir(parents=True)
    for checksum in ['b'*10,'c'*10]:
        with sqlite3.connect(folder/('state.db.'+checksum+'.incoming')) as db:
            db.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY)')
            db.executemany('INSERT INTO sessions VALUES(?)',[(f's{i}',) for i in range(45)])
    first=await c.operation('sessions.archives',{'agentId':'default'},'one')
    second=await c.operation('sessions.archives',{'agentId':'default','offset':first['nextArchiveOffset']},'two')
    assert len(first['sessions'])==60 and len(second['sessions'])==30
    assert second['nextArchiveOffset'] is None
    assert len({s['id'] for s in first['sessions']+second['sessions']})==90


@pytest.mark.asyncio
async def test_empty_timeout_cannot_be_misreported_as_a_success(tmp_path):
    c=connector(tmp_path);c.operation=AsyncMock(side_effect=TimeoutError());c.cloud_send=AsyncMock()
    await c.request({'id':'transport','requestId':'timeout','method':'providers.keys','params':{'agentId':'default'}})
    assert 'did not respond in time' in c.cloud_send.call_args.args[0]['error']


@pytest.mark.asyncio
async def test_connection_reconciliation_checks_expired_history_in_original_profile_without_prompt(tmp_path):
    import sqlite3
    c = connector(tmp_path)
    other = c.home / 'profiles/other';other.mkdir(parents=True);(other / 'config.yaml').write_text('model: test')
    for folder in [c.home, other]:
        with sqlite3.connect(folder / 'state.db') as db:
            db.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY)')
    with sqlite3.connect(c.home / 'state.db') as db: db.execute("INSERT INTO sessions VALUES('saved')")
    c.ledger.bind('expired', 'default', 'saved')
    c.rpc = AsyncMock(side_effect=[{'transportRecovery': True}, {'recovered': []}])
    result = await c.operation('connection.reconcile', {}, 'check')
    assert result['reconciled'] is True
    assert [call.args[0] for call in c.rpc.call_args_list] == ['studio.capabilities', 'studio.sessions.recover']
    c.ledger.bind('other-expired', 'other', 'saved')
    c.ledger.begin('other-request', 'chat.send', {'runtimeId':'other-expired'})
    c.ledger.finish('other-request', {'taskId':'missing-task'})
    c.rpc = AsyncMock(side_effect=[{'transportRecovery': True}, {'recovered': []}])
    result = await c.operation('connection.reconcile', {}, 'check')
    assert result['reconciled'] is False and result['needsReview'] == 1


@pytest.mark.asyncio
async def test_unused_sessions_and_verified_legacy_delivery_histories_do_not_break_connection(tmp_path):
    import sqlite3
    c = connector(tmp_path)
    c.ledger.bind('unused', 'default', 'never-persisted')
    c.ledger.bind('legacy', 'default', 'legacy-ui-session')
    c.ledger.begin('legacy-send', 'chat.send', {'runtimeId':'legacy'})
    c.ledger.finish('legacy-send', {'taskId':'legacy-task'})
    with sqlite3.connect(c.home / 'state.db') as db:
        db.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY)')
        db.execute("INSERT INTO sessions VALUES('actual-history')")
    folder = c.home / 'studio-cloud/runtime';folder.mkdir(parents=True)
    with sqlite3.connect(folder / 'workspace.sqlite3') as db:
        db.execute('CREATE TABLE deliveries(id TEXT,recipient TEXT,state TEXT,stored_id TEXT)')
        db.execute("INSERT INTO deliveries VALUES('legacy-task','default','complete','actual-history')")
    c.rpc = AsyncMock(side_effect=[{'transportRecovery': True}, {'recovered': []}])
    result = await c.operation('connection.reconcile', {}, 'check')
    assert result['reconciled'] is True
    assert result['unused'] == result['legacyHistoriesVerified'] == 1
    with sqlite3.connect(folder / 'workspace.sqlite3') as db:
        db.execute("UPDATE deliveries SET recipient='another-profile'")
    c.rpc = AsyncMock(side_effect=[{'transportRecovery': True}, {'recovered': []}])
    result = await c.operation('connection.reconcile', {}, 'check')
    assert result['reconciled'] is False and result['needsReview'] == 1
