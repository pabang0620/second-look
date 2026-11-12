import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, authorized, scenario, HOUR } from './helpers.js'
import { fakeClock } from '../server/clock.js'
import { createLiveGuard, RULES_LABEL } from '../server/agent/liveGuard.js'
import { createMockLlm } from '../server/agent/mockLlm.js'
import { createReplayLlm } from '../server/agent/replayLlm.js'
import { loadRecordedRuns } from '../server/agent/recordedRuns.js'
import { loadConfig } from '../server/config.js'
import { familyView } from '../server/views.js'
import { STATES } from '../server/store.js'

const RUNS = loadRecordedRuns().filter((r) => !r.key.endsWith('|sandbox'))
const label = (env, p) => familyView(env.store.get(p.id), { registry: env.registry, now: env.clock.now(), household: env.store.household() }).modelLabel

// A fake live model: counts runs by turn, can throw.
function fakeLive({ fail = false, error = new Error('529 overloaded') } = {}) {
  const live = { mode: 'live', label: 'Claude (API)', turns: 0, fail, async step(args) {
    live.turns += 1
    if (live.fail) throw error
    return createMockLlm().step(args).then((r) => ({ ...r, source: 'Claude (API)' }))
  } }
  return live
}
const guardOf = (live, opts = {}) => createLiveGuard({ live, fallback: createMockLlm(), ...opts })

test('live_failure_finishes_on_the_rule_based_stand_in_and_the_hold_stays', async () => {
  const live = fakeLive({ fail: true })
  const env = makeEnv({ llm: guardOf(live) })
  const p = await authorized(env, 2)
  assert.ok([STATES.HELD, STATES.HELD_ASKING].includes(p.state), `still held, got ${p.state}`)
  assert.equal(p.paypalStatus, 'AUTHORIZED')
  assert.ok(p.report, 'the investigation still wrote a report')
  assert.notEqual(p.investigation.status, 'rules_only')
  assert.match(label(env, p), new RegExp(`^${RULES_LABEL} \\(live model unavailable\\)$`))
  assert.equal(env.mock.captureCalls?.length ?? 0, 0)
})

test('live_failure_uses_the_recorded_run_when_one_matches_the_scene', async () => {
  const replay = createReplayLlm({ runs: RUNS, fallback: createMockLlm(), paceMs: 0 })
  const env = makeEnv({ llm: createLiveGuard({ live: fakeLive({ fail: true }), fallback: replay }) })
  const p = await authorized(env, 2)
  assert.match(label(env, p), /^Recorded run: Claude Sonnet, \d{4}-\d{2}-\d{2} \(live model unavailable\)$/)
  assert.ok(p.report)
  assert.ok([STATES.HELD, STATES.HELD_ASKING].includes(p.state))
})

test('live_timeout_is_labelled_as_a_timeout_not_an_error', async () => {
  const err = Object.assign(new Error('aborted'), { name: 'TimeoutError' })
  const env = makeEnv({ llm: guardOf(fakeLive({ fail: true, error: err })) })
  const p = await authorized(env, 2)
  assert.ok(p.report)
  assert.ok([STATES.HELD, STATES.HELD_ASKING].includes(p.state))
  assert.match(label(env, p) || '', /live model timed out/)
})

test('a_failed_model_never_captures_a_held_payment', async () => {
  const env = makeEnv({ llm: guardOf(fakeLive({ fail: true })) })
  const p = await authorized(env, 1)
  assert.notEqual(p.state, STATES.CAPTURED)
  assert.notEqual(p.state, STATES.CAPTURING)
  assert.equal(p.paypalStatus, 'AUTHORIZED')
})

test('one_run_counts_once_however_many_tool_turns_it_takes', async () => {
  const live = fakeLive()
  const clock = fakeClock()
  const llm = guardOf(live, { perIpHour: 1, now: clock.now })
  const env = makeEnv({ llm })
  env.client.ip = '10.0.0.1'
  const p = await authorized(env, 2)
  assert.ok(live.turns > 2, 'several turns in one run')
  assert.match(label(env, p), /^Claude \(API\)$/)
})

test('hourly_cap_per_ip_sends_the_next_run_to_the_fallback_until_the_window_passes', async () => {
  const live = fakeLive()
  const clock = fakeClock()
  const llm = guardOf(live, { perIpHour: 2, perDay: 100, now: clock.now })
  const env = makeEnv({ llm })
  env.client.ip = '10.0.0.1'
  const sources = []
  for (let i = 0; i < 3; i += 1) {
    const p = await authorized(env, 2)
    sources.push(label(env, p))
  }
  assert.deepEqual(sources.slice(0, 2), ['Claude (API)', 'Claude (API)'])
  assert.equal(sources[2], `${RULES_LABEL} (live limit reached)`)
  env.client.ip = '10.0.0.2'
  assert.equal(label(env, await authorized(env, 2)), 'Claude (API)', 'another address has its own allowance')
  env.client.ip = '10.0.0.1'
  clock.advance(HOUR + 1000)
  assert.equal(label(env, await authorized(env, 2)), 'Claude (API)', 'the window moved on')
})

test('daily_cap_per_host_applies_to_every_address', async () => {
  const live = fakeLive()
  const clock = fakeClock()
  const llm = guardOf(live, { perIpHour: 10, perDay: 2, now: clock.now })
  const env = makeEnv({ llm })
  const out = []
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
    env.client.ip = ip
    out.push(label(env, await authorized(env, 2)))
  }
  assert.deepEqual(out, ['Claude (API)', 'Claude (API)', `${RULES_LABEL} (live limit reached)`])
  clock.advance(24 * HOUR + 1000)
  env.client.ip = '4.4.4.4'
  assert.equal(label(env, await authorized(env, 2)), 'Claude (API)')
})

test('a_pasted_request_also_finishes_when_the_live_model_throws', async () => {
  const env = makeEnv({ llm: guardOf(fakeLive({ fail: true })) })
  const record = await env.investigator.checkRequest({ text: 'Please buy me two gift cards and send me the codes, do not tell anyone', amountCents: 20000 })
  assert.ok(record.report)
  assert.match(record.modelSources[1][0], /live model unavailable/)
})

test('the_caps_come_from_the_environment_with_defaults_10_and_150', () => {
  assert.deepEqual(loadConfig({}).liveLimits, { perIpHour: 10, perDay: 150 })
  assert.deepEqual(loadConfig({ LLM_LIVE_PER_IP_HOUR: '3', LLM_LIVE_PER_DAY: '40' }).liveLimits, { perIpHour: 3, perDay: 40 })
})
