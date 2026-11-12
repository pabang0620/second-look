// Each payee (seller) is its own PayPal sandbox business account with its own REST app.
// The prototype holds each demo seller's credentials to play the role PayPal would play internally.
export const PAYEE_DEFS = Object.freeze([
  { key: 'power_company', displayName: 'Power company', email: 'billing@citypower-billing.example', domain: 'citypower-billing.example', known: true },
  { key: 'garden_shop', displayName: 'Garden shop', email: 'orders@greenthumb-garden.example', domain: 'greenthumb-garden.example', known: true },
  { key: 'mobility_direct', displayName: 'Mobility Direct Outlet', email: 'sales@quickdeal-outlet.example', domain: 'quickdeal-outlet.example', known: false },
  { key: 'maple_lane', displayName: 'Maple Lane Nursery', email: 'hello@maplelane-nursery.example', domain: 'maplelane-nursery.example', known: false },
  { key: 'lakeside_tickets', displayName: 'Lakeside Tickets', email: 'box@lakeside-tickets.example', domain: 'lakeside-tickets.example', known: false },
])

// SANDBOX_SELLERS=mobility_direct,maple_lane limits the sandbox to those sellers; the others use the local stand-in
// even when .env has their keys (the video records only the key scene on the sandbox).
export function sandboxAllowed(key, env) {
  const list = String(env.SANDBOX_SELLERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  return list.length === 0 || list.includes(key)
}

function credentialsFor(def, env, forceMock) {
  const prefix = `PAYEE_${def.key.toUpperCase()}`
  const clientId = env[`${prefix}_CLIENT_ID`]
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]
  if (!forceMock && clientId && clientSecret && sandboxAllowed(def.key, env)) {
    return { mode: 'sandbox', clientId, clientSecret, webhookId: env[`${prefix}_WEBHOOK_ID`] || '' }
  }
  return { mode: 'mock', clientId: `mock-client-${def.key}`, clientSecret: `mock-secret-${def.key}`, webhookId: `mock-webhook-${def.key}` }
}

// forceMock ignores every PAYEE_* key, so FORCE_MOCK=1 can never reach the PayPal sandbox.
export function createPayeeRegistry(env = process.env, defs = PAYEE_DEFS, { forceMock = false } = {}) {
  const payees = new Map(
    defs.map((def) => [def.key, Object.freeze({ ...def, merchantId: `MERCHANT${def.key.toUpperCase().replace(/_/g, '')}`, credentials: Object.freeze(credentialsFor(def, env, forceMock)) })]),
  )
  return {
    get: (key) => payees.get(key) || null,
    list: () => [...payees.values()],
    // Safe for the browser: never includes credentials.
    publicList: () => [...payees.values()].map(({ credentials, ...rest }) => ({ ...rest, mode: credentials.mode })),
  }
}
