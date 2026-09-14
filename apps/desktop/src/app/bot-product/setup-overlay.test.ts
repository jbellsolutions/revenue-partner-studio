import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getGlobalModelInfo } from '@/hermes'

import { BotSetupOverlay, createFirstBotProfile, firstBotSoul, formatBotSetupError } from './setup-overlay'

vi.mock('@/hermes', () => ({
  getGlobalModelInfo: vi.fn()
}))

vi.mock('@/lib/product', () => ({
  BOT_APP_NAME: 'Revenue Partner Studio',
  isBotProduct: () => true
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('first bot profile setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['openai-codex', 'gpt-5.6-sol'],
    ['xai-oauth', 'grok-4.6']
  ])('pins the connected %s model onto the created profile', async (provider, model) => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({ provider, model })
    const requestGateway = vi.fn().mockResolvedValue({})

    await expect(createFirstBotProfile('Research Assistant', requestGateway)).resolves.toEqual({
      model,
      name: 'research-assistant',
      provider
    })
    expect(requestGateway).toHaveBeenCalledWith('profiles.create', {
      name: 'research-assistant',
      description: 'Research Assistant',
      clone_from: null,
      no_skills: false,
      model,
      provider,
      soul: firstBotSoul('Research Assistant', 'research-assistant')
    })
    expect(firstBotSoul('Research Assistant', 'research-assistant')).toContain('that host is the bound Orgo computer')
  })

  it('does not create an unpinned-model profile when model resolution fails', async () => {
    vi.mocked(getGlobalModelInfo).mockResolvedValue({ provider: '', model: '' })
    const requestGateway = vi.fn().mockResolvedValue({})

    await expect(createFirstBotProfile('Assistant', requestGateway)).rejects.toThrow(
      /connected GPT or Grok model could not be resolved/
    )
    expect(requestGateway).not.toHaveBeenCalled()
  })
})

describe('bot setup overlay', () => {
  it('saves an existing computer binding before preparing its remote connection', async () => {
    const saveConfig = vi.fn().mockResolvedValue({})
    const saveKey = vi.fn()

    const provision = vi.fn().mockImplementation(() => {
      expect(saveConfig).toHaveBeenCalledWith({
        profile: 'default',
        apiKey: 'orgo-secret',
        computerId: '22222222-2222-4222-8222-222222222222'
      })

      return new Promise<never>(() => undefined)
    })

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        orgoDesktop: {
          provision, saveConfig, saveKey,
          status: vi.fn().mockResolvedValue({ apiKeySet: false, computerId: '' })
        }
      }
    })
    render(createElement(BotSetupOverlay, {
      enabled: true,
      requestGateway: async <T>() => ({} as T)
    }))
    fireEvent.change(screen.getByPlaceholderText('Orgo API key'), { target: { value: 'orgo-secret' } })
    fireEvent.change(screen.getByPlaceholderText('Leave blank to create a computer'), {
      target: { value: '22222222-2222-4222-8222-222222222222' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect existing computer' }))
    await screen.findByRole('status')
    expect(provision).toHaveBeenCalledOnce()
    expect(saveKey).not.toHaveBeenCalled()
  })

  it('exports a skippable overlay component', () => {
    expect(typeof BotSetupOverlay).toBe('function')
  })

  it('shows animated, explanatory progress while the cloud computer is prepared', async () => {
    const provision = new Promise<never>(() => undefined)

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        orgoDesktop: {
          provision: vi.fn().mockReturnValue(provision),
          saveKey: vi.fn().mockResolvedValue({}),
          status: vi.fn().mockResolvedValue({ apiKeySet: false, computerId: '' })
        }
      }
    })

    const view = render(
      createElement(BotSetupOverlay, {
        enabled: true,
        requestGateway: async <T>() => {
          return {} as T
        }
      })
    )

    fireEvent.change(screen.getByPlaceholderText('Orgo API key'), { target: { value: 'orgo-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create cloud computer' }))

    const progress = await screen.findByRole('status')

    expect(within(progress).getByText('Preparing your cloud computer')).toBeTruthy()
    expect(within(progress).getByText(/This can take a few minutes/)).toBeTruthy()
    expect(view.container.querySelector('.animate-spin')).toBeTruthy()
    expect(screen.getByPlaceholderText('Orgo API key').getAttribute('disabled')).not.toBeNull()
  })

  it('explains that an existing computer stays pinned during key recovery', async () => {
    const computerId = 'ef2f6e29-3864-494b-a82c-15280c5d9f9e'

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        orgoDesktop: {
          status: vi.fn().mockResolvedValue({ apiKeySet: false, computerId })
        }
      }
    })

    render(
      createElement(BotSetupOverlay, {
        enabled: true,
        requestGateway: async <T>() => {
          return {} as T
        }
      })
    )

    expect(await screen.findByText(/assigned to its Orgo computer/i)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Orgo API key'), { target: { value: 'replacement-key' } })
    expect(screen.getByRole('button', { name: 'Reconnect saved computer' })).toBeTruthy()
  })

  it('turns Electron context cancellation into an actionable retry message', () => {
    expect(
      formatBotSetupError(
        new Error(
          "Error invoking remote method 'hermes:orgo-desktop:tailscale:begin': OrgoDesktopError: context canceled"
        ),
        'Fallback'
      )
    ).toBe(
      'Your cloud computer is ready, but the private connection took too long to start. Try “Authorize cloud computer” again.'
    )
  })

  it('never dumps raw Tailscale status JSON into the onboarding card', () => {
    const rawStatus = JSON.stringify({
      AuthURL: '',
      BackendState: 'NeedsLogin',
      Self: { PublicKey: `nodekey:${'0'.repeat(64)}` }
    })

    expect(formatBotSetupError(new Error(rawStatus.repeat(20)), 'Fallback')).toBe(
      'Tailscale is installed on the cloud computer, but it did not provide a sign-in link. Try authorizing again.'
    )
  })
})
