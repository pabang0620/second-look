import 'dotenv/config'

const HOUR = 3600 * 1000
const MIN = 60 * 1000

export const REAL_TIMERS = Object.freeze({
  autoVoidMs: 70 * HOUR,
  undoMs: 15 * MIN,
  captureDeadlineMs: 71 * HOUR,
  honorMs: 72 * HOUR,
  askTimeoutMs: 2 * HOUR,
  pauseMs: 24 * HOUR,
  segment1Ms: 45 * 1000,
  segment2Ms: 30 * 1000,
})

function num(value, fallback) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Demo timers shorten the waits so a judge can watch an auto-void. Real values stay the defaults of the state machine.
export function buildTimers(env = process.env) {
  const demo = env.DEMO_TIMERS !== '0'
  if (!demo) return { demo, ...REAL_TIMERS }
  return {
    demo,
    ...REAL_TIMERS,
    autoVoidMs: num(env.AUTO_VOID_MS, 2 * MIN),
    undoMs: num(env.UNDO_MS, 30 * 1000),
    askTimeoutMs: num(env.ASK_TIMEOUT_MS, 3 * MIN),
  }
}

export function loadConfig(env = process.env) {
  const port = num(env.PORT, 3001)
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '')
  const forceMock = env.FORCE_MOCK === '1'
  return {
    port,
    publicUrl,
    forceMock,
    anthropicKey: forceMock ? '' : env.ANTHROPIC_API_KEY || '',
    llmBackend: forceMock ? 'mock' : env.LLM_BACKEND === 'account' ? 'account' : 'api',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    timers: buildTimers(env),
    paypalApiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    paypalTransport: env.PAYPAL_TRANSPORT === 'rest' ? 'rest' : 'sdk',
    env,
  }
}
