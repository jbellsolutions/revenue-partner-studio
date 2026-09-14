/** Each installation is bound to its explicitly configured computer. No shipped account IDs. */
export const STUDIO_REMOTE_HERMES = '/opt/hermes-orgo-studio/venv/bin/hermes'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let readBinding: () => string = () => ''
export function configureStudioBinding(reader: () => string): void { readBinding = reader }
export function requireStudioComputer(computerId: string, expected = readBinding()): void {
  if (!UUID.test(expected) || !UUID.test(computerId) || computerId.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Studio can access only the computer configured for this installation.')
  }
}
export function guardStudioOrgoRequest(requestPath: string, method = 'GET'): void {
  const computer = /^\/computers\/([^/?]+)/.exec(requestPath)
  if (computer) requireStudioComputer(decodeURIComponent(computer[1]))
  if (method !== 'GET' && !computer) throw new Error('Studio cannot provision or modify account resources automatically.')
}
