import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { $gateway } from '@/store/gateway'
import { $gatewayState } from '@/store/session'

import { AgentThreads, ComputerWindows } from './workspace-controls'

const connectedGateway = { connectionState: 'open' } as HermesGateway
beforeEach(() => {
  $gateway.set(connectedGateway)
  $gatewayState.set('open')
})
afterEach(() => {
  cleanup()
  $gateway.set(null)
  $gatewayState.set('idle')
})

it('waits for both an open connection and a published gateway, then loads without waiting for the poll', async () => {
  $gateway.set(null)
  $gatewayState.set('connecting')
  const request = vi.fn().mockResolvedValue({ sessions: [{ id: 'operator-saved', title: 'Operator history' }] })
  render(<AgentThreads onCreateAgent={vi.fn()} onNewThread={vi.fn()} onOpenThread={vi.fn()} profile="default" request={request} />)
  expect(request).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Connecting')

  act(() => $gatewayState.set('open'))
  expect(request).not.toHaveBeenCalled()
  act(() => $gateway.set(connectedGateway))
  expect(await screen.findByText('Operator history')).toBeTruthy()
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('status')).toBeNull()
})

it('keeps cached rows during disconnect and refreshes immediately after reconnect', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ sessions: [{ id: 'saved', title: 'Saved before sleep' }] })
    .mockResolvedValue({ sessions: [{ id: 'saved', title: 'Updated after wake' }] })

  render(<AgentThreads onCreateAgent={vi.fn()} onNewThread={vi.fn()} onOpenThread={vi.fn()} profile="default" request={request} />)
  await screen.findByText('Saved before sleep')
  act(() => $gatewayState.set('closed'))
  expect(screen.getByText('Saved before sleep')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Connecting')
  expect(request).toHaveBeenCalledTimes(1)
  act(() => $gatewayState.set('open'))
  expect(await screen.findByText('Updated after wake')).toBeTruthy()
  expect(request).toHaveBeenCalledTimes(2)
})

it('ignores a request that settles after disconnect and retries on the next open gateway', async () => {
  let reject!: (reason: Error) => void

  const request = vi.fn()
    .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    .mockResolvedValue({ sessions: [{ id: 'recovered', title: 'Recovered history' }] })

  render(<AgentThreads onCreateAgent={vi.fn()} onNewThread={vi.fn()} onOpenThread={vi.fn()} profile="default" request={request} />)
  act(() => $gatewayState.set('closed'))
  await act(async () => reject(new Error('Old disconnected request')))
  expect(screen.queryByRole('alert')).toBeNull()
  act(() => $gatewayState.set('open'))
  expect(await screen.findByText('Recovered history')).toBeTruthy()
})

it('loads saved threads for the selected agent and opens the durable id with its owner', async () => {
  const request = vi.fn().mockResolvedValue({ sessions: [{ id: 'saved-one', title: 'Research' }] })
  const open = vi.fn().mockResolvedValue(undefined)
  const newThread = vi.fn()
  render(
    <AgentThreads
      onCreateAgent={() => {}}
      onNewThread={newThread}
      onOpenThread={open}
      profile="researcher"
      request={request}
    />
  )
  fireEvent.click(await screen.findByText('Research'))
  expect(open).toHaveBeenCalledWith('researcher', 'saved-one')
  expect(request).toHaveBeenCalledWith('session.list', { profile: 'researcher', limit: 100 })
  fireEvent.click(screen.getByText('New thread'))
  expect(newThread).toHaveBeenCalledWith('researcher')
})

it('never paints a previous agent’s delayed response after switching', async () => {
  let finish!: (value: { sessions: { id: string; title: string }[] }) => void

  const request = vi.fn().mockImplementation((_method, params) =>
    params.profile === 'one'
      ? new Promise(resolve => {
          finish = resolve
        })
      : Promise.resolve({ sessions: [{ id: 'two-id', title: 'Private two' }] })
  )

  const props = { request, onOpenThread: vi.fn(), onNewThread: vi.fn(), onCreateAgent: vi.fn() }
  const view = render(<AgentThreads {...props} profile="one" />)
  view.rerender(<AgentThreads {...props} profile="two" />)
  await screen.findByText('Private two')
  finish({ sessions: [{ id: 'one-id', title: 'Private one' }] })
  await waitFor(() => expect(screen.queryByText('Private one')).toBeNull())
  expect(screen.getByText('Private two')).toBeTruthy()
})

it('shows launch failures and does not retarget the current computer', async () => {
  const openInstance = vi.fn().mockRejectedValue(new Error('Unable to open window'))
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      orgoDesktop: {
        listInstances: vi
          .fn()
          .mockResolvedValue([{ name: 'research', computerId: 'computer-two', current: false, unreadable: false }]),
        openInstance
      }
    }
  })
  render(<ComputerWindows />)
  fireEvent.click(await screen.findByText('research · computer-two'))
  expect(openInstance).toHaveBeenCalledWith('research')
  expect((await screen.findByRole('alert')).textContent).toContain('Unable to open window')
})

it('refreshes current windows and live names without changing their computer bindings', async () => {
  const listInstances = vi.fn().mockResolvedValueOnce([
    { name: 'old-window', computerId: 'old', current: false, unreadable: false }
  ]).mockResolvedValue([
    { name: 'revenue', computerId: 'same-id', current: false, unreadable: false,
      cloudName: 'Revenue Partner', cloudStatus: 'running', availability: 'available' },
    { name: 'removed', computerId: 'removed-id', current: false, unreadable: false, availability: 'missing' }
  ])

  const openInstance = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true, value: { orgoDesktop: { listInstances, openInstance } }
  })
  render(<ComputerWindows />)
  await screen.findByText('old-window · old')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh computers' }))
  expect(await screen.findByText('revenue · Revenue Partner · running')).toBeTruthy()
  expect(screen.queryByText('old-window · old')).toBeNull()
  expect(screen.getByText('removed · removed-id · Not found or no access')).toBeTruthy()
  expect(listInstances).toHaveBeenLastCalledWith(true)
  expect(openInstance).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('revenue · Revenue Partner · running'))
  await waitFor(() => expect(openInstance).toHaveBeenCalledWith('revenue'))
})

it('keeps saved windows when refresh fails and allows a retry', async () => {
  const rows = [{ name: 'saved', computerId: 'same-id', current: false, unreadable: false }]

  const listInstances = vi.fn().mockResolvedValueOnce(rows)
    .mockRejectedValueOnce(new Error('Refresh unavailable'))
    .mockResolvedValue(rows)

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true, value: { orgoDesktop: { listInstances, openInstance: vi.fn() } }
  })
  render(<ComputerWindows />)
  await screen.findByText('saved · same-id')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh computers' }))
  expect(await screen.findByText('Refresh unavailable')).toBeTruthy()
  expect(screen.getByText('saved · same-id')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh computers' }))
  await waitFor(() => expect(screen.queryByText('Refresh unavailable')).toBeNull())
  expect(listInstances).toHaveBeenLastCalledWith(true)
})

it('shows a failed thread open and re-enables the saved thread for retry', async () => {
  const request = vi.fn().mockResolvedValue({ sessions: [{ id: 'a2a_share_saved', title: 'Received history' }] })
  const open = vi.fn().mockRejectedValueOnce(new Error('Receiver is unreachable')).mockResolvedValue(undefined)
  render(
    <AgentThreads
      onCreateAgent={vi.fn()}
      onNewThread={vi.fn()}
      onOpenThread={open}
      profile="receiver"
      request={request}
    />
  )
  const thread = await screen.findByRole('button', { name: 'Received history' })
  fireEvent.click(thread)
  expect((await screen.findByRole('alert')).textContent).toContain('Receiver is unreachable')
  await waitFor(() => expect((thread as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(thread)
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
  expect(open).toHaveBeenLastCalledWith('receiver', 'a2a_share_saved')
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

it('sets a launch default without opening or rebinding either computer', async () => {
  const setDefaultInstance = vi.fn().mockResolvedValue({instance:'market'})
  const openInstance = vi.fn()
  const listInstances = vi.fn().mockResolvedValue([{name:'market',computerId:'market-computer',cloudName:'Market team',current:true,unreadable:false,isDefault:false}])
  Object.defineProperty(window,'hermesDesktop',{configurable:true,value:{orgoDesktop:{listInstances,openInstance,setDefaultInstance}}})
  render(<ComputerWindows />)
  fireEvent.click(await screen.findByRole('button',{name:'Make Market team default'}))
  await waitFor(()=>expect(setDefaultInstance).toHaveBeenCalledWith('market'))
  expect(openInstance).not.toHaveBeenCalled()
})
