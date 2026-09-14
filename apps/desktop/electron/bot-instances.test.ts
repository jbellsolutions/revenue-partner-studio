import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { botInstanceLaunch, listBotInstances, refreshBotInstances, validateBotInstance } from './bot-instances'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('isolated computer windows', () => {
  it('refreshes live names/status once per computer without changing window bindings', async () => {
    const rows = [
      { name: '', computerId: 'one', current: true, unreadable: false },
      { name: 'support', computerId: 'one', current: false, unreadable: false },
      { name: 'setup', computerId: '', current: false, unreadable: false }
    ]

    const lookup = vi.fn().mockResolvedValue({ id: 'one', name: 'Renamed computer', status: 'stopped' })
    const result = await refreshBotInstances(rows, lookup)

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(result).toEqual([
      { ...rows[0], cloudName: 'Renamed computer', cloudStatus: 'stopped', availability: 'available' },
      { ...rows[1], cloudName: 'Renamed computer', cloudStatus: 'stopped', availability: 'available' },
      rows[2]
    ])
    expect(rows[0]).not.toHaveProperty('availability')
  })
  it('retains missing and unreachable computers rather than removing histories or rebinding windows', async () => {
    const rows = ['removed', 'offline', 'foreign'].map(computerId => ({
      name: computerId, computerId, current: false, unreadable: false
    }))

    const lookup = vi.fn().mockRejectedValueOnce(Object.assign(new Error('404'), { code: 'computer-not-found' }))
      .mockRejectedValueOnce(new Error('Timeout or auth failure'))
      .mockResolvedValueOnce({ id: 'wrong-computer', name: 'Foreign', status: 'running' })

    expect(await refreshBotInstances(rows, lookup)).toEqual([
      { ...rows[0], availability: 'missing' },
      { ...rows[1], availability: 'unknown' },
      { ...rows[2], availability: 'unknown' }
    ])
  })
  it('enumerates real instance bindings without returning secrets or following symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-instances-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'instances', 'research'), { recursive: true })
    fs.mkdirSync(path.join(root, 'instances', 'broken'))
    fs.writeFileSync(
      path.join(root, 'orgo-desktop.json'),
      JSON.stringify({ profiles: { default: { computerId: 'primary', apiKey: 'secret' } } })
    )
    fs.writeFileSync(
      path.join(root, 'instances', 'research', 'orgo-desktop.json'),
      JSON.stringify({ profiles: { default: { computerId: 'other', apiKey: 'another-secret' } } })
    )
    fs.writeFileSync(path.join(root, 'instances', 'broken', 'orgo-desktop.json'), '{')
    fs.symlinkSync(root, path.join(root, 'instances', 'linked'))
    expect(listBotInstances(root, 'research')).toEqual([
      { name: '', computerId: 'primary', current: false, unreadable: false },
      { name: 'broken', computerId: '', current: false, unreadable: true },
      { name: 'research', computerId: 'other', current: true, unreadable: false }
    ])
  })
  it.each(['../other', '/tmp/foo', '--inspect', 'a/b', 'a b', null])('rejects unsafe instance %s', value => {
    expect(() => validateBotInstance(value)).toThrow()
  })
  it('launches the default window explicitly and strips inherited connection overrides', () => {
    const launch = botInstanceLaunch('', '/Applications/Orgo AI Guy Bot.app/Contents/MacOS/Orgo AI Guy Bot', 'darwin', {
      PATH: '/usr/bin',
      HERMES_HOME: '/other/home',
      HERMES_DESKTOP_USER_DATA_DIR: '/other/data',
      ELECTRON_RUN_AS_NODE: '1'
    })

    expect(launch).toEqual({
      command: '/usr/bin/open',
      args: ['-na', '/Applications/Orgo AI Guy Bot.app', '--args', '--studio-primary'],
      env: { PATH: '/usr/bin' }
    })
    expect(botInstanceLaunch('Research', '/app', 'linux', {}).args).toEqual(['--studio-instance=research'])
  })
})
