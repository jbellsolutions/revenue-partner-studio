import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { useRef, useState } from 'react'

const DEFAULT_WIDTH = 268
const MIN_WIDTH = 240
const MAX_WIDTH = 520
const KEYBOARD_STEP = 16
const STORAGE_KEY = 'hermes:computer-rail-width'

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))
}

function readStoredWidth(): number {
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(STORAGE_KEY) ?? '')

    return Number.isFinite(stored) ? clampWidth(stored) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function storeWidth(width: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    // The rail remains resizable for this window when storage is unavailable.
  }
}

interface ResizableComputerRailProps {
  children: ReactNode
}

export function ResizableComputerRail({ children }: ResizableComputerRailProps) {
  const [width, setWidth] = useState(readStoredWidth)
  const widthRef = useRef(width)

  const resize = (nextWidth: number, persist = false) => {
    const clamped = clampWidth(nextWidth)
    widthRef.current = clamped
    setWidth(clamped)

    if (persist) {
      storeWidth(clamped)
    }
  }

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startWidth = widthRef.current
    const startX = event.clientX
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    let active = true

    try {
      handle.setPointerCapture?.(pointerId)
    } catch {
      // Synthetic pointer events do not always expose capture.
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      if (active) {
        resize(startWidth + startX - moveEvent.clientX)
      }
    }

    const finish = () => {
      if (!active) {
        return
      }

      active = false
      storeWidth(widthRef.current)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect

      try {
        handle.releasePointerCapture?.(pointerId)
      } catch {
        // The browser may already have released capture.
      }

      window.removeEventListener('pointermove', handleMove, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('blur', finish)
      handle.removeEventListener('lostpointercapture', finish)
    }

    window.addEventListener('pointermove', handleMove, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('blur', finish)
    handle.addEventListener('lostpointercapture', finish)
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null

    if (event.key === 'ArrowLeft') {
      nextWidth = widthRef.current + KEYBOARD_STEP
    } else if (event.key === 'ArrowRight') {
      nextWidth = widthRef.current - KEYBOARD_STEP
    } else if (event.key === 'Home') {
      nextWidth = MIN_WIDTH
    } else if (event.key === 'End') {
      nextWidth = MAX_WIDTH
    }

    if (nextWidth === null) {
      return
    }

    event.preventDefault()
    resize(nextWidth, true)
  }

  return (
    <aside className="relative h-full shrink-0 border-l border-(--ui-stroke-tertiary)" style={{ width: `${width}px` }}>
      <div
        aria-label="Resize computer details"
        aria-orientation="vertical"
        aria-valuemax={MAX_WIDTH}
        aria-valuemin={MIN_WIDTH}
        aria-valuenow={Math.round(width)}
        aria-valuetext={`${Math.round(width)} pixels`}
        className="group absolute inset-y-0 -left-1 z-80 w-2 cursor-col-resize touch-none select-none focus-visible:outline-none"
        onDoubleClick={() => resize(DEFAULT_WIDTH, true)}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
        role="separator"
        tabIndex={0}
      >
        <span className="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-(--ui-stroke-secondary) opacity-0 transition-opacity duration-100 group-hover:opacity-70 group-focus-visible:opacity-70" />
      </div>
      {children}
    </aside>
  )
}
