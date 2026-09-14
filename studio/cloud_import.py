"""Versioned one-way Hermes imports, never a raw copy of a credential home."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import sqlite3
import tempfile
import time
import yaml

PROFILE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')
FORBIDDEN = {'.env', 'auth.json', 'credentials.json', 'secrets.json', 'token', 'tokens.json'}
IGNORED = {'node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', 'state-snapshots'}
MAX_TOTAL = 40 * 1024 * 1024


def digest(data):
    h = hashlib.sha256()
    if isinstance(data, Path):
        with data.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
    else: h.update(data)
    return h.hexdigest()


def allowed(path):
    return not any(part in IGNORED or part.lower() in FORBIDDEN or part.lower().startswith('.env')
                   or part.lower().endswith(('.pem', '.key', '.p12', '.pfx')) for part in path.parts)


def safe_settings(value):
    """Preserve preferences, not host paths, connection bindings or credentials."""
    result = {}
    model = value.get('model') or {}
    if isinstance(model, dict):
        result['model'] = {k: model[k] for k in ('default', 'provider', 'max_tokens', 'temperature') if k in model}
    elif isinstance(model, str):
        result['model'] = model
    for key in ('personality', 'reasoning_effort'):
        if isinstance(value.get(key), (str, int, float, bool)):
            result[key] = value[key]
    for key, fields in {'display': ('personality',), 'agent': ('max_turns',),
                        'compression': ('enabled', 'threshold')}.items():
        if isinstance(value.get(key), dict):
            result[key] = {k: value[key][k] for k in fields if k in value[key]}
    for key in ('toolsets',):
        if isinstance(value.get(key), list):
            result[key] = [x for x in value[key] if isinstance(x, str)]
    # Tool grants are portable preferences. Dropping a narrow platform/tools
    # selection would fall back to Hermes defaults and broaden the import.
    for key in ('tools', 'platform_toolsets', 'agent'):
        settings = value.get(key)
        if not isinstance(settings, dict): continue
        fields = settings if key == 'platform_toolsets' else (
            ('enabled_toolsets',) if key == 'tools' else ('disabled_toolsets',))
        for field in fields:
            if isinstance(settings.get(field), list):
                result.setdefault(key, {})[field] = [x for x in settings[field] if isinstance(x, str)]
    result['terminal'] = {'backend': 'local', 'cwd': '~/studio-projects'}
    return result


def build_bundle(source: Path, computer_id: str, profiles=None, _sink=None):
    source = source.resolve()
    source_id = digest((platform.node() + '\n' + str(source)).encode())[:24]
    names = profiles or ['default'] + sorted(p.name for p in (source / 'profiles').glob('*')
                                             if p.is_dir() and not p.is_symlink())
    bundle = {'version': 1, 'sourceId': source_id, 'computerId': computer_id,
              'created': time.time(), 'source': {'hostname': platform.node(), 'platform': platform.system(), 'hermesHome': str(source)}, 'profiles': {}, 'warnings': []}
    total = 0
    with tempfile.TemporaryDirectory(prefix='studio-import-') as temp:
        for name in names:
            if not PROFILE.fullmatch(name):
                raise ValueError('Invalid source profile')
            root = source if name == 'default' else source / 'profiles' / name
            if root.is_symlink() or not (root / 'config.yaml').is_file():
                continue
            config = yaml.safe_load((root / 'config.yaml').read_text()) or {}
            files = {}
            def add(relative, data, mode=0o644):
                nonlocal total
                total += data.stat().st_size if isinstance(data, Path) else len(data)
                if total > (16 * 1024**3 if _sink else MAX_TOTAL):
                    raise ValueError('Import is larger than 40 MB. Export selected profiles separately.')
                if _sink:
                    files[relative] = _sink(name, relative, data, mode)
                else:
                    if isinstance(data, Path): data = data.read_bytes()
                    files[relative] = {'sha256': digest(data), 'data': base64.b64encode(data).decode(), 'mode': mode}
            add('config.yaml', yaml.safe_dump(safe_settings(config)).encode())
            for filename in ('SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md'):
                file = root / filename
                if file.is_file() and not file.is_symlink():
                    add(filename, file.read_bytes())
            meta = root / 'profile.yaml'
            if meta.is_file() and not meta.is_symlink():
                value = yaml.safe_load(meta.read_text()) or {}
                add('profile.yaml', yaml.safe_dump({k: value[k] for k in ('name', 'description') if k in value}).encode())
            for folder in ('skills', 'memories', 'memory'):
                tree = root / folder
                if not tree.is_dir() or tree.is_symlink():
                    continue
                for current, dirs, filenames in os.walk(tree, followlinks=False):
                    dirs[:] = [d for d in dirs if d not in IGNORED and not (Path(current) / d).is_symlink()]
                    for filename in filenames:
                        file = Path(current) / filename
                        rel = file.relative_to(root)
                        if file.is_symlink() or not allowed(rel):
                            continue
                        if not _sink and file.stat().st_size > 4 * 1024 * 1024:
                            bundle['warnings'].append(f'{name}/{rel}: large helper asset omitted')
                            continue
                        add(rel.as_posix(), file, 0o755 if file.stat().st_mode & 0o111 else 0o644)
            dbpath = root / 'state.db'
            if dbpath.is_file() and not dbpath.is_symlink():
                copy = Path(temp) / (name + '.db')
                src = sqlite3.connect(dbpath.as_uri() + '?mode=ro', uri=True)
                dst = sqlite3.connect(copy)
                try:
                    src.backup(dst)
                    if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise ValueError('History snapshot failed integrity verification')
                finally:
                    src.close(); dst.close()
                add('state.db', copy, 0o600)
                copy.unlink()
            for key in ('mcp_servers', 'cron', 'gateway'):
                if config.get(key):
                    bundle['warnings'].append(f'{name}: {key} requires destination setup; source connection settings were excluded')
            if config.get('terminal', {}).get('backend') not in (None, 'local'):
                bundle['warnings'].append(f'{name}: terminal backend changed to this Linux computer')
            if config.get('mcp_servers'):
                bundle['warnings'].append(f'{name}: review imported skills for macOS-only programs; imported scripts have not run')
            bundle['profiles'][name] = {'files': files}
    return bundle


def atomic_write(file, data, mode=0o600):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if file.resolve() != file.absolute():
        raise ValueError('Linked import paths are not supported')
    if isinstance(data, Path) and data.stat().st_dev == file.parent.stat().st_dev:
        data.chmod(mode)
        os.replace(data, file)
        directory = os.open(file.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
        return
    fd, temporary = tempfile.mkstemp(prefix='.import-', dir=file.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            if isinstance(data, Path):
                with data.open('rb') as source: shutil.copyfileobj(source, stream, 1024 * 1024)
            else: stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        directory = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_history(path):
    """Verify a staged copy using the destination SQLite, rebuilding only a
    known version-sensitive derived trigram index. Authoritative rows are kept.
    See NousResearch/hermes-agent#69672; never repair the source/live database.
    """
    notes=[]
    db=sqlite3.connect(path)
    try:
        errors=[r[0] for r in db.execute('PRAGMA integrity_check')]
        expected='malformed inverted index for FTS5 table main.messages_fts_trigram'
        if errors != ['ok'] and errors and all(x == expected for x in errors):
            for table in ('sessions','messages'):
                if [r[0] for r in db.execute('PRAGMA integrity_check(' + table + ')')] != ['ok']:
                    raise ValueError('Imported history has a damaged authoritative table')
            before=tuple(db.execute('SELECT (SELECT count(*) FROM sessions),(SELECT count(*) FROM messages)').fetchone())
            # This unpublished temporary copy is discarded on any failure. A
            # multi-GB rollback journal for a regenerable index can exhaust a
            # small computer; the verified original archive remains untouched.
            journal=db.execute('PRAGMA journal_mode').fetchone()[0]
            db.execute('PRAGMA journal_mode=OFF')
            db.execute("INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild')")
            db.commit()
            if journal.upper() in {'DELETE','TRUNCATE','PERSIST','MEMORY','WAL','OFF'}:
                db.execute('PRAGMA journal_mode='+journal)
            after=tuple(db.execute('SELECT (SELECT count(*) FROM sessions),(SELECT count(*) FROM messages)').fetchone())
            if before != after: raise ValueError('History records changed during index conversion')
            errors=[r[0] for r in db.execute('PRAGMA integrity_check')]
            notes.append('Rebuilt the imported search index for destination SQLite ' + sqlite3.sqlite_version + '; original history rows preserved')
        if errors != ['ok']: raise ValueError('Imported history failed integrity verification')
        db.execute('SELECT id FROM sessions LIMIT 0')
        db.execute('SELECT id,session_id,role,content FROM messages LIMIT 0')
        return notes
    finally: db.close()


def apply_bundle(home: Path, computer_id: str, bundle: dict, busy_profiles=(), _archive_root=None):
    if bundle.get('version') != 1 or bundle.get('computerId') != computer_id:
        raise ValueError('Import destination does not match this computer')
    source_id = bundle.get('sourceId', '')
    if not re.fullmatch(r'[a-f0-9]{24}', source_id):
        raise ValueError('Invalid import source identity')
    home = home.resolve()
    base = home / 'studio' / 'imports'
    profile_root = home / 'profiles'
    for root in (base, profile_root):
        if root.resolve() != root:
            raise ValueError('Linked import destinations are not supported')
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    import fcntl
    with (base / 'import.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if bundle.get('scope') == 'skills':
            from .cloud_skills import apply_locked
            return apply_locked(home, computer_id, bundle, set(busy_profiles), _archive_root)
        if bundle.get('scope') not in (None, 'profiles'):
            raise ValueError('Unsupported import scope')
        return _apply_locked(home, computer_id, bundle, set(busy_profiles), _archive_root)


def _apply_locked(home, computer_id, bundle, busy_profiles, archive_root=None):
    source_id = bundle['sourceId']
    base = home / 'studio' / 'imports'
    profile_root = home / 'profiles'
    manifest = base / (source_id + '.json')
    if manifest.is_symlink():
        raise ValueError('Linked import records are not supported')
    previous = json.loads(manifest.read_text()) if manifest.exists() else {'profiles': {}}
    previous['sourceId'] = source_id
    previous['source'] = bundle.get('source', previous.get('source', {}))
    total = 0
    checked = {}
    compatibility = []
    for name, profile in bundle.get('profiles', {}).items():
        if not PROFILE.fullmatch(name):
            raise ValueError('Invalid profile name')
        checked[name] = {}
        for key, item in profile.get('files', {}).items():
            relative = PurePosixPath(key)
            if not relative.parts or relative.is_absolute() or '..' in relative.parts or '\\' in key or not allowed(relative):
                raise ValueError('Unsafe import path')
            top = relative.parts[0]
            if top not in {'config.yaml', 'profile.yaml', 'SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md', 'state.db', 'skills', 'memories', 'memory'}:
                raise ValueError('Unsupported import file')
            if top not in {'skills', 'memories', 'memory'} and len(relative.parts) != 1:
                raise ValueError('Unsupported nested import file')
            data = archive_root / name / key if archive_root else base64.b64decode(item['data'], validate=True)
            total += data.stat().st_size if isinstance(data, Path) else len(data)
            if total > (16 * 1024**3 if archive_root else MAX_TOTAL) or digest(data) != item['sha256']:
                raise ValueError('Import size or checksum verification failed')
            if key == 'config.yaml':
                value = yaml.safe_load(data.read_bytes() if isinstance(data, Path) else data) or {}
                if not isinstance(value, dict):
                    raise ValueError('Invalid profile configuration')
                data = yaml.safe_dump(safe_settings(value)).encode()
            if key == 'state.db':
                with tempfile.TemporaryDirectory() as tmp:
                    dbfile = data if isinstance(data, Path) else Path(tmp) / 'history.db'
                    if not isinstance(data, Path): dbfile.write_bytes(data)
                    compatibility.extend(validate_history(dbfile))
                    if not isinstance(data, Path): data = dbfile.read_bytes()
            checked[name][key] = (data, 0o755 if item.get('mode', 0) & 0o111 else 0o600)
        if 'config.yaml' not in checked[name]:
            raise ValueError('Every imported profile must have a configuration')
    for name in checked:
        if previous['profiles'].get(name, {}).get('target') in busy_profiles:
            raise ValueError('An imported agent is currently working. Retry after its turn finishes.')
    result = {'profiles': [], 'conflicts': [], 'warnings': list(bundle.get('warnings', [])) + compatibility}
    def save():
        previous['updated'] = time.time()
        atomic_write(manifest, json.dumps(previous).encode())
    for name, files in checked.items():
        record = previous['profiles'].get(name)
        if record is None:
            import uuid
            target = 'imported-' + name[:30] + '-' + uuid.uuid4().hex[:10]
            record = {'target': target, 'hashes': {}, 'sourceComputerId': computer_id}
            previous['profiles'][name] = record
            # Reserve identity durably before touching files; crashes resume it.
            save()
        target = record['target']
        if not PROFILE.fullmatch(target):
            raise ValueError('Invalid saved import mapping')
        dest = profile_root / target
        if dest.resolve() != dest:
            raise ValueError('Linked destinations cannot be imported into')
        dest.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Publish configuration last so an incomplete first import is not an agent.
        for key in sorted(files, key=lambda k: k == 'config.yaml'):
            data, mode = files[key]
            file = dest / key
            if file.resolve() != file:
                raise ValueError('Linked destination files cannot be updated')
            source_hash=bundle['profiles'][name]['files'][key]['sha256']
            source_hashes=record.setdefault('sourceHashes',{})
            # The imported database may have a destination-specific search
            # index and subsequent cloud messages. Compare the Mac source hash
            # as well as the installed version; never invent an update because
            # a derived index was rebuilt using another SQLite version.
            if file.exists() and source_hashes.get(key)==source_hash:continue
            new_hash = digest(data)
            old_hash = record['hashes'].get(key)
            if file.exists():
                current_hash = digest(file)
                if current_hash == new_hash:
                    record['hashes'][key] = new_hash; source_hashes[key]=source_hash; save(); continue
                if old_hash == new_hash:
                    source_hashes[key]=source_hash; save()
                    continue
                # Never replace a history database already opened on Orgo.
                # Keep additional source snapshots with provenance for browsing.
                if key == 'state.db' or current_hash != old_hash:
                    conflict = base / source_id / target / (key + '.' + new_hash[:10] + '.incoming')
                    atomic_write(conflict, data)
                    source_hashes[key]=source_hash; save()
                    result['conflicts'].append({'profile': target, 'file': key, 'incoming': str(conflict)})
                    continue
                backup = base / source_id / target / (key + '.' + current_hash[:10] + '.previous')
                atomic_write(backup, file.read_bytes())
            # A crash between replacement and manifest save is harmless: the
            # identical-content check above reconciles it on the next import.
            atomic_write(file, data, mode)
            record['hashes'][key] = new_hash
            source_hashes[key]=source_hash
            save()
        result['profiles'].append({'source': name, 'target': target})
    return result


def main():
    parser = argparse.ArgumentParser(description='Export a private Hermes import for one Orgo computer')
    parser.add_argument('--source', type=Path, default=Path.home() / '.hermes')
    parser.add_argument('--computer', required=True)
    parser.add_argument('--profile', action='append')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--archive', action='store_true', help='Create a streamed ZIP for large histories')
    args = parser.parse_args()
    if args.archive:
        from .cloud_archive import build_archive
        path, bundle = build_archive(args.source, args.computer, args.output, args.profile)
        print(f'Exported {len(bundle["profiles"])} profiles to {path}; credentials excluded.')
        return
    bundle = build_bundle(args.source, args.computer, args.profile)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as file:
        os.chmod(args.output, 0o600)
        json.dump(bundle, file)
    print(f'Exported {len(bundle["profiles"])} profiles; {len(bundle["warnings"])} compatibility notes. Credentials excluded.')


if __name__ == '__main__':
    main()
