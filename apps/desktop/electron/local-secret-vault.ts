import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const LOCAL_SECRET_VAULT_ENCODING = 'localVaultV1'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const PAYLOAD_VERSION = 1
const AAD = Buffer.from('hermes-orgo-studio/local-secret-v1', 'utf8')

export function shouldUseBotLocalSecretVault({ platform, botProduct }: { platform: string; botProduct: boolean }) {
  return platform === 'darwin' && botProduct
}

function readKey(keyPath: string, tightenPermissions = false): Buffer {
  // Read through one descriptor: do not follow a replaced/symlinked key when
  // tightening its mode, and never manufacture a key during decryption.
  const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))

  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error('The local secret-vault key is invalid.')
    }

    if (tightenPermissions) {
      fs.fchmodSync(fd, 0o600)
    }

    const key = fs.readFileSync(fd)

    if (key.length !== KEY_BYTES) {
      throw new Error('The local secret-vault key is invalid.')
    }

    return key
  } finally {
    fs.closeSync(fd)
  }
}

function readOrCreateKey(keyPath: string): Buffer {
  try {
    return readKey(keyPath, true)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 })
  const stagingPath = `${keyPath}.${crypto.randomUUID()}.pending`
  const fd = fs.openSync(stagingPath, 'wx', 0o600)

  try {
    // Publish only a completely written key. An exclusive write directly to
    // keyPath exposes a partial key to another start and poisons retries if
    // the write fails. A same-directory hard link atomically publishes without
    // overwriting a key another process has already committed (unlike rename).
    fs.writeFileSync(fd, crypto.randomBytes(KEY_BYTES))
    fs.fsyncSync(fd)

    try {
      fs.linkSync(stagingPath, keyPath)
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error
      }
    }
  } finally {
    try {
      fs.closeSync(fd)
    } finally {
      fs.unlinkSync(stagingPath)
    }
  }

  return readKey(keyPath, true)
}

export function encryptLocalSecret(value: unknown, keyPath: string) {
  const raw = String(value || '')

  if (!raw) {
    return null
  }

  const key = readOrCreateKey(keyPath)
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)

  cipher.setAAD(AAD)
  const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([Buffer.from([PAYLOAD_VERSION]), iv, tag, encrypted])

  return { encoding: LOCAL_SECRET_VAULT_ENCODING, value: payload.toString('base64') }
}

export function decryptLocalSecret(secret: any, keyPath: string): string {
  if (secret?.encoding !== LOCAL_SECRET_VAULT_ENCODING || !secret?.value) {
    return ''
  }

  const payload = Buffer.from(String(secret.value), 'base64')
  const minimumBytes = 1 + IV_BYTES + TAG_BYTES

  if (payload.length <= minimumBytes || payload[0] !== PAYLOAD_VERSION) {
    throw new Error('The local secret-vault payload is invalid.')
  }

  const key = readKey(keyPath)
  const ivStart = 1
  const tagStart = ivStart + IV_BYTES
  const encryptedStart = tagStart + TAG_BYTES
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(ivStart, tagStart))

  decipher.setAAD(AAD)
  decipher.setAuthTag(payload.subarray(tagStart, encryptedStart))

  return Buffer.concat([decipher.update(payload.subarray(encryptedStart)), decipher.final()]).toString('utf8')
}
