import plugin from '@bot-mode/plugin'
/**
 * First-party Bot Mode. The complete implementation is tracked beside this
 * wrapper so source checkouts, CI, and packaged builds all compile the same UI
 * without depending on a machine-local desktop plugin.
 */
import type { HermesPlugin } from '@hermes/plugin-sdk'

const bundled: HermesPlugin = {
  ...plugin,
  defaultEnabled: true,
  description: 'Bot roster, group chat, connectors, and shared computer.',
  name: plugin.name ?? 'Bots'
}

export default bundled
