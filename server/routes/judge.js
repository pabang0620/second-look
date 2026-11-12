import { Router } from 'express'
import { z } from 'zod'
import { HttpError, parse } from '../http.js'
import { SCENARIOS } from '../scenarios.js'
import { SANDBOX_EVIDENCE } from '../sandboxEvidence.js'
import { elderState, familyState, paypalPanel } from './state.js'
import { elderView } from '../views.js'

const scenarioBody = z.object({ n: z.number().int().min(1).max(5) })
const approveBody = z.object({ paymentId: z.string().regex(/^pay_[0-9a-f]{8}$/) })

const COVERAGE = 'Coverage: payments made in Second Look. Built into PayPal, the same check would cover any PayPal checkout.'

// Judge mode: one page, two roles side by side. Every visitor gets a household of their own (own tokens, own state),
// so several judges can use a hosted copy at the same time and Reset only clears the caller's household.
export function judgeRoutes(pool) {
  const router = Router()

  const household = (req) => {
    const svc = pool.get(req.get('x-session'))
    if (!svc) throw new HttpError(401, 'Your demo session ended. Reload the page to start a new one.')
    return svc
  }

  router.get('/bootstrap', (req, res) => {
    const { id, svc } = pool.open(req.get('x-session'))
    res.json({
      success: true,
      data: {
        sessionId: id,
        tokens: svc.store.tokens(),
        payees: svc.registry.publicList(),
        scenarios: SCENARIOS.map(({ n, title, ends, message, request }) => ({ n, title, ends, message: message || '', request: request || null })),
        timers: { demo: svc.timers.demo, autoVoidMs: svc.timers.autoVoidMs, undoMs: svc.timers.undoMs, askTimeoutMs: svc.timers.askTimeoutMs },
        realTimers: { autoVoidHours: 70, undoMinutes: 15 },
        modes: { llm: svc.llm.mode, llmLabel: svc.llm.label || (svc.llm.mode === 'live' ? 'Claude (API)' : 'scripted stand-in'), paypal: svc.registry.list().map((p) => ({ key: p.key, mode: p.credentials.mode })) },
        coverage: COVERAGE,
        evidence: SANDBOX_EVIDENCE,
      },
    })
  })

  router.get('/state', (req, res) => {
    const svc = household(req)
    const paymentId = typeof req.query.paymentId === 'string' ? req.query.paymentId : undefined
    res.json({ success: true, data: { elder: elderState(svc), family: familyState(svc), panel: paypalPanel(svc, paymentId) } })
  })

  // Scenarios 1 to 4 start a payment. Scenario 5 is a sentence the payer pastes, so it goes through the payer's own
  // screen (E4, E5) and the elder API; the judge page does that, not this route.
  router.post('/scenario', async (req, res) => {
    const svc = household(req)
    const { n } = parse(scenarioBody, req.body)
    const scenario = SCENARIOS.find((s) => s.n === n)
    if (scenario.request) throw new HttpError(400, 'This scenario is sent from the payer screen (Someone asked me for money).')
    const payment = await svc.lifecycle.createPayment({ payeeKey: scenario.payeeKey, amountCents: scenario.amountCents, memo: scenario.memo, message: scenario.message })
    const view = elderView(payment, { registry: svc.registry, now: svc.clock.now(), store: svc.store, stopReason: svc.decisions.stopReason })
    return res.status(201).json({ success: true, data: { payment: view, mockCheckout: svc.registry.get(payment.payeeKey).credentials.mode === 'mock' } })
  })

  // Local mode only: stands in for the payer clicking Approve inside PayPal's own page.
  router.post('/mock-approve', async (req, res) => {
    const svc = household(req)
    const { paymentId } = parse(approveBody, req.body)
    const payment = svc.store.get(paymentId)
    if (!payment) throw new HttpError(404, 'Payment not found')
    if (svc.registry.get(payment.payeeKey).credentials.mode !== 'mock') throw new HttpError(400, 'This seller uses the real PayPal sandbox. Approve in the PayPal window.')
    svc.mock.buyerApprove(payment.orderId)
    await svc.lifecycle.ensureAuthorized(paymentId)
    res.json({ success: true, data: { paymentId } })
  })

  router.post('/reset', async (req, res) => {
    const svc = household(req)
    await svc.investigator.settleAll()
    svc.store.reset()
    res.json({ success: true, data: { reset: true } })
  })

  return router
}
