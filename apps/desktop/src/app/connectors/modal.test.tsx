import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ConnectorsModal } from './modal'
import { closeConnectors, openConnectors } from './store'

const gmail = {
  slug: 'gmail',
  name: 'Gmail',
  description: 'Mail',
  logo: null,
  category: 'Email',
  featured: true,
  isNoAuth: false
}

function renderModal() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ConnectorsModal />
    </I18nProvider>
  )
}

describe('ConnectorsModal', () => {
  const connectors = {
    keyStatus: vi.fn(),
    saveKey: vi.fn(),
    removeKey: vi.fn(),
    catalog: vi.fn(),
    categories: vi.fn(),
    connections: vi.fn(),
    authorize: vi.fn(),
    poll: vi.fn(),
    disconnect: vi.fn(),
    syncProfiles: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    connectors.keyStatus.mockResolvedValue({ configured: false, hint: null })
    connectors.catalog.mockResolvedValue({ items: [], nextCursor: null })
    connectors.categories.mockResolvedValue([])
    connectors.connections.mockResolvedValue([])
    connectors.syncProfiles.mockResolvedValue({ synced: 0, removed: 0, toolkits: [] })
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        connectors,
        openExternal: vi.fn(),
        api: vi.fn().mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'inbox' }] })
      }
    })
    openConnectors()
  })

  afterEach(() => {
    closeConnectors()
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('asks for a key on first run', async () => {
    renderModal()

    expect(await screen.findByLabelText('Composio API key')).toBeTruthy()
    expect(screen.getByText('Add a Composio key to browse and connect apps.')).toBeTruthy()
  })

  it('saves a key and then lists Composio apps', async () => {
    connectors.saveKey.mockResolvedValue({ configured: true, hint: '••••cret' })
    connectors.keyStatus
      .mockResolvedValueOnce({ configured: false, hint: null })
      .mockResolvedValue({ configured: true, hint: '••••cret' })
    connectors.catalog.mockResolvedValue({ items: [gmail], nextCursor: null })

    renderModal()
    fireEvent.change(await screen.findByLabelText('Composio API key'), { target: { value: 'ak_live_supersecret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(connectors.saveKey).toHaveBeenCalledWith('ak_live_supersecret'))
    expect(await screen.findByText('Gmail')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(screen.queryByDisplayValue('ak_live_supersecret')).toBeNull()
  })

  it('polls until connected and then syncs every bot', async () => {
    connectors.keyStatus.mockResolvedValue({ configured: true, hint: '••••cret' })
    connectors.catalog.mockResolvedValue({ items: [gmail], nextCursor: null })
    connectors.authorize.mockResolvedValue({ slug: 'gmail', status: 'pending', accountId: 'req-1', opened: true })
    connectors.poll.mockResolvedValue({ slug: 'gmail', status: 'connected', accountId: 'acc-1', opened: false })
    connectors.connections.mockResolvedValueOnce([]).mockResolvedValue([
      {
        slug: 'gmail',
        name: 'Gmail',
        description: '',
        logo: null,
        category: 'Connected',
        status: 'connected',
        accountId: 'acc-1',
        statusReason: null
      }
    ])

    renderModal()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(connectors.poll).toHaveBeenCalledWith('gmail'))
    await waitFor(() => expect(connectors.syncProfiles).toHaveBeenCalled())
  })

  it('disconnects a connected app from the same list', async () => {
    connectors.keyStatus.mockResolvedValue({ configured: true, hint: '••••cret' })
    connectors.catalog.mockResolvedValue({ items: [], nextCursor: null })
    connectors.connections.mockResolvedValue([
      {
        slug: 'slack',
        name: 'Slack',
        description: '',
        logo: null,
        category: 'Connected',
        status: 'connected',
        accountId: 'acc-2',
        statusReason: null
      }
    ])
    connectors.disconnect.mockResolvedValue({ slug: 'slack', status: 'disconnected' })

    renderModal()
    expect(await screen.findByText('Composio is connected')).toBeTruthy()
    expect(await screen.findByText('Slack')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(connectors.disconnect).toHaveBeenCalledWith('slack'))
  })
})
