import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync('src/app/shell/titlebar-controls.tsx', 'utf8')

describe('computer titlebar controls', () => {
  it('places the computer toggle immediately after its settings gear', () => {
    const settings = source.indexOf("id: 'settings'")
    const computer = source.indexOf("id: 'computer'")

    expect(settings).toBeGreaterThan(0)
    expect(computer).toBeGreaterThan(settings)
  })
})
