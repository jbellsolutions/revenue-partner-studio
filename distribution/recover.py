"""Bounded Studio connector recovery. Never installs or restarts Hermes.

Accepts one small JSON request on stdin. The same entry point is used over the
Orgo API and by a forced-command SSH key; no caller-supplied shell is executed.
"""
from pathlib import Path
import configparser
import fcntl
import hashlib
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse
import uuid

HOME = Path('/root/.hermes')
CONF = Path('/etc/supervisor/conf.d/unified-studio.conf')
PROTOCOL = 1


def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=12, check=False)


def atomic(path, value):
    temp = path.with_suffix('.tmp')
    with temp.open('w') as out:
        os.fchmod(out.fileno(), 0o600)
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())
    temp.replace(path)


def inspect(computer, origin, home=HOME, conf=CONF):
    state = home / 'studio-cloud'
    def result(code, **extra):
        return {'protocol': PROTOCOL, 'computerId': computer, 'code': code, **extra}
    config = state / 'connector.json'
    if not config.is_file(): return result('not_installed')
    # Do not adopt paths or services owned by another installation.
    if config.is_symlink() or conf.is_symlink(): return result('ownership_unknown')
    c = json.loads(config.read_text())
    binding = home / 'orgo-computer/computer.json'
    if (c.get('computerId') != computer or c.get('cloudUrl') != origin or
            c.get('hermesHome') != str(home) or c.get('stateDir') != str(state / 'connector') or
            not binding.is_file() or json.loads(binding.read_text()).get('computerId') != computer):
        return result('ownership_unknown')
    if (state / 'access-paused').exists() or (state / 'recovery-disabled').exists(): return result('paused')
    services = configparser.RawConfigParser()
    services.read(conf)
    if not services.has_section('program:unified-studio-connector') or not services.has_section('program:unified-studio-runtime'):
        return result('ownership_unknown')
    command = shlex.split(services.get('program:unified-studio-connector', 'command'))
    expected = [c.get('python'), '-m', 'studio.cloud_connector', '--config', str(config)]
    if command != expected or services.get('program:unified-studio-runtime', 'command') != str(state / 'serve'):
        return result('ownership_unknown')
    output = run(['supervisorctl', 'status', 'unified-studio-connector', 'unified-studio-runtime'])
    states = {parts[0]: parts[1] for line in output.stdout.splitlines() if len(parts := line.split()) >= 2}
    connector, runtime = states.get('unified-studio-connector'), states.get('unified-studio-runtime')
    if runtime != 'RUNNING': return result('runtime_unavailable')
    # Process liveness is preliminary; authenticated RPC and stored-conversation
    # reconciliation in the gateway are still required after connection returns.
    endpoint = urlparse(c.get('hermesUrl', ''))
    if endpoint.scheme != 'http' or endpoint.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        return result('ownership_unknown')
    try:
        req = urllib.request.Request(c['hermesUrl'].rstrip('/') + '/api/health',
            headers={'Authorization': 'Bearer ' + Path(c['hermesTokenFile']).read_text().strip()})
        with urllib.request.urlopen(req, timeout=3) as response:
            if json.load(response).get('ok') is not True: return result('runtime_unavailable')
    except Exception: return result('runtime_unavailable')
    if connector in {'RUNNING', 'STARTING', 'BACKOFF'}: return result('connector_running')
    # STOPPED can mean an intentional owner stop. Automatic repair preserves it.
    if connector == 'STOPPED': return result('paused')
    if connector not in {'EXITED', 'FATAL'}: return result('ownership_unknown')
    lockpath = state / 'connector/connector.lock'
    if not lockpath.is_file() or lockpath.is_symlink(): return result('ownership_unknown')
    with lockpath.open('r+') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return result('ownership_unknown')
    # Refuse an unmanaged connector even if Supervisor's process table is stale.
    for proc in Path('/proc').glob('[0-9]*/cmdline'):
        try: args = proc.read_bytes().split(b'\0')
        except (FileNotFoundError, ProcessLookupError): continue
        if b'studio.cloud_connector' in args and str(config).encode() in args:
            return result('ownership_unknown')
    return result('connector_failed')


def dispatch(request, home=HOME, conf=CONF):
    computer = str(uuid.UUID(request['computerId']))
    origin = request['origin']
    if not isinstance(origin, str) or len(origin) > 500: raise ValueError('Invalid origin')
    action = request['action']
    if action not in {'inspect', 'repair'}: raise ValueError('Unknown operation')
    rid = str(uuid.UUID(request['requestId']))
    if action == 'inspect': return inspect(computer, origin, home, conf)
    directory = home / 'studio-cloud/recovery'
    # Identity/intent is checked before writing anything on an unfamiliar host.
    current = inspect(computer, origin, home, conf)
    if current['code'] not in {'connector_failed', 'connector_running'}: return current
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory / 'repair.lock').open('a+') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return {**current, 'code': 'repair_busy'}
        receipt = directory / (rid + '.json')
        digest = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        if receipt.exists():
            saved = json.loads(receipt.read_text())
            if saved.get('digest') != digest: raise ValueError('Request identity conflict')
            # A lost acknowledgment is reconciled, never replayed.
            return {**saved['result'], 'replayed': True}
        current = inspect(computer, origin, home, conf)
        if current['code'] != 'connector_failed': return current
        recent = 0
        for file in directory.glob('*.json'):
            data = json.loads(file.read_text())
            if data.get('at', 0) > time.time() - 600: recent += 1
        if recent >= 2: return {**current, 'code': 'attempt_limit'}
        data = {'digest': digest, 'at': time.time(), 'result': {**current, 'code': 'repair_uncertain'}}
        atomic(receipt, data)  # Commit intent before the one permitted side effect.
        try:
            changed = run(['supervisorctl', 'start', 'unified-studio-connector'])
            code = 'awaiting_connection' if changed.returncode == 0 else 'repair_uncertain'
        except subprocess.TimeoutExpired: code = 'repair_uncertain'
        data['result'] = {**current, 'code': code}
        atomic(receipt, data)
        return data['result']


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096: raise ValueError('Request too large')
        # An SSH key invoking this as a forced command cannot run a remote shell.
        if os.environ.get('SSH_ORIGINAL_COMMAND') not in {None, '', 'studio-recovery'}:
            raise ValueError('Only Studio recovery is supported')
        print(json.dumps(dispatch(json.loads(raw))))
    except Exception:
        print(json.dumps({'protocol': PROTOCOL, 'code': 'inspection_failed'}))
        sys.exit(1)
