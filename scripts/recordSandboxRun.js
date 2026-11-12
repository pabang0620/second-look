// Records the real model (Claude Sonnet through the local Claude Code login, no API key) on scenario 1 while the
// seller Mobility Direct Outlet is on the PayPal SANDBOX, and writes server/agent/recorded-runs/scenario-1-sandbox.json.
// One sandbox order: create, the sandbox buyer approves (scripts/sandboxApprove.py through the buyer pool wrapper),
// authorize, investigate to the question, answer "An ad or post", finish. The same conversation is saved, so the
// recording state (npm run demo:video) can replay it on a fresh sandbox order.
// The authorization is left AUTHORIZED for VERIFY V14 unless VOID_AFTER=1; the printed ids are sandbox ids.
// Usage: BUYER_RUN=<path to buyer-run.sh> node scripts/recordSandboxRun.js
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServices } from '../server/services.js'
import { loadConfig } from '../server/config.js'
import { SCENARIOS } from '../server/scenarios.js'
import { createAccountLlm } from '../server/agent/accountLlm.js'
import { normalizeResult, replayKeyOf } from '../server/agent/replayLlm.js'
import { RECORDED_DIR } from '../server/agent/recordedRuns.js'
import { STATES } from '../server/store.js'

const out = (line) => process.stdout.write(`${line}\n`)
const MODEL = 'claude-sonnet-5-5'
const ANSWER = 'An ad or post'
const here = dirname(fileURLToPath(import.meta.url))
const s = SCENARIOS.find((x) => x.n === 1)
const config = loadConfig({ ...process.env, ANTHROPIC_API_KEY: '', LLM_BACKEND: 'account', ANTHROPIC_MODEL: MODEL, SANDBOX_SELLERS: s.payeeKey, DEMO_TIMERS: '1' })

const turns = []
const results = new Map()
const remember = (messages) => {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b)
  }
}
const account = createAccountLlm({ model: MODEL })
const llm = {
  mode: 'account',
  label: account.label,
  async step(args) {
    remember(args.messages)
    const started = Date.now()
    const response = await account.step(args)
    turns.push({ ms: Date.now() - started, content: response.content })
    return response
  },
}
function take() {
  const taken = turns.splice(0).map((t) => ({
    ms: t.ms,
    ...(t.content.some((b) => b.type === 'text') ? { text: t.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') } : {}),
    calls: t.content.filter((b) => b.type === 'tool_use').map((b) => {
      const r = b.name === 'ask_elder' ? null : results.get(b.id)
      return { name: b.name, input: b.input, ...(r ? { result: normalizeResult(r.content) } : {}) }
    }),
  }))
  return taken.filter((t) => t.calls.length > 0)
}

const svc = createServices({ config, llm })
if (svc.registry.get(s.payeeKey).credentials.mode !== 'sandbox') {
  out(`No sandbox keys for ${s.payeeKey} in .env`)
  process.exit(2)
}
const started = Date.now()
const created = await svc.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: s.message })
const payment = svc.store.get(created.id)
out(`order ${payment.orderId} created on the sandbox`)
const wrapper = process.env.BUYER_RUN
const approve = wrapper
  ? spawnSync(wrapper, ['python3', join(here, 'sandboxApprove.py'), payment.approveUrl], { stdio: 'inherit' })
  : spawnSync('python3', [join(here, 'sandboxApprove.py'), payment.approveUrl], { stdio: 'inherit' })
if (approve.status !== 0) {
  out('Buyer approval failed; nothing was authorized')
  process.exit(2)
}
await svc.lifecycle.ensureAuthorized(created.id)
await svc.investigator.settle(created.id)
let p = svc.store.get(created.id)
out(`authorization ${p.authorizationId}, state ${p.state}, risk ${p.risk}`)
if (p.state !== STATES.HELD_ASKING) {
  out('Claude did not reach the question; not saved')
  process.exit(1)
}
remember([{ role: 'user', content: p.agent.pendingResults }])
const segment1 = take()
const s1ms = Date.now() - started
const t0 = Date.now()
svc.decisions.answer(created.id, ANSWER)
await svc.investigator.settle(created.id)
p = svc.store.get(created.id)
const after = take()
if (p.report?.source !== 'claude') {
  out(`The report did not come from Claude (${p.report?.source}); not saved`)
  process.exit(1)
}
const run = {
  key: replayKeyOf({ kind: 'payment', ...s, secondRequest: false }, s.payeeKey, 'sandbox'),
  scenario: s.n,
  title: `${s.title} (PayPal sandbox)`,
  model: MODEL,
  modelName: 'Claude Sonnet',
  backend: 'account (local Claude Code login, no API key); PayPal sandbox order',
  recordedAt: new Date().toISOString().slice(0, 10),
  segment1,
  afterAnswer: { [ANSWER]: after },
  outcome: {
    state: p.state, risk: p.risk, findings: p.findings.map((f) => f.kind), asked: true,
    sandbox: { orderId: p.orderId, authorizationId: p.authorizationId },
    seconds: Number((s1ms / 1000).toFixed(1)), afterAnswerSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    familySummary: p.report.familySummary,
  },
}
writeFileSync(join(RECORDED_DIR, 'scenario-1-sandbox.json'), `${JSON.stringify(run, null, 2)}\n`)
out(`saved: ${segment1.map((t) => t.calls.map((c) => c.name).join('+')).join(' > ')} | after answer: ${after.map((t) => t.calls.map((c) => c.name).join('+')).join(' > ')}`)
out(`findings ${run.outcome.findings.join(', ')}, risk ${p.risk}`)
if (process.env.VOID_AFTER === '1') {
  await svc.decisions.stop(created.id)
  await svc.scheduler.tick?.()
  out(`stopped: state ${svc.store.get(created.id).state}`)
}
process.exit(0)
