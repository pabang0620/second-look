// VERIFY V6 through the local Claude Code account (no API key, no PayPal call).
// Runs scenarios 1 and 2 against the local PayPal stand-in with the real model and prints the tool order.
// Usage: npm run v6:account
import { createServices } from '../server/services.js'
import { loadConfig } from '../server/config.js'
import { SCENARIOS } from '../server/scenarios.js'

const out = (line) => process.stdout.write(`${line}\n`)
// An explicit env keeps .env keys (PayPal, Anthropic) out of this run.
const svc = createServices({ config: loadConfig({ LLM_BACKEND: 'account', DEMO_TIMERS: '1' }) })
out(`model backend: ${svc.llm.label}, PayPal: local stand-in`)

async function run(n) {
  const s = SCENARIOS.find((x) => x.n === n)
  const started = Date.now()
  const payment = await svc.lifecycle.createPayment({ payeeKey: s.payeeKey, amountCents: s.amountCents, memo: s.memo, message: s.message })
  svc.mock.buyerApprove(payment.orderId)
  await svc.lifecycle.ensureAuthorized(payment.id)
  await svc.investigator.settle(payment.id)
  const p = svc.store.get(payment.id)
  out(`\nScenario ${n} (${s.title}): state ${p.state}, risk ${p.risk}, ${((Date.now() - started) / 1000).toFixed(1)} s`)
  out(`  tools: ${p.steps.map((x) => x.tool).join(' > ')}`)
  out(`  findings: ${p.findings.map((f) => f.kind).join(', ') || 'none'}`)
  out(`  question asked: ${p.question ? 'yes' : 'no'}`)
  out(`  report source: ${p.report?.source || 'none'}`)
  if (p.report) out(`  family summary: ${p.report.familySummary}`)
  return p
}

try {
  await run(1)
  await run(2)
} finally {
  svc.scheduler?.stop?.()
  process.exit(0)
}
