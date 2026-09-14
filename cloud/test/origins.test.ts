import test from 'node:test'
import assert from 'node:assert/strict'
import { trustedOrigins } from '../server/origins.ts'
test('origins reject paths, wildcards, credentials and unencrypted public hosts', () => {
  for (const value of [
    'https://app.test/path',
    'https://user:password@app.test',
    'https://*.test',
    'http://public.test',
    'https://app.test/'
  ])
    assert.throws(() => trustedOrigins(value))
  assert.equal(trustedOrigins('https://app.test', ['https://old.test']).has('https://old.test'), true)
})
