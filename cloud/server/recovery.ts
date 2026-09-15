import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ControlStore } from './control-store.ts'
import { Computers } from './computers.ts'
import { sshRecovery, validateSsh, type SshRecovery } from './recovery-ssh.ts'

type Rpc=(id:string,method:string,params:unknown,request?:string)=>Promise<any>
type State={computerId:string;state:string;detail:string;since:number;checked:number;lastSuccess?:number;connector:boolean;hermes:string;conversations:string;reachability:string;transport?:string;incident?:string;attempts:number[];submitted?:boolean;sshConfigured?:boolean}
const reasons:Record<string,string>={paused:'Connection was deliberately stopped. It has been preserved.',ownership_unknown:'Connection ownership could not be verified. Existing work was preserved.',runtime_unavailable:'Hermes is unavailable. Its running work has not been restarted.',not_installed:'This computer needs first-time setup.',inspection_failed:'The computer could not complete its connection check.',connector_running:'The connector is running and trying to reconnect.',connector_failed:'The Studio connector stopped unexpectedly.',attempt_limit:'Automatic repair reached its limit. Review this computer before retrying.',repair_uncertain:'Checking the previous repair before doing anything else.',awaiting_connection:'Connector started. Waiting for Hermes and conversation checks.',repair_busy:'Another connection repair is already running.'}
export class Recovery {
  private busy=new Map<string,Promise<void>>()
  private stopped=false
  private timer?:ReturnType<typeof setInterval>
  constructor(readonly control:ControlStore,readonly computers:Computers,readonly online:(id:string)=>boolean,readonly rpc:Rpc,readonly changed:()=>void,readonly now=Date.now,readonly ssh=sshRecovery) {}
  key(id:string){return 'recovery.'+id}
  get(id:string):State {
    return this.control.get(this.key(id))||{computerId:id,state:'reconnecting',detail:'Checking the computer connection.',since:this.now(),checked:0,connector:this.online(id),hermes:'unknown',conversations:'check_on_open',reachability:'unknown',attempts:[]}
  }
  status(id:string){const s=this.get(id);return {...s,connector:this.online(id),state:!this.online(id)&&s.state==='connected'?'reconnecting':s.state,incident:undefined,submitted:undefined,attempts:undefined,sshConfigured:!!this.control.get('recovery.ssh.'+id)}}
  save(id:string,patch:Partial<State>){if(this.stopped)return;this.control.set(this.key(id),{...this.get(id),...patch});this.changed()}
  start(){this.timer=setInterval(()=>{for(const c of this.control.computers() as any[])if(c.kind==='orgo'&&c.lastSeen)void this.check(c.id)},5000);this.timer.unref()}
  async close(){this.stopped=true;clearInterval(this.timer);await Promise.allSettled([...this.busy.values()])}
  check(id:string,manual=false){
    const c=(this.control.computers() as any[]).find(c=>c.id===id)
    if(!c||c.kind!=='orgo')return Promise.reject(Error('Choose a saved Orgo computer.'))
    const active=this.busy.get(id);if(active)return active
    const task=this.run(id,manual).catch(()=>this.save(id,{state:'repair_needed',detail:'Connection checks could not finish. Existing work was preserved.',checked:this.now()})).finally(()=>this.busy.delete(id))
    this.busy.set(id,task);return task
  }
  async configureSsh(id:string,value:SshRecovery|null){
    if(!(this.control.computers() as any[]).some(c=>c.id===id&&c.kind==='orgo'))throw Error('Choose a saved Orgo computer.')
    if(value===null){this.control.set('recovery.ssh.'+id,null);this.changed();return}
    validateSsh(value)
    const request={computerId:id,origin:this.computers.origin,action:'inspect',requestId:randomUUID()}
    const blocked=await this.ssh(value,request,'printf STUDIO_UNRESTRICTED_SHELL')
    if(blocked?.code!=='inspection_failed')throw Error('This key is not restricted to the Studio recovery command.')
    const result=await this.ssh(value,request)
    if(result?.computerId!==id||!['connector_running','connector_failed','paused'].includes(result.code))throw Error('SSH could not verify this computer and its restricted recovery helper.')
    this.control.set('recovery.ssh.'+id,value);this.changed()
  }
  async command(id:string,action:'inspect'|'repair',requestId:string) {
    const request={computerId:id,origin:this.computers.origin,action,requestId}
    try {
      const script=readFileSync(path.join(this.computers.assets,'recover.py'),'utf8')
      // JSON travels as encoded stdin data to a fixed reviewed helper. No user shell.
      const body=Buffer.from(JSON.stringify(request)).toString('base64')
      const code=Buffer.from(script).toString('base64')
      const command=`python3 -c 'import base64,io,sys;sys.stdin=io.TextIOWrapper(io.BytesIO(base64.b64decode("${body}")));exec(compile(base64.b64decode("${code}"),"studio-recovery","exec"))'`
      const output=await this.computers.bash(id,command)
      const result=JSON.parse(output.trim().split('\n').at(-1)!)
      if(result.protocol!==1||result.computerId!==id) return {code:'ownership_unknown',computerId:id,transport:'orgo_api'}
      return {...result,transport:'orgo_api'}
    }catch(error){
      if((error as {permanent?:boolean})?.permanent)throw error
      const config=this.control.get('recovery.ssh.'+id)
      if(!config)throw error
      // Same operation and receipt across transports, including ambiguous API timeouts.
      const result=await this.ssh(config,request)
      if(result.protocol!==1||result.computerId!==id)throw Error('Recovery identity mismatch')
      return {...result,transport:'ssh'}
    }
  }
  private async run(id:string,manual:boolean){
    let s=this.get(id),now=this.now()
    if(!manual&&now-s.checked<30000)return
    if(this.online(id)){
      if(!s.incident&&!manual&&s.state==='connected'&&now-s.checked<30000)return
      this.save(id,{connector:true,reachability:'reachable',checked:now})
      const health=await this.rpc(id,'connection.status',{})
      if(health.computerId!==id||!health.runtimeConnected){this.save(id,{state:'repair_needed',hermes:'unavailable',conversations:'unknown',detail:'The computer is connected, but Hermes needs attention.'});return}
      let conversations=s.conversations
      if(s.incident||manual){
        if(!health.capabilities?.connectionRecovery){this.save(id,{state:'repair_needed',hermes:'ready',detail:'Connected to Hermes. Update the Studio connector to verify saved conversations.',conversations:'unknown'});return}
        const result=await this.rpc(id,'connection.reconcile',{},s.incident||randomUUID())
        if(result.computerId!==id||!result.reconciled){this.save(id,{state:'repair_needed',hermes:'ready',conversations:'needs_review',detail:'Connected to Hermes. A saved conversation needs review.'});return}
        conversations='reconciled'
      }
      this.save(id,{state:'connected',detail:'Connected to Hermes.',connector:true,hermes:'ready',conversations,lastSuccess:now,checked:now,incident:undefined,submitted:false,since:now});return
    }
    if(!s.incident){this.save(id,{incident:randomUUID(),state:'reconnecting',detail:'Waiting for the computer to reconnect.',since:now,checked:now,connector:false,hermes:'unknown',conversations:'unknown'});return}
    if(now-s.since<30000||(!manual&&s.state==='repair_needed'))return
    // Installation owns its own separate receipt and must finish before recovery.
    if((this.control.jobs() as any[]).some(j=>j.computerId===id&&!['connected','failed','needs_action'].includes(j.state)))return
    this.save(id,{checked:now,connector:false})
    let diagnostic
    try{diagnostic=await this.command(id,'inspect',s.incident)}catch(error){
      const stop=now-s.since>=600000||(error as {permanent?:boolean})?.permanent||/identity changed|revoked|expired/.test(String((error as Error)?.message))
      this.save(id,{state:stop?'repair_needed':'reconnecting',reachability:'unavailable',detail:'The computer could not be reached for repair. Checking Orgo access and the verified SSH connection.'});return
    }
    if(this.stopped||this.online(id))return
    this.save(id,{reachability:'reachable',transport:diagnostic.transport,hermes:diagnostic.code==='runtime_unavailable'?'unavailable':'unknown',detail:reasons[diagnostic.code]||'Connection needs review.'})
    if(diagnostic.code==='connector_running'){
      this.save(id,{state:now-s.since>=600000?'repair_needed':'reconnecting'});return
    }
    if(diagnostic.code!=='connector_failed'){this.save(id,{state:'repair_needed'});return}
    s=this.get(id)
    const attempts=s.attempts.filter(at=>at>now-600000)
    if(!s.submitted&&attempts.length>=2){this.save(id,{state:'repair_needed',detail:reasons.attempt_limit});return}
    if(!s.submitted){
      attempts.push(now)
      this.save(id,{submitted:true,attempts,state:'repairing',detail:'Starting the failed Studio connector. Hermes and desktops stay running.'})
    }
    // A persisted submitted job always reuses its ID, even after a gateway restart.
    let result
    try{result=await this.command(id,'repair',s.incident!)}catch{this.save(id,{state:'repairing',detail:reasons.repair_uncertain});return}
    if(this.stopped)return
    if(result.code==='awaiting_connection'||result.code==='repair_uncertain'){
      this.save(id,{state:now-s.since>=600000?'repair_needed':'repairing',detail:reasons[result.code],transport:result.transport})
    }else this.save(id,{state:'repair_needed',detail:reasons[result.code]||'Connection needs review.'})
  }
}
