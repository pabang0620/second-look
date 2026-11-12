// Records the real model (Claude Sonnet through the local Claude Code login, no API key) on the judge scenarios
// and writes server/agent/recorded-runs/scenario-<n>.json. PayPal stays on the local stand-in.
// Scenario 1 is recorded once up to the question; the part after the answer is recorded once per answer button
// (and for "No answer"), each continuing from that same recorded first part.
// Usage: npm run record:runs
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServices } from '../server/services.js'
import { loadConfig } from '../server/config.js'
import { SCENARIOS } from '../server/scenarios.js'
import { createAccountLlm } from '../server/agent/accountLlm.js'
import { createReplayLlm, normalizeResult, replayKeyOf } from '../server/agent/replayLlm.js'
import { RECORDED_DIR } from '../server/agent/recordedRuns.js'
import { ELDER_OPTIONS } from '../server/agent/tools.js'
import { STATES } from '../server/store.js'

const out = (line) => process.stdout.write(`${line}\n`)
const MODEL = 'claude-sonnet-5-5'
const RECORDED_AT = new Date().toISOString().slice(0, 10)
// An explicit env keeps .env keys (PayPal, Anthropic) out of this run.
const config = loadConfig({ LLM_BACKEND: 'account', DEMO_TIMERS: '1', ANTHROPIC_MODEL: MODEL })

function createRecorder() {
  const account = createAccountLlm({ model: MODEL })
  let turns = []
  const results = new Map()
  const remember = (messages) => {
    for (const m of messages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue
      for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b)
    }
  }
  return {
    llm: {
      mode: 'account',
      label: account.label,
      async step(args) {
        remember(args.messages)
        const started = Date.now()
        const response = await account.step(args)
        turns = [...turns, { ms: Date.now() - started, content: response.content }]
        return response
      },
    },
    remember,
    // Recorded turns since the last take(), with each call's result where it is known.
    take() {
      const taken = turns.map((t) => ({
        ms: t.ms,
        ...(t.content.some((b) => b.type === 'text') ? { text: t.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') } : {}),
        calls: t.content.filter((b) => b.type === 'tool_use').map((b) => {
          const r = b.name === 'ask_elder' ? null : results.get(b.id)
          return { name: b.name, input: b.input, ...(r ? { result: normalizeResult(r.content) } : {}) }
        }),
      })).filter((t) => t.calls.length > 0)
      turns = []
      return taken
    },
  }
}

const header = (s, key) => ({ key, scenario: s.n, title: s.title, model: MODEL, modelName: 'Claude Sonnet', backend: 'account (local Claude Code login, no API key)', recordedAt: RECORDED_AT })

function outcomeOf(p, ms) {
  return { state: p.state, risk: p.risk, findings: p.findings.map((f) => f.kind), asked: Boolean(p.question), reportSource: p.report?.source || null, familySummary: p.report?.familySummary || null, seconds: Number((ms / 1000).toFixed(1)) }
}

async function startPayment(svc, s) {
  const payment = await svc.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: s.message })
  svc.mock.buyerApprove(payment.orderId)
  await svc.lifecycle.ensureAuthorized(payment.id)
  await svc.investigator.settle(payment.id)
  return svc.store.get(payment.id)
}

async function withRetry(label, fn, ok) {
  const first = await fn()
  if (ok(first)) return first
  out(`  ${label}: retrying once (${first.investigation?.status} ${first.investigation?.limit || first.investigation?.error || ''})`)
  return fn()
}

const done = (p) => p.investigation?.status === 'done' && !p.investigation?.limit && p.report?.source === 'claude'

async function recordPayment(s) {
  const rec = createRecorder()
  const started = Date.now()
  const p = await withRetry(`scenario ${s.n}`, async () => { rec.take(); return startPayment(createServices({ config, llm: rec.llm }), s) }, done)
  const run = { ...header(s, replayKeyOf({ kind: 'payment', ...s, secondRequest: false }, s.payeeKey)), segment1: rec.take(), outcome: outcomeOf(p, Date.now() - started) }
  return run
}

async function recordScam(s) {
  const rec = createRecorder()
  const started = Date.now()
  const asking = (p) => p.state === STATES.HELD_ASKING
  let svc
  const p = await withRetry('scenario 1', async () => { rec.take(); svc = createServices({ config, llm: rec.llm }); return startPayment(svc, s) }, asking)
  if (!asking(p)) throw new Error(`Scenario 1 did not reach the question (state ${p.state})`)
  rec.remember([{ role: 'user', content: p.agent.pendingResults }])
  const base = { ...header(s, replayKeyOf({ kind: 'payment', ...s, secondRequest: false }, s.payeeKey)), segment1: rec.take(), outcome: outcomeOf(p, Date.now() - started) }

  const afterAnswer = {}
  const outcomes = {}
  for (const answer of [...ELDER_OPTIONS, 'No answer']) {
    const branch = createRecorder()
    const llm = createReplayLlm({ runs: [base], fallback: branch.llm, paceMs: 0 })
    const t0 = Date.now()
    const after = await withRetry(`answer "${answer}"`, async () => {
      branch.take()
      const svc2 = createServices({ config, llm })
      const held = await startPayment(svc2, s)
      if (!asking(held)) throw new Error('The recorded first part did not replay to the question')
      if (branch.take().length > 0) throw new Error('The recorded first part did not replay exactly')
      svc2.decisions.answer(held.id, answer, { system: answer === 'No answer' })
      await svc2.investigator.settle(held.id)
      return svc2.store.get(held.id)
    }, done)
    afterAnswer[answer] = branch.take()
    outcomes[answer] = outcomeOf(after, Date.now() - t0)
    out(`  answer "${answer}": ${after.risk}, ${afterAnswer[answer].map((t) => t.calls.map((c) => c.name).join('+')).join(' > ')}`)
  }
  return { ...base, afterAnswer, outcome: { ...base.outcome, afterAnswer: outcomes } }
}

async function recordRequest(s) {
  const rec = createRecorder()
  const started = Date.now()
  const svc = createServices({ config, llm: rec.llm })
  const r = await svc.investigator.checkRequest(s.request)
  const subject = { kind: 'request', amountCents: s.request.amountCents, text: s.request.text }
  return { ...header(s, replayKeyOf(subject)), segment1: rec.take(), outcome: { risk: r.risk, findings: r.findings.map((f) => f.kind), reportSource: r.report?.source || null, familySummary: r.report?.familySummary || null, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) } }
}

function save(run) {
  mkdirSync(RECORDED_DIR, { recursive: true })
  writeFileSync(join(RECORDED_DIR, `scenario-${run.scenario}.json`), `${JSON.stringify(run, null, 2)}\n`)
  out(`Scenario ${run.scenario} (${run.title}): ${run.segment1.map((t) => t.calls.map((c) => c.name).join('+')).join(' > ')}`)
  out(`  outcome: ${JSON.stringify({ ...run.outcome, afterAnswer: undefined })}`)
}

const only = process.argv.slice(2).map(Number).filter(Boolean)
const wanted = (n) => only.length === 0 || only.includes(n)
const scenario = (n) => SCENARIOS.find((x) => x.n === n)

try {
  out(`Recording with ${MODEL} through the local Claude Code login. PayPal: local stand-in.`)
  if (wanted(1)) save(await recordScam(scenario(1)))
  if (wanted(2)) save(await recordPayment(scenario(2)))
  if (wanted(4)) save(await recordPayment(scenario(4)))
  if (wanted(5)) save(await recordRequest(scenario(5)))
  process.exit(0)
} catch (err) {
  process.stderr.write(`Recording failed: ${err?.stack || err}\n`)
  process.exit(1)
}
