import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://studio.test' })
Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true }, document: { value: dom.window.document, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true }, HTMLElement: { value: dom.window.HTMLElement, configurable: true }
})
const React = await import('react')
const { render, cleanup, fireEvent } = await import('@testing-library/react')
const { Screen } = await import('../src/screen.tsx')
test('unverified screen ownership stops automatic allocation and provides a repair action', async t => {
  t.after(cleanup)
  const methods: string[] = [], repairs: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: any, options: any) => {
    const { method, params } = JSON.parse(options.body); methods.push(method)
    assert.equal(params.agentId, 'brent')
    assert.match(String(_url), /computers\/gtm\/rpc$/)
    if (method === 'screen.repair') return new Response(JSON.stringify({ error: 'Another process owns this port; nothing was changed.' }), { status: 409 })
    return new Response(JSON.stringify({ state: 'repair_needed', reason: 'unverified_owner', message: 'Existing work preserved.' }))
  })
  const ui = render(React.createElement(Screen, { computer: 'gtm', agent: 'brent', agentName: 'Brent', computerName: 'GTM', enabled: true,
    diagnostics: true, onRepair: () => repairs.push('repair') }))
  await ui.findByText('Screen needs repair')
  assert.ok(ui.getByText('Existing work preserved.'))
  assert.deepEqual(methods, ['screen.status'])
  fireEvent.click(ui.getByRole('button', { name: 'Repair screen ownership' }))
  await ui.findByText('Another process owns this port; nothing was changed.')
  assert.deepEqual(methods, ['screen.status', 'screen.repair'])
  fireEvent.click(ui.getByRole('button', { name: 'Repair computer connection' }))
  assert.deepEqual(repairs, ['repair'])
  assert.equal((ui.getByRole('button', { name: 'Take control' }) as HTMLButtonElement).disabled, true)
})
