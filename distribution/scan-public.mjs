#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = resolve(process.argv[2] || '.'),
  directory = process.argv.includes('--directory')
const policy = JSON.parse(readFileSync(new URL('./public/scan-allowlist.json', import.meta.url), 'utf8'))
const temp = mkdtempSync(join(tmpdir(), 'rps-scan-')),
  report = join(temp, 'report.json')
try {
  const args = [
    directory ? 'dir' : 'git',
    ...(directory ? [] : ['--staged']),
    root,
    '--redact',
    '--no-banner',
    '--no-color',
    '--report-format',
    'json',
    '--report-path',
    report,
    '--gitleaks-ignore-path',
    temp,
    '--max-archive-depth',
    '3'
  ]
  const scan = spawnSync('gitleaks', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (![0, 1].includes(scan.status))
    throw Error('Gitleaks could not complete. Install gitleaks and inspect its configuration.')
  const rows = JSON.parse(readFileSync(report, 'utf8')),
    remaining = [],
    reviewed = []
  for (const row of rows) {
    let hash = ''
    const file = row.File.startsWith(root + '/') ? row.File.slice(root.length + 1) : row.File
    try {
      const content = directory
        ? readFileSync(resolve(root, file))
        : spawnSync('git', ['show', ':' + file], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).stdout
      hash = createHash('sha256').update(content).digest('hex')
    } catch {}
    const known = policy.entries.some(e => e.file === file && e.rule === row.RuleID && e.fileHash === hash)
    ;(known ? reviewed : remaining).push({ file, rule: row.RuleID, line: row.StartLine })
  }
  console.log(
    JSON.stringify(
      {
        scanned: true,
        reviewedBaselineFindings: reviewed.length,
        newFindings: remaining.length,
        unreviewed: remaining
      },
      null,
      2
    )
  )
  process.exitCode = remaining.length ? 1 : 0
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
} finally {
  rmSync(temp, { recursive: true, force: true })
}
