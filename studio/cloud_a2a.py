"""Hermes A2A protocol adapter backed by Studio's persistent profile queue.

The native A2A wire helpers and trust framing are reused. The connector carries
JSON-RPC across an authenticated computer connection; this adapter never calls
another model loop. Task IDs and ownership survive restarts.
"""
import hashlib
import json
import re
from .cloud_peer import database
from plugins.platforms.a2a import protocol, security


def dispatch(service,p):
    source=str(p.get('sourceComputerId',''))
    if not re.fullmatch(r'[a-f0-9-]{36}',source):raise ValueError('An authenticated source computer is required')
    agent=p['agentId'];service.adopt_profiles();service.store.agent(agent)
    envelope=p['envelope'];method=envelope.get('method');rid=envelope.get('id')
    params=envelope.get('params') or {};db=database(service.home)
    try:
        if method=='message/send':
            text=protocol.extract_text(params)
            if not text or len(text)>20000:raise ValueError('Peer task must contain at most 20,000 characters')
            hops=int(p.get('hops',0))
            if not 1<=hops<=service.settings()['maxPeerHops']:raise ValueError('Cross-computer delegation hop limit exceeded')
            message=params.get('message') or {}
            message_id=str(message.get('messageId') or '')
            if not 1<=len(message_id)<=128:raise ValueError('A stable A2A messageId is required')
            task_id=hashlib.sha256(json.dumps([source,agent,message_id]).encode()).hexdigest()
            fingerprint=hashlib.sha256(json.dumps([text,hops],sort_keys=True).encode()).hexdigest()
            existing=db.execute('SELECT * FROM inbound WHERE id=?',(task_id,)).fetchone()
            if existing and existing['digest']!=fingerprint:raise ValueError('A2A messageId already belongs to another task')
            db.execute('INSERT OR IGNORE INTO inbound VALUES(?,?,?,?,?)',(task_id,source,agent,hops,fingerprint))
            service.store.send('user',agent,security.wrap_inbound(source,text),request_id=task_id)
        elif method in {'tasks/get','tasks/cancel'}:
            task_id=str(params.get('id') or params.get('taskId') or '')
            record=db.execute('SELECT * FROM inbound WHERE id=? AND source=? AND agent=?',(task_id,source,agent)).fetchone()
            if not record:return protocol.jsonrpc_error(rid,protocol.ERR_TASK_NOT_FOUND,'Task not found on this peer')
            if method=='tasks/cancel':service.operation('user',{'operation':'cancel','request_id':task_id})
        else:return protocol.jsonrpc_error(rid,protocol.ERR_METHOD_NOT_FOUND,'Unsupported A2A operation')
        delivery=service.store.rows('SELECT * FROM deliveries WHERE id=?',(task_id,))[0]
        states={'queued':protocol.STATE_SUBMITTED,'starting':protocol.STATE_WORKING,'running':protocol.STATE_WORKING,
                'complete':protocol.STATE_COMPLETED,'error':protocol.STATE_FAILED,'cancelled':protocol.STATE_CANCELED,
                'needs_review':protocol.STATE_INPUT_REQUIRED}
        reply=security.redact_outbound(delivery['result'] or '')
        task=protocol.build_task(task_id,task_id,states[delivery['state']],reply)
        return protocol.jsonrpc_result(rid,protocol.send_message_response(task) if method=='message/send' else task)
    finally:db.close()
