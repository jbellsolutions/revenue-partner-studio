import copy
import json
import sqlite3
from pathlib import Path
import pytest
import yaml
from studio.cloud_import import build_bundle, apply_bundle


def test_import_keeps_narrow_tool_grants_and_disabled_tools():
    from studio.cloud_import import safe_settings
    config={'tools':{'enabled_toolsets':['file'],'private_key':'secret'},
            'platform_toolsets':{'cli':['file']},
            'agent':{'max_turns':24,'disabled_toolsets':['cronjob','browser']}}
    result=safe_settings(config)
    assert result['tools']=={'enabled_toolsets':['file']}
    assert result['platform_toolsets']=={'cli':['file']}
    assert result['agent']==config['agent']


def source(tmp_path):
    root = tmp_path / 'mac'; root.mkdir()
    (root / 'config.yaml').write_text(yaml.safe_dump({'model': {'default': 'test', 'api_key': 'secret'}, 'mcp_servers': {'private': {'token': 'secret'}}}))
    (root / 'auth.json').write_text('secret')
    (root / 'SOUL.md').write_text('source soul')
    skill = root / 'skills/example'; skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('example')
    (skill / '.env').write_text('secret')
    (skill / 'helper.sh').write_text('touch /tmp/must-not-execute')
    (skill / 'helper.sh').chmod(0o755)
    with sqlite3.connect(root / 'state.db') as db:
        db.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT);INSERT INTO sessions VALUES('history');INSERT INTO messages VALUES(1,'history','user','Original history');")
    return root


def test_import_preserves_credentials_and_creates_independent_real_profile(tmp_path):
    mac=source(tmp_path); cloud=tmp_path/'cloud'; cloud.mkdir();(cloud/'auth.json').write_text('remote-secret')
    bundle=build_bundle(mac,'computer');result=apply_bundle(cloud,'computer',bundle)
    dest=cloud/'profiles'/result['profiles'][0]['target']
    assert (dest/'SOUL.md').read_text()=='source soul'
    assert (dest/'skills/example/helper.sh').exists()
    assert not (dest/'auth.json').exists() and not (dest/'skills/example/.env').exists()
    assert 'secret' not in (dest/'config.yaml').read_text()
    assert (cloud/'auth.json').read_text()=='remote-secret'
    with sqlite3.connect(dest/'state.db') as db: assert db.execute('SELECT content FROM messages').fetchone()[0]=='Original history'
    assert apply_bundle(cloud,'computer',bundle)['profiles']==result['profiles']


def test_both_sides_changed_preserves_cloud_and_incoming(tmp_path):
    mac=source(tmp_path);cloud=tmp_path/'cloud';cloud.mkdir();first=build_bundle(mac,'c')
    target=apply_bundle(cloud,'c',first)['profiles'][0]['target'];dest=cloud/'profiles'/target
    (dest/'SOUL.md').write_text('cloud edit');(mac/'SOUL.md').write_text('mac edit')
    result=apply_bundle(cloud,'c',build_bundle(mac,'c'))
    assert (dest/'SOUL.md').read_text()=='cloud edit'
    conflict=next(x for x in result['conflicts'] if x['file']=='SOUL.md')
    assert Path(conflict['incoming']).read_text()=='mac edit'


def test_wrong_destination_and_traversal_are_rejected_before_profiles(tmp_path):
    bundle=build_bundle(source(tmp_path),'a');cloud=tmp_path/'cloud';cloud.mkdir()
    with pytest.raises(ValueError,match='destination'):apply_bundle(cloud,'b',bundle)
    item=bundle['profiles']['default']['files']['SOUL.md'];bundle['profiles']['default']['files']['skills/../../escape']=item
    with pytest.raises(ValueError,match='Unsafe'):apply_bundle(cloud,'a',bundle)
    assert not (cloud/'escape').exists()


def test_crash_after_reserved_identity_resumes_without_duplicate(tmp_path,monkeypatch):
    import studio.cloud_import as mod
    bundle=build_bundle(source(tmp_path),'c');cloud=tmp_path/'cloud';cloud.mkdir()
    original=mod.atomic_write
    def fail(file,data,mode=0o600):
        if file.name=='SOUL.md':raise OSError('simulated power loss')
        return original(file,data,mode)
    monkeypatch.setattr(mod,'atomic_write',fail)
    with pytest.raises(OSError):apply_bundle(cloud,'c',bundle)
    monkeypatch.setattr(mod,'atomic_write',original)
    result=apply_bundle(cloud,'c',bundle)
    assert len(list((cloud/'profiles').iterdir()))==1
    assert (cloud/'profiles'/result['profiles'][0]['target']/'config.yaml').exists()


def test_busy_import_and_symlink_destination_are_rejected(tmp_path):
    mac=source(tmp_path);cloud=tmp_path/'cloud';cloud.mkdir();bundle=build_bundle(mac,'c')
    target=apply_bundle(cloud,'c',bundle)['profiles'][0]['target']
    with pytest.raises(ValueError,match='working'):apply_bundle(cloud,'c',bundle,{target})
    file=cloud/'profiles'/target/'SOUL.md';file.unlink();file.symlink_to(mac/'SOUL.md')
    with pytest.raises(ValueError,match='Linked'):apply_bundle(cloud,'c',bundle)


def test_history_updates_never_replace_cloud_history(tmp_path):
    mac=source(tmp_path);cloud=tmp_path/'cloud';cloud.mkdir();bundle=build_bundle(mac,'c')
    target=apply_bundle(cloud,'c',bundle)['profiles'][0]['target']
    with sqlite3.connect(mac/'state.db') as db:db.execute("INSERT INTO messages VALUES(2,'history','assistant','Later Mac')")
    result=apply_bundle(cloud,'c',build_bundle(mac,'c'))
    assert any(x['file']=='state.db' for x in result['conflicts'])
    with sqlite3.connect(cloud/'profiles'/target/'state.db') as db:assert db.execute('SELECT count(*) FROM messages').fetchone()[0]==1
    assert not apply_bundle(cloud,'c',build_bundle(mac,'c'))['conflicts']


def test_streamed_archive_resume_integrity_and_profile_identity(tmp_path):
    from studio.cloud_archive import build_archive, Uploads, apply_archive, CHUNK
    from studio.cloud_import import digest
    import base64
    mac=source(tmp_path);cloud=tmp_path/'cloud';cloud.mkdir()
    # A helper asset above the ordinary JSON limit must survive the archive path.
    payload=mac/'skills/example/large.bin';payload.write_bytes(b'asset' * 900000)
    archive,bundle=build_archive(mac,'computer',tmp_path/'export.zip')
    uploads=Uploads(cloud,'computer'); checksum=digest(archive)
    started=uploads.begin(archive.stat().st_size,checksum)
    with archive.open('rb') as stream:
        offset=0
        for chunk in iter(lambda:stream.read(CHUNK),b''):
            encoded=base64.b64encode(chunk).decode()
            uploads.append(checksum,offset,encoded,digest(chunk))
            uploads.append(checksum,offset,encoded,digest(chunk)) # lost ack, same bytes
            offset+=len(chunk)
    complete=Uploads(cloud,'computer').finish(checksum)
    result=apply_archive(cloud,'computer',complete)
    target=cloud/'profiles'/result['profiles'][0]['target']
    assert digest(target/'skills/example/large.bin')==digest(payload)
    assert not (target/'auth.json').exists()
    assert apply_archive(cloud,'computer',complete)['profiles']==result['profiles']
    with pytest.raises(ValueError,match='destination'):apply_archive(cloud,'other',complete)


def test_corrupted_archive_chunk_is_not_accepted(tmp_path):
    from studio.cloud_archive import Uploads
    import base64
    uploads=Uploads(tmp_path,'computer');uploads.begin(5,'a'*64)
    with pytest.raises(ValueError,match='checksum'):
        uploads.append('a'*64,0,base64.b64encode(b'wrong').decode(),'b'*64)


def test_only_derived_trigram_index_is_rebuilt_on_staged_copy(tmp_path):
    from studio.cloud_import import validate_history
    root=source(tmp_path);path=root/'state.db'
    with sqlite3.connect(path) as db:
        db.executescript("CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content, tokenize='trigram'); INSERT INTO messages_fts_trigram(rowid,content) VALUES(1,'original text'); UPDATE messages_fts_trigram_content SET c0='destination text' WHERE id=1;")
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='malformed inverted index for FTS5 table main.messages_fts_trigram'
    notes=validate_history(path)
    assert len(notes)==1 and 'original history rows preserved' in notes[0]
    with sqlite3.connect(path) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert db.execute('SELECT content FROM messages').fetchone()[0]=='Original history'
        assert db.execute("SELECT rowid FROM messages_fts_trigram WHERE messages_fts_trigram MATCH 'destination'").fetchone()[0]==1
    assert validate_history(path)==[]
