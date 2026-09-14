import base64
import hashlib
import hmac
import json
import time
from pathlib import Path
import pytest
from studio.cloud_explorer import Explorer
from studio.cloud_library import Library
from studio.cloud_permissions import accept,allowed,receive
from studio.cloud_archive import Uploads,apply_archive

A='10000000-0000-4000-8000-000000000001'
B='10000000-0000-4000-8000-000000000002'
def home(path):
    path.mkdir();(path/'config.yaml').write_text('model: test\n');return path

def test_roster_reuses_unchanged_profiles_but_reflects_edits_additions_and_removals(tmp_path, monkeypatch):
    from studio.cloud_connector import Connector
    import studio.cloud_connector as module
    h = home(tmp_path/'hermes')
    connector = object.__new__(Connector)
    connector.home, connector.agent_cache = h, {}
    parse = module.yaml.safe_load
    calls = []
    monkeypatch.setattr(module.yaml, 'safe_load', lambda text: (calls.append(text), parse(text))[1])
    first = connector.agents()
    first['agents'][0]['name'] = 'caller edit'
    assert connector.agents()['agents'][0]['name'] == 'default'
    assert len(calls) == 1
    (h/'profile.yaml').write_text('name: Co-Founder\n')
    assert connector.agents()['agents'][0]['name'] == 'Co-Founder'
    (h/'config.yaml').write_text('model:\n  default: updated\n  provider: existing-account\n')
    assert connector.agents()['agents'][0]['model'] == 'updated'
    (h/'profiles').mkdir()
    specialist = home(h/'profiles'/'specialist')
    assert [row['id'] for row in connector.agents()['agents']] == ['default', 'specialist']
    (specialist/'config.yaml').unlink()
    (h/'profile.yaml').unlink()
    assert connector.agents()['agents'] == [{'id':'default','name':'default','description':'',
        'model':'updated','provider':'existing-account','head':True}]
    assert 'specialist' not in connector.agent_cache

def test_mac_start_waits_for_previous_job_removal_and_reports_exhausted_retries(tmp_path, monkeypatch):
    import runpy
    from types import SimpleNamespace
    installer=runpy.run_path(str(Path(__file__).resolve().parents[1]/'distribution/connect-local.py'))
    calls=[]
    def run(command,**kwargs):
        calls.append(command)
        # launchd may still list the old job while rejecting its replacement.
        return SimpleNamespace(returncode=0 if command[1]=='print' or len(calls)>=3 else 5,stderr=b'Job is being removed')
    monkeypatch.setattr(installer['subprocess'],'run',run)
    monkeypatch.setattr(installer['time'],'sleep',lambda seconds:None)
    installer['start_service']('gui/test',tmp_path/'runtime.plist',tmp_path/'error.log')
    assert len(calls)==3
    assert not (tmp_path/'error.log').exists()
    monkeypatch.setattr(installer['subprocess'],'run',lambda *a,**k:SimpleNamespace(returncode=5,stderr=b'Cannot register service'))
    with pytest.raises(RuntimeError,match='could not start'):
        installer['start_service']('gui/test',tmp_path/'runtime.plist',tmp_path/'error.log')
    assert (tmp_path/'error.log').read_bytes()==b'Cannot register service'

def test_explorer_scope_blocks_foreign_roots_links_and_secrets(tmp_path):
    h=home(tmp_path/'hermes');work=tmp_path/'work';work.mkdir();(work/'answer.txt').write_text('answer');(work/'auth.json').write_text('secret')
    explorer=Explorer(h,A,'default');explorer.add(str(work));root=next(r['id'] for r in explorer.roots()['roots'] if r['path']==str(work))
    assert [r['name'] for r in explorer.list(root)['entries']]==['answer.txt']
    for path in ['../hermes/config.yaml','auth.json','/etc/passwd']:
        with pytest.raises(PermissionError):explorer.read(root,path)
    (work/'linked').symlink_to(h,target_is_directory=True)
    with pytest.raises(PermissionError):explorer.read(root,'linked/config.yaml')
    foreign=Explorer(home(tmp_path/'other'),B,'default')
    with pytest.raises(PermissionError):foreign.list(root)
    first=explorer.read(root,'answer.txt');(work/'answer.txt').write_text('different')
    with pytest.raises(ValueError,match='changed'):explorer.read(root,'answer.txt',expected=first['version'])


def test_folder_picker_lists_only_directories_and_does_not_implicitly_grant_access(tmp_path,monkeypatch):
    monkeypatch.setattr(Path,'home',classmethod(lambda cls:tmp_path))
    h=home(tmp_path/'hermes');work=tmp_path/'work';work.mkdir()
    (tmp_path/'private.txt').write_text('private');(tmp_path/'.ssh').mkdir();(tmp_path/'linked').symlink_to(work,target_is_directory=True)
    explorer=Explorer(h,A,'default')
    rows=explorer.folders(str(tmp_path))
    names = {r['name'] for r in rows['folders']}
    assert {'hermes','work'} <= names and not {'.ssh','linked','private.txt'} & names
    assert not rows['selectable']
    assert explorer.folders(str(work))['selectable']
    assert not any(r['path']==str(work) for r in explorer.roots()['roots'])
    for path in [str(tmp_path/'.ssh'),str(tmp_path/'linked'),'/etc']:
        with pytest.raises(PermissionError):explorer.folders(path)

def test_reviewed_export_roundtrip_is_repeatable_and_excludes_credentials(tmp_path):
    source=home(tmp_path/'source');destination=home(tmp_path/'destination')
    (source/'SOUL.md').write_text('A useful specialist')
    (source/'.env').write_text('PROVIDER_KEY=private');(source/'auth.json').write_text('{"token":"private"}')
    library=Library(source);snapshot=library.export(B,['default'],'fixed-export')
    assert library.export(B,['default'],'fixed-export')==snapshot
    with pytest.raises(ValueError):library.export(A,['default'],'fixed-export')
    files=snapshot['manifest']['profiles']['default']['files'];assert 'auth.json' not in files and '.env' not in files
    preview=Library(destination).preview(B,snapshot['manifest']);assert preview['profiles'][0]['newProfile']
    assert not (destination/'profiles').exists()
    uploads=Uploads(destination,B);begin=uploads.begin(snapshot['size'],snapshot['sha256']);offset=0
    while offset<snapshot['size']:
        chunk=library.chunk(snapshot['exportId'],offset)
        uploaded=uploads.append(begin['uploadId'],offset,chunk['data'],chunk['sha256'])
        assert uploads.append(begin['uploadId'],offset,chunk['data'],chunk['sha256'])==uploaded
        offset=uploaded['offset']
    result=apply_archive(destination,B,uploads.finish(begin['uploadId']))
    target=destination/'profiles'/result['profiles'][0]['target'];assert (target/'SOUL.md').read_text()=='A useful specialist'
    assert not (target/'auth.json').exists()
    (target/'SOUL.md').write_text('A cloud edit')
    assert Library(destination).preview(B,snapshot['manifest'])['profiles'][0]['conflicts']==1

def sign(value,token='private-connector-token'):
    payload=base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return {'payload':payload,'signature':hmac.new(hashlib.sha256(token.encode()).hexdigest().encode(),payload.encode(),hashlib.sha256).hexdigest()}

def test_receiving_computer_checks_grant_identity_expiration_and_revocation(tmp_path):
    h=home(tmp_path/'hermes');token='private-connector-token';now=time.time()*1000
    grant={'id':'g','source':A,'actor':'default','target':B,'agent':'email','expires':None}
    receive(h,B,sign({'computerId':B,'validUntil':now+15000,'grants':[grant]}),token)
    envelope={'params':{'message':{'messageId':'request'}}}
    p={'sourceComputerId':A,'sourceAgentId':'default','agentId':'email','envelope':envelope,'authorization':sign({'source':A,'actor':'default','target':B,'agent':'email','request':'request','grant':'g','expires':now+30000,'hops':0,'envelopeHash':hashlib.sha256(json.dumps(envelope,separators=(',',':')).encode()).hexdigest()})}
    accept(h,B,p,token,'task');assert allowed(h,'task')
    with pytest.raises(PermissionError):accept(h,A,p,token,'wrong-computer')
    with pytest.raises(PermissionError):accept(h,B,{**p,'agentId':'other'},token,'wrong-agent')
    with pytest.raises(PermissionError):accept(h,B,{**p,'envelope':{'params':{'message':{'messageId':'request','text':'changed'}}}},token,'changed-work')
    with pytest.raises(PermissionError):receive(h,B,sign({'computerId':B,'validUntil':now-1,'grants':[grant]}),token)
    receive(h,B,sign({'computerId':B,'validUntil':now+15000,'grants':[]}),token)
    assert not allowed(h,'task')
    assert allowed(h,'existing-owner-chat')

def test_mac_desktop_is_separately_approved_single_owner_expiring_and_locally_stoppable(tmp_path):
    from types import SimpleNamespace
    from studio.local_screen import LocalScreen,may_automate
    h=home(tmp_path/'hermes');c=SimpleNamespace(home=h,computer=A,profile=lambda agent:h)
    screen=LocalScreen(c)
    with pytest.raises(PermissionError):screen.operation('default','screen.open')
    granted=screen.operation('default','screen.authorize');assert granted['expires']>time.time()
    assert may_automate(h,'default');assert not may_automate(h,'email')
    with pytest.raises(PermissionError):screen.operation('email','screen.authorize')
    screen.operation('default','screen.pause');assert not may_automate(h,'default')
    screen.operation('default','screen.resume');assert may_automate(h,'default')
    (h/'studio-cloud/access-paused').touch();assert not may_automate(h,'default')
    with pytest.raises(PermissionError):screen.operation('default','screen.authorize')
    (h/'studio-cloud/access-paused').unlink();screen.operation('default','screen.stop')
    with pytest.raises(PermissionError):screen.operation('default','screen.open')
    screen.operation('email','screen.authorize');value=json.loads(screen.path.read_text());value['expires']=0;screen.path.write_text(json.dumps(value))
    assert not may_automate(h,'email')

def test_revoked_delegation_interrupts_before_tool_dispatch(tmp_path,monkeypatch):
    from types import SimpleNamespace
    from studio.cloud_permissions import install_guard,record
    import gateway.session_context as context
    from tools.registry import registry
    h=home(tmp_path/'hermes');calls=[]
    with record(h) as db:db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)',('task','revoked',A,'default','email'))
    monkeypatch.setattr(registry,'dispatch',lambda *a,**k:calls.append('tool'))
    monkeypatch.setattr(context,'get_session_env',lambda name,default='':'runtime' if name=='HERMES_UI_SESSION_ID' else '')
    monkeypatch.setenv('STUDIO_COMPUTER_KIND','orgo')
    store=SimpleNamespace(rows=lambda *a:[{'id':'task'}],state=lambda *a:calls.append(a[1]))
    service=SimpleNamespace(home=h,store=store,server=SimpleNamespace(_sessions={}),task_event=lambda task:None,rpc=lambda *a:calls.append(a[0]))
    install_guard(service);result=registry.dispatch('terminal',{})
    assert 'tool' not in calls;assert calls==['needs_review','session.interrupt'];assert 'permission' in str(result)
