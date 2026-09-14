"""Narrow collaboration tool; all inference stays inside real Hermes sessions."""
import json
import os
from tools.registry import registry


def studio_team(args, **kwargs):
    try:
        from studio.service import current
        service=current()
        return json.dumps(service.operation(service.actor(),args),ensure_ascii=False)
    except Exception as exc:
        return json.dumps({'error':str(exc)})


registry.register(name='studio_team',toolset='studio',handler=studio_team,
    check_fn=lambda:os.getenv('HERMES_STUDIO_RUNTIME')=='1',
    description='Create persistent teammates and groups; deliver messages to real Hermes sessions and inspect results.',
    schema={'name':'studio_team','description':'Coordinate persistent Hermes teammates. Create specialists as needed, then create a group. Send concrete tasks, inspect status for genuine replies, and send revisions. Status/wait returns compact previews; use status with request_id to read a full exchange. Read truncated details before relying on them. Review a revision only after its builder finishes. Only the head can create agents/groups. Messages queue while recipients are busy. Never invent their replies. Reuse a request_id when retrying an uncertain send. Use peers to discover agents on connected computers, peer_send to delegate to a target_computer and target_agent, and peer_status to inspect acknowledgments and results. Cross-computer tasks return promptly and finish later. Only explicit task text is shared; never send credentials or entire histories.',
      'parameters':{'type':'object','properties':{
        'operation':{'type':'string','enum':['create_agent','create_group','send','status','wait','cancel','request_approval','inspect_recovery','resume_recovery','peers','peer_send','peer_status']},
        'inspection_token':{'type':'string'},'seconds':{'type':'number'},'name':{'type':'string'},'role':{'type':'string'},'title':{'type':'string'},
        'skills':{'type':'array','items':{'type':'string'}},'target_computer':{'type':'string'},'target_agent':{'type':'string'},'peer_task_id':{'type':'string'},
        'members':{'type':'array','items':{'type':'string'}},'recipient':{'type':'string'},
        'message':{'type':'string'},'group_id':{'type':'string'},'request_id':{'type':'string'}},
        'required':['operation']}})
