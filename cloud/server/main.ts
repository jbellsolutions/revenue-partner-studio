import { mkdirSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.ts'
import { createGateway } from './gateway.ts'
import { Qualification } from './qualification.ts'
import { ControlStore } from './control-store.ts'
const data = process.env.STUDIO_DATA_DIR || path.resolve('.local')
mkdirSync(data, { recursive: true, mode: 0o700 })
const store = new Store(path.join(data, 'studio.sqlite'))
chmodSync(path.join(data, 'studio.sqlite'), 0o600)
let qualification: Qualification | undefined
const gateway = createGateway({
  control:new ControlStore(store,ControlStore.keyFile(path.join(data,'connection-key'))),
  setupDir:process.env.STUDIO_SETUP_DIR||path.join(path.dirname(fileURLToPath(import.meta.url)),'setup'),
  qualificationStatus: () => qualification?.summary() || { state: 'not_started' },
  store,
  password: process.env.STUDIO_OWNER_PASSWORD || '',
  allowedOrigins: (process.env.STUDIO_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean),
  origin: process.env.STUDIO_PUBLIC_URL || 'http://127.0.0.1:8788',
  publicDir: process.env.STUDIO_PUBLIC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
})
if (process.env.STUDIO_TRIAL_TARGETS) {
  const targets = JSON.parse(process.env.STUDIO_TRIAL_TARGETS)
  qualification = new Qualification(gateway, path.join(data, 'qualification.sqlite'), targets,Date.now,process.env.STUDIO_TRIAL_REVISION)
  chmodSync(path.join(data, 'qualification.sqlite'), 0o600)
  qualification.start()
}
gateway.server.listen(Number(process.env.PORT || 8788), '0.0.0.0', () => process.stdout.write('Studio gateway ready\n'))
let stopping = false
async function close() {
  if (stopping) return
  stopping = true
  const drain = qualification?.close()
  await gateway.close()
  await drain
}
process.on('SIGTERM', () => void close())
process.on('SIGINT', () => void close())
