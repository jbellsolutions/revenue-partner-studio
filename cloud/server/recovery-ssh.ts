import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type SshRecovery = { host:string; port:number; user:string; privateKey:string; hostKey:string }
export function validateSsh(value:SshRecovery) {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value.host) ||
      !Number.isInteger(value.port) || value.port<1 || value.port>65535 ||
      !/^[a-z_][a-z0-9_-]{0,31}$/i.test(value.user) ||
      !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(value.hostKey) ||
      typeof value.privateKey!=='string' || value.privateKey.length>16384 ||
      !value.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) throw Error('Invalid dedicated SSH recovery configuration.')
}
export async function sshRecovery(config:SshRecovery, request:unknown, command='studio-recovery'):Promise<any> {
  validateSsh(config)
  const dir=await mkdtemp(path.join(tmpdir(),'studio-recovery-'))
  try {
    await writeFile(path.join(dir,'key'),config.privateKey,{mode:0o600})
    const host=config.port===22?config.host:`[${config.host}]:${config.port}`
    await writeFile(path.join(dir,'known_hosts'),`${host} ${config.hostKey}\n`,{mode:0o600})
    const args=['-F','/dev/null','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none',
      '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${path.join(dir,'known_hosts')}`,
      '-o','GlobalKnownHostsFile=/dev/null','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no',
      '-o','ConnectTimeout=5','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=1',
      '-p',String(config.port),'-l',config.user,'-i',path.join(dir,'key'),config.host,command]
    return await new Promise((resolve,reject)=>{
      const child=spawn('ssh',args,{stdio:['pipe','pipe','pipe']})
      let output='',error='',settled=false
      const finish=(value?:any)=>{if(settled)return;settled=true;clearTimeout(timer);value?resolve(value):reject(Error(/REMOTE HOST IDENTIFICATION|Host key verification/.test(error)?'SSH host identity changed.':/Permission denied/.test(error)?'SSH recovery access was revoked or expired.':'SSH recovery could not be verified.'))}
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish()},15000)
      child.stdout.on('data',data=>{output+=data.toString();if(output.length>16384){child.kill('SIGKILL');finish()}})
      child.stderr.on('data',data=>{error=(error+data.toString()).slice(0,4096)})
      child.on('error',()=>finish())
      child.stdin.on('error',()=>{})
      child.on('close',()=>{try{const value=JSON.parse(output.trim());finish(value)}catch{finish()}})
      child.stdin.end(JSON.stringify(request))
    })
  } finally {await rm(dir,{recursive:true,force:true})}
}
