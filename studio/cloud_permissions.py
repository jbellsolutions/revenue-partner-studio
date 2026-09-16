"""Receiver-side checks for Studio grants. Trusted connections never imply desktop access."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import time
from contextlib import contextmanager
from .cloud_import import atomic_write

def verify(proof,token):
    payload=proof.get('payload','');signature=proof.get('signature','')
    expected=hmac.new(hashlib.sha256(token.encode()).hexdigest().encode(),payload.encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected,signature):raise PermissionError('Studio permission proof is invalid.')
    return json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))

@contextmanager
def record(home):
    base=Path(home)/'studio-cloud';base.mkdir(parents=True,exist_ok=True,mode=0o700)
    db=sqlite3.connect(base/'permissions.sqlite',timeout=5)
    try:
        (base/'permissions.sqlite').chmod(0o600)
        db.execute('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,source TEXT NOT NULL,actor TEXT NOT NULL,agent TEXT NOT NULL)')
        yield db
        db.commit()
    finally:db.close()

def receive(home,computer,proof,token):
    value=verify(proof,token)
    if value.get('computerId')!=computer or value.get('validUntil',0)<time.time()*1000:raise PermissionError('Studio permission directory is stale or belongs to another computer.')
    path=Path(home)/'studio-cloud/permissions.json'
    try: previous=json.loads(path.read_text())
    except (FileNotFoundError,ValueError,OSError): previous={}
    # Reconnect/admission can repeat an unchanged directory. Keep the newer
    # durable lease when it still has ample life instead of fsyncing it again.
    if (previous.get('revision')==value.get('revision') and
            previous.get('validUntil',0)>time.time()*1000+35000):
        return {'revision':value.get('revision',''),'written':False}
    atomic_write(path,json.dumps(value,separators=(',',':')).encode())
    return {'revision':value.get('revision',''),'written':True}

def accept(home,computer,p,token,task):
    value=verify(p.get('authorization') or {},token)
    message_id=str(((p.get('envelope') or {}).get('params') or {}).get('message',{}).get('messageId') or '')
    expected={'source':p.get('sourceComputerId'),'actor':p.get('sourceAgentId'),'target':computer,'agent':p.get('agentId'),'request':message_id}
    expected['envelopeHash']=hashlib.sha256(json.dumps(p.get('envelope'),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    expected['hops']=p.get('hops',0)
    if any(value.get(k)!=v for k,v in expected.items()) or value.get('expires',0)<time.time()*1000:
        raise PermissionError('Studio permission does not authorize this task.')
    with record(home) as db:
        db.execute('INSERT OR IGNORE INTO tasks VALUES(?,?,?,?,?)',(task,value['grant'],value['source'],value['actor'],value['agent']))

def allowed(home,task):
    with record(home) as db:row=db.execute('SELECT grant_id,source,actor,agent FROM tasks WHERE id=?',(task,)).fetchone()
    if not row:return True # Existing accepted tasks and direct owner conversations.
    try:value=json.loads((Path(home)/'studio-cloud/permissions.json').read_text())
    except (FileNotFoundError,ValueError):return False
    if value.get('validUntil',0)<time.time()*1000:return False
    return any(g['id']==row[0] and g['source']==row[1] and g['actor']==row[2] and g['agent']==row[3] and not g.get('revoked') and (not g.get('expires') or g['expires']>time.time()*1000) for g in value.get('grants',[]))

def install_guard(service):
    from tools.registry import registry,tool_error
    from gateway.session_context import get_session_env
    original=registry.dispatch
    def dispatch(name,args,**kwargs):
        from .machine import kind
        if kind()=='local':
            if (service.home/'studio-cloud/access-paused').exists():
                return tool_error('Studio access was stopped on this Mac. Resume it from the companion menu.')
            if name=='computer_use' or name.startswith(('desktop_','mac_','mcp_mac_')):
                from .local_screen import may_automate
                if not may_automate(service.home,service.actor()):
                    return tool_error('Approve this agent’s Mac desktop session in Studio and resume automation before using desktop tools.')
        runtime=get_session_env('HERMES_UI_SESSION_ID','');stored=get_session_env('HERMES_SESSION_ID','')
        if not runtime and stored:
            runtime=next((r for r,s in list(service.server._sessions.items()) if s.get('session_key')==stored),'')
        if runtime:
            for row in service.store.rows("SELECT id FROM deliveries WHERE runtime_id=? AND state IN ('running','needs_review')",(runtime,)):
                if not allowed(service.home,row['id']):
                    service.store.state(row['id'],'needs_review','Trusted connection expired, was revoked, or is awaiting reconnection. Inspect before resuming.')
                    service.task_event(row['id'])
                    try:service.rpc('session.interrupt',{'session_id':runtime})
                    except Exception:pass
                    return tool_error('Studio paused this delegated task because its permission is no longer available. No tool action was performed.')
        return original(name,args,**kwargs)
    registry.dispatch=dispatch
