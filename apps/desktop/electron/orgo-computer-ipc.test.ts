import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = process.cwd()
const main = readFileSync(resolve(root, 'electron/main.ts'), 'utf8')
const preload = readFileSync(resolve(root, 'electron/preload.ts'), 'utf8')
const globals = readFileSync(resolve(root, 'src/global.d.ts'), 'utf8')

describe('Orgo computer metadata IPC', () => {
  it('exposes a read-only remote computer summary method', () => {
    expect(preload).toContain("getComputer: () => ipcRenderer.invoke('hermes:orgo-desktop:computer:get')")
    expect(globals).toContain('getComputer: () => Promise<{')
    expect(globals).toContain('name: string')
    expect(globals).toContain("status: string")
  })

  it('registers a main-process handler backed by getOrgoComputer', () => {
    expect(main).toContain("ipcMain.handle('hermes:orgo-desktop:computer:get'")
    expect(main).toContain('return getOrgoComputer(credentials.apiKey, credentials.computerId)')
  })

  it('prefers the official Orgo CLI credential before touching macOS safeStorage', () => {
    expect(main).toContain("path.join(os.homedir(), '.orgo', 'credentials.json')")
    expect(main).toContain('return readOrgoCliApiKey() || decryptDesktopSecret(secret)')
  })
})
