import { requireStudioComputer, STUDIO_REMOTE_HERMES } from './studio-policy'

/** Attach to the supervised remote service. This client never starts/stops an agent runtime. */
interface StudioTransport {
  computerId: string
  ssh: { exec(command: string): Promise<string>; forward(local: number, remote: number): Promise<void>; cancelForward(local: number, remote: number): Promise<void> }
  pickLocalPort(): Promise<number>
  waitForHermes(url: string, token: string): Promise<unknown>
}
export async function connectStudioService({ computerId, ssh, pickLocalPort, waitForHermes }: StudioTransport) {
  requireStudioComputer(computerId, computerId)
  const inspection = `from pathlib import Path; import json; b=json.loads(Path('/root/.hermes/orgo-computer/computer.json').read_text()); assert b['computerId']=='${computerId}', 'Wrong Studio computer'; print(json.dumps({'computerId':b['computerId'],'token':Path('/root/.hermes/studio/gateway-token').read_text().strip()}))`
  const quoted = "'" + inspection.replaceAll("'", "'\\''") + "'"
  const result = await ssh.exec(`/opt/hermes-orgo-studio/venv/bin/python -c ${quoted}`)
  const identity = JSON.parse(result)
  if (identity.computerId !== computerId || typeof identity.token !== 'string' || !identity.token) {
    throw new Error('Invalid Studio service identity.')
  }
  const localPort = await pickLocalPort()
  const remotePort = 8787
  await ssh.forward(localPort, remotePort)
  const baseUrl = `http://127.0.0.1:${localPort}`
  try { await waitForHermes(baseUrl, identity.token) }
  catch (error) { await ssh.cancelForward(localPort, remotePort); throw error }
  return { baseUrl, localPort, remotePort, token:identity.token, reused:true, pid:null,
    hermesPath:STUDIO_REMOTE_HERMES, hermesVersion:'Studio remote service', platform:{os:'Linux'} }
}
