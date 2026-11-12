import { elderView, familyView, activityList, requestView, impactSummary } from '../views.js'

const ago = (clock, days) => clock.now() - days * 86400000

export function householdPublic(svc) {
  const h = svc.store.household()
  return {
    elderName: h.elder.name, familyName: h.family.name, familyPhone: h.family.phone, elderPhone: h.elder.phone, limitCents: h.limitCents,
    rulesState: h.rulesState, pauseEffectiveAt: h.pauseEffectiveAt,
    trustedPayees: [...h.trustedPayees],
  }
}

// Which payment the payer's screen and the PayPal panel show when nobody picked one: a payment with an open
// question first (the oldest one has waited longest), otherwise the newest.
export function focusPaymentId(svc) {
  const payments = svc.store.list().sort((a, b) => a.createdAt - b.createdAt)
  const asking = payments.find((p) => p.state === 'HELD_ASKING' && p.question && !p.question.closedBy && p.question.answer === null)
  if (asking) return asking.id
  return payments.at(-1)?.id || null
}

export function elderState(svc) {
  const now = svc.clock.now()
  const ctx = { registry: svc.registry, now, store: svc.store, stopReason: svc.decisions.stopReason }
  const payments = svc.store.list().sort((a, b) => b.createdAt - a.createdAt).slice(0, 8).map((p) => elderView(p, ctx))
  const requests = svc.store.listRequests().slice(-3).reverse().map(requestView)
  const history = svc.store.household().history.map((h) => ({ ...h, at: ago(svc.clock, h.daysAgo) }))
  return { household: householdPublic(svc), payments, focusId: focusPaymentId(svc), requests, history }
}

export function familyState(svc) {
  const now = svc.clock.now()
  const household = svc.store.household()
  const ctx = { registry: svc.registry, now, household }
  const payments = svc.store.list().filter((p) => p.state !== 'CREATED').sort((a, b) => b.createdAt - a.createdAt).map((p) => familyView(p, ctx))
  return {
    household: householdPublic(svc),
    payments,
    waiting: payments.filter((p) => p.canDecide || p.canUndo),
    activity: activityList(svc.store, svc.registry),
    impact: impactSummary(svc.store),
    requests: svc.store.listRequests().slice(-5).reverse().map(requestView),
  }
}

// The PayPal side of one payment: what the judge needs to see that the state really came from PayPal.
export function paypalPanel(svc, paymentId) {
  const p = (paymentId && svc.store.get(paymentId)) || svc.store.get(focusPaymentId(svc))
  const rejected = svc.store.activity().filter((a) => a.kind === 'webhook_rejected').length
  if (!p) return { paymentId: null, rejectedWebhooks: rejected }
  const payee = svc.registry.get(p.payeeKey)
  return {
    paymentId: p.id, payee: payee.displayName, payeeMode: payee.credentials.mode, orderId: p.orderId, authorizationId: p.authorizationId, captureId: p.captureId,
    paypalStatus: p.paypalStatus, state: p.state, calls: p.calls, webhooks: p.webhooks, rejectedWebhooks: rejected,
  }
}
