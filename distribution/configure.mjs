import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { encryptLocalSecret } from '../apps/desktop/electron/local-secret-vault.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function configure({directory, computerId, workspaceId = '', sshHost, apiKey}) {
  if (!uuid.test(computerId) || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(sshHost || '') || !apiKey) throw new Error('A valid computer UUID, SSH host and private Orgo key are required.')
  const configPath = path.join(directory, 'orgo-desktop.json')
  const connectionPath = path.join(directory, 'connection.json')
  const read = p => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
  const existing = read(configPath)
  const connection = read(connectionPath)
  if (existing?.profiles?.default?.computerId && existing.profiles.default.computerId !== computerId) throw new Error('Existing installation is bound to another computer; no files changed.')
  if (connection?.remote?.host && connection.remote.host !== sshHost) throw new Error('Existing SSH destination differs; no files changed.')
  fs.mkdirSync(directory, {recursive:true,mode:0o700})
  const write = (p, value) => {const temp = p+'.studio-tmp'; fs.writeFileSync(temp, JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,p)}
  const secret = encryptLocalSecret(apiKey,path.join(directory,'local-secret.key'))
  write(configPath,{...existing,version:1,profiles:{...existing?.profiles,default:{...existing?.profiles?.default,computerId,workspaceId,apiKey:secret}}})
  write(connectionPath,connection || {mode:'ssh',remote:{mode:'ssh',host:sshHost,user:'root',remoteHermesPath:'/opt/hermes-orgo-studio/venv/bin/hermes',authMode:'token',token:null},profiles:{}})
  return {configured:true,computerId,sshHost}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input=JSON.parse(fs.readFileSync(0,'utf8'))
  input.directory ||= path.join(os.homedir(),'Library/Application Support/Hermes Orgo Studio')
  try { console.log(JSON.stringify(configure(input))) } catch(e) { console.error(e.message);process.exitCode=1 }
}
