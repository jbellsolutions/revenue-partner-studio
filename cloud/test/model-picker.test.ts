import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://studio.test' })
Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true },
  document: { value: dom.window.document, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true },
  HTMLElement: { value: dom.window.HTMLElement, configurable: true }
})
const React = await import('react')
const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
const { ModelPicker } = await import('../src/model-picker.tsx')
const { modelCatalog, invalidateModels } = await import('../src/model-catalog.ts')
const result = (value: any) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
const catalog = {
  providers: [
    { slug: 'openrouter', name: 'OpenRouter', authenticated: true, models: ['vendor/one', 'vendor/two'] },
    { slug: 'anthropic', name: 'Claude', authenticated: false, models: ['unconnected-model'] }
  ]
}
const base = {
  computer: 'computer-a',
  agent: 'same',
  runtime: 'conversation-one',
  model: 'vendor/one',
  provider: 'openrouter'
}

test('composer picker searches connected models and scopes a pending choice to the existing conversation', async t => {
  invalidateModels()
  t.after(cleanup)
  const calls: any[] = [],
    changes: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    const p = JSON.parse(options.body)
    calls.push({ url, ...p })
    return result(
      p.method === 'models.options'
        ? catalog
        : { model: p.params.model, provider: p.params.provider, state: 'pending', activeModel: 'vendor/one' }
    )
  })
  const ui = render(React.createElement(ModelPicker, { ...base, changed: v => changes.push(v) }))
  await ui.findByRole('button', { name: 'vendor/two' })
  assert.equal(ui.queryByRole('button', { name: 'unconnected-model' }), null)
  fireEvent.change(ui.getByLabelText('Search models'), { target: { value: 'two' } })
  assert.equal(ui.queryByRole('button', { name: 'vendor/one ✓' }), null)
  fireEvent.click(ui.getByRole('button', { name: 'vendor/two' }))
  await waitFor(() => assert.equal(changes.length, 1))
  assert.equal(changes[0].state, 'pending')
  assert.equal(changes[0].activeModel, 'vendor/one')
  assert.match(calls[1].url, /computer-a/)
  assert.deepEqual(calls[1].params, {
    agentId: 'same',
    runtimeId: 'conversation-one',
    provider: 'openrouter',
    model: 'vendor/two'
  })
  assert.equal(
    calls.some(c => c.method === 'chat.send' || c.method === 'sessions.open'),
    false
  )
})
test('manual IDs save through model selection, activation errors stay visible, and offline selection is disabled', async t => {
  invalidateModels()
  t.after(cleanup)
  const changes: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: any, options: any) => {
    const p = JSON.parse(options.body)
    if (p.method === 'models.options') return result(catalog)
    if (p.method === 'models.select')
      return new Response(JSON.stringify({ error: 'The selected model could not be activated' }), { status: 400 })
    return result({ state: 'error', model: 'vendor/custom', provider: 'openrouter', error: 'Choose a working model' })
  })
  const ui = render(React.createElement(ModelPicker, { ...base, changed: v => changes.push(v) }))
  await ui.findByRole('button', { name: 'vendor/two' })
  fireEvent.click(ui.getByText('Enter a model ID'))
  fireEvent.change(ui.getByLabelText('Model ID'), { target: { value: 'vendor/custom' } })
  fireEvent.click(ui.getByRole('button', { name: 'Use in this conversation' }))
  await waitFor(() => assert.equal(changes[0]?.state, 'error'))
  assert.ok(ui.getByText('The selected model could not be activated'))
  ui.rerender(React.createElement(ModelPicker, { ...base, online: false, changed: () => {} }))
  assert.equal((ui.getByRole('button', { name: 'Use in this conversation' }) as HTMLButtonElement).disabled, true)
})
test('late model replies cannot update a picker after changing computers with identical profile names', async t => {
  invalidateModels()
  t.after(cleanup)
  let resolve: (v: Response) => void = () => {}
  const changed: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: any, options: any) => {
    const p = JSON.parse(options.body)
    return p.method === 'models.options'
      ? result(catalog)
      : new Promise<Response>(r => {
          resolve = r
        })
  })
  const ui = render(React.createElement(ModelPicker, { ...base, key: 'a', changed: v => changed.push(v) }))
  fireEvent.click(await ui.findByRole('button', { name: 'vendor/two' }))
  ui.rerender(
    React.createElement(ModelPicker, { ...base, computer: 'computer-b', key: 'b', changed: v => changed.push(v) })
  )
  await React.act(async () => resolve(result({ state: 'applied', model: 'vendor/two', provider: 'openrouter' })))
  assert.deepEqual(changed, [])
})
test('model catalog deduplicates by computer/profile and invalidation does not share another profile catalog', async t => {
  invalidateModels()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return result(catalog)
  })
  await Promise.all([modelCatalog('a', 'same'), modelCatalog('a', 'same'), modelCatalog('b', 'same')])
  assert.equal(calls, 2)
  invalidateModels('a', 'same')
  await modelCatalog('a', 'same')
  await modelCatalog('b', 'same')
  assert.equal(calls, 3)
})
