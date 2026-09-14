"""Durable host-local outbox for the Studio tool and outbound connector."""
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid


def database(home):
    path=Path(home)/'studio/peers.sqlite'
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    db=sqlite3.connect(path,timeout=5,isolation_level=None);path.chmod(0o600)
    db.row_factory=sqlite3.Row
    db.executescript('''PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,actor TEXT,target_computer TEXT,
        target_agent TEXT,body TEXT,hops INTEGER,state TEXT,task TEXT,error TEXT,notified INTEGER DEFAULT 0,created REAL);
      CREATE TABLE IF NOT EXISTS directory(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT,updated REAL);
      CREATE TABLE IF NOT EXISTS inbound(id TEXT PRIMARY KEY,source TEXT,agent TEXT,hops INTEGER,digest TEXT);
      CREATE TABLE IF NOT EXISTS lineage(id TEXT PRIMARY KEY,hops INTEGER NOT NULL);
    ''')
    return db


def active_hops(service,actor,db):
    hops=0
    for row in service.store.rows("SELECT id FROM deliveries WHERE recipient=? AND state='running'",(actor,)):
        identity=row['id']
        while identity.endswith(':recovery'):identity=identity[:-9]
        for table in ('inbound','lineage'):
            value=db.execute('SELECT hops FROM '+table+' WHERE id=?',(identity,)).fetchone()
            if value:hops=max(hops,value['hops'])
        if identity.startswith('peer-result-'):
            value=db.execute('SELECT hops FROM outbox WHERE id=? AND actor=?',(identity[12:],actor)).fetchone()
            if value:hops=max(hops,value['hops'])
    return hops


def local_send(service,actor,p):
    """Carry delegation depth through local turns and returned peer results."""
    rid=str(p.get('request_id') or uuid.uuid4().hex)
    if actor=='user' or service.store.rows('SELECT id FROM deliveries WHERE id=?',(rid,)):
        return service.store.send(actor,p['recipient'],p['message'],p.get('group_id'),rid)
    db=database(service.home)
    try:
        hops=active_hops(service,actor,db)+1
        if hops>service.settings()['maxPeerHops']:raise ValueError('Delegation reached its hop limit')
        # Save lineage before publishing the receipt. A crash can leave an
        # unused lineage row, but can never publish a task with its depth lost.
        db.execute('INSERT OR IGNORE INTO lineage VALUES(?,?)',(rid,hops))
        return service.store.send(actor,p['recipient'],p['message'],p.get('group_id'),rid)
    finally:db.close()


def operation(service,actor,p):
    from plugins.platforms.a2a import security
    actor='default' if actor=='user' else actor
    service.store.agent(actor)
    db=database(service.home)
    try:
        op=p['operation']
        if op=='peers':
            row=db.execute('SELECT value,updated FROM directory WHERE id=1').fetchone()
            return {'computers':json.loads(row['value']) if row else [],'updated':row['updated'] if row else None}
        if op=='peer_status':
            task=p.get('peer_task_id')
            rows=db.execute('SELECT * FROM outbox WHERE actor=?'+(' AND id=?' if task else '')+' ORDER BY created DESC LIMIT 30',
                            (actor,task) if task else (actor,)).fetchall()
            return {'tasks':[{'id':r['id'],'computerId':r['target_computer'],'agentId':r['target_agent'],
                     'state':r['state'],'task':json.loads(r['task']) if r['task'] else None,'error':r['error']} for r in rows]}
        body=str(p.get('message','')).strip()
        if not body or len(body)>20000:raise ValueError('Peer tasks require 1–20,000 characters of explicit task context')
        target=str(p.get('target_computer',''));agent=str(p.get('target_agent',''))
        if not target or not agent:raise ValueError('A destination computer and agent are required')
        body=security.redact_outbound(body)
        task_id=str(p.get('request_id') or uuid.uuid4().hex)
        if not 1<=len(task_id)<=128:raise ValueError('Invalid task request identity')
        previous=db.execute('SELECT * FROM outbox WHERE id=?',(task_id,)).fetchone()
        if previous:
            if tuple(previous[k] for k in ('actor','target_computer','target_agent','body'))!=(actor,target,agent,body):
                raise ValueError('Request identity belongs to another peer task')
            return {'id':task_id,'state':previous['state'],'accepted':True,'message':'Task saved. Completion will arrive separately.'}
        hops=active_hops(service,actor,db)+1
        if hops>service.settings()['maxPeerHops']:raise ValueError('Cross-computer delegation reached its hop limit')
        db.execute('INSERT INTO outbox VALUES(?,?,?,?,?,?,\'queued\',NULL,NULL,0,?)',
                   (task_id,actor,target,agent,body,hops,time.time()))
        return {'id':task_id,'state':'queued','accepted':True,'message':'Task saved. Completion will arrive separately.'}
    finally:db.close()
