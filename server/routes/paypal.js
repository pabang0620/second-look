import { Router } from 'express'
import { z } from 'zod'
import { HttpError, parse, idSchema } from '../http.js'

const returnQuery = z.object({ paymentId: z.string().regex(/^pay_[0-9a-f]{8}$/), token: z.string().max(60).optional() })
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const OUTCOME = { CREATED: 'waiting', CAPTURED: 'captured', CAPTURING: 'captured', FAILED: 'failed' }

// Each request finds the household that owns the payment, order or webhook event. Nothing here trusts a session header,
// because PayPal and the payer's browser come back without one.
export function paypalRoutes(pool) {
  const router = Router()
  const owner = (paymentId) => pool.find((s) => s.store.get(paymentId))

  // The payer comes back from PayPal after approving. Authorizing is idempotent, so a reload is harmless.
  router.get('/api/paypal/return', async (req, res) => {
    const { paymentId } = parse(returnQuery, req.query)
    const svc = owner(paymentId)
    if (!svc) throw new HttpError(404, 'Payment not found')
    const after = await svc.lifecycle.ensureAuthorized(paymentId)
    res.redirect(`/return?paymentId=${paymentId}&outcome=${OUTCOME[after?.state] || 'held'}`)
  })

  router.get('/api/paypal/cancel', (req, res) => {
    const { paymentId } = parse(returnQuery, req.query)
    const svc = owner(paymentId)
    const payment = svc?.store.get(paymentId)
    if (payment?.state === 'CREATED') svc.store.update(paymentId, { state: 'FAILED', failure: 'You cancelled at PayPal. Nothing was charged.' })
    res.redirect(`/return?paymentId=${paymentId}&cancelled=1`)
  })

  // Webhook endpoint, one URL per seller app: /api/webhooks/paypal/<payeeKey>
  router.post('/api/webhooks/paypal/:payeeKey', async (req, res) => {
    const { payeeKey } = parse(z.object({ payeeKey: idSchema }), req.params)
    const svc = pool.find((s) => s.webhooks.matches(req.body)) || pool.any()
    if (!svc) return res.json({ success: true, data: { duplicate: false, matched: false } })
    const result = await svc.webhooks.handle({ payeeKey, headers: req.headers, event: req.body })
    res.json({ success: true, data: result })
  })

  // Local mode stand-in for PayPal's approval page.
  router.get('/mock-paypal/checkout', (req, res) => {
    const token = String(req.query.token || '')
    const svc = pool.find((s) => s.mock.peekOrder(token))
    const order = svc?.mock.peekOrder(token)
    if (!order) throw new HttpError(404, 'Order not found')
    const unit = order.purchase_units[0]
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox checkout (local mode)</title>
<style>body{font:18px system-ui;max-width:420px;margin:40px auto;padding:0 16px;color:#16202b}button{font:inherit;font-weight:700;width:100%;min-height:56px;border:0;border-radius:12px;background:#0b5cad;color:#fff;cursor:pointer}small{color:#4a5a6b}</style></head>
<body><h1>Sandbox checkout</h1><p><small>Local mode: a stand-in for PayPal's approval page. No real money.</small></p>
<p>Pay <b>$${esc(unit.amount.value)}</b> to <b>${esc(unit.payee.email_address)}</b></p><p>${esc(unit.description || '')}</p>
<form method="post" action="/mock-paypal/approve"><input type="hidden" name="token" value="${esc(order.id)}"><button type="submit">Approve payment</button></form></body></html>`)
  })

  router.post('/mock-paypal/approve', (req, res) => {
    const token = String(req.body?.token || '')
    const svc = pool.find((s) => s.mock.peekOrder(token))
    const result = svc?.mock.buyerApprove(token)
    if (!result) throw new HttpError(404, 'Order not found')
    res.redirect(result.returnUrl)
  })

  return router
}
