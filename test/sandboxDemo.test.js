import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, authorized } from './helpers.js'
import { loadRecordedRuns } from '../server/agent/recordedRuns.js'
import { createReplayLlm, recordedLabel, replayKeyOf } from '../server/agent/replayLlm.js'
import { createMockLlm } from '../server/agent/mockLlm.js'
import { localLlm, selectLlm } from '../server/agent/selectLlm.js'
import { loadConfig } from '../server/config.js'
import { createPayeeRegistry } from '../server/paypal/payees.js'
import { familyView, readableQuote } from '../server/views.js'
import { STATES } from '../server/store.js'

const ALL = loadRecordedRuns()
const SANDBOX = ALL.find((r) => r.key.endsWith('|sandbox'))
const MONEY_TOOLS = ['capture', 'void', 'release', 'refund', 'approve']

test('sandbox_recording_of_scenario_1_read_a_real_sandbox_order_and_has_no_money_tool', () => {
  assert.ok(SANDBOX, 'scenario-1-sandbox.json exists')
  assert.equal(SANDBOX.scenario, 1)
  assert.equal(SANDBOX.modelName, 'Claude Sonnet')
  const calls = [...SANDBOX.segment1, ...Object.values(SANDBOX.afterAnswer).flat()].flatMap((t) => t.calls)
  assert.ok(calls.every((c) => !MONEY_TOOLS.some((m) => c.name.includes(m))))
  const order = JSON.parse(calls.find((c) => c.name === 'get_order').result)
  assert.match(order.payee_email, /@business\.example\.com$/, 'the order came from the PayPal sandbox, not the local stand-in')
  assert.ok(calls.some((c) => c.name === 'ask_elder'))
  assert.deepEqual(Object.keys(SANDBOX.afterAnswer), ['An ad or post'])
})

test('replay_key_keeps_sandbox_and_local_recordings_apart', () => {
  const subject = { kind: 'payment', amountCents: 64000, memo: 'm', message: 'x', secondRequest: false }
  assert.notEqual(replayKeyOf(subject, 'mobility_direct', 'sandbox'), replayKeyOf(subject, 'mobility_direct'))
  assert.equal(replayKeyOf(subject, 'mobility_direct', 'mock'), replayKeyOf(subject, 'mobility_direct'))
})

test('a_local_seller_still_replays_the_local_recording_when_the_sandbox_one_is_loaded', async () => {
  const env = makeEnv({ llm: createReplayLlm({ runs: ALL, fallback: createMockLlm(), paceMs: 0 }) })
  const p = await authorized(env, 1)
  assert.equal(p.state, STATES.HELD_ASKING)
  const local = ALL.find((r) => r.scenario === 1 && !r.key.endsWith('|sandbox'))
  const view = familyView(env.store.get(p.id), { registry: env.registry, now: env.clock.now(), household: env.store.household() })
  assert.equal(view.modelLabel, recordedLabel(local))
})

test('sandbox_sellers_limits_the_sandbox_to_the_named_sellers', () => {
  const keys = { PAYEE_MOBILITY_DIRECT_CLIENT_ID: 'a', PAYEE_MOBILITY_DIRECT_CLIENT_SECRET: 'b', PAYEE_MAPLE_LANE_CLIENT_ID: 'c', PAYEE_MAPLE_LANE_CLIENT_SECRET: 'd' }
  const all = createPayeeRegistry(keys)
  assert.equal(all.get('maple_lane').credentials.mode, 'sandbox')
  const one = createPayeeRegistry({ ...keys, SANDBOX_SELLERS: 'mobility_direct' })
  assert.equal(one.get('mobility_direct').credentials.mode, 'sandbox')
  assert.equal(one.get('maple_lane').credentials.mode, 'mock')
  assert.equal(createPayeeRegistry({ ...keys, SANDBOX_SELLERS: 'mobility_direct' }, undefined, { forceMock: true }).get('mobility_direct').credentials.mode, 'mock')
})

test('replay_backend_never_reads_the_api_key_but_keeps_paypal_keys', () => {
  const config = loadConfig({ LLM_BACKEND: 'replay', ANTHROPIC_API_KEY: 'sk-x', PAYEE_MAPLE_LANE_CLIENT_ID: 'id', PAYEE_MAPLE_LANE_CLIENT_SECRET: 'secret' })
  assert.equal(config.anthropicKey, '')
  assert.equal(config.paypalLocal, false)
  assert.equal(selectLlm(config), undefined)
  assert.equal(localLlm(config, { runs: ALL }).mode, 'replay')
})

test('family_view_turns_quoted_field_names_into_words', () => {
  assert.equal(readableQuote('typical_max_usd 84.00, this_payment_usd 120.00, above_usual_range true'), 'typical max: $84.00, this payment: $120.00, above usual range: yes')
  assert.equal(readableQuote("Don't tell your son, it's a surprise."), "Don't tell your son, it's a surprise.")
})
