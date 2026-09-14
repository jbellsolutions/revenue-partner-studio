import { describe, it, expect, vi } from 'vitest'
import { connectStudioService } from './studio-connection'
const STUDIO_COMPUTER_ID = '11111111-1111-4111-8111-111111111111'

function fixture(id = STUDIO_COMPUTER_ID) {
  return { computerId: STUDIO_COMPUTER_ID, ssh:{exec:vi.fn().mockResolvedValue(JSON.stringify({computerId:id,token:'test-token'})),forward:vi.fn(),cancelForward:vi.fn()},
    pickLocalPort:vi.fn().mockResolvedValue(42788),waitForHermes:vi.fn() }
}
describe('independent remote service attachment', () => {
  it('only inspects identity and forwards; never spawns or stops a remote runtime', async () => {
    const deps=fixture();const result=await connectStudioService(deps)
    expect(result.reused).toBe(true)
    expect(deps.ssh.exec).toHaveBeenCalledTimes(1)
    expect(deps.ssh.exec.mock.calls[0][0]).not.toMatch(/nohup|kill|supervisorctl|serve --/)
    expect(deps.ssh.forward).toHaveBeenCalledWith(42788,8787)
    expect(deps.waitForHermes).toHaveBeenCalledWith('http://127.0.0.1:42788','test-token')
  })
  it('rejects any other computer before forwarding', async () => {
    const deps=fixture('another-computer')
    await expect(connectStudioService(deps)).rejects.toThrow('identity')
    expect(deps.ssh.forward).not.toHaveBeenCalled()
  })
  it('closes only its tunnel when the remote service is unavailable', async () => {
    const deps=fixture();deps.waitForHermes.mockRejectedValue(new Error('unavailable'))
    await expect(connectStudioService(deps)).rejects.toThrow('unavailable')
    expect(deps.ssh.cancelForward).toHaveBeenCalledWith(42788,8787)
  })
})
