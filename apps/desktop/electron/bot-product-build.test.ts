import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = process.cwd()
const bundleMain = readFileSync(resolve(root, 'scripts/bundle-electron-main.mjs'), 'utf8')
const electronMain = readFileSync(resolve(root, 'electron/main.ts'), 'utf8')

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  build?: { extraResources?: Array<{ from?: string; to?: string }> }
}

const runBuilder = readFileSync(resolve(root, 'scripts/run-electron-builder.mjs'), 'utf8')

describe('Revenue Partner Studio production package identity', () => {
  it('bakes the Revenue Partner Studio name into the packaged Electron main bundle', () => {
    expect(bundleMain).toContain("JSON.stringify('Revenue Partner Studio')")
    expect(bundleMain).not.toContain("JSON.stringify('Oorgo AI Guy Bot')")
  })

  it('names the app bundle, executable, and artifacts consistently', () => {
    expect(runBuilder).toContain("'-c.productName=Revenue Partner Studio'")
    expect(runBuilder).toContain("'-c.executableName=Revenue Partner Studio'")
    expect(runBuilder).toContain("'-c.artifactName=Revenue-Partner-Studio-${version}-${os}-${arch}.${ext}'")
    expect(runBuilder).toContain("'-c.dmg.title=Install Revenue Partner Studio'")
  })

  it('uses a valid ad-hoc identity for local mac builds when Developer ID signing is unavailable', () => {
    expect(runBuilder).toContain("args.push('-c.mac.identity=-')")
    expect(runBuilder).toContain("process.platform === 'darwin'")
    expect(runBuilder).toContain('hasConfiguredSigningIdentity')
  })

  it('packages and provisions remote maintenance for new and existing Orgo computers', () => {
    const targets = new Set((packageJson.build?.extraResources || []).map(resource => resource.to))

    for (const name of [
      'orgo-remote-maintenance',
      'orgo-maintenance-loop',
      'orgo-maintenance-supervisor.conf',
      'orgo-maintenance.service',
      'orgo-maintenance.timer'
    ]) {
      expect(targets).toContain(`orgo/maintenance/${name}`)
    }

    expect(electronMain.match(/ensureOrgoMaintenanceInstalled/g)?.length || 0).toBeGreaterThanOrEqual(3)
    expect(electronMain.match(/readBundledOrgoMaintenanceAssets/g)?.length || 0).toBeGreaterThanOrEqual(3)
  })
})
