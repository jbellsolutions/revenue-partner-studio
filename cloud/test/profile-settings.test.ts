import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://studio.test' })
Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true }, document: { value: dom.window.document, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true }, HTMLElement: { value: dom.window.HTMLElement, configurable: true }
})
const React = await import('react')
const { render, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react')
const { ProfileSettings } = await import('../src/profile-settings.tsx')
const { LocalSetup } = await import('../src/local.tsx')
const response = (value: any) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
test('settings save only changed values to the selected profile and retain edits on conflict', async t => {
  t.after(cleanup)
  const calls: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    const body = JSON.parse(options.body); calls.push({ url, ...body })
    if (body.method === 'profile.settings.get') return response({ version: 'v1', busy: false, efforts: ['low', 'medium'], toolsets: ['terminal'],
      values: { 'agent.max_turns': 20, 'agent.reasoning_effort': 'medium', 'agent.disabled_toolsets': [] } })
    return new Response(JSON.stringify({ error: 'These settings changed. Reload before saving.' }), { status: 409 })
  })
  const ui = render(React.createElement(ProfileSettings, { computer: 'computer-b', agent: 'same', supported: true }))
  fireEvent.change(await ui.findByLabelText('Maximum tool turns'), { target: { value: '30' } })
  fireEvent.click(ui.getByRole('button', { name: 'Save agent settings' }))
  await ui.findByRole('alert')
  assert.equal((ui.getByLabelText('Maximum tool turns') as HTMLInputElement).value, '30')
  assert.deepEqual(calls[1].params, { agentId: 'same', version: 'v1', changes: { 'agent.max_turns': 30 } })
  assert.match(calls[1].url, /computer-b/)
  assert.equal(calls.some(c => c.method === 'chat.send'), false)
})
test('a Mac already online does not hide the repair download before the new companion pairs', async t => {
  t.after(cleanup)
  const checks: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    checks.push(url)
    return response(String(url) === '/api/connections/local'
      ? { computerId: 'mac', job: 'new-job', download: '/private-download' }
      : { runtimeConnected: true, setupJob: 'old-job', runtimeVersion: 'legacy' })
  })
  const ui = render(React.createElement(LocalSetup, { computers: [{ id: 'mac', name: 'Mac', kind: 'local', online: true }], select: () => {} }))
  fireEvent.click(await ui.findByRole('button', { name: 'Repair local Hermes' }))
  await ui.findByRole('link', { name: 'Download Mac connection' })
  await waitFor(() => assert.equal(ui.queryByText('Your Mac is connected'), null))
  assert.ok(checks.includes('/api/connections/local'))
})
test('a replacement repair download waits for its own job on the same Mac', async t => {
  t.after(cleanup)
  let nextJob = 0, readyJob = 'old-job'
  let poll: (() => void) | undefined
  t.mock.method(globalThis, 'setInterval', ((callback: () => void) => { poll = callback; return 1 }) as any)
  t.mock.method(globalThis, 'clearInterval', (() => {}) as any)
  t.mock.method(globalThis, 'fetch', async (url: any) => response(String(url) === '/api/connections/local'
    ? { computerId: 'mac', job: 'job-' + ++nextJob, download: '/private-download-' + nextJob }
    : { runtimeConnected: true, setupJob: readyJob, runtimeVersion: 'screens-recovery-2' }))
  const ui = render(React.createElement(LocalSetup, { computers: [{ id: 'mac', name: 'Mac', kind: 'local', online: true }], select: () => {} }))
  fireEvent.click(await ui.findByRole('button', { name: 'Repair local Hermes' }))
  await ui.findByRole('link', { name: 'Download Mac connection' })
  fireEvent.click(ui.getByRole('button', { name: 'Prepare a fresh download' }))
  await waitFor(() => assert.equal(ui.getByRole('link', { name: 'Download Mac connection' }).getAttribute('href'), '/private-download-2'))
  readyJob = 'job-1'
  await act(async () => { poll!(); await Promise.resolve() })
  assert.equal(ui.queryByText('Your Mac is connected'), null)
  readyJob = 'job-2'
  await act(async () => { poll!(); await Promise.resolve() })
  await ui.findByText('Your Mac is connected')
})
