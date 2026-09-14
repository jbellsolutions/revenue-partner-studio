import { describe, expect, it, vi } from 'vitest'

import { legacyScreenSession, managedScreenSession, screenCommand, workspaceScreenSession } from './orgo-screen-session'

const id = '11111111-1111-4111-8111-111111111111'
const info = { computerId: id, profile: 'team-support', display: ':100', wsPort: 6200, paused: false }
const connection = (output = JSON.stringify(info)) => ({ exec: vi.fn().mockResolvedValue(output), forward: vi.fn().mockResolvedValue(undefined) })

describe('cloud-only managed agent screens', () => {
  it('uses a deduplicated encrypted SSH tunnel for an older computer, retaining rotated credentials', async () => {
    const ssh = connection()
    const pick = vi.fn().mockResolvedValue(45679)
    const first = await legacyScreenSession(ssh, id, 'old token', pick)
    const second = await legacyScreenSession(ssh, id, 'new token', pick)
    expect(ssh.forward).toHaveBeenCalledExactlyOnceWith(45679, 6080)
    expect(first.websocketUrl).toBe('ws://127.0.0.1:45679/websockify?token=old%20token')
    expect(second.websocketUrl).toBe('ws://127.0.0.1:45679/websockify?token=new%20token')
    expect(second).not.toHaveProperty('managedScreen')
  })
  it('retries a failed legacy tunnel and never chooses an arbitrary remote port', async () => {
    const ssh = connection()
    ssh.forward.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(legacyScreenSession(ssh, id, 'token', async () => 45679)).rejects.toThrow('Connection lost')
    expect((await legacyScreenSession(ssh, id, 'token', async () => 45680)).websocketUrl).toContain('127.0.0.1:45680')
    expect(ssh.forward).toHaveBeenLastCalledWith(45680, 6080)
    await expect(legacyScreenSession(ssh, 'bad-id', 'token', async () => 22)).rejects.toThrow('valid Orgo computer ID')
  })
  it('tunnels the selected profile and deduplicates simultaneous reconnects', async () => {
    const ssh = connection()
    const pick = vi.fn().mockResolvedValue(45678)
    const result = await Promise.all([1, 2].map(() => managedScreenSession(ssh, id, 'team-support', pick)))
    expect(result[0]?.websocketUrl).toBe('ws://127.0.0.1:45678')
    expect(ssh.forward).toHaveBeenCalledExactlyOnceWith(45678, 6200)
    expect(ssh.exec.mock.calls[0][0]).toContain('ensure team-support')
    expect(ssh.exec.mock.calls[0][0]).toContain(`ORGO_DEFAULT_COMPUTER_ID=${id}`)
  })
  it('only falls back for explicitly missing capability, never timeout or a wrong computer', async () => {
    expect(await screenCommand(connection('ORGO_SCREEN_UNSUPPORTED\n'), id, 'team-support', 'ensure')).toBeNull()
    await expect(screenCommand(connection(JSON.stringify({ ...info, computerId: 'other' })), id, 'team-support', 'ensure')).rejects.toThrow('identity')
    const ssh = connection(); ssh.exec.mockRejectedValue(new Error('timeout'))
    await expect(screenCommand(ssh, id, 'team-support', 'ensure')).rejects.toThrow('timeout')
  })
  it('does not accept command injection or arbitrary forwarded ports', async () => {
    const ssh = connection()
    await expect(screenCommand(ssh, id, 'a;id', 'ensure')).rejects.toThrow('Invalid')
    expect(ssh.exec).not.toHaveBeenCalled()
    await expect(screenCommand(connection(JSON.stringify({ ...info, wsPort: 22 })), id, 'team-support', 'ensure')).rejects.toThrow('identity')
  })
  it('waits for authoritative pause before granting human control', async () => {
    const ssh = connection(JSON.stringify({ ...info, paused: true }))
    expect((await screenCommand(ssh, id, 'team-support', 'pause'))?.paused).toBe(true)
    expect(ssh.exec.mock.calls[0][0]).toContain('pause team-support')
  })
})

it('keeps existing Hermes chats on the main computer without creating empty agent displays', async () => {
  const ssh = connection()
  const pick = vi.fn().mockResolvedValue(45680)
  const first = await workspaceScreenSession(ssh, id, 'assistant', 'credential', pick, 'hermes')
  const second = await workspaceScreenSession(ssh, id, 'team-gtm', 'rotated', pick, 'hermes')
  expect(ssh.exec).not.toHaveBeenCalled()
  expect(ssh.forward).toHaveBeenCalledExactlyOnceWith(45680, 6080)
  expect(first).toMatchObject({sharedScreen: true})
  expect(first).not.toHaveProperty('managedScreen')
  expect(second?.websocketUrl).toBe('ws://127.0.0.1:45680/websockify?token=rotated')
})
it('preserves dedicated Studio agent-screen ownership and fails closed on identity errors', async () => {
  const ssh = connection()
  const screen = await workspaceScreenSession(ssh, id, 'team-support', 'credential', async () => 45681, 'studio')
  expect(screen).toMatchObject({managedScreen: true, screenProfile: 'team-support'})
  expect(ssh.forward).toHaveBeenCalledExactlyOnceWith(45681, 6200)
  const invalid = connection(JSON.stringify({...info, computerId:'wrong'}))
  await expect(workspaceScreenSession(invalid, id, 'team-support', 'credential', async () => 45681, 'studio')).rejects.toThrow('identity')
  expect(invalid.forward).not.toHaveBeenCalled()
})
