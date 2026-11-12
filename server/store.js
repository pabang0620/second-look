import { randomBytes } from 'node:crypto'

export const STATES = Object.freeze({
  CREATED: 'CREATED',
  HELD: 'HELD',
  HELD_ASKING: 'HELD_ASKING',
  APPROVED_PENDING: 'APPROVED_PENDING',
  CAPTURING: 'CAPTURING',
  CAPTURED: 'CAPTURED',
  VOIDING: 'VOIDING',
  VOIDED: 'VOIDED',
  FAILED: 'FAILED',
})

export const TERMINAL = new Set([STATES.CAPTURED, STATES.VOIDED, STATES.FAILED])
export const HELD_STATES = [STATES.HELD, STATES.HELD_ASKING]

export const newId = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`

export function seedHousehold() {
  return {
    elder: { name: 'Margaret', phone: '(555) 010-0178' },
    family: { name: 'Sarah', phone: '(555) 010-0142' },
    limitCents: 15000,
    trustedPayees: new Set(['power_company', 'garden_shop']),
    rulesState: 'RULES_ON', // RULES_ON -> PAUSE_REQUESTED (24 h) -> RULES_OFF
    pauseRequestedAt: null,
    pauseEffectiveAt: null,
    history: [
      { payeeKey: 'power_company', amountCents: 8400, daysAgo: 31 },
      { payeeKey: 'garden_shop', amountCents: 2000, daysAgo: 20 },
      { payeeKey: 'power_company', amountCents: 8100, daysAgo: 1 },
      { payeeKey: 'garden_shop', amountCents: 2400, daysAgo: 9 },
    ],
    tokens: { elder: randomBytes(12).toString('hex'), family: randomBytes(12).toString('hex') },
  }
}

// In-memory state with conditional updates: a transition only happens if the payment is still in an expected state.
export function createStore() {
  let payments = new Map()
  let household = seedHousehold()
  let requests = []
  let activity = []
  const processedEvents = new Set()
  const tokens = household.tokens

  return {
    tokens: () => tokens,
    household: () => household,
    updateHousehold(patch) { household = { ...household, ...patch } },
    reset() {
      payments = new Map()
      requests = []
      activity = []
      processedEvents.clear()
      household = { ...seedHousehold(), tokens }
    },
    insert(payment) { payments.set(payment.id, payment); return payment },
    get: (id) => payments.get(id) || null,
    list: () => [...payments.values()],
    update(id, patch) {
      const current = payments.get(id)
      if (!current) return null
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
      payments.set(id, next)
      return next
    },
    transition(id, from, to, patch = {}) {
      const current = payments.get(id)
      if (!current || !from.includes(current.state)) return null
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), state: to }
      payments.set(id, next)
      return next
    },
    // A claim is written before a money call and refused when it already exists, so a second caller never reaches PayPal.
    claim(id, op, at) {
      const current = payments.get(id)
      if (!current || current.claims?.[op]) return false
      payments.set(id, { ...current, claims: { ...current.claims, [op]: at } })
      return true
    },
    releaseClaim(id, op) {
      const current = payments.get(id)
      if (!current?.claims?.[op]) return
      const { [op]: _released, ...rest } = current.claims
      payments.set(id, { ...current, claims: rest })
    },
    addRequest(request) { requests = [...requests, request]; return request },
    listRequests: () => requests,
    log(entry) { activity = [...activity, { id: newId('act'), ...entry }] },
    activity: () => activity,
    hasEvent: (eventId) => processedEvents.has(eventId),
    // Called only after an event was processed successfully, so a failed run can be redelivered by PayPal.
    markEvent(eventId) {
      if (processedEvents.has(eventId)) return false
      processedEvents.add(eventId)
      return true
    },
  }
}
