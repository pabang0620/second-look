import test from 'node:test'
import assert from 'node:assert/strict'
import { STATES } from '../server/store.js'
import { PayPalError } from '../server/paypal/errors.js'
import { createGateway } from '../server/paypal/gateway.js'
import { assertSandboxHost } from '../server/paypal/sdkClient.js'
import { createPayeeRegistry } from '../server/paypal/payees.js'
import {
  API_BASE, SELLER_ENV, errorBody, fakePayPal, json, makeSdkEnv, networkDown, withAuthorization, withCapture,
} from './sdkHelpers.js'

const POWER = 'power_company'
const newPayment = (env, extra = {}) => env.lifecycle.createPayment({ payeeKey: POWER, amountCents: 8400, memo: 'electric bill', ...extra })

// Headers the SDK adds on its own, plus the ones a contract-sheet row requires. Anything else on a request is invented.
const SDK_OWN = ['authorization', 'content-type', 'idempotency-key', 'user-agent', 'x-apimatic-gen-version', 'x-apimatic-lang', 'x-apimatic-os', 'x-apimatic-package-version', 'x-apimatic-runtime']
const ROW_REQUIRED = { create: ['paypal-request-id', 'prefer'], authorize: ['paypal-request-id', 'prefer'], capture: ['paypal-request-id', 'prefer'], void: ['paypal-request-id', 'prefer'], getOrder: [], getAuthorization: [] }

// A payment that is already authorized and sitting in a given state, without going through the hold rules.
async function paymentIn(env, state, patch = {}) {
  const p = await newPayment(env)
  env.store.update(p.id, { state, authorizationId: 'AUTH1', authorizedAt: env.clock.now(), voidAt: env.clock.now() + 1e9, captureAt: env.clock.now(), ...patch })
  return env.store.get(p.id)
}

test('sdk_adapter_uses_each_payees_own_token_and_fixed_request_id', async () => {
  const env = makeSdkEnv()
  const power = env.registry.get('power_company')
  const maple = env.registry.get('maple_lane')
  for (const [payee, request] of [[power, 'pay_1:capture'], [maple, 'pay_2:capture'], [power, 'pay_1:capture']]) {
    await env.gateway.captureAuthorization(payee, 'AUTH1', { amountCents: 6500, requestId: request, orderId: 'ORD1' })
  }
  const captures = env.paypal.of('capture')
  assert.deepEqual(captures.map((c) => c.bearer), ['Bearer tok-power-id', 'Bearer tok-maple-id', 'Bearer tok-power-id'])
  assert.deepEqual(captures.map((c) => c.headers.get('paypal-request-id')), ['pay_1:capture', 'pay_2:capture', 'pay_1:capture'])
  assert.equal(env.paypal.of('token').length, 2, 'one client per seller, so one token each and the client is reused')
})

test('capture_amount_is_computed_by_server_code', async () => {
  const env = makeSdkEnv()
  await env.gateway.captureAuthorization(env.registry.get(POWER), 'AUTH1', { amountCents: 8405, requestId: 'x:capture', orderId: 'ORD1' })
  assert.deepEqual(env.paypal.of('capture')[0].body, { amount: { currency_code: 'USD', value: '84.05' }, final_capture: true })
})

test('sdk_requests_carry_no_header_or_field_a_contract_row_does_not_require', async () => {
  const env = makeSdkEnv()
  const p = await newPayment(env, { memo: 'x'.repeat(200) })
  await env.lifecycle.ensureAuthorized(p.id)
  await env.gateway.voidAuthorization(env.registry.get(POWER), 'AUTH1', 'x:void')
  await env.gateway.getOrder(env.registry.get(POWER), 'ORD1')
  await env.gateway.authorizeOrder(env.registry.get(POWER), 'ORD1', 'x:authorize')
  for (const call of env.paypal.calls.filter((c) => c.op !== 'token')) {
    const allowed = new Set([...SDK_OWN, ...ROW_REQUIRED[call.op]])
    for (const name of call.headers.keys()) assert.ok(allowed.has(name), `${call.op} sent unexpected header ${name}`)
  }
  const create = env.paypal.of('create')[0]
  assert.deepEqual(create.body, {
    intent: 'AUTHORIZE',
    purchase_units: [{ reference_id: p.id, amount: { currency_code: 'USD', value: '84.00' }, description: 'x'.repeat(120) }],
    payment_source: { paypal: { experience_context: {
      shipping_preference: 'NO_SHIPPING', contact_preference: 'NO_CONTACT_INFO', return_url: `http://localhost:3001/api/paypal/return?paymentId=${p.id}`,
      cancel_url: `http://localhost:3001/api/paypal/cancel?paymentId=${p.id}`, landing_page: 'NO_PREFERENCE', user_action: 'CONTINUE', payment_method_preference: 'UNRESTRICTED',
    } } },
  })
  assert.equal(create.headers.get('paypal-request-id'), `${p.id}:create`)
  assert.equal(env.paypal.of('void')[0].headers.get('prefer'), 'return=representation')
  assert.equal(env.paypal.of('authorize')[0].headers.get('prefer'), 'return=representation')
  assert.equal(env.paypal.of('void')[0].text, '', 'void sends no body')
  assert.equal(env.paypal.of('getOrder')[0].headers.get('paypal-request-id'), null, 'reads carry no request id')
})

test('sdk_path_runs_create_authorize_capture_and_the_claim_is_in_the_store_when_each_request_leaves', async () => {
  const paypal = fakePayPal()
  const env = makeSdkEnv({ paypal })
  const seen = {}
  paypal.onWire = (call) => {
    const p = env.store.list()[0]
    if (call.op === 'create') seen.create = p.state
    if (call.op === 'authorize') seen.authorize = p.claims.authorize
    if (call.op === 'capture') seen.capture = p.state
  }
  const p = await newPayment(env)
  assert.equal(p.orderId, 'ORD1')
  assert.match(p.approveUrl, /checkout\?token=ORD1/)
  const done = await env.lifecycle.ensureAuthorized(p.id)
  assert.equal(done.state, STATES.CAPTURED)
  assert.equal(done.captureId, 'CAP1')
  assert.equal(seen.create, STATES.CREATED, 'the payment row exists before create_order leaves')
  assert.ok(seen.authorize, 'the authorize claim is written before the request leaves')
  assert.equal(seen.capture, STATES.CAPTURING, 'CAPTURING is written before the capture leaves')
  assert.deepEqual(env.paypal.calls.filter((c) => c.op !== 'token').map((c) => c.op), ['create', 'authorize', 'capture'])
})

test('duplicate_authorize_reaches_paypal_once', async () => {
  const env = makeSdkEnv()
  const p = await newPayment(env)
  await Promise.all([env.lifecycle.ensureAuthorized(p.id), env.lifecycle.ensureAuthorized(p.id), env.lifecycle.ensureAuthorized(p.id)])
  assert.equal(env.paypal.of('authorize').length, 1)
  assert.equal(env.paypal.of('capture').length, 1)
  assert.equal(env.store.get(p.id).state, STATES.CAPTURED)
})

test('duplicate_capture_reaches_paypal_once', async () => {
  const env = makeSdkEnv()
  const p = await paymentIn(env, STATES.APPROVED_PENDING)
  await Promise.all([env.decisions.captureDue(p.id), env.decisions.captureDue(p.id)])
  assert.equal(env.paypal.of('capture').length, 1)
  assert.equal(env.store.get(p.id).state, STATES.CAPTURED)
})

test('duplicate_void_reaches_paypal_once', async () => {
  const paypal = fakePayPal()
  const env = makeSdkEnv({ paypal })
  const p = await paymentIn(env, STATES.HELD)
  let stateOnWire
  paypal.onWire = (call) => { if (call.op === 'void') stateOnWire = env.store.get(p.id).state }
  await Promise.all([env.decisions.stop(p.id), env.decisions.stop(p.id), env.decisions.undo(p.id).catch(() => {})])
  assert.equal(paypal.of('void').length, 1)
  assert.equal(stateOnWire, STATES.VOIDING, 'VOIDING is written before the void leaves')
  assert.equal(env.store.get(p.id).state, STATES.VOIDED)
})

// ----- unknown outcomes: a lost answer is re-read, never reported as a failure -----

test('lost_create_order_response_replays_with_the_same_request_id', async () => {
  const paypal = fakePayPal()
  let first = true
  paypal.on('create', () => { if (first) { first = false; networkDown() } return json(201, { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [] }) })
  const env = makeSdkEnv({ paypal })
  const p = await newPayment(env)
  assert.equal(p.orderId, 'ORD1')
  const creates = paypal.of('create')
  assert.equal(creates.length, 2)
  assert.equal(creates[0].headers.get('paypal-request-id'), creates[1].headers.get('paypal-request-id'))
  assert.equal(paypal.of('getOrder').length, 0, 'no operation finds an order by request id: replay is the only settle')
})

test('lost_authorize_response_is_settled_by_rereading_the_order', async () => {
  const paypal = fakePayPal()
  paypal.on('authorize', networkDown)
  paypal.on('getOrder', () => json(200, withAuthorization()))
  const env = makeSdkEnv({ paypal })
  const p = await newPayment(env)
  const done = await env.lifecycle.ensureAuthorized(p.id)
  assert.equal(paypal.of('authorize').length, 1)
  assert.equal(paypal.of('getOrder').length, 1, 'the order was re-read by id')
  assert.equal(done.state, STATES.CAPTURED, 'the lost answer did not make the payment fail')
})

test('lost_authorize_response_not_found_stays_unknown_and_the_pickup_settles_it', async () => {
  const paypal = fakePayPal()
  paypal.on('authorize', networkDown)
  paypal.on('getOrder', () => json(200, { id: 'ORD1', status: 'APPROVED' }))
  const env = makeSdkEnv({ paypal })
  const p = await newPayment(env)
  const first = await env.lifecycle.ensureAuthorized(p.id)
  assert.equal(first.state, STATES.CREATED, 'unknown is not failed')
  assert.equal(first.failure, null)
  const ids = paypal.of('authorize').map((c) => c.headers.get('paypal-request-id'))
  assert.equal(new Set(ids).size, 1, 'every resend reuses the same PayPal-Request-Id')
  const sent = paypal.of('authorize').length
  await env.lifecycle.ensureAuthorized(p.id)
  assert.equal(paypal.of('authorize').length, sent, 'the held claim stops a second caller before it reaches PayPal')
  paypal.on('getOrder', () => json(200, withAuthorization()))
  const settled = await env.lifecycle.pickUpApproved(p.id)
  assert.equal(settled.state, STATES.CAPTURED)
  assert.equal(paypal.of('authorize').length, sent, 'the pickup settled from the order and did not authorize again')
})

test('lost_capture_response_is_settled_by_rereading_the_order', async () => {
  const paypal = fakePayPal()
  paypal.on('capture', networkDown)
  paypal.on('getOrder', () => json(200, withCapture()))
  const env = makeSdkEnv({ paypal })
  const capture = await env.gateway.captureAuthorization(env.registry.get(POWER), 'AUTH1', { amountCents: 8400, requestId: 'x:capture', orderId: 'ORD1' })
  assert.equal(capture.id, 'CAP1')
  assert.equal(capture.status, 'COMPLETED')
  assert.equal(paypal.of('capture').length, 1)
  assert.equal(paypal.of('getOrder').length, 1)
})

test('lost_capture_response_not_found_is_unknown_and_the_payment_stays_capturing', async () => {
  const paypal = fakePayPal()
  paypal.on('capture', networkDown)
  paypal.on('getOrder', () => json(200, withAuthorization()))
  const env = makeSdkEnv({ paypal })
  const p = await paymentIn(env, STATES.APPROVED_PENDING)
  await assert.rejects(env.gateway.captureAuthorization(env.registry.get(POWER), 'AUTH1', { amountCents: 8400, requestId: 'x:capture', orderId: 'ORD1' }), (e) => e.issue === 'UNKNOWN_OUTCOME' && e.retryable)
  const after = await env.decisions.captureDue(p.id)
  assert.equal(after.state, STATES.CAPTURING, 'not failed: retryStuck settles it later')
  assert.equal(after.failure, null)
})

test('lost_void_response_is_settled_by_rereading_the_authorization', async () => {
  const paypal = fakePayPal()
  paypal.on('void', networkDown)
  paypal.on('getAuthorization', () => json(200, { id: 'AUTH1', status: 'VOIDED' }))
  const env = makeSdkEnv({ paypal })
  const p = await paymentIn(env, STATES.HELD)
  const done = await env.decisions.stop(p.id)
  assert.equal(done.state, STATES.VOIDED)
  assert.equal(paypal.of('void').length, 1)
  assert.equal(paypal.of('getAuthorization').length, 1)
})

test('lost_void_response_not_found_stays_voiding_not_failed', async () => {
  const paypal = fakePayPal()
  paypal.on('void', networkDown)
  const env = makeSdkEnv({ paypal })
  const p = await paymentIn(env, STATES.HELD)
  const after = await env.decisions.stop(p.id)
  assert.equal(after.state, STATES.VOIDING)
  assert.equal(after.failure, null)
})

test('an_empty_success_body_on_void_is_an_unknown_outcome_that_the_reread_settles', async () => {
  const paypal = fakePayPal()
  paypal.on('void', () => new Response(null, { status: 204 }))
  paypal.on('getAuthorization', () => json(200, { id: 'AUTH1', status: 'VOIDED' }))
  const env = makeSdkEnv({ paypal })
  const result = await env.gateway.voidAuthorization(env.registry.get(POWER), 'AUTH1', 'x:void')
  assert.deepEqual(result, { id: 'AUTH1', status: 'VOIDED' })
  assert.equal(paypal.of('getAuthorization').length, 1)
})

test('never_sent_failures_do_not_reread', async () => {
  const paypal = fakePayPal()
  paypal.tokenStatus = 401
  const env = makeSdkEnv({ paypal })
  const payee = env.registry.get(POWER)
  const refused = (e) => e instanceof PayPalError && e.issue === 'CREDENTIAL_FAILED' && e.status === 502 && !e.retryable
  await assert.rejects(env.gateway.authorizeOrder(payee, 'ORD1', 'x:authorize'), refused)
  await assert.rejects(env.gateway.captureAuthorization(payee, 'AUTH1', { amountCents: 100, requestId: 'x:capture', orderId: 'ORD1' }), refused)
  await assert.rejects(env.gateway.voidAuthorization(payee, 'AUTH1', 'x:void'), refused)
  assert.deepEqual(paypal.calls.filter((c) => c.op !== 'token').map((c) => c.op), [], 'no operation and no re-read left the app')
  paypal.tokenStatus = 200
  await assert.rejects(env.gateway.authorizeOrder(payee, undefined, 'x:authorize'), (e) => e.issue === 'ENCODE_FAILED' && !e.retryable)
  assert.equal(paypal.of('authorize').length + paypal.of('getOrder').length, 0, 'a value that would not encode sends nothing and re-reads nothing')
})

// ----- when the API says no -----

test('api_4xx_reason_is_kept_and_shown_in_the_trace', async () => {
  const paypal = fakePayPal()
  paypal.on('authorize', () => json(422, errorBody('UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Order is not approved by the payer')))
  const env = makeSdkEnv({ paypal })
  await assert.rejects(env.gateway.authorizeOrder(env.registry.get(POWER), 'ORD1', 'x:authorize'), (e) => e.status === 422 && e.issue === 'ORDER_NOT_APPROVED' && e.message === 'Order is not approved by the payer' && e.debugId === 'dbg-1')
  const p = await newPayment(env)
  const same = await env.lifecycle.ensureAuthorized(p.id)
  assert.equal(same.state, STATES.CREATED, 'not approved yet: left alone')
  assert.equal(same.claims.authorize, undefined, 'a refusal releases the claim, so a later attempt is not blocked')
  assert.match(env.store.get(p.id).calls.at(-1).detail, /ORDER_NOT_APPROVED/)
})

test('credential_refusal_maps_to_502_without_leaking_the_sdk_message', async () => {
  const paypal = fakePayPal()
  paypal.on('getOrder', () => json(401, errorBody('AUTHENTICATION_FAILURE', 'AUTH', 'Authentication failed due to invalid authentication credentials.')))
  const env = makeSdkEnv({ paypal })
  await assert.rejects(env.gateway.getOrder(env.registry.get(POWER), 'ORD1'), (e) => e.status === 502 && e.issue === 'PROVIDER_CREDENTIALS' && !e.retryable && !/api-m\.sandbox|GET /.test(e.message))
})

test('quota_429_maps_to_503_and_5xx_maps_to_502_retryable', async () => {
  const paypal = fakePayPal()
  paypal.on('capture', () => json(429, errorBody('RATE_LIMIT_REACHED', 'RATE_LIMIT_REACHED')))
  const env = makeSdkEnv({ paypal })
  const payee = env.registry.get(POWER)
  const args = { amountCents: 100, requestId: 'x:capture', orderId: 'ORD1' }
  await assert.rejects(env.gateway.captureAuthorization(payee, 'AUTH1', args), (e) => e.status === 503 && e.issue === 'PROVIDER_BUSY')
  paypal.on('capture', () => new Response(null, { status: 500 }))
  await assert.rejects(env.gateway.captureAuthorization(payee, 'AUTH1', args), (e) => e.status === 502 && e.retryable)
})

test('decode_failure_on_error_status_keeps_status_and_on_success_is_unknown', async () => {
  const paypal = fakePayPal()
  paypal.on('create', () => new Response('<html>nope</html>', { status: 422 }))
  const env = makeSdkEnv({ paypal })
  const payee = env.registry.get(POWER)
  const args = { amountCents: 100, memo: 'm', referenceId: 'r', returnUrl: 'http://x/r', cancelUrl: 'http://x/c', requestId: 'r:create' }
  await assert.rejects(env.gateway.createOrder(payee, args), (e) => e.status === 422 && e.issue === 'UNREADABLE_ERROR_BODY')
  paypal.on('create', () => json(201, { id: 42 }))
  await assert.rejects(env.gateway.createOrder(payee, args), (e) => e.status === 0 && e.issue === 'UNKNOWN_OUTCOME')
})

test('read_connection_failure_maps_to_network_error', async () => {
  const paypal = fakePayPal()
  paypal.on('getOrder', networkDown)
  const env = makeSdkEnv({ paypal })
  await assert.rejects(env.gateway.getOrder(env.registry.get(POWER), 'ORD1'), (e) => e.status === 0 && e.issue === 'NETWORK')
  assert.equal(paypal.of('getOrder').length, 4, 'a GET is retried by the SDK policy: 1 try and 3 retries')
})

// ----- host, transport, REST leftovers -----

test('only_the_sandbox_host_is_accepted_and_a_wrong_host_stops_startup', () => {
  assert.equal(assertSandboxHost(API_BASE), API_BASE)
  for (const bad of ['https://api-m.paypal.com', 'http://api-m.sandbox.paypal.com', 'https://localhost:9999', 'not a url']) assert.throws(() => assertSandboxHost(bad), /PAYPAL_API_BASE/)
  const registry = createPayeeRegistry(SELLER_ENV)
  assert.throws(() => createGateway({ registry, apiBase: 'https://api-m.paypal.com', now: () => 0, publicUrl: 'http://x' }), /PAYPAL_API_BASE/)
  assert.doesNotThrow(() => createGateway({ registry: createPayeeRegistry({}), apiBase: 'https://elsewhere.test', now: () => 0, publicUrl: 'http://x' }), 'no live seller, no SDK client, nothing to bind')
})

test('webhook_verification_stays_on_rest_with_the_sellers_own_credentials', async () => {
  const paypal = fakePayPal()
  const env = makeSdkEnv({ paypal })
  const headers = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'https://api.sandbox.paypal.com/c', 'paypal-transmission-id': 't', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'x' }
  assert.equal(await env.gateway.verifyWebhook(env.registry.get('maple_lane'), { headers, event: { id: 'WH-1' } }), 'SUCCESS')
  const verify = paypal.of('verify')[0]
  assert.equal(verify.body.webhook_id, 'w2')
  assert.equal(verify.bearer, 'Bearer tok-maple-id')
})

test('rest_transport_switch_keeps_the_previous_adapter_for_orders_and_payments', async () => {
  const paypal = fakePayPal()
  paypal.on('authorize', () => json(201, withAuthorization()))
  const env = makeSdkEnv({ paypal, transport: 'rest' })
  await env.gateway.authorizeOrder(env.registry.get(POWER), 'ORD1', 'x:authorize')
  const call = paypal.of('authorize')[0]
  assert.equal(call.headers.get('paypal-request-id'), 'x:authorize')
  assert.equal(call.headers.get('x-apimatic-lang'), null, 'not the SDK')
})
