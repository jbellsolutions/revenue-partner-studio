import { rpc } from './api'
const checksum = async (data: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), x => x.toString(16).padStart(2, '0')).join('')
export async function retryImport<T>(
  operation: () => Promise<T>,
  wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const e = error as Error & { status?: number }
      const transient =
        e instanceof TypeError ||
        (e.status || 0) >= 500 ||
        /offline|connection interrupted|gateway stopping|timed? out|timeout|still being reconciled/i.test(e.message)
      if (!transient || attempt >= 15) throw error
      await wait(Math.min(2000, 250 * 2 ** attempt))
    }
  }
}
export async function prepareImport(file: File, computer: string, progress: (percent: number) => void) {
  if (!file.name.endsWith('.zip')) {
    const content = await file.arrayBuffer(),
      bundle = JSON.parse(new TextDecoder().decode(content)),
      id = 'import-json-' + (await checksum(content))
    const preview=await rpc(computer,'import.preview',{bundle})
    return {preview,apply:()=>retryImport(() => rpc(computer, 'import.apply', { bundle }, id))}
  }
  const match = /-([a-f0-9]{64})\.studio\.zip$/.exec(file.name)
  if (!match) throw new Error('Choose the original archive produced by the Studio import helper.')
  const upload = await retryImport(() => rpc(computer, 'import.begin', { size: file.size, sha256: match[1] }))
  for (let offset = upload.offset; offset < file.size; offset += upload.chunkSize) {
    const chunk = await file.slice(offset, offset + upload.chunkSize).arrayBuffer()
    const bytes = new Uint8Array(chunk)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    const params = {
      uploadId: upload.uploadId,
      offset,
      data: btoa(binary),
      sha256: await checksum(chunk)
    }
    await retryImport(() => rpc(computer, 'import.chunk', params))
    progress(Math.min(100, Math.round(((offset + chunk.byteLength) / file.size) * 100)))
  }
  progress(100)
  const preview=await rpc(computer,'import.preview',{uploadId:upload.uploadId})
  return {preview,apply:()=>retryImport(() => rpc(computer, 'import.commit', { uploadId: upload.uploadId }, 'import-' + upload.uploadId))}
}
export async function importProfile(file:File,computer:string,progress:(percent:number)=>void){return (await prepareImport(file,computer,progress)).apply()}
