import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, authorized } from './helpers.js'
import { createServices } from '../server/services.js'
import { loadConfig } from '../server/config.js'
import { createPayeeRegistry } from '../server/paypal/payees.js'
import { selectLlm } from '../server/agent/selectLlm.js'
import { createAccountLlm, withoutApiKey, transcriptOf } from '../server/agent/accountLlm.js'
import { claudeTools } from '../server/agent/tools.js'
import { elderState, familyState, paypalPanel } from '../server/routes/state.js'
import { pinAfterScenario } from '../client/src/judgeLogic.js'

const KEYS = { PAYEE_MAPLE_LANE_CLIENT_ID: 'id', PAYEE_MAPLE_LANE_CLIENT_SECRET: 'secret', PAYEE_MAPLE_LANE_WEBHOOK_ID: 'WH' }

// ----- FORCE_MOCK -----

test('force_mock_ignores_paypal_keys', () => {
  assert.equal(createPayeeRegistry(KEYS).get('maple_lane').credentials.mode, 'sandbox', 'without the flag the keys are used')
  assert.equal(createPayeeRegistry(KEYS, undefined, { forceMock: true }).get('maple_lane').credentials.mode, 'mock')
  const config = loadConfig({ ...KEYS, FORCE_MOCK: '1', ANTHROPIC_API_KEY: 'sk-x', LLM_BACKEND: 'account' })
  const svc = createServices({ config })
  assert.ok(svc.registry.list().every((p) => p.credentials.mode === 'mock'))
  assert.equal(svc.llm.mode, 'mock', 'neither the API key nor the account backend is used')
  assert.equal(selectLlm(config), undefined)
})

// ----- scenario button brings its payment to the phone -----

test('scenario_payment_replaces_the_pinned_payment_on_the_phone', async () => {
  const env = makeEnv()
  const first = await authorized(env, 1)
  assert.equal(pinAfterScenario(first.id, { payment: { id: 'pay_deadbeef' } }), 'pay_deadbeef', 'the new payment wins over the picked one')
  assert.equal(pinAfterScenario(first.id, { payment: null }), first.id, 'scenario 5 creates no payment, the pick stays')
  const second = await authorized(env, 2)
  const elder = elderState(env)
  assert.ok(elder.payments.some((p) => p.id === second.id), 'the new payment is in the phone list')
  assert.equal(paypalPanel(env, pinAfterScenario(first.id, { payment: { id: second.id } })).paymentId, second.id, 'the PayPal panel follows it')
})

// ----- first visit: no 401, no reload loop -----

function browser({ session = '' } = {}) {
  const store = new Map(session ? [['secondlook.session', session]] : [])
  const log = { reloads: 0, calls: [] }
  globalThis.window = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, location: { reload: () => { log.reloads += 1 } } }
  globalThis.fetch = async (path, init) => {
    const sent = init.headers['x-session'] || ''
    log.calls.push({ path, sent })
    const known = path.endsWith('/bootstrap') ? true : sent === 'sess_ok'
    const body = path.endsWith('/bootstrap') ? { success: true, data: { sessionId: 'sess_ok', tokens: {} } } : known ? { success: true, data: { fine: true } } : { success: false, message: 'ended' }
    return { status: known ? 200 : 401, ok: known, json: async () => body }
  }
  return log
}

test('first_visit_state_request_waits_for_bootstrap_and_never_reloads', async () => {
  const log = browser()
  const api = await import(`../client/src/api.js?first=${Math.random()}`)
  const [a, b] = await Promise.all([api.judge('GET', '/state'), api.judge('GET', '/state')])
  assert.deepEqual([a.fine, b.fine], [true, true])
  assert.equal(log.reloads, 0)
  assert.equal(log.calls.filter((c) => c.path.endsWith('/bootstrap')).length, 1, 'one bootstrap for two callers')
  assert.equal(log.calls.find((c) => c.path.endsWith('/state')).sent, 'sess_ok', 'the first state request already carries the session')
})

test('401_reloads_only_when_a_session_was_sent', async () => {
  const api = await import(`../client/src/api.js?stale=${Math.random()}`)
  assert.equal(api.shouldReload({ status: 401, sentSession: '', hasToken: false }), false)
  assert.equal(api.shouldReload({ status: 401, sentSession: 'sess_old', hasToken: false }), true)
  assert.equal(api.shouldReload({ status: 403, sentSession: 'sess_old', hasToken: true }), true)
  assert.equal(api.shouldReload({ status: 403, sentSession: 'sess_old', hasToken: false }), false)
  const log = browser({ session: 'sess_gone' })
  const fresh = await import(`../client/src/api.js?stale2=${Math.random()}`)
  await fresh.judge('GET', '/state') // bootstrap replaces the stale id, so this request is accepted
  assert.equal(log.reloads, 0)
})

// ----- account backend -----

const fakeSdk = (script, seen = {}) => ({
  tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
  createSdkMcpServer: (o) => ({ ...o, instance: true }),
  query: (args) => {
    seen.options = args.options
    seen.prompt = args.prompt
    return (async function* () {
      for (const m of script) yield m
    })()
  },
})
const stepArgs = (messages = [{ role: 'user', content: 'Check payment pay_1' }]) => ({ system: 'SYS', tools: claudeTools(), messages, deadline: Date.now() + 5000, now: Date.now })

test('account_adapter_strips_api_key_and_maps_tool_calls', async () => {
  assert.deepEqual(Object.keys(withoutApiKey({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin' })), ['PATH'])
  const seen = {}
  const script = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__secondlook__get_payment_request', input: {} }, { type: 'tool_use', id: 'toolu_2', name: 'mcp__secondlook__get_order', input: {} }] } },
    { type: 'result', subtype: 'error_max_turns', is_error: true },
  ]
  const llm = createAccountLlm({ model: 'claude-sonnet-5-5', loadSdk: async () => fakeSdk(script, seen), env: { ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_AUTH_TOKEN: 'tok', HOME: '/h' } })
  assert.equal(llm.mode, 'account')
  assert.match(llm.label, /local account/)
  const out = await llm.step(stepArgs())
  assert.equal(out.stop_reason, 'tool_use')
  assert.deepEqual(out.content.map((b) => [b.type, b.id, b.name]), [['tool_use', 'toolu_1', 'get_payment_request'], ['tool_use', 'toolu_2', 'get_order']])
  assert.equal(seen.options.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(seen.options.env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(seen.options.env.HOME, '/h')
  assert.equal(seen.options.maxTurns, 1)
  assert.deepEqual(seen.options.settingSources, [])
  assert.match(seen.options.systemPrompt, /^SYS/)
  assert.ok(!JSON.stringify(seen.options.mcpServers).includes('capture'), 'no money tool is exposed')
})

test('account_adapter_reports_text_only_turns_and_failures', async () => {
  const text = createAccountLlm({ model: 'm', loadSdk: async () => fakeSdk([{ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }]) })
  assert.equal((await text.step(stepArgs())).stop_reason, 'end_turn')
  const bad = createAccountLlm({ model: 'm', loadSdk: async () => fakeSdk([{ type: 'result', subtype: 'error_during_execution', is_error: true }]) })
  await assert.rejects(() => bad.step(stepArgs()), /Account model failed/)
})

test('account_adapter_transcript_carries_tool_results', () => {
  const text = transcriptOf([
    { role: 'user', content: 'Check it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'get_order', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: '{"status":"CREATED"}' }] },
  ])
  assert.match(text, /RESULT of get_order: \{"status":"CREATED"\}/)
})

test('select_llm_prefers_account_backend_and_never_reads_the_key_there', () => {
  const llm = selectLlm(loadConfig({ LLM_BACKEND: 'account', ANTHROPIC_API_KEY: 'sk-x' }))
  assert.equal(llm.mode, 'account')
  assert.equal(selectLlm(loadConfig({})), undefined)
})

test('account_adapter_accepts_the_sdk_max_turns_error_after_tool_calls', async () => {
  const sdk = fakeSdk([])
  sdk.query = () => (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_7', name: 'mcp__secondlook__get_order', input: {} }] } }
    throw new Error('Claude Code returned an error result: Reached maximum number of turns (1)')
  })()
  const out = await createAccountLlm({ model: 'm', loadSdk: async () => sdk }).step(stepArgs())
  assert.equal(out.content[0].name, 'get_order')
  const none = fakeSdk([]); none.query = () => (async function* () { throw new Error('login required') })()
  await assert.rejects(() => createAccountLlm({ model: 'm', loadSdk: async () => none }).step(stepArgs()), /login required/)
})

// ----- Sarah's summary line, tool source label -----

test('family_impact_summary_sums_stored_payments_only', async () => {
  const env = makeEnv()
  assert.equal(familyState(env).impact.any, false)
  const shop = await authorized(env, 1)
  await env.decisions.stop(shop.id)
  const real = await authorized(env, 2)
  env.decisions.approve(real.id)
  env.clock.advance(16 * 60 * 1000)
  await env.scheduler.tick()
  const late = await authorized(env, 4)
  env.clock.advance(71 * 3600 * 1000)
  await env.scheduler.tick()
  await env.investigator.settle(late.id)
  const { impact } = familyState(env)
  assert.equal(impact.stopped, '$640')
  assert.equal(impact.paid, '$65')
  assert.equal(impact.released, '$120')
  assert.equal(impact.any, true)
})

test('get_order_step_names_the_local_stand_in_when_no_sandbox_keys', async () => {
  const env = makeEnv()
  const p = await authorized(env, 1)
  assert.equal(p.steps.find((s) => s.tool === 'get_order').source, 'local PayPal stand-in')
})
