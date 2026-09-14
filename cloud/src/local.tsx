import {useEffect,useState} from 'react'
import {api} from './api'
export function LocalSetup({computers,select}:{computers:any[];select:(id:string)=>void}) {
  const locals=computers.filter(c=>c.kind==='local')
  const [id,setId]=useState(locals[0]?.id||''),[name,setName]=useState('My Mac'),[setup,setSetup]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{
    if(!setup)return
    let disposed=false
    const timer=setInterval(()=>void api('/api/computers').then(r=>{
      if(!disposed&&r.computers.some((c:any)=>c.id===setup.computerId&&c.online))setSetup((s:any)=>({...s,connected:true}))
    }).catch(()=>{}),2000)
    return()=>{disposed=true;clearInterval(timer)}
  },[setup?.computerId])
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
    {!setup?<button className="primary" disabled={busy} onClick={()=>void prepare()}>{busy?'Preparing…':'Prepare Mac connection'}</button>:setup.connected?<div className="connection-card"><strong>Your Mac is connected</strong><p>Open it to chat, or return to Import from Hermes to review a transfer.</p><button className="primary" onClick={()=>select(setup.computerId)}>Open local Hermes</button></div>:<div className="connection-card">
      <strong>Open this download on your Mac</strong>
      <ol><li>Download and open the ZIP.</li><li>Open “Connect Studio” inside it. The installer already contains your private connection details.</li><li>Return here; Studio detects the connection automatically.</li></ol>
      <a className="button primary" href={setup.download} download>Download Mac connection</a>
      <p className="small-note">Begin within 10 minutes. Requires an installed Hermes and compatible Apple command line developer tools. This source-built private companion is not yet a notarized public Mac installer.</p>
      <button disabled={busy} onClick={()=>{setId(setup.computerId);void api('/api/connections/local',{computerId:setup.computerId}).then(setSetup).catch(e=>setError(e.message))}}>Prepare a fresh download</button>
    </div>}
    <p className="small-note">Sharing profiles or sending work to another computer needs your approval or a saved trusted connection. Mac desktop access has a separate, timed approval.</p>
    {error&&<p role="alert" className="connection-error">{error}</p>}
  </>
}
