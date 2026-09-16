"""Adapter to Hermes' existing profile, session, prompt and cancellation methods.

Only the remote gateway owns this service. It does not call a model itself.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import threading
import time
from .store import Store

_service = None


def specialist_toolsets(owner):
    """Resolve Hermes bundles before narrowing a specialist's grant."""
    from toolsets import resolve_toolset
    grants=(owner.get('tools') or {}).get('enabled_toolsets')
    if grants is None: grants=(owner.get('platform_toolsets') or {}).get('cli')
    if grants is None: grants=owner.get('toolsets', ['hermes-cli'])
    allowed=set()
    for grant in grants: allowed.update(resolve_toolset(grant))
    disabled=(owner.get('agent') or {}).get('disabled_toolsets') or []
    for grant in disabled: allowed.difference_update(resolve_toolset(grant))
    result=[]
    for name in ('terminal','file','web','browser','skills','memory','session_search','vision'):
        tools=set(resolve_toolset(name))
        if name not in disabled and (tools and tools.issubset(allowed)): result.append(name)
    if 'orgo-screen' not in disabled and ('orgo-screen' in grants or 'browser_navigate' in allowed): result.append('orgo-screen')
    # Coordination is the explicitly enabled Studio extension, independent of
    # a profile's model and filesystem tool grants.
    result.append('studio')
    from .machine import kind
    if kind()=='local':
        result=[x for x in result if x!='orgo-screen']
        if 'computer_use' not in disabled and 'computer_use' in allowed:result.append('computer_use')
    return result


def screen_config(profile):
    from .machine import computer_id as verify_binding
    computer_id = verify_binding()
    import sys
    return {'command':sys.executable,
            'args':['-m','hermes_cli.orgo_screen_mcp'],'trust':'full','timeout':120,
            'env':{'ORGO_AGENT_PROFILE':profile,'PYTHONPATH':str(Path(__file__).resolve().parent.parent),
                   'HERMES_HOME':str(Path('/root/.hermes') if profile=='default' else Path('/root/.hermes/profiles')/profile),
                   'ORGO_DEFAULT_COMPUTER_ID':computer_id,
                   'BROWSER_BACKEND':'local',
                   'STUDIO_SCREEN_SCHEMA_REVISION':'3',
                   'PATH':str(Path(__file__).resolve().parent.parent/'distribution/computer-tools/node_modules/.bin')+':/opt/hermes-orgo-studio/computer-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'}}


def current():
    if _service is None: raise RuntimeError('Studio collaboration requires the remote Studio gateway')
    return _service


class Service:
    def __init__(self, server, home: Path):
        self.server=server
        self.home=home
        import fcntl
        state=Path(os.environ.get('HERMES_STUDIO_STATE_DIR',str(home/'studio')))
        state.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.owner_lock=(state/'service.lock').open('a+')
        try:
            fcntl.flock(self.owner_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.owner_lock.close()
            raise RuntimeError('Another Studio service already owns this workspace')
        self.store=Store(state/'workspace.sqlite3')
        self.store.recover()
        self.stopped=threading.Event()
        self.creation_lock=threading.RLock()
        self.turn_lock=threading.RLock()
        self.importing=False
        self.adopt_profiles()

    def adopt_profiles(self):
        import yaml
        for path in (self.home/'profiles').glob('*'):
            if not path.is_dir() or path.is_symlink() or not (path/'config.yaml').is_file(): continue
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',path.name): continue
            if self.store.rows('SELECT name FROM agents WHERE name=?',(path.name,)): continue
            meta=yaml.safe_load((path/'profile.yaml').read_text()) if (path/'profile.yaml').exists() else {}
            self.store.add_agent(path.name,(meta or {}).get('description') or 'Existing Hermes agent')

    def settings(self):
        file=self.home/'studio/settings.json'
        value=json.loads(file.read_text()) if file.exists() else {}
        return {'maxConcurrent':max(1,min(16,int(value.get('maxConcurrent',4)))),
                'maxPeerHops':max(1,min(5,int(value.get('maxPeerHops',5))))}

    def task_event(self,delivery_id):
        rows=self.store.rows('SELECT id,sender,recipient,state,runtime_id,stored_id,body,result,created,updated FROM deliveries WHERE id=?',(delivery_id,))
        if rows and hasattr(self.server,'_emit'):
            value=rows[0];value['body']=(value['body'] or '')[:1000];value['result']=(value['result'] or '')[:1000]
            self.server._emit('studio.task','',value)

    def active_turns(self):
        return sum(bool(s.get('running')) for s in self.server._sessions.values())

    def rpc(self, method, params):
        result=self.server._methods[method]('studio-internal',params)
        if 'error' in result: raise RuntimeError(result['error'].get('message','Hermes rejected the request'))
        return result.get('result',{})

    def snapshot(self):
        from tools import approval
        from gateway.run import _redact_approval_command
        def pending_gateway_approvals(key):
            if hasattr(approval,'pending_gateway_approvals'):return approval.pending_gateway_approvals(key)
            if hasattr(approval,'list_gateway_approvals'):return approval.list_gateway_approvals(key)
            # Native Hermes exposes one pending approval per session in the
            # older API; the pinned Orgo runtime also exposes queued approvals.
            if hasattr(approval,'get_pending_gateway_approval'):
                item=approval.get_pending_gateway_approval(key)
                return [item] if item else []
            raise RuntimeError('This Hermes approval API is not compatible with Studio.')
        result=self.store.snapshot()
        result['approvals']=[]
        for agent in result['agents']:
            if not agent['stored_id']: continue
            for item in pending_gateway_approvals(agent['stored_id']):
                result['approvals'].append({**item, 'command':_redact_approval_command(item.get('command')),
                    'agent':agent['name'], 'session_id':agent['runtime_id']})
        return result

    def actor(self):
        from gateway.session_context import get_session_env
        sid=get_session_env('HERMES_SESSION_ID','')
        ui_sid=get_session_env('HERMES_UI_SESSION_ID','')
        for runtime,session in list(self.server._sessions.items()):
            if runtime==ui_sid or session.get('session_key')==sid:
                home=Path(session.get('profile_home') or self.home)
                name='default' if home==self.home else home.name
                self.store.agent(name)
                self.store.bind(name,runtime,session['session_key'])
                return name
        raise PermissionError('Cannot establish the calling Hermes agent identity')

    def create_agent(self, actor, name, role, skills=()):
        if actor not in {'default','user'}: raise PermissionError('Only the head agent or owner may create agents')
        if not re.fullmatch(r'[a-z][a-z0-9_-]{0,47}',name) or name=='default': raise ValueError('Use a unique lowercase agent name')
        if not role.strip() or len(role)>4000: raise ValueError('A role of at most 4000 characters is required')
        with self.creation_lock:
            found=self.store.rows('SELECT * FROM agents WHERE name=?',(name,))
            if found:
                if found[0]['role'] != role: raise ValueError('Agent already exists with another role')
                return found[0]
            self.adopt_profiles()
            if self.store.rows('SELECT name FROM agents WHERE name=?',(name,)):
                return self.store.agent(name)
            skill_paths=[]
            for skill in skills:
                candidate=self.home/'skills'/str(skill)
                if candidate.resolve()!=candidate or not candidate.is_relative_to(self.home/'skills') or '..' in Path(skill).parts or not (candidate/'SKILL.md').is_file():
                    raise ValueError('Select an existing skill from this computer')
                if any(p.is_symlink() for p in candidate.rglob('*')):
                    raise ValueError('Linked skill files cannot be assigned')
                skill_paths.append(candidate)
            from hermes_cli.profiles import create_profile
            import yaml
            # Explicit model/tool grant. No integration credentials, histories,
            # permission allowlists or parent memory are copied to a child.
            owner=yaml.safe_load((self.home/'config.yaml').read_text()) or {}
            config={key:owner[key] for key in ('model','terminal','agent','compression') if key in owner}
            work=self.home.parent/'studio-projects'/'agents'/name
            work.mkdir(parents=True,exist_ok=True,mode=0o700)
            config['terminal']={**config.get('terminal',{}),'backend':'local','cwd':str(work)}
            config['toolsets']=specialist_toolsets(owner)
            home=create_profile(name,no_alias=True,no_skills=True,description=role)
            config['mcp_servers']={'orgo-screen':screen_config(name)} if 'orgo-screen' in config['toolsets'] else {}
            config['platform_toolsets']={'cli':config['toolsets'],'desktop':config['toolsets']}
            config['tools']={'enabled_toolsets':config['toolsets']}
            config['display']={'personality':''}
            config['approvals']={key:value for key,value in owner.get('approvals',{}).items() if key in {'mode','timeout'}}
            config['browser']={'allow_private_urls':owner.get('browser',{}).get('allow_private_urls') is True,
                               'cloud_provider':'local','backend':'off','headed':False}
            import shutil
            for source in skill_paths:
                target=home/'skills'/source.relative_to(self.home/'skills')
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copytree(source,target)
            (home/'config.yaml').write_text(yaml.safe_dump(config))
            (home/'SOUL.md').write_text(role+'\n\nYou are a persistent Hermes teammate in Studio. '
              'Use studio_team to exchange explicit findings and revision requests. '
              'Other agents have private histories. Do not access them or credentials. '
              f'Use {Path.home()/"studio-projects"} for deliberately shared work. '
              'Your terminal and browser execute on Orgo. Use the local headless browser for ordinary public research. '
              'Use orgo-screen for saved logins, uploads, desktop interaction, live viewing, or takeover; wait if a visible slot is busy. '
              'Never switch a visible or authenticated task to a different browser. Never invent teammate replies.\n')
            result=self.store.add_agent(name,role)
            return result

    def operation(self, actor, p):
        op=p.get('operation')
        if op in {'owner_peer_send', 'owner_peer_status'}:
            if actor != 'user': raise PermissionError('Only the owner may select a source profile')
            from .cloud_profiles import profile
            from .cloud_peer import operation
            profile(self.home, p['agentId'])
            self.adopt_profiles()
            return operation(self, p['agentId'], {**p, 'operation': 'peer_send' if op == 'owner_peer_send' else 'peer_status'})
        if op in {'model_select', 'model_status'}:
            if actor != 'user': raise PermissionError('Only the owner may change a conversation model')
            from .cloud_models import operation
            return operation(self, p)
        if op in {'profile_settings_get', 'profile_settings_update'}:
            if actor != 'user': raise PermissionError('Only the owner may manage profile settings')
            from .cloud_settings import operation
            return operation(self, p)
        if op in {'profile_describe','profile_update','provider_keys','provider_configure','provider_check','model_options','skill_update','endpoint_configure','endpoint_list'}:
            if actor!='user': raise PermissionError('Only the owner may manage profile settings')
            from .cloud_profiles import operation
            return operation(self,op,p)
        if op in {'inspect_recovery','resume_recovery'}:
            if actor!='user': raise PermissionError('Only the owner may inspect private recovery history')
            from studio import recovery
            if op=='inspect_recovery': return recovery.inspect(self,p['request_id'])
            return recovery.resume(self,p['request_id'],p.get('inspection_token'))
        if op=='create_agent': return self.create_agent(actor,str(p.get('name','')),str(p.get('role','')),p.get('skills',()))
        if op in {'import','import_archive'}:
            if actor!='user': raise PermissionError('Only the owner may import profiles')
            from .cloud_import import apply_bundle
            from .machine import computer_id as verify_binding
            with self.creation_lock:
                with self.turn_lock:
                    self.importing=True
                    busy={('default' if Path(s.get('profile_home') or self.home)==self.home else Path(s['profile_home']).name)
                          for s in self.server._sessions.values() if s.get('running')}
                try:
                    if op=='import_archive':
                        from .cloud_archive import apply_archive
                        result=apply_archive(self.home,verify_binding(),p['archive'],busy)
                    else: result=apply_bundle(self.home,verify_binding(),p['bundle'],busy)
                    self.adopt_profiles()
                    if result.get('scope') == 'skills':
                        targets={row['target'] for row in result['profiles']}
                        for session in self.server._sessions.values():
                            path=Path(session.get('profile_home') or self.home)
                            name='default' if path==self.home else path.name
                            agent=session.get('agent')
                            if name in targets and agent is not None:agent._invalidate_system_prompt()
                    return result
                finally:
                    with self.turn_lock:self.importing=False
        if op=='cancel_chat':
            if actor!='user': raise PermissionError('Only the owner may stop a conversation')
            with self.turn_lock:
                runtime=p['runtime_id'];session=self.server._sessions.get(runtime)
                if not session: raise ValueError('Conversation is no longer active')
                self.rpc('session.interrupt',{'session_id':runtime})
                rows=self.store.rows("SELECT id FROM deliveries WHERE runtime_id=? AND state IN ('queued','starting','running')",(runtime,))
                for row in rows:
                    self.store.state(row['id'],'cancelled','Stopped by owner')
                    self.task_event(row['id'])
                return {'cancelled':True,'tasks':len(rows)}
        if op=='submit_chat':
            if actor!='user': raise PermissionError('Only the owner may submit a direct conversation')
            runtime=p['runtime_id'];session=self.server._sessions.get(runtime)
            if not session: raise ValueError('Open this conversation before sending')
            home=Path(session.get('profile_home') or self.home)
            name='default' if home==self.home else home.name
            if name!=p['recipient']: raise ValueError('Conversation agent mismatch')
            from .cloud_models import apply
            with self.turn_lock:
                apply(self, {'agentId': name, 'runtimeId': runtime})
            self.adopt_profiles()
            attachments=[]
            if p.get('attachmentIds'):
                from .cloud_files import Files
                from .machine import computer_id as verify_binding
                attachments=Files(home,verify_binding(),name,session['session_key']).resolve(p['attachmentIds'])
            with self.store.lock:
                delivery=self.store.send('user',name,p['message'],request_id=p['request_id'],attachments=attachments)
                if delivery['runtime_id'] and delivery['runtime_id']!=runtime:
                    raise ValueError('Request belongs to another conversation')
                self.store.db.execute("UPDATE deliveries SET runtime_id=?,stored_id=? WHERE id=? AND state='queued'",
                                      (runtime,session['session_key'],delivery['id']))
            self.task_event(delivery['id'])
            return {'accepted':True,'taskId':delivery['id'],'state':delivery['state']}
        if op in {'peers','peer_send','peer_status'}:
            from .cloud_peer import operation
            return operation(self,actor,p)
        if op=='create_group':
            if actor not in {'default','user'}: raise PermissionError('Only the head agent or owner may create groups')
            return self.store.group(str(p['name']),str(p.get('title') or p['name']),p['members'])
        if op=='redirect':
            if actor!='user': raise PermissionError('Only the owner may redirect ongoing work')
            delivery=self.store.send(actor,p['recipient'],p['message'],p.get('group_id'),p.get('request_id'))
            if delivery['state']=='queued':
                with self.store.lock:
                    self.store.db.execute('UPDATE deliveries SET priority=1 WHERE id=?',(delivery['id'],))
                agent=self.store.agent(p['recipient'])
                if agent['runtime_id'] and self.server._sessions.get(agent['runtime_id'],{}).get('running'):
                    self.rpc('session.interrupt',{'session_id':agent['runtime_id']})
            return delivery
        if op=='send':
            from .cloud_peer import local_send
            return local_send(self,actor,p)
        if op=='wait':
            from tools.interrupt import is_interrupted
            deadline=time.monotonic()+min(30,max(0,float(p.get('seconds',10))))
            while time.monotonic()<deadline:
                if is_interrupted() or self.stopped.is_set(): return {'interrupted':True}
                self.stopped.wait(min(.1,max(0,deadline-time.monotonic())))
            p={**p,'operation':'status'}
            op='status'
        if op=='status':
            received=[]
            if actor!='user':
                agent=self.store.agent(actor)
                if not p.get('request_id') and agent['runtime_id'] and self.server._sessions.get(agent['runtime_id'],{}).get('running'):
                    received=self.store.deliver_inbox(actor,agent['runtime_id'],agent['stored_id'])
            snapshot=self.store.snapshot()
            # Agent tools expose only deliberately shared exchanges; user UI can audit all.
            if actor!='user':
                if p.get('request_id'):
                    snapshot['deliveries']=self.store.rows('SELECT * FROM deliveries WHERE id=?',(p['request_id'],))
                snapshot['deliveries']=[d for d in snapshot['deliveries'] if actor in {d['sender'],d['recipient']} or
                  (d['group_id'] and self.store.rows('SELECT 1 FROM members WHERE group_id=? AND agent=?',(d['group_id'],actor)))]
                if p.get('request_id'):
                    if not snapshot['deliveries']: raise PermissionError('No accessible exchange with this ID')
                    return {'delivery':snapshot['deliveries'][0]}
                recent=[d for d in snapshot['deliveries']
                        if not (d['recipient']==actor and d['sender']=='user' and d['state']=='queued')][:20]
                # Repeated waits must not reinsert hundreds of complete replies
                # into model context. Preserve every newly received message ID
                # and offer explicit full-record reads; owner UI stays lossless.
                selected={d['id']:{**d,'state':'running'} for d in received}
                selected.update({d['id']:d for d in recent})
                snapshot['newly_received']=[d['id'] for d in received]
                snapshot['deliveries']=[]
                for delivery in selected.values():
                    preview=dict(delivery)
                    preview['details_truncated']=False
                    for key in ('body','result'):
                        value=preview.get(key)
                        if isinstance(value,str) and len(value)>800:
                            preview[key]=value[:800]+'…'
                            preview['details_truncated']=True
                    snapshot['deliveries'].append(preview)
                snapshot['detail_hint']='Status previews recent exchanges and new inbox messages. Use status with request_id to read any full accessible exchange before relying on truncated details.'
            return snapshot
        if op=='request_approval':
            if actor=='user': raise ValueError('The controlled action must be proposed by an agent')
            agent=self.store.agent(actor)
            if not agent['runtime_id']: raise RuntimeError('The agent has no live Hermes session')
            from tools.approval import _await_gateway_decision
            decision=_await_gateway_decision(agent['stored_id'],
                lambda data:self.server._emit_approval_request(agent['runtime_id'],data),
                {'command':'Create /root/studio-projects/approval-demo.txt',
                 'description':'Controlled Studio test: create a local text file on this Orgo computer.',
                 'choices':['once','deny'],'allow_permanent':False,
                 'pattern_keys':['studio-demo-marker']},surface='desktop')
            if decision.get('resolved') and decision.get('choice')=='once':
                marker=Path('/root/studio-projects/approval-demo.txt')
                text='Created after an explicit Studio approval.\n'
                if marker.exists() and marker.read_text()!=text:
                    raise RuntimeError('Existing file differs; no overwrite was attempted')
                marker.write_text(text)
                return {'approved':True,'path':str(marker),'verified':marker.read_text()==text}
            return {'approved':False,'created':False,'reason':'Denied, expired, or interrupted'}
        if op=='chat_receipt':
            if actor!='user': raise PermissionError('Only the owner may inspect a chat receipt')
            rows=self.store.rows('SELECT * FROM deliveries WHERE id=?',(p['request_id'],))
            if not rows: return {'accepted':False}
            row=rows[0]
            if row['sender']!='user' or row['recipient']!=p['recipient']:
                raise ValueError('Chat receipt identity mismatch')
            return {'accepted':True,'id':row['id'],'state':row['state']}
        if op=='cancel':
            rows=self.store.rows('SELECT * FROM deliveries WHERE id=?',(p['request_id'],))
            if not rows: raise ValueError('Unknown delivery')
            delivery=rows[0]
            if actor not in {'user',delivery['sender']}: raise PermissionError('Only the sender or owner may cancel')
            if delivery['state'] in {'complete','error','cancelled'}: return delivery
            if delivery['runtime_id']: self.rpc('session.interrupt',{'session_id':delivery['runtime_id']})
            self.store.state(delivery['id'],'cancelled','Cancelled by '+actor)
            return {'cancelled':True}
        raise ValueError('Unknown Studio operation')

    def dispatch(self):
        screen_check = 0
        while not self.stopped.wait(.5):
            if time.monotonic() - screen_check > 5:
                screen_check = time.monotonic()
                from .machine import kind
                if kind() == 'orgo':
                    try:
                        from hermes_cli.orgo_screens import lease, reclaim_idle
                        for session in list(self.server._sessions.values()):
                            if session.get('running'):
                                home = Path(session.get('profile_home') or self.home)
                                lease('default' if home == self.home else home.name, 'task-' + str(os.getpid()), 30)
                        reclaim_idle()
                    except Exception:
                        import logging
                        logging.getLogger(__name__).debug('Screen lease maintenance unavailable', exc_info=True)
            if self.importing:continue
            if self.active_turns()>=self.settings()['maxConcurrent']: continue
            delivery=self.store.claim()
            if not delivery: continue
            try:
                from .cloud_permissions import allowed
                if not allowed(self.home,delivery['id']):
                    self.store.state(delivery['id'],'queued');continue
                agent=self.store.agent(delivery['recipient'])
                # A recovered conversation owns its persisted history even if
                # this agent most recently worked in a different conversation.
                runtime=delivery['runtime_id'] or (agent['runtime_id'] if not delivery['stored_id'] or delivery['stored_id']==agent['stored_id'] else None)
                if runtime and runtime in self.server._sessions:
                    if self.server._sessions[runtime].get('running'):
                        self.store.state(delivery['id'],'queued'); continue
                else:
                    params={'profile':agent['name'],'source':'studio' if os.environ.get('HERMES_STUDIO_RUNTIME')=='1' else 'desktop','close_on_disconnect':False,
                            'cwd':str(Path.home()/'studio-projects'),'title':agent['role'][:80]}
                    stored=delivery['stored_id'] or agent['stored_id']
                    if stored:
                        params['session_id']=stored
                        params['omit_messages']=True
                        try:
                            result=self.rpc('session.resume',params)
                        except RuntimeError as exc:
                            if 'session not found' not in str(exc).lower(): raise
                            # A queued, never-dispatched chat can have a reserved
                            # session ID without a persisted first turn yet.
                            params.pop('session_id',None)
                            result=self.rpc('session.create',params)
                    else:
                        result=self.rpc('session.create',params)
                    runtime=result['session_id']
                    stored=result.get('stored_session_id') or agent['stored_id']
                    self.store.bind(agent['name'],runtime,stored)
                    agent=self.store.agent(agent['name'])
                    self.rpc('profiles.configure',{'name':agent['name'],'ui_meta':{'hermes-bots':{'chat':stored}}})
                with self.turn_lock:
                    if self.importing:
                        self.store.state(delivery['id'],'queued');continue
                    from .cloud_models import apply
                    apply(self, {'agentId': agent['name'], 'runtimeId': runtime})
                    row=self.store.rows('SELECT state FROM deliveries WHERE id=?',(delivery['id'],))[0]
                    if row['state']!='starting': continue
                    stored=self.server._sessions.get(runtime,{}).get('session_key') or delivery['stored_id'] or agent['stored_id']
                    self.store.bind(agent['name'],runtime,stored)
                    self.store.started(delivery['id'],runtime,stored)
                    self.task_event(delivery['id'])
                    envelope=f"Studio message {delivery['id']} from {delivery['sender']}"
                    if delivery['group_id']: envelope+=' in project group '+delivery['group_id']
                    attachment_text=''
                    self.server._sessions[runtime]['attached_images']=[]
                    assets=json.loads(delivery.get('attachments') or '[]')
                    if assets:
                        from .cloud_files import Files, IMAGES
                        from .machine import computer_id as verify_binding
                        home=self.home if agent['name']=='default' else self.home/'profiles'/agent['name']
                        files=Files(home,verify_binding(),agent['name'],assets[0]['sessionId'])
                        verified=files.resolve([a['id'] for a in assets])
                        images=[]
                        for asset in verified:
                            path=files.path(asset)
                            attachment_text+='\nAttached file '+json.dumps(asset['name'])+': @file:'+json.dumps(str(path))
                            if path.suffix.lower() in IMAGES: images.append(str(path))
                        self.server._sessions[runtime]['attached_images']=images
                    self.rpc('prompt.submit',{'session_id':runtime,'text':envelope+'\n\n'+delivery['body']+attachment_text})
            except Exception as exc:
                # Dispatch may have reached Hermes before an error. Hold it for
                # inspection, never auto-repeat a possibly completed tool action.
                self.store.state(delivery['id'],'queued' if 'concurrency limit reached' in str(exc) else 'needs_review',str(exc))
                self.task_event(delivery['id'])


def register(server):
    global _service
    if os.getenv('HERMES_STUDIO_RUNTIME')!='1': return
    from .mcp_compat import install as install_mcp_compat
    install_mcp_compat()
    from hermes_constants import get_hermes_home
    _service=Service(server,get_hermes_home())
    from .cloud_permissions import install_guard
    install_guard(_service)
    def handle(rid,params):
        try: return server._ok(rid,_service.operation('user',params))
        except Exception as exc: return server._err(rid,4091,str(exc))
    def create_profile(rid,params):
        try:
            name=str(params.get('name',''))
            result=_service.create_agent('user',name,str(params.get('description') or params.get('soul') or name))
            return server._ok(rid,{'name':name,'path':str(_service.home/'profiles'/name),'soul_written':True,'agent':result})
        except Exception as exc: return server._err(rid,4062,str(exc))
    server._methods['profiles.create']=create_profile
    server._methods['studio.operation']=handle
    original_prompt=server._methods['prompt.submit']
    def limited_prompt(rid,params):
        with _service.turn_lock:
            if _service.importing:
                return server._err(rid,4095,'Profiles are being imported; accepted work remains queued')
            if _service.active_turns()>=_service.settings()['maxConcurrent']:
                return server._err(rid,4095,'Computer concurrency limit reached; work remains queued')
            session = server._sessions.get(params.get('session_id'))
            if session and not session.get('running'):
                from .cloud_settings import apply_pending
                try: apply_pending(_service, params['session_id'], session)
                except Exception:
                    return server._err(rid, 4095, 'Saved settings could not be activated. Review this agent’s settings before sending another turn.')
            return original_prompt(rid,params)
    server._methods['prompt.submit']=limited_prompt
    def a2a(rid,params):
        from .cloud_a2a import dispatch
        try: return server._ok(rid,dispatch(_service,params))
        except Exception as exc: return server._err(rid,4096,str(exc))
    server._methods['studio.a2a']=a2a
    server._methods['studio.capabilities']=lambda rid,params:server._ok(rid,{'protocol':1,'teams':True,'a2a':True,'imports':True,'files':True,'profiles':True,'providerKeys':True,'librarySkills':True,'profileSettings':True,'sessionRecovery':True,'transportRecovery':True,'historySearch':True,'screenSessions':True,'headlessOverflow':'local','extensionVersion':'client-ready-screens-1','limits':_service.settings()})
    from .session_recovery import inspect_session, bind_session, recover_sessions
    original_create = server._methods['session.create']
    def create_session(rid, params):
        result = original_create(rid, params)
        runtime = result.get('result', {}).get('session_id')
        identity = params.get('studio_conversation_id')
        if runtime and isinstance(identity, str) and 1 <= len(identity) <= 200:
            server._sessions[runtime]['studio_conversation_id'] = identity
        return result
    server._methods['session.create'] = create_session
    def session_method(fn):
        def invoke(rid, params):
            try: return server._ok(rid, fn(_service, params))
            except Exception as exc: return server._err(rid, 4091, str(exc))
        return invoke
    server._methods['studio.session'] = session_method(inspect_session)
    server._methods['studio.session.bind'] = session_method(bind_session)
    server._methods['studio.sessions.recover'] = session_method(recover_sessions)
    if hasattr(server, '_LONG_HANDLERS'):
        server._LONG_HANDLERS = frozenset(server._LONG_HANDLERS) | {'studio.sessions.recover', 'studio.session.bind', 'session.activate'}
    server._methods['studio.snapshot']=lambda rid,params:server._ok(rid,_service.snapshot())
    def events(rid,params):
        if params.get('summary'):
            counts={r['kind']:r['count'] for r in _service.store.rows(
                'SELECT kind,count(*) AS count FROM events WHERE delivery_id=? GROUP BY kind',(params.get('delivery_id',''),))}
            return server._ok(rid,{'toolStarts':counts.get('tool.start',0),
                'toolResults':sum(counts.get(k,0) for k in ('tool.complete','tool.end','tool.result'))})
        return server._ok(rid,{'events':_service.store.rows('SELECT * FROM events WHERE delivery_id=? ORDER BY seq LIMIT 500',(params.get('delivery_id',''),))})
    server._methods['studio.events']=events
    original_emit=server._emit
    def emit(event,sid,payload=None):
        if event in {'message.complete','tool.start','tool.end','tool.complete','tool.result','approval.request'}:
            _service.store.record(sid,event,payload or {})
        result = original_emit(event,sid,payload)
        if event == 'message.complete':
            for delivery in _service.store.rows('SELECT id FROM deliveries WHERE runtime_id=? ORDER BY updated DESC LIMIT 1',(sid,)):
                _service.task_event(delivery['id'])
            # Screens stay warm. Demand-based reclamation checks task, viewer,
            # and human ownership; a completed turn alone cannot close a viewer.
        return result
    server._emit=emit
    threading.Thread(target=_service.dispatch,name='studio-delivery',daemon=True).start()
