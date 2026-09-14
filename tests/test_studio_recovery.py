from types import SimpleNamespace
import pytest
from studio.store import Store
from studio import recovery


def test_recovery_requires_unchanged_inspection_and_preserves_original(tmp_path):
    s=Store(tmp_path/'ledger.db')
    s.send('user','default','Build a prototype',request_id='task');s.claim()
    s.started('task','runtime','persisted');s.recover()
    service=SimpleNamespace(store=s,home=tmp_path)
    inspected=recovery.inspect(service,'task')
    with pytest.raises(ValueError,match='inspect'):
        recovery.resume(service,'task','not-inspected')
    result=recovery.resume(service,'task',inspected['inspection_token'])
    assert result['id']=='task:recovery'
    assert result['stored_id']=='persisted' and result['runtime_id'] is None
    assert 'FIRST inspect' in result['body']
    assert s.rows("SELECT state FROM deliveries WHERE id='task'")[0]['state']=='cancelled'
    assert s.claim()['id']=='task:recovery'
    assert recovery.resume(service,'task',inspected['inspection_token'])['id']==result['id']
    assert len(s.rows('SELECT * FROM deliveries'))==2
    with pytest.raises(ValueError,match='inspect'):
        recovery.resume(service,'task','different-review')


def test_late_evidence_invalidates_recovery_authorization(tmp_path):
    s=Store(tmp_path/'ledger.db');s.send('user','default','Work',request_id='task');s.claim();s.recover()
    service=SimpleNamespace(store=s,home=tmp_path)
    inspected=recovery.inspect(service,'task')
    s.state('task','needs_review','New evidence arrived')
    with pytest.raises(ValueError,match='changed'):
        recovery.resume(service,'task',inspected['inspection_token'])
