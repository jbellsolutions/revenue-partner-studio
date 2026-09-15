import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Store} from '../server/store.ts'
import {ControlStore} from '../server/control-store.ts'
import {Computers} from '../server/computers.ts'
import {Recovery} from '../server/recovery.ts'
import {validateSsh} from '../server/recovery-ssh.ts'
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002'
function fixture(t:any){
 const store=new Store(':memory:'),control=new ControlStore(store,Buffer.alloc(32,7));store.addComputer(A,'Same');store.addComputer(B,'Same')
 const dir=mkdtempSync(path.join(tmpdir(),'rps-recovery-test-'));writeFileSync(path.join(dir,'recover.py'),'print("fixture")')
 const computers=new Computers(control,'https://studio.test',dir,()=>false,()=>{})
 let time=100000,online=false,healthy=true,reconciled=true
 const calls:any[]=[]
 const rpc=async(id:string,method:string)=>{calls.push({id,method});return method==='connection.status'?{computerId:id,runtimeConnected:healthy,capabilities:{connectionRecovery:true}}:{computerId:id,reconciled}}
 const recovery=new Recovery(control,computers,()=>online,rpc,()=>{},()=>time)
 t.after(async()=>{await recovery.close();store.close();rmSync(dir,{recursive:true,force:true})})
 return {store,control,computers,recovery,calls,advance:()=>time+=31000,setOnline:(value:boolean)=>online=value,setHealthy:(value:boolean)=>healthy=value,setReconciled:(value:boolean)=>reconciled=value,rpc,clock:()=>time}
}
test('brief disconnect never repairs; sustained failure starts only a connector and verifies RPC plus histories',async t=>{
 const f=fixture(t);const actions:any[]=[]
 f.recovery.command=async(id,action,requestId)=>{actions.push({id,action,requestId});return {code:action==='inspect'?'connector_failed':'awaiting_connection',computerId:id,transport:'orgo_api'}}
 await f.recovery.check(A);assert.equal(actions.length,0)
 f.advance();await f.recovery.check(A);assert.deepEqual(actions.map(x=>x.action),['inspect','repair']);assert.equal(actions[0].requestId,actions[1].requestId)
 f.setOnline(true);f.setReconciled(false);f.advance();await f.recovery.check(A);assert.equal(f.recovery.status(A).state,'repair_needed')
 f.setReconciled(true);f.advance();await f.recovery.check(A);assert.equal(f.recovery.status(A).state,'connected');assert.equal(f.recovery.status(A).conversations,'reconciled')
 assert.ok(f.calls.every(x=>x.id===A));assert.equal(f.recovery.status(B).lastSuccess,undefined)
})
test('running, paused, unknown-owner and unavailable-runtime computers never get a restart',async t=>{
 const f=fixture(t);let code='connector_running',writes=0
 f.recovery.command=async(id,action)=>{if(action==='repair')writes++;return {code,computerId:id,transport:'orgo_api'}}
 await f.recovery.check(A)
 for(const next of ['connector_running','paused','ownership_unknown','runtime_unavailable']){code=next;f.advance();await f.recovery.check(A,true)}
 assert.equal(writes,0);assert.equal(f.recovery.status(A).state,'repair_needed')
})
test('uncertain repair keeps its receipt across gateway restart and concurrent repair clicks',async t=>{
 const f=fixture(t);const ids:string[]=[]
 const command=async(id:string,action:string,rid:string)=>{if(action==='repair'){ids.push(rid);throw Error('lost acknowledgment')}return {code:'connector_failed',computerId:id,transport:'orgo_api'}}
 f.recovery.command=command;await f.recovery.check(A);f.advance();await Promise.all([f.recovery.check(A),f.recovery.check(A,true)])
 assert.equal(ids.length,1)
 const other=new Recovery(f.control,f.computers,()=>false,f.rpc,()=>{},f.clock);other.command=command
 f.advance();await other.check(A);await other.close();assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal(f.recovery.get(A).attempts.length,1)
})
test('two recent attempts remain a limit even with an explicit repair request',async t=>{
 const f=fixture(t);let starts=0
 f.recovery.save(A,{incident:A,since:0,attempts:[90000,95000]})
 f.recovery.command=async(id,action)=>{if(action==='repair')starts++;return {code:'connector_failed',computerId:id,transport:'orgo_api'}}
 await f.recovery.check(A,true);assert.equal(starts,0);assert.match(f.recovery.status(A).detail,/limit/)
})
test('installation job retains exclusive ownership of setup',async t=>{
 const f=fixture(t);let inspections=0;f.recovery.command=async()=>{inspections++;return {}}
 f.control.saveJob('install',A,'installing','Working',{});await f.recovery.check(A);f.advance();await f.recovery.check(A,true);assert.equal(inspections,0)
})
test('SSH fallback reuses request identity; denial and wrong computer never fall through',async t=>{
 const f=fixture(t);const calls:any[]=[]
 const recovery=new Recovery(f.control,f.computers,()=>false,f.rpc,()=>{},f.clock,async(c,request)=>{calls.push(request);return {protocol:1,computerId:A,code:'connector_running'}})
 f.control.set('recovery.ssh.'+A,{test:true})
 f.computers.bash=async()=>{throw Error('timeout')}
 await recovery.command(A,'repair',B);assert.equal(calls[0].requestId,B);assert.equal(calls[0].action,'repair')
 f.computers.bash=async()=>{throw Object.assign(Error('denied'),{permanent:true})};await assert.rejects(recovery.command(A,'repair',B));assert.equal(calls.length,1)
 f.computers.bash=async()=>JSON.stringify({protocol:1,computerId:B,code:'connector_failed'})
 assert.equal((await recovery.command(A,'inspect',B)).code,'ownership_unknown');assert.equal(calls.length,1);await recovery.close()
})
test('SSH configuration is restricted, encrypted, omitted from status, and revocable',async t=>{
 const f=fixture(t);let unrestricted=true
 const recovery=new Recovery(f.control,f.computers,()=>false,f.rpc,()=>{},f.clock,async(c,r,command)=>(!command||command==='studio-recovery')?{computerId:A,code:'connector_running'}:unrestricted?{code:'shell'}:{code:'inspection_failed'})
 const configuration={host:'example.test',port:22,user:'root',privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\nfixture',hostKey:'ssh-ed25519 AAAA'}
 await assert.rejects(recovery.configureSsh(A,configuration));unrestricted=false;await recovery.configureSsh(A,configuration)
 assert.equal(recovery.status(A).sshConfigured,true);assert.ok(!JSON.stringify(recovery.status(A)).includes('PRIVATE KEY'))
 const row=f.store.db.prepare('SELECT value FROM control_values WHERE name=?').get('recovery.ssh.'+A) as any
 assert.ok(!row.value.includes('PRIVATE KEY'));await recovery.configureSsh(A,null);assert.equal(recovery.status(A).sshConfigured,false)
 assert.throws(()=>validateSsh({...configuration,host:'-oProxyCommand=bad'}));await recovery.close()
})
