import {useEffect,useState,type ReactNode} from 'react'
import {api,rpc} from './api'

export function HermesLibrary({computer,name,computers,localSetup,fallback}:{computer:string;name:string;computers:any[];localSetup:()=>void;fallback:ReactNode}) {
  const sources=computers.filter(c=>c.id!==computer)
  const [source,setSource]=useState(sources.find(c=>c.kind==='local')?.id||'')
  const [profiles,setProfiles]=useState<any[]>([]),[chosen,setChosen]=useState<string[]>([]),[jobs,setJobs]=useState<any[]>([])
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{
    let live=true;setProfiles([]);setChosen([]);setError('')
    if(source)void rpc(source,'library.profiles').then(r=>{if(live)setProfiles(r.profiles)}).catch(e=>{if(live)setError(e.message)})
    return()=>{live=false}
  },[source])
  useEffect(()=>{
    let live=true
    const poll=()=>api('/api/transfers').then(r=>{if(live)setJobs(r.transfers.filter((j:any)=>j.target===computer))}).catch(e=>{if(live)setError(e.message)})
    void poll();const timer=setInterval(()=>void poll(),2000)
    return()=>{live=false;clearInterval(timer)}
  },[computer])
  async function action(route:string,body:any){setBusy(true);setError('');try{await api(route,body);const r=await api('/api/transfers');setJobs(r.transfers.filter((j:any)=>j.target===computer))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <>
    <h2>Import from Hermes</h2>
    <p>Bring selected profiles, skills, memory, and history onto <strong>{name}</strong>.</p>
    <div className="import-explanation">Each computer keeps its own copy. You review changes before applying them. Subscription sign-ins and API keys stay separate.</div>
    {!sources.some(c=>c.kind==='local')&&<div className="connection-card"><strong>Use Hermes on your Mac</strong><p className="small-note">The local helper finds your existing Hermes profiles and makes them available here.</p><button onClick={localSetup}>Connect local Hermes</button></div>}
    <label>Copy from<select value={source} onChange={e=>setSource(e.target.value)}><option value="">Choose a computer</option>{sources.map(c=><option key={c.id} value={c.id}>{c.name}{c.online?'':' — offline'}</option>)}</select></label>
    {!!profiles.length&&<div className="profile-selection">{profiles.map(p=><label className="checkbox-row" key={p.id}><input type="checkbox" checked={chosen.includes(p.id)} onChange={e=>setChosen(v=>e.target.checked?[...v,p.id]:v.filter(x=>x!==p.id))}/><span>{p.name}</span></label>)}</div>}
    <button className="primary" disabled={busy||!chosen.length} onClick={()=>void action('/api/transfers',{source,target:computer,profiles:chosen})}>{busy?'Preparing…':'Review selected profiles'}</button>
    {jobs.map(j=><section className="connection-card" key={j.id}>
      <strong>{j.state==='review'?'Ready to review':j.state==='complete'?'Import complete':'Hermes transfer'}</strong>
      <p className="small-note">{computers.find(c=>c.id===j.source)?.name||'Source computer'} → {name}</p>
      <p role="status">{j.detail}</p>
      {j.total>0&&j.state==='copying'&&<progress max={j.total} value={j.offset}/>}
      {j.preview&&j.state==='review'&&<>
        {j.preview.profiles.map((p:any)=><p className="small-note" key={p.source}><strong>{p.source}</strong>: {p.newProfile?'new independent profile; ':''}{p.added} additions, {p.changed} updates, {p.conflicts} conflicts. Conflicts keep both versions.</p>)}
        {j.preview.warnings.map((w:string,i:number)=><p className="small-note" key={i}>{w}</p>)}
        <button className="primary" disabled={busy} onClick={()=>void action('/api/transfers/apply',{id:j.id})}>Apply reviewed changes to {name}</button>
      </>}
      {j.state==='failed'&&<button disabled={busy} onClick={()=>void action('/api/transfers/retry',{id:j.id})}>Retry transfer</button>}
    </section>)}
    {error&&<p className="connection-error" role="alert">{error}</p>}
    <section className="connection-card"><h3>Or choose an export file</h3>{fallback}</section>
  </>
}
