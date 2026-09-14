import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readStudioDefault, resolveStudioLaunch, saveStudioDefault } from './studio-launch'

const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-launch-')); roots.push(root)
  for (const name of ['', 'market']) {
    const dir = name ? path.join(root, 'instances', name) : root
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, 'orgo-desktop.json'), JSON.stringify({profiles: {default: {computerId: name || 'trial', apiKey: 'test-encrypted-key'}}}))
  }
  return root
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, {recursive: true, force: true})))
it('cold starts select the chosen computer while explicit windows keep their own history and lock root', () => {
  const root = fixture()
  const before = fs.readFileSync(path.join(root, 'orgo-desktop.json'), 'utf8')
  expect(resolveStudioLaunch(root, [])).toBe('')
  saveStudioDefault(root, 'market')
  expect(readStudioDefault(root)).toBe('market')
  expect(resolveStudioLaunch(root, [])).toBe('market')
  expect(resolveStudioLaunch(root, ['--studio-primary'])).toBe('')
  expect(resolveStudioLaunch(root, ['--studio-instance=market'])).toBe('market')
  expect(fs.readFileSync(path.join(root, 'orgo-desktop.json'), 'utf8')).toBe(before)
  expect(fs.readFileSync(path.join(root, 'studio-launch.json'), 'utf8')).not.toContain('test-encrypted-key')
})
it('rejects incomplete, linked and unsafe choices without changing the saved default', () => {
  const root = fixture(); saveStudioDefault(root, 'market')
  for (const name of ['../outside', 'missing']) expect(() => saveStudioDefault(root, name)).toThrow()
  fs.symlinkSync(root, path.join(root, 'instances', 'linked'))
  expect(() => saveStudioDefault(root, 'linked')).toThrow()
  expect(readStudioDefault(root)).toBe('market')
  expect(() => resolveStudioLaunch(root, ['--studio-primary', '--studio-instance=market'])).toThrow()
})
it('does not silently send a broken default to the head agent on another computer', () => {
  const root = fixture(); saveStudioDefault(root, 'market')
  fs.rmSync(path.join(root, 'instances', 'market'), {recursive: true})
  expect(() => resolveStudioLaunch(root, [])).toThrow('unavailable')
  expect(resolveStudioLaunch(root, ['--studio-primary'])).toBe('')
})
