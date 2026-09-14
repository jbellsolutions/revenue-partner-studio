import { rpc } from './api'
import { retryImport } from './import'
export type Attachment = {
  id: string
  name: string
  size: number
  attachmentId?: string
  sessionId?: string
  progress: number
  status: 'uploading' | 'ready' | 'error'
  error?: string
}
export const ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.tsv,.json,.docx,.xlsx'
export function checkFiles(files: { name: string; size: number }[], existing: Attachment[]) {
  if (files.length + existing.length > 10) throw new Error('Attach at most ten files to one message.')
  if (files.reduce((n, f) => n + f.size, 0) + existing.reduce((n, f) => n + f.size, 0) > 100 * 1024 * 1024)
    throw new Error('A message can contain at most 100 MB of attachments.')
  for (const file of files) {
    if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Each attachment must be between 1 byte and 25 MB.')
    if (!ACCEPT.split(',').some(ext => file.name.toLowerCase().endsWith(ext)))
      throw new Error('Choose an image, PDF, text, CSV, DOCX or XLSX file.')
  }
}
export async function uploadAttachment(
  file: File,
  computer: string,
  agent: string,
  id: string,
  context: () => { runtimeId: string },
  progress: (value: number) => void
) {
  const buffer = await file.arrayBuffer()
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), n =>
    n.toString(16).padStart(2, '0')
  ).join('')
  const call = (method: string, params: Record<string, unknown>, requestId?: string) =>
    retryImport(() => rpc(computer, method, { ...params, agentId: agent, ...context() }, requestId))
  const upload = await call('files.begin', { name: file.name, size: file.size, sha256: checksum }, id)
  for (let offset = upload.offset; offset < file.size; offset += upload.chunkSize) {
    const bytes = new Uint8Array(buffer.slice(offset, offset + upload.chunkSize))
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    await call('files.chunk', { attachmentId: upload.id, offset, data: btoa(binary) })
    progress(Math.min(99, Math.round(((offset + bytes.byteLength) / file.size) * 100)))
  }
  return call('files.commit', { attachmentId: upload.id })
}
export async function downloadAttachment(computer: string, agent: string, runtime: string, attachmentId: string) {
  const parts: Uint8Array[] = []
  let offset = 0,
    name = 'attachment',
    size = 1
  while (offset < size) {
    const chunk = await rpc(computer, 'files.read', { agentId: agent, runtimeId: runtime, attachmentId, offset })
    const bytes = Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0))
    parts.push(bytes)
    offset += bytes.length
    size = chunk.size
    name = chunk.name
  }
  const url = URL.createObjectURL(new Blob(parts as BlobPart[]))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
