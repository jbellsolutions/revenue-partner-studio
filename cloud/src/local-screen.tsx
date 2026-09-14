import {useEffect,useRef,useState} from 'react'
import {rpc} from './api'
export function LocalDesktop({computer,agent,enabled}:{computer:string;agent:string;enabled:boolean}) {
  const [attempt,setAttempt]=useState(0),[frame,setFrame]=useState(''),[error,setError]=useState(''),[paused,setPaused]=useState(false),[live,setLive]=useState(false),[busy,setBusy]=useState(false)
  const socket=useRef<WebSocket|null>(null),surface=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    let disposed=false;let timer:ReturnType<typeof setTimeout>|undefined;let ws:WebSocket|undefined
    setFrame('');setLive(false);setError('');setPaused(false)
    if(!enabled)return
    void rpc(computer,'screen.open',{agentId:agent}).then(info=>{
      if(disposed)return
      setPaused(info.paused);const url=new URL(info.url,location.origin);url.protocol=location.protocol==='https:'?'wss:':'ws:'
      ws=new WebSocket(url);socket.current=ws
      ws.onmessage=async e=>{
        const text=typeof e.data==='string'?e.data:await e.data.text();if(disposed)return
        try{const value=JSON.parse(text);if(value.type==='frame'){setFrame(value.data);setLive(true);setError('')}else if(value.error){setError(value.error);setLive(false)}}catch{setError('The Mac sent an incomplete screen frame.')}
      }
      ws.onclose=()=>{if(!disposed){setLive(false);timer=setTimeout(()=>setAttempt(a=>a+1),2000)}}
    }).catch(e=>{if(!disposed)setError(e.message)})
    return()=>{disposed=true;clearTimeout(timer);ws?.close();socket.current=null}
  },[computer,agent,enabled,attempt])
  async function action(method:string){
    setBusy(true);setError('')
    try{const result=await rpc(computer,method,{agentId:agent});setPaused(!!result.paused);if(method==='screen.authorize')setAttempt(a=>a+1);if(method==='screen.stop'){socket.current?.close();setFrame('');setLive(false)}}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  function send(value:any){if(paused&&live&&socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify(value))}
  return <section className="studio-screen-section">
    <div className="studio-screen-heading">Mac desktop <span><i className={live?'dot live':'dot'}/>{live?'Live':'Permission required'}</span></div>
    <div className="studio-screen-frame" ref={surface} tabIndex={paused?0:-1} onKeyDown={e=>{
      if(!paused||!live)return;e.preventDefault()
      if(e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey)send({type:'text',text:e.key})
      else send({type:'key',key:e.key,meta:e.metaKey,ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey})
    }}>
      {frame&&live?<img className="mac-frame" alt="Selected Mac desktop" src={frame} onClick={e=>{surface.current?.focus();const r=e.currentTarget.getBoundingClientRect();send({type:'click',x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height})}} onContextMenu={e=>{e.preventDefault();const r=e.currentTarget.getBoundingClientRect();send({type:'click',button:'right',x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height})}} onWheel={e=>send({type:'scroll',delta:-e.deltaY})}/>:<div className="screen-placeholder">
        <span className="screen-glyph">▱</span><strong>Allow access to this Mac’s desktop</strong>
        <p>{error||'This is your physical Mac screen. Approve 30 minutes of viewing and desktop tools for the selected agent. The companion menu on your Mac can stop access.'}</p>
        <button className="primary" disabled={!enabled||busy} onClick={()=>void action('screen.authorize')}>Allow desktop access for 30 minutes</button>
        <p className="small-note">Screen Recording and Accessibility permissions must also be enabled for the companion on this Mac.</p>
      </div>}
    </div>
    <p className="studio-screen-caption">{agent} · Shared physical Mac · {paused?'You have control':'Agent access requires approval'}</p>
    <div className="studio-screen-controls"><button disabled={!live||busy} onClick={()=>void action(paused?'screen.resume':'screen.pause')}>{paused?'Resume agent':'Take control'}</button><button disabled={!live} onClick={()=>void surface.current?.requestFullscreen()}>Expand ↗</button><button disabled={!enabled||busy} onClick={()=>void action('screen.stop')}>Stop desktop access</button></div>
  </section>
}
