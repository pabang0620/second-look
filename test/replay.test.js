import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, authorized, scenario } from './helpers.js'
import { loadRecordedRuns } from '../server/agent/recordedRuns.js'
import { createReplayLlm, recordedLabel, SCRIPTED_LABEL } from '../server/agent/replayLlm.js'
import { createMockLlm } from '../server/agent/mockLlm.js'
import { localLlm } from '../server/agent/selectLlm.js'
import { loadConfig } from '../server/config.js'
import { familyView } from '../server/views.js'
import { STATES } from '../server/store.js'

const RUNS = loadRecordedRuns()
const replay = (runs = RUNS) => createReplayLlm({ runs, fallback: createMockLlm(), paceMs: 0 })
const MONEY_TOOLS = ['capture', 'void', 'release', 'refund', 'approve']
const view = (env, p) => familyView(env.store.get(p.id), { registry: env.registry, now: env.clock.now(), household: env.store.household() })
const recordedTools = (run, answer) => [...run.segment1, ...(answer ? run.afterAnswer[answer] : [])].flatMap((t) => t.calls.map((c) => c.name))

test('recorded_runs_exist_for_scenarios_1_2_4_5_and_hold_no_money_tool', () => {
  assert.deepEqual(RUNS.map((r) => r.scenario).sort(), [1, 2, 4, 5])
  for (const run of RUNS) {
    assert.equal(run.modelName, 'Claude Sonnet')
    const names = [...run.segment1, ...Object.values(run.afterAnswer || {}).flat()].flatMap((t) => t.calls.map((c) => c.name))
    assert.ok(names.every((n) => !MONEY_TOOLS.some((m) => n.includes(m))), `${run.title} has no money tool`)
  }
  assert.deepEqual(Object.keys(RUNS.find((r) => r.scenario === 1).afterAnswer).sort(), ['An ad or post', 'I found them', 'No answer', 'Not sure', 'They contacted me'])
})

test('replay_follows_the_recorded_calls_and_labels_them_as_a_recording', async () => {
  const run = RUNS.find((r) => r.scenario === 2)
  const env = makeEnv({ llm: replay() })
  const p = await authorized(env, 2)
  assert.deepEqual(p.steps.map((s) => s.tool), recordedTools(run).filter((n) => n !== 'write_report'))
  assert.equal(p.report.source, 'claude')
  assert.equal(view(env, p).modelLabel, recordedLabel(run))
  assert.match(view(env, p).modelLabel, /^Recorded run: Claude Sonnet, \d{4}-\d{2}-\d{2}$/)
})

test('replay_of_scenario_1_reaches_the_question_and_continues_with_the_recorded_answer_branch', async () => {
  const run = RUNS.find((r) => r.scenario === 1)
  const env = makeEnv({ llm: replay() })
  const held = await authorized(env, 1)
  assert.equal(held.state, STATES.HELD_ASKING)
  assert.equal(held.risk, 'high')
  env.decisions.answer(held.id, 'They contacted me')
  await env.investigator.settle(held.id)
  const p = env.store.get(held.id)
  assert.equal(p.report.source, 'claude')
  assert.equal(view(env, p).modelLabel, recordedLabel(run), 'both parts came from the recording')
})

test('replay_hands_over_to_the_scripted_stand_in_when_the_answer_branch_was_not_recorded', async () => {
  const run = RUNS.find((r) => r.scenario === 1)
  const partial = { ...run, afterAnswer: {} }
  const env = makeEnv({ llm: replay([partial]) })
  const held = await authorized(env, 1)
  env.decisions.answer(held.id, 'Not sure')
  await env.investigator.settle(held.id)
  const label = view(env, env.store.get(held.id)).modelLabel
  assert.equal(label, `${recordedLabel(run)}; after Mom's answer: ${SCRIPTED_LABEL}`)
})

test('replay_never_reuses_a_recording_for_different_inputs', async () => {
  const env = makeEnv({ llm: replay() })
  const p = await authorized(env, 1, { message: 'Hello, your scooter ships Monday.' })
  assert.equal(view(env, p).modelLabel, SCRIPTED_LABEL, 'another message means another key')

  // Same key, but an earlier capture changes a tool result: the recording stops at the first difference.
  const run = RUNS.find((r) => r.scenario === 2)
  const env2 = makeEnv({ llm: replay() })
  const s = scenario(2)
  const first = await authorized(env2, 2)
  env2.store.update(first.id, { state: STATES.CAPTURED })
  const second = await authorized(env2, 2)
  const label = view(env2, second).modelLabel
  const profileTurn = run.segment1.findIndex((t) => t.calls.some((c) => c.name === 'get_payee_profile'))
  assert.ok(profileTurn >= 0 && s.payeeKey === 'maple_lane')
  assert.match(label, new RegExp(SCRIPTED_LABEL), `the label admits the stand-in took over: ${label}`)
})

test('replay_of_the_gift_card_request_is_labelled_on_the_alert', async () => {
  const env = makeEnv({ llm: replay() })
  const r = await env.investigator.checkRequest(scenario(5).request)
  assert.equal(r.report.source, 'claude')
  assert.deepEqual(r.modelSources[1], [recordedLabel(RUNS.find((x) => x.scenario === 5))])
})

test('local_llm_replays_by_default_and_force_mock_keeps_the_scripted_stand_in', () => {
  assert.equal(localLlm(loadConfig({}), { runs: RUNS }).mode, 'replay')
  assert.equal(localLlm(loadConfig({ FORCE_MOCK: '1' }), { runs: RUNS }).mode, 'mock')
  assert.equal(localLlm(loadConfig({ LLM_BACKEND: 'scripted' }), { runs: RUNS }).mode, 'mock')
  assert.equal(localLlm(loadConfig({}), { runs: [] }).mode, 'mock')
})

test('local_only_ignores_paypal_keys_and_the_model_keys_but_still_replays', () => {
  const config = loadConfig({ LOCAL_ONLY: '1', LLM_BACKEND: 'account', ANTHROPIC_API_KEY: 'sk-x', PAYEE_MAPLE_LANE_CLIENT_ID: 'id', PAYEE_MAPLE_LANE_CLIENT_SECRET: 'secret' })
  assert.equal(config.paypalLocal, true)
  assert.equal(config.anthropicKey, '')
  assert.equal(localLlm(config, { runs: RUNS }).mode, 'replay')
})
