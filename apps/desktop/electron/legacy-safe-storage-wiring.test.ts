import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const main = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8')

describe('macOS safeStorage wiring', () => {
  it('never shells out to security to export legacy keychain passwords', () => {
    expect(main).not.toContain("['find-generic-password', '-w', '-s', service]")
    expect(main).not.toContain('PREVIOUS_KORGO_SAFE_STORAGE_SERVICES')
    expect(main).not.toContain('readPreviousKorgoSafeStoragePasswords')
  })

  it('uses only the current app identity to decrypt persisted secrets outside Bot local-vault mode', () => {
    expect(main).toContain("safeStorage.decryptString(Buffer.from(value, 'base64'))")
    expect(main).not.toContain('decryptDesktopSecretWithLegacyMigration')
  })

  it('keeps a rebuilt macOS Bot app entirely away from Keychain', () => {
    const switchIndex = main.indexOf("app.commandLine.appendSwitch('use-mock-keychain')")
    const readyIndex = main.indexOf('app.whenReady().then')

    expect(switchIndex).toBeGreaterThan(0)
    expect(switchIndex).toBeLessThan(readyIndex)
    expect(main).toContain('if (USE_BOT_LOCAL_SECRET_VAULT)')
    expect(main).toContain('return encryptLocalSecret(value, DESKTOP_LOCAL_SECRET_KEY_PATH)')
    expect(main).toContain('return decryptLocalSecret(secret, DESKTOP_LOCAL_SECRET_KEY_PATH)')
  })

  it('migrates the known Orgo credential without reading its legacy Keychain blob', () => {
    expect(main).toContain('function migrateBotOrgoSecretFromCli()')
    expect(main).toContain('current.apiKey?.encoding !== SAFE_STORAGE_ENCODING')
    expect(main).toContain('apiKey: encryptDesktopSecret(apiKey)')
    expect(main).toContain('USE_BOT_LOCAL_SECRET_VAULT && apiKey?.encoding === LOCAL_SECRET_VAULT_ENCODING')
  })

  it('persists optional SSH reuse tokens through the same local vault', () => {
    expect(main).toContain('function decryptSshReuseToken(secret)')
    expect(main).toContain('function encryptSshReuseToken(token)')
    expect(main).toContain('const encrypted = encryptSshReuseToken(token)')
  })
})
