import io
import sqlite3
import pytest
from studio.cloud_backup import snapshot,restore


def test_streamed_restore_preserves_nul_blobs_rowids_and_virtual_search(tmp_path):
    source=tmp_path/'source.db'
    with sqlite3.connect(source) as db:
        db.executescript("CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,content TEXT,payload BLOB);CREATE VIRTUAL TABLE messages_fts USING fts5(content);CREATE INDEX content_index ON messages(content);")
        db.execute('INSERT INTO messages VALUES(?,?,?)',(19,'\x00json:embedded text',b'\x00\xff'))
        db.execute('INSERT INTO messages_fts(rowid,content) VALUES(?,?)',(19,'searchable text'))
    data=io.BytesIO();original=snapshot(source,data);data.seek(0)
    result=restore(data,tmp_path/'restored.db')
    assert result['counts']==original['counts'] and result['sha256']==original['sha256']
    with sqlite3.connect(tmp_path/'restored.db') as db:
        assert db.execute('SELECT * FROM messages').fetchone()==(19,'\x00json:embedded text',b'\x00\xff')
        assert db.execute("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'searchable'").fetchone()[0]==19
    data.seek(0)
    with pytest.raises(FileExistsError):restore(data,source)


def test_partial_backup_is_never_reported_restored(tmp_path):
    source=tmp_path/'source.db'
    with sqlite3.connect(source) as db:db.execute('CREATE TABLE test(value TEXT)')
    data=io.BytesIO();snapshot(source,data)
    with pytest.raises((EOFError,ValueError)):
        restore(io.BytesIO(data.getvalue()[:-20]),tmp_path/'partial.db')
