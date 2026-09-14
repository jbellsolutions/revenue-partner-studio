"""Bounded, resumable imports. Archive contents are data and are never executed."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import zipfile
from .cloud_import import build_bundle, apply_bundle, digest, atomic_write, PROFILE, allowed

MAX_ARCHIVE = 4 * 1024**3
MAX_EXPANDED = 16 * 1024**3
CHUNK = 1024 * 1024


def build_archive(source, computer, output, profiles=None):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists(): raise ValueError('Export already exists')
    with output.open('xb') as raw:
        os.chmod(output, 0o600)
        with zipfile.ZipFile(raw, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
            def add(name, relative, data, mode):
                key = name + '/' + relative
                size = data.stat().st_size if isinstance(data, Path) else len(data)
                checksum = digest(data)
                if isinstance(data, Path): archive.write(data, key)
                else: archive.writestr(key, data)
                return {'sha256': checksum, 'size': size, 'mode': mode}
            try:
                bundle = build_bundle(source, computer, profiles, _sink=add)
            except BaseException:
                # Never leave a partial export that appears ready to import or
                # prevents retrying a read-only snapshot after a transient error.
                output.unlink()
                raise
            archive.writestr('manifest.json', json.dumps(bundle))
    checksum = digest(output)
    final = output.with_name(output.stem + '-' + checksum + '.studio.zip')
    output.rename(final)
    return final, bundle


def apply_archive(home, computer, archive_path, busy_profiles=()):
    home = Path(home).resolve()
    base = home / 'studio-cloud' / 'uploads'
    archive_path = Path(archive_path)
    if archive_path.resolve() != archive_path or archive_path.parent != base or archive_path.suffix != '.zip':
        raise ValueError('Archive must be a completed upload on this computer')
    with zipfile.ZipFile(archive_path) as archive:
        info = archive.getinfo('manifest.json')
        if info.file_size > 8 * 1024 * 1024: raise ValueError('Archive manifest is too large')
        bundle = json.loads(archive.read(info))
        if bundle.get('computerId') != computer: raise ValueError('Import destination mismatch')
        expected = {'manifest.json'}
        for name, profile in bundle.get('profiles', {}).items():
            if not PROFILE.fullmatch(name): raise ValueError('Invalid profile name')
            for key in profile.get('files', {}):
                path = Path(key)
                if path.is_absolute() or '..' in path.parts or '\\' in key or not allowed(path):
                    raise ValueError('Unsafe archive path')
                expected.add(name + '/' + key)
        entries = archive.infolist()
        if len(entries) != len(expected) or {x.filename for x in entries} != expected:
            raise ValueError('Archive entries do not match its manifest')
        size = sum(x.file_size for x in entries)
        if size > MAX_EXPANDED or size + 512 * 1024**2 > shutil.disk_usage(base).free:
            raise ValueError('Not enough free space for this import and a 512 MB reserve')
        with tempfile.TemporaryDirectory(prefix='expanded-', dir=base) as temp:
            root = Path(temp)
            for item in entries:
                if item.filename == 'manifest.json': continue
                if item.is_dir() or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Linked archive entries are not supported')
                path = root / item.filename
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, path.open('xb') as target:
                    os.chmod(path, 0o600)
                    shutil.copyfileobj(source, target, CHUNK)
                    target.flush(); os.fsync(target.fileno())
            return apply_bundle(home, computer, bundle, busy_profiles, _archive_root=root)


class Uploads:
    def __init__(self, home, computer):
        self.base = Path(home) / 'studio-cloud' / 'uploads'
        if self.base.resolve() != self.base: raise ValueError('Linked upload directory')
        self.base.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.computer = computer

    def record(self, upload):
        if not isinstance(upload, str) or not re.fullmatch(r'[a-f0-9]{64}', upload):
            raise ValueError('Invalid upload identity')
        return self.base / (upload + '.json'), self.base / (upload + '.part')

    def begin(self, size, checksum):
        meta, part = self.record(checksum)
        if not isinstance(size, int) or not 1 <= size <= MAX_ARCHIVE: raise ValueError('Invalid archive size')
        value = {'size': size, 'sha256': checksum, 'computerId': self.computer}
        if meta.exists() and json.loads(meta.read_text()) != value: raise ValueError('Upload identity conflict')
        if not meta.exists():
            if size + 512 * 1024**2 > shutil.disk_usage(self.base).free: raise ValueError('Computer needs more free disk space')
            atomic_write(meta, json.dumps(value).encode())
        complete = self.base / (checksum + '.zip')
        return {'uploadId': checksum, 'offset': complete.stat().st_size if complete.exists() else (part.stat().st_size // CHUNK * CHUNK if part.exists() else 0), 'chunkSize': CHUNK, 'complete': complete.exists()}

    def append(self, upload, offset, encoded, checksum):
        meta, part = self.record(upload)
        value = json.loads(meta.read_text())
        data = base64.b64decode(encoded, validate=True)
        if not isinstance(offset, int) or offset < 0 or offset % CHUNK or not 1 <= len(data) <= CHUNK:
            raise ValueError('Invalid upload chunk')
        if len(data) != min(CHUNK, value['size'] - offset) or digest(data) != checksum:
            raise ValueError('Upload chunk checksum or size mismatch')
        if not part.exists(): atomic_write(part, b'')
        with part.open('r+b') as stream:
            current = stream.seek(0, 2)
            if offset > current: raise ValueError('Upload chunk is out of order')
            stream.seek(offset)
            if current >= offset + len(data):
                if stream.read(len(data)) != data: raise ValueError('Upload chunk conflicts with accepted bytes')
            else:
                stream.write(data); stream.truncate(); stream.flush(); os.fsync(stream.fileno())
        return {'offset': offset + len(data)}

    def finish(self, upload):
        meta, part = self.record(upload)
        value = json.loads(meta.read_text())
        complete = self.base / (upload + '.zip')
        path = complete if complete.exists() else part
        if path.stat().st_size != value['size'] or digest(path) != upload: raise ValueError('Archive verification failed')
        if path == part: os.replace(part, complete)
        return complete
