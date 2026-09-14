/** Exact origins only: adding a domain never trusts its siblings or subdomains. */
export function trustedOrigins(primary: string, additional: string[] = []) {
  const values = [primary, ...additional]
  for (const value of values) {
    const url = new URL(value)
    const local = ['127.0.0.1', 'localhost', '[::1]', 'studio.test'].includes(url.hostname)
    if (
      url.origin !== value ||
      url.hostname.includes('*') ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    )
      throw new Error('Studio origins must be exact HTTPS origins, without paths or wildcards.')
  }
  return new Set(values)
}
