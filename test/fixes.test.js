import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { makeEnv, authorized, scenario, TEST_TIMERS, MIN } from './helpers.js'
import { createServices } from '../server/services.js'
import { fakeClock } from '../server/clock.js'
import { loadConfig } from '../server/config.js'
import { createMockLlm } from '../server/agent/mockLlm.js'
import { createPayeeRegistry } from '../server/paypal/payees.js'
import { createWebhookHandler } from '../server/payments/webhooks.js'
import { createBudget } from '../server/agent/budget.js'
import { executeTool } from '../server/agent/tools.js'
import { searchPatterns } from '../server/agent/knowledge.js'
import { elderState, householdPublic, paypalPanel } from '../server/routes/state.js'
import { familyView } from '../server/views.js'
import { createHouseholdPool } from '../server/households.js'
import { createApp } from '../server/app.js'
import { STATES } from '../server/store.js'
import { HttpError } from '../server/http.js'

const toolUse = (name, input = {}, id = 't1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] })

async function listen(source) {
  const server = await new Promise((resolve) => { const s = createApp(source).listen(0, () => resolve(s)) })
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

const call = async (base, path, { method = 'POST', body, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

// ----- Defect 1: overlapping payments -----

test('overlapping_payments_show_the_open_question_first_and_panel_follows', async () => {
  const env = makeEnv()
  const first = await authorized(env, 1) // asks Margaret a question
  assert.equal(first.state, STATES.HELD_ASKING)
  env.clock.advance(1000)
  const fourth = await authorized(env, 4) // started while the question is open
  const elder = elderState(env)
  assert.equal(elder.focusId, first.id, 'the payment with the open question stays in front')
  assert.equal(elder.payments.find((p) => p.id === first.id).question.options.length, 4)
  assert.equal(elder.payments.length, 2, 'the newer payment is still listed')
  assert.equal(paypalPanel(env, undefined).paymentId, first.id, 'the PayPal panel stays on the same payment')
  assert.equal(paypalPanel(env, fourth.id).paymentId, fourth.id, 'a picked payment wins')
  env.decisions.answer(first.id, 'An ad or post')
  await env.investigator.settle(first.id)
  assert.equal(elderState(env).focusId, fourth.id, 'once nothing is waiting for an answer the newest is shown')
  const stop = await env.decisions.stop(first.id)
  assert.equal(stop.state, STATES.VOIDED)
})

// ----- Defect 2: whose number -----

test('family_card_calls_the_elders_number_not_the_familys', () => {
  const env = makeEnv()
  const h = householdPublic(env)
  assert.ok(h.elderPhone && h.familyPhone)
  assert.notEqual(h.elderPhone, h.familyPhone)
  assert.equal(h.elderPhone, env.store.household().elder.phone)
})

// ----- Defect 3: usual range wording -----

test('get_elder_context_says_above_the_usual_range', async () => {
  const env = makeEnv()
  const steps = []
  const ctx = (amountCents) => ({ subject: { kind: 'payment', amountCents }, payee: env.registry.get('lakeside_tickets'), household: env.store.household(), gateway: env.gateway, sink: { step: (s) => steps.push(s) } })
  const out = await executeTool('get_elder_context', {}, ctx(12000)) // scenario 4: $120 against $20 to $84
  assert.equal(out.result.above_usual_range, true)
  assert.equal(out.result.well_above_usual, false)
  assert.equal(steps.at(-1).summary, '$120 is above the usual range ($20 to $84)')
  await executeTool('get_elder_context', {}, ctx(6500))
  assert.match(steps.at(-1).summary, /within the usual range/)
  await executeTool('get_elder_context', {}, ctx(8400))
  assert.match(steps.at(-1).summary, /within the usual range/, 'the top of the range is still inside it')
  await executeTool('get_elder_context', {}, ctx(30000))
  assert.match(steps.at(-1).summary, /well above the usual range/)
  await executeTool('get_elder_context', {}, ctx(1000))
  assert.match(steps.at(-1).summary, /below the usual range/)
})

// ----- Defect 4: a slow live call -----

test('live_call_past_the_deadline_finishes_with_what_was_found_not_rules_only', async () => {
  const abortable = {
    mode: 'live',
    calls: 0,
    async step({ deadline, now }) {
      abortable.calls += 1
      if (abortable.calls === 1) return toolUse('get_payment_request')
      // Like an HTTP call with AbortSignal.timeout(deadline): it rejects when the segment time is up.
      return new Promise((_, reject) => setTimeout(() => { const err = new Error('Request timed out.'); err.name = 'TimeoutError'; reject(err) }, Math.max(0, deadline - now())))
    },
  }
  const env = makeEnv({ llm: abortable, timers: { segment1Ms: 150 } })
  const p = await authorized(env, 1)
  assert.equal(abortable.calls, 2, 'no retry after the time is up')
  assert.equal(p.investigation.status, 'done')
  assert.equal(p.investigation.limit, 'timeout')
  assert.equal(p.report.source, 'limit')
  assert.equal(p.state, STATES.HELD)
  const view = familyView(p, { registry: env.registry, now: env.clock.now(), household: env.store.household() })
  assert.equal(view.checkedBy, 'claude', 'the rules-only label is not shown for a slow call')
  assert.ok(p.steps.some((s) => s.tool === 'get_payment_request'), 'what was found is kept')
})

test('rules_only_label_appears_only_for_a_real_api_failure', async () => {
  const broken = { mode: 'live', calls: 0, async step() { broken.calls += 1; const err = new Error('529 overloaded'); err.name = 'APIError'; throw err } }
  const env = makeEnv({ llm: broken })
  const p = await authorized(env, 1)
  assert.equal(broken.calls, 2, 'one retry')
  assert.equal(p.investigation.status, 'rules_only')
  assert.equal(familyView(p, { registry: env.registry, now: env.clock.now(), household: env.store.household() }).checkedBy, 'rules')
  assert.equal(p.state, STATES.HELD, 'still held')
})

// ----- Defect 5: scenario 5 goes through the payer screen -----

test('scenario_5_goes_through_the_elder_api_and_shows_for_both_roles', async () => {
  const pool = createHouseholdPool({ build: () => ({ svc: makeEnv() }) })
  const { base, close } = await listen(pool)
  try {
    const boot = (await call(base, '/api/judge/bootstrap', { method: 'GET' })).json.data
    const headers = { 'x-session': boot.sessionId }
    const five = boot.scenarios.find((s) => s.n === 5)
    assert.equal(five.request.text, scenario(5).request.text, 'the page gets the sentence to send')
    assert.equal((await call(base, '/api/judge/scenario', { body: { n: 5 }, headers })).status, 400, 'the judge route no longer investigates it behind the payer')
    const sent = await call(base, '/api/elder/requests', { body: { text: five.request.text, amount: '500.00' }, headers: { 'x-role-token': boot.tokens.elder } })
    assert.equal(sent.status, 201)
    assert.deepEqual(sent.json.data.findings.map((f) => f.kind).sort(), ['gift_card', 'secrecy'])
    const state = (await call(base, '/api/judge/state', { method: 'GET', headers })).json.data
    assert.equal(state.elder.requests.length, 1, 'Margaret has the result')
    assert.equal(state.family.requests.length, 1, 'Sarah has the alert')
  } finally {
    close()
  }
})

// ----- Defect 6: order events and orders left in CREATED -----

test('order_approved_webhook_matches_on_resource_id', async () => {
  const env = makeEnv()
  const s = scenario(2)
  const payment = await env.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: '' })
  env.mock.buyerApprove(payment.orderId)
  const [event] = env.mock.pendingEvents()
  assert.equal(event.event_type, 'CHECKOUT.ORDER.APPROVED')
  assert.equal(event.resource.supplementary_data, undefined, 'like PayPal, the order event carries no related ids')
  assert.equal(event.resource.id, payment.orderId)
  await env.mock.flush()
  await env.investigator.settle(payment.id)
  const after = env.store.get(payment.id)
  assert.notEqual(after.state, STATES.CREATED, 'the event alone moved the payment on')
  assert.ok(after.webhooks.some((w) => w.type === 'CHECKOUT.ORDER.APPROVED'))
})

test('scheduler_picks_up_an_approved_order_nobody_told_us_about', async () => {
  const env = makeEnv()
  const s = scenario(2)
  const approved = await env.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: '' })
  const waiting = await env.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: '' })
  env.mock.buyerApprove(approved.orderId) // the payer closed the window: no return, no webhook delivered
  env.clock.advance(11000)
  await env.scheduler.tick()
  await env.investigator.settle(approved.id)
  assert.equal(env.store.get(approved.id).state, STATES.HELD)
  assert.equal(env.store.get(waiting.id).state, STATES.CREATED, 'an order that was never approved is left alone')
  assert.equal(env.mock.operationCount('authorize'), 1)
  env.clock.advance(11000)
  await env.scheduler.tick()
  assert.equal(env.mock.operationCount('authorize'), 1, 'no second authorize')
})

// ----- Defect 7: one household per visitor -----

test('each_visitor_gets_a_separate_household_and_reset_is_local', async () => {
  const pool = createHouseholdPool({ build: () => ({ svc: makeEnv() }) })
  const { base, close } = await listen(pool)
  try {
    const boot = async (session) => (await call(base, '/api/judge/bootstrap', { method: 'GET', headers: session ? { 'x-session': session } : {} })).json.data
    const a = await boot()
    const b = await boot()
    assert.notEqual(a.sessionId, b.sessionId)
    assert.notEqual(a.tokens.elder, b.tokens.elder)
    assert.notEqual(a.tokens.family, b.tokens.family)
    assert.deepEqual((await boot(a.sessionId)).tokens, a.tokens, 'the same visitor keeps the same household')
    const ha = { 'x-session': a.sessionId }
    const hb = { 'x-session': b.sessionId }
    const made = await call(base, '/api/judge/scenario', { body: { n: 1 }, headers: ha })
    assert.equal(made.status, 201)
    const id = made.json.data.payment.id
    const stateOf = async (h) => (await call(base, '/api/judge/state', { method: 'GET', headers: h })).json.data
    assert.equal((await stateOf(ha)).elder.payments.length, 1)
    assert.equal((await stateOf(hb)).elder.payments.length, 0, 'B does not see A\'s payment')
    // B's tokens cannot touch A's payment.
    const stop = await call(base, `/api/family/payments/${id}/stop`, { body: {}, headers: { 'x-role-token': b.tokens.family } })
    assert.equal(stop.status, 404)
    assert.equal((await call(base, '/api/judge/state', { method: 'GET' })).status, 401, 'no session, no state')
    // B resets: A is untouched. A resets: A is empty.
    assert.equal((await call(base, '/api/judge/reset', { headers: hb })).status, 200)
    assert.equal((await stateOf(ha)).elder.payments.length, 1)
    assert.equal((await call(base, '/api/judge/reset', { headers: ha })).status, 200)
    assert.equal((await stateOf(ha)).elder.payments.length, 0)
    assert.equal((await call(base, '/api/family/state', { method: 'GET', headers: { 'x-role-token': a.tokens.elder } })).status, 403, 'roles stay separate inside a household')
  } finally {
    close()
  }
})

test('household_pool_drops_idle_and_oldest_households', () => {
  let t = 0
  const disposed = []
  let n = 0
  const pool = createHouseholdPool({ build: () => { n += 1; const id = n; return { svc: { store: { tokens: () => ({ elder: `e${id}`, family: `f${id}` }) } }, dispose: () => disposed.push(id) } }, ttlMs: 1000, max: 2, now: () => t })
  const first = pool.open()
  t = 10
  pool.open()
  t = 20
  pool.open() // full: the oldest idle one (1) goes
  assert.deepEqual(disposed, [1])
  assert.equal(pool.get(first.id), null)
  t = 5000
  pool.open() // everything else is idle for more than the ttl
  assert.equal(pool.size(), 1)
})

// ----- Defect 8: the local-mode webhook key -----

test('local_mode_webhook_key_is_not_in_the_code_and_never_valid_for_a_live_seller', async () => {
  const env = makeEnv()
  const event = { id: 'WH-KEY', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: 'AUTHZ' } }
  const signed = env.mock.signedDelivery('maple_lane', event)
  const old = createHmac('sha256', 'mock-paypal-webhook-signing-key').update(`${signed.headers['paypal-transmission-id']}|${signed.headers['paypal-transmission-time']}|mock-webhook-maple_lane|${signed.body}`).digest('hex')
  assert.notEqual(signed.headers['paypal-transmission-sig'], old, 'the old public key does not sign anything')

  const registry = createPayeeRegistry({ PAYEE_MAPLE_LANE_CLIENT_ID: 'id', PAYEE_MAPLE_LANE_CLIENT_SECRET: 'secret', PAYEE_MAPLE_LANE_WEBHOOK_ID: 'WH-LIVE' })
  let fetched = 0
  const live = createServices({
    clock: fakeClock(), timers: TEST_TIMERS, config: loadConfig({ FORCE_MOCK: '1', DEMO_TIMERS: '0' }), llm: createMockLlm(), registry,
    fetchImpl: async () => { fetched += 1; throw new Error('no network in tests') },
  })
  await assert.rejects(live.webhooks.handle({ payeeKey: 'maple_lane', headers: signed.headers, event }), (err) => err instanceof HttpError && err.status === 401)
  assert.equal(fetched, 0, 'a mock-signed event is refused before PayPal is even asked')
  const real = { ...signed.headers, 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1' }
  await assert.rejects(live.webhooks.handle({ payeeKey: 'maple_lane', headers: real, event }), HttpError)
  assert.ok(fetched > 0, 'a real-looking event is sent to PayPal for verification')
})

// ----- Defect 9: event id after success -----

test('event_id_is_recorded_only_after_the_event_was_processed', async () => {
  const env = makeEnv()
  const s = scenario(2)
  const payment = await env.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: '' })
  env.mock.buyerApprove(payment.orderId)
  const [event] = env.mock.pendingEvents()
  const signed = env.mock.signedDelivery(payment.payeeKey, event)
  let fail = true
  const lifecycle = { ensureAuthorized: async () => { if (fail) { fail = false; throw new Error('database was down') } }, applyFact: () => {} }
  const handler = createWebhookHandler({ store: env.store, registry: env.registry, gateway: env.gateway, clock: env.clock, lifecycle })
  const args = { payeeKey: payment.payeeKey, headers: signed.headers, event }
  await assert.rejects(handler.handle(args), /database was down/)
  assert.equal(env.store.hasEvent(event.id), false, 'a failed run does not use up the event id')
  assert.equal(env.store.get(payment.id).webhooks.length, 0)
  assert.deepEqual(await handler.handle(args), { duplicate: false, matched: true }, 'PayPal\'s redelivery is processed')
  assert.deepEqual(await handler.handle(args), { duplicate: true })
  assert.equal(env.store.get(payment.id).webhooks.length, 1)
})

// ----- Defect 10: call counter wording -----

test('hard_focus_starts_after_13_calls_as_the_readme_says', () => {
  assert.equal(createBudget({ segment: 1, total: 12 }).check('get_payment_request').ok, true, 'the 13th call is allowed')
  assert.equal(createBudget({ segment: 1, total: 13 }).check('get_payment_request').ok, false, 'the 14th call is not')
  assert.equal(createBudget({ segment: 1, total: 13 }).check('write_report').ok, true)
  assert.equal(createBudget({ segment: 1, total: 13 }).check('ask_elder').ok, true)
})

// ----- Defect 11: return page wording follows the payment -----

test('return_redirect_tells_the_page_what_happened', async () => {
  const env = makeEnv()
  const { base, close } = await listen(env)
  try {
    const run = async (n, approve = true) => {
      const s = scenario(n)
      const payment = await env.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: s.message })
      if (approve) env.mock.buyerApprove(payment.orderId)
      const res = await fetch(`${base}/api/paypal/return?paymentId=${payment.id}`, { redirect: 'manual' })
      await env.investigator.settle(payment.id)
      return res.headers.get('location')
    }
    assert.match(await run(3), /outcome=captured/, 'a known seller is paid at once')
    assert.match(await run(1), /outcome=held/)
    assert.match(await run(2, false), /outcome=waiting/, 'not approved yet')
  } finally {
    close()
  }
})

// ----- Defect 12: capture status -----

test('capture_pending_waits_for_the_webhook_and_declined_is_failed', async () => {
  const env = makeEnv()
  const p = await authorized(env, 2)
  await env.decisions.approve(p.id)
  let captures = 0
  env.mock.captureAuthorization = async () => { captures += 1; return { id: 'CAPPEND', status: 'PENDING' } }
  env.clock.advance(16 * MIN)
  await env.scheduler.tick()
  let now = env.store.get(p.id)
  assert.equal(now.state, STATES.CAPTURING, 'PENDING is not captured')
  assert.equal(now.captureId, 'CAPPEND')
  assert.equal(now.paypalStatus, 'CAPTURE_PENDING')
  env.clock.advance(31000)
  await env.scheduler.tick()
  assert.equal(captures, 1, 'a pending capture is not captured again')
  const event = { id: 'WH-DONE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPPEND', supplementary_data: { related_ids: { order_id: p.orderId, authorization_id: p.authorizationId } } } }
  await env.webhooks.handle({ payeeKey: p.payeeKey, headers: env.mock.signedDelivery(p.payeeKey, event).headers, event })
  now = env.store.get(p.id)
  assert.equal(now.state, STATES.CAPTURED)

  const d = await authorized(env, 2)
  await env.decisions.approve(d.id)
  env.mock.captureAuthorization = async () => ({ id: 'CAPDECL', status: 'DECLINED' })
  env.clock.advance(16 * MIN)
  await env.scheduler.tick()
  const declined = env.store.get(d.id)
  assert.equal(declined.state, STATES.FAILED)
  assert.match(declined.failure, /Nothing was charged/)
})

// ----- Defect 13: family impersonation wording -----

test('family_impersonation_patterns_cover_common_phrasings', () => {
  const hit = (text) => searchPatterns(text).some((m) => m.type === 'family_impersonation')
  for (const text of [
    'I am in jail and need bail money.',
    'Grandma, it is me. I got arrested last night.',
    "Hi, it's me, your grandson. I'm in trouble.",
    'This is your granddaughter, please do not call mom.',
    'I was in a car accident and I am in the hospital.',
    'Im in jail',
  ]) assert.equal(hit(text), true, text)
  assert.equal(hit('I am in the garden today.'), false)
  assert.equal(hit('Your seedlings ship on Tuesday.'), false)
})
