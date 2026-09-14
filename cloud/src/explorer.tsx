import {useEffect,useRef,useState} from 'react'
import {rpc} from './api'
export function Explorer({computer,agent,local=false}:{computer:string;agent:string;local?:boolean}) {
  const [roots,setRoots]=useState<any[]>([]),[root,setRoot]=useState(''),[path,setPath]=useState(''),[entries,setEntries]=useState<any[]>([])
  const [next,setNext]=useState<number|null>(null),[folder,setFolder]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [preview,setPreview]=useState<{name:string;text:string}|null>(null)
  const [picker,setPicker]=useState<any>(null)
  async function browse(value=''){setBusy(true);setError('');try{setPicker(await rpc(computer,'explorer.folders',{agentId:agent,path:value}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  function added(r:any){if(r.cancelled)return;setRoots(r.roots);setRoot(r.roots.at(-1)?.id||'');setPath('');setPicker(null);setFolder('')}
  const generation=useRef(0)
  useEffect(()=>{let live=true;void rpc(computer,'explorer.roots',{agentId:agent}).then(r=>{if(live){setRoots(r.roots);setRoot(r.roots[0]?.id||'')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false;generation.current++}},[computer,agent])
  useEffect(()=>{
    const g=++generation.current;setEntries([]);setNext(null);setPreview(null);setError('')
    if(root)void rpc(computer,'explorer.list',{agentId:agent,root,path}).then(r=>{if(g===generation.current){setEntries(r.entries);setNext(r.nextOffset)}}).catch(e=>{if(g===generation.current)setError(e.message)})
  },[computer,agent,root,path])
  async function file(entry:any,download:boolean){
    const g=generation.current;setBusy(true);setError('')
    try {
      let offset=0,version='',name=entry.name;const chunks:Uint8Array<ArrayBuffer>[]=[]
      do {
        const r=await rpc(computer,'explorer.read',{agentId:agent,root,path:entry.path,offset,version:version||undefined})
        if(g!==generation.current)return
        const bytes=Uint8Array.from(atob(r.data),(c:string)=>c.charCodeAt(0));chunks.push(bytes);version=r.version;name=r.name
        if(r.complete||!download)break
        if(r.nextOffset<=offset)throw Error('File download stopped making progress.')
        offset=r.nextOffset
      }while(true)
      const blob=new Blob(chunks)
      if(download){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
      else {
        const text=await blob.text()
        setPreview({name,text:text.includes('\0')?'This file needs its original application. Use Download to open it.':text.slice(0,100000)+(text.length>100000?'\n… Preview shortened. Download for the complete file.':'')})
      }
    }catch(e){if(g===generation.current)setError((e as Error).message)}finally{if(g===generation.current)setBusy(false)}
  }
  return <>
    <h2>Computer files</h2><p>Browse this agent’s work folders. Credential files stay private.</p>
    <label>Folder<select value={root} onChange={e=>{setRoot(e.target.value);setPath('')}}>{roots.map(r=><option key={r.id} value={r.id}>{r.path}</option>)}</select></label>
    <div className="computer-row"><span>{path||'Work folder'}</span>{path&&<button onClick={()=>setPath(path.split('/').slice(0,-1).join('/'))}>Up one folder</button>}</div>
    {entries.map(e=><div className="computer-row" key={e.path}><button disabled={busy} onClick={()=>e.directory?setPath(e.path):void file(e,false)}>{e.directory?'▱':'▤'} {e.name}</button>{!e.directory&&<button disabled={busy} onClick={()=>void file(e,true)}>Download</button>}</div>)}
    {next!==null&&<button onClick={()=>{const g=generation.current;void rpc(computer,'explorer.list',{agentId:agent,root,path,offset:next}).then(r=>{if(g===generation.current){setEntries(v=>[...v,...r.entries]);setNext(r.nextOffset)}}).catch(e=>setError(e.message))}}>Load more files</button>}
    {preview&&<div className="file-preview"><strong>{preview.name}</strong><pre>{preview.text}</pre></div>}
    <section className="connection-card"><h3>Add a work folder</h3><p className="small-note">Choose a folder on {local?'your Mac':'this Orgo computer'}. It stays private to this profile in Studio.</p>
      {local&&<button disabled={busy} onClick={async()=>{setBusy(true);setError('');try{added(await rpc(computer,'explorer.choose',{agentId:agent}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>Choose folder on Mac…</button>}
      <button disabled={busy} onClick={()=>void browse()}>Browse folders…</button>
      {busy&&<p role="status">{local?'Check your Mac for the folder dialog, or wait for the selected folder.':'Loading folders…'}</p>}
      {picker&&<div className="folder-picker"><strong>{picker.path||'Choose a location'}</strong>
        {picker.path&&<button disabled={busy} onClick={()=>void browse(picker.parent)}>Up one folder</button>}
        {picker.folders.map((f:any)=><button className="computer-row" disabled={busy} key={f.path} onClick={()=>void browse(f.path)}>▱ {f.name} →</button>)}
        {!picker.folders.length&&<p className="small-note">No subfolders.</p>}
        <button className="primary" disabled={busy||!picker.selectable} onClick={()=>{setBusy(true);void rpc(computer,'explorer.add',{agentId:agent,path:picker.path}).then(added).catch(e=>setError(e.message)).finally(()=>setBusy(false))}}>Use this folder</button>
        <button onClick={()=>setPicker(null)}>Cancel</button>
      </div>}
      <details><summary>Enter a path manually</summary><form onSubmit={e=>{e.preventDefault();setError('');void rpc(computer,'explorer.add',{agentId:agent,path:folder}).then(added).catch(e=>setError(e.message))}}><label>Folder path<input value={folder} onChange={e=>setFolder(e.target.value)} required/></label><button>Allow this folder</button></form></details>
    </section>
    {error&&<p className="connection-error" role="alert">{error}</p>}
  </>
}
