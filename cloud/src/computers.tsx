import {useEffect,useState,useRef} from 'react'
import {api} from './api'

export function ComputerManager({select,refresh,localSetup,initialComputer}:{select:(id:string)=>void;refresh:()=>Promise<void>;localSetup:()=>void;initialComputer?:string}) {
  const [saved,setSaved]=useState<any[]>([]),[orgo,setOrgo]=useState<any>(null)
  const [key,setKey]=useState(''),[manual,setManual]=useState(initialComputer||''),[busy,setBusy]=useState(''),[error,setError]=useState('')
  const connectForm=useRef<HTMLFormElement>(null)
  async function load(){
    const [directory,account]=await Promise.all([api('/api/computers'),api('/api/orgo')])
    setSaved(directory.computers);setOrgo(account)
  }
  useEffect(()=>{
    let disposed=false
    async function poll(){try{if(!disposed)await load()}catch(e){if(!disposed)setError((e as Error).message)}}
    void poll();const timer=setInterval(()=>void poll(),3000)
    return()=>{disposed=true;clearInterval(timer)}
  },[])
  async function action(id:string,fn:()=>Promise<unknown>){
    setBusy(id);setError('')
    try{await fn();await load();await refresh()}catch(e){setError((e as Error).message)}finally{setBusy('')}
  }
  const candidates=(orgo?.computers||[]).filter((c:any)=>!saved.some(s=>s.id===c.id))
  return <>
    <h2>Your computers</h2>
    <p>Each computer has its own Hermes agents, settings, and history.</p>
    <button onClick={localSetup}>Connect local Hermes</button>
    <form ref={connectForm} className="connection-card" onSubmit={e=>{e.preventDefault();void action('manual',async()=>{
      if(key.trim()){await api('/api/orgo',{key:key.trim()});setKey('')}
      await api(saved.some(c=>c.id===manual.trim()&&c.lastSeen)?'/api/connections/repair':'/api/connections/install',{computerId:manual.trim()})
    })}}>
      <h3>Connect an Orgo computer</h3>
      <label>Computer ID<input value={manual} onChange={e=>setManual(e.target.value)} required placeholder="Paste a computer ID from Orgo"/></label>
      <label>Orgo API key {orgo?.configured?'(optional — account key saved)':''}<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder={orgo?.configured?'Use the saved account key':'Paste your Orgo API key'}/></label>
      <p className="small-note">Save your account key once. Studio connects this computer and finds your other Orgo computers. The connector credential is installed for you.</p>
      <button className="primary" disabled={!!busy||!manual.trim()||(!orgo?.configured&&!key.trim())}>{busy==='manual'?'Connecting…':'Connect / Repair computer'}</button>
    </form>
    {saved.map(c=>{
      const job=orgo?.jobs.find((j:any)=>j.computerId===c.id)
      const installing=job&&!['failed','connected','needs_action'].includes(job.state)
      const health=c.recovery
      const labels:Record<string,string>={connected:'Connected',reconnecting:'Reconnecting',repairing:'Repairing',repair_needed:'Repair needed'}
      return <div className="connection-card" key={c.id}>
        <button className="computer-row" onClick={()=>select(c.id)}><i className={c.online?'dot live':'dot'}/><strong>{c.name}</strong><span>{health?labels[health.state]||'Checking':c.online?'Open →':'Offline'}</span></button>
        {health&&<details><summary>Connection details</summary>
          <p className="small-note">{health.detail}</p>
          <dl className="small-note"><dt>Computer</dt><dd>{health.reachability}</dd><dt>Studio connector</dt><dd>{c.online?'Connected':'Disconnected'}</dd><dt>Hermes</dt><dd>{health.hermes}</dd><dt>Saved conversations</dt><dd>{health.conversations==='reconciled'?'Verified':health.conversations==='check_on_open'?'Checked when opened':health.conversations}</dd><dt>Screen</dt><dd>Check the selected agent’s screen panel.</dd><dt>Last verified connection</dt><dd>{health.lastSuccess?new Date(health.lastSuccess).toLocaleString():'Not yet verified'}</dd><dt>SSH recovery</dt><dd>{health.sshConfigured?'Verified restricted connection':'Not configured — Orgo API recovery is available when reachable'}</dd></dl>
          {health.sshConfigured&&<button disabled={!!busy} onClick={()=>void action(c.id,()=>api('/api/connections/ssh',{computerId:c.id,configuration:null}))}>Disable SSH recovery</button>}
        </details>}
        {c.providerName&&c.providerName!==c.name&&<p className="small-note">Orgo: {c.providerName}</p>}
        {(!c.online||health?.state==='repair_needed')&&<>
          <p className="small-note" role="status">{health?.detail||job?.detail||'Finish setup to connect this computer to Studio.'}</p>
          {c.kind!=='local'&&<button disabled={!!busy||!!installing} onClick={()=>{setManual(c.id);if(orgo?.configured||health?.sshConfigured)void action(c.id,()=>api(c.lastSeen?'/api/connections/repair':'/api/connections/install',{computerId:c.id}));else{connectForm.current?.scrollIntoView({behavior:'smooth'});connectForm.current?.querySelector<HTMLInputElement>('input[type=password]')?.focus()}}}>{installing?'Connecting…':orgo?.configured||health?.sshConfigured?'Connect / Repair':'Add Orgo key to connect'}</button>}
          {c.kind==='local'&&<button onClick={localSetup}>Reconnect local Hermes</button>}
        </>}
      </div>
    })}
    <details open={!orgo?.configured}>
      <summary>{orgo?.configured?'Orgo account connected':'Connect your Orgo account'}</summary>
      <p className="small-note">Connect once to find your computers and finish their setup. Your API key stays private and is never shared with agents.</p>
      <form onSubmit={e=>{e.preventDefault();const value=key;setKey('');void action('account',()=>api('/api/orgo',{key:value}))}}>
        <label>Orgo API key<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} required/></label>
        <button className="primary" disabled={!!busy}>{busy==='account'?'Checking…':orgo?.configured?'Replace account key':'Connect Orgo'}</button>
      </form>
      <p className="small-note"><a href="https://www.orgo.ai" target="_blank" rel="noreferrer">Open Orgo</a> to find your API key in account settings.</p>
    </details>
    <details>
      <summary>Connect another computer</summary>
      {orgo?.configured?<>
        <p className="small-note">Choose an existing computer. Studio installs its connector and checks the connection for you.</p>
        {candidates.map((c:any)=><div className="computer-row" key={c.id}><strong>{c.name}</strong><span>{c.status}</span><button disabled={!!busy||c.status!=='running'} onClick={()=>void action(c.id,()=>api('/api/connections/install',{computerId:c.id}))}>{busy===c.id?'Preparing…':'Connect'}</button></div>)}
        {!candidates.length&&<p className="small-note">All discovered computers are already listed above.</p>}
        <button disabled={!!busy} onClick={()=>void action('refresh',()=>api('/api/orgo/refresh',{}))}>Refresh from Orgo</button>
        <details><summary>Enter a computer ID</summary><form onSubmit={e=>{e.preventDefault();void action('manual',()=>api(saved.some(c=>c.id===manual.trim()&&c.lastSeen)?'/api/connections/repair':'/api/connections/install',{computerId:manual.trim()}))}}><label>Computer ID<input value={manual} onChange={e=>setManual(e.target.value)} required/></label><button disabled={!!busy}>Connect computer</button></form></details>
      </>:<p className="small-note">Connect your Orgo account above to select a computer.</p>}
    </details>
    {orgo?.error&&<p className="small-note" role="status">{orgo.error}</p>}
    {error&&<p className="connection-error" role="alert">{error}</p>}
  </>
}
