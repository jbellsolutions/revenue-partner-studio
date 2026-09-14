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
