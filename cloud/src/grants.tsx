import {useEffect,useState} from 'react'
import {api,rpc} from './api'
export function TrustedConnections({computers,current}:{computers:any[];current:string}) {
  const [source,setSource]=useState(current),[target,setTarget]=useState(computers.find(c=>c.id!==current)?.id||'')
  const [actors,setActors]=useState<any[]>([]),[agents,setAgents]=useState<any[]>([]),[actor,setActor]=useState(''),[agent,setAgent]=useState('')
  const [grants,setGrants]=useState<any[]>([]),[duration,setDuration]=useState('0'),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const refresh=()=>api('/api/grants').then(r=>setGrants(r.grants))
  useEffect(()=>{void refresh().catch(e=>setError(e.message))},[])
  useEffect(()=>{let live=true;setActor('');setActors([]);if(source)void rpc(source,'agents.list').then(r=>{if(live){setActors(r.agents);setActor(r.agents[0]?.id||'')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[source])
  useEffect(()=>{let live=true;setAgent('');setAgents([]);if(target)void rpc(target,'agents.list').then(r=>{if(live){setAgents(r.agents);setAgent(r.agents[0]?.id||'')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[target])
  const label=(id:string)=>computers.find(c=>c.id===id)?.name||id
  return <>
    <h2>Trusted connections</h2>
    <p>Choose which agents may delegate work to one another. Each connection works in one direction.</p>
    <div className="import-explanation">A trusted connection shares task context and returns its result. It does not mirror profiles, share credentials, or grant access to your Mac’s desktop.</div>
    <form onSubmit={e=>{e.preventDefault();setBusy(true);setError('');void api('/api/grants',{source,actor,target,agent,expires:Number(duration)?Date.now()+Number(duration):null}).then(refresh).catch(e=>setError(e.message)).finally(()=>setBusy(false))}}>
      <label>From computer<select value={source} onChange={e=>setSource(e.target.value)}>{computers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
      <label>From agent<select value={actor} onChange={e=>setActor(e.target.value)}>{actors.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label>
      <label>To computer<select value={target} onChange={e=>setTarget(e.target.value)}>{computers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
      <label>To agent<select value={agent} onChange={e=>setAgent(e.target.value)}>{agents.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label>
      <label>Permission lasts<select value={duration} onChange={e=>setDuration(e.target.value)}><option value="0">Until I revoke it</option><option value="86400000">24 hours</option><option value="3600000">One hour</option></select></label>
      <button className="primary" disabled={busy||!actor||!agent||source===target}>Save trusted connection</button>
      <button type="button" disabled={busy||!actor||!agent||source===target} onClick={async()=>{setBusy(true);setError('');setNotice('');try{const r=await api('/api/grants/check',{source,actor,target,agent});setNotice(r.message)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>Check connection</button>
    </form>
    {grants.map(g=><div className="connection-card" key={g.id}><strong>{label(g.source)} / {g.actor} → {label(g.target)} / {g.agent}</strong><p className="small-note">{g.revoked?'Revoked':g.expires?new Date(g.expires)<new Date()?'Expired':'Expires '+new Date(g.expires).toLocaleString():'Allowed until revoked'}</p>{!g.revoked&&<button onClick={()=>void api('/api/grants/revoke',{id:g.id}).then(refresh).catch(e=>setError(e.message))}>Revoke connection</button>}</div>)}
    {error&&<p className="connection-error" role="alert">{error}</p>}
    {notice&&<p role="status" className="small-note">{notice}</p>}
  </>
}
