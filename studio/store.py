"""Durable collaboration ledger. Hermes remains the owner of agent execution/history."""
from __future__ import annotations
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        path.chmod(0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
          PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS agents(name TEXT PRIMARY KEY, role TEXT NOT NULL,
            runtime_id TEXT, stored_id TEXT, created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, title TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS members(group_id TEXT REFERENCES groups(id),
            agent TEXT REFERENCES agents(name), PRIMARY KEY(group_id,agent));
          CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, sender TEXT NOT NULL,
            recipient TEXT NOT NULL REFERENCES agents(name), group_id TEXT REFERENCES groups(id),
            body TEXT NOT NULL, state TEXT NOT NULL, runtime_id TEXT, stored_id TEXT,
            result TEXT, created REAL NOT NULL, updated REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            delivery_id TEXT REFERENCES deliveries(id), author TEXT NOT NULL,
            kind TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL);
        ''')
        if 'priority' not in {r[1] for r in self.db.execute('PRAGMA table_info(deliveries)')}:
            self.db.execute('ALTER TABLE deliveries ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
        if 'response_id' not in {r[1] for r in self.db.execute('PRAGMA table_info(deliveries)')}:
            self.db.execute('ALTER TABLE deliveries ADD COLUMN response_id TEXT')
        if 'attachments' not in {r[1] for r in self.db.execute('PRAGMA table_info(deliveries)')}:
            self.db.execute("ALTER TABLE deliveries ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
        self.db.execute('INSERT OR IGNORE INTO agents VALUES(?,?,NULL,NULL,?)',
                        ('default', 'Head of Operations', time.time()))

    def rows(self, sql, args=()):
        with self.lock:
            return [dict(row) for row in self.db.execute(sql, args)]

    def agent(self, name):
        rows = self.rows('SELECT * FROM agents WHERE name=?', (name,))
        if not rows: raise ValueError('Unknown agent')
        return rows[0]

    def add_agent(self, name, role):
        with self.lock:
            self.db.execute('INSERT INTO agents VALUES(?,?,NULL,NULL,?)', (name, role, time.time()))
        return self.agent(name)

    def bind(self, name, runtime_id, stored_id):
        with self.lock:
            self.db.execute('UPDATE agents SET runtime_id=?, stored_id=? WHERE name=?',
                            (runtime_id, stored_id, name))

    def group(self, group_id, title, members):
        members = sorted(set(members))
        if len(members) < 2: raise ValueError('Groups need at least two agents')
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                existing = self.rows('SELECT title FROM groups WHERE id=?', (group_id,))
                if existing:
                    actual = [r['agent'] for r in self.rows('SELECT agent FROM members WHERE group_id=? ORDER BY agent', (group_id,))]
                    if actual != members or existing[0]['title'] != title:
                        raise ValueError('Group id already belongs to another definition')
                else:
                    self.db.execute('INSERT INTO groups VALUES(?,?)', (group_id, title))
                    self.db.executemany('INSERT INTO members VALUES(?,?)', [(group_id,m) for m in members])
                self.db.execute('COMMIT')
            except Exception:
                self.db.execute('ROLLBACK'); raise
        return {'id':group_id, 'title':title, 'members':members}

    def send(self, sender, recipient, body, group_id=None, request_id=None, attachments=None):
        if not isinstance(body,str) or not body.strip() or len(body)>100000:
            raise ValueError('A nonempty message of at most 100000 characters is required')
        if sender != 'user': self.agent(sender)
        self.agent(recipient)
        request_id = request_id or uuid.uuid4().hex
        now = time.time()
        with self.lock:
            if group_id:
                members = {r['agent'] for r in self.rows('SELECT agent FROM members WHERE group_id=?', (group_id,))}
                if recipient not in members or (sender != 'user' and sender not in members):
                    raise PermissionError('Both agents must belong to the group')
            existing = self.rows('SELECT * FROM deliveries WHERE id=?',(request_id,))
            if existing:
                row=existing[0]
                if (row['sender'],row['recipient'],row['body'],row['group_id'],json.loads(row['attachments'])) != (sender,recipient,body,group_id,attachments or []):
                    raise ValueError('Request id was already used for different content')
                return row
            self.db.execute('INSERT INTO deliveries(id,sender,recipient,group_id,body,state,runtime_id,stored_id,result,created,updated,attachments) VALUES(?,?,?,?,?,\'queued\',NULL,NULL,NULL,?,?,?)',
                            (request_id,sender,recipient,group_id,body,now,now,json.dumps(attachments or [])))
        return self.rows('SELECT * FROM deliveries WHERE id=?',(request_id,))[0]

    def deliver_inbox(self, recipient, runtime_id, stored_id):
        """Deliver waiting messages to the actual agent reading its inbox.

        A busy agent can incorporate findings/revisions into its current turn.
        Mark them received so the dispatcher does not run each message again
        after the agent has already read and acted on it.
        """
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                # Direct chats and inbound A2A tasks own a separate turn. A
                # status read in an older conversation must not adopt them and
                # attach that conversation's final answer as their result.
                queued=self.rows("SELECT * FROM deliveries WHERE recipient=? AND state='queued' AND sender!='user' AND runtime_id IS NULL ORDER BY priority DESC,created LIMIT 20",(recipient,))
                for delivery in queued:
                    self.db.execute("UPDATE deliveries SET state='running',runtime_id=?,stored_id=?,updated=? WHERE id=? AND state='queued'",
                        (runtime_id,stored_id,time.time(),delivery['id']))
                    self.db.execute('INSERT INTO events(delivery_id,author,kind,payload,created) VALUES(?,?,?,?,?)',
                        (delivery['id'],recipient,'message.received',json.dumps({'via':'studio_team inbox','runtime_id':runtime_id,'stored_id':stored_id}),time.time()))
                self.db.execute('COMMIT')
                return queued
            except BaseException:
                self.db.execute('ROLLBACK');raise

    def claim(self):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                rows=self.rows('''SELECT * FROM deliveries d WHERE state='queued' AND NOT EXISTS
                 (SELECT 1 FROM deliveries active WHERE active.recipient=d.recipient
                  AND active.state IN ('starting','running','needs_review')) ORDER BY d.priority DESC,d.created LIMIT 1''')
                if rows:
                    self.db.execute("UPDATE deliveries SET state='starting',updated=? WHERE id=?",(time.time(),rows[0]['id']))
                self.db.execute('COMMIT')
                return rows[0] if rows else None
            except Exception:
                self.db.execute('ROLLBACK'); raise

    def started(self, delivery_id, runtime_id, stored_id):
        with self.lock:
            self.db.execute("UPDATE deliveries SET state='running',runtime_id=?,stored_id=?,updated=? WHERE id=? AND state='starting'",
                            (runtime_id,stored_id,time.time(),delivery_id))

    def state(self, delivery_id, state, result=None):
        if state not in {'queued','running','complete','error','cancelled','needs_review'}: raise ValueError('Invalid state')
        with self.lock:
            self.db.execute('UPDATE deliveries SET state=?,result=?,updated=? WHERE id=?',
                            (state,result,time.time(),delivery_id))

    def record(self, runtime_id, kind, payload):
        with self.lock:
            active = self.rows("SELECT * FROM deliveries WHERE runtime_id=? AND state='running'",(runtime_id,))
            response_id=uuid.uuid4().hex if kind=='message.complete' else None
            for delivery in active:
                self.db.execute('INSERT INTO events(delivery_id,author,kind,payload,created) VALUES(?,?,?,?,?)',
                    (delivery['id'],delivery['recipient'],kind,json.dumps(payload,ensure_ascii=False),time.time()))
                if kind=='message.complete':
                    state='error' if payload.get('status')=='error' else 'cancelled' if payload.get('status') in {'cancelled','interrupted'} else 'complete'
                    self.state(delivery['id'],state,str(payload.get('text','')))
                    self.db.execute('UPDATE deliveries SET response_id=? WHERE id=?',(response_id,delivery['id']))

    def recover(self):
        # The last tool may have succeeded before a crash. Never blindly replay it.
        with self.lock:
            self.db.execute("UPDATE deliveries SET state='needs_review',updated=? WHERE state IN ('starting','running')",(time.time(),))
            self.db.execute('UPDATE agents SET runtime_id=NULL')

    def snapshot(self):
        return {'agents':self.rows('SELECT * FROM agents ORDER BY created'),
                'groups':[{**r,'members':[m['agent'] for m in self.rows('SELECT agent FROM members WHERE group_id=?',(r['id'],))]} for r in self.rows('SELECT * FROM groups')],
                'deliveries':self.rows('SELECT * FROM deliveries ORDER BY created DESC LIMIT 200')}
