import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {configure} from './configure.mjs'
import {decryptLocalSecret} from '../apps/desktop/electron/local-secret-vault.ts'
test('fresh recipient configuration encrypts credentials and preserves an existing binding',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'studio-config-'))
 try {
  const input={directory,computerId:'11111111-1111-4111-8111-111111111111',sshHost:'client.example.ts.net',apiKey:'unit-test-placeholder'}
  configure(input)
  const file=path.join(directory,'orgo-desktop.json');const before=fs.readFileSync(file,'utf8')
  assert.ok(!before.includes(input.apiKey))
  assert.equal(fs.statSync(file).mode & 0o777,0o600)
  assert.equal(decryptLocalSecret(JSON.parse(before).profiles.default.apiKey,path.join(directory,'local-secret.key')),input.apiKey)
  assert.throws(()=>configure({...input,computerId:'22222222-2222-4222-8222-222222222222'}),/another computer/)
  assert.equal(fs.readFileSync(file,'utf8'),before)
  assert.throws(()=>configure({...input,sshHost:'another.example.ts.net'}),/destination differs/)
 } finally {fs.rmSync(directory,{recursive:true,force:true})}
})
