import { createDecipheriv, pbkdf2Sync } from 'node:crypto'

export interface DesktopSecretMigrationIo {
  decryptCurrent: (ciphertext: Buffer) => string
  encryptCurrent: (plaintext: string) => Buffer
  readLegacyPasswords: () => string[]
}

export interface DesktopSecretMigrationResult {
  value: string
  replacementValue?: string
}

export function collectAvailableLegacyPasswords(
  services: string[],
  readPassword: (service: string) => string
) {
  const passwords: string[] = []

  for (const service of services) {
    try {
      const password = readPassword(service)

      if (password) {
        passwords.push(password)
      }
    } catch {
      // Keychain returns a non-zero exit when a historical service is absent.
    }
  }

  return passwords
}

export function decryptDesktopSecretWithLegacyMigration(
  encodedValue: string,
  io: DesktopSecretMigrationIo
): DesktopSecretMigrationResult {
  const ciphertext = Buffer.from(encodedValue, 'base64')

  try {
    return { value: io.decryptCurrent(ciphertext) }
  } catch {
    if (ciphertext.subarray(0, 3).toString('ascii') !== 'v10') {
      throw new Error('Unsupported legacy safeStorage envelope.')
    }

    const passwords = io.readLegacyPasswords().filter(Boolean)

    if (passwords.length === 0) {
      throw new Error('Legacy safeStorage password is unavailable.')
    }

    for (const password of passwords) {
      const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')

      try {
        const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
        const value = Buffer.concat([decipher.update(ciphertext.subarray(3)), decipher.final()]).toString('utf8')
        const replacementValue = io.encryptCurrent(value).toString('base64')

        return { value, replacementValue }
      } catch {
        // The stable user-data directory can contain ciphertext from either
        // previous product identity. Try the next matching Keychain service.
      } finally {
        key.fill(0)
      }
    }

    throw new Error('Legacy safeStorage ciphertext could not be decrypted.')
  }
}
