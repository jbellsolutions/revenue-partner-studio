import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { BOT_REMOTE_DESKTOP_RUNTIME, runOrgoBash } from './orgo-broker'

const FILES = ['__init__.py', 'adapter.py', 'protocol.py', 'security.py', 'tools.py', 'desktop.py']
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

export interface HistoryPreview {
  title: string
  text: string
  truncated: boolean
}
export interface HistoryHandoff {
  sourceProfile: string
  sourceSessionId: string
  targetComputerId: string
  targetProfile: string
  text: string
  requestId: string
}
export interface HistoryHandoffResult {
  state: string
  requestId: string
  sessionId?: string
  error?: string
}

export function readCollaborationAssets(appRoot: string, resourcesPath: string): Record<string, string> {
  const candidates = [path.join(resourcesPath, 'orgo', 'a2a'), path.resolve(appRoot, '../..', 'plugins/platforms/a2a')]
  const source = candidates.find(directory => FILES.every(file => fs.existsSync(path.join(directory, file))))

  if (!source) {
    throw new Error('The installed app is missing its A2A handoff worker.')
  }

  return Object.fromEntries(FILES.map(file => [file, fs.readFileSync(path.join(source, file), 'utf8')]))
}

export function collaborationCommand(
  files: Record<string, string>,
  operation: 'preview' | 'profiles' | 'deliver',
  payload: unknown,
  root = '/root/.hermes/desktop-collaboration',
  python = '/usr/local/lib/hermes-agent/venv/bin/python'
): string {
  const bundle = JSON.stringify(files)
  const digest = crypto.createHash('sha256').update(bundle).digest('hex')
  const encoded = zlib.gzipSync(bundle).toString('base64')

  // Immutable, versioned worker assets: no patching the managed Hermes runtime,
  // listener, profile cloning, or credential copying. Only approved text is sent.
  const script = [
    'import base64,gzip,json,os,pathlib,subprocess,tempfile',
    `root=pathlib.Path(${JSON.stringify(root)})/${JSON.stringify(digest)}`,
    '(root/"a2a").mkdir(parents=True,exist_ok=True,mode=0o700)',
    `files=json.loads(gzip.decompress(base64.b64decode(${JSON.stringify(encoded)})))`,
    `allowed=${JSON.stringify(FILES)}`,
    'for name,content in files.items():',
    '    if name not in allowed: raise ValueError("Invalid handoff asset")',
    '    target=root/"a2a"/name',
    '    if target.exists() and target.read_text(encoding="utf-8")==content: continue',
    '    fd,tmp=tempfile.mkstemp(dir=target.parent)',
    '    with os.fdopen(fd,"w",encoding="utf-8") as f: f.write(content)',
    '    os.replace(tmp,target)',
    'os.chdir(root)',
    'os.environ.pop("PYTHONPATH",None)',
    'os.environ.pop("PYTHONHOME",None)',
    `runtime=${JSON.stringify(python)}`,
    `fallback=${JSON.stringify(BOT_REMOTE_DESKTOP_RUNTIME + '/venv/bin/python')}`,
    `probe=${JSON.stringify("from gateway.config import Platform; Platform('a2a')")}`,
    // os.path.isfile treats inaccessible optional candidates as unavailable.
    'if os.path.isfile(fallback) and subprocess.run([runtime,"-c",probe],capture_output=True,timeout=10).returncode: runtime=fallback',
    `entry="import pathlib,sys,hermes_cli,runpy; sys.path.insert(1,str(pathlib.Path(hermes_cli.__file__).resolve().parent.parent)); runpy.run_module('a2a.desktop',run_name='__main__')"`,
    `os.execv(runtime,[runtime,"-c",entry,${JSON.stringify(operation)},${JSON.stringify(JSON.stringify(payload))}])`
  ].join('\n')

  return `python3 -c ${quote(script)}`
}

export async function runCollaboration<T>(
  apiKey: string,
  computerId: string,
  files: Record<string, string>,
  operation: 'preview' | 'profiles' | 'deliver',
  payload: unknown
): Promise<T> {
  const result = await runOrgoBash(
    apiKey,
    computerId,
    collaborationCommand(files, operation, payload),
    fetch,
    operation === 'deliver' ? 100 : 30
  )

  const line = result.output.split('\n').findLast(value => value.startsWith('ORGO_COLLABORATION_RESULT='))

  if (!line) {
    throw new Error(
      operation === 'deliver'
        ? 'The handoff response was lost. It may still be running; do not start another delivery.'
        : 'The computer could not load its history handoff worker.'
    )
  }

  const response = JSON.parse(line.slice('ORGO_COLLABORATION_RESULT='.length))

  if (response.error) {
    throw new Error(String(response.error))
  }

  return response as T
}
