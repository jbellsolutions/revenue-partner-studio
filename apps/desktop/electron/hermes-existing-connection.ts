import { normalizeStudioComputer } from './studio-computers'

/** Inspect only the explicitly selected computer's existing, loopback Hermes dashboard.
 * Never starts, installs, restarts or stops that backend. Tokens stay inside the private transport. */
export function existingHermesInspection(computerId: string) {
  const id = normalizeStudioComputer(computerId)
  return `import pathlib,json,re,subprocess,urllib.request
expected='${id}'
root=pathlib.Path('/root/.hermes')
b=json.loads((root/'orgo-computer/computer.json').read_text())
assert b.get('computerId')==expected, 'The SSH host is not the selected Orgo computer'
listeners=subprocess.check_output(['ss','-ltnp'],text=True,timeout=5)
candidates=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit(): continue
 try:
  args=(p/'cmdline').read_bytes().decode().split('\\0')
  if 'serve' not in args or '--isolated' not in args: continue
  if not (args[0].startswith('/root/.hermes/desktop-runtime/') or args[0].startswith('/usr/local/lib/hermes-agent/')): continue
  profile=args[args.index('--profile')+1] if '--profile' in args else 'default'
  if profile not in ['','default']: continue
  for line in listeners.splitlines():
   if ('pid='+p.name+',') in line:
    m=re.search(r'127\\.0\\.0\\.1:(\\d+)',line)
    if m: candidates.append((int(p.name),int(m.group(1)),args))
 except Exception: pass
for pid,port,args in sorted(candidates,reverse=True)[:5]:
 try:
  base='http://127.0.0.1:'+str(port)
  html=urllib.request.urlopen(base+'/',timeout=3).read(2097152).decode()
  match=re.search(r'window\\.__HERMES_SESSION_TOKEN__\\s*=\\s*(\"[^\"]+\")',html)
  if not match: continue
  token=json.loads(match.group(1))
  req=urllib.request.Request(base+'/api/status',headers={'X-Hermes-Session-Token':token})
  status=json.load(urllib.request.urlopen(req,timeout=5))
  if not isinstance(status.get('version'),str): continue
  if (pathlib.Path('/proc')/str(pid)/'cmdline').read_bytes().decode().split('\\0')!=args: continue
  print(json.dumps({'computerId':expected,'port':port,'token':token,'version':status['version'],'hermesPath':args[0]}));break
 except Exception: pass
else: raise SystemExit('No responding existing Hermes chat service was found on this computer. Its agents were not changed.')`
}

export async function connectExistingHermes({computerId, ssh, pickLocalPort, waitForHermes}: {
  computerId: string
  ssh: {exec(command: string): Promise<string>; forward(local: number, remote: number): Promise<void>; cancelForward(local: number, remote: number): Promise<void>}
  pickLocalPort(): Promise<number>
  waitForHermes(url: string, token: string): Promise<unknown>
}) {
  const id = normalizeStudioComputer(computerId)
  const script = existingHermesInspection(id)
  const result = JSON.parse(await ssh.exec("python3 - <<'GROK_ISH_INSPECT'\n" + script + "\nGROK_ISH_INSPECT"))
  if (result.computerId !== id || !Number.isInteger(result.port) || result.port < 1024 || result.port > 65535 ||
      typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(result.token)) throw new Error('The existing Hermes service identity is invalid.')
  const localPort = await pickLocalPort()
  await ssh.forward(localPort, result.port)
  const baseUrl = `http://127.0.0.1:${localPort}`
  try {await waitForHermes(baseUrl, result.token)}
  catch (error) {await ssh.cancelForward(localPort, result.port); throw error}
  return {baseUrl,localPort,remotePort:result.port,token:result.token,reused:true,pid:null,hermesPath:result.hermesPath,hermesVersion:result.version,platform:{os:'Linux'}}
}
