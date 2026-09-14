import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test, vi } from 'vitest'

import {
  decryptLocalSecret,
  encryptLocalSecret,
  LOCAL_SECRET_VAULT_ENCODING,
  shouldUseBotLocalSecretVault
} from './local-secret-vault'

const temporaryDirectories: string[] = []

function temporaryKeyPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orgo-local-secret-'))

  temporaryDirectories.push(directory)

  return path.join(directory, 'local-secret.key')
}

afterEach(() => {
  vi.restoreAllMocks()

  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the local vault is limited to the macOS Bot product', () => {
  assert.equal(shouldUseBotLocalSecretVault({ platform: 'darwin', botProduct: true }), true)
  assert.equal(shouldUseBotLocalSecretVault({ platform: 'darwin', botProduct: false }), false)
  assert.equal(shouldUseBotLocalSecretVault({ platform: 'linux', botProduct: true }), false)
})

test('secrets survive restarts without storing plaintext or changing the key', () => {
  const keyPath = temporaryKeyPath()
  const first = encryptLocalSecret('orgo-secret-123', keyPath)
  const keyBefore = fs.readFileSync(keyPath)
  const second = encryptLocalSecret('orgo-secret-123', keyPath)

  assert.equal(first?.encoding, LOCAL_SECRET_VAULT_ENCODING)
  assert.notEqual(first?.value, second?.value)
  assert.doesNotMatch(first?.value || '', /orgo-secret-123/)
  assert.equal(decryptLocalSecret(first, keyPath), 'orgo-secret-123')
  assert.equal(decryptLocalSecret(second, keyPath), 'orgo-secret-123')
  assert.deepEqual(fs.readFileSync(keyPath), keyBefore)
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600)
})

test('tampering is detected instead of returning corrupted credentials', () => {
  const keyPath = temporaryKeyPath()
  const secret = encryptLocalSecret('orgo-secret-123', keyPath)!
  const payload = Buffer.from(secret.value, 'base64')

  payload[payload.length - 1] ^= 1

  assert.throws(() => decryptLocalSecret({ ...secret, value: payload.toString('base64') }, keyPath))
})

test('reading a credential never creates a replacement for a missing vault key', () => {
  const originalKey = temporaryKeyPath()
  const secret = encryptLocalSecret('synthetic-credential', originalKey)!
  const missingKey = path.join(path.dirname(temporaryKeyPath()), 'not-created', 'local-secret.key')

  assert.throws(() => decryptLocalSecret(secret, missingKey))
  assert.equal(fs.existsSync(path.dirname(missingKey)), false)
  assert.equal(decryptLocalSecret(secret, originalKey), 'synthetic-credential')
})

test('an invalid existing key is preserved rather than silently replaced', () => {
  const keyPath = temporaryKeyPath()
  fs.writeFileSync(keyPath, 'partial-key', { mode: 0o600 })

  assert.throws(() => encryptLocalSecret('synthetic-credential', keyPath), /key is invalid/)
  assert.equal(fs.readFileSync(keyPath, 'utf8'), 'partial-key')
})

test('different app-instance keys cannot decrypt each other’s credentials', () => {
  const firstKey = temporaryKeyPath()
  const secondKey = temporaryKeyPath()
  const first = encryptLocalSecret('first-instance', firstKey)!
  const second = encryptLocalSecret('second-instance', secondKey)!

  assert.throws(() => decryptLocalSecret(first, secondKey))
  assert.throws(() => decryptLocalSecret(second, firstKey))
  assert.equal(decryptLocalSecret(first, firstKey), 'first-instance')
  assert.equal(decryptLocalSecret(second, secondKey), 'second-instance')
})

test('an interrupted key write leaves no published partial key and a fresh retry succeeds', () => {
  const keyPath = temporaryKeyPath()
  const write = fs.writeFileSync.bind(fs)

  const interrupted = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((file, data, options) => {
    write(file, (data as Buffer).subarray(0, 8), options)
    throw new Error('simulated interrupted write')
  })

  assert.throws(() => encryptLocalSecret('synthetic-credential', keyPath), /interrupted write/)
  interrupted.mockRestore()
  assert.equal(fs.existsSync(keyPath), false)
  const retried = encryptLocalSecret('synthetic-credential', keyPath)!
  assert.equal(decryptLocalSecret(retried, keyPath), 'synthetic-credential')
})

test('a concurrent publisher wins without its key being overwritten', () => {
  const keyPath = temporaryKeyPath()
  const link = fs.linkSync.bind(fs)
  let competingSecret: ReturnType<typeof encryptLocalSecret>
  let winningKey: Buffer
  vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, target) => {
    competingSecret = encryptLocalSecret('competing-start', keyPath)
    winningKey = fs.readFileSync(keyPath)
    link(source, target)
  })

  const firstSecret = encryptLocalSecret('first-start', keyPath)

  assert.equal(decryptLocalSecret(firstSecret, keyPath), 'first-start')
  assert.equal(decryptLocalSecret(competingSecret!, keyPath), 'competing-start')
  assert.deepEqual(fs.readFileSync(keyPath), winningKey!)
  assert.deepEqual(fs.readdirSync(path.dirname(keyPath)), ['local-secret.key'])
})

test('independent startup processes share one complete key and all saved credentials remain readable', async () => {
  const keyPath = temporaryKeyPath()
  const moduleUrl = new URL('./local-secret-vault.ts', import.meta.url).href

  const run = (index: number) =>
    new Promise<ReturnType<typeof encryptLocalSecret>>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { encryptLocalSecret } from ${JSON.stringify(moduleUrl)};
       process.stdout.write(JSON.stringify(encryptLocalSecret(process.argv[2], process.argv[1])));`,
          keyPath,
          `synthetic-start-${index}`
        ],
        {
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )

      let output = ''
      let error = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      child.stdout.on('data', chunk => {
        output += chunk
      })
      child.stderr.on('data', chunk => {
        error += chunk
      })
      child.once('error', reject)
      child.once('close', code => {
        clearTimeout(timer)

        if (code !== 0) {
          return reject(new Error(`Synthetic vault child failed (${code}): ${error}`))
        }

        try {
          resolve(JSON.parse(output))
        } catch (failure) {
          reject(failure)
        }
      })
    })

  // Await every owned child, including failure, before fixture cleanup.
  const results = await Promise.allSettled([0, 1, 2, 3].map(run))
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      throw result.reason
    }

    assert.equal(decryptLocalSecret(result.value, keyPath), `synthetic-start-${index}`)
  })
  assert.deepEqual(fs.readdirSync(path.dirname(keyPath)), ['local-secret.key'])
}, 15_000)

test.skipIf(process.platform === 'win32')('a symlinked key cannot alter or borrow another instance’s key', () => {
  const ownerKey = temporaryKeyPath()
  const linkedKey = temporaryKeyPath()
  const secret = encryptLocalSecret('owner', ownerKey)!
  const before = fs.readFileSync(ownerKey)
  fs.symlinkSync(ownerKey, linkedKey)

  assert.throws(() => encryptLocalSecret('other', linkedKey))
  assert.throws(() => decryptLocalSecret(secret, linkedKey))
  assert.deepEqual(fs.readFileSync(ownerKey), before)
  assert.equal(decryptLocalSecret(secret, ownerKey), 'owner')
})
