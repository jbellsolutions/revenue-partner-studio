import fs from 'node:fs'
import path from 'node:path'
import { encryptLocalSecret } from './local-secret-vault'
import { listBotInstances } from './bot-instances'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export type StudioComputerMode = 'studio' | 'hermes' | 'desktop'
export function normalizeStudioComputer(value: unknown): string {
  const id=String(value || '').trim().toLowerCase()
  if (!UUID.test(id)) throw new Error('Enter a valid Orgo computer ID.')
  return id
}

/** Selection is an explicit owner action; inventory reads never grant control to the current window. */
export async function readStudioComputer(apiKey:string, computerId:string, fetchImpl:typeof fetch=fetch) {
  const id=normalizeStudioComputer(computerId)
  const response=await fetchImpl(`https://www.orgo.ai/api/computers/${id}`,{
    headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(15000)})
  if (!response.ok) throw new Error(response.status===401 || response.status===403 ? 'This Orgo key cannot access that computer.' : response.status===404 ? 'Computer not found or not accessible to this Orgo key.' : 'Orgo could not verify that computer. Try again.')
  const body=await response.json()
  if(body.id!==id) throw new Error('Orgo returned a different computer; nothing was changed.')
  return {id,name:String(body.name||id),status:String(body.status||'unknown'),workspaceId:String(body.workspace_id||'')}
}

export async function inspectStudioComputer(apiKey:string, computerId:string, fetchImpl:typeof fetch=fetch) {
  const id=normalizeStudioComputer(computerId)
  // Read-only compatibility inspection. No installs, restarts, enrollments or remote file writes.
  const script=`import json,pathlib,subprocess,urllib.request
expected='${id}'
host=''
try:
 d=json.loads(subprocess.check_output(['tailscale','status','--json'],stderr=subprocess.DEVNULL,timeout=8)); host=d.get('Self',{}).get('DNSName','').rstrip('.') if d.get('BackendState')=='Running' else ''
except Exception: pass
ready=False
hermes=False
try:
 p=pathlib.Path('/root/.hermes'); b=json.loads((p/'orgo-computer/computer.json').read_text())
 if b.get('computerId')==expected:
  for process in pathlib.Path('/proc').iterdir():
   if not process.name.isdigit(): continue
   try:
    args=(process/'cmdline').read_bytes().decode().split('\\0')
    if 'serve' in args and '--isolated' in args and (args[0].startswith('/root/.hermes/desktop-runtime/') or args[0].startswith('/usr/local/lib/hermes-agent/')): hermes=True
   except Exception: pass
 if b.get('computerId')==expected and pathlib.Path('/opt/hermes-orgo-studio/venv/bin/hermes').is_file():
  token=(p/'studio/gateway-token').read_text().strip()
  req=urllib.request.Request('http://127.0.0.1:8787/api/health',headers={'X-Hermes-Session-Token':token})
  ready=urllib.request.urlopen(req,timeout=3).status==200
except Exception: pass
print(json.dumps({'ready':ready,'hermes':hermes,'host':host}))`
  const response=await fetchImpl(`https://www.orgo.ai/api/computers/${id}/bash`,{
    method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({command:"python3 - <<'STUDIO_CHECK'\n"+script+"\nSTUDIO_CHECK"}),signal:AbortSignal.timeout(20000)})
  if (!response.ok) return {mode:'desktop' as StudioComputerMode,host:''}
  const body=await response.json()
  try {
    const result=JSON.parse(String(body.output||'').trim())
    const host=typeof result.host==='string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(result.host) ? result.host : ''
    return {mode:body.success && result.ready===true && host ? 'studio' as const : body.success && result.hermes===true && host ? 'hermes' as const : 'desktop' as const,host}
  } catch {return {mode:'desktop' as const,host:''}}
}

export function readStudioWindow(directory:string): {mode:StudioComputerMode;name?:string;computerId?:string} {
  try {
    const value=JSON.parse(fs.readFileSync(path.join(directory,'studio-window.json'),'utf8'))
    return {mode:value.mode==='desktop'?'desktop':value.mode==='hermes'?'hermes':'studio',name:value.name,computerId:value.computerId}
  } catch {return {mode:'studio'}}
}

/** Only new local metadata is created. Existing windows keep their credentials, settings and history. */
export function prepareStudioComputer(root:string, computer:{id:string;name:string;workspaceId:string}, apiKey:string, connection:{mode:StudioComputerMode;host:string}) {
  const id=normalizeStudioComputer(computer.id)
  if(!apiKey.trim()) throw new Error('Enter an Orgo API key or use the current account.')
  const existing=listBotInstances(root,'').find(row=>row.computerId===id && !row.unreadable)
  if(existing) {
    const directory=existing.name?path.join(root,'instances',existing.name):root
    const meta=readStudioWindow(directory)
    if(meta.mode==='desktop' && connection.mode==='hermes') {
      if(!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(connection.host)) throw new Error('A private SSH host is required for chats.')
      const file=path.join(directory,'connection.json')
      if(fs.existsSync(file)) throw new Error('Review the existing connection before upgrading this computer workspace.')
      fs.writeFileSync(file,JSON.stringify({mode:'ssh',remote:{mode:'ssh',host:connection.host,user:'root',remoteHermesPath:'',authMode:'token',token:null},profiles:{}},null,2)+'\n',{mode:0o600,flag:'wx'})
      const temp=path.join(directory,'studio-window.json.pending')
      fs.writeFileSync(temp,JSON.stringify({...meta,mode:'hermes'},null,2)+'\n',{mode:0o600})
      fs.renameSync(temp,path.join(directory,'studio-window.json'))
      return {name:existing.name,reused:true,mode:'hermes' as const}
    }
    return {name:existing.name,reused:true,mode:meta.mode}
  }
  const name='computer-'+id
  const parent=path.join(root,'instances'),directory=path.join(parent,name)
  for(const p of [root,parent,directory]) {
    if(fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('Linked workspace directories cannot be used.')
  }
  if(fs.existsSync(directory)) throw new Error('This computer window has incomplete settings. Review it before retrying; nothing was overwritten.')
  if(connection.mode!=='desktop' && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(connection.host)) throw new Error('A private SSH host is required for Studio conversations.')
  fs.mkdirSync(parent,{recursive:true,mode:0o700})
  const staging=fs.mkdtempSync(path.join(parent,'.pending-'))
  try {
    const write=(filename:string,value:unknown)=>fs.writeFileSync(path.join(staging,filename),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'})
    const encrypted=encryptLocalSecret(apiKey,path.join(staging,'local-secret.key'))
    write('orgo-desktop.json',{version:1,profiles:{default:{computerId:id,workspaceId:computer.workspaceId,apiKey:encrypted}}})
    write('studio-window.json',{mode:connection.mode,name:computer.name,computerId:id})
    if(connection.mode!=='desktop') write('connection.json',{mode:'ssh',remote:{mode:'ssh',host:connection.host,user:'root',remoteHermesPath:'/opt/hermes-orgo-studio/venv/bin/hermes',authMode:'token',token:null},profiles:{}})
    fs.renameSync(staging,directory)
  } finally {fs.rmSync(staging,{recursive:true,force:true})}
  return {name,reused:false,mode:connection.mode}
}
