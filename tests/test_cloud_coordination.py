import json
from pathlib import Path
from types import SimpleNamespace
import pytest
import yaml
from studio.service import Service
from studio.cloud_a2a import dispatch
from studio.cloud_peer import database, operation
from plugins.platforms.a2a import protocol

A='10000000-0000-4000-8000-000000000001'
B='10000000-0000-4000-8000-000000000002'


def make_service(tmp_path):
    (tmp_path/'config.yaml').write_text('model: test\n')
    return Service(SimpleNamespace(_sessions={}),tmp_path)


def test_owner_peer_handoff_uses_selected_source_profile_and_cannot_be_spoofed_by_agents(tmp_path):
    service=make_service(tmp_path)
    child=tmp_path/'profiles/email';child.mkdir(parents=True);(child/'config.yaml').write_text('model: test\n')
    p={'operation':'owner_peer_send','agentId':'email','target_computer':B,'target_agent':'default','message':'A controlled handoff','request_id':'selected-source'}
    service.operation('user',p)
    db=database(tmp_path)
    assert db.execute('SELECT actor FROM outbox WHERE id=?',('selected-source',)).fetchone()['actor']=='email'
    db.close()
    with pytest.raises(PermissionError):service.operation('default',p)

def test_native_approval_api_preserves_all_pending_approvals(tmp_path,monkeypatch):
    from tools import approval
    service=make_service(tmp_path);service.store.bind('default','runtime','stored')
    monkeypatch.delattr(approval,'pending_gateway_approvals',raising=False)
    monkeypatch.setattr(approval,'list_gateway_approvals',lambda key:[{'request_id':'first','command':'echo first'},{'request_id':'second','command':'echo second'}],raising=False)
    assert [a['request_id'] for a in service.snapshot()['approvals']]==['first','second']


def incoming(source=A,message_id='stable-message',text='Research this topic',hops=1):
    message=protocol.text_message(protocol.ROLE_USER,text);message['messageId']=message_id
    return {'sourceComputerId':source,'agentId':'default','hops':hops,
            'envelope':{'jsonrpc':'2.0','id':'wire-id','method':'message/send','params':{'message':message}}}


def test_a2a_acknowledges_durably_without_executing_a_model_and_reuses_task(tmp_path):
    s=make_service(tmp_path)
    first=dispatch(s,incoming());second=dispatch(s,incoming())
    task=first['result']['task'];assert second['result']['task']['id']==task['id']
    assert task['status']['state']==protocol.STATE_SUBMITTED
    assert len(s.store.rows('SELECT * FROM deliveries'))==1
    with pytest.raises(ValueError,match='another task'):dispatch(s,incoming(text='different task'))


def test_a2a_task_result_is_scoped_to_authenticated_source_and_target(tmp_path):
    s=make_service(tmp_path);task=dispatch(s,incoming())['result']['task'];s.store.state(task['id'],'complete','Result')
    request={'sourceComputerId':A,'agentId':'default','envelope':{'id':'query','method':'tasks/get','params':{'id':task['id']}}}
    assert dispatch(s,request)['result']['status']['state']==protocol.STATE_COMPLETED
    assert dispatch(s,{**request,'sourceComputerId':B})['error']['code']==protocol.ERR_TASK_NOT_FOUND


def test_hops_are_inherited_from_active_inbound_task_not_model_supplied_values(tmp_path):
    s=make_service(tmp_path);task=dispatch(s,incoming(hops=5))['result']['task']
    s.store.claim();s.store.started(task['id'],'r','stored')
    with pytest.raises(ValueError,match='hop limit'):
        operation(s,'default',{'operation':'peer_send','message':'Forward','target_computer':B,'target_agent':'default','hops':0})
    with pytest.raises(ValueError,match='hop limit'):dispatch(s,incoming(message_id='another',hops=6))


def test_peer_outbox_keeps_stable_identity_and_sender(tmp_path):
    s=make_service(tmp_path);p={'operation':'peer_send','request_id':'id','message':'Work','target_computer':B,'target_agent':'default'}
    a=operation(s,'default',p);assert operation(s,'default',p)==a
    with pytest.raises(ValueError,match='another peer task'):operation(s,'default',{**p,'message':'other'})
    db=database(tmp_path);assert db.execute('SELECT count(*) FROM outbox').fetchone()[0]==1;db.close()


def test_browser_chat_is_durable_before_dispatch_and_preserves_conversation(tmp_path):
    s=make_service(tmp_path);s.server._sessions['runtime']={'session_key':'conversation','profile_home':tmp_path}
    p={'operation':'submit_chat','runtime_id':'runtime','recipient':'default','message':'Work','request_id':'request'}
    assert s.operation('user',p)['accepted']
    row=s.store.rows('SELECT * FROM deliveries')[0]
    assert row['runtime_id']=='runtime' and row['stored_id']=='conversation' and row['state']=='queued'
    s.operation('user',p);assert len(s.store.rows('SELECT * FROM deliveries'))==1
    with pytest.raises(ValueError,match='mismatch'):s.operation('user',{**p,'recipient':'other'})


def test_import_barrier_preserves_fast_durable_acceptance(tmp_path):
    s=make_service(tmp_path);s.importing=True
    s.server._sessions['r']={'session_key':'s','profile_home':tmp_path}
    result=s.operation('user',{'operation':'submit_chat','runtime_id':'r','recipient':'default',
        'message':'Wait for import','request_id':'during-import'})
    assert result['accepted'] and result['state']=='queued'
    assert s.importing


def test_preexisting_profiles_are_adopted_without_replacement(tmp_path):
    path=tmp_path/'profiles/email';path.mkdir(parents=True);(path/'config.yaml').write_text('model: existing')
    s=make_service(tmp_path);assert s.store.agent('email')['name']=='email'
    assert (path/'config.yaml').read_text()=='model: existing'


def test_same_stored_conversation_id_is_not_reused_across_profiles(tmp_path,monkeypatch):
    from tui_gateway import server
    a=tmp_path/'a';b=tmp_path/'b'
    monkeypatch.setattr(server,'_sessions',{'a':{'session_key':'shared','profile_home':a},'b':{'session_key':'shared','profile_home':b}})
    assert server._find_live_session_by_key('shared',profile_home=a)[0]=='a'
    assert server._find_live_session_by_key('shared',profile_home=b)[0]=='b'


def test_studio_runtime_never_uses_a_fallback_billing_path(monkeypatch):
    from tui_gateway import server
    monkeypatch.setenv('HERMES_STUDIO_RUNTIME','1')
    monkeypatch.setattr(server,'_load_cfg',lambda: {'fallback_providers':[{'provider':'paid','model':'paid-model'}]})
    assert server._load_fallback_model()==[]


def test_cancelling_a_queued_chat_prevents_later_claim(tmp_path):
    s=make_service(tmp_path);s.server._sessions['runtime']={'session_key':'conversation','profile_home':tmp_path}
    s.operation('user',{'operation':'submit_chat','runtime_id':'runtime','recipient':'default','message':'Work','request_id':'cancel-me'})
    s.rpc=lambda method,params: {'interrupted':True}
    s.operation('user',{'operation':'cancel_chat','runtime_id':'runtime'})
    assert s.store.claim() is None
    assert s.store.rows('SELECT state FROM deliveries')[0]['state']=='cancelled'


def test_text_work_dispatches_when_all_desktop_screens_are_occupied(tmp_path,monkeypatch):
    from hermes_cli import orgo_screens
    s=make_service(tmp_path)
    (tmp_path/'config.yaml').write_text('mcp_servers:\n  orgo-screen: {}\n')
    s.server._sessions['r']={'running':False};s.store.bind('default','r','stored')
    s.store.send('user','default','Create a harmless text file',request_id='file-work')
    def no_screen(*args,**kwargs):raise RuntimeError('All four screens are assigned')
    monkeypatch.setattr(orgo_screens,'ensure',no_screen)
    calls=[];s.rpc=lambda method,params:calls.append((method,params)) or {}
    class OneIteration:
        count=0
        def wait(self,timeout):
            self.count+=1
            return self.count>1
    s.stopped=OneIteration();s.dispatch()
    assert calls[0][0]=='prompt.submit'
    assert s.store.rows('SELECT state FROM deliveries')[0]['state']=='running'


def test_ten_accepted_tasks_start_four_turns_and_keep_six_durably_queued(tmp_path):
    s=make_service(tmp_path)
    for number in range(10):
        name=f'agent-{number}'
        path=tmp_path/'profiles'/name;path.mkdir(parents=True)
        (path/'config.yaml').write_text('model: test\n')
        s.store.add_agent(name,f'Agent {number}')
        s.store.send('user',name,f'Task {number}',request_id=f'task-{number}')
    sequence={'value':0}
    def rpc(method,params):
        if method=='session.create':
            sequence['value']+=1;runtime=f'runtime-{sequence["value"]}'
            s.server._sessions[runtime]={'running':False,'session_key':f'history-{runtime}','profile_home':tmp_path}
            return {'session_id':runtime,'stored_session_id':f'history-{runtime}'}
        if method=='prompt.submit':
            s.server._sessions[params['session_id']]['running']=True
        return {}
    s.rpc=rpc
    class TwentyIterations:
        count=0
        def wait(self,timeout):
            self.count+=1
            return self.count>20
    s.stopped=TwentyIterations();s.dispatch()
    states={row['state']:row['count'] for row in s.store.rows('SELECT state,count(*) AS count FROM deliveries GROUP BY state')}
    assert states=={'queued':6,'running':4}
    assert s.active_turns()==4


def test_legacy_hermes_cli_bundle_grants_real_specialist_tools():
    from studio.service import specialist_toolsets
    grants=specialist_toolsets({'toolsets':['hermes-cli']})
    assert {'terminal','file','web','skills','memory','orgo-screen','studio'}.issubset(grants)
    restricted=specialist_toolsets({'tools':{'enabled_toolsets':['file']}})
    assert set(restricted)=={'file','studio'}
    disabled=specialist_toolsets({'toolsets':['hermes-cli'],'agent':{'disabled_toolsets':['browser','terminal']}})
    assert 'orgo-screen' not in disabled and 'terminal' not in disabled


def test_cloud_surface_exposes_coordination_without_electron_only_tools():
    from tui_gateway.server import _gui_surface_toolsets
    assert _gui_surface_toolsets('studio')=={'studio'}
    assert 'desktop_ui' in _gui_surface_toolsets('desktop')


def test_recovery_dispatch_uses_original_conversation_instead_of_latest_agent_session(tmp_path):
    s=make_service(tmp_path)
    s.server._sessions['other']={'running':False,'session_key':'other-history'}
    s.store.bind('default','other','other-history')
    s.store.send('user','default','Recover after inspection',request_id='recover')
    s.store.db.execute("UPDATE deliveries SET stored_id='original-history' WHERE id='recover'")
    calls=[]
    def rpc(method,params):
        calls.append((method,params))
        if method=='session.resume':
            s.server._sessions['restored']={'running':False,'session_key':'original-history'}
            return {'session_id':'restored','stored_session_id':'original-history'}
        return {}
    s.rpc=rpc
    class Once:
        count=0
        def wait(self,timeout):
            self.count+=1
            return self.count>1
    s.stopped=Once();s.dispatch()
    assert calls[0]==('session.resume',{'profile':'default','source':'desktop','close_on_disconnect':False,'cwd':str(Path.home()/'studio-projects'),'title':'Head of Operations','session_id':'original-history','omit_messages':True})
    assert calls[-1][1]['session_id']=='restored'
    assert s.store.agent('default')['stored_id']=='original-history'


def test_direct_chat_binds_approvals_and_inbox_to_its_current_conversation(tmp_path):
    s=make_service(tmp_path)
    s.server._sessions['new']={'running':False,'session_key':'new-history','profile_home':tmp_path}
    s.store.bind('default','old','old-history')
    s.operation('user',{'operation':'submit_chat','runtime_id':'new','recipient':'default','message':'New task','request_id':'new-task'})
    s.rpc=lambda method,params:{}
    class Once:
        count=0
        def wait(self,timeout):
            self.count+=1
            return self.count>1
    s.stopped=Once();s.dispatch()
    assert s.store.agent('default')['runtime_id']=='new'
    assert s.store.agent('default')['stored_id']=='new-history'


def test_peer_result_and_recovery_cannot_reset_the_delegation_hop_limit(tmp_path):
    s=make_service(tmp_path);s.store.add_agent('writer','Writer')
    with database(s.home) as db:
        db.execute("INSERT INTO outbox VALUES('sent','default',?,'qa','Task',5,'complete',NULL,NULL,1,0)",(B,))
    s.store.send('user','default','Returned result',request_id='peer-result-sent:recovery')
    s.store.claim();s.store.started('peer-result-sent:recovery','runtime','stored')
    with pytest.raises(ValueError,match='hop limit'):
        operation(s,'default',{'operation':'peer_send','target_computer':B,'target_agent':'qa','message':'Repeat review'})
    with pytest.raises(ValueError,match='hop limit'):
        s.operation('default',{'operation':'send','recipient':'writer','message':'Forward locally'})


def test_local_forwarding_preserves_peer_depth_and_stable_receipts(tmp_path):
    s=make_service(tmp_path);s.store.add_agent('writer','Writer')
    task=dispatch(s,incoming(hops=4))['result']['task']
    s.store.claim();s.store.started(task['id'],'runtime','stored')
    p={'operation':'send','recipient':'writer','message':'Finish this step','request_id':'local-forward'}
    first=s.operation('default',p)
    assert s.operation('default',p)['id']==first['id']
    s.store.state(task['id'],'complete','Forwarded')
    s.store.claim();s.store.started('local-forward','writer-runtime','writer-history')
    with pytest.raises(ValueError,match='hop limit'):
        operation(s,'writer',{'operation':'peer_send','target_computer':B,'target_agent':'qa','message':'One more handoff'})
