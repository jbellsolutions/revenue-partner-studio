import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  out = resolve(root, 'site/public/downloads')
mkdirSync(out, { recursive: true })
for (const [source, target] of [
  ['BEFORE-YOU-START.md', 'before-you-start.md'],
  ['Revenue Partner Studio - Before You Start.docx', 'revenue-partner-studio-before-you-start.docx'],
  ['SETUP-PROMPT.txt', 'setup-prompt.txt']
])
  copyFileSync(resolve(root, 'docs', source), resolve(out, target))
