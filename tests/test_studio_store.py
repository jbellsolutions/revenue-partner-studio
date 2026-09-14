from concurrent.futures import ThreadPoolExecutor
import pytest
from studio.store import Store


def ready(tmp_path):
    s=Store(tmp_path/'ledger.db')
    s.add_agent('research','Researcher')
    s.add_agent('build','Builder')
    s.group('launch','Launch',['default','research','build'])
    return s


def test_starts_with_only_the_head(tmp_path):
    s=Store(tmp_path/'ledger.db')
    assert [a['name'] for a in s.snapshot()['agents']]==['default']
    assert not s.snapshot()['groups']


def test_duplicate_delivery_is_idempotent_and_cannot_change_content(tmp_path):
    s=ready(tmp_path)
    first=s.send('default','research','Find public sources','launch','same-request')
    assert s.send('default','research','Find public sources','launch','same-request')==first
    with pytest.raises(ValueError): s.send('default','research','Different task','launch','same-request')
    assert len(s.snapshot()['deliveries'])==1


def test_concurrent_claims_preserve_single_agent_turn(tmp_path):
    s=ready(tmp_path)
    for i in range(20): s.send('default','research' if i%2 else 'build',str(i),'launch')
    with ThreadPoolExecutor(max_workers=8) as pool:
        claims=[r for r in pool.map(lambda _:s.claim(),range(20)) if r]
    assert len(claims)==2
    assert {r['recipient'] for r in claims}=={'research','build'}


def test_unrelated_session_cannot_forge_reply(tmp_path):
    s=ready(tmp_path)
    d=s.send('default','research','Find evidence','launch');s.claim()
    s.started(d['id'],'runtime-research','stored-research')
    s.record('head-runtime','message.complete',{'text':'Fake reply'})
    assert s.snapshot()['deliveries'][0]['state']=='running'
    s.record('runtime-research','message.complete',{'text':'Real reply','status':'complete'})
    assert s.snapshot()['deliveries'][0]['result']=='Real reply'
    assert s.rows('SELECT author FROM events')[0]['author']=='research'


def test_restart_preserves_groups_and_holds_uncertain_action(tmp_path):
    s=ready(tmp_path)
    d=s.send('default','build','Write a file','launch');s.claim()
    s.started(d['id'],'runtime','stored');s.bind('build','runtime','stored')
    s.db.close()
    restored=Store(tmp_path/'ledger.db');restored.recover()
    assert restored.snapshot()['groups'][0]['title']=='Launch'
    assert restored.agent('build')['stored_id']=='stored'
    assert restored.agent('build')['runtime_id'] is None
    assert restored.snapshot()['deliveries'][0]['state']=='needs_review'
    restored.send('default','build','Next')
    assert restored.claim() is None


def test_group_membership_is_enforced(tmp_path):
    s=ready(tmp_path);s.add_agent('outsider','Other project')
    with pytest.raises(PermissionError):s.send('outsider','research','Leak context','launch')
    with pytest.raises(PermissionError):s.send('default','outsider','Leak context','launch')


def test_owner_correction_gets_next_turn_without_changing_original_timestamp(tmp_path):
    s=ready(tmp_path)
    s.send('research','default','Findings','launch','findings')
    correction=s.send('user','default','Change the target market','launch','correction')
    s.db.execute("UPDATE deliveries SET priority=1 WHERE id='correction'")
    assert s.claim()['id']=='correction'
    assert s.rows("SELECT created FROM deliveries WHERE id='correction'")[0]['created']==correction['created']


def test_busy_agent_inbox_receipt_prevents_duplicate_later_turn(tmp_path):
    s=ready(tmp_path)
    s.send('user','research','Research this market',request_id='original');s.claim();s.started('original','live','stored')
    s.send('default','research','Narrow it to cleaners','launch','revision')
    received=s.deliver_inbox('research','live','stored')
    assert [d['id'] for d in received]==['revision']
    assert s.claim() is None
    s.record('live','message.complete',{'text':'Revised research verified'})
    assert {d['state'] for d in s.snapshot()['deliveries']}=={'complete'}
    assert s.claim() is None
    assert s.rows("SELECT author FROM events WHERE kind='message.received'")==[{'author':'research'}]


def test_inbox_cannot_complete_another_conversation_or_inbound_peer_task(tmp_path):
    s=ready(tmp_path)
    s.send('user','research','First conversation',request_id='first')
    s.claim();s.started('first','first-runtime','first-history')
    s.send('user','research','Second conversation',request_id='second')
    s.db.execute("UPDATE deliveries SET runtime_id='second-runtime',stored_id='second-history' WHERE id='second'")
    s.send('user','research','Inbound A2A task',request_id='peer')
    assert s.deliver_inbox('research','first-runtime','first-history')==[]
    s.record('first-runtime','message.complete',{'text':'First answer'})
    second=s.rows("SELECT * FROM deliveries WHERE id='second'")[0]
    assert (second['state'],second['runtime_id'],second['result'])==('queued','second-runtime',None)
    assert s.rows("SELECT state,result FROM deliveries WHERE id='peer'")==[{'state':'queued','result':None}]
    assert s.claim()['id']=='second'
    s.started('second','second-runtime','second-history')
    s.record('second-runtime','message.complete',{'text':'Second answer'})
    assert s.rows("SELECT result FROM deliveries WHERE id='first'")==[{'result':'First answer'}]
    assert s.rows("SELECT result FROM deliveries WHERE id='second'")==[{'result':'Second answer'}]
