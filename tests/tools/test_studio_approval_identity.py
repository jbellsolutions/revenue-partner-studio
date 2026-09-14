import pytest
import tools.approval as a


def test_stale_click_does_not_approve_next_command():
    key='studio-stale'
    first=a._ApprovalEntry({'command':'first'})
    second=a._ApprovalEntry({'command':'second'})
    a._gateway_queues[key]=[first,second]
    try:
        assert a.resolve_gateway_approval(key,'deny',request_id=first.data['request_id'])==1
        assert a.resolve_gateway_approval(key,'once',request_id=first.data['request_id'])==0
        assert not second.event.is_set()
    finally:a._gateway_queues.pop(key,None)


def test_request_target_and_remote_permission_are_enforced():
    key='studio-policy'
    entry=a._ApprovalEntry({'allow_permanent':False,'command':'controlled'})
    a._gateway_queues[key]=[entry]
    try:
        with pytest.raises(ValueError):a.resolve_gateway_approval(key,'always',request_id=entry.data['request_id'])
        with pytest.raises(ValueError):a.resolve_gateway_approval(key,'garbage')
        assert not entry.event.is_set()
        assert a.resolve_gateway_approval(key,'once',request_id=entry.data['request_id'])==1
    finally:a._gateway_queues.pop(key,None)


def test_reconnect_returns_only_live_requests():
    key='studio-reconnect'
    live=a._ApprovalEntry({'command':'live'})
    old=a._ApprovalEntry({'command':'already answered'});old.event.set()
    a._gateway_queues[key]=[old,live]
    try:
        records=a.pending_gateway_approvals(key)
        assert [r['request_id'] for r in records]==[live.data['request_id']]
        records[0]['command']='tampered'
        assert live.data['command']=='live'
        a.resolve_gateway_approval(key,'deny',request_id=live.data['request_id'])
        assert a.pending_gateway_approvals(key)==[]
    finally:a._gateway_queues.pop(key,None)


def test_expiration_never_creates_later_approval(monkeypatch):
    monkeypatch.setattr(a, '_get_approval_timeout', lambda: 0)
    notified=[]
    outcome=a._await_gateway_decision('studio-expired',notified.append,{'command':'test'})
    assert not outcome['resolved']
    assert a.pending_gateway_approvals('studio-expired')==[]
    assert a.resolve_gateway_approval('studio-expired','once',request_id=notified[0]['request_id'])==0
