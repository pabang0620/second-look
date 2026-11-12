import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, authorized, scenario } from './helpers.js'
import { createApp } from '../server/app.js'
import { createLivePayPal } from '../server/paypal/live.js'
import { createPayeeRegistry } from '../server/paypal/payees.js'
import { STATES } from '../server/store.js'
import { HttpError } from '../server/http.js'

test('webhook_with_bad_signature_is_rejected', async () => {
  const env = makeEnv()
  const p = await authorized(env, 1)
  const event = { id: 'WH-FORGED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPFORGED', supplementary_data: { related_ids: { order_id: p.orderId, authorization_id: p.authorizationId } } } }
  const good = env.mock.signedDelivery(p.payeeKey, event)
  const tampered = { ...good.headers, 'paypal-transmission-sig': good.headers['paypal-transmission-sig'].replace(/.$/, (c) => (c === '0' ? '1' : '0')) }
  await assert.rejects(env.webhooks.handle({ payeeKey: p.payeeKey, headers: tampered, event }), (err) => err instanceof HttpError && err.status === 401)
  // A signature made for another seller's app does not verify either.
  const other = env.mock.signedDelivery('maple_lane', event)
  await assert.rejects(env.webhooks.handle({ payeeKey: p.payeeKey, headers: other.headers, event }), HttpError)
  assert.notEqual(env.store.get(p.id).state, STATES.CAPTURED, 'a forged capture event changed nothing')
  assert.equal(env.store.activity().filter((a) => a.kind === 'webhook_rejected').length, 2)
})

test('each_payee_has_its_own_credentials', async () => {
  const env = makeEnv()
  const p = await authorized(env, 2)
  const stranger = env.registry.get('lakeside_tickets')
  await assert.rejects(env.gateway.captureAuthorization(stranger, p.authorizationId, { amountCents: p.amountCents, requestId: 'x:capture' }), (err) => err.issue === 'PERMISSION_DENIED' && err.status === 401)
  await assert.rejects(env.gateway.voidAuthorization(stranger, p.authorizationId, 'x:void'), (err) => err.status === 401)
  assert.equal(env.mock.operationCount('capture'), 0)
})

test('live_adapter_uses_each_payees_own_token_and_fixed_request_id', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization, requestId: init.headers['PayPal-Request-Id'], body: init.body })
    if (url.endsWith('/v1/oauth2/token')) {
      const who = Buffer.from(init.headers.Authorization.split(' ')[1], 'base64').toString().split(':')[0]
      return { ok: true, status: 200, json: async () => ({ access_token: `tok-${who}`, expires_in: 32400 }), text: async () => '' }
    }
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'CAP1', status: 'COMPLETED' }) }
  }
  const env = { PAYEE_MAPLE_LANE_CLIENT_ID: 'maple-id', PAYEE_MAPLE_LANE_CLIENT_SECRET: 's1', PAYEE_MAPLE_LANE_WEBHOOK_ID: 'w1', PAYEE_LAKESIDE_TICKETS_CLIENT_ID: 'lake-id', PAYEE_LAKESIDE_TICKETS_CLIENT_SECRET: 's2', PAYEE_LAKESIDE_TICKETS_WEBHOOK_ID: 'w2' }
  const registry = createPayeeRegistry(env)
  const live = createLivePayPal({ apiBase: 'https://api-m.sandbox.paypal.com', fetchImpl })
  await live.captureAuthorization(registry.get('maple_lane'), 'AUTH-A', { amountCents: 6500, requestId: 'pay_1:capture' })
  await live.captureAuthorization(registry.get('lakeside_tickets'), 'AUTH-B', { amountCents: 12000, requestId: 'pay_2:capture' })
  await live.captureAuthorization(registry.get('maple_lane'), 'AUTH-A', { amountCents: 6500, requestId: 'pay_1:capture' })
  const captures = seen.filter((s) => s.url.includes('/capture'))
  assert.deepEqual(captures.map((c) => c.auth), ['Bearer tok-maple-id', 'Bearer tok-lake-id', 'Bearer tok-maple-id'])
  assert.deepEqual(captures.map((c) => c.requestId), ['pay_1:capture', 'pay_2:capture', 'pay_1:capture'])
  assert.equal(seen.filter((s) => s.url.endsWith('/v1/oauth2/token')).length, 2, 'one token per seller, cached')
  assert.equal(JSON.parse(captures[0].body).amount.value, '65.00')
  assert.equal(JSON.parse(captures[0].body).final_capture, true)
})

let server
let base
let env

before(async () => {
  env = makeEnv()
  const app = createApp(env)
  await new Promise((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server?.close())

const api = async (path, { role, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (role) headers['x-role-token'] = env.store.tokens()[role]
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

test('roles_are_separated_and_inputs_are_validated', async () => {
  const s = scenario(1)
  const pay = { payeeKey: s.payeeKey, amount: '640', memo: s.memo, message: s.message }
  assert.equal((await api('/api/elder/payments', { body: pay })).status, 403, 'no token')
  assert.equal((await api('/api/elder/payments', { role: 'family', body: pay })).status, 403, 'family cannot pay')
  assert.equal((await api('/api/elder/payments', { role: 'elder', body: { ...pay, amount: '-5' } })).status, 400)
  assert.equal((await api('/api/elder/payments', { role: 'elder', body: { ...pay, payeeKey: 'not_a_seller' } })).status, 400)
  const created = await api('/api/elder/payments', { role: 'elder', body: pay })
  assert.equal(created.status, 201)
  const id = created.json.data.id
  env.mock.buyerApprove(env.store.get(id).orderId)
  await env.lifecycle.ensureAuthorized(id)
  await env.investigator.settle(id)
  assert.equal((await api(`/api/family/payments/${id}/approve`, { role: 'elder' })).status, 403, 'the payer cannot approve her own payment')
  assert.equal((await api(`/api/elder/payments/${id}/answer`, { role: 'family', body: { choice: 'Not sure' } })).status, 403, 'family cannot answer for her')
  const family = await api('/api/family/state', { role: 'family', method: 'GET' })
  assert.equal(family.json.data.waiting.length, 1)
  assert.equal(JSON.stringify(family.json).includes('mock-secret'), false, 'no credentials in any response')
  const elder = await api('/api/elder/state', { role: 'elder', method: 'GET' })
  assert.equal(elder.json.data.payments[0].steps, undefined, 'the payer view has no investigation internals')
  const stop = await api(`/api/family/payments/${id}/stop`, { role: 'family', body: {} })
  assert.equal(stop.json.data.state, 'VOIDED')
})

test('webhook_endpoint_checks_signature_over_http', async () => {
  const event = { id: 'WH-HTTP', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: 'AUTHX', supplementary_data: { related_ids: {} } } }
  const signed = env.mock.signedDelivery('maple_lane', event)
  const ok = await fetch(`${base}/api/webhooks/paypal/maple_lane`, { method: 'POST', headers: { ...signed.headers, 'content-type': 'application/json' }, body: signed.body })
  assert.equal(ok.status, 200)
  const bad = await fetch(`${base}/api/webhooks/paypal/maple_lane`, { method: 'POST', headers: { ...signed.headers, 'paypal-transmission-sig': 'nope', 'content-type': 'application/json' }, body: signed.body })
  assert.equal(bad.status, 401)
})
