"""Inspection before recovery; interrupted actions are never blindly resubmitted."""
import hashlib
import json
from pathlib import Path


def inspect(service, delivery_id):
    rows=service.store.rows('SELECT * FROM deliveries WHERE id=?',(delivery_id,))
    if not rows: raise ValueError('Unknown delivery')
    delivery=rows[0]
    if delivery['state'] != 'needs_review': raise ValueError('This delivery does not need recovery')
    events=service.store.rows('SELECT * FROM events WHERE delivery_id=? ORDER BY seq',(delivery_id,))
    messages=[]
    if delivery['stored_id']:
        from hermes_state import SessionDB
        profile=delivery['recipient']
        home=service.home if profile=='default' else service.home/'profiles'/profile
        path=home/'state.db'
        if path.exists():
            db=SessionDB(db_path=path,read_only=True)
            try: messages=db.get_messages(delivery['stored_id'],limit=12,latest=True)
            finally: db.close()
    evidence={'delivery':delivery,'events':events,'history_tail':messages}
    evidence['inspection_token']=hashlib.sha256(json.dumps(evidence,sort_keys=True,default=str).encode()).hexdigest()
    return evidence


def resume(service, delivery_id, token):
    # Keep the interrupted delivery in the audit trail. A new recovery turn
    # resumes the same persisted Hermes session, with explicit verification.
    recovery_id=delivery_id+':recovery'
    with service.store.lock:
        existing=service.store.rows('SELECT * FROM deliveries WHERE id=?',(recovery_id,))
        if existing:
            authorization=service.store.rows("SELECT payload FROM events WHERE delivery_id=? AND kind='recovery.authorized' ORDER BY seq DESC LIMIT 1",(delivery_id,))
            if not authorization or json.loads(authorization[0]['payload']).get('inspection_token')!=token:
                raise ValueError('Recovery evidence changed; inspect it again')
            return existing[0]
        evidence=inspect(service,delivery_id)
        if token != evidence['inspection_token']: raise ValueError('Recovery evidence changed; inspect it again')
        delivery=evidence['delivery']
        body=('Recover the interrupted task below using your existing Hermes history. '
              'FIRST inspect the relevant files, running processes, or assigned browser using your '
              'available tools to determine which actions already completed. Do not blindly repeat '
              'any command or external action whose result was uncertain. Report what you verified, '
              'then finish only missing work. If an external action cannot be checked, hold it for '
              'owner review.\n\nOriginal task:\n'+delivery['body'])
        service.store.db.execute('BEGIN IMMEDIATE')
        try:
            service.store.state(delivery_id,'cancelled','Interrupted; durable history inspected before recovery '+recovery_id)
            service.store.send('user',delivery['recipient'],body,delivery['group_id'],recovery_id,
                               attachments=json.loads(delivery.get('attachments') or '[]'))
            service.store.db.execute('UPDATE deliveries SET priority=2,stored_id=? WHERE id=?',(delivery['stored_id'],recovery_id))
            import time
            service.store.db.execute('INSERT INTO events(delivery_id,author,kind,payload,created) VALUES(?,?,?,?,?)',
                (delivery_id,'user','recovery.authorized',json.dumps({'inspection_token':token,'recovery_id':recovery_id}),time.time()))
            service.store.db.execute('COMMIT')
        except BaseException:
            service.store.db.execute('ROLLBACK');raise
    return service.store.rows('SELECT * FROM deliveries WHERE id=?',(recovery_id,))[0]
