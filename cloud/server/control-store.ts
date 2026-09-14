import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Store, hash } from './store.ts'

export class ControlStore {
  constructor(readonly store: Store, readonly key: Buffer) {
    if (key.length !== 32) throw Error('A 32-byte connection encryption key is required.')
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS control_values(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing_codes(hash TEXT PRIMARY KEY,computer TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS connection_jobs(id TEXT PRIMARY KEY,computer TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,private TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_grants(id TEXT PRIMARY KEY,source TEXT NOT NULL,actor TEXT NOT NULL,target TEXT NOT NULL,agent TEXT NOT NULL,expires INTEGER,revoked INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS permission_audit(id INTEGER PRIMARY KEY,created INTEGER NOT NULL,action TEXT NOT NULL,source TEXT,target TEXT,request TEXT,decision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peer_receipts(source TEXT NOT NULL,request TEXT NOT NULL,target TEXT NOT NULL,agent TEXT NOT NULL,actor TEXT NOT NULL,digest TEXT NOT NULL,grant_id TEXT NOT NULL,task TEXT,PRIMARY KEY(source,request));
    `)
    const columns = new Set(store.db.prepare('PRAGMA table_info(computers)').all().map((r:any)=>r.name))
    for (const [name,type] of Object.entries({kind:"TEXT NOT NULL DEFAULT 'orgo'",provider_name:'TEXT',platform:'TEXT',last_seen:'INTEGER'}))
      if (!columns.has(name)) store.db.exec(`ALTER TABLE computers ADD COLUMN ${name} ${type}`)
  }
  static keyFile(path: string) {
    if (!existsSync(path)) writeFileSync(path, randomBytes(32), {mode:0o600,flag:'wx'})
    chmodSync(path,0o600)
    return readFileSync(path)
  }
  seal(value: unknown, scope: string) {
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv)
    cipher.setAAD(Buffer.from(scope))
    const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()])
    return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64')
  }
  unseal(value: string, scope: string) {
    const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12))
    cipher.setAAD(Buffer.from(scope));cipher.setAuthTag(bytes.subarray(12,28))
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString())
  }
  get(name: string) {
    const row=this.store.db.prepare('SELECT value FROM control_values WHERE name=?').get(name) as any
    return row ? this.unseal(row.value,name) : null
  }
  set(name: string,value:unknown) {
    this.store.db.prepare('INSERT OR REPLACE INTO control_values VALUES(?,?)').run(name,this.seal(value,name))
  }
  computers() { return this.store.db.prepare('SELECT id,name,created,kind,provider_name AS providerName,platform,last_seen AS lastSeen FROM computers ORDER BY created').all() }
  pairing(computer: string) {
    if (!this.store.computers().some(c=>c.id===computer)) throw Error('Unknown computer.')
    const code=randomBytes(32).toString('base64url'),expires=Date.now()+600000
    this.store.db.prepare('UPDATE pairing_codes SET used=1 WHERE computer=?').run(computer)
    this.store.db.prepare('INSERT INTO pairing_codes(hash,computer,expires) VALUES(?,?,?)').run(hash(code),computer,expires)
    return {computerId:computer,code,expires}
  }
  exchange(computer:string, code:string, platform:string) {
    const token=randomBytes(32).toString('base64url'),db=this.store.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const r=db.prepare('UPDATE pairing_codes SET used=1 WHERE hash=? AND computer=? AND used=0 AND expires>?').run(hash(code),computer,Date.now())
      if(r.changes!==1) throw Error('Pairing code expired, already used, or belongs to another computer.')
      db.prepare('UPDATE computers SET token_hash=?,platform=? WHERE id=?').run(hash(token),platform,computer)
      db.exec('COMMIT'); return {computerId:computer,token}
    } catch(e) {db.exec('ROLLBACK');throw e}
  }
  audit(action:string,source:string,target:string,request:string,decision:string) {
    if(this.store.db.prepare('SELECT id FROM permission_audit WHERE action=? AND source=? AND target=? AND request=? AND decision=?').get(action,source,target,request,decision))return
    this.store.db.prepare('INSERT INTO permission_audit(created,action,source,target,request,decision) VALUES(?,?,?,?,?,?)').run(Date.now(),action,source,target,request,decision)
  }
  grants() {return this.store.db.prepare('SELECT * FROM connection_grants ORDER BY created DESC').all()}
  grant(p:any) {
    const computers=new Set(this.store.computers().map(c=>c.id))
    if(!computers.has(p.source)||!computers.has(p.target)||p.source===p.target) throw Error('Choose two different connected computers.')
    for(const name of [p.actor,p.agent]) if(typeof name!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw Error('Choose a specific source and destination agent.')
    if(p.expires!=null&&(!Number.isSafeInteger(p.expires)||p.expires<=Date.now())) throw Error('Expiration must be in the future.')
    const existing=this.store.db.prepare('SELECT id FROM connection_grants WHERE source=? AND actor=? AND target=? AND agent=? AND revoked=0 AND expires IS ?').get(p.source,p.actor,p.target,p.agent,p.expires??null) as any
    if(existing) return {id:existing.id}
    const id=randomUUID()
    this.store.db.prepare('INSERT INTO connection_grants VALUES(?,?,?,?,?,?,0,?)').run(id,p.source,p.actor,p.target,p.agent,p.expires??null,Date.now())
    this.audit('grant',p.source,p.target,id,'allowed');return {id}
  }
  revoke(id:string) {
    this.store.db.prepare('UPDATE connection_grants SET revoked=1 WHERE id=?').run(id)
    this.audit('revoke','','',id,'revoked')
  }
  permission(source:string,actor:string,target:string,agent:string) {
    return this.store.db.prepare('SELECT id FROM connection_grants WHERE source=? AND actor=? AND target=? AND agent=? AND revoked=0 AND (expires IS NULL OR expires>?)').get(source,actor,target,agent,Date.now()) as {id:string}|undefined
  }
  sign(computer:string,claims:unknown) {
    const row=this.store.db.prepare('SELECT token_hash FROM computers WHERE id=?').get(computer) as any
    if(!row)throw Error('Unknown permission destination.')
    const payload=Buffer.from(JSON.stringify(claims)).toString('base64url')
    return {payload,signature:createHmac('sha256',row.token_hash).update(payload).digest('hex')}
  }
  permissions(computer:string) {
    const grants=(this.grants() as any[]).filter(g=>g.target===computer&&!g.revoked&&(!g.expires||g.expires>Date.now()))
    return this.sign(computer,{computerId:computer,validUntil:Date.now()+15000,grants})
  }
  jobs() {return this.store.db.prepare('SELECT id,computer AS computerId,state,detail,updated FROM connection_jobs ORDER BY updated DESC LIMIT 30').all()}
  job(id:string) {
    const r=this.store.db.prepare('SELECT * FROM connection_jobs WHERE id=?').get(id) as any
    return r ? {...r,private:this.unseal(r.private,id)} : null
  }
  saveJob(id:string,computer:string,state:string,detail:string,privateData:unknown) {
    this.store.db.prepare('INSERT OR REPLACE INTO connection_jobs VALUES(?,?,?,?,?,?)').run(id,computer,state,detail,this.seal(privateData,id),Date.now())
  }
}
