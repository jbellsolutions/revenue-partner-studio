import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../server/store.ts'
import {ControlStore} from '../server/control-store.ts'
import {Computers} from '../server/computers.ts'
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002'
function fixture(t:any){const store=new Store(':memory:');const control=new ControlStore(store,Buffer.alloc(32,7));t.after(()=>store.close());return {store,control}}
test('migration preserves existing credentials and credentials are encrypted and scope bound',t=>{
  const store=new Store(':memory:');const old=store.addComputer(A,'Studio Trial')
  const control=new ControlStore(store,Buffer.alloc(32,7));t.after(()=>store.close())
  assert.equal(store.connector(A,old.token),true)
  control.set('orgo.key','private-test-value')
  const row=store.db.prepare('SELECT value FROM control_values WHERE name=?').get('orgo.key') as any
  assert.equal(row.value.includes('private-test-value'),false)
  assert.equal(control.get('orgo.key'),'private-test-value')
  assert.throws(()=>control.unseal(row.value,'different-scope'))
  assert.throws(()=>new ControlStore(store,Buffer.alloc(32,9)).get('orgo.key'))
  assert.equal(store.addComputer(B,'Another').id,B)
})
test('pairing is single-use, destination bound, expiring, and revokes superseded credentials',t=>{
  const {store,control}=fixture(t);const old=store.addComputer(A,'A');store.addComputer(B,'B')
  const pair=control.pairing(A)
  assert.throws(()=>control.exchange(B,pair.code,'linux'))
  const next=control.exchange(A,pair.code,'linux')
  assert.equal(store.connector(A,next.token),true);assert.equal(store.connector(A,old.token),false)
  assert.throws(()=>control.exchange(A,pair.code,'linux'))
  const expired=control.pairing(A);store.db.prepare('UPDATE pairing_codes SET expires=0 WHERE computer=?').run(A)
  assert.throws(()=>control.exchange(A,expired.code,'linux'))
  const superseded=control.pairing(A),latest=control.pairing(A)
  assert.throws(()=>control.exchange(A,superseded.code,'linux'));assert.ok(control.exchange(A,latest.code,'linux'))
})
test('live provider rename keeps identity and intentional nickname; refresh failure preserves directory',async t=>{
  const {store,control}=fixture(t);store.addComputer(A,'Studio Trial');store.addComputer(B,'Content Marketer')
  let failing=false;let name='AI Guy Operator Co-Founder — Live';let changes=0
  const fetcher=async()=>{if(failing)throw Error('private upstream error');return new Response(JSON.stringify({workspaces:[{id:'workspace',name:'Team',desktops:[{id:A,name,os:'linux',status:'running'},{id:B,name:'Content Studio Agent',os:'linux',status:'running'}]}]}))}
  const service=new Computers(control,'https://studio.test','/missing',()=>false,()=>changes++,fetcher as any)
  await service.saveKey('private-orgo-key-for-test')
  assert.equal(store.computers()[0].name,name);assert.equal(store.computers()[1].name,'Content Marketer')
  name='Renamed co-founder';await service.refresh();assert.equal(store.computers()[0].name,name)
  failing=true;await service.refresh();assert.equal(service.state().computers.length,2);assert.match(service.state().error,/could not refresh/)
  assert.equal(service.state().error.includes('private upstream'),false);assert.equal(changes,2)
})
test('trusted connections are explicit, directional, agent-specific, durable, and revocable',t=>{
  const {store,control}=fixture(t);store.addComputer(A,'Same');store.addComputer(B,'Same')
  assert.equal(control.permission(A,'default',B,'email'),undefined)
  const grant=control.grant({source:A,actor:'default',target:B,agent:'email'})
  assert.ok(control.permission(A,'default',B,'email'));assert.equal(control.permission(B,'email',A,'default'),undefined)
  assert.equal(control.permission(A,'other',B,'email'),undefined)
  assert.equal(control.grant({source:A,actor:'default',target:B,agent:'email'}).id,grant.id)
  control.revoke(grant.id);assert.equal(control.permission(A,'default',B,'email'),undefined)
  assert.throws(()=>control.grant({source:A,actor:'*',target:B,agent:'email'}))
})

test('permission leases keep a stable revision and enough renewal time',t=>{
  const {store,control}=fixture(t);store.addComputer(A,'A');store.addComputer(B,'B')
  control.grant({source:A,actor:'default',target:B,agent:'email'})
  const decode=(proof:any)=>JSON.parse(Buffer.from(proof.payload,'base64url').toString())
  const first=decode(control.permissions(B)),second=decode(control.permissions(B))
  assert.equal(first.revision,second.revision)
  assert.ok(first.validUntil-Date.now()>55000)
  control.grant({source:A,actor:'other',target:B,agent:'email'})
  assert.notEqual(decode(control.permissions(B)).revision,first.revision)
})

test('permanent setup authorization failures need action; temporary failures keep resumable progress',async t=>{
  const {store,control}=fixture(t);store.addComputer(A,'Revenue Partner');control.set('orgo.key','test-key')
  let status=403
  const service=new Computers(control,'https://studio.test','/missing',()=>false,()=>{},(async()=>new Response('{}',{status})) as any)
  const job={created:Date.now(),computerId:A,pair:'same-pair'}
  control.saveJob('setup',A,'installing','Installing',job)
  await service.run('setup')
  assert.equal(control.job('setup').state,'needs_action')
  assert.match(control.job('setup').detail,/authorize/)
  status=503;control.saveJob('setup',A,'installing','Installing',job);await service.run('setup')
  assert.equal(control.job('setup').state,'installing')
  assert.equal(control.job('setup').private.pair,'same-pair')
})
test('computer updates are deduplicated and carry only a short-lived artifact receipt',async t=>{
  const {store,control}=fixture(t);store.addComputer(A,'Revenue Partner');control.set('orgo.key','test-key')
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path')
  const assets=fs.mkdtempSync(path.join(os.tmpdir(),'rps-update-assets-'));t.after(()=>fs.rmSync(assets,{recursive:true,force:true}))
  fs.writeFileSync(path.join(assets,'runtime.tar.gz'),'archive');fs.writeFileSync(path.join(assets,'runtime.sha256'),'a'.repeat(64));fs.writeFileSync(path.join(assets,'update-remote.py'),'pass\n')
  const fetcher=async(url:string)=>new Response(JSON.stringify(url.includes('/computers/')?{id:A,os:'linux',status:'running'}:{}))
  const service=new Computers(control,'https://studio.test',assets,()=>true,()=>{},fetcher as any)
  const started:string[]=[];(service as any).run=async(id:string)=>{started.push(id)}
  const first=await service.update(A),second=await service.update(A)
  assert.equal(first.id,second.id);assert.deepEqual(started,[first.id])
  const saved=control.job(first.id).private
  assert.equal(saved.kind,'update');assert.equal(JSON.stringify(saved).includes('test-key'),false)
})
