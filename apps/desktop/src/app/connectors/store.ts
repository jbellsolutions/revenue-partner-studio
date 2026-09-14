import { atom } from 'nanostores'

export const $connectorsOpen = atom(false)

export function openConnectors(): void {
  $connectorsOpen.set(true)
}

export function closeConnectors(): void {
  $connectorsOpen.set(false)
}
