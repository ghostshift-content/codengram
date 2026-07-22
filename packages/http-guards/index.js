// Exact local-server request guards. Host is checked on every request to prevent DNS rebinding; Origin is checked
// on mutations to prevent a different localhost application from driving Codengram with the user's browser.
export function allowedHosts(port) {
  const p = Number(port)
  return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`])
}

export function hostOk(host, port) {
  return typeof host === 'string' && allowedHosts(port).has(host.toLowerCase())
}

export function originOk(origin, port) {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && allowedHosts(port).has(url.host.toLowerCase()) && url.pathname === '/'
  } catch { return false }
}
