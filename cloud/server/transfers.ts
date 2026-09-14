import { randomUUID } from 'node:crypto'
import { ControlStore } from './control-store.ts'
type Rpc = (computer: string, method: string, params: any, requestId?: string) => Promise<any>
export class Transfers {
  private running = new Set<string>()
  private stopped = false
  private timer: ReturnType<typeof setInterval>
  constructor(
    readonly control: ControlStore,
    readonly rpc: Rpc
  ) {
    this.timer = setInterval(() => {
      for (const j of this.list()) if (['preparing', 'copying', 'waiting'].includes(j.state)) void this.run(j.id)
    }, 15000)
    this.timer.unref()
  }
  close() {
    this.stopped = true
    clearInterval(this.timer)
  }
  list(): any[] {
    return this.control.store.db
      .prepare("SELECT name FROM control_values WHERE name LIKE 'transfer:%' ORDER BY name LIMIT 100")
      .all()
      .map((r: any) => this.control.get(r.name))
      .map(({ manifest, snapshot, ...j }: any) => j)
      .sort((a: any, b: any) => b.created - a.created)
  }
  get(id: string) {
    const j = this.control.get('transfer:' + id)
    if (!j) throw Error('Unknown Hermes transfer.')
    return j
  }
  save(j: any) {
    if (!this.stopped) this.control.set('transfer:' + j.id, { ...j, updated: Date.now() })
  }
  start(p: any) {
    const ids = new Set(this.control.store.computers().map(c => c.id))
    if (!ids.has(p.source) || !ids.has(p.target) || p.source === p.target)
      throw Error('Choose different source and destination computers.')
    if (
      !Array.isArray(p.profiles) ||
      !p.profiles.length ||
      p.profiles.length > 100 ||
      p.profiles.some((v: any) => typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v))
    )
      throw Error('Select valid Hermes profiles.')
    const selection =
      p.scope === 'skills'
        ? { scope: 'skills', sourceProfile: p.sourceProfile, skillIds: p.skillIds, targetAgent: p.targetAgent }
        : undefined
    if (p.scope && !['skills', 'profiles'].includes(p.scope)) throw Error('Unknown transfer type.')
    if (
      selection &&
      (typeof selection.sourceProfile !== 'string' ||
        typeof selection.targetAgent !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(selection.sourceProfile || '') ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(selection.targetAgent || '') ||
        p.profiles.length !== 1 ||
        p.profiles[0] !== selection.sourceProfile ||
        !Array.isArray(selection.skillIds) ||
        !selection.skillIds.length ||
        selection.skillIds.length > 100 ||
        selection.skillIds.some(
          (s: any) =>
            typeof s !== 'string' ||
            s.length > 500 ||
            s.includes('\\') ||
            s.split('/').some((part: string) => ['', '.', '..'].includes(part))
        ))
    )
      throw Error('Choose skills and an existing destination agent.')
    const j = {
      selection,
      id: randomUUID(),
      source: p.source,
      target: p.target,
      profiles: p.profiles,
      state: 'preparing',
      approved: false,
      created: Date.now(),
      detail: 'Preparing a consistent Hermes snapshot for review.',
      offset: 0
    }
    this.save(j)
    void this.run(j.id)
    return j
  }
  apply(id: string) {
    const j = this.get(id)
    if (j.approved) return { id: j.id, state: j.state }
    if (j.state !== 'review') throw Error('Wait for the transfer preview before applying it.')
    j.approved = true
    j.state = 'copying'
    this.save(j)
    this.control.audit('import', j.source, j.target, id, 'approved')
    void this.run(id)
    return { id, state: 'copying' }
  }
  retry(id: string) {
    const j = this.get(id)
    if (!['failed', 'waiting'].includes(j.state)) return { id, state: j.state }
    j.state = j.approved ? 'copying' : 'preparing'
    this.save(j)
    void this.run(id)
    return { id, state: j.state }
  }
  async run(id: string) {
    if (this.running.has(id) || this.stopped) return
    this.running.add(id)
    let j = this.get(id)
    try {
      if (!j.snapshot) {
        if (j.selection) {
          const status = await Promise.all([j.source, j.target].map(c => this.rpc(c, 'status', {})))
          if (status.some(s => !s.capabilities?.librarySkills))
            throw Error(
              'Update the source and destination Studio companions to use selected-skill transfers. Full-profile imports remain available.'
            )
        }
        const snapshot = await this.rpc(
          j.source,
          'library.export',
          { targetComputerId: j.target, profiles: j.profiles, selection: j.selection },
          id + ':snapshot'
        )
        if (
          j.selection &&
          (snapshot.manifest?.scope !== 'skills' ||
            snapshot.manifest?.sourceProfile !== j.selection.sourceProfile ||
            snapshot.manifest?.targetAgent !== j.selection.targetAgent ||
            !Array.isArray(snapshot.manifest?.skillIds) ||
            JSON.stringify([...snapshot.manifest.skillIds].sort()) !== JSON.stringify([...j.selection.skillIds].sort()))
        )
          throw Error('The source returned a different import selection. No files were copied.')
        j.snapshot = snapshot
        j.manifest = j.snapshot.manifest
        delete j.snapshot.manifest
        this.save(j)
      }
      if (!j.approved) {
        j.preview = await this.rpc(j.target, 'library.preview', { manifest: j.manifest }, id + ':preview')
        j.state = 'review'
        j.detail = 'Review the changes before applying. Credentials are excluded.'
        this.save(j)
        return
      }
      const upload = await this.rpc(
        j.target,
        'import.begin',
        { size: j.snapshot.size, sha256: j.snapshot.sha256 },
        id + ':begin'
      )
      j.offset = upload.offset
      j.state = 'copying'
      while (j.offset < j.snapshot.size && !this.stopped) {
        const chunk = await this.rpc(
          j.source,
          'library.chunk',
          { exportId: j.snapshot.exportId, offset: j.offset },
          id + ':read:' + j.offset
        )
        const next = await this.rpc(
          j.target,
          'import.chunk',
          { uploadId: upload.uploadId, offset: j.offset, data: chunk.data, sha256: chunk.sha256 },
          id + ':write:' + j.offset
        )
        if (!Number.isSafeInteger(next.offset) || next.offset <= j.offset || next.offset > j.snapshot.size)
          throw Error('Transfer returned an invalid offset.')
        j.offset = next.offset
        j.total = j.snapshot.size
        j.detail = 'Copying the approved snapshot to its destination.'
        this.save(j)
      }
      if (this.stopped) return
      j.detail = 'Applying the verified snapshot. Existing agents and conflicts are preserved.'
      this.save(j)
      j.result = await this.rpc(j.target, 'import.commit', { uploadId: upload.uploadId }, id + ':commit')
      j.state = 'complete'
      j.detail = 'Import complete. This computer can use its copy while the source is offline.'
      this.save(j)
    } catch (e) {
      const error = (e as Error).message
      j.state = /offline|interrupted|acknowledge|timeout|connection/i.test(error) ? 'waiting' : 'failed'
      j.detail =
        j.state === 'waiting'
          ? 'Waiting for the computers to reconnect. Approved progress is saved.'
          : error.slice(0, 300)
      this.save(j)
    } finally {
      this.running.delete(id)
    }
  }
}
