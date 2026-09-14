import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { computers, initialState, transition } from '../src/fixtures.ts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  read = p => readFileSync(resolve(root, p), 'utf8')
test('four invented computers keep independent content when switching', () => {
  assert.equal(new Set(computers.map(c => c.id)).size, 4)
  let s = { ...initialState }
  for (let turn = 0; turn < 40; turn++) {
    const i = turn % 4
    s = transition(s, 'select', i)
    assert.equal(s.selected, i)
    assert.match(computers[i].id, /^sample-/)
    assert.notEqual(computers[i].file, computers[(i + 1) % 4].file)
  }
})
test('handoff approval, takeover, switching and reset have deterministic boundaries', () => {
  let s = transition(initialState, 'approve')
  assert.equal(s.approved, false)
  s = transition(s, 'delegate')
  s = transition(s, 'approve')
  assert.equal(s.approved, true)
  s = transition(s, 'takeover')
  assert.equal(s.takeover, true)
  s = transition(s, 'select', 2)
  assert.equal(s.takeover, false)
  assert.deepEqual(transition(s, 'reset'), initialState)
})
test('public entry imports no authenticated app or agent network client', () => {
  for (const file of ['src/main.tsx', 'src/fixtures.ts']) {
    const source = read(file)
    assert.doesNotMatch(source, /\b(fetch|WebSocket|EventSource|XMLHttpRequest)\s*\(/)
    assert.doesNotMatch(source, /cloud\/(src|server)|api\.ts|ScreenVNC|screen-vnc|<iframe|type=["']file/)
  }
  const headers = read('public/_headers')
  assert.match(headers, /connect-src 'none'/)
  assert.match(headers, /frame-src 'none'/)
  assert.match(headers, /form-action 'none'/)
})
test('published downloads exactly match the preparation source', () => {
  for (const [source, target] of [
    ['BEFORE-YOU-START.md', 'before-you-start.md'],
    ['Revenue Partner Studio - Before You Start.docx', 'revenue-partner-studio-before-you-start.docx'],
    ['SETUP-PROMPT.txt', 'setup-prompt.txt']
  ])
    assert.deepEqual(
      readFileSync(resolve(root, '../docs', source)),
      readFileSync(resolve(root, 'public/downloads', target))
    )
})
test('all four routes, redirect and accessible labels remain present', () => {
  const source = read('src/main.tsx')
  for (const route of ['/demo', '/build', '/prep'])
    assert.ok(read('public/_redirects').includes(route + ' /index.html 200'))
  assert.match(read('public/_redirects'), /www\.revenuepartnerstudio\.com/)
  for (const text of [
    'Skip to content',
    'Reset demo',
    'aria-pressed',
    'Simulated response',
    'SIMULATED SCREEN',
    'Copy setup prompt'
  ])
    assert.ok(source.includes(text))
  assert.match(read('src/style.css'), /prefers-reduced-motion/)
  assert.match(read('src/style.css'), /max-width:\s*600px/)
})
