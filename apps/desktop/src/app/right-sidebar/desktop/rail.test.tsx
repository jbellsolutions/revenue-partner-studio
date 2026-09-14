import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ResizableComputerRail } from './rail'

describe('ResizableComputerRail', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(cleanup)

  it('resizes from its left edge and persists the chosen width', () => {
    const view = render(
      <ResizableComputerRail>
        <div>Computer</div>
      </ResizableComputerRail>
    )

    const separator = screen.getByRole('separator', { name: 'Resize computer details' })
    const rail = separator.parentElement

    expect(rail?.style.width).toBe('268px')
    fireEvent.pointerDown(separator, { clientX: 800, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 700, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 700, pointerId: 1 })
    expect(rail?.style.width).toBe('368px')

    view.unmount()
    render(
      <ResizableComputerRail>
        <div>Computer</div>
      </ResizableComputerRail>
    )
    expect(screen.getByRole('separator', { name: 'Resize computer details' }).parentElement?.style.width).toBe('368px')
  })

  it('supports keyboard resizing and resets on double click', () => {
    render(
      <ResizableComputerRail>
        <div>Computer</div>
      </ResizableComputerRail>
    )
    const separator = screen.getByRole('separator', { name: 'Resize computer details' })
    const rail = separator.parentElement

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(rail?.style.width).toBe('284px')
    expect(separator.getAttribute('aria-valuenow')).toBe('284')
    fireEvent.doubleClick(separator)
    expect(rail?.style.width).toBe('268px')
  })
})
