import { createPayeeRegistry } from '../server/paypal/payees.js'
import { createGateway } from '../server/paypal/gateway.js'
import { createServices } from '../server/services.js'
import { fakeClock } from '../server/clock.js'
import { loadConfig } from '../server/config.js'
import { createMockLlm } from '../server/agent/mockLlm.js'
import { TEST_TIMERS } from './helpers.js'

export const API_BASE = 'https://api-m.sandbox.paypal.com'

export const SELLER_ENV = Object.freeze({
  PAYEE_POWER_COMPANY_CLIENT_ID: 'power-id', PAYEE_POWER_COMPANY_CLIENT_SECRET: 's1', PAYEE_POWER_COMPANY_WEBHOOK_ID: 'w1',
  PAYEE_MAPLE_LANE_CLIENT_ID: 'maple-id', PAYEE_MAPLE_LANE_CLIENT_SECRET: 's2', PAYEE_MAPLE_LANE_WEBHOOK_ID: 'w2',
})

const json = (status, body) => new Response(JSON.stringify(body), { status })

export const errorBody = (name, issue, message = 'The request was refused.') => ({ name, message, debug_id: 'dbg-1', details: [{ issue }] })

const wireOrder = (extra = {}) => ({ id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ href: 'https://paypal.test/checkout?token=ORD1', rel: 'payer-action', method: 'GET' }], ...extra })
export const withAuthorization = (extra = {}) => wireOrder({
  status: 'COMPLETED',
  purchase_units: [{ reference_id: 'pay_x', payments: { authorizations: [{ id: 'AUTH1', status: 'CREATED', amount: { currency_code: 'USD', value: '84.00' } }] } }],
  ...extra,
})
export const withCapture = () => withAuthorization({
  purchase_units: [{ reference_id: 'pay_x', payments: { authorizations: [{ id: 'AUTH1', status: 'CAPTURED' }], captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '84.00' } }] } }],
})

const ROUTES = [
  ['POST', /^\/v1\/oauth2\/token$/, 'token'],
  ['POST', /^\/v1\/notifications\/verify-webhook-signature$/, 'verify'],
  ['POST', /^\/v2\/checkout\/orders$/, 'create'],
  ['GET', /^\/v2\/checkout\/orders\/[^/]+$/, 'getOrder'],
  ['POST', /^\/v2\/checkout\/orders\/[^/]+\/authorize$/, 'authorize'],
  ['POST', /^\/v2\/payments\/authorizations\/[^/]+\/capture$/, 'capture'],
  ['POST', /^\/v2\/payments\/authorizations\/[^/]+\/void$/, 'void'],
  ['GET', /^\/v2\/payments\/authorizations\/[^/]+$/, 'getAuthorization'],
]

export const networkDown = () => { throw new TypeError('fetch failed') }

// A fake PayPal at the fetch seam. The SDK calls fetch(Request); the REST adapter calls fetch(url, init). Both work.
// handlers[op](call) returns a Response (or throws, or returns undefined to use the happy default).
export function fakePayPal(handlers = {}) {
  const calls = []
  const defaults = {
    create: () => json(201, wireOrder()),
    getOrder: () => json(200, wireOrder({ status: 'APPROVED' })),
    authorize: () => json(201, withAuthorization()),
    capture: () => json(201, { id: 'CAP1', status: 'COMPLETED' }),
    void: () => json(200, { id: 'AUTH1', status: 'VOIDED' }),
    getAuthorization: () => json(200, { id: 'AUTH1', status: 'CREATED' }),
    verify: () => json(200, { verification_status: 'SUCCESS' }),
  }
  const api = {
    calls,
    handlers: { ...defaults, ...handlers },
    on(op, fn) { api.handlers[op] = fn },
    of: (op) => calls.filter((c) => c.op === op),
    tokenStatus: 200,
    // Set by the test to look at the app's own store while a request is on the wire.
    onWire: null,
  }
  api.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const text = request.body === null ? '' : await request.clone().text()
    const route = ROUTES.find(([method, re]) => method === request.method && re.test(url.pathname))
    const op = route ? route[2] : 'unknown'
    const basic = request.headers.get('authorization') || ''
    const call = {
      op, method: request.method, path: url.pathname, headers: request.headers, text,
      body: text && op !== 'token' ? JSON.parse(text) : undefined, bearer: basic,
      id: url.pathname.split('/').filter(Boolean).at(-1),
    }
    calls.push(call)
    if (op === 'token') {
      if (api.tokenStatus !== 200) return json(api.tokenStatus, { error: 'invalid_client' })
      const who = Buffer.from(basic.split(' ')[1] || '', 'base64').toString().split(':')[0]
      return json(200, { access_token: `tok-${who}`, token_type: 'Bearer', expires_in: 32400 })
    }
    api.onWire?.(call)
    return (await api.handlers[op]?.(call)) ?? json(500, errorBody('INTERNAL_SERVER_ERROR', 'UNHANDLED_IN_TEST'))
  }
  return api
}

export { json }

// The whole backend over the SDK adapter with two live sellers (power company is trusted, so a low payment is captured at once).
export function makeSdkEnv({ paypal = fakePayPal(), transport = 'sdk' } = {}) {
  const clock = fakeClock()
  const registry = createPayeeRegistry(SELLER_ENV)
  const config = loadConfig({ FORCE_MOCK: '1', DEMO_TIMERS: '0' })
  const gateway = createGateway({
    registry, apiBase: API_BASE, fetchImpl: paypal.fetch, now: clock.now, publicUrl: config.publicUrl,
    transport, sdkRetry: { delay: 0, maxJitter: 0 },
  })
  const svc = createServices({ clock, timers: { ...TEST_TIMERS }, config, llm: createMockLlm(), registry, gateway })
  return { ...svc, clock, paypal, registry }
}
