// Thin fetch wrapper. Every call returns data or throws an Error with a plain message.
// Each browser keeps one demo session id, so the Judge page, the payer page and the family page share one household
// and another visitor never sees it.
const SESSION_KEY = 'secondlook.session'
let boot = null
let bootPromise = null

const storedSession = () => {
  try { return window.localStorage.getItem(SESSION_KEY) || '' } catch { return '' }
}
const saveSession = (id) => {
  try { window.localStorage.setItem(SESSION_KEY, id) } catch { /* private mode: the session lasts until reload */ }
}
const forgetSession = () => {
  try { window.localStorage.removeItem(SESSION_KEY) } catch { /* nothing stored */ }
}

// One bootstrap request no matter how many callers ask at once. Nothing else is sent before it finishes,
// so a first visit never meets a 401.
export function bootstrap() {
  if (!bootPromise) {
    bootPromise = request('GET', '/api/judge/bootstrap').then((data) => {
      boot = data
      saveSession(data.sessionId)
      return data
    }).catch((err) => { bootPromise = null; throw err })
  }
  return bootPromise
}

// Reload only when a session was actually sent and the server no longer knows it (restart, idle for hours).
export const shouldReload = ({ status, sentSession, hasToken }) => Boolean(sentSession) && (status === 401 || (status === 403 && hasToken))

async function request(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  const session = boot?.sessionId || storedSession()
  if (session) headers['x-session'] = session
  if (token) headers['x-role-token'] = token
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json().catch(() => ({ success: false, message: 'The server did not answer.' }))
  if (shouldReload({ status: res.status, sentSession: session, hasToken: Boolean(token) })) {
    // The household was dropped: start a fresh one.
    forgetSession()
    boot = null
    bootPromise = null
    window.location.reload()
  }
  if (!res.ok || json.success === false) throw new Error(json.message || 'Something went wrong.')
  return json.data
}

export async function call(role, method, path, body) {
  const { tokens } = await bootstrap()
  return request(method, path, body, tokens[role])
}

export async function judge(method, path, body) {
  await bootstrap()
  return request(method, `/api/judge${path}`, body)
}
