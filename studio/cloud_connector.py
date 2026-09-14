"""Outbound Studio transport. Hermes remains the only execution runtime.

The connector survives browser and cloud-gateway disconnects. All runtime URLs
and credential file paths come from its private, host-local configuration.
"""
from __future__ import annotations
import argparse
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
from urllib.parse import urlencode, urlparse
import uuid

import yaml
from websockets.asyncio.client import connect
from .cloud_ledger import Ledger

PROFILE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')
WRITES = {'chat.send', 'chat.cancel', 'agents.create', 'import.apply', 'settings.update',
          'import.commit', 'tasks.cancel', 'tasks.resume', 'a2a.receive', 'providers.begin', 'providers.submit', 'peer.send', 'peer.receive', 'approvals.resolve',
          'agents.update', 'providers.configure', 'skills.update', 'models.select', 'endpoints.configure'}


class Connector:
    def __init__(self, config):
        self.config = config
        self.computer = str(config['computerId'])
        self.home = Path(config['hermesHome']).resolve()
        self.base = Path(config['stateDir']).resolve()
        self.base.mkdir(mode=0o700, parents=True, exist_ok=True)
        import fcntl
        self.owner_lock = (self.base / 'connector.lock').open('a+')
        try:
            fcntl.flock(self.owner_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.owner_lock.close()
            raise RuntimeError('Another connector already owns this computer')
        binding = self.home / ('studio-cloud/local-computer.json' if config.get('kind')=='local' else 'orgo-computer/computer.json')
        if not binding.is_file() or json.loads(binding.read_text()).get('computerId') != self.computer:
            raise ValueError('Connector computer does not match the installed Orgo binding')
        self.ledger = Ledger(self.base / 'connector.sqlite')
        self.event_lock = asyncio.Lock()
        self.upload_lock = asyncio.Lock()
        self.auth_flows = {}
        self.hermes = None
        self.cloud = None
        self.ready = asyncio.Event()
        self.pending = {}
        self.peer_pending = {}
        self.request_locks = {}
        self.jobs = set()
        self.peers = []
        self.peer_directory = []
        self.screens = {}
        self.agent_cache = {}
        from .local_screen import LocalScreen
        self.local_screen=LocalScreen(self) if config.get('kind')=='local' and config.get('desktopHelper') else None
        self.capabilities = {'chat': False, 'teams': False, 'screens': False, 'imports': True}
        endpoint = urlparse(config['hermesUrl'])
        if endpoint.scheme not in {'http', 'ws'} or endpoint.hostname not in {'127.0.0.1', 'localhost', '::1'}:
            raise ValueError('Hermes must be reached over a host-local connection')
        cloud = urlparse(config['cloudUrl'])
        if cloud.scheme != 'https' and not (cloud.scheme == 'http' and cloud.hostname in {'127.0.0.1', 'localhost'}):
            raise ValueError('Cloud Studio requires HTTPS')

    def profile(self, name):
        if not isinstance(name, str) or not PROFILE.fullmatch(name):
            raise ValueError('Invalid agent identity')
        path = self.home if name == 'default' else self.home / 'profiles' / name
        if path.resolve() != path or not (path / 'config.yaml').is_file():
            raise ValueError('Agent does not exist on this computer')
        return path

    def agents(self):
        rows = []
        current = {}
        paths = [self.home] + sorted((self.home / 'profiles').glob('*'))
        for path in paths:
            if path.resolve() != path or not (path / 'config.yaml').is_file():
                continue
            name = 'default' if path == self.home else path.name
            if not PROFILE.fullmatch(name):
                continue
            def version(file):
                try:
                    stat = file.stat()
                    return (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
                except FileNotFoundError:
                    return None
            config_file, meta_file = path / 'config.yaml', path / 'profile.yaml'
            fingerprint = (version(config_file), version(meta_file))
            cached = self.agent_cache.get(name)
            if cached and cached[0] == fingerprint:
                current[name] = cached
                rows.append(dict(cached[1]))
                continue
            cfg = yaml.safe_load(config_file.read_text()) or {}
            meta = yaml.safe_load(meta_file.read_text()) if fingerprint[1] is not None else {}
            model = cfg.get('model') or {}
            row = {'id': name, 'name': (meta or {}).get('name') or name,
                         'description': (meta or {}).get('description', ''),
                         'model': model.get('default', '') if isinstance(model, dict) else str(model),
                         'provider': model.get('provider', '') if isinstance(model, dict) else '',
                         'head': name == 'default'}
            current[name] = (fingerprint, row)
            rows.append(dict(row))
        self.agent_cache = current
        return {'agents': rows}

    async def rpc(self, method, params, timeout=90):
        await asyncio.wait_for(self.ready.wait(), timeout=10)
        rid = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        try:
            await self.hermes.send(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params}))
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(rid, None)

    async def emit(self, kind, payload, runtime=None):
        async with self.event_lock:
            event = self.ledger.event(kind, payload, runtime)
            await self.cloud_send({'type': 'event', **event})

    async def cloud_send(self, value):
        if self.cloud:
            try:
                await self.cloud.send(json.dumps({'computerId': self.computer, **value}))
            except Exception:
                pass  # Events remain replayable in the local ledger.

    def connection_diagnostic(self,area,error=None):
        from .cloud_import import atomic_write
        value={'area':area,'time':time.time(),'connected':error is None}
        if error:
            value['errorType']=type(error).__name__
            received=getattr(error,'rcvd',None)
            if received:
                value['closeCode']=received.code
                safe={'Invalid connector frame','Computer identity mismatch','Stopped on Mac','A connector already owns this computer','Session ended'}
                value['reason']=received.reason if received.reason in safe else 'Connection closed'
        atomic_write(self.base/(area+'-connection.json'),json.dumps(value).encode())

    async def hermes_loop(self):
        while True:
            try:
                token = Path(self.config['hermesTokenFile']).read_text().strip()
                base = self.config['hermesUrl'].rstrip('/').replace('http:', 'ws:')
                async with connect(base + '/api/ws?' + urlencode({'token': token}),
                                   origin=self.config.get('hermesOrigin', 'http://localhost:8787'),
                                   max_size=32 * 1024 * 1024, ping_interval=2, ping_timeout=3) as ws:
                    self.hermes = ws
                    self.ready.set()
                    self.capabilities['chat'] = True
                    await self.emit('runtime.connected', {'connected': True})
                    async for raw in ws:
                        message = json.loads(raw)
                        if 'id' in message and message['id'] in self.pending:
                            future = self.pending[message['id']]
                            if not future.done():
                                if 'error' in message:
                                    future.set_exception(RuntimeError(message['error'].get('message', 'Hermes rejected the operation')))
                                else:
                                    future.set_result(message.get('result', {}))
                        elif message.get('method') == 'event':
                            p = message.get('params', {})
                            if p.get('type') == 'studio.task':
                                delivery = p.get('payload', {})
                                if delivery.get('runtime_id') and delivery.get('recipient'):
                                    self.ledger.bind(delivery['runtime_id'], delivery['recipient'], delivery.get('stored_id'))
                            await self.emit(p.get('type', 'runtime.event'), p.get('payload', {}), p.get('session_id'))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.ready.clear()
                self.capabilities['chat'] = False
                for future in list(self.pending.values()):
                    if not future.done():
                        future.set_exception(ConnectionError('Hermes connection interrupted'))
                await self.emit('runtime.disconnected', {'connected': False, 'reason': type(exc).__name__})
                await asyncio.sleep(2)
            finally:
                self.ready.clear()
                self.hermes = None

    def history_source(self, agent, stored):
        home = self.profile(agent)
        if stored and stored.startswith('imported-history:'):
            parts = stored.split(':', 3)
            if len(parts) != 4 or not re.fullmatch('[a-f0-9]{24}', parts[1]) or not re.fullmatch('[a-f0-9]{10}', parts[2]):
                raise ValueError('Invalid imported history identity')
            path = self.home / 'studio' / 'imports' / parts[1] / agent / ('state.db.' + parts[2] + '.incoming')
            if path.resolve() != path or not path.is_file(): raise ValueError('Imported history snapshot unavailable')
            return path, parts[3], True
        return home / 'state.db', stored, False

    def imported_histories(self, agent, offset=0, limit=61):
        self.profile(agent)
        rows=[];offset=max(0,int(offset))
        for path in sorted((self.home / 'studio' / 'imports').glob('*/' + agent + '/state.db.*.incoming'),reverse=True):
            if path.resolve() != path: continue
            source=path.parent.parent.name; checksum=path.name.split('.')[2]
            if not re.fullmatch('[a-f0-9]{24}', source) or not re.fullmatch('[a-f0-9]{10}', checksum): continue
            with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
                count=db.execute('SELECT count(*) FROM sessions').fetchone()[0]
                if offset>=count:offset-=count;continue
                columns={r[1] for r in db.execute('PRAGMA table_info(sessions)')}
                title='title' if 'title' in columns else 'id'
                for sid, name in db.execute('SELECT id,' + title + ' FROM sessions ORDER BY rowid DESC LIMIT ? OFFSET ?', (limit-len(rows),offset)):
                    rows.append({'id':f'imported-history:{source}:{checksum}:{sid}',
                        'title':name or 'Imported conversation', 'preview':'Mac update · preserved history snapshot', 'readOnly':True})
                offset=0
                if len(rows)>=limit:break
        return rows

    @staticmethod
    def history_text(content, offset, limit):
        # Hermes stores multimodal content behind a NUL-prefixed JSON marker.
        # SQLite TEXT substr/length stops at that NUL. Project text on Orgo and
        # keep attachment bytes in the authoritative database, off the wire.
        if isinstance(content, str) and content.startswith('\x00json:'):
            try:
                value = json.loads(content[6:])
                parts = value if isinstance(value, list) else [value]
                text = []
                for part in parts:
                    if isinstance(part, str): text.append(part)
                    elif isinstance(part, dict):
                        if isinstance(part.get('text'), str): text.append(part['text'])
                        else: text.append('[Attachment retained on this computer]')
                content = '\n\n'.join(text)
            except (ValueError, TypeError):
                content = '[Structured message retained on this computer; preview unavailable]'
        elif isinstance(content, bytes):
            content = '[Binary attachment retained on this computer]'
        return str(content or '')[offset:offset + limit]

    def history(self, agent, stored, before=None, message_id=None, offset=0):
        dbpath, actual, archived = self.history_source(agent, stored)
        if not dbpath.exists() or not stored:
            return {'messages': [], 'hasMore': False}
        db = sqlite3.connect(dbpath.as_uri() + '?mode=ro', uri=True)
        db.row_factory = sqlite3.Row
        db.create_function('studio_history_text', 3, self.history_text, deterministic=True)
        try:
            if not db.execute('SELECT 1 FROM sessions WHERE id=?', (actual,)).fetchone():
                raise ValueError('Conversation does not belong to this agent')
            columns = {r[1] for r in db.execute('PRAGMA table_info(messages)')}
            session_columns = {r[1] for r in db.execute('PRAGMA table_info(sessions)')}
            lineage=[actual]
            if {'parent_session_id','end_reason'}.issubset(session_columns):
                cursor=actual
                for _ in range(100):
                    parent=db.execute("SELECT p.id FROM sessions s JOIN sessions p ON p.id=s.parent_session_id WHERE s.id=? AND p.end_reason='compression'", (cursor,)).fetchone()
                    if not parent or parent[0] in lineage: break
                    lineage.append(parent[0]);cursor=parent[0]
            where='session_id IN (' + ','.join('?' for _ in lineage) + ')'
            if 'active' in columns: where += ' AND active=1'
            if message_id is not None:
                offset=max(0,int(offset))
                row=db.execute('SELECT id,studio_history_text(content,?,16001) AS content FROM messages WHERE '+where+' AND id=?',
                    (offset,*lineage,int(message_id))).fetchone()
                if not row: raise ValueError('Message does not belong to this conversation')
                return {**dict(row),'content':row['content'][:16000],'truncated':len(row['content'])>16000}
            rows=db.execute('SELECT id,role,studio_history_text(content,0,16001) AS content FROM messages WHERE '+where+' AND id<? ORDER BY id DESC LIMIT 81',
                (*lineage,int(before or 9223372036854775807))).fetchall()
            return {'messages':[{**dict(r),'content':r['content'][:16000],'truncated':len(r['content'])>16000} for r in reversed(rows[:80])],
                    'hasMore':len(rows)>80, 'readOnly':archived}
        finally: db.close()

    async def operation(self, method, p, request_id):
        if self.config.get('kind')=='local' and (self.home/'studio-cloud/access-paused').exists():
            raise PermissionError('Studio access was stopped on this Mac.')
        agent = p.get('agentId', 'default')
        if method.startswith('explorer.'):
            from .cloud_explorer import Explorer
            explorer=Explorer(self.profile(agent),self.computer,agent)
            if method=='explorer.roots':return await asyncio.to_thread(explorer.roots)
            if method=='explorer.folders':return await asyncio.to_thread(explorer.folders,p.get('path',''))
            if method=='explorer.choose':
                if self.config.get('kind') != 'local': raise ValueError('Select your Mac to open its folder picker.')
                return await asyncio.to_thread(explorer.choose)
            if method=='explorer.add':return await asyncio.to_thread(explorer.add,p['path'])
            if method=='explorer.list':return await asyncio.to_thread(explorer.list,p['root'],p.get('path',''),p.get('offset',0))
            if method=='explorer.read':return await asyncio.to_thread(explorer.read,p['root'],p['path'],p.get('offset',0),p.get('version'))
            raise ValueError('Unknown computer file operation')
        if method.startswith('library.'):
            from .cloud_library import Library
            library=Library(self.home)
            if method=='library.profiles':return await asyncio.to_thread(library.profiles)
            if method=='library.preview':return await asyncio.to_thread(library.preview,self.computer,p['manifest'])
            if method=='library.chunk':return await asyncio.to_thread(library.chunk,p['exportId'],p['offset'])
            if method=='library.export':
                async with self.upload_lock:return await asyncio.to_thread(library.export,p['targetComputerId'],p['profiles'],request_id)
            raise ValueError('Unknown Hermes library operation')
        if method == 'status':
            try:
                if not self.ready.is_set():
                    raise RuntimeError('Hermes is offline')
                capabilities = await self.rpc('studio.capabilities', {})
                self.capabilities['teams'] = bool(capabilities.get('teams'))
                self.capabilities['a2a'] = bool(capabilities.get('a2a'))
                for capability in ('files','profiles','providerKeys'):
                    self.capabilities[capability] = bool(capabilities.get(capability))
            except RuntimeError:
                self.capabilities['teams'] = False
            self.capabilities['screens'] = bool(self.config.get('screenControl') or self.local_screen)
            self.capabilities['localDesktop'] = bool(self.local_screen)
            self.capabilities.update({'explorer':True,'library':True})
            return {'computerId': self.computer, 'capabilities': self.capabilities, 'runtimeConnected': self.ready.is_set(), 'protocol': 1}
        if method=='import.preview':
            from .cloud_library import Library
            if p.get('bundle'):return await asyncio.to_thread(Library(self.home).preview,self.computer,p['bundle'])
            from .cloud_archive import Uploads
            import zipfile
            async with self.upload_lock:
                archive=await asyncio.to_thread(Uploads(self.home,self.computer).finish,p['uploadId'])
                with zipfile.ZipFile(archive) as contents:
                    info=contents.getinfo('manifest.json')
                    if info.file_size>8*1024*1024:raise ValueError('Archive manifest is too large.')
                    manifest=json.loads(contents.read(info))
                return await asyncio.to_thread(Library(self.home).preview,self.computer,manifest)
        if method in {'import.begin', 'import.chunk', 'import.commit'}:
            from .cloud_archive import Uploads
            async with self.upload_lock:
                uploads = Uploads(self.home, self.computer)
                if method == 'import.begin':
                    return uploads.begin(p['size'], p['sha256'])
                if method == 'import.chunk':
                    return await asyncio.to_thread(uploads.append, p['uploadId'], p['offset'], p['data'], p['sha256'])
                archive = await asyncio.to_thread(uploads.finish, p['uploadId'])
                result = await self.rpc('studio.operation', {'operation': 'import_archive', 'archive': str(archive)}, timeout=600)
                await self.emit('agents.changed', {})
                return result
        if method == 'agents.list':
            return self.agents()
        if method == 'sessions.list':
            self.profile(agent)
            offset=max(0,int(p.get('offset',0)))
            result = await self.rpc('session.list', {'profile': agent, 'limit': 60, 'paged':True, 'offset':offset})
            if offset==0:
                archived=await asyncio.to_thread(self.imported_histories, agent)
                result['sessions'] = result.get('sessions', []) + archived[:60]
                result['nextArchiveOffset']=60 if len(archived)>60 else None
            return result
        if method == 'sessions.archives':
            offset=max(0,int(p.get('offset',0)))
            archived=await asyncio.to_thread(self.imported_histories,agent,offset)
            return {'sessions':archived[:60], 'nextArchiveOffset':offset+60 if len(archived)>60 else None}
        if method == 'sessions.open':
            self.profile(agent)
            stored = p.get('sessionId')
            if stored:
                if self.history_source(agent, stored)[2]:
                    return {'runtimeId':'','sessionId':stored,'readOnly':True,'info':{}, **await asyncio.to_thread(self.history,agent,stored)}
                await asyncio.to_thread(self.history, agent, stored)
            params = {'profile': agent, 'source': 'studio', 'close_on_disconnect': False}
            if p.get('model'):
                params['model'] = p['model']
                params['provider'] = p.get('provider', '')
            if stored:
                params['session_id'] = stored
                params['omit_messages'] = True
            resumed = bool(stored)
            result = await self.rpc('session.resume' if stored else 'session.create', params)
            runtime = result['session_id']
            stored = result.get('stored_session_id') or stored
            self.ledger.bind(runtime, agent, stored)
            return {'runtimeId': runtime, 'sessionId': stored, 'info': result,
                    'eventCursor': self.ledger.db.execute('SELECT coalesce(max(seq),0) FROM events').fetchone()[0],
                    **(await asyncio.to_thread(self.history, agent, stored) if resumed else {'messages': [], 'hasMore': False})}
        if method == 'sessions.history':
            return await asyncio.to_thread(self.history, agent, p['sessionId'], p.get('before'))
        if method == 'sessions.message':
            return await asyncio.to_thread(self.history, agent, p['sessionId'], None, p['messageId'], p.get('offset',0))
        if method in {'chat.send', 'chat.cancel'}:
            runtime = p['runtimeId']
            self.ledger.session(runtime, agent)
            if method == 'chat.cancel':
                return await self.rpc('studio.operation', {'operation': 'cancel_chat', 'runtime_id': runtime})
            text = p.get('text', '') or ('Please review the attached files.' if p.get('attachmentIds') else '')
            if not isinstance(text, str) or not text.strip() or len(text) > 100000:
                raise ValueError('A nonempty message of at most 100,000 characters is required')
            return await self.rpc('studio.operation', {'operation': 'submit_chat', 'runtime_id': runtime, 'recipient': agent, 'message': text, 'request_id': request_id, 'attachmentIds':p.get('attachmentIds',[])})
        if method in {'models.select', 'models.status'}:
            self.ledger.session(p['runtimeId'], agent)
            return await self.rpc('studio.operation', {**p, 'agentId': agent,
                'operation': 'model_select' if method == 'models.select' else 'model_status'})
        if method in {'agents.describe','agents.update','providers.keys','providers.configure','providers.check','models.options','skills.update','endpoints.configure','endpoints.list'}:
            self.profile(agent)
            op={'agents.describe':'profile_describe','agents.update':'profile_update','providers.keys':'provider_keys',
                'providers.configure':'provider_configure','providers.check':'provider_check','models.options':'model_options',
                'skills.update':'skill_update','endpoints.configure':'endpoint_configure','endpoints.list':'endpoint_list'}[method]
            return await self.rpc('studio.operation',{**p,'operation':op,'agentId':agent})
        if method.startswith('files.'):
            from .cloud_files import Files
            home=self.profile(agent)
            session=self.ledger.session(p['runtimeId'],agent)
            if not session['stored']: raise ValueError('Wait for the conversation to open before uploading')
            files=Files(home,self.computer,agent,session['stored'])
            async with self.upload_lock:
                if method=='files.begin': return await asyncio.to_thread(files.begin,p,request_id)
                if method=='files.chunk': return await asyncio.to_thread(files.append,p['attachmentId'],p['offset'],p['data'])
                if method=='files.commit': return await asyncio.to_thread(files.finish,p['attachmentId'])
                if method=='files.read': return await asyncio.to_thread(files.read,p['attachmentId'],p.get('offset',0))
                if method=='files.list': return await asyncio.to_thread(files.listing)
            raise ValueError('Unknown file operation')
        if method == 'agents.create':
            result = await self.rpc('studio.operation', {'operation': 'create_agent', 'name': p['name'], 'role': p['role'], 'skills': p.get('skills', [])})
            await self.emit('agents.changed', {})
            return result
        if method == 'tasks.list':
            result = await self.rpc('studio.snapshot', {})
            return {**result, 'requests': self.ledger.requests()}
        if method == 'tasks.cancel':
            return await self.rpc('studio.operation', {'operation':'cancel','request_id':p['taskId']})
        if method == 'tasks.resume':
            return await self.rpc('studio.operation', {'operation':'resume_recovery','request_id':p['taskId'],'inspection_token':p['inspectionToken']})
        if method == 'tasks.reconcile':
            evidence=await self.rpc('studio.operation', {'operation':'inspect_recovery','request_id':p['taskId']})
            def preview(value):
                text=self.history_text(value,0,4001) if isinstance(value,str) else json.dumps(value,ensure_ascii=False,default=str)
                return {'text':text[:4000],'truncated':len(text)>4000}
            events=evidence.get('events',[])
            return {'delivery':evidence['delivery'],'inspectionToken':evidence['inspection_token'],
                    'actions':[{'kind':e['kind'],**preview(e['payload'])} for e in events[-40:]],
                    'history':[{'role':m.get('role',''),**preview(m.get('content',''))} for m in evidence.get('history_tail',[])],
                    'earlierActions':max(0,len(events)-40)}
        if method == 'tasks.evidence':
            return await self.rpc('studio.events',{'delivery_id':p['taskId'],'summary':True})
        if method == 'skills.list':
            root = self.profile(agent) / 'skills'
            return {'skills': [{'id': str(f.parent.relative_to(root)), 'name': f.parent.name}
                              for f in root.rglob('SKILL.md') if not f.is_symlink()][:5000]}
        if method == 'import.apply':
            result = await self.rpc('studio.operation', {'operation': 'import', 'bundle': p['bundle']})
            await self.emit('agents.changed', {})
            return result
        if method in {'settings.get', 'settings.update'}:
            settings = self.home / 'studio' / 'settings.json'
            value = json.loads(settings.read_text()) if settings.exists() else {'maxConcurrent': 4, 'maxPeerHops': 5}
            if method == 'settings.update':
                value = {'maxConcurrent': max(1, min(16, int(p['maxConcurrent']))), 'maxPeerHops': max(1, min(5, int(p['maxPeerHops'])))}
                temporary = settings.with_suffix('.tmp')
                settings.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                temporary.write_text(json.dumps(value)); temporary.chmod(0o600); temporary.replace(settings)
            return value
        if method in {'providers.list', 'providers.begin', 'providers.status', 'providers.submit'}:
            self.profile(agent)
            from .cloud_auth import provider_flow
            return await provider_flow(self, method, agent, p)
        if method == 'approvals.list':
            result = await self.rpc('studio.snapshot', {})
            return {'approvals': result.get('approvals', [])}
        if method == 'approvals.resolve':
            self.ledger.session(p['runtimeId'], agent)
            return await self.rpc('approval.respond', {'session_id': p['runtimeId'], 'request_id': p['approvalId'], 'choice': p['choice']})
        if method.startswith('screen.'):
            if method == 'screen.cancel_wait':
                return await self.screen(agent, 'cancel')
            if self.local_screen:
                info=self.local_screen.operation(agent,method)
                if method in {'screen.pause','screen.stop'}:
                    for row in self.ledger.db.execute('SELECT runtime FROM sessions WHERE agent=?',(agent,)).fetchall():
                        with contextlib.suppress(RuntimeError):await self.rpc('session.interrupt',{'session_id':row['runtime']})
                return info
            if method in {'screen.authorize','screen.stop'}:raise ValueError('This operation is only available for a local Mac desktop.')
            info = await self.screen(agent, 'ensure' if method == 'screen.open' else 'pause' if method == 'screen.pause' else 'resume')
            if info.get('queued'): return info
            if method == 'screen.open':
                self.screens[agent] = info
            return {k: v for k, v in info.items() if k in {'computerId', 'profile', 'paused', 'display', 'sharedScreen'}} | {'password': self.screen_password()}
        if method == 'peers.list':
            await self.cloud_send({'type': 'peers.list'})
            return {'computers': self.peers}
        if method in {'a2a.receive', 'a2a.status'}:
            expected = 'message/send' if method == 'a2a.receive' else 'tasks/get'
            if p.get('envelope', {}).get('method') != expected:
                raise ValueError('A2A route does not match the operation')
            if method=='a2a.receive':
                import hashlib
                from .cloud_permissions import accept
                message=p['envelope']['params'].get('message',{})
                identity=hashlib.sha256(json.dumps([p.get('sourceComputerId'),p['agentId'],str(message.get('messageId') or '')]).encode()).hexdigest()
                accept(self.home,self.computer,p,Path(self.config['connectorTokenFile']).read_text().strip(),identity)
            return await self.rpc('studio.a2a', p)
        if method == 'peer.send':
            self.profile(agent)
            return await self.rpc('studio.operation', {'operation': 'owner_peer_send', 'agentId': agent,
                'target_computer': p['targetComputerId'], 'target_agent': p['targetAgentId'],
                'message': p['text'], 'request_id': request_id})
        if method == 'peer.status':
            self.profile(agent)
            return await self.rpc('studio.operation', {'operation': 'owner_peer_status', 'agentId': agent, 'peer_task_id': p.get('taskId')})
        raise ValueError('Unsupported Studio operation')

    async def peer_exchange(self, target, method, params, request_id):
        if not self.cloud:
            raise ConnectionError('Studio connection unavailable')
        rid = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.peer_pending[rid] = future
        try:
            await self.cloud_send({'type': 'peer.request', 'id': rid, 'requestId': request_id,
                'targetComputerId': target, 'method': method, 'params': params})
            return await asyncio.wait_for(future, 15)
        finally:
            self.peer_pending.pop(rid, None)

    async def directory_loop(self):
        while True:
            await asyncio.sleep(3 if not self.peer_directory else 30)
            if not self.cloud: continue
            async def describe(peer):
                value = dict(peer)
                if peer.get('online') and peer['id'] != self.computer:
                    try:
                        result = await self.peer_exchange(peer['id'], 'agents.list', {}, uuid.uuid4().hex)
                        value['agents'] = result.get('agents', [])
                    except Exception:
                        value['online'] = False
                return value
            self.peer_directory = await asyncio.gather(*(describe(peer) for peer in self.peers))

    async def peer_loop(self):
        from .cloud_peer import database
        from plugins.platforms.a2a import protocol
        while True:
            await asyncio.sleep(1)
            if not self.cloud or not self.ready.is_set():
                continue
            db = database(self.home)
            try:
                db.execute('INSERT OR REPLACE INTO directory VALUES(1,?,?)', (json.dumps(self.peer_directory), time.time()))
                rows = [dict(r) for r in db.execute("SELECT * FROM outbox WHERE state IN ('queued','working') ORDER BY created LIMIT 8")]
                for row in rows:
                    try:
                        if row['state'] == 'queued':
                            message = protocol.text_message(protocol.ROLE_USER, row['body'])
                            message['messageId'] = row['id']
                            envelope = {'jsonrpc':'2.0','id':row['id'],'method':'message/send','params':{'message':message}}
                            result = await self.peer_exchange(row['target_computer'], 'a2a.receive',
                                {'agentId':row['target_agent'],'sourceAgentId':row['actor'],'hops':row['hops'],'envelope':envelope}, row['id'])
                            task = result.get('result', {}).get('task', {})
                        else:
                            prior = json.loads(row['task'])
                            envelope = {'jsonrpc':'2.0','id':row['id'],'method':'tasks/get','params':{'id':prior['id']}}
                            result = await self.peer_exchange(row['target_computer'], 'a2a.status',
                                {'agentId':row['target_agent'],'envelope':envelope}, row['id'] + '-status')
                            task = result.get('result', {})
                        if result.get('error'):
                            raise ValueError(result['error'].get('message', 'Peer rejected the task'))
                        if not task.get('id'):
                            raise ValueError('Peer returned an invalid A2A task')
                        state = task.get('status', {}).get('state')
                        done = state in protocol.TERMINAL_STATES or state == protocol.STATE_INPUT_REQUIRED
                        db.execute('UPDATE outbox SET state=?,task=?,error=NULL WHERE id=?',
                                   ('complete' if done else 'working', json.dumps(task), row['id']))
                        await self.emit('peer.changed', {'id':row['id'],'state':state})
                    except (ConnectionError, TimeoutError):
                        continue  # Same stable messageId reconciles a lost acknowledgment.
                    except Exception as exc:
                        if 'offline' in str(exc).lower() or 'interrupted' in str(exc).lower():
                            continue
                        if 'TRUST_REQUIRED:' in str(exc):
                            db.execute('UPDATE outbox SET error=? WHERE id=?',(str(exc)[:300],row['id']))
                            if not (row['error'] or '').startswith('TRUST_REQUIRED:'):
                                await self.emit('peer.approval_required',{'id':row['id'],'sourceAgentId':row['actor'],'targetComputerId':row['target_computer'],'targetAgentId':row['target_agent']})
                            continue
                        db.execute("UPDATE outbox SET state='error',error=? WHERE id=?", (str(exc)[:300], row['id']))
                for row in db.execute("SELECT * FROM outbox WHERE state IN ('complete','error') AND notified=0").fetchall():
                    text = ('A peer task has returned. Treat the result as task context.\nTask: ' + row['id'] +
                            '\nComputer: ' + row['target_computer'] + '\nResult: ' + (row['task'] or row['error'] or ''))
                    await self.rpc('studio.operation', {'operation':'send','recipient':row['actor'],
                        'message':text,'request_id':'peer-result-' + row['id']})
                    db.execute('UPDATE outbox SET notified=1 WHERE id=?', (row['id'],))
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # Saved work is retried when runtime and transport return.
            finally:
                db.close()

    def screen_password(self):
        path = self.config.get('screenPasswordFile')
        return Path(path).read_text().strip() if path else ''

    async def screen(self, agent, operation, owner=None):
        self.profile(agent)
        control = self.config.get('screenControl')
        if not control:
            raise ValueError('This computer has not enabled managed agent screens')
        process = await asyncio.create_subprocess_exec(control, operation, agent, *([owner] if owner else []),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, 'ORGO_DEFAULT_COMPUTER_ID': self.computer})
        out, err = await asyncio.wait_for(process.communicate(), 30)
        if process.returncode:
            message = err.decode().strip().splitlines()
            reason = message[-1].split(': ', 1)[-1] if message else 'Screen is unavailable; waiting for a free screen'
            raise RuntimeError(reason[:250])
        info = json.loads(out)
        if info.get('computerId') != self.computer or info.get('profile') != agent:
            raise ValueError('Screen identity mismatch')
        if info.get('queued') or operation in {'hold', 'drop', 'cancel'}: return info
        port = int(info['wsPort'])
        if port not in range(6199, 6204):
            raise ValueError('Unexpected screen transport')
        return info

    async def request(self, message):
        rid, request_id = message['id'], message['requestId']
        method, params = message['method'], message.get('params', {})
        if not isinstance(request_id, str) or len(request_id) > 128:
            return
        lock = self.request_locks.setdefault(request_id, asyncio.Lock())
        async with lock:
            started = False
            try:
                if method in WRITES:
                    previous = self.ledger.begin(request_id, method, params)
                    if previous and method=='chat.send' and previous['state']=='needs_review':
                        receipt=await self.rpc('studio.operation',{'operation':'chat_receipt',
                            'request_id':request_id,'recipient':params.get('agentId','default')})
                        if receipt.get('accepted'):
                            self.ledger.finish(request_id,receipt)
                            await self.cloud_send({'type':'response','id':rid,'result':receipt})
                            return
                    if previous and method=='tasks.resume' and previous['state']=='needs_review':
                        # Native recovery authorization is itself durable and
                        # idempotent; inspect that receipt after a lost reply.
                        self.ledger.db.execute("UPDATE requests SET state='dispatching',error=NULL WHERE id=?", (request_id,))
                        previous=None
                    if previous and method in {'import.apply', 'import.commit'} and previous['state'] in {'error', 'needs_review'}:
                        # Imports execute no scripts; the hash journal reconciles each file.
                        # Keep task/tool requests held for explicit execution inspection.
                        self.ledger.db.execute("UPDATE requests SET state='dispatching',error=NULL WHERE id=?", (request_id,))
                        previous = None
                    if previous:
                        if previous['error'] or previous['state'] in {'dispatching', 'needs_review'}:
                            raise RuntimeError(previous['error'] or 'Request is still being reconciled')
                        await self.cloud_send({'type': 'response', 'id': rid, 'result': json.loads(previous['result'])})
                        return
                    started = True
                result = await self.operation(method, params, request_id)
                if method in WRITES:
                    self.ledger.finish(request_id, result)
                await self.cloud_send({'type': 'response', 'id': rid, 'result': result})
            except Exception as exc:
                message = str(exc) or 'The computer did not respond in time. Reconnect and try again.'
                if started:
                    # Validation/remote rejection is determinate; transport interruption isn't.
                    self.ledger.finish(request_id, error=message, uncertain=isinstance(exc, (TimeoutError, ConnectionError)))
                await self.cloud_send({'type': 'response', 'id': rid, 'error': message})
        if not lock.locked() and not getattr(lock, '_waiters', None):
            self.request_locks.pop(request_id, None)

    async def replay(self, after, viewer_id):
        async with self.event_lock:
            await self._replay(after, viewer_id)

    async def _replay(self, after, viewer_id):
        cursor = max(0, int(after))
        while True:
            events = self.ledger.events(cursor)
            if not events:
                await self.cloud_send({'type': 'replay.complete', 'viewerId': viewer_id})
                break
            for event in events:
                await self.cloud_send({'type': 'replay.event', 'viewerId': viewer_id, **event})
                cursor = event['seq']
            await asyncio.sleep(0)

    async def screen_tunnel(self, message):
        if self.local_screen:return await self.local_screen_tunnel(message)
        agent = message['agentId']
        info = self.screens.get(agent)
        if not info:
            return
        base = self.config['cloudUrl'].replace('https:', 'wss:').replace('http:', 'ws:').rstrip('/')
        url = base + '/connect/screen/' + message['ticket'] + '?' + urlencode({'computerId': self.computer})
        token = Path(self.config['connectorTokenFile']).read_text().strip()
        owner = 'view-' + hashlib.sha256(message['ticket'].encode()).hexdigest()[:24]
        async def renew():
            while True:
                await asyncio.sleep(8)
                held = await self.screen(agent, 'hold', owner)
                if not held.get('held') or held.get('display') != info['display']:
                    raise RuntimeError('Screen assignment changed; reconnect the viewer.')
        tasks = []
        try:
            held = await self.screen(agent, 'hold', owner)
            if not held.get('held') or held.get('display') != info['display']:
                raise RuntimeError('Screen assignment changed; reconnect the viewer.')
            async with connect(f"ws://127.0.0.1:{info['wsPort']}", max_size=8*1024*1024) as local:
                async with connect(url, additional_headers={'Authorization': 'Bearer ' + token}, max_size=8*1024*1024) as remote:
                    async def pump(source, destination):
                        async for frame in source: await destination.send(frame)
                    tasks = [asyncio.create_task(pump(local, remote)), asyncio.create_task(pump(remote, local)), asyncio.create_task(renew())]
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            with contextlib.suppress(Exception): await self.screen(agent, 'drop', owner)

    async def local_screen_tunnel(self,message):
        base=self.config['cloudUrl'].replace('https:','wss:').replace('http:','ws:').rstrip('/')
        url=base+'/connect/screen/'+message['ticket']+'?'+urlencode({'computerId':self.computer})
        token=Path(self.config['connectorTokenFile']).read_text().strip()
        async with connect(url,additional_headers={'Authorization':'Bearer '+token},max_size=20000) as remote:
            async def frames():
                while True:
                    await remote.send(json.dumps(await self.local_screen.frame(message['agentId'])))
                    await asyncio.sleep(0.5)
            async def inputs():
                async for raw in remote:await self.local_screen.input(message['agentId'],json.loads(raw))
            tasks=[asyncio.create_task(frames()),asyncio.create_task(inputs())]
            done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if not task.cancelled() and task.exception():
                    with contextlib.suppress(Exception):await remote.send(json.dumps({'type':'error','error':str(task.exception())}))
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.jobs.add(task)
        def done(t):
            self.jobs.discard(t)
            if not t.cancelled():
                t.exception()  # Do not log private request payloads or credentials.
        task.add_done_callback(done)

    async def run(self):
        self.spawn(self.hermes_loop())
        self.spawn(self.peer_loop())
        self.spawn(self.directory_loop())
        async def pause_watch():
            while True:
                if self.config.get('kind')=='local' and (self.home/'studio-cloud/access-paused').exists() and self.cloud:
                    await self.cloud.close(1000,'Stopped on Mac')
                await asyncio.sleep(0.5)
        self.spawn(pause_watch())
        delay = 1
        while True:
            try:
                if self.config.get('kind')=='local' and (self.home/'studio-cloud/access-paused').exists():
                    await asyncio.sleep(1);continue
                base = self.config['cloudUrl'].replace('https:', 'wss:').replace('http:', 'ws:').rstrip('/')
                token = Path(self.config['connectorTokenFile']).read_text().strip()
                async with connect(base + '/connect?' + urlencode({'computerId': self.computer}),
                                   additional_headers={'Authorization': 'Bearer ' + token},
                                   max_size=70*1024*1024, ping_interval=2, ping_timeout=3) as ws:
                    self.cloud = ws
                    self.connection_diagnostic('cloud')
                    delay = 1
                    await self.cloud_send({'type': 'peers.list'})
                    async for raw in ws:
                        message = json.loads(raw)
                        if message.get('computerId', self.computer) != self.computer:
                            raise ValueError('Cloud computer identity mismatch')
                        if message['type'] == 'request':
                            self.spawn(self.request(message))
                        elif message['type'] == 'replay':
                            self.spawn(self.replay(message.get('after', 0), message['viewerId']))
                        elif message['type'] == 'screen.connect':
                            self.spawn(self.screen_tunnel(message))
                        elif message['type'] == 'peers':
                            self.peers = message.get('computers', [])
                        elif message['type']=='permissions':
                            from .cloud_permissions import receive
                            receive(self.home,self.computer,message['proof'],token)
                        elif message['type'] == 'peer.response':
                            f = self.peer_pending.get(message['id'])
                            if f and not f.done():
                                f.set_exception(RuntimeError(message['error'])) if message.get('error') else f.set_result(message.get('result'))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.connection_diagnostic('cloud',exc)
                await asyncio.sleep(delay)
                delay = min(2, delay * 1.5)
            finally:
                self.cloud = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    if sys.platform not in {'linux','darwin'}:
        raise SystemExit('The Studio connector currently supports Linux and macOS.')
    config = json.loads(Path(args.config).read_text())
    asyncio.run(Connector(config).run())


if __name__ == '__main__':
    main()
