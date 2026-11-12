import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, authorized, scriptedLlm, countingLlm, sleep, HOUR } from './helpers.js'
import { createMockLlm } from '../server/agent/mockLlm.js'
import { createBudget, LIMITS } from '../server/agent/budget.js'
import { claudeTools } from '../server/agent/tools.js'
import { STATES } from '../server/store.js'
import { familyView } from '../server/views.js'

const count = (p, tool) => p.steps.filter((s) => s.tool === tool).length

test('ai_cannot_lower_risk_or_release_hold', async () => {
  const names = claudeTools().map((t) => t.name)
  assert.ok(!names.some((n) => /capture|void|release|approve|stop/i.test(n)), 'no tool can move money or release the hold')
  const llm = scriptedLlm([
    [['get_payment_request', {}]],
    [['raise_risk', { level: 'high', reason: 'test signals' }]],
    [['raise_risk', { level: 'low', reason: 'looks fine to me' }]],
    [['release_hold', {}]],
    [['write_report', { risk_level: 'low', family_summary: 'All good', elder_message: 'Fine. Go ahead.', call_questions: ['Ok?'] }]],
  ])
  const env = makeEnv({ llm })
  const p = await authorized(env, 2)
  assert.equal(p.risk, 'high', 'the later low report and low raise_risk did not lower it')
  assert.equal(p.state, STATES.HELD, 'the model could not release the hold')
  assert.equal(env.mock.operationCount('capture') + env.mock.operationCount('void'), 0)
})

test('elder_answer_never_lowers_risk', async () => {
  const env = makeEnv()
  const p = await authorized(env, 1)
  assert.equal(p.state, STATES.HELD_ASKING)
  const before = p.findings.length
  env.decisions.answer(p.id, 'I found them')
  await env.investigator.settle(p.id)
  const after = env.store.get(p.id)
  assert.equal(after.risk, 'high')
  assert.ok(after.findings.length >= before, 'no finding was removed')
  assert.equal(after.question.answer, 'I found them')
  assert.equal(after.state, STATES.HELD, 'the answer does not release the hold')
  assert.equal(after.report.source, 'claude')
})

test('held_asking_has_no_model_timeout_and_resumes_on_answer', async () => {
  const llm = countingLlm(createMockLlm())
  const env = makeEnv({ llm, timers: { segment1Ms: 80, segment2Ms: 5000 } })
  const p = await authorized(env, 1)
  assert.equal(p.state, STATES.HELD_ASKING)
  const callsWhenAsked = llm.calls
  await sleep(250) // far longer than the 80 ms segment limit
  assert.equal(llm.calls, callsWhenAsked, 'no model runs while we wait for a person')
  assert.equal(env.store.get(p.id).state, STATES.HELD_ASKING)
  env.decisions.answer(p.id, 'An ad or post')
  await env.investigator.settle(p.id)
  const done = env.store.get(p.id)
  assert.equal(done.investigation.status, 'done')
  assert.equal(done.investigation.limit, undefined, 'the second segment has its own clock')
  assert.equal(done.report.source, 'claude')
  assert.ok(llm.calls > callsWhenAsked)
})

test('family_decision_while_asking_closes_question', async () => {
  const llm = countingLlm(createMockLlm())
  const env = makeEnv({ llm })
  const p = await authorized(env, 1)
  const calls = llm.calls
  await env.decisions.approve(p.id)
  const after = env.store.get(p.id)
  assert.equal(after.state, STATES.APPROVED_PENDING)
  assert.equal(after.question.closedBy, 'family')
  assert.equal(after.investigation.status, 'ended')
  assert.ok(after.report, 'the card still has a report')
  assert.throws(() => env.decisions.answer(p.id, 'An ad or post'), /no question/i)
  const elder = env.store.get(p.id)
  assert.equal(elder.question.answer, null)
  assert.equal(llm.calls, calls, 'the model is not called again')
})

test('claude_api_error_after_retry_marks_rules_only_new_payee_still_held', async () => {
  const llm = { mode: 'live', calls: 0, async step() { llm.calls += 1; throw new Error('overloaded') } }
  const env = makeEnv({ llm })
  const p = await authorized(env, 1)
  assert.equal(llm.calls, 2, 'one retry, then rules only')
  assert.equal(p.state, STATES.HELD, 'a new seller is held even when Claude is down')
  assert.equal(p.investigation.status, 'rules_only')
  assert.equal(p.report.source, 'rules')
  const view = familyView(p, { registry: env.registry, now: env.clock.now(), household: env.store.household() })
  assert.equal(view.checkedBy, 'rules')
  assert.ok(view.signals.some((s) => s.kind === 'first_time_seller'), 'the rule card is already complete')
})

test('scenario1_reaches_ask_elder_within_limits', async () => {
  const env = makeEnv()
  const p = await authorized(env, 1)
  assert.equal(p.state, STATES.HELD_ASKING)
  assert.equal(p.steps.filter((s) => s.kind === 'check').length, 4, 'four checks')
  assert.equal(p.findings.length, 3)
  assert.equal(p.agent.used.record_finding, 3)
  assert.equal(p.agent.used.raise_risk, 1)
  assert.equal(p.agent.used.ask_elder, 1)
  assert.equal(p.risk, 'high')
  assert.ok(p.steps.filter((s) => s.kind === 'check').length <= LIMITS.investigateSegment1)
  assert.equal(p.question.text, 'How did you first hear about this seller?')
  env.decisions.answer(p.id, 'An ad or post')
  await env.investigator.settle(p.id)
  const done = env.store.get(p.id)
  assert.equal(done.findings.length, 4)
  assert.equal(done.agent.used.write_report, 1)
  assert.match(done.findings.at(-1).quote, /may fit this pattern/)
})

test('scenario2_real_new_shop_gets_no_question', async () => {
  const env = makeEnv()
  const p = await authorized(env, 2)
  assert.equal(p.state, STATES.HELD)
  assert.equal(p.risk, 'low')
  assert.equal(p.steps.length, 4)
  assert.equal(p.question, null)
  assert.equal(count(p, 'search_scam_patterns'), 0, 'no message, so the pattern search is skipped')
})

test('recording_tools_do_not_consume_investigation_cap', () => {
  const recording = createBudget({ segment: 1 })
  for (let i = 0; i < LIMITS.recordFinding; i += 1) {
    assert.equal(recording.check('record_finding').ok, true)
    recording.count('record_finding')
  }
  assert.equal(recording.check('record_finding').ok, false, 'findings have their own cap of 8')
  for (let i = 0; i < LIMITS.raiseRisk; i += 1) recording.count('raise_risk')
  assert.equal(recording.snapshot().investigate, 0, 'eleven recording calls used none of the investigation cap')
  assert.equal(recording.check('get_order').ok, true)
  assert.equal(recording.check('ask_elder').ok, true, 'a risky payment with many findings still reaches its question')

  const investigating = createBudget({ segment: 1 })
  for (let i = 0; i < LIMITS.investigateSegment1; i += 1) investigating.count('get_order')
  assert.equal(investigating.check('get_order').ok, false, 'the cap counts investigative tools only')
  assert.equal(investigating.check('record_finding').ok, true, 'recording the sixth result is still allowed')
  assert.equal(investigating.check('ask_elder').ok, true)
  assert.equal(createBudget({ segment: 2 }).check('ask_elder').ok, false, 'the question belongs to segment 1')
  assert.equal(createBudget({ segment: 2 }).check('get_order').ok, true)
})

test('near_hard_cap_only_ask_elder_or_report_allowed', async () => {
  const near = createBudget({ segment: 1, total: LIMITS.focusAt })
  assert.equal(near.check('get_order').ok, false)
  assert.equal(near.check('record_finding').ok, false)
  assert.equal(near.check('raise_risk').ok, false)
  assert.equal(near.check('ask_elder').ok, true)
  assert.equal(near.check('write_report').ok, true)
  const full = createBudget({ segment: 1, total: LIMITS.hardCap })
  assert.equal(full.check('write_report').ok, false)
  // A model that never stops asking for more checks ends at the hard cap and the card is finished by the server.
  const env = makeEnv({ llm: scriptedLlm([[['get_payment_request', {}]]]) })
  const p = await authorized(env, 1)
  assert.equal(p.state, STATES.HELD)
  assert.equal(p.investigation.limit, 'hard_cap')
  assert.equal(p.report.source, 'limit')
  assert.equal(p.steps.filter((s) => s.kind === 'check').length, LIMITS.investigateSegment1)
})

test('segment_time_limit_finishes_with_what_was_found', async () => {
  const slow = { mode: 'live', calls: 0, async step() { await sleep(60); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${(slow.calls += 1)}`, name: 'get_payment_request', input: {} }] } } }
  const env = makeEnv({ llm: slow, timers: { segment1Ms: 100 } })
  const p = await authorized(env, 1)
  assert.equal(p.investigation.limit, 'timeout')
  assert.equal(p.report.source, 'limit')
  assert.notEqual(p.investigation.status, 'rules_only', 'a time limit is not an API error')
})

test('unanswered_question_continues_with_no_answer_after_timeout', async () => {
  const env = makeEnv()
  const p = await authorized(env, 1)
  env.clock.advance(3 * HOUR)
  await env.scheduler.tick()
  await env.investigator.settle(p.id)
  const done = env.store.get(p.id)
  assert.equal(done.question.answer, 'No answer')
  assert.equal(done.state, STATES.HELD)
  assert.equal(done.risk, 'high')
})

test('check_a_request_alerts_family_without_holding_money', async () => {
  const env = makeEnv()
  const record = await env.investigator.checkRequest({ text: 'Pay $500 in gift cards today and keep this between us.', amountCents: 50000 })
  assert.equal(record.steps.length, 2)
  assert.deepEqual(record.findings.map((f) => f.kind).sort(), ['gift_card', 'secrecy'])
  assert.equal(env.mock.log.length, 0, 'no PayPal call, no money')
  assert.equal(env.store.list().length, 0)
  assert.ok(env.store.activity().some((a) => a.kind === 'request_alert'))
  assert.match(record.report.summary ?? record.report.familySummary, /gift cards/)
})
