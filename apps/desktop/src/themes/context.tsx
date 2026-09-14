/**
 * Desktop theme context.
 *
 * Applies the active theme as CSS custom properties on :root so every
 * Tailwind utility that references a color or font-family token picks up
 * the change automatically.
 *
 * Mode (light/dark/system) controls brightness; skin controls accent.
 * The two are persisted independently. Shift+X toggles light/dark.
 */

import { useStore } from '@nanostores/react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { $registryVersion } from '@/contrib/registry'
import { matchesQuery, useMediaQuery } from '@/hooks/use-media-query'
import { persistString, persistStringRecord, storedString, storedStringRecord } from '@/lib/storage'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

import { $backendThemes, $pendingSkinApply } from './backend-sync'
import { hexToRgb, mix, readableOn } from './color'
import { BUILTIN_THEME_LIST, DEFAULT_SKIN_NAME, DEFAULT_TYPOGRAPHY, orgoTheme } from './presets'
import type { DesktopTheme, DesktopThemeColors } from './types'
import { $userThemes, listAllThemes, resolveTheme } from './user-themes'

// Legacy global skin (pre per-profile themes). Still the inheritance fallback
// for any profile without its own assignment after the one-time Orgo reset.
const SKIN_KEY = 'hermes-desktop-theme-v2'
const MODE_KEY = 'hermes-desktop-mode-v1'
// Per-profile skin + light/dark mode assignments: { [profileKey]: value }. A
// profile inherits the global default until it's given its own appearance.
const PROFILE_SKINS_KEY = 'hermes-desktop-profile-themes-v1'
const PROFILE_MODES_KEY = 'hermes-desktop-profile-modes-v1'
// Last active profile, recorded so the boot-time paint can pick that profile's
// theme before the gateway reports which profile actually launched.
const LAST_PROFILE_KEY = 'hermes-desktop-active-profile-v1'
// Product-wide visual reset: existing installs may have any legacy Hermes
// palette persisted. Move each install to Orgo Black exactly once; choices made
// after this migration remain user-owned.
const ORGO_BLACK_MIGRATION_KEY = 'hermes-orgo-black-migration-v1'
const RETIRED_SKINS = new Set(['nous', 'nous-light', 'default', 'gold'])

export type ThemeMode = 'light' | 'dark' | 'system'

const INJECTED_FONT_URLS = new Set<string>()

const resolveMode = (mode: ThemeMode, systemDark = matchesQuery('(prefers-color-scheme: dark)')): 'light' | 'dark' =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

const normalizeSkin = (name: string | null): string =>
  name && resolveTheme(name) && !RETIRED_SKINS.has(name) ? name : DEFAULT_SKIN_NAME

const normalizeMode = (value: string | null): ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'dark'

// ─── Per-profile appearance persistence ─────────────────────────────────────
// Skin and mode are each stored per profile. "default" isn't a real profile —
// it *is* the legacy global slot, so it reads/writes the global directly. Named
// profiles get their own entry and fall back to that global until assigned, so
// unassigned profiles and pre-per-profile installs stay on the global value.
const profilePref = <T extends string>(record: string, legacy: string, normalize: (v: string | null) => T) => ({
  resolve: (profile: string): T => normalize(storedStringRecord(record)[profile] ?? storedString(legacy)),
  assign: (profile: string, value: T): void => {
    if (profile === 'default') {
      persistString(legacy, value)
    } else {
      persistStringRecord(record, { ...storedStringRecord(record), [profile]: value })
    }
  }
})

export const skinPref = profilePref(PROFILE_SKINS_KEY, SKIN_KEY, normalizeSkin)
export const modePref = profilePref(PROFILE_MODES_KEY, MODE_KEY, normalizeMode)

const ensureOrgoBlackMigration = (): void => {
  if (typeof window === 'undefined' || storedString(ORGO_BLACK_MIGRATION_KEY) === '1') {
    return
  }

  persistString(SKIN_KEY, DEFAULT_SKIN_NAME)
  persistString(MODE_KEY, 'dark')
  persistStringRecord(PROFILE_SKINS_KEY, {})
  persistStringRecord(PROFILE_MODES_KEY, {})
  persistString(ORGO_BLACK_MIGRATION_KEY, '1')
}

/** Everything a peer window could change that this one has to repaint for. */
const APPEARANCE_KEYS = new Set([SKIN_KEY, PROFILE_SKINS_KEY, MODE_KEY, PROFILE_MODES_KEY])

// Last active profile — lets the boot paint pick its appearance before the
// gateway reports which profile actually launched.
const readBootProfileKey = () => normalizeProfileKey(storedString(LAST_PROFILE_KEY))
const rememberActiveProfileKey = (profile: string) => persistString(LAST_PROFILE_KEY, profile)

// ─── Color math (for synthesised light variants of dark-only skins) ────────
// hexToRgb / mix / readableOn live in ./color so the VS Code converter shares
// the exact same math.

function synthLightColors(seed: DesktopTheme): DesktopThemeColors {
  const accent = seed.colors.ring || seed.colors.primary
  const soft = mix('#ffffff', accent, 0.1)
  const softer = mix('#ffffff', accent, 0.06)
  const border = mix('#ececef', accent, 0.14)
  const midground = seed.colors.midground ?? accent

  return {
    background: '#ffffff',
    foreground: '#161616',
    card: '#ffffff',
    cardForeground: '#161616',
    muted: softer,
    mutedForeground: mix('#6b6b70', accent, 0.16),
    popover: '#ffffff',
    popoverForeground: '#161616',
    primary: accent,
    primaryForeground: readableOn(accent),
    secondary: soft,
    secondaryForeground: mix('#2a2a2a', accent, 0.34),
    accent: soft,
    accentForeground: mix('#2a2a2a', accent, 0.34),
    border,
    input: mix('#e2e2e6', accent, 0.18),
    ring: accent,
    midground,
    midgroundForeground: readableOn(midground),
    destructive: '#b94a3a',
    destructiveForeground: '#ffffff',
    sidebarBackground: mix('#fafafa', accent, 0.05),
    sidebarBorder: border,
    userBubble: soft,
    userBubbleBorder: border
  }
}

/** Returns the seed palette for a given skin + mode (no overrides applied). */
export function getBaseColors(skinName: string, mode: 'light' | 'dark'): DesktopThemeColors {
  const seed = resolveTheme(skinName) ?? orgoTheme

  if (mode === 'dark') {
    return seed.darkColors ?? seed.colors
  }

  return seed.darkColors ? seed.colors : synthLightColors(seed)
}

function deriveTheme(skinName: string, mode: 'light' | 'dark'): DesktopTheme {
  const seed = resolveTheme(skinName) ?? orgoTheme

  return {
    ...seed,
    name: `${skinName}-${mode}`,
    label: `${seed.label} ${mode === 'light' ? 'Light' : 'Dark'}`,
    description: `${seed.label} ${mode} palette`,
    colors: getBaseColors(skinName, mode)
  }
}

/**
 * Some palettes intentionally keep a bright background even when
 * `mode === 'dark'`, so we shouldn't apply the `.dark` class. Decide from
 * the actual background luminance.
 */
function renderedModeFor(colors: DesktopThemeColors, mode: 'light' | 'dark'): 'light' | 'dark' {
  const rgb = hexToRgb(colors.background)

  if (!rgb) {
    return mode
  }

  const [r, g, b] = rgb.map(v => v / 255)

  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

// ─── CSS application ────────────────────────────────────────────────────────

// Per-mode mix knobs. Light/dark fallbacks live in styles.css `:root` /
// `:root.dark`; setting them inline keeps active-skin overrides surviving
// the boot-time paint.
// styles.css --theme-neutral-chrome — keep in sync.
const NEUTRAL_CHROME = { light: '#f3f3f3', dark: '#0d0d0e' } as const

const chromeBackground = (background: string, isDark: boolean) =>
  mix(background, NEUTRAL_CHROME[isDark ? 'dark' : 'light'], isDark ? 0.26 : 0.08)

// Orgo Black is an exact product surface contract rather than a seed that gets
// remixed by the legacy glass theme. Keep these lists centralized so switching
// skin/mode can remove every inline override before applying the next palette.
const ORGO_DARK_PALETTE: Record<string, string> = {
  '--orgo-app': '#070707',
  '--orgo-panel': '#111111',
  '--orgo-raised': '#2f2f2f',
  '--orgo-raised-hover': '#3d3d3d',
  '--orgo-card': '#262626',
  '--orgo-inset': '#191919',
  '--orgo-hairline': '#333333',
  '--orgo-ink': '#fcfcfc',
  '--orgo-ink-secondary': 'rgb(252 252 252 / 60%)'
}

const ORGO_LIGHT_PALETTE: Record<string, string> = {
  '--orgo-app': '#f7f7f7',
  '--orgo-panel': '#efefef',
  '--orgo-raised': '#e1e1e1',
  '--orgo-raised-hover': '#d6d6d6',
  '--orgo-card': '#ffffff',
  '--orgo-inset': '#eeeeee',
  '--orgo-hairline': '#d6d6d6',
  '--orgo-ink': '#171717',
  '--orgo-ink-secondary': 'rgb(23 23 23 / 60%)'
}

const ORGO_DARK_SURFACE_OVERRIDES: Record<string, string> = {
  '--ui-bg-chrome': 'var(--orgo-app)',
  '--ui-bg-sidebar': 'var(--orgo-panel)',
  '--ui-bg-editor': 'var(--orgo-app)',
  '--ui-bg-elevated': 'var(--orgo-inset)',
  '--ui-bg-card': 'var(--orgo-card)',
  '--ui-bg-input': 'var(--orgo-inset)',
  '--ui-bg-primary': 'var(--orgo-raised)',
  '--ui-bg-secondary': 'var(--orgo-card)',
  '--ui-bg-tertiary': '#202020',
  '--ui-bg-quaternary': 'var(--orgo-inset)',
  '--ui-bg-quinary': '#141414',
  '--ui-row-hover-background': '#1c1c1c',
  '--ui-row-active-background': 'var(--orgo-card)',
  '--ui-control-hover-background': 'var(--orgo-card)',
  '--ui-control-active-background': 'var(--orgo-raised)',
  '--ui-text-primary': 'var(--orgo-ink)',
  '--ui-text-secondary': 'var(--orgo-ink-secondary)',
  '--ui-text-tertiary': 'rgb(252 252 252 / 46%)',
  '--ui-text-quaternary': 'rgb(252 252 252 / 30%)',
  '--ui-stroke-primary': 'var(--orgo-hairline)',
  '--ui-stroke-secondary': 'rgb(51 51 51 / 72%)',
  '--ui-stroke-tertiary': 'rgb(51 51 51 / 42%)',
  '--ui-stroke-quaternary': 'rgb(51 51 51 / 22%)',
  '--ui-sash-hover-border': 'var(--orgo-raised-hover)',
  '--ui-sash-hover-background': 'rgb(61 61 61 / 22%)',
  '--ui-surface-background': 'var(--orgo-app)',
  '--ui-sidebar-surface-background': 'var(--orgo-panel)',
  '--ui-chat-surface-background': 'var(--orgo-app)',
  '--ui-editor-surface-background': 'var(--orgo-app)',
  '--ui-terminal-surface-background': 'var(--orgo-app)',
  '--ui-widget-surface-background': 'var(--orgo-inset)',
  '--ui-panel-background': 'var(--orgo-inset)',
  '--ui-chat-bubble-background': 'var(--orgo-inset)',
  '--ui-chat-bubble-opaque-background': 'var(--orgo-inset)',
  '--ui-assistant-message-background': 'var(--orgo-card)',
  '--ui-user-message-background': '#5a5a5a',
  '--ui-user-message-hover-background': '#646464',
  '--dt-background': 'var(--orgo-app)',
  '--dt-foreground': 'var(--orgo-ink)',
  '--dt-card': 'var(--orgo-panel)',
  '--dt-card-foreground': 'var(--orgo-ink)',
  '--dt-muted': 'var(--orgo-inset)',
  '--dt-muted-foreground': 'var(--orgo-ink-secondary)',
  '--dt-popover': 'var(--orgo-inset)',
  '--dt-popover-foreground': 'var(--orgo-ink)',
  '--dt-primary': 'var(--orgo-ink)',
  '--dt-primary-foreground': 'var(--orgo-app)',
  '--dt-secondary': 'var(--orgo-card)',
  '--dt-secondary-foreground': 'var(--orgo-ink-secondary)',
  '--dt-accent': 'var(--orgo-raised)',
  '--dt-accent-foreground': 'var(--orgo-ink)',
  '--dt-border': 'var(--orgo-hairline)',
  '--dt-input': 'var(--orgo-hairline)',
  '--dt-ring': '#8a8a8a',
  '--dt-composer-ring': 'var(--orgo-hairline)',
  '--dt-sidebar-bg': 'var(--orgo-panel)',
  '--dt-sidebar-border': '#202020',
  '--dt-user-bubble': '#5a5a5a',
  '--dt-user-bubble-border': '#686868',
  '--sidebar-edge-border': '#1e1e1e',
  '--chrome-action-hover': 'var(--orgo-raised-hover)',
  '--composer-fill': 'var(--orgo-raised)',
  '--noise-opacity-mul': '0'
}

// Light Orgo keeps the same surface roles as dark, with ink/paper flipped so
// Cmd+K, dialogs, plugin menus, and chat share one readable contract.
const ORGO_LIGHT_SURFACE_OVERRIDES: Record<string, string> = {
  '--ui-bg-chrome': 'var(--orgo-app)',
  '--ui-bg-sidebar': 'var(--orgo-panel)',
  '--ui-bg-editor': 'var(--orgo-app)',
  '--ui-bg-elevated': 'var(--orgo-card)',
  '--ui-bg-card': 'var(--orgo-card)',
  '--ui-bg-input': 'var(--orgo-card)',
  '--ui-bg-primary': 'var(--orgo-raised)',
  '--ui-bg-secondary': 'var(--orgo-inset)',
  '--ui-bg-tertiary': '#e8e8e8',
  '--ui-bg-quaternary': 'var(--orgo-inset)',
  '--ui-bg-quinary': '#f0f0f0',
  '--ui-row-hover-background': '#e8e8e8',
  '--ui-row-active-background': 'var(--orgo-raised)',
  '--ui-control-hover-background': 'var(--orgo-raised)',
  '--ui-control-active-background': 'var(--orgo-raised)',
  '--ui-text-primary': 'var(--orgo-ink)',
  '--ui-text-secondary': 'var(--orgo-ink-secondary)',
  '--ui-text-tertiary': 'rgb(23 23 23 / 46%)',
  '--ui-text-quaternary': 'rgb(23 23 23 / 30%)',
  '--ui-stroke-primary': 'var(--orgo-hairline)',
  '--ui-stroke-secondary': 'rgb(214 214 214 / 90%)',
  '--ui-stroke-tertiary': 'rgb(214 214 214 / 70%)',
  '--ui-stroke-quaternary': 'rgb(214 214 214 / 45%)',
  '--ui-sash-hover-border': 'var(--orgo-raised-hover)',
  '--ui-sash-hover-background': 'rgb(23 23 23 / 6%)',
  '--ui-surface-background': 'var(--orgo-app)',
  '--ui-sidebar-surface-background': 'var(--orgo-panel)',
  '--ui-chat-surface-background': 'var(--orgo-app)',
  '--ui-editor-surface-background': 'var(--orgo-app)',
  '--ui-terminal-surface-background': 'var(--orgo-app)',
  '--ui-widget-surface-background': 'var(--orgo-card)',
  '--ui-panel-background': 'var(--orgo-card)',
  '--ui-chat-bubble-background': 'var(--orgo-card)',
  '--ui-chat-bubble-opaque-background': 'var(--orgo-card)',
  '--ui-assistant-message-background': 'var(--orgo-card)',
  '--ui-user-message-background': '#e3e3e3',
  '--ui-user-message-hover-background': '#d8d8d8',
  '--dt-background': 'var(--orgo-app)',
  '--dt-foreground': 'var(--orgo-ink)',
  '--dt-card': 'var(--orgo-panel)',
  '--dt-card-foreground': 'var(--orgo-ink)',
  '--dt-muted': 'var(--orgo-inset)',
  '--dt-muted-foreground': 'var(--orgo-ink-secondary)',
  '--dt-popover': 'var(--orgo-card)',
  '--dt-popover-foreground': 'var(--orgo-ink)',
  '--dt-primary': 'var(--orgo-ink)',
  '--dt-primary-foreground': 'var(--orgo-app)',
  '--dt-secondary': 'var(--orgo-inset)',
  '--dt-secondary-foreground': 'var(--orgo-ink-secondary)',
  '--dt-accent': 'var(--orgo-raised)',
  '--dt-accent-foreground': 'var(--orgo-ink)',
  '--dt-border': 'var(--orgo-hairline)',
  '--dt-input': 'var(--orgo-hairline)',
  '--dt-ring': '#666666',
  '--dt-composer-ring': 'var(--orgo-hairline)',
  '--dt-sidebar-bg': 'var(--orgo-panel)',
  '--dt-sidebar-border': '#d8d8d8',
  '--dt-user-bubble': '#e3e3e3',
  '--dt-user-bubble-border': '#d0d0d0',
  '--sidebar-edge-border': '#d8d8d8',
  '--chrome-action-hover': 'var(--orgo-raised-hover)',
  '--composer-fill': 'var(--orgo-card)',
  '--noise-opacity-mul': '0'
}

const ORGO_SURFACE_OVERRIDE_KEYS = Array.from(
  new Set([...Object.keys(ORGO_DARK_SURFACE_OVERRIDES), ...Object.keys(ORGO_LIGHT_SURFACE_OVERRIDES)])
)

const ORGO_PALETTE_KEYS = Object.keys(ORGO_DARK_PALETTE)

const mixesFor = (isDark: boolean): Record<string, string> => ({
  '--theme-mix-chrome': isDark ? '74%' : '92%',
  '--theme-mix-sidebar': '100%',
  '--theme-mix-card': isDark ? '38%' : '22%',
  '--theme-mix-elevated': isDark ? '46%' : '28%',
  '--theme-mix-bubble': isDark ? '46%' : '0%'
})

function applyTheme(theme: DesktopTheme, mode: 'light' | 'dark') {
  if (typeof document === 'undefined') {
    return
  }

  const root = document.documentElement
  const c = theme.colors
  const typo = { ...DEFAULT_TYPOGRAPHY, ...theme.typography }
  const rendered = renderedModeFor(c, mode)
  const isDark = rendered === 'dark'
  const midground = c.midground ?? c.ring
  const skinName = theme.name.endsWith(`-${mode}`) ? theme.name.slice(0, -mode.length - 1) : theme.name
  const usesOrgoSurfaces = skinName === 'orgo'

  const orgoSurfaceOverrides = usesOrgoSurfaces
    ? isDark
      ? ORGO_DARK_SURFACE_OVERRIDES
      : ORGO_LIGHT_SURFACE_OVERRIDES
    : null

  const orgoPalette = usesOrgoSurfaces ? (isDark ? ORGO_DARK_PALETTE : ORGO_LIGHT_PALETTE) : null

  for (const key of ORGO_SURFACE_OVERRIDE_KEYS) {
    root.style.removeProperty(key)
  }

  for (const key of ORGO_PALETTE_KEYS) {
    root.style.removeProperty(key)
  }

  root.style.setProperty('color-scheme', rendered)
  root.dataset.hermesTheme = skinName
  root.dataset.hermesMode = rendered
  root.classList.toggle('dark', isDark)

  // Brand seeds feed every glass + shadcn token via `color-mix()` in styles.css.
  const seeds: Record<string, string> = {
    '--theme-foreground': c.foreground,
    '--theme-primary': c.primary,
    '--theme-secondary': c.secondary,
    '--theme-accent-soft': c.accent,
    '--theme-midground': midground,
    '--theme-warm': c.primary,
    '--theme-background-seed': c.background,
    '--theme-sidebar-seed': c.sidebarBackground ?? c.background,
    '--theme-card-seed': c.card,
    '--theme-elevated-seed': c.popover,
    '--theme-bubble-seed': c.userBubble ?? c.popover,
    '--theme-neutral-chrome': NEUTRAL_CHROME[isDark ? 'dark' : 'light'],
    '--theme-neutral-sidebar': isDark ? '#0a0a0b' : '#f3f3f3',
    '--theme-neutral-card': isDark ? '#161618' : '#ffffff'
  }

  // shadcn/Tailwind tokens that aren't derived from the seed chain.
  const palette: Record<string, string> = {
    '--dt-primary-foreground': c.primaryForeground,
    '--dt-secondary-foreground': c.secondaryForeground,
    '--dt-accent-foreground': c.accentForeground,
    '--dt-border': c.border,
    '--dt-input': c.input,
    '--dt-ring': c.ring,
    '--dt-muted': c.muted,
    '--dt-midground-foreground': c.midgroundForeground ?? readableOn(midground),
    '--dt-composer-ring': c.composerRing ?? midground,
    '--dt-destructive': c.destructive,
    '--dt-destructive-foreground': c.destructiveForeground,
    '--dt-sidebar-border': c.sidebarBorder ?? c.border,
    '--dt-user-bubble-border': c.userBubbleBorder ?? c.border,
    '--dt-font-sans': typo.fontSans,
    '--dt-font-mono': typo.fontMono,
    '--noise-opacity-mul': isDark ? 'calc(0.04 / 0.21)' : 'calc(0.34 / 0.21)'
  }

  for (const [k, v] of Object.entries({ ...seeds, ...mixesFor(isDark), ...palette })) {
    root.style.setProperty(k, v)
  }

  if (orgoPalette) {
    for (const [key, value] of Object.entries(orgoPalette)) {
      root.style.setProperty(key, value)
    }
  }

  if (orgoSurfaceOverrides) {
    for (const [key, value] of Object.entries(orgoSurfaceOverrides)) {
      root.style.setProperty(key, value)
    }
  }

  const chromeBg = usesOrgoSurfaces ? c.background : chromeBackground(c.background, isDark)

  window.hermesDesktop?.setTitleBarTheme?.({
    background: chromeBg,
    foreground: c.foreground
  })

  // Raw (non-JSON) keys read by the inline pre-paint script in index.html —
  // they let a brand-new window paint the themed background on its very first
  // frame, before this module has even loaded.
  try {
    window.localStorage.setItem('hermes-boot-background', chromeBg)
    window.localStorage.setItem('hermes-boot-color-scheme', rendered)
  } catch {
    // Storage may be unavailable (private mode / quota); the inline script
    // falls back to prefers-color-scheme.
  }

  if (typo.fontUrl && !INJECTED_FONT_URLS.has(typo.fontUrl)) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = typo.fontUrl
    link.dataset.hermesThemeFont = 'true'
    document.head.appendChild(link)
    INJECTED_FONT_URLS.add(typo.fontUrl)
  }
}

// Pin Electron's nativeTheme to the app's mode so the NATIVE window chrome
// (macOS vibrancy material, titlebar, pre-paint background) matches the app
// theme instead of the OS appearance. An explicit light/dark pick is forced;
// 'system' stays 'system' so prefers-color-scheme keeps tracking the OS.
const syncNativeTheme = (pref: ThemeMode, rendered: 'light' | 'dark') =>
  window.hermesDesktop?.setNativeTheme?.(pref === 'system' ? 'system' : rendered)

// Boot-time paint to avoid a flash before <ThemeProvider> mounts. Use the last
// active profile's appearance so a non-default profile relaunch paints its own
// skin + light/dark mode.
if (typeof window !== 'undefined') {
  ensureOrgoBlackMigration()
  const profile = readBootProfileKey()
  const pref = modePref.resolve(profile)
  const resolved = resolveMode(pref)
  const theme = deriveTheme(skinPref.resolve(profile), resolved)
  applyTheme(theme, resolved)
  syncNativeTheme(pref, renderedModeFor(theme.colors, resolved))
}

// ─── Context ────────────────────────────────────────────────────────────────

interface ThemeContextValue {
  theme: DesktopTheme
  themeName: string
  mode: ThemeMode
  /** The light/dark switch the user picked. */
  resolvedMode: 'light' | 'dark'
  /**
   * The mode actually painted, derived from the active background's luminance.
   * Differs from `resolvedMode` for skins that keep a bright surface in "dark"
   * (or vice-versa). Surface-bound UI (e.g. the terminal palette) should key off
   * this so it matches what's on screen instead of inverting.
   */
  renderedMode: 'light' | 'dark'
  availableThemes: Array<{ name: string; label: string; description: string }>
  setTheme: (name: string) => void
  setMode: (mode: ThemeMode) => void
}

const SKIN_LIST = BUILTIN_THEME_LIST.map(({ name, label, description }) => ({ name, label, description }))

const ThemeContext = createContext<ThemeContextValue>({
  theme: orgoTheme,
  themeName: DEFAULT_SKIN_NAME,
  mode: 'dark',
  resolvedMode: 'dark',
  renderedMode: 'dark',
  availableThemes: SKIN_LIST,
  setTheme: () => {},
  setMode: () => {}
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Skin + mode are assigned per profile; the active profile drives which
  // appearance shows. Single-profile users only ever see "default", so their
  // behavior is unchanged.
  const profileKey = normalizeProfileKey(useStore($activeGatewayProfile))

  // Built-ins + user-installed + registry-contributed themes. Reactive so an
  // import or a plugin registration shows up live in the palette, settings
  // grid, and `/skin` without a reload.
  const userThemes = useStore($userThemes)
  const backendThemes = useStore($backendThemes)
  const registryVersion = useStore($registryVersion)

  const availableThemes = useMemo(
    () =>
      listAllThemes().map(({ name, label, description }) => ({
        name,
        label,
        description
      })),
    // userThemes + backendThemes + registryVersion ARE listAllThemes' reactivity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userThemes, backendThemes, registryVersion]
  )

  const [themeName, setThemeNameState] = useState(() =>
    typeof window === 'undefined'
      ? DEFAULT_SKIN_NAME
      : (ensureOrgoBlackMigration(), skinPref.resolve(readBootProfileKey()))
  )

  const [mode, setModeState] = useState<ThemeMode>(() =>
    typeof window === 'undefined' ? 'dark' : (ensureOrgoBlackMigration(), modePref.resolve(readBootProfileKey()))
  )

  // Follow profile switches: paint the profile's assigned skin + mode and
  // remember it for the next boot's first paint.
  useEffect(() => {
    rememberActiveProfileKey(profileKey)
    setThemeNameState(skinPref.resolve(profileKey))
    setModeState(modePref.resolve(profileKey))
  }, [profileKey])

  // Appearance is per-profile localStorage, and every desktop window is another
  // renderer on the same origin — so a switch made in the HUD (or any peer
  // window) only ever repainted the window it was made in. `storage` fires in
  // the OTHER windows, which is exactly the set that needs to catch up.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key && !APPEARANCE_KEYS.has(event.key)) {
        return
      }

      const live = normalizeProfileKey($activeGatewayProfile.get())

      setThemeNameState(skinPref.resolve(live))
      setModeState(modePref.resolve(live))
    }

    window.addEventListener('storage', onStorage)

    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const resolvedMode = resolveMode(mode, systemDark)

  const activeTheme = useMemo(
    () => deriveTheme(themeName, resolvedMode),
    // deriveTheme resolves its seed through the merged registry, so the theme
    // stores are its reactivity too — an in-place palette edit of the ACTIVE
    // skin (live theme authoring) must repaint, not just a name switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeName, resolvedMode, userThemes, backendThemes, registryVersion]
  )

  // What actually gets painted (matches the `.dark` class applyTheme toggles).
  const renderedMode = useMemo(() => renderedModeFor(activeTheme.colors, resolvedMode), [activeTheme, resolvedMode])

  useEffect(() => applyTheme(activeTheme, resolvedMode), [activeTheme, resolvedMode])

  // Keep the native window appearance pinned to the app theme (vibrancy
  // material, titlebar, new-window pre-paint background).
  useEffect(() => syncNativeTheme(mode, renderedMode), [mode, renderedMode])

  // Assign to whichever profile is live right now (read fresh so the callbacks
  // stay stable across profile switches).
  const liveProfile = () => normalizeProfileKey($activeGatewayProfile.get())

  const setTheme = useCallback((name: string) => {
    const next = normalizeSkin(name)
    setThemeNameState(next)
    skinPref.assign(liveProfile(), next)
  }, [])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    modePref.assign(liveProfile(), next)
  }, [])

  // Drain a backend-driven skin switch (Hermes authoring/activating a skin from a
  // prompt, or `/skin` on another surface). setTheme persists it per profile, so
  // the choice sticks like any manual pick.
  const pendingSkin = useStore($pendingSkinApply)

  useEffect(() => {
    if (pendingSkin) {
      setTheme(pendingSkin)
      $pendingSkinApply.set(null)
    }
  }, [pendingSkin, setTheme])

  // The light/dark toggle (Shift+X by default) is owned by the keybind runtime
  // (`appearance.toggleMode`) so it shows up in the hotkey map and is rebindable.

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: activeTheme, themeName, mode, resolvedMode, renderedMode, availableThemes, setTheme, setMode }),
    [activeTheme, themeName, mode, resolvedMode, renderedMode, availableThemes, setTheme, setMode]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = (): ThemeContextValue => useContext(ThemeContext)
