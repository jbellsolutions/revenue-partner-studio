import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export type PublicWebsiteOptions = { url: string; directory: string }

// A fixture-only website may share the deployment, but never the app's routes.
export function publicWebsite(options?: PublicWebsiteOptions) {
  if (!options) return undefined
  const canonical = new URL(options.url)
  if (!['http:', 'https:'].includes(canonical.protocol) || canonical.username || canonical.password ||
      canonical.pathname !== '/' || canonical.search || canonical.hash)
    throw new Error('Public website URL must be an HTTP(S) origin.')
  const host = canonical.host.toLowerCase()
  const www = `www.${host}`
  const root = path.resolve(options.directory)
  const pages = new Set(['/', '/demo', '/build', '/prep'])
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf': 'application/pdf', '.zip': 'application/zip'
  }
  const requestHost = (req: IncomingMessage) => (req.headers.host || '').toLowerCase().replace(/\.(?=:\d+$|$)/, '')
  const matches = (req: IncomingMessage) => [host, www].includes(requestHost(req))
  async function serve(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'")
    res.setHeader('Cache-Control', 'no-store')
    const end = (status: number, text: string) => { res.statusCode = status; res.end(req.method === 'HEAD' ? undefined : text) }
    if (!['GET', 'HEAD'].includes(req.method || '')) { res.setHeader('Allow', 'GET, HEAD'); return end(405, 'Method not allowed') }
    let url: URL, pathname: string
    try { url = new URL(req.url || '/', canonical); pathname = decodeURIComponent(url.pathname) }
    catch { return end(400, 'Invalid path') }
    // Even with an app cookie or Origin header, no API, connector, or setup route exists here.
    const page = pages.has(pathname.replace(/\/$/, '') || '/')
    const asset = /^\/(?:assets|downloads)\/[A-Za-z0-9_./ -]+$/.test(pathname) || pathname === '/favicon.svg'
    if (!page && !asset) return end(404, 'Not found')
    if (requestHost(req) === www) {
      res.setHeader('Location', canonical.origin + url.pathname + url.search)
      return end(301, 'Moved permanently')
    }
    const file = path.resolve(root, page ? 'index.html' : '.' + pathname)
    if (!file.startsWith(root + path.sep)) return end(404, 'Not found')
    try {
      const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(file)])
      if (!resolvedFile.startsWith(resolvedRoot + path.sep) || !(await stat(resolvedFile)).isFile()) return end(404, 'Not found')
      const content = await readFile(resolvedFile)
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
      res.setHeader('Cache-Control', page ? 'no-cache' : 'public, max-age=3600')
      res.setHeader('Content-Length', content.length)
      res.statusCode = 200
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch { return end(404, 'Not found') }
  }
  return { matches, serve }
}
