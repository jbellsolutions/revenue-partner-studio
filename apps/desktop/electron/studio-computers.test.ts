import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectStudioComputer, normalizeStudioComputer, prepareStudioComputer, readStudioComputer, readStudioWindow } from './studio-computers'
import { decryptLocalSecret } from './local-secret-vault'
const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
const computer={id:'22222222-2222-4222-8222-222222222222',name:'Another computer',workspaceId:'workspace'}
const fresh=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-windows-'));roots.push(root);return root}
it('creates isolated settings with a newly encrypted key and reopens without overwriting',()=>{
 const root=fresh();fs.writeFileSync(path.join(root,'orgo-desktop.json'),JSON.stringify({profiles:{default:{computerId:'11111111-1111-4111-8111-111111111111'}}}))
 const original=fs.readFileSync(path.join(root,'orgo-desktop.json'),'utf8')
 const created=prepareStudioComputer(root,computer,'unit-test-key',{mode:'desktop',host:''})
 const dir=path.join(root,'instances',created.name)
 const raw=fs.readFileSync(path.join(dir,'orgo-desktop.json'),'utf8')
 expect(raw).not.toContain('unit-test-key')
 expect(decryptLocalSecret(JSON.parse(raw).profiles.default.apiKey,path.join(dir,'local-secret.key'))).toBe('unit-test-key')
 expect(fs.statSync(path.join(dir,'orgo-desktop.json')).mode&0o777).toBe(0o600)
 expect(readStudioWindow(dir).mode).toBe('desktop')
 fs.writeFileSync(path.join(dir,'retained-history-marker'),'keep')
 expect(prepareStudioComputer(root,computer,'different-key',{mode:'studio',host:'example.ts.net'})).toEqual({...created,reused:true})
 expect(fs.readFileSync(path.join(dir,'orgo-desktop.json'),'utf8')).toBe(raw)
 expect(fs.readFileSync(path.join(root,'orgo-desktop.json'),'utf8')).toBe(original)
 expect(fs.readFileSync(path.join(dir,'retained-history-marker'),'utf8')).toBe('keep')
})
it('creates a remote-only Studio connection without copying profiles or auth',()=>{
 const root=fresh();const result=prepareStudioComputer(root,computer,'unit-test-key',{mode:'studio',host:'example.ts.net'})
 const dir=path.join(root,'instances',result.name)
 const connection=JSON.parse(fs.readFileSync(path.join(dir,'connection.json'),'utf8'))
 expect(connection.mode).toBe('ssh');expect(connection.remote.host).toBe('example.ts.net');expect(connection.profiles).toEqual({})
 expect(fs.readdirSync(dir).sort()).toEqual(['connection.json','local-secret.key','orgo-desktop.json','studio-window.json'])
})
it('refuses malformed IDs, conflicting directories and symlinks',()=>{
 const root=fresh()
 expect(()=>normalizeStudioComputer('../escape')).toThrow()
 fs.symlinkSync(root,path.join(root,'instances'))
 expect(()=>prepareStudioComputer(root,computer,'key',{mode:'desktop',host:''})).toThrow(/Linked/)
})
it('rejects inaccessible and mismatched computers before local configuration',async()=>{
 await expect(readStudioComputer('key',computer.id,vi.fn().mockResolvedValue(Response.json({}, {status:403})))).rejects.toThrow(/cannot access/)
 await expect(readStudioComputer('key',computer.id,vi.fn().mockResolvedValue(Response.json({id:'wrong'})))).rejects.toThrow(/different computer/)
})
it('does not mistake existing AI Guy for a Studio runtime or send installation commands',async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json({success:true,output:JSON.stringify({ready:false,host:'existing.ts.net'})}))
 expect(await inspectStudioComputer('key',computer.id,fetcher)).toEqual({mode:'desktop',host:'existing.ts.net'})
 const command=JSON.parse(fetcher.mock.calls[0][1].body).command
 expect(command).not.toMatch(/pip install|supervisorctl|write_text|tailscale up/)
 expect(command).toContain('127.0.0.1:8787')
})
it('recognizes existing Hermes without labelling it a Studio runtime',async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json({success:true,output:JSON.stringify({ready:false,hermes:true,host:'existing.ts.net'})}))
 expect(await inspectStudioComputer('key',computer.id,fetcher)).toEqual({mode:'hermes',host:'existing.ts.net'})
})
it('upgrades a previously desktop-only window to chats without copying or replacing its keys and history',()=>{
 const root=fresh();const created=prepareStudioComputer(root,computer,'unit-key',{mode:'desktop',host:''})
 const dir=path.join(root,'instances',created.name)
 const credentials=fs.readFileSync(path.join(dir,'orgo-desktop.json'),'utf8')
 fs.writeFileSync(path.join(dir,'history-marker'),'unchanged')
 expect(prepareStudioComputer(root,computer,'ignored-new-key',{mode:'hermes',host:'existing.ts.net'}).mode).toBe('hermes')
 expect(readStudioWindow(dir).mode).toBe('hermes')
 expect(fs.readFileSync(path.join(dir,'orgo-desktop.json'),'utf8')).toBe(credentials)
 expect(fs.readFileSync(path.join(dir,'history-marker'),'utf8')).toBe('unchanged')
})
