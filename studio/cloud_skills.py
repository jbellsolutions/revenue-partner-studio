"""Reviewed skill-only copies into an existing profile, using the import ledger.

This module never executes transferred content or edits the destination's profile
configuration, identity, credentials, memory or history. Removed files are kept.
"""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import time
from .cloud_import import PROFILE, MAX_TOTAL, allowed, atomic_write, digest
from .cloud_profiles import profile


def selection(source_profile, skill_ids, target_agent):
    if not isinstance(source_profile, str) or not PROFILE.fullmatch(source_profile):
        raise ValueError('Choose a source Hermes profile')
    if not isinstance(target_agent, str) or not PROFILE.fullmatch(target_agent):
        raise ValueError('Choose an existing destination agent')
    if not isinstance(skill_ids, list) or not 1 <= len(skill_ids) <= 100:
        raise ValueError('Select between one and 100 skills')
    for key in skill_ids:
        if not isinstance(key, str) or len(key) > 500 or not key:
            raise ValueError('Invalid skill identity')
        p = PurePosixPath(key)
        if p.is_absolute() or any(x in ('', '.', '..') for x in key.split('/')) or '\\' in key or not allowed(p):
            raise ValueError('Invalid skill identity')
    if len(set(skill_ids)) != len(skill_ids):
        raise ValueError('Select each skill only once')
    return {'scope': 'skills', 'sourceProfile': source_profile, 'skillIds': sorted(skill_ids), 'targetAgent': target_agent}


def build(source, computer, scope, sink=None):
    source = Path(source).resolve()
    scope = selection(scope['sourceProfile'], scope['skillIds'], scope['targetAgent'])
    root = profile(source, scope['sourceProfile'])
    files = {}; total = 0
    for key in scope['skillIds']:
        tree = root / 'skills' / key
        if tree.resolve() != tree or not (tree / 'SKILL.md').is_file() or (tree / 'SKILL.md').is_symlink():
            raise ValueError('A selected skill is missing or linked. Refresh the list.')
        for current, dirs, names in os.walk(tree, followlinks=False):
            dirs[:] = [d for d in dirs if allowed(Path(d)) and not (Path(current) / d).is_symlink()]
            for name in names:
                file = Path(current) / name; rel = file.relative_to(root).as_posix()
                if file.is_symlink() or not file.is_file() or not allowed(Path(rel)) or rel in files: continue
                total += file.stat().st_size
                if total > MAX_TOTAL: raise ValueError('Selected skills exceed 40 MB. Transfer fewer skills at a time.')
                mode = 0o755 if file.stat().st_mode & 0o111 else 0o600
                # Copy bytes now so source edits cannot change a hash after it is recorded.
                data = file.read_bytes()
                files[rel] = sink(scope['sourceProfile'], rel, data, mode) if sink else {
                    'sha256': digest(data), 'size': len(data), 'mode': mode, 'data': base64.b64encode(data).decode()}
    return {'version': 1, 'computerId': computer, 'sourceId': digest((platform.node() + '\n' + str(source)).encode())[:24],
            **scope, 'created': time.time(), 'source': {'hostname': platform.node(), 'platform': platform.system(), 'hermesHome': str(source)},
            'profiles': {scope['sourceProfile']: {'files': files}},
            'warnings': ['Only selected skills are copied. Existing permissions and removed source files are retained. Review Mac-specific tools before using them on Linux. Scripts have not run.']}


def inspect(home, computer, bundle):
    scope = selection(bundle.get('sourceProfile'), bundle.get('skillIds'), bundle.get('targetAgent'))
    if bundle.get('version') != 1 or bundle.get('computerId') != computer or not re.fullmatch(r'[a-f0-9]{24}', bundle.get('sourceId', '')):
        raise ValueError('Invalid skill import destination or provenance')
    root = profile(home, scope['targetAgent'])
    if set(bundle.get('profiles', {})) != {scope['sourceProfile']}:
        raise ValueError('Skill import contains another profile')
    files = bundle['profiles'][scope['sourceProfile']].get('files', {})
    for key, item in files.items():
        p = PurePosixPath(key)
        if str(p) != key or p.is_absolute() or '..' in p.parts or '\\' in key or not allowed(p) or not any(key.startswith('skills/' + s + '/') for s in scope['skillIds']):
            raise ValueError('Skill import contains an unselected or unsafe file')
        if not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')): raise ValueError('Invalid skill checksum')
        file = root / key
        if file.resolve() != file or (file.exists() and not file.is_file()): raise ValueError('Linked or non-file skill destinations cannot be updated')
    if any('skills/' + s + '/SKILL.md' not in files for s in scope['skillIds']):
        raise ValueError('Each selected skill must include SKILL.md')
    identity = digest(json.dumps([bundle['sourceId'], scope['sourceProfile'], scope['targetAgent']]).encode())
    manifest = Path(home) / 'studio/imports' / ('skills-' + identity + '.json')
    if manifest.resolve() != manifest: raise ValueError('Linked import records are not supported')
    record = json.loads(manifest.read_text()) if manifest.exists() else {'hashes': {}, 'sourceHashes': {}}
    return scope, root, files, manifest, record


def preview(home, computer, bundle):
    scope, root, files, _, record = inspect(home, computer, bundle)
    counts = {'added': 0, 'changed': 0, 'conflicts': 0, 'unchanged': 0}
    roots = [s for s in scope['skillIds'] if not any(s.startswith(other + '/') for other in scope['skillIds'] if s != other)]
    for skill in roots:
        group = {k: v for k, v in files.items() if k.startswith('skills/' + skill + '/')}
        if all((root / k).exists() and record['sourceHashes'].get(k) == v['sha256'] for k, v in group.items()):
            counts['unchanged'] += len(group)
            continue
        conflict = any((root / k).exists() and digest(root / k) not in (v['sha256'], record['hashes'].get(k)) for k, v in group.items())
        if conflict:
            counts['conflicts'] += len(group)
            continue
        for key, item in group.items():
            file = root / key
            if not file.exists(): counts['added'] += 1
            elif digest(file) == item['sha256']: counts['unchanged'] += 1
            else: counts['changed'] += 1
    return {'scope': 'skills', 'skills': scope['skillIds'], 'profiles': [{'source': scope['sourceProfile'], 'target': scope['targetAgent'], 'newProfile': False, **counts}],
            'warnings': bundle.get('warnings', []), 'credentialsExcluded': True, 'conflictPolicy': 'Preserve the entire incoming skill when an installed file conflicts'}


def apply_locked(home, computer, bundle, busy_profiles, archive_root=None):
    scope, root, files, manifest, record = inspect(home, computer, bundle)
    if scope['targetAgent'] in busy_profiles: raise ValueError('The destination agent is working. Retry after its turn finishes.')
    checked = {}; total = 0
    for key, item in files.items():
        size = (archive_root / scope['sourceProfile'] / key).stat().st_size if archive_root else len(item.get('data', '')) * 3 // 4
        if total + size > MAX_TOTAL + 2: raise ValueError('Skill size limit exceeded')
        data = (archive_root / scope['sourceProfile'] / key).read_bytes() if archive_root else base64.b64decode(item['data'], validate=True)
        total += len(data)
        if total > MAX_TOTAL or digest(data) != item['sha256']: raise ValueError('Skill size or checksum verification failed')
        checked[key] = data
    record.update({'sourceId': bundle['sourceId'], 'source': bundle.get('source', {}), **scope})
    result = {'scope': 'skills', 'profiles': [{'source': scope['sourceProfile'], 'target': scope['targetAgent']}], 'skills': scope['skillIds'], 'conflicts': [], 'warnings': bundle.get('warnings', [])}
    def save():
        record['updated'] = time.time(); atomic_write(manifest, json.dumps(record).encode())
    # Use outermost selected roots so overlapping choices are one consistent unit.
    roots = [s for s in scope['skillIds'] if not any(s.startswith(other + '/') for other in scope['skillIds'] if s != other)]
    for skill in roots:
        group = {k: v for k, v in checked.items() if k.startswith('skills/' + skill + '/')}
        if all((root / k).exists() and record['sourceHashes'].get(k) == files[k]['sha256'] for k in group): continue
        conflict = any((root / k).exists() and digest(root / k) not in (files[k]['sha256'], record['hashes'].get(k)) for k in group)
        version = digest(json.dumps({k: files[k]['sha256'] for k in sorted(group)}).encode())[:16]
        for key, data in group.items():
            dest = root / key; new_hash = files[key]['sha256']
            if conflict:
                incoming = manifest.parent / manifest.stem / version / (key + '.incoming')
                atomic_write(incoming, data)
                result['conflicts'].append({'profile': scope['targetAgent'], 'file': key, 'incoming': str(incoming)})
            elif not dest.exists() or digest(dest) != new_hash:
                if dest.exists():
                    atomic_write(manifest.parent / manifest.stem / (key + '.' + digest(dest)[:16] + '.previous'), dest.read_bytes())
                atomic_write(dest, data, 0o755 if files[key].get('mode', 0) & 0o111 else 0o600)
                record['hashes'][key] = new_hash
            else: record['hashes'][key] = new_hash
            record['sourceHashes'][key] = new_hash
            save()
    return result
