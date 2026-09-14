"""Install the bounded subscription worker into a prepared cloud runtime.

Does not change models, restart gateways, install providers, or touch histories.
Every replaced configuration/launcher is copied into a private rollback folder.
Run on the verified Orgo host after backing up its history database.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import tempfile

import yaml

from hermes_cli.config import read_user_config_raw
from hermes_cli.orgo_screens import PROFILE, bind, root, write_json

POLICY_START = '<!-- orgo-subscription-worker:start -->'
POLICY_END = '<!-- orgo-subscription-worker:end -->'
POLICY = f"""{POLICY_START}
For requests to open a site, search images on the computer, click, type, or use
an app, call mcp__orgo_agent__orgo_agent_run with the complete task. It actually
operates your assigned visible screen on this Orgo computer using Luna through
the owner's ChatGPT subscription. Do not substitute web_search, give the owner
shell commands, or claim computer work without a tool result. General factual
research can still use web tools. Do not silently choose paid computer workers.
Ask the worker to capture and verify the screen as part of that same task. Its
verified result is sufficient; do not make an extra native Orgo screenshot call
(that would target the primary screen, not your assigned screen).
If the screen is paused, authentication/usage is blocked, or a website requests
CAPTCHA, report that exact blocker and stop; never work around it. The owner can
use Take control in the computer panel and Resume agent when finished.
Your normal Hermes model, history, and A2A team tools are unchanged. Ignore old
cutesy personality suffixes; respond naturally without DESU or forced sign-offs.
{POLICY_END}"""


def update_config(config: dict, computer_id: str, profile: str, base: Path) -> dict:
    config.setdefault('display', {})['personality'] = ''
    servers = config.setdefault('mcp_servers', {})
    servers['orgo-agent'] = {
        'command': str(base / 'worker'), 'args': [], 'trust': 'full', 'timeout': 960,
        'env': {'ORGO_DEFAULT_COMPUTER_ID': computer_id, 'ORGO_AGENT_PROFILE': profile,
                'ORGO_AGENT_MAX_STEPS': '30', 'ORGO_AGENT_TIMEOUT_SECONDS': '900'},
    }
    if 'orgo' in servers:
        servers['orgo']['command'] = str(base / 'native')
        servers['orgo']['args'] = []
        servers['orgo'].setdefault('env', {}).pop('ORGO_API_KEY', None)
        servers['orgo']['env']['ORGO_DEFAULT_COMPUTER_ID'] = computer_id
        if profile == 'team-support':
            # Do not advertise dozens of primary-screen tools that this scoped
            # profile cannot use. The worker handles its assigned screen.
            servers['orgo']['enabled'] = False
            config.setdefault('tools', {})['tool_search'] = False
    for name in ('pandadoc', 'higgsfield'):
        if name in servers:
            servers[name]['lazy'] = True
            servers[name]['connect_timeout'] = 5
            servers[name]['enabled'] = False
    # Explicitly enable the worker in the desktop/CLI profile. Background team
    # runs remain restricted by their pre_tool_call boundary; Slack is unchanged.
    toolsets = config.setdefault('toolsets', [])
    if 'mcp-orgo-agent' not in toolsets:
        toolsets.append('mcp-orgo-agent')
    platforms = config.setdefault('platform_toolsets', {})
    for surface in ('cli', 'desktop'):
        allowed = platforms.setdefault(surface, list(toolsets))
        if 'mcp-orgo-agent' not in allowed:
            allowed.append('mcp-orgo-agent')
    return config


def patch_team_boundary(text: str) -> str:
    marker = '        def boundary(tool_name,**kwargs):\n'
    if '# orgo-owner-computer-access' in text:
        return text
    if marker not in text:
        raise ValueError('Unknown team boundary format; no permissions were changed')
    return text.replace(marker, marker + (
        '            # orgo-owner-computer-access: desktop only, never scheduled workers.\n'
        '            from gateway.session_context import get_session_env\n'
        '            if (get_session_env("HERMES_SESSION_SOURCE", "") == "desktop"\n'
        '                    and not os.environ.get("HERMES_KANBAN_TASK")\n'
        '                    and tool_name in {"mcp__orgo_agent__orgo_agent_run", "tool_search", "tool_describe"}):\n'
        '                return None\n'
    ), 1)


def install(runtime: Path, computer_id: str, profiles: list[str]) -> dict:
    runtime = runtime.resolve()
    if not runtime.is_relative_to(Path('/root/.hermes/desktop-runtime')):
        raise ValueError('Install only into a prepared cloud runtime')
    if not (runtime / 'hermes_cli/orgo_codex_worker.py').is_file():
        raise ValueError('Prepared runtime is missing the subscription worker')
    base = root()
    bind(computer_id)
    python = runtime / '.venv/bin/python'
    if not python.is_file():
        raise ValueError('Prepared runtime Python is unavailable')
    # Preflight every target before any configuration change.
    updates: dict[Path, str] = {}
    for profile in profiles:
        if not PROFILE.fullmatch(profile):
            raise ValueError('Invalid agent profile')
        home = Path('/root/.hermes') if profile == 'default' else Path('/root/.hermes/profiles') / profile
        config_file = home / 'config.yaml'
        # This is a write-back round-trip: preserve raw provider placeholders
        # and user settings, without expanding secrets or persisting defaults.
        if not config_file.is_file():
            raise FileNotFoundError(f'Prepared profile configuration is missing: {config_file}')
        config = read_user_config_raw(config_file)
        updates[config_file] = yaml.safe_dump(update_config(config, computer_id, profile, base), sort_keys=False, allow_unicode=True)
        soul = home / 'SOUL.md'
        text = soul.read_text(encoding='utf-8') if soul.exists() else ''
        if POLICY_START in text:
            start, end = text.index(POLICY_START), text.index(POLICY_END) + len(POLICY_END)
            text = text[:start] + text[end:]
        updates[soul] = text.rstrip() + '\n\n' + POLICY + '\n'
        plugin = home / 'plugins/agent-team/__init__.py'
        if plugin.exists():
            updates[plugin] = patch_team_boundary(plugin.read_text(encoding='utf-8'))
    prefix = f'#!/bin/sh\nset -eu\nexport PYTHONPATH={shlex.quote(str(runtime))}\nexport PATH=/root/.hermes/codex-worker/node_modules/.bin:/usr/local/bin:/usr/bin:/bin\n'
    for name, module in [('worker', 'hermes_cli.orgo_agent_mcp'), ('control', 'hermes_cli.orgo_screens'), ('native', 'hermes_cli.orgo_native_mcp'), ('hermes', 'hermes_cli.main')]:
        updates[base / name] = prefix + f'exec {shlex.quote(str(python))} -m {module} "$@"\n'
    updates[base / 'runtime.json'] = json.dumps({'runtime': str(runtime), 'computerId': computer_id, 'model': 'gpt-5.6-luna'})
    backup = Path(tempfile.mkdtemp(prefix='rollback-', dir=base))
    receipt = {'runtime': str(runtime), 'computerId': computer_id, 'profiles': profiles, 'files': []}
    for index, (path, text) in enumerate(updates.items()):
        saved = backup / str(index)
        existed = path.exists()
        if existed:
            shutil.copy2(path, saved)
            saved.chmod(0o600)
        receipt['files'].append({'path': str(path), 'backup': str(saved) if existed else None})
    write_json(backup / 'receipt.json', receipt)
    for path, text in updates.items():
        staging = path.with_name(path.name + '.subscription-tmp')
        staging.write_text(text, encoding='utf-8')
        staging.chmod(0o700 if path.parent == base and path.name != 'runtime.json' else 0o600)
        staging.replace(path)
    return {'installed': True, 'runtime': str(runtime), 'profiles': profiles, 'rollbackReceipt': str(backup / 'receipt.json'), 'gatewayRestarted': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--computer-id', required=True)
    parser.add_argument('--profiles', nargs='+', required=True)
    args = parser.parse_args()
    print(json.dumps(install(args.runtime, args.computer_id, args.profiles)))


if __name__ == '__main__':
    main()
