import { createCipheriv, pbkdf2Sync } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  collectAvailableLegacyPasswords,
  decryptDesktopSecretWithLegacyMigration,
  type DesktopSecretMigrationIo
} from './legacy-safe-storage'

function legacyCiphertext(plaintext: string, password: string) {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

  return Buffer.concat([Buffer.from('v10'), encrypted]).toString('base64')
}

describe('legacy macOS safeStorage migration', () => {
  it('continues past missing Keychain services', () => {
    const reader = vi.fn((service: string) => {
      if (service === 'missing') {
        throw new Error('not found')
      }

      return service === 'current-previous-name' ? 'available-password' : ''
    })

    expect(collectAvailableLegacyPasswords(['missing', 'current-previous-name', 'empty'], reader)).toEqual([
      'available-password'
    ])
    expect(reader).toHaveBeenCalledTimes(3)
  })

  it('uses current safeStorage without reading the legacy keychain', () => {
    const io: DesktopSecretMigrationIo = {
      decryptCurrent: vi.fn(() => 'current-secret'),
      encryptCurrent: vi.fn(),
      readLegacyPasswords: vi.fn()
    }

    expect(decryptDesktopSecretWithLegacyMigration('Y3VycmVudA==', io)).toEqual({
      value: 'current-secret'
    })
    expect(io.readLegacyPasswords).not.toHaveBeenCalled()
    expect(io.encryptCurrent).not.toHaveBeenCalled()
  })

  it('decrypts a legacy v10 blob and returns a replacement under the current identity', () => {
    const password = 'legacy-keychain-password'

    const io: DesktopSecretMigrationIo = {
      decryptCurrent: vi.fn(() => {
        throw new Error('wrong app safeStorage identity')
      }),
      encryptCurrent: vi.fn(value => Buffer.from(`oorgo:${value}`, 'utf8')),
      readLegacyPasswords: vi.fn(() => [password])
    }

    const result = decryptDesktopSecretWithLegacyMigration(legacyCiphertext('orgo-api-secret', password), io)

    expect(result).toEqual({
      value: 'orgo-api-secret',
      replacementValue: Buffer.from('oorgo:orgo-api-secret', 'utf8').toString('base64')
    })

    expect(io.readLegacyPasswords).toHaveBeenCalledOnce()
    expect(io.encryptCurrent).toHaveBeenCalledWith('orgo-api-secret')
  })

  it('tries each previous app identity until one decrypts the shared ciphertext', () => {
    const currentPassword = 'oorgo-keychain-password'

    const io: DesktopSecretMigrationIo = {
      decryptCurrent: vi.fn(() => {
        throw new Error('wrong Korgo safeStorage identity')
      }),
      encryptCurrent: vi.fn(value => Buffer.from(`korgo:${value}`, 'utf8')),
      readLegacyPasswords: vi.fn(() => ['wrong-old-password', currentPassword])
    }

    expect(
      decryptDesktopSecretWithLegacyMigration(legacyCiphertext('orgo-api-secret', currentPassword), io)
    ).toEqual({
      value: 'orgo-api-secret',
      replacementValue: Buffer.from('korgo:orgo-api-secret', 'utf8').toString('base64')
    })
  })

  it('rejects non-v10 legacy ciphertext', () => {
    const io: DesktopSecretMigrationIo = {
      decryptCurrent: () => {
        throw new Error('wrong identity')
      },
      encryptCurrent: vi.fn(),
      readLegacyPasswords: () => ['password']
    }

    expect(() => decryptDesktopSecretWithLegacyMigration(Buffer.from('v11payload').toString('base64'), io)).toThrow(
      'Unsupported legacy safeStorage envelope.'
    )
  })
})
