import { createServices } from '../server/services.js'
import { fakeClock } from '../server/clock.js'
import { loadConfig } from '../server/config.js'
import { createMockLlm } from '../server/agent/mockLlm.js'
import { SCENARIOS } from '../server/scenarios.js'

export const HOUR = 3600 * 1000
export const MIN = 60 * 1000

export const TEST_TIMERS = Object.freeze({
  demo: false, autoVoidMs: 70 * HOUR, undoMs: 15 * MIN, captureDeadlineMs: 71 * HOUR, honorMs: 72 * HOUR,
  askTimeoutMs: 2 * HOUR, pauseMs: 24 * HOUR, segment1Ms: 45000, segment2Ms: 30000,
})

// A backend with a fake clock, the mock PayPal and the scripted model. Webhooks wait until the test flushes them.
export function makeEnv({ timers = {}, llm } = {}) {
  const clock = fakeClock()
  const svc = createServices({
    clock,
    timers: { ...TEST_TIMERS, ...timers },
    config: loadConfig({ FORCE_MOCK: '1', DEMO_TIMERS: '0' }),
    llm: llm || createMockLlm(),
  })
  svc.mock.setDeliver(async (payeeKey, event, signed) => {
    await svc.webhooks.handle({ payeeKey, headers: signed.headers, event }).catch(() => {})
  }, { auto: false })
  return { ...svc, clock }
}

export const scenario = (n) => SCENARIOS.find((s) => s.n === n)

// Creates a payment for a scenario and plays the payer approving it inside PayPal.
export async function authorized(env, n, overrides = {}) {
  const s = { ...scenario(n), ...overrides }
  const payment = await env.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: s.message })
  env.mock.buyerApprove(payment.orderId)
  await env.lifecycle.ensureAuthorized(payment.id)
  await env.investigator.settle(payment.id)
  return env.store.get(payment.id)
}

// Scripted model: each entry is a list of tool calls (or a function of the messages) for one model turn.
export function scriptedLlm(turns) {
  let i = 0
  let n = 0
  const llm = {
    mode: 'mock',
    calls: 0,
    async step({ messages }) {
      llm.calls += 1
      const turn = turns[Math.min(i, turns.length - 1)]
      i += 1
      const list = typeof turn === 'function' ? turn(messages) : turn
      return { stop_reason: 'tool_use', content: list.map(([name, input]) => ({ type: 'tool_use', id: `toolu_${(n += 1)}`, name, input })) }
    },
  }
  return llm
}

export function countingLlm(inner) {
  const llm = { mode: inner.mode, calls: 0, async step(args) { llm.calls += 1; return inner.step(args) } }
  return llm
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
