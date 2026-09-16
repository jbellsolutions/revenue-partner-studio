"""Resumable, computer-local Studio extension update with guarded rollback."""
from pathlib import Path
import hashlib
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value)); temporary.chmod(0o600); temporary.replace(path)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): digest.update(block)
    return digest.hexdigest()


def supervised_python(configuration, current, proc_root=Path('/proc')):
    """Resolve the interpreter from the exact running Studio connector.

    Early Studio connectors did not always persist an absolute ``python``
    field.  The supervised process is the stronger ownership receipt: it must
    be the expected module, use this exact connector configuration and point to
    a real absolute interpreter.  ``update-extension.py`` repeats the complete
    runtime/connector ownership check before replacing any file.
    """
    pid = subprocess.check_output(
        ['supervisorctl', 'pid', 'unified-studio-connector'], text=True, timeout=30
    ).strip()
    if not pid.isdigit() or int(pid) <= 0:
        raise ValueError('Installed Studio Python owner could not be verified.')
    command = (proc_root / pid / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
    if (
        len(command) != 5
        or command[1:4] != ['-m', 'studio.cloud_connector', '--config']
        or Path(command[4]).resolve() != configuration
    ):
        raise ValueError('Installed Studio Python owner could not be verified.')
    python = Path(command[0])
    if not python.is_absolute() or not python.is_file():
        raise ValueError('Installed Studio Python owner could not be verified.')
    saved = current.get('python')
    if saved and Path(saved).resolve() != python.resolve():
        raise ValueError('Installed Studio Python owner could not be verified.')
    return str(python)


def run(configuration):
    configuration = Path(configuration).resolve(); base = configuration.parent
    lock = (base/'update.lock').open('a+')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: return
    request = json.loads(configuration.read_text()); status = base/'status.json'
    if status.exists() and json.loads(status.read_text()).get('state') == 'updated': return
    try:
        computer = request['computerId']; expected = request['sha256']
        connector = Path('/root/.hermes/studio-cloud/connector.json')
        current = json.loads(connector.read_text())
        if current.get('computerId') != computer: raise ValueError('Computer identity mismatch; no update was applied.')
        archive = base/'runtime.tar.gz'
        if not archive.exists() or sha256(archive) != expected:
            with urllib.request.urlopen(request['artifactUrl'], timeout=90) as response, archive.open('wb') as output:
                os.fchmod(output.fileno(), 0o600); shutil.copyfileobj(response, output)
        if sha256(archive) != expected: raise ValueError('Update package checksum mismatch.')
        source = base/('source-'+expected[:16])
        if not (source/'.verified').exists():
            source.mkdir(mode=0o700, exist_ok=True)
            with tarfile.open(archive) as contents:
                for item in contents.getmembers():
                    path = Path(item.name)
                    if path.is_absolute() or '..' in path.parts or not (item.isfile() or item.isdir()):
                        raise ValueError('Unsafe update package.')
                contents.extractall(source)
            (source/'.verified').write_text(expected)
        python = supervised_python(connector.resolve(), current)
        command = [python, str(source/'distribution/update-extension.py'), '--config', str(connector), '--source', str(source)]
        checked = json.loads(subprocess.check_output(command+['--check'], text=True, timeout=120))
        if checked.get('computerId') != computer: raise ValueError('Update preflight returned another computer identity.')
        if not checked.get('ready'):
            atomic(status, {'state':'waiting','detail':'Accepted work is still running. The update will resume without replacing it.',
                            'pendingTasks':checked.get('pendingTasks',0)}); return
        applied = json.loads(subprocess.check_output(command+['--apply'], text=True, timeout=300))
        if not applied.get('updated') or applied.get('computerId') != computer:
            raise RuntimeError('The extension update did not return a verified readiness receipt.')
        atomic(status, {'state':'updated','detail':'Extension updated and readiness verified.',
                        'revision':applied.get('revision'),'backup':applied.get('backup')})
    except Exception as exc:
        # update-extension restores its prior source and services when readiness
        # fails. Keep only a bounded operator-facing error here.
        atomic(status, {'state':'failed','detail':str(exc)[:300]})


if __name__ == '__main__': run(sys.argv[1])
