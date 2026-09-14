import json
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from studio.local_runtime import protect_dispatch
from studio.session_recovery import inspect_session, bind_session, recover_sessions
from studio.cloud_settings import operation, apply_pending
from tests.test_cloud_coordination import make_service


def test_mac_extension_slow_work_does_not_use_connection_reader():
    native = SimpleNamespace(_LONG_HANDLERS=frozenset({'native.operation'}))
    protect_dispatch(native)
    assert {'studio.operation', 'studio.snapshot', 'studio.a2a', 'session.create'} <= native._LONG_HANDLERS
    assert 'native.operation' in native._LONG_HANDLERS
    assert 'approval.respond' not in native._LONG_HANDLERS
    with pytest.raises(RuntimeError, match='dispatch'): protect_dispatch(SimpleNamespace())


def test_resume_reuses_only_the_owning_profile_and_retains_history(tmp_path):
    service = make_service(tmp_path)
    child=tmp_path/'profiles'/'assistant';child.mkdir(parents=True);(child/'config.yaml').write_text('model: test')
    a={'profile_home':tmp_path,'session_key':'same','history':['existing'],'running':True}
    b={'profile_home':child,'session_key':'same','history':['other']}
    service.server._sessions={'a':a,'b':b}
    service.rpc=Mock(return_value={})
    assert inspect_session(service,{'agentId':'assistant','sessionId':'same'})['runtimeId']=='b'
    bind_session(service,{'agentId':'assistant','runtimeId':'b','conversationId':'draft'})
    service.rpc.assert_called_once_with('session.activate', {'session_id':'b','omit_messages':True})
    assert inspect_session(service,{'agentId':'assistant','conversationId':'draft'})['runtimeId']=='b'
    assert inspect_session(service,{'agentId':'default','conversationId':'draft'})['runtimeId'] is None
    with pytest.raises(ValueError):bind_session(service,{'agentId':'default','runtimeId':'b','conversationId':'draft'})
    assert a['history']==['existing'] and b['history']==['other']


def test_transport_recovery_reattaches_only_live_matching_profiles_without_submitting_work(tmp_path):
    service=make_service(tmp_path)
    child=tmp_path/'profiles'/'assistant';child.mkdir(parents=True);(child/'config.yaml').write_text('model: test')
    service.server._sessions={'live':{'profile_home':child,'history':['keep'],'running':True}}
    service.rpc=Mock(return_value={})
    result=recover_sessions(service,{'sessions':[{'runtime':'live','agent':'default'},
        {'runtime':'missing','agent':'assistant'},{'runtime':'live','agent':'deleted'}, {'runtime':'live','agent':'assistant'}]})
    assert result=={'recovered':['live']}
    service.rpc.assert_called_once_with('session.activate',{'session_id':'live','omit_messages':True})
    assert service.server._sessions['live']['running'] and service.server._sessions['live']['history']==['keep']


def test_profile_settings_native_save_is_scoped_preserves_secrets_and_rejects_stale_busy(tmp_path, monkeypatch):
    import yaml
    service=make_service(tmp_path)
    child=tmp_path/'profiles'/'assistant';child.mkdir(parents=True)
    (child/'config.yaml').write_text('agent:\n  max_turns: 20\nmodel:\n  default: keep-model\n  api_key: PRIVATE\ncustom: keep\n')
    original=(tmp_path/'config.yaml').read_bytes()
    service.server._sessions={'child':{'profile_home':child,'history':['keep']},'root':{'profile_home':tmp_path}}
    before=operation(service,{'operation':'profile_settings_get','agentId':'assistant'})
    assert 'PRIVATE' not in json.dumps(before)
    patch={'operation':'profile_settings_update','agentId':'assistant','version':before['version'],'changes':{'agent.max_turns':25}}
    result=operation(service,patch)
    saved=yaml.safe_load((child/'config.yaml').read_text())
    assert saved['agent']['max_turns']==25 and saved['model']['api_key']=='PRIVATE' and saved['custom']=='keep'
    assert (tmp_path/'config.yaml').read_bytes()==original
    assert service.server._sessions['child']['history']==['keep']
    assert 'studio_settings_changed' not in service.server._sessions['root']
    with pytest.raises(ValueError,match='changed'):operation(service,patch)
    service.server._sessions['child']['running']=True
    with pytest.raises(ValueError,match='finish'):operation(service,{**patch,'version':result['version']})


def test_pending_settings_never_reset_the_conversation(tmp_path):
    service=make_service(tmp_path)
    agent=SimpleNamespace(_invalidate_system_prompt=Mock(),max_iterations=10)
    session={'agent':agent,'history':['keep'],'model_override':{'model':'chosen'},'studio_settings_changed':{'agent.max_turns':30}}
    apply_pending(service,'runtime',session)
    assert session['history']==['keep'] and session['model_override']=={'model':'chosen'}
    assert agent.max_iterations==30 and 'studio_settings_changed' not in session
