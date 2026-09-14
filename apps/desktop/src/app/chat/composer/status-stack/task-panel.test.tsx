import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { TodoItem } from '@/lib/todos'
import { $todosBySession, setSessionTodos } from '@/store/todos'

import { ComposerStatusStack } from './index'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)

const SID = 'sess-task-1'

const todo = (id: string, status: TodoItem['status'], content = `task ${id}`): TodoItem => ({
  content,
  id,
  status
})

function renderStack(sessionId: null | string = SID) {
  return render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="en">
        <ComposerStatusStack queue={null} sessionId={sessionId} />
      </I18nProvider>
    </MemoryRouter>
  )
}

describe('ComposerStatusStack task checklist', () => {
  beforeEach(() => {
    $todosBySession.set({})
  })

  afterEach(() => {
    cleanup()
    $todosBySession.set({})
    vi.useRealTimers()
  })

  it('renders nothing when the session has no tasks', () => {
    const view = renderStack()

    expect(view.container.firstChild).toBeNull()
  })

  it('shows the compact task header with tabular progress and segmented rail', () => {
    setSessionTodos(SID, [todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'pending')])

    const view = renderStack()

    expect(screen.getByText('Tasks')).toBeTruthy()
    expect(screen.getByText('1 of 3')).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
    expect(view.container.querySelector('[data-variant="task"]')).toBeTruthy()
    expect(view.container.querySelector('.codicon-checklist')).toBeNull()
  })

  it('keeps the task card detached from the composer surface', () => {
    setSessionTodos(SID, [todo('a', 'in_progress')])

    const view = renderStack()
    const stack = view.container.querySelector('[data-slot="composer-status-stack"]')
    const card = view.container.querySelector('[data-slot="composer-status-card"]')

    expect(stack?.getAttribute('data-layout')).toBe('detached')
    expect(card?.className).toContain('mb-2')
    expect(card?.className).toContain('rounded-2xl')
  })

  it('labels each task row with its semantic state', () => {
    setSessionTodos(SID, [
      todo('a', 'completed', 'ship checklist polish'),
      todo('b', 'in_progress', 'verify responsive states'),
      todo('c', 'pending', 'run desktop typecheck')
    ])

    renderStack()

    expect(screen.getByText('ship checklist polish').closest('[data-task-state="completed"]')).toBeTruthy()
    expect(screen.getByText('verify responsive states').closest('[data-task-state="in_progress"]')).toBeTruthy()
    expect(screen.getByText('run desktop typecheck').closest('[data-task-state="pending"]')).toBeTruthy()
  })

  it('marks the active segment in the progress rail', () => {
    setSessionTodos(SID, [todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'pending')])

    const view = renderStack()

    const segments = view.container.querySelectorAll('[data-slot="task-progress-rail"] [data-segment]')

    expect(segments).toHaveLength(3)
    expect(segments[0]?.getAttribute('data-segment')).toBe('completed')
    expect(segments[1]?.getAttribute('data-segment')).toBe('active')
    expect(segments[2]?.getAttribute('data-segment')).toBe('pending')
  })

  it('collapses and expands the task list from the header', () => {
    setSessionTodos(SID, [todo('a', 'pending', 'first task')])

    renderStack()

    expect(screen.getByText('first task')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Tasks/i }))

    expect(screen.queryByText('first task')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Tasks/i }))

    expect(screen.getByText('first task')).toBeTruthy()
  })

  it('scopes the checklist to the task-owning session', () => {
    setSessionTodos('other-session', [todo('a', 'pending', 'other task')])

    const view = renderStack()

    expect(view.container.firstChild).toBeNull()
  })
})
