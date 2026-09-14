export async function api(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let result
  try {
    result = await response.json()
  } catch {
    throw Object.assign(new Error('The server returned an incomplete reply. Please reconnect.'), {
      status: response.status
    })
  }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), { status: response.status })
  return result
}
export const rpc = (
  computer: string,
  method: string,
  params: Record<string, unknown> = {},
  requestId: string = crypto.randomUUID()
) => api(`/api/computers/${encodeURIComponent(computer)}/rpc`, { method, params, requestId })
