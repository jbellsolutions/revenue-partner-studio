from types import SimpleNamespace
from studio.service import Service
import pytest


def test_agent_status_is_bounded_but_explicit_reads_and_owner_keep_full_text(tmp_path):
    service=Service(SimpleNamespace(_sessions={}),tmp_path)
    service.store.add_agent('source-agent','Source agent')
    for i in range(50):service.store.send('source-agent','default','x'*10000,request_id=str(i))
    status=service.operation('default',{'operation':'status'})
    assert len(status['deliveries'])==20
    assert all(len(d['body'])<=801 and d['details_truncated'] for d in status['deliveries'])
    assert len(service.operation('default',{'operation':'status','request_id':'0'})['delivery']['body'])==10000
    assert len(service.operation('user',{'operation':'status'})['deliveries'])==50
    service.store.add_agent('writer','Writer')
    with pytest.raises(PermissionError):service.operation('writer',{'operation':'status','request_id':'0'})


def test_inbox_receipts_are_not_lost_behind_recent_unrelated_messages(tmp_path):
    service=Service(SimpleNamespace(_sessions={'live':{'running':True}}),tmp_path)
    service.store.bind('default','live','stored')
    service.store.add_agent('writer','Writer')
    service.store.send('writer','default','Old queued teammate finding',request_id='important')
    for i in range(30):service.store.send('default','writer','Newer outgoing message',request_id=str(i))
    status=service.operation('default',{'operation':'status'})
    assert status['newly_received']==['important']
    received=next(d for d in status['deliveries'] if d['id']=='important')
    assert received['state']=='running' and received['body']=='Old queued teammate finding'


def test_direct_conversation_is_not_previewed_or_received_by_an_older_turn(tmp_path):
    service=Service(SimpleNamespace(_sessions={'old':{'running':True}}),tmp_path)
    service.store.bind('default','old','old-history')
    service.store.send('user','default','Separate conversation',request_id='new-chat')
    service.store.db.execute("UPDATE deliveries SET runtime_id='new',stored_id='new-history' WHERE id='new-chat'")
    status=service.operation('default',{'operation':'status'})
    assert status['newly_received']==[] and status['deliveries']==[]
    owner=service.operation('user',{'operation':'status'})
    assert owner['deliveries'][0]['body']=='Separate conversation'
    assert owner['deliveries'][0]['state']=='queued'
    assert owner['deliveries'][0]['runtime_id']=='new'
