from types import SimpleNamespace
import pytest
from studio.cloud_models import operation, apply
from tests.test_cloud_coordination import make_service


def conversation(service, home, runtime='r', stored='history'):
    service.server._sessions[runtime] = {'profile_home':home, 'session_key':stored,
        'running':False, 'agent':SimpleNamespace(model='old', provider='openrouter'),
        'messages':[{'role':'user','content':'keep this history'}]}
    return service.server._sessions[runtime]


def test_switch_is_session_only_preserves_history_and_waits_until_idle(tmp_path):
    service=make_service(tmp_path); session=conversation(service,tmp_path)
    calls=[];service.rpc=lambda method,params: calls.append((method,params)) or {}
    p={'operation':'model_select','agentId':'default','runtimeId':'r','provider':'openrouter','model':'vendor/model'}
    session['running']=True
    assert operation(service,p)['state']=='pending'
    assert not calls
    session['running']=False
    assert apply(service,p)['state']=='applied'
    assert calls[0][0]=='config.set' and calls[0][1]['session_id']=='r'
    assert calls[0][1]['value']=='vendor/model --provider openrouter --session'
    assert session['messages']==[{'role':'user','content':'keep this history'}]
    assert (tmp_path/'config.yaml').read_text()=='model: test\n'


def test_failed_switch_blocks_next_turn_and_survives_session_resume(tmp_path):
    service=make_service(tmp_path);conversation(service,tmp_path)
    service.rpc=lambda *a,**k: (_ for _ in ()).throw(RuntimeError('private-key in provider failure'))
    p={'operation':'model_select','agentId':'default','runtimeId':'r','provider':'openrouter','model':'vendor/missing'}
    with pytest.raises(ValueError,match='could not be activated'):operation(service,p)
    conversation(service,tmp_path,'resumed','history')
    with pytest.raises(ValueError,match='could not be activated'):apply(service,{**p,'runtimeId':'resumed'})
    assert 'private-key' not in ''.join(f.read_text() for f in (tmp_path/'studio/model-selections').glob('*.json'))
    service.rpc=lambda *a,**k: {}
    assert operation(service,{**p,'model':'vendor/working','runtimeId':'resumed'})['state']=='applied'


def test_switch_cannot_target_sibling_or_inject_model_flags(tmp_path):
    service=make_service(tmp_path);conversation(service,tmp_path)
    child=tmp_path/'profiles/email';child.mkdir(parents=True);(child/'config.yaml').write_text('model: other')
    p={'operation':'model_select','agentId':'email','runtimeId':'r','provider':'openrouter','model':'x'}
    with pytest.raises(ValueError,match='selected agent'):operation(service,p)
    with pytest.raises(ValueError,match='model ID'):operation(service,{**p,'agentId':'default','model':'x --global'})
