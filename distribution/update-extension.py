"""Update an existing Studio extension, preserving Hermes and computer identity.

Run --check first. --apply drains only Studio's connector, checks its durable
queue again, then updates its extension with file/database backups and rollback.
The source is a reviewed release unpacked by the installation assistant.
"""
import argparse
import ast
import hashlib
import json
import os
import plistlib
from pathlib import Path
import sqlite3
import subprocess
import time
import uuid


def launch_updates(configuration, target):
    changes = {}
    for name in ['runtime', 'connector']:
        label = 'com.jbellsolutions.grokish-studio.' + name
        path = Path.home()/'Library/LaunchAgents'/(label+'.plist')
        original = path.read_bytes(); value = plistlib.loads(original)
        argv = value.get('ProgramArguments', [])
        if value.get('Label') != label or len(argv) != 4 or Path(argv[1]).resolve() != target/'distribution/local-launch.py' or Path(argv[2]).resolve() != configuration or argv[3] != name:
            raise RuntimeError('The existing Mac service does not belong to this Studio installation')
        value['ProcessType'] = 'Interactive'
        changes[path] = (original, plistlib.dumps(value))
    return changes


def verify_runtime(cfg):
    """Verify the authenticated extension before reopening its cloud connector."""
    from urllib.parse import urlencode
    from websockets.sync.client import connect
    token = Path(cfg['hermesTokenFile']).read_text().strip()
    url = cfg['hermesUrl'].rstrip('/').replace('http:', 'ws:')
    last_error = 'NoCapabilityResponse'
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            with connect(url + '/api/ws?' + urlencode({'token': token}),
                         origin=cfg.get('hermesOrigin', 'http://localhost:8787'), open_timeout=2) as ws:
                request = uuid.uuid4().hex
                ws.send(json.dumps({'jsonrpc': '2.0', 'id': request, 'method': 'studio.capabilities', 'params': {}}))
                response_deadline = time.monotonic() + 3
                while time.monotonic() < response_deadline:
                    message = json.loads(ws.recv(timeout=max(.01, response_deadline-time.monotonic())))
                    if message.get('id') != request: continue
                    result = message.get('result', {})
                    if result.get('sessionRecovery') and result.get('profileSettings'): return
                    raise RuntimeError('The installed extension did not report the required capabilities')
        except Exception as exc:
            last_error = type(exc).__name__
            time.sleep(.5)
    raise RuntimeError('The updated Studio runtime failed its readiness check ('+last_error+')')


def payload(source, target, kind):
    names = sorted(str(p.relative_to(source)) for p in (source/'studio').glob('*.py'))
    names += ['distribution/local-launch.py'] if kind == 'local' else [
        'hermes_cli/orgo_screens.py', 'hermes_cli/orgo_screen_mcp.py', 'distribution/screen-control.py']
    if not names or 'studio/cloud_connector.py' not in names:
        raise ValueError('This release has no Studio extension')
    result = {}
    for name in names:
        src, dest = source/name, target/name
        if src.resolve() != src or dest.resolve() != dest or not src.is_file():
            raise ValueError('Linked or missing extension files cannot be updated')
        data = src.read_bytes(); ast.parse(data, filename=name)
        result[name] = data
    return result


def pending(path):
    if not path.is_file(): raise RuntimeError('The existing Studio task store could not be verified')
    with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as db:
        return db.execute("SELECT count(*) FROM deliveries WHERE state IN ('queued','starting','running')").fetchone()[0]


def update(configuration, source, apply=False):
    cfg = json.loads(configuration.read_text())
    home, target = Path(cfg['hermesHome']).resolve(), Path(cfg['sourceDir']).resolve()
    kind = cfg.get('kind', 'orgo')
    binding = home / ('studio-cloud/local-computer.json' if kind == 'local' else 'orgo-computer/computer.json')
    if json.loads(binding.read_text()).get('computerId') != cfg['computerId']:
        raise RuntimeError('Computer identity mismatch')
    files = payload(source.resolve(), target, kind)
    launch_files = launch_updates(configuration, target) if kind == 'local' else {}
    task_store = home/('studio/workspace.sqlite3' if kind == 'local' else 'studio-cloud/runtime/workspace.sqlite3')
    queued = pending(task_store)
    result = {'computerId': cfg['computerId'], 'files': len(files), 'pendingTasks': queued,
              'ready': queued == 0, 'revision': 'screens-recovery-1'}
    if not apply: return result
    if queued: raise RuntimeError('Studio has accepted work. Wait for it to finish before updating')
    os.umask(0o077)
    base = configuration.parent
    lock = (base/'extension-update.lock').open('a+')
    import fcntl
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    backup = base/'extension-backups'/(time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8])
    backup.mkdir(parents=True, mode=0o700)
    old = {name: (target/name).read_bytes() if (target/name).exists() else None for name in files}
    for name, data in old.items():
        if data is not None:
            p = backup/'source'/name;p.parent.mkdir(parents=True, exist_ok=True);p.write_bytes(data)
    for path, (original, _) in launch_files.items():
        (backup/path.name).write_bytes(original)
    def control(action, name):
        if kind == 'local':
            label = 'com.jbellsolutions.grokish-studio.' + name
            domain = 'gui/' + str(os.getuid())
            args = ['/bin/launchctl','bootout',domain+'/'+label] if action == 'stop' else [
                '/bin/launchctl','bootstrap',domain,str(Path.home()/'Library/LaunchAgents'/(label+'.plist'))]
        else: args = ['supervisorctl',action,'unified-studio-'+name]
        attempts = 20 if action == 'start' else 1
        for attempt in range(attempts):
            command = subprocess.run(args, capture_output=True)
            if command.returncode == 0: return
            if attempts > 1: time.sleep(.5)
        raise RuntimeError('Studio '+name+' could not '+action+'. Backup: '+str(backup))
    stopped = []
    replaced = False
    started = []
    try:
        control('stop', 'connector'); stopped.append('connector')
        if pending(task_store): raise RuntimeError('Work arrived while draining. Update deferred; nothing was replaced')
        control('stop', 'runtime'); stopped.append('runtime')
        for dbpath in [task_store, Path(cfg['stateDir'])/'connector.sqlite']:
            with sqlite3.connect(dbpath.as_uri()+'?mode=ro', uri=True) as src, sqlite3.connect(backup/dbpath.name) as dest:
                src.backup(dest)
                if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise RuntimeError('Backup verification failed')
        for name, data in files.items():
            replaced = True
            dest = target/name;dest.parent.mkdir(parents=True, exist_ok=True)
            temp = dest.with_suffix('.studio-update');temp.write_bytes(data);temp.replace(dest)
        for path, (_, data) in launch_files.items():
            temp = path.with_suffix('.studio-update');temp.write_bytes(data);temp.replace(path)
        record = {'revision': result['revision'], 'computerId': cfg['computerId'],
                  'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        (backup/'manifest.json').write_text(json.dumps(record))
        control('start', 'runtime'); stopped.remove('runtime'); started.append('runtime')
        verify_runtime(cfg)
        control('start', 'connector'); stopped.remove('connector'); started.append('connector')
        result.update({'updated': True, 'backup': str(backup)})
        return result
    except BaseException:
        if replaced:
            for name in reversed(started):
                control('stop', name); stopped.append(name)
            for name, data in old.items():
                dest = target/name
                if data is None: dest.unlink(missing_ok=True)
                else: dest.write_bytes(data)
            for path, (original, _) in launch_files.items(): path.write_bytes(original)
        raise
    finally:
        for name in ['runtime','connector']:
            if name in stopped: control('start', name)
        lock.close()


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--source', type=Path, required=True)
    mode=p.add_mutually_exclusive_group(required=True);mode.add_argument('--check',action='store_true');mode.add_argument('--apply',action='store_true')
    args=p.parse_args()
    print(json.dumps(update(args.config.resolve(),args.source,args.apply)))
