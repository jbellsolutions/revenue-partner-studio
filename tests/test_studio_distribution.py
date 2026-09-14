from pathlib import Path
import importlib.util
import pytest
import yaml

ROOT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'distribution'/f'{name}.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def test_fresh_home_and_conflicting_retry(tmp_path):
    initialize=load('initialize_remote').initialize
    home=tmp_path/'remote'
    result=initialize(home,'11111111-1111-4111-8111-111111111111')
    assert result['agents']==1 and not result['providerAuthenticated']
    token=(home/'studio/gateway-token').read_text()
    assert len(token.strip())>=48
    assert (home/'studio/gateway-token').stat().st_mode & 0o777 == 0o600
    assert not (home/'auth.json').exists()
    assert yaml.safe_load((home/'config.yaml').read_text())['tools']['enabled_toolsets']==['terminal','file','web','studio','orgo-screen']
    with pytest.raises(RuntimeError,match='overwrite'):
        initialize(home,'22222222-2222-4222-8222-222222222222')
    assert (home/'studio/gateway-token').read_text()==token


def test_installer_rejects_unsafe_destinations():
    installer=load('install')
    for host in ['-oProxyCommand=bad','host;bad','host\ncommand','user@host','$(bad)']:
        with pytest.raises(ValueError):installer.target(host)
    with pytest.raises(ValueError):installer.validate_id('not-a-computer')
    assert installer.target('client.example.ts.net')=='root@client.example.ts.net'


def test_existing_auth_is_never_imported_or_overwritten(tmp_path):
    (tmp_path/'auth.json').write_text('owner-private-auth')
    with pytest.raises(RuntimeError):load('initialize_remote').initialize(tmp_path,'11111111-1111-4111-8111-111111111111')
    assert (tmp_path/'auth.json').read_text()=='owner-private-auth'
    assert not (tmp_path/'config.yaml').exists()


def test_screen_configuration_uses_verified_installation_binding(monkeypatch):
    from studio.service import screen_config
    from hermes_cli import orgo_screens
    selected='22222222-2222-4222-8222-222222222222'
    monkeypatch.setattr(orgo_screens,'verify_binding',lambda:selected)
    assert screen_config('researcher')['env']['ORGO_DEFAULT_COMPUTER_ID']==selected
    def wrong():raise RuntimeError('binding mismatch')
    monkeypatch.setattr(orgo_screens,'verify_binding',wrong)
    with pytest.raises(RuntimeError,match='binding mismatch'):screen_config('researcher')


def test_route_verification_refuses_another_ssh_host_and_cleans_challenge(monkeypatch):
    import io,json
    from types import SimpleNamespace
    installer=load('install');commands=[]
    def request(req,timeout):
        commands.append(json.loads(req.data)['command'])
        return io.BytesIO(b'{"success":true}')
    monkeypatch.setattr(installer.urllib.request,'urlopen',request)
    monkeypatch.setattr(installer,'ssh',lambda *a,**kw:SimpleNamespace(stdout='wrong-host'))
    with pytest.raises(RuntimeError,match='does not match'):installer.verify_route('11111111-1111-4111-8111-111111111111','test','host')
    assert len(commands)==2 and commands[1].startswith('rm -f /tmp/studio-route-')
