from types import SimpleNamespace
import os
import textwrap
import pytest
from studio import team_compat as compat


@pytest.fixture
def studio_actor(monkeypatch, tmp_path):
    from studio import service
    from gateway import session_context
    profile = tmp_path/'profiles'/'researcher'
    profile.mkdir(parents=True)
    config = profile/'config.yaml'
    config.write_text('toolsets: [agent_team, orgo-screen]\nagent:\n  disabled_toolsets: [browser, terminal]\n')
    monkeypatch.setenv('HERMES_STUDIO_RUNTIME', '1')
    monkeypatch.delenv('HERMES_KANBAN_TASK', raising=False)
    monkeypatch.setattr(session_context, 'get_session_env', lambda *args: 'studio')
    monkeypatch.setattr(service, 'current', lambda: SimpleNamespace(home=tmp_path, actor=lambda: 'researcher'))
    return config


def test_live_actor_grant_allows_only_managed_screen_and_scoped_catalog(studio_actor):
    for name in ('mcp__orgo_screen__browser_action', 'mcp__orgo_screen__desktop_action', 'tool_search', 'tool_describe'):
        assert compat.allows_managed_screen(name)
    for name in ('terminal', 'mcp__orgo_agent__orgo_agent_run', 'tool_call', 'browser_navigate', 'studio_delegate'):
        assert not compat.allows_managed_screen(name)
    studio_actor.write_text('toolsets: [orgo-screen]\nagent:\n  disabled_toolsets: [orgo-screen]\n')
    assert not compat.allows_managed_screen('mcp__orgo_screen__browser_action')


@pytest.mark.parametrize('context', ['scheduled', 'cli', 'desktop', 'other-runtime', 'unbound', 'other-profile', 'precedence'])
def test_inherited_worker_boundaries_are_preserved(studio_actor, monkeypatch, context):
    from studio import service
    from gateway import session_context
    if context == 'scheduled': monkeypatch.setenv('HERMES_KANBAN_TASK', 'saved-task')
    elif context in ('cli', 'desktop'): monkeypatch.setattr(session_context, 'get_session_env', lambda *args: context)
    elif context == 'other-runtime': monkeypatch.delenv('HERMES_STUDIO_RUNTIME')
    elif context == 'unbound': monkeypatch.setattr(service, 'current', lambda: (_ for _ in ()).throw(PermissionError('No session')))
    elif context == 'other-profile': monkeypatch.setattr(service, 'current', lambda: SimpleNamespace(home=studio_actor.parents[2], actor=lambda: 'ungranted'))
    elif context == 'precedence': studio_actor.write_text('toolsets: [orgo-screen]\ntools:\n  enabled_toolsets: [agent_team]\n')
    assert not compat.allows_managed_screen('mcp__orgo_screen__browser_action')


@pytest.mark.parametrize('desktop', [False, True])
def test_patch_is_idempotent_and_keeps_scheduled_and_unrelated_tools_blocked(studio_actor, monkeypatch, desktop):
    marker = '        def boundary(tool_name,**kwargs):\n'
    original = compat._BASE.replace(marker, marker + compat._DESKTOP) if desktop else compat._BASE
    source = 'def register(ctx):\n    if True:\n' + original
    patched = compat.patch_boundary(source)
    assert compat.patch_boundary(patched) == patched
    namespace = {'os': os}
    exec(textwrap.dedent(patched.split('    if True:\n')[1]), namespace)
    boundary = namespace['boundary']
    assert boundary('mcp__orgo_screen__browser_action') is None
    assert boundary('team_execute') is None
    assert boundary('terminal')['action'] == 'block'
    monkeypatch.setenv('HERMES_KANBAN_TASK', 'saved-task')
    assert boundary('mcp__orgo_screen__browser_action')['action'] == 'block'


def test_unrecognized_worker_policy_is_never_patched():
    source = 'def register(ctx):\n    if True:\n' + compat._BASE.replace("if tool_name not in", "if tool_name == 'terminal': return {'action':'block','message':'Custom policy'}\n            if tool_name not in")
    with pytest.raises(ValueError, match='Unknown team boundary'): compat.patch_boundary(source)


def test_only_explicitly_granted_existing_plugins_are_selected(studio_actor):
    home = studio_actor.parents[2]
    plugin = studio_actor.parent/'plugins/agent-team/__init__.py'
    plugin.parent.mkdir(parents=True)
    original = ('def register(ctx):\n    if True:\n' + compat._BASE).encode()
    plugin.write_bytes(original)
    changes = compat.boundary_updates(home)
    assert list(changes) == [plugin] and plugin.read_bytes() == original
    studio_actor.write_text('toolsets: [agent_team]\n')
    assert compat.boundary_updates(home) == {}
