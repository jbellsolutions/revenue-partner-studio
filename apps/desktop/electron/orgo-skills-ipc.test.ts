import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const preload = readFileSync(resolve(process.cwd(), 'electron/preload.ts'), 'utf8')
const main = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8')

describe('Korgo skills import IPC', () => {
  it('exposes the skills sync method with an optional trusted source path', () => {
    expect(preload).toContain("syncSkills: (sourcePath?: string) =>")
    expect(preload).toContain("ipcRenderer.invoke('hermes:orgo-desktop:skills:sync', sourcePath)")
  })

  it('opens a directory picker or syncs a trusted local root to the bound computer', () => {
    expect(main).toContain("ipcMain.handle('hermes:orgo-desktop:skills:sync', async (_event, sourcePath?: string) =>")
    expect(main).toContain('importLocalKorgoSkills(sourcePath)')
    expect(main).toContain("properties: ['openDirectory']")
    expect(main).toContain('buildKorgoSkillsBundle(sourcePath)')
    expect(main).toContain('ensureKorgoSkillsOnOrgo(')
  })
})
