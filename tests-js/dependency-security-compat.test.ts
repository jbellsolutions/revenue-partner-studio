/**
 * Lockfile invariants for patched transitive dependencies and native addons.
 *
 * `plist` currently brings in both the 0.8.x and 0.9.x lines of
 * `@xmldom/xmldom`, so one unqualified override can silently leave one line
 * vulnerable. Vite and Tailwind can also resolve different `lightningcss`
 * versions; npm must not let one JavaScript runtime load another version's
 * platform-native package.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { test } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '..')
const LOCK_PATH = path.join(REPO_ROOT, 'package-lock.json')

interface LockPackage {
  version?: string
  optionalDependencies?: Record<string, string>
}

function lockPackages(): Record<string, LockPackage> {
  if (!fs.existsSync(LOCK_PATH)) {return {}}
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'))

  return (lock.packages ?? {}) as Record<string, LockPackage>
}

function packageName(lockPath: string): string {
  const marker = 'node_modules/'
  const index = lockPath.lastIndexOf(marker)

  return index >= 0 ? lockPath.slice(index + marker.length) : lockPath
}

function resolveDependency(
  packages: Record<string, LockPackage>,
  requesterPath: string,
  dependency: string,
): LockPackage | undefined {
  let installScope = requesterPath.slice(0, requesterPath.lastIndexOf('node_modules/'))

  while (true) {
    const candidate = `${installScope}node_modules/${dependency}`

    if (packages[candidate]) {return packages[candidate]}

    if (!installScope) {return undefined}

    const trimmed = installScope.replace(/\/$/, '')
    const parentMarker = trimmed.lastIndexOf('node_modules/')

    installScope = parentMarker >= 0 ? trimmed.slice(0, parentMarker) : ''
  }
}

function numericVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('-', 1)[0]
    .split('.')
    .map(Number)

  return [major, minor, patch]
}

test('every @xmldom/xmldom release is above its patched security floor', () => {
  const packages = lockPackages()

  if (Object.keys(packages).length === 0) {return}

  const offenders = Object.entries(packages)
    .filter(([lockPath]) => packageName(lockPath) === '@xmldom/xmldom')
    .flatMap(([lockPath, meta]) => {
      if (!meta.version) {return [`${lockPath} has no version`]}
      const [major, minor, patch] = numericVersion(meta.version)

      const patched =
        major > 0 ||
        minor > 9 ||
        (minor === 9 && patch >= 12) ||
        (minor === 8 && patch >= 15)

      return patched ? [] : [`${lockPath}@${meta.version}`]
    })

  assert.deepEqual(
    offenders,
    [],
    `Vulnerable @xmldom/xmldom release(s) remain in package-lock.json: ${offenders.join(', ')}`,
  )
})

test('each lightningcss runtime resolves native packages at its own version', () => {
  const packages = lockPackages()

  if (Object.keys(packages).length === 0) {return}

  const mismatches: string[] = []
  let resolvedNativePackages = 0

  for (const [lockPath, meta] of Object.entries(packages)) {
    if (packageName(lockPath) !== 'lightningcss' || !meta.version) {continue}

    for (const [dependency, requiredVersion] of Object.entries(meta.optionalDependencies ?? {})) {
      if (!dependency.startsWith('lightningcss-')) {continue}
      const resolved = resolveDependency(packages, lockPath, dependency)

      if (!resolved?.version) {continue}
      resolvedNativePackages += 1

      if (resolved.version !== requiredVersion || resolved.version !== meta.version) {
        mismatches.push(
          `${lockPath}@${meta.version} resolves ${dependency}@${resolved.version}, requires ${requiredVersion}`,
        )
      }
    }
  }

  assert.ok(resolvedNativePackages > 0, 'package-lock.json contains no resolved lightningcss native packages')
  assert.deepEqual(
    mismatches,
    [],
    `Mismatched lightningcss native package(s): ${mismatches.join('; ')}`,
  )
})
