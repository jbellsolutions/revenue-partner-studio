import json
from pathlib import Path
import runpy
import sqlite3
from types import SimpleNamespace
import pytest


@pytest.fixture
def installation(tmp_path):
    module=runpy.run_path(str(Path(__file__).parents[1]/'distribution/update-extension.py'))
    module['update'].__globals__['verify_runtime'] = lambda cfg: None
    module['update'].__globals__['launch_updates'] = lambda cfg, target: {}
    source=tmp_path/'release';target=tmp_path/'installed';home=tmp_path/'hermes'
    for root in (source,target):
        for name in ['studio/cloud_connector.py','studio/service.py','distribution/local-launch.py']:
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('VERSION = '+repr(root.name))
    base=home/'studio-cloud';base.mkdir(parents=True)
    (base/'local-computer.json').write_text(json.dumps({'computerId':'mac'}))
    state=base/'local-connector';state.mkdir()
    (home/'studio').mkdir()
    task=home/'studio/workspace.sqlite3'
    with sqlite3.connect(task) as db:db.execute('CREATE TABLE deliveries(state TEXT)')
    with sqlite3.connect(state/'connector.sqlite') as db:db.execute('CREATE TABLE requests(id TEXT)')
    cfg=base/'local-connector.json';cfg.write_text(json.dumps({'computerId':'mac','kind':'local','hermesHome':str(home),'sourceDir':str(target),'stateDir':str(state)}))
    return module,source,target,home,cfg,task


def test_update_refuses_pending_work_without_changing_files_or_services(installation,monkeypatch):
    m,source,target,home,cfg,task=installation
    with sqlite3.connect(task) as db:db.execute("INSERT INTO deliveries VALUES('running')")
    monkeypatch.setattr(m['subprocess'],'run',lambda *a,**k:pytest.fail('Must not touch services'))
    assert not m['update'](cfg,source)['ready']
    with pytest.raises(RuntimeError,match='accepted work'):m['update'](cfg,source,True)
    assert (target/'studio/service.py').read_text()=="VERSION = 'installed'"


def test_work_arriving_during_drain_never_stops_runtime(installation,monkeypatch):
    m,source,target,home,cfg,task=installation;calls=[]
    def run(args,**kwargs):
        calls.append(args)
        if 'bootout' in args:
            with sqlite3.connect(task) as db:db.execute("INSERT INTO deliveries VALUES('running')")
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(m['subprocess'],'run',run)
    with pytest.raises(RuntimeError,match='draining'):m['update'](cfg,source,True)
    assert len(calls)==2 and all('runtime' not in ' '.join(c) for c in calls)
    assert (target/'studio/service.py').read_text()=="VERSION = 'installed'"


def test_update_backs_up_source_and_databases_and_preserves_identity(installation,monkeypatch):
    m,source,target,home,cfg,task=installation;original=cfg.read_bytes()
    monkeypatch.setattr(m['subprocess'],'run',lambda *a,**k:SimpleNamespace(returncode=0))
    result=m['update'](cfg,source,True);backup=Path(result['backup'])
    assert (target/'studio/service.py').read_text()=="VERSION = 'release'"
    assert (backup/'source/studio/service.py').read_text()=="VERSION = 'installed'"
    assert cfg.read_bytes()==original
    for name in ['workspace.sqlite3','connector.sqlite']:
        with sqlite3.connect(backup/name) as db:assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'


def test_runtime_readiness_failure_rolls_back_before_accepting_new_work(installation,monkeypatch):
    m,source,target,home,cfg,task=installation;calls=[]
    def verify(cfg): raise RuntimeError('Readiness failed')
    m['update'].__globals__['verify_runtime']=verify
    monkeypatch.setattr(m['subprocess'],'run',lambda args,**kw:(calls.append(args) or SimpleNamespace(returncode=0)))
    with pytest.raises(RuntimeError,match='Readiness failed'):m['update'](cfg,source,True)
    assert (target/'studio/service.py').read_text()=="VERSION = 'installed'"
    connector_starts=[i for i,c in enumerate(calls) if 'bootstrap' in c and 'connector' in ' '.join(c)]
    assert connector_starts==[len(calls)-1]
    assert 'runtime' in ' '.join(calls[-2]) and 'bootstrap' in calls[-2]


def test_interactive_launch_update_requires_the_exact_studio_owner(tmp_path,monkeypatch):
    import plistlib
    m=runpy.run_path(str(Path(__file__).parents[1]/'distribution/update-extension.py'))
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    target=tmp_path/'runtime';cfg=tmp_path/'connector.json'
    base=tmp_path/'Library/LaunchAgents';base.mkdir(parents=True)
    for name in ['runtime','connector']:
        label='com.jbellsolutions.grokish-studio.'+name
        value={'Label':label,'ProgramArguments':['python',str(target/'distribution/local-launch.py'),str(cfg),name],'KeepAlive':True}
        (base/(label+'.plist')).write_bytes(plistlib.dumps(value))
    changed=m['launch_updates'](cfg,target)
    assert len(changed)==2
    for path,(old,new) in changed.items():
        assert path.read_bytes()==old
        assert plistlib.loads(new)=={**plistlib.loads(old),'ProcessType':'Interactive'}
    path=base/'com.jbellsolutions.grokish-studio.runtime.plist'
    value=plistlib.loads(path.read_bytes());value['ProgramArguments'][1]='/some/other/runtime.py';path.write_bytes(plistlib.dumps(value))
    with pytest.raises(RuntimeError,match='does not belong'):m['launch_updates'](cfg,target)


@pytest.fixture
def repair(tmp_path,monkeypatch):
    module=runpy.run_path(str(Path(__file__).parents[1]/'distribution/connect-local.py'))
    cfg=tmp_path/'connector.json';token=tmp_path/'connector-token';token.write_text('old-pairing')
    original={'kind':'local','computerId':'mac','cloudUrl':'https://workspace.test','sourceDir':str(tmp_path/'existing-runtime'),'connectorTokenFile':str(token),'stateDir':str(tmp_path/'state')}
    cfg.write_text(json.dumps(original));state={'computerId':'mac','origin':'https://workspace.test','job':'repair-job','pair':'one-time-fixture'}
    monkeypatch.setattr(module['urllib'].request,'urlopen',lambda *a,**k:pytest.fail('A healthy pairing must not be exchanged'))
    module['repair_existing'].__globals__['wait_connected']=lambda *a:True
    return module,cfg,original,state,token


def test_repair_reuses_binding_and_credentials_instead_of_installing_a_second_copy(repair,monkeypatch):
    m,cfg,original,state,token=repair;calls=[]
    def update(configuration,source,apply=False,**kwargs):
        calls.append(apply);return {'ready':True,'backup':'private-backup'}
    monkeypatch.setattr(m['runpy'],'run_path',lambda _: {'update':update})
    result=m['repair_existing'](cfg,cfg.parent/'release',state,lambda:None)
    assert calls==[False,True] and result=={**original,'setupJob':'repair-job'}
    assert token.read_text()=='old-pairing' and state['installed']


def test_busy_repair_does_not_rewrite_binding_or_pairing(repair,monkeypatch):
    m,cfg,original,state,token=repair;before=cfg.read_bytes()
    monkeypatch.setattr(m['runpy'],'run_path',lambda _: {'update':lambda *a:{'ready':False}})
    with pytest.raises(RuntimeError,match='accepted work'):m['repair_existing'](cfg,cfg.parent/'release',state,lambda:None)
    assert cfg.read_bytes()==before and token.read_text()=='old-pairing'


def test_failed_extension_repair_restores_original_connection_config(repair,monkeypatch):
    m,cfg,original,state,token=repair;before=cfg.read_bytes()
    def update(configuration,source,apply=False,**kwargs):
        if apply:raise RuntimeError('native readiness failed')
        return {'ready':True}
    monkeypatch.setattr(m['runpy'],'run_path',lambda _: {'update':update})
    with pytest.raises(RuntimeError,match='readiness'):m['repair_existing'](cfg,cfg.parent/'release',state,lambda:None)
    assert cfg.read_bytes()==before and token.read_text()=='old-pairing'


def test_repair_can_renew_only_its_existing_studio_pairing(repair,monkeypatch):
    import io
    m,cfg,original,state,token=repair;checks=iter([False,True]);sent=[]
    m['repair_existing'].__globals__['wait_connected']=lambda *a:next(checks)
    monkeypatch.setattr(m['runpy'],'run_path',lambda _: {'update':lambda *a,**kw:{'ready':True,'backup':'private-backup'}})
    def exchange(request,**kwargs):
        sent.append(request)
        return io.BytesIO(json.dumps({'token':'fixture-pairing'}).encode())
    monkeypatch.setattr(m['urllib'].request,'urlopen',exchange)
    m['repair_existing'](cfg,cfg.parent/'release',state,lambda:None)
    assert len(sent)==1 and sent[0].full_url=='https://workspace.test/api/pairing/exchange'
    assert json.loads(sent[0].data)['computerId']=='mac'
    assert token.read_text()=='fixture-pairing'


def test_compatibility_probe_never_uses_the_live_hermes_home(tmp_path,monkeypatch):
    m=runpy.run_path(str(Path(__file__).parents[1]/'distribution/connect-local.py'));seen=[]
    def run(args,**kwargs):
        home=Path(kwargs['env']['HERMES_HOME']);seen.append(home)
        assert home!=tmp_path/'live' and (home/'config.yaml').read_text()=='{}\n'
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(m['subprocess'],'run',run)
    monkeypatch.setenv('HERMES_HOME',str(tmp_path/'live'))
    m['check_compatibility'](Path('python'),tmp_path/'native',tmp_path/'release','mac')
    assert seen and not seen[0].exists()


def test_update_sets_repair_job_only_with_verified_extension_and_rolls_it_back(installation,monkeypatch):
    m,source,target,home,cfg,task=installation;old=cfg.read_bytes()
    monkeypatch.setattr(m['subprocess'],'run',lambda *a,**kw:SimpleNamespace(returncode=0))
    def failed(cfg):raise RuntimeError('not ready')
    m['update'].__globals__['verify_runtime']=failed
    with pytest.raises(RuntimeError,match='not ready'):m['update'](cfg,source,True,setup_job='new-job')
    assert cfg.read_bytes()==old
    m['update'].__globals__['verify_runtime']=lambda cfg:None
    result=m['update'](cfg,source,True,setup_job='new-job')
    assert json.loads(cfg.read_text())=={**json.loads(old),'setupJob':'new-job'}
    assert (Path(result['backup'])/'connector-config.json').read_bytes()==old
