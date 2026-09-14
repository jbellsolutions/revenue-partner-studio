import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryImport } from '../src/import.ts'

test('imports retry transient outages but never retry validation or authentication failures', async () => {
  const attempts: string[] = []
  const result = await retryImport(
    async () => {
      attempts.push('same-stable-operation')
      if (attempts.length < 4) throw new Error('This computer is offline. Your request was not sent.')
      return { accepted: true }
    },
    async () => {}
  )
  assert.deepEqual(result, { accepted: true })
  assert.equal(attempts.length, 4)
  let invalid = 0
  await assert.rejects(
    retryImport(
      async () => {
        invalid++
        throw Object.assign(new Error('Sign in required'), { status: 401 })
      },
      async () => {}
    )
  )
  assert.equal(invalid, 1)
  let corrupt = 0
  await assert.rejects(
    retryImport(
      async () => {
        corrupt++
        throw new Error('Checksum mismatch')
      },
      async () => {}
    )
  )
  assert.equal(corrupt, 1)
})
