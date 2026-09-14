import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { collaborationCommand } from './orgo-collaboration'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {fs.rmSync(root, { recursive: true, force: true })} })

it('executes the actual upload/launch path with multiline and shell-sensitive text intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgo-collaboration-'))
  roots.push(root)
  const payload = { text: "reviewed 'excerpt' 日本語 café\n$NOT_A_COMMAND `not-a-command`", targetProfile: 'research' }

  const files = {
    '__init__.py': '',
    'desktop.py': 'import json,sys\nprint("ORGO_COLLABORATION_RESULT=" + sys.argv[-1])\n'
  }

  // The JS-only CI job has Python but deliberately does not install Hermes.
  // Exercise the real launcher in a disposable runtime, never the developer's
  // venv. Only the fake inbox and minimal package-location fixture are stubbed.
  const runtime = path.join(root, 'runtime')
  execFileSync('python3', ['-m', 'venv', '--without-pip', runtime])
  const python = path.join(runtime, 'bin/python')
  const packages = execFileSync(python, ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(packages, 'hermes_cli.py'), '# Runtime package-location fixture\n', 'utf8')
  const command = collaborationCommand(files, 'deliver', payload, root, python)
  const output = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
  expect(JSON.parse(output.trim().split('ORGO_COLLABORATION_RESULT=')[1])).toEqual(payload)
  // Reuse the immutable worker without corrupting it or changing the payload.
  expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })).toBe(output)
})
