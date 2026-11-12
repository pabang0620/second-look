import { randomBytes } from 'node:crypto'

const SESSION_PATTERN = /^[0-9a-f]{24}$/

export const isSessionId = (value) => typeof value === 'string' && SESSION_PATTERN.test(value)

// One household (a full set of services with its own store, tokens and mock PayPal) per visitor.
// build() returns { svc, dispose }. Idle households are dropped after ttlMs, and the oldest idle one goes when the pool is full.
export function createHouseholdPool({ build, ttlMs = 3 * 3600 * 1000, max = 200, now = () => Date.now() }) {
  const sessions = new Map() // id -> { svc, dispose, lastSeen }

  function drop(id) {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    entry.dispose?.()
  }

  function sweep() {
    const t = now()
    for (const [id, entry] of sessions) if (t - entry.lastSeen > ttlMs) drop(id)
    while (sessions.size >= max) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]
      drop(oldest[0])
    }
  }

  const touch = (entry) => { entry.lastSeen = now(); return entry.svc }

  return {
    // The session a visitor already has, or a fresh household.
    open(sessionId, meta = {}) {
      const existing = isSessionId(sessionId) ? sessions.get(sessionId) : null
      if (existing) {
        if (meta.ip) existing.svc.client.ip = meta.ip
        return { id: sessionId, svc: touch(existing) }
      }
      sweep()
      const id = randomBytes(12).toString('hex')
      const built = build()
      if (meta.ip && built.svc.client) built.svc.client.ip = meta.ip
      sessions.set(id, { svc: built.svc, dispose: built.dispose, lastSeen: now() })
      return { id, svc: built.svc }
    },
    get(sessionId) {
      const entry = isSessionId(sessionId) ? sessions.get(sessionId) : null
      return entry ? touch(entry) : null
    },
    byToken(token, role) {
      if (typeof token !== 'string' || !token) return null
      for (const entry of sessions.values()) if (entry.svc.store.tokens()[role] === token) return touch(entry)
      return null
    },
    find(predicate) {
      for (const entry of sessions.values()) if (predicate(entry.svc)) return entry.svc
      return null
    },
    any() { const first = sessions.values().next().value; return first ? first.svc : null },
    size: () => sessions.size,
    closeAll() { for (const id of [...sessions.keys()]) drop(id) },
  }
}

// Tests and tools that have one backend: the pool always hands out that one household.
export function singleHousehold(svc) {
  return {
    open: () => ({ id: 'single', svc }),
    get: () => svc,
    byToken: (token, role) => (svc.store.tokens()[role] === token ? svc : null),
    find: (predicate) => (predicate(svc) ? svc : null),
    any: () => svc,
    size: () => 1,
    closeAll() {},
  }
}
