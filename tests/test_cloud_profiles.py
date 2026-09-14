import json
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.error import HTTPError
import pytest
from studio.cloud_profiles import operation, document
from studio.cloud_credentials import run
from studio.cloud_ledger import Ledger
from tests.test_cloud_coordination import make_service


def test_edits_preserve_old_version_reject_stale_and_busy_and_refresh_only_owner(tmp_path):
    service=make_service(tmp_path);(tmp_path/'SOUL.md').write_text('Original')
    a=SimpleNamespace(_invalidate_system_prompt=Mock());b=SimpleNamespace(_invalidate_system_prompt=Mock())
    service.server._sessions={'a':{'profile_home':tmp_path,'agent':a},'b':{'profile_home':tmp_path/'other','agent':b}}
    original=document(tmp_path,'instructions')
    params={'agentId':'default','kind':'instructions','text':'Updated','version':original['version']}
    result=operation(service,'profile_update',params)
    assert result['text']=='Updated'
    assert (tmp_path/'studio/document-versions/instructions'/ (original['version']+'.txt')).read_text()=='Original'
    a._invalidate_system_prompt.assert_called_once();b._invalidate_system_prompt.assert_not_called()
    with pytest.raises(ValueError,match='changed'):operation(service,'profile_update',params)
    service.server._sessions['a']['running']=True
    with pytest.raises(ValueError,match='finish'):operation(service,'profile_update',{**params,'version':result['version']})
    assert operation(service,'profile_describe',{'agentId':'default'})['busy']


def test_describe_masks_connection_secrets_and_retains_skill_disablement(tmp_path):
    service=make_service(tmp_path)
    (tmp_path/'config.yaml').write_text('skills:\n  disabled: [mail]\nmcp_servers:\n  crm:\n    env:\n      TOKEN: TOP_SECRET\n')
    skill=tmp_path/'skills/mail';skill.mkdir(parents=True);(skill/'SKILL.md').write_text('Mailbox skill')
    value=operation(service,'profile_describe',{'agentId':'default'})
    assert value['skills'][0]['enabled'] is False
    assert 'TOP_SECRET' not in json.dumps(value)
    assert value['connections'][0]['status']=='configured'


def test_credential_checks_report_exact_source_and_errors_without_leaking_key(tmp_path):
    child=tmp_path/'profiles/email';child.mkdir(parents=True)
    (tmp_path/'config.yaml').write_text('model: test');(child/'config.yaml').write_text('model: test')
    (tmp_path/'.env').write_text('OPENROUTER_API_KEY=root-secret\n')
    (child/'.env').write_text('ANTHROPIC_API_KEY=child-secret\n')
    keys=run(child,tmp_path,{'operation':'provider_keys'})['keys']
    assert {k['id']:k['source'] for k in keys}=={'anthropic':'profile','openrouter':'computer'}
    def unauthorized(request,**kwargs):
        assert request.headers['X-api-key']=='child-secret'
        raise HTTPError(request.full_url,401,'Never reveal child-secret',{},None)
    result=run(child,tmp_path,{'operation':'provider_check','provider':'anthropic'},opener=unauthorized)
    assert result['status']=='invalid'
    assert 'child-secret' not in json.dumps(result)
    assert 'child-secret' not in (child/'studio/provider-checks.json').read_text()


def test_api_key_is_not_saved_in_request_ledger(tmp_path):
    ledger=Ledger(tmp_path/'ledger.db')
    ledger.begin('key','providers.configure',{'agentId':'email','apiKey':'PRIVATE_KEY'})
    rows=ledger.db.execute('SELECT params FROM requests').fetchall()
    assert 'PRIVATE_KEY' not in str(rows) and json.loads(rows[0][0])=={'redacted':True}


def test_saving_keys_uses_isolated_helper_and_preserves_siblings_and_oauth(tmp_path, monkeypatch):
    from dotenv import dotenv_values
    import os
    service=make_service(tmp_path)
    child=tmp_path/'profiles/email';child.mkdir(parents=True)
    (child/'config.yaml').write_text('model:\n  provider: openrouter\n  api_key: old-inline\n')
    (tmp_path/'.env').write_text('OPENROUTER_API_KEY=root-unchanged\n')
    (child/'auth.json').write_text(json.dumps({'version':1,'providers':{'anthropic':{'access_token':'oauth-unchanged'}},'credential_pool':{'openrouter':[{'source':'env:OPENROUTER_API_KEY','api_key':'old-key'}]}}))
    monkeypatch.setenv('OPENROUTER_API_KEY','process-unchanged')
    result=operation(service,'provider_configure',{'agentId':'email','provider':'openrouter','apiKey':'selected-profile-key'})
    assert result['saved']
    assert dotenv_values(child/'.env')['OPENROUTER_API_KEY']=='selected-profile-key'
    assert dotenv_values(tmp_path/'.env')['OPENROUTER_API_KEY']=='root-unchanged'
    assert os.environ['OPENROUTER_API_KEY']=='process-unchanged'
    assert 'oauth-unchanged' in (child/'auth.json').read_text()
    assert 'old-inline' not in (child/'config.yaml').read_text()
    assert operation(service,'provider_keys',{'agentId':'email'})['keys'][1]['source']=='profile'


def test_linked_memory_parent_and_credential_files_are_rejected(tmp_path):
    service=make_service(tmp_path);outside=tmp_path/'outside';outside.mkdir()
    (tmp_path/'memories').symlink_to(outside,target_is_directory=True)
    with pytest.raises(ValueError,match='Linked'):
        operation(service,'profile_update',{'agentId':'default','kind':'memory','text':'new','version':'invalid'})
    assert not list(outside.iterdir())
    (tmp_path/'.env').symlink_to(outside/'secret')
    with pytest.raises(ValueError,match='Linked'):run(tmp_path,tmp_path,{'operation':'provider_keys'})


def test_saved_profile_key_is_used_by_native_scoped_turn_resolution(tmp_path,monkeypatch):
    from agent.secret_scope import build_profile_secret_scope,set_secret_scope,reset_secret_scope,get_secret
    service=make_service(tmp_path);child=tmp_path/'profiles/email';child.mkdir(parents=True)
    (child/'config.yaml').write_text('model: test')
    monkeypatch.setenv('OPENROUTER_API_KEY','parent-key')
    operation(service,'provider_configure',{'agentId':'email','provider':'openrouter','apiKey':'child-turn-key'})
    token=set_secret_scope(build_profile_secret_scope(child))
    try:assert get_secret('OPENROUTER_API_KEY')=='child-turn-key'
    finally:reset_secret_scope(token)
    assert get_secret('OPENROUTER_API_KEY')=='parent-key'


def test_skill_toggle_uses_native_hermes_settings_without_changing_sibling(tmp_path):
    service=make_service(tmp_path)
    child=tmp_path/'profiles/email';child.mkdir(parents=True);(child/'config.yaml').write_text('model: test\n')
    skill=child/'skills/mail';skill.mkdir(parents=True);(skill/'SKILL.md').write_text('---\nname: mail\n---\nRead mail only when asked')
    root=(tmp_path/'config.yaml').read_bytes()
    operation(service,'skill_update',{'agentId':'email','id':'mail','enabled':False})
    assert not operation(service,'profile_describe',{'agentId':'email'})['skills'][0]['enabled']
    operation(service,'skill_update',{'agentId':'email','id':'mail','enabled':True})
    assert operation(service,'profile_describe',{'agentId':'email'})['skills'][0]['enabled']
    assert (tmp_path/'config.yaml').read_bytes()==root
    with pytest.raises(ValueError):operation(service,'skill_update',{'agentId':'email','id':'../../other','enabled':True})


def test_custom_endpoint_reuses_native_writer_preserving_options_and_credential_isolation(tmp_path):
    from dotenv import dotenv_values
    import yaml
    service=make_service(tmp_path)
    child=tmp_path/'profiles/email';child.mkdir(parents=True)
    (child/'config.yaml').write_text('model: original\nproviders:\n  local:\n    name: Local\n    base_url: http://localhost:1234/v1\n    api_mode: chat_completions\n    extra_headers:\n      X-Custom: preserved\n')
    result=operation(service,'endpoint_configure',{'agentId':'email','name':'Local','baseUrl':'http://localhost:4321/v1','model':'local-model','apiKey':'private-endpoint-key'})
    assert result['endpoints']
    cfg=yaml.safe_load((child/'config.yaml').read_text())
    assert cfg['model']=='original' and cfg['providers']['local']['extra_headers']=={'X-Custom':'preserved'}
    assert 'private-endpoint-key' not in (child/'config.yaml').read_text()
    assert 'private-endpoint-key' not in json.dumps(result)
    assert 'private-endpoint-key' in dotenv_values(child/'.env').values()
    assert not (tmp_path/'.env').exists()
    ledger=Ledger(tmp_path/'ledger.db');ledger.begin('endpoint','endpoints.configure',{'apiKey':'private-endpoint-key'})
    assert 'private-endpoint-key' not in str(ledger.db.execute('SELECT params FROM requests').fetchall())
