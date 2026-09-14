import {useEffect,useState} from 'react'
import {api,rpc} from './api'
export function LocalSetup({computers,select}:{computers:any[];select:(id:string)=>void}) {
  const locals=computers.filter(c=>c.kind==='local')
  const [id,setId]=useState(locals[0]?.id||''),[name,setName]=useState('My Mac'),[setup,setSetup]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [health,setHealth]=useState<any>(null)
  useEffect(()=>{
    let disposed=false
    if(id)void rpc(id,'status').then(value=>{if(!disposed)setHealth(value)}).catch(()=>{if(!disposed)setHealth({runtimeConnected:false})})
    return()=>{disposed=true}
  },[id])
  useEffect(()=>{
    if(!setup)return
    let disposed=false
    const timer=setInterval(()=>void rpc(setup.computerId,'status').then(health=>{
      if(!disposed&&health.runtimeConnected&&health.setupJob===setup.job)setSetup((s:any)=>({...s,connected:true}))
    }).catch(()=>{}),3000)
    return()=>{disposed=true;clearInterval(timer)}
  },[setup?.computerId,setup?.job])
  async function prepare(){
    setBusy(true);setError('')
    try{setSetup(await api('/api/connections/local',id?{computerId:id}:{name}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  return <>
    <h2>Connect your local Hermes</h2>
    <p>Your Mac becomes another computer in Studio, using its existing Hermes profiles, skills, memory, and provider connections.</p>
    {locals.length>0&&<label>Mac connection<select value={id} onChange={e=>{setId(e.target.value);setSetup(null)}}>{locals.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}<option value="">Connect a different Mac</option></select></label>}
    {!id&&<label>Computer name<input value={name} onChange={e=>setName(e.target.value)}/></label>}
    <p className="small-note">The companion makes private backups and installs beside Hermes. This Mac must stay awake and connected for remote work. You can stop Studio access from its ✳ menu.</p>
    {!setup&&id&&<div className="connection-card"><strong>{health?.runtimeConnected?'Hermes is responding':'Hermes needs attention'}</strong>
      <p>{health?.runtimeVersion==='screens-recovery-2'?'The compatible extension is connected. Repair can restore the saved connection if conversation recovery fails.':'Install the compatible companion to enable conversation recovery and selected-skill transfers.'}</p>
      <p className="small-note">A profile import is a copy. This saved Mac connection uses the original Hermes on your computer.</p>
    </div>}
    {!setup?<button className="primary" disabled={busy} onClick={()=>void prepare()}>{busy?'Preparing…':id?'Repair local Hermes':'Prepare Mac connection'}</button>:setup.connected?<div className="connection-card"><strong>Your Mac is connected</strong><p>Open it to chat, or return to Import from Hermes to review a transfer.</p><button className="primary" onClick={()=>select(setup.computerId)}>Open local Hermes</button></div>:<div className="connection-card">
      <strong>Open this download on your Mac</strong>
      <ol><li>Download and open the ZIP.</li><li>Open “Connect Revenue Partner Studio.command” inside the “Connect Revenue Partner Studio” folder. The installer already contains your private connection details.</li><li>Return here; Studio detects the connection automatically.</li></ol>
      <a className="button primary" href={setup.download} download>Download Mac connection</a>
      <p className="small-note">Begin within 10 minutes. Requires an installed Hermes and compatible Apple command line developer tools. This source-built private companion is not yet a notarized public Mac installer.</p>
      <button disabled={busy} onClick={()=>{setId(setup.computerId);void api('/api/connections/local',{computerId:setup.computerId}).then(setSetup).catch(e=>setError(e.message))}}>Prepare a fresh download</button>
    </div>}
    <p className="small-note">Sharing profiles or sending work to another computer needs your approval or a saved trusted connection. Chat and files are available here; desktop control remains on your Mac.</p>
    {error&&<p role="alert" className="connection-error">{error}</p>}
  </>
}
