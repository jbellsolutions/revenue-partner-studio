from types import SimpleNamespace
import yaml
import pytest
from studio.service import Service


def test_child_cannot_expand_owner_tools_or_copy_secrets(tmp_path,monkeypatch):
    from hermes_cli import profiles
    owner={'model':{'provider':'openai-codex','default':'test'},'tools':{'enabled_toolsets':['file','studio']},
           'approvals':{'mode':'manual','timeout':120,'approved_commands':['sensitive-grant']},
           'mcp_servers':{'private-crm':{'token':'must-not-copy'}}}
    (tmp_path/'config.yaml').write_text(yaml.safe_dump(owner))
    (tmp_path/'auth.json').write_text('private-owner-auth')
    def create(name,**kwargs):
        assert kwargs['no_skills'] and kwargs['no_alias']
        assert not kwargs.get('clone_all') and not kwargs.get('clone_config')
        path=tmp_path/'profiles'/name;path.mkdir(parents=True);return path
    monkeypatch.setattr(profiles,'create_profile',create)
    service=Service(SimpleNamespace(),tmp_path)
    service.create_agent('default','writer','Write briefs')
    path=tmp_path/'profiles/writer';child=yaml.safe_load((path/'config.yaml').read_text())
    assert child['tools']['enabled_toolsets']==['file','studio']
    assert child['mcp_servers']=={}
    assert child['approvals']=={'mode':'manual','timeout':120}
    assert not (path/'auth.json').exists()
    with pytest.raises(PermissionError):service.create_agent('writer','other','Expand team')


def test_second_service_cannot_recover_a_running_owners_work(tmp_path):
    first=Service(SimpleNamespace(),tmp_path)
    first.store.send('user','default','Work',request_id='work');first.store.claim()
    first.store.started('work','runtime','stored')
    with pytest.raises(RuntimeError,match='already owns'):Service(SimpleNamespace(),tmp_path)
    assert first.store.rows("SELECT state FROM deliveries WHERE id='work'")[0]['state']=='running'


def test_wait_respects_only_its_own_hermes_interrupt(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from tools.interrupt import set_interrupt
    service=Service(SimpleNamespace(),tmp_path)
    set_interrupt(True)
    try:
        assert service.operation('user',{'operation':'wait','seconds':30})=={'interrupted':True}
        with ThreadPoolExecutor(max_workers=1) as executor:
            result=executor.submit(service.operation,'user',{'operation':'wait','seconds':.01}).result(timeout=2)
        assert result['agents'][0]['name']=='default'
    finally: set_interrupt(False)
