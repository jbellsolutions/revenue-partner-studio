import asyncio
import json
from types import SimpleNamespace
import pytest
from studio import screen_bridge as bridge


def test_multiplexed_agents_never_share_screen_connection(monkeypatch):
    from studio import service
    from tools import mcp_tool
    from hermes_cli import orgo_screens
    monkeypatch.setattr(orgo_screens,'verify_binding',lambda:'11111111-1111-4111-8111-111111111111')
    actor=['researcher']
    calls=[];created=[]
    monkeypatch.setattr(service,'current',lambda:SimpleNamespace(actor=lambda:actor[0]))
    async def connect(name,config):
        profile=config['env']['ORGO_AGENT_PROFILE'];created.append(profile)
        async def call(name,arguments):
            calls.append((profile,name,arguments))
            return SimpleNamespace(isError=False,content=[SimpleNamespace(text='verified')])
        return SimpleNamespace(session=SimpleNamespace(call_tool=call))
    monkeypatch.setattr(mcp_tool,'_connect_server',connect)
    monkeypatch.setattr(mcp_tool,'_run_on_mcp_loop',lambda work,timeout:asyncio.run(work()))
    monkeypatch.setattr(bridge,'_connections',{})
    monkeypatch.setattr(bridge,'_locks',{})
    bridge.call('browser_action',{'operation':'snapshot','profile':'default'})
    actor[0]='builder';bridge.call('browser_action',{'operation':'snapshot'})
    actor[0]='researcher';bridge.call('desktop_action',{'operation':'capture'})
    assert created==['researcher','builder']
    assert [c[0] for c in calls]==['researcher','builder','researcher']


def test_uncertain_screen_action_is_not_replayed(monkeypatch):
    from studio import service
    from tools import mcp_tool
    calls=[]
    monkeypatch.setattr(service,'current',lambda:SimpleNamespace(actor=lambda:'researcher'))
    def failed(work,timeout):
        calls.append('attempt');raise TimeoutError('transport disappeared')
    monkeypatch.setattr(mcp_tool,'_run_on_mcp_loop',failed)
    result=json.loads(bridge.call('desktop_action',{'operation':'click','x':1,'y':1}))
    assert calls==['attempt']
    assert 'uncertain' in result['error']
    assert result['screen_owner']=='researcher'


def test_reassigned_port_discards_old_browser_target_without_closing_it():
    import threading
    from hermes_cli.orgo_screen_mcp import refresh_browser_binding
    stopped=[]
    browser=SimpleNamespace(_stop_cdp_supervisor=stopped.append, _cleanup_lock=threading.Lock(),
                            _active_sessions={'researcher':{'cdp_url':'old-target'},'builder':{'cdp_url':'other'}})
    identity=refresh_browser_binding(browser,'researcher','new-browser-uuid','old-browser-uuid')
    assert identity=='new-browser-uuid'
    assert browser._active_sessions=={'builder':{'cdp_url':'other'}}
    assert stopped==['researcher']
    refresh_browser_binding(browser,'researcher',identity,identity)
    assert stopped==['researcher']
