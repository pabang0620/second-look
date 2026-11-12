import { Router } from 'express'
import { z } from 'zod'
import { parse, idSchema } from '../http.js'
import { dollarsSchema } from '../money.js'
import { requireRole } from './auth.js'
import { elderState } from './state.js'
import { elderView, requestView } from '../views.js'

const paymentBody = z.object({
  payeeKey: idSchema,
  amount: dollarsSchema,
  memo: z.string().trim().min(1).max(120),
  message: z.string().max(1000).optional(),
})
const answerBody = z.object({ choice: z.string().min(1).max(60) })
const requestBody = z.object({ text: z.string().trim().min(3).max(1000), amount: dollarsSchema.optional() })
const idParam = z.object({ id: z.string().regex(/^pay_[0-9a-f]{8}$/) })

// Express 5 forwards errors from async handlers to the central errorHandler.
export function elderRoutes(svc) {
  const router = Router()
  router.use(requireRole(svc, 'elder'))
  const view = (p) => elderView(p, { registry: svc.registry, now: svc.clock.now(), store: svc.store, stopReason: svc.decisions.stopReason })

  router.get('/state', (_req, res) => res.json({ success: true, data: elderState(svc) }))

  router.post('/payments', async (req, res) => {
    const body = parse(paymentBody, req.body)
    const payment = await svc.lifecycle.createPayment({ payeeKey: body.payeeKey, amountCents: body.amount, memo: body.memo, message: body.message || '' })
    res.status(201).json({ success: true, data: view(payment) })
  })

  router.post('/payments/:id/answer', (req, res) => {
    const { id } = parse(idParam, req.params)
    const { choice } = parse(answerBody, req.body)
    res.json({ success: true, data: view(svc.decisions.answer(id, choice)) })
  })

  router.post('/payments/:id/ask-again', async (req, res) => {
    const { id } = parse(idParam, req.params)
    res.status(201).json({ success: true, data: view(await svc.decisions.askAgain(id)) })
  })

  router.post('/requests', async (req, res) => {
    const body = parse(requestBody, req.body)
    const record = await svc.investigator.checkRequest({ text: body.text, amountCents: body.amount })
    res.status(201).json({ success: true, data: requestView(record) })
  })

  router.post('/rules/pause', (_req, res) => {
    svc.decisions.requestPause()
    res.json({ success: true, data: elderState(svc).household })
  })
  router.post('/rules/cancel-pause', (_req, res) => {
    svc.decisions.cancelPause()
    res.json({ success: true, data: elderState(svc).household })
  })

  return router
}
