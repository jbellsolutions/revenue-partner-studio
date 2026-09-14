import fs from 'node:fs'
import path from 'node:path'
import { listBotInstances, validateBotInstance } from './bot-instances'
import { BOT_INSTANCE_ARG, parseBotInstanceName } from './product'

export const STUDIO_PRIMARY_ARG = '--studio-primary'
const filename = 'studio-launch.json'

export function readStudioDefault(root: string): string | null {
  const file = path.join(root, filename)
  if (!fs.existsSync(file)) return null
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('The default computer settings cannot be a link.')
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  const name = validateBotInstance(value.instance)
  const row = listBotInstances(root, '').find(row => row.name === name)
  if (!row || row.unreadable || !row.computerId) throw new Error('The saved default computer is unavailable. Open a saved computer explicitly; no other workspace was selected.')
  return name
}

/** Resolve before Electron chooses its data directory and single-instance lock. */
export function resolveStudioLaunch(root: string, argv: string[]): string {
  const explicit = argv.some(arg => arg === BOT_INSTANCE_ARG || arg.startsWith(BOT_INSTANCE_ARG + '='))
  if (argv.includes(STUDIO_PRIMARY_ARG)) {
    if (explicit) throw new Error('Choose either the primary workspace or a named computer, not both.')
    return ''
  }
  if (explicit) return parseBotInstanceName(argv)
  return readStudioDefault(root) ?? ''
}

export function saveStudioDefault(root: string, name: unknown): string {
  const instance = validateBotInstance(name)
  const row = listBotInstances(root, '').find(row => row.name === instance)
  if (!row || row.unreadable || !row.computerId) throw new Error('Only a configured computer can be the default.')
  const file = path.join(root, filename)
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('The default computer settings cannot be a link.')
  const temp = path.join(root, `.studio-launch-${process.pid}-${Date.now()}.tmp`)
  try {
    fs.writeFileSync(temp, JSON.stringify({version: 1, instance}, null, 2) + '\n', {mode: 0o600, flag: 'wx'})
    fs.renameSync(temp, file)
  } finally { fs.rmSync(temp, {force: true}) }
  return instance
}
