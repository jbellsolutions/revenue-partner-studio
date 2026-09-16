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
        for name in ['studio/cloud_connector.py','studio/service.py','tools/studio_tools.py','distribution/local-launch.py']:
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


def test_owned_plugins_with_same_filename_have_distinct_backups_and_rollback(installation,monkeypatch):
    m,source,target,home,cfg,task=installation
    paths=[home/'profiles'/name/'__init__.py' for name in ['researcher','writer']]
    changes={}
    for i,path in enumerate(paths):
        path.parent.mkdir(parents=True);path.write_bytes(str(i).encode())
        changes[path]=(path.read_bytes(),b'updated')
    m['update'].__globals__['launch_updates']=lambda *args: changes
    monkeypatch.setattr(m['subprocess'],'run',lambda *a,**kw:SimpleNamespace(returncode=0))
    def failed(cfg): raise RuntimeError('readiness failed')
    m['update'].__globals__['verify_runtime']=failed
    with pytest.raises(RuntimeError,match='readiness failed'):m['update'](cfg,source,True)
    saved=next((cfg.parent/'extension-backups').glob('*/owned-files'))
    manifest=json.loads((saved/'manifest.json').read_text())
    for i,row in enumerate(manifest):
        assert (saved/row['backup']).read_bytes()==str(i).encode()
        assert Path(row['path']).read_bytes()==str(i).encode()


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


def test_legacy_orgo_paths_require_the_exact_supervised_connector(tmp_path,monkeypatch):
    m=runpy.run_path(str(Path(__file__).parents[1]/'distribution/update-extension.py'))
    target=tmp_path/'runtime';target.mkdir()
    cfg=tmp_path/'connector.json';proc=tmp_path/'proc';python='/known/venv/bin/python'
    for pid,args in [('101',[python,'-m','studio.cloud_connector','--config',str(cfg)]),('102',[python,'hermes','serve','--isolated'])]:
        p=proc/pid;p.mkdir(parents=True);(p/'cwd').symlink_to(target,target_is_directory=True)
        (p/'cmdline').write_bytes(('\0'.join(args)+'\0').encode())
    monkeypatch.setattr(m['subprocess'],'check_output',lambda args,**kw:'101' if args[-1].endswith('connector') else '102')
    wrapper=tmp_path/'screen-control';wrapper.write_text('# '+str(target)+'\n# hermes_cli.orgo_screens\n')
    original={'computerId':'existing','screenControl':str(wrapper)}
    resolved,changes=m['orgo_installation'](cfg,original,proc)
    assert resolved=={**original,'sourceDir':str(target),'python':python}
    assert str(cfg).encode() in changes[wrapper][1] and b'distribution/screen-control.py' in changes[wrapper][1]
    assert wrapper.read_bytes()==changes[wrapper][0]
    (proc/'101/cmdline').write_bytes((python+'\0-m\0studio.cloud_connector\0--config\0/another/config.json\0').encode())
    with pytest.raises(RuntimeError,match='does not belong'):m['orgo_installation'](cfg,original,proc)


def test_orgo_migration_backs_up_owned_wrapper_and_rolls_back_config(installation,monkeypatch):
    m,source,target,home,cfg,task=installation
    state=json.loads(cfg.read_text());state.pop('sourceDir');state['kind']='orgo';cfg.write_text(json.dumps(state))
    old_config=cfg.read_bytes()
    binding=home/'orgo-computer';binding.mkdir();(binding/'computer.json').write_text('{"computerId":"mac"}')
    destination=home/'studio-cloud/runtime/workspace.sqlite3';destination.parent.mkdir();task.rename(destination)
    for root in (source,target):
        for name in ['hermes_cli/orgo_screens.py','hermes_cli/orgo_screen_mcp.py','distribution/screen-control.py']:
            p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('VERSION = '+repr(root.name))
    wrapper=cfg.parent/'screen-control';wrapper.write_text('old-wrapper');wrapper.chmod(0o700)
    m['update'].__globals__['orgo_installation']=lambda configuration,value:({**value,'sourceDir':str(target),'python':'python'}, {wrapper:(b'old-wrapper',b'new-wrapper')})
    monkeypatch.setattr(m['subprocess'],'run',lambda *a,**kw:SimpleNamespace(returncode=0))
    def failed(cfg):raise RuntimeError('not ready')
    m['update'].__globals__['verify_runtime']=failed
    with pytest.raises(RuntimeError,match='not ready'):m['update'](cfg,source,True)
    assert cfg.read_bytes()==old_config and wrapper.read_text()=='old-wrapper' and wrapper.stat().st_mode & 0o777==0o700
    m['update'].__globals__['verify_runtime']=lambda cfg:None
    result=m['update'](cfg,source,True)
    assert wrapper.read_text()=='new-wrapper' and wrapper.stat().st_mode & 0o777==0o700
    assert json.loads(cfg.read_text())['sourceDir']==str(target)
    assert (Path(result['backup'])/'connector-config.json').read_bytes()==old_config
    saved=Path(result['backup'])/'owned-files'
    row=next(row for row in json.loads((saved/'manifest.json').read_text()) if row['path']==str(wrapper))
    assert (saved/row['backup']).read_text()=='old-wrapper'
