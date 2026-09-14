import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ControlStore } from './control-store.ts'

const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
type Fetch = typeof globalThis.fetch
class OrgoError extends Error {
  constructor(message:string,readonly permanent:boolean){super(message)}
}
export class Computers {
  timer?:ReturnType<typeof setInterval>
  refreshing?:Promise<void>
  private running=new Set<string>()
  private stopped=false
  constructor(readonly control:ControlStore,readonly origin:string,readonly assets:string,readonly online:(id:string)=>boolean,readonly changed:()=>void,readonly fetch:Fetch=globalThis.fetch) {}
  async request(route:string,key:string,body?:unknown) {
    const response=await this.fetch('https://www.orgo.ai/api/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)})
    if(!response.ok) throw new OrgoError(response.status===401||response.status===403?'Orgo could not authorize this account or computer. Reconnect your Orgo account.':response.status===404?'This computer could not be found in your Orgo account. Check its computer ID.':`Orgo is temporarily unavailable (${response.status}). Try again.`,[400,401,403,404,410,422].includes(response.status))
    return response.json()
  }
  state() {
    const catalog=this.control.get('orgo.catalog')||{computers:[],checked:0,error:''}
    return {...catalog,configured:!!this.control.get('orgo.key'),installerAvailable:existsSync(path.join(this.assets,'runtime.tar.gz')),jobs:this.control.jobs()}
  }
  async saveKey(key:string) {
    if(typeof key!=='string'||key.length<16||key.length>512||/\s/.test(key)) throw Error('Enter your Orgo API key.')
    await this.request('workspaces',key)
    this.control.set('orgo.key',key)
    await this.refresh();return this.state()
  }
  refresh() {
    if(this.refreshing)return this.refreshing
    this.refreshing=this.load().finally(()=>{this.refreshing=undefined})
    return this.refreshing
  }
  private async load() {
    const key=this.control.get('orgo.key');if(!key)return
    const prior=this.control.get('orgo.catalog')||{computers:[],checked:0}
    try {
      const value=await this.request('workspaces',key)
      const workspaces=Array.isArray(value)?value:(value.workspaces||value.projects||[])
      const computers:any[]=[]
      for(const w of workspaces) {
        const details=w.desktops||w.computers?w:await this.request('workspaces/'+w.id,key)
        for(const c of details.desktops||details.computers||[]) if(validId(c.id)) computers.push({id:c.id,name:String(c.name||'Orgo computer'),workspaceId:w.id,workspaceName:w.name,platform:c.os||'linux',status:c.status,cpu:c.cpu,ram:c.ram})
      }
      if(this.stopped)return
      this.control.set('orgo.catalog',{computers,checked:Date.now(),error:''})
      for(const c of computers) {
        const saved=this.control.store.db.prepare('SELECT name,provider_name FROM computers WHERE id=? AND kind=?').get(c.id,'orgo') as any
        if(!saved)continue
        const follows=!saved.provider_name?(saved.name===c.name||saved.name==='Studio Trial'):saved.name===saved.provider_name
        this.control.store.db.prepare('UPDATE computers SET provider_name=?,platform=?,name=? WHERE id=?').run(c.name,c.platform,follows?c.name:saved.name,c.id)
      }
      this.changed()
    } catch (error) {
      if(this.stopped)return
      this.control.set('orgo.catalog',{...prior,error:error instanceof OrgoError?error.message:'Orgo directory could not refresh. Saved connections remain available.'})
    }
  }
  start() {
    void this.refresh()
    this.timer=setInterval(()=>{void this.refresh();void this.resumeJobs()},30000)
    this.timer.unref()
    void this.resumeJobs()
  }
  close() {this.stopped=true;clearInterval(this.timer)}
  async connect(id:string) {
    if(!validId(id))throw Error('Choose an Orgo computer or enter its valid computer ID.')
    if(this.online(id))return {computerId:id,state:'connected'}
    const key=this.control.get('orgo.key');if(!key)throw Error('Connect your Orgo account first.')
    if(!existsSync(path.join(this.assets,'runtime.tar.gz')))throw Error('The installation package is unavailable on this gateway. Its deployment needs repair.')
    const c=await this.request('computers/'+id,key)
    if(c.id!==id||c.os!=='linux')throw Error('Studio currently installs on Orgo Linux computers.')
    if(c.status!=='running')throw Error('This computer is not running. Start it in Orgo before connecting.')
    const active=(this.control.jobs() as any[]).find(j=>j.computerId===id&&!['failed','connected','needs_action'].includes(j.state))
    if(active)return active
    if(!this.control.store.computers().some(x=>x.id===id))this.control.store.addComputer(id,c.name||'Orgo computer')
    this.control.store.db.prepare('UPDATE computers SET provider_name=?,platform=? WHERE id=?').run(c.name,'linux',id)
    const job=randomUUID(),pair=this.control.pairing(id)
    const info={pair:pair.code,origin:this.origin,job,computerId:id,created:Date.now()}
    this.control.saveJob(job,id,'preparing','Preparing a private connection and checking this computer.',info)
    void this.run(job)
    return {id:job,computerId:id,state:'preparing'}
  }
  async resumeJobs() {
    for(const j of this.control.jobs() as any[]) if(!['connected','failed','needs_action'].includes(j.state))void this.run(j.id)
  }
  async bash(computer:string,command:string) {
    const r=await this.request('computers/'+computer+'/bash',this.control.get('orgo.key'),{command})
    if(r.success===false)throw Error('The computer could not complete the setup command.')
    return String(r.output??r.result?.output??'')
  }
  async run(id:string) {
    if(this.running.has(id)||this.stopped)return
    this.running.add(id)
    let job=this.control.job(id)
    if(!job){this.running.delete(id);return}
    try {
      if(this.online(job.computer)) {
        this.control.saveJob(id,job.computer,'connected','Connected. Open this computer to use its Hermes agents.',job.private);this.changed();return
      }
      if(job.private.kind==='local')return
      if(job.private.created<Date.now()-3600000){
        this.control.saveJob(id,job.computer,'failed','Setup credential expired. Use Connect / Repair to prepare a new connection.',job.private);return
      }
      const base='/root/.hermes/studio-cloud/setup/'+id
      if(job.state==='preparing') {
        // The bootstrap itself takes an exclusive lock and reconciles its saved
        // phases. Retrying an uncertain HTTP acknowledgment cannot start it twice.
        const script=readFileSync(path.join(this.assets,'connect.py'),'utf8')
        const config=Buffer.from(JSON.stringify({...job.private,artifactUrl:this.origin+'/setup/artifacts/'+job.private.pair+'/runtime.tar.gz',pairUrl:this.origin+'/api/pairing/exchange',sha256:readFileSync(path.join(this.assets,'runtime.sha256'),'utf8').trim()})).toString('base64')
        const code=Buffer.from(script).toString('base64')
        const command=`python3 - <<'STUDIO_SETUP'\nimport base64,os,subprocess\nfrom pathlib import Path\np=Path('${base}');p.mkdir(parents=True,exist_ok=True,mode=0o700)\nfor name,data in [('config.json','${config}'),('connect.py','${code}')]:\n f=p/name;f.write_bytes(base64.b64decode(data));f.chmod(0o600)\nwith (p/'install.log').open('ab') as log:subprocess.Popen(['/usr/bin/python3',str(p/'connect.py'),str(p/'config.json')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)\nprint('STUDIO_SETUP_STARTED')\nSTUDIO_SETUP`
        await this.bash(job.computer,command)
        if(this.stopped)return
        this.control.saveJob(id,job.computer,'installing','Checking Hermes, preserving state, and installing the connector.',job.private)
      }
      for(let attempt=0;attempt<5&&!this.stopped;attempt++) {
        if(this.online(job.computer)){this.control.saveJob(id,job.computer,'connected','Connected. Your agents and history are ready.',job.private);this.changed();return}
        const output=await this.bash(job.computer,`python3 - <<'STUDIO_STATUS'\nimport json\nfrom pathlib import Path\np=Path('${base}/status.json')\nprint('STUDIO_STATUS '+(p.read_text() if p.exists() else json.dumps({'state':'installing','detail':'Waiting for setup to start.'})))\nSTUDIO_STATUS`)
        const line=output.split('\n').find(l=>l.startsWith('STUDIO_STATUS '))
        if(this.stopped)return
        if(line) {
          const result=JSON.parse(line.slice(14))
          const state=['failed','waiting_for_connector'].includes(result.state)?result.state:'installing'
          this.control.saveJob(id,job.computer,state,String(result.detail||'Installing connector.').slice(0,300),job.private)
          if(state==='failed')return
        }
        await new Promise(r=>setTimeout(r,3000))
      }
    } catch (error) {
      if(this.stopped)return
      // A timeout does not prove the remote installer failed. Its private status
      // is reconciled on the next pass; never rotate a pairing code on retry.
      this.control.saveJob(id,job.computer,error instanceof OrgoError&&error.permanent?'needs_action':job.state==='preparing'?'preparing':'installing',error instanceof OrgoError?error.message:'Reconnecting to setup. Installation progress is preserved.',job.private)
    } finally {this.running.delete(id)}
  }
  artifact(code:string,name:string) {
    if(!['runtime.tar.gz','runtime.sha256'].includes(name))throw Error('Unknown installation artifact.')
    const job=(this.control.jobs() as any[]).map(j=>this.control.job(j.id)).find(j=>j.private.pair===code&&j.private.created>Date.now()-3600000&&!['failed'].includes(j.state))
    if(!job)throw Error('Installation download expired.')
    return path.join(this.assets,name)
  }
}
