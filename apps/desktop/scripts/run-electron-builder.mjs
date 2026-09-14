// Resolve electronDist at runtime (#38673, #47917): electron-builder 26.8.x can
// re-unpack a broken Electron.app; reusing the installed dist dodges that.
// npm workspace hoisting is non-deterministic — require.resolve finds electron
// wherever it landed. Dist present → -c.electronDist=<abs>/dist; absent → let
// electron-builder fetch via @electron/get (electronVersion + ELECTRON_MIRROR).

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

function electronDistDir() {
  try {
    return path.join(path.dirname(require.resolve("electron/package.json")), "dist")
  } catch {
    return null
  }
}

function distBinary(dist) {
  if (process.platform === "darwin") {
    return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
  }
  if (process.platform === "win32") {
    return path.join(dist, "electron.exe")
  }
  return path.join(dist, "electron")
}

function electronBuilderCli() {
  const pkgJson = require.resolve("electron-builder/package.json")
  const bin = require(pkgJson).bin
  const rel = typeof bin === "string" ? bin : bin["electron-builder"]
  return path.join(path.dirname(pkgJson), rel)
}

function hasConfiguredSigningIdentity() {
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    return true
  }

  if (process.platform !== 'darwin') {
    return false
  }

  const result = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  return result.status === 0 && /\b[1-9]\d* valid identities found\b/.test(output)
}

const dist = electronDistDir()
const args = []
if (dist && fs.existsSync(distBinary(dist))) {
  args.push(`-c.electronDist=${dist}`)
} else {
  console.warn(
    "[run-electron-builder] no local electron dist; electron-builder will fetch " +
      "via @electron/get (electronVersion + ELECTRON_MIRROR)."
  )
}
if (process.env.HERMES_DESKTOP_PRODUCT === 'bot') {
  args.push(
    '-c.appId=com.usingaitoscale.hermes-orgo-studio',
    '-c.productName=Revenue Partner Studio',
    '-c.executableName=Revenue Partner Studio',
    '-c.artifactName=Revenue-Partner-Studio-${version}-${os}-${arch}.${ext}',
    '-c.icon=assets/studio-icon',
    '-c.dmg.title=Install Revenue Partner Studio',
    '-c.mac.extendInfo.CFBundleDisplayName=Revenue Partner Studio',
    '-c.mac.extendInfo.CFBundleExecutable=Revenue Partner Studio',
    '-c.mac.extendInfo.CFBundleName=Revenue Partner Studio'
  )
}

if (process.platform === 'darwin' && !hasConfiguredSigningIdentity()) {
  // Electron's bundled signature becomes invalid after electron-builder changes
  // the app identity. A deliberate ad-hoc signature keeps local builds valid;
  // configured Developer ID credentials still take precedence above.
  args.push('-c.mac.identity=-')
}

args.push(...process.argv.slice(2))

const result = spawnSync(process.execPath, [electronBuilderCli(), ...args], {
  stdio: "inherit",
})
if (result.error) {
  console.error(`[run-electron-builder] spawn failed: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status == null ? 1 : result.status)
