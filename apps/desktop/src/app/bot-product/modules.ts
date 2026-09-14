/** Typed seams around the frozen Bot Mode plugin. Roster, group chat, profile
 *  editing, and provider pickers still live in plugin.js until packaged E2E
 *  coverage lands; these modules are the split points for later extraction. */
export { resolveGroupSessionBinding } from '@/lib/bot-group-session'
export { BOT_PROVIDER_IDS, filterBotProviders, isBotProduct } from '@/lib/product'
