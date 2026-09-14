import json
import pytest

from hermes_cli import orgo_screens as screens
from hermes_cli.orgo_codex_worker import check_subscription, worker_args


@pytest.fixture
def control_root(tmp_path, monkeypatch):
    monkeypatch.setattr(screens.sys, "platform", "linux")
    monkeypatch.setenv("ORGO_CONTROL_ROOT", str(tmp_path))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / 'codex'))
    monkeypatch.setenv("ORGO_DEFAULT_COMPUTER_ID", "11111111-1111-4111-8111-111111111111")
    screens.bind("11111111-1111-4111-8111-111111111111")
    return tmp_path


def test_other_computer_cannot_rebind_or_control(control_root, monkeypatch):
    other = "22222222-2222-4222-8222-222222222222"
    with pytest.raises(RuntimeError, match="already bound"):
        screens.bind(other)
    monkeypatch.setenv("ORGO_DEFAULT_COMPUTER_ID", other)
    with pytest.raises(RuntimeError, match="binding mismatch"):
        screens.screen("default")


def test_screen_assignments_survive_reload_and_are_bounded(control_root):
    assert screens.screen("default")["display"] == ":99"
    assert screens.screen("team-support")["display"] == ":100"
    assert screens.screen("gtm-assistant")["display"] == ":101"
    assert screens.screen("revenue-agent")["display"] == ":102"
    assert screens.screen("team-support")["display"] == ":100"
    assert screens.screen("fourth-specialist")["display"] == ":103"
    with pytest.raises(screens.ScreenBusy):
        screens.screen("fifth")


@pytest.mark.parametrize("profile", ["../other", "a/b", "x;id", "", "a" * 65])
def test_profile_cannot_escape_registry(control_root, profile):
    with pytest.raises(ValueError):
        screens.screen(profile)


def test_pause_fences_actions_until_explicit_resume(control_root):
    info = screens.screen("default")
    screens.control("default", True)
    with pytest.raises(RuntimeError, match="paused"):
        with screens.action(info):
            pytest.fail("Action must not run")
    screens.control("default", False)
    with screens.action(info):
        pass


def test_cannot_run_screen_tools_on_mac(monkeypatch):
    monkeypatch.setattr(screens.sys, "platform", "darwin")
    with pytest.raises(RuntimeError, match="never the Mac"):
        screens.root()


class Client:
    def __init__(self, kind="chatgpt", models=None):
        self.kind = kind
        self.models = models if models is not None else [{"model": "gpt-5.6-luna", "inputModalities": ["image", "text"]}]
        self.calls = []
    def request(self, method, params):
        self.calls.append(method)
        return {"account": {"type": self.kind}} if method == "account/read" else {"data": self.models}


def test_subscription_preflight_has_no_inference_or_billing_calls():
    client = Client()
    check_subscription(client)
    assert client.calls == ["account/read", "model/list"]


@pytest.mark.parametrize("kind", ["apiKey", "apikey", None])
def test_api_key_auth_never_accepted(kind):
    with pytest.raises(RuntimeError, match="fallback is disabled"):
        check_subscription(Client(kind=kind))


def test_unavailable_model_fails_without_upgrade():
    with pytest.raises(RuntimeError, match="no paid fallback"):
        check_subscription(Client(models=[]))


def test_worker_configuration_is_subscription_only_and_has_no_shell(control_root):
    args = worker_args("/python", "team-support", 10)
    config = dict(item.split("=", 1) for item in args if item != "-c")
    assert json.loads(config["forced_login_method"]) == "chatgpt"
    assert json.loads(config["model"]) == "gpt-5.6-luna"
    assert json.loads(config["features.shell_tool"]) is False
    assert json.loads(config["mcp_servers.orgo-screen.required"]) is True
    assert "ANTHROPIC_API_KEY" not in " ".join(args)
    assert json.loads(config["features.apps"]) is False
    assert json.loads(config["features.plugins"]) is False
    assert json.loads(config["mcp_servers.orgo-screen.enabled_tools"]) == ['browser_action', 'desktop_action']


def test_install_config_preserves_model_history_and_background_permissions(control_root):
    from hermes_cli.orgo_worker_install import update_config
    config = {'model': {'default': 'existing'}, 'agent': {'disabled_toolsets': ['terminal']},
              'platform_toolsets': {'slack': ['agent_team']}, 'mcp_servers': {'pandadoc': {'url': 'private'}}}
    result = update_config(config, '11111111-1111-4111-8111-111111111111', 'team-support', control_root)
    assert result['model'] == {'default': 'existing'}
    assert result['agent']['disabled_toolsets'] == ['terminal']
    assert result['platform_toolsets']['slack'] == ['agent_team']
    assert result['mcp_servers']['pandadoc']['url'] == 'private'
    assert result['mcp_servers']['pandadoc']['enabled'] is False
    assert result['display']['personality'] == ''


def test_worker_plugin_only_allows_owner_desktop_computer_calls(monkeypatch):
    from hermes_cli.orgo_worker_install import patch_team_boundary
    from gateway import session_context
    text = 'def register():\n    if True:\n        def boundary(tool_name,**kwargs):\n            return {"action": "block"}\n        return boundary\n'
    patched = patch_team_boundary(text)
    assert patch_team_boundary(patched) == patched
    namespace = {}
    import os
    exec(patched, {'os': os}, namespace)
    boundary = namespace['register']()
    monkeypatch.setattr(session_context, 'get_session_env', lambda *args: 'desktop')
    monkeypatch.delenv('HERMES_KANBAN_TASK', raising=False)
    assert boundary('mcp__orgo_agent__orgo_agent_run') is None
    assert boundary('terminal')['action'] == 'block'
    monkeypatch.setenv('HERMES_KANBAN_TASK', 'background')
    assert boundary('mcp__orgo_agent__orgo_agent_run')['action'] == 'block'
    monkeypatch.delenv('HERMES_KANBAN_TASK')
    monkeypatch.setattr(session_context, 'get_session_env', lambda *args: 'slack')
    assert boundary('mcp__orgo_agent__orgo_agent_run')['action'] == 'block'


def test_primary_display_is_never_replaced(control_root, monkeypatch):
    monkeypatch.setattr(screens, 'listening', lambda _: False)
    monkeypatch.setattr(screens, 'spawn', lambda *args: pytest.fail('Must not replace the main desktop'))
    with pytest.raises(RuntimeError, match='primary desktop is unavailable'):
        screens.ensure('default')


def test_lost_secondary_display_recovers_same_binding(control_root, monkeypatch):
    original = screens.screen('team-support')
    listeners = set()
    starts = []
    monkeypatch.setattr(screens, 'listening', lambda port: port in listeners)
    monkeypatch.setattr(screens, 'wait_port', lambda port: listeners.add(port))
    def simulated_spawn(info, name, command):
        starts.append((info['display'], name))
        screens.write_json(control_root / info['profile'] / (name + '.process.json'), {'pid': 123, 'start': 'owned-test-process'})
    monkeypatch.setattr(screens, 'spawn', simulated_spawn)
    monkeypatch.setattr(screens, 'process_start', lambda pid: 'owned-test-process' if pid == 123 else None)
    assert screens.ensure('team-support')['display'] == original['display']
    assert [name for _, name in starts] == ['display', 'window-manager', 'viewer']
    starts.clear()
    screens.ensure('team-support')
    assert not starts
    listeners.remove(original['vncPort'])
    assert screens.ensure('team-support')['display'] == original['display']
    assert starts == [(original['display'], 'display'), (original['display'], 'window-manager')]


def test_standalone_launcher_preserves_explicit_profile(monkeypatch):
    from pathlib import Path
    from hermes_cli import orgo_agent_mcp as bridge
    monkeypatch.setattr(bridge, '__file__', '/root/.hermes/orgo-agent-mcp.py')
    monkeypatch.setenv('HERMES_HOME', '/root/.hermes')
    monkeypatch.setenv('ORGO_AGENT_PROFILE', 'team-support')
    monkeypatch.setattr(Path, 'exists', lambda self: True)
    monkeypatch.setattr(Path, 'read_text', lambda self, *, encoding: json.dumps({'runtime': '/root/.hermes/desktop-runtime/candidate'}) if encoding == 'utf-8' else pytest.fail('Expected UTF-8'))
    captured = {}
    def execute(binary, argv, env):
        captured.update(env)
        raise RuntimeError('exec-replaced')
    monkeypatch.setattr(bridge.os, 'execve', execute)
    with pytest.raises(RuntimeError, match='exec-replaced'):
        bridge.main()
    assert captured['ORGO_AGENT_PROFILE'] == 'team-support'


@pytest.mark.parametrize('platform', ['darwin', 'win32'])
def test_live_canary_refuses_non_cloud_platform_before_starting_tools(monkeypatch, platform):
    from scripts import orgo_subscription_smoke as smoke
    monkeypatch.setattr(smoke.sys, 'platform', platform)
    monkeypatch.setattr(smoke.subprocess, 'Popen', lambda *a, **kw: pytest.fail('Must not start automation'))
    monkeypatch.setattr(smoke.tempfile, 'NamedTemporaryFile', lambda *a, **kw: pytest.fail('Must not create files'))
    with pytest.raises(RuntimeError, match='Orgo Linux host'):
        smoke.main()


def test_install_round_trip_preserves_unicode_and_unexpanded_credentials(control_root, monkeypatch):
    from pathlib import Path
    import yaml
    from hermes_cli import orgo_worker_install as installer

    def cloud_path(value):
        value = str(value)
        return control_root / value.lstrip('/') if value.startswith('/root/') else Path(value)

    monkeypatch.setattr(installer, 'Path', cloud_path)
    monkeypatch.setenv('ORGO_TEST_SECRET', 'must-not-be-written')
    runtime = cloud_path('/root/.hermes/desktop-runtime/candidate')
    for relative in ('hermes_cli/orgo_codex_worker.py', '.venv/bin/python'):
        target = runtime / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()
    profile_home = cloud_path('/root/.hermes/profiles/team-support')
    profile_home.mkdir(parents=True)
    config_path = profile_home / 'config.yaml'
    original = 'model:\n  default: unchanged\ncustom:\n  name: café 日本語\n  key: ${ORGO_TEST_SECRET}\n'
    config_path.write_text(original, encoding='utf-8')
    (profile_home / 'SOUL.md').write_text('Keep this identity: 日本語\n', encoding='utf-8')
    receipt = installer.install(runtime, '11111111-1111-4111-8111-111111111111', ['team-support'])
    saved = config_path.read_text(encoding='utf-8')
    config = yaml.safe_load(saved)
    assert config['custom'] == {'name': 'café 日本語', 'key': '${ORGO_TEST_SECRET}'}
    assert config['model'] == {'default': 'unchanged'}
    assert 'must-not-be-written' not in saved
    assert 'Keep this identity: 日本語' in (profile_home / 'SOUL.md').read_text(encoding='utf-8')
    backup = json.loads(Path(receipt['rollbackReceipt']).read_text(encoding='utf-8'))
    source_backup = next(entry['backup'] for entry in backup['files'] if entry['path'] == str(config_path))
    assert Path(source_backup).read_text(encoding='utf-8') == original
    assert receipt['gatewayRestarted'] is False
