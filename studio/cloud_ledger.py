"""Connector receipts and replay cursors. Contains no model execution loop."""
from __future__ import annotations
import hashlib
import json
import sqlite3
import time
from pathlib import Path


class Ledger:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, isolation_level=None)
        path.chmod(0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,digest TEXT NOT NULL,
            method TEXT NOT NULL,params TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            agent TEXT,session TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(runtime TEXT PRIMARY KEY,agent TEXT NOT NULL,stored TEXT);
        """)
        self.db.execute("UPDATE requests SET state='needs_review',error='Connector restarted during dispatch; inspect saved history before retrying.' WHERE state='dispatching'")

    def begin(self, request_id, method, params):
        encoded = json.dumps(params, sort_keys=True, separators=(',', ':'))
        digest = hashlib.sha256((method + '\n' + encoded).encode()).hexdigest()
        row = self.db.execute('SELECT * FROM requests WHERE id=?', (request_id,)).fetchone()
        if row:
            if row['digest'] != digest:
                raise ValueError('Request ID already belongs to a different operation')
            return dict(row)
        self.db.execute('INSERT INTO requests VALUES(?,?,?,?,\'dispatching\',NULL,NULL,?)',
                        (request_id, digest, method, json.dumps({'redacted': True}) if method in {'providers.submit','providers.configure','endpoints.configure','import.apply'} else encoded, time.time()))
        return None

    def finish(self, request_id, result=None, error=None, uncertain=False):
        self.db.execute('UPDATE requests SET state=?,result=?,error=? WHERE id=?',
                        ('needs_review' if uncertain else 'error' if error else 'accepted',
                         json.dumps(result) if result is not None else None, error, request_id))

    def bind(self, runtime, agent, stored):
        previous = self.db.execute('SELECT agent FROM sessions WHERE runtime=?', (runtime,)).fetchone()
        if previous and previous['agent'] != agent:
            raise ValueError('Runtime session belongs to another agent')
        self.db.execute('INSERT OR REPLACE INTO sessions VALUES(?,?,?)', (runtime, agent, stored))

    def session(self, runtime, agent):
        row = self.db.execute('SELECT * FROM sessions WHERE runtime=? AND agent=?', (runtime, agent)).fetchone()
        if not row:
            raise ValueError('Open this agent conversation before using it')
        return dict(row)

    def event(self, kind, payload, runtime=None):
        row = self.db.execute('SELECT * FROM sessions WHERE runtime=?', (runtime,)).fetchone()
        agent = row['agent'] if row else None
        result = self.db.execute('INSERT INTO events(agent,session,kind,payload,created) VALUES(?,?,?,?,?)',
                                 (agent, runtime, kind, json.dumps(payload), time.time()))
        return {'seq': result.lastrowid, 'agentId': agent, 'runtimeId': runtime,
                'kind': kind, 'payload': payload}

    def events(self, after, limit=500):
        return [{'seq': r['seq'], 'agentId': r['agent'], 'runtimeId': r['session'],
                 'kind': r['kind'], 'payload': json.loads(r['payload'])}
                for r in self.db.execute('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?', (after, limit))]

    def requests(self):
        return [dict(r) for r in self.db.execute('SELECT id,method,state,result,error,created FROM requests ORDER BY created DESC LIMIT 100')]
