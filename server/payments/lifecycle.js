import { HttpError } from '../http.js'
import { STATES, newId } from '../store.js'
import { decide } from '../rules.js'
import { PayPalError, UNKNOWN_OUTCOME } from '../paypal/errors.js'
import { approvalLink, authorizationOf } from '../paypal/gateway.js'

const RETRY_ATTEMPTS = 3
const DECLINED_CAPTURE = new Set(['DECLINED', 'FAILED'])
const FRIENDLY_FAILURE = "PayPal couldn't take this payment. Nothing was charged."

// Creates, holds, captures and voids payments. Every PayPal money call uses the payee's own credentials and a fixed
// Request-Id of the form paymentId:action, so a retry can never make a second capture or void.
export function createLifecycle({ store, registry, gateway, clock, timers, withLock, investigator, publicUrl }) {
  async function retry(fn) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn()
      } catch (err) {
        if (!(err instanceof PayPalError) || !err.retryable || attempt >= RETRY_ATTEMPTS) throw err
      }
    }
  }

  async function traced(id, op, requestId, fn) {
    const at = clock.now()
    try {
      const result = await fn()
      store.update(id, (p) => ({ calls: [...p.calls, { at, op, requestId, outcome: 'ok' }].slice(-30) }))
      return result
    } catch (err) {
      store.update(id, (p) => ({ calls: [...p.calls, { at, op, requestId, outcome: 'error', detail: String(err.issue || err.message).slice(0, 80) }].slice(-30) }))
      throw err
    }
  }

  const payeeOf = (p) => registry.get(p.payeeKey)

  function applyFact(id, fact) {
    const now = clock.now()
    if (fact.type === 'captured') {
      return store.transition(id, [STATES.CAPTURING, STATES.APPROVED_PENDING, STATES.HELD, STATES.HELD_ASKING], STATES.CAPTURED, { captureId: fact.captureId, capturedAt: now, paypalStatus: 'CAPTURED', endedBy: 'captured' })
    }
    if (fact.type === 'voided') {
      return store.transition(id, [STATES.VOIDING, STATES.HELD, STATES.HELD_ASKING, STATES.APPROVED_PENDING, STATES.CAPTURING], STATES.VOIDED, (p) => ({ voidedAt: now, paypalStatus: 'VOIDED', endedBy: p.endedBy || 'paypal' }))
    }
    return null
  }

  // PayPal can answer a capture with PENDING (a later webhook says COMPLETED or DENIED) or DECLINED. Neither is "captured".
  function noteCapturePending(id, captureId) {
    return store.update(id, { captureId, paypalStatus: 'CAPTURE_PENDING' })
  }

  function declineCapture(id) {
    return store.transition(id, [STATES.CAPTURING, STATES.APPROVED_PENDING], STATES.FAILED, { failure: 'PayPal declined the capture. Nothing was charged.', paypalStatus: 'CAPTURE_DECLINED' })
  }

  // After an unclear failure, ask PayPal what really happened and make our state match it.
  async function reconcile(id) {
    const p = store.get(id)
    try {
      const order = await gateway.getOrder(payeeOf(p), p.orderId)
      const unit = order.purchase_units?.[0]
      const auth = unit?.payments?.authorizations?.[0]
      const capture = unit?.payments?.captures?.[0]
      if (capture?.status === 'PENDING') return noteCapturePending(id, capture.id)
      if (capture && DECLINED_CAPTURE.has(capture.status)) return declineCapture(id)
      if (auth?.status === 'CAPTURED') return applyFact(id, { type: 'captured', captureId: capture?.id || null })
      if (auth?.status === 'VOIDED') return applyFact(id, { type: 'voided' })
    } catch {
      // PayPal is still unreachable: the tick retries this operation later.
    }
    return null
  }

  async function captureNow(id) {
    const p = store.get(id)
    const requestId = `${id}:capture`
    try {
      const capture = await traced(id, 'capture', requestId, () => retry(() => gateway.captureAuthorization(payeeOf(p), p.authorizationId, { amountCents: p.amountCents, requestId, orderId: p.orderId })))
      if (capture.status === 'COMPLETED') applyFact(id, { type: 'captured', captureId: capture.id })
      else if (capture.status === 'PENDING') noteCapturePending(id, capture.id)
      else if (DECLINED_CAPTURE.has(capture.status)) declineCapture(id)
      else await reconcile(id)
    } catch (err) {
      if (err instanceof PayPalError && !err.retryable) {
        const settled = await reconcile(id)
        if (!settled) store.transition(id, [STATES.CAPTURING], STATES.FAILED, { failure: 'PayPal could not capture this payment. Nothing was charged.', paypalStatus: 'AUTHORIZED' })
        return store.get(id)
      }
      await reconcile(id)
    }
    return store.get(id)
  }

  async function voidNow(id) {
    const p = store.get(id)
    const requestId = `${id}:void`
    try {
      await traced(id, 'void', requestId, () => retry(() => gateway.voidAuthorization(payeeOf(p), p.authorizationId, requestId)))
      applyFact(id, { type: 'voided' })
    } catch (err) {
      await reconcile(id)
      if (err instanceof PayPalError && !err.retryable && store.get(id).state === STATES.VOIDING) {
        throw new HttpError(502, 'PayPal did not release the hold. Try again.')
      }
    }
    return store.get(id)
  }

  async function createPayment({ payeeKey, amountCents, memo, message = '', secondRequest = false }) {
    const payee = registry.get(payeeKey)
    if (!payee) throw new HttpError(400, 'Unknown seller')
    const id = newId('pay')
    store.insert({
      id, payeeKey, amountCents, memo, message, secondRequest, state: STATES.CREATED, risk: 'low', createdAt: clock.now(),
      orderId: null, approveUrl: null, authorizationId: null, captureId: null, authorizedAt: null, voidAt: null, approvedAt: null, captureAt: null, askExpiresAt: null,
      signals: [], steps: [], findings: [], question: null, report: null, investigation: { status: 'idle' }, agent: null,
      stoppedBy: null, endedBy: null, refunded: false, failure: null, paypalStatus: null, calls: [], webhooks: [], opStartedAt: null, claims: {},
    })
    const requestId = `${id}:create`
    try {
      const order = await traced(id, 'create_order', requestId, () => retry(() => gateway.createOrder(payee, {
        amountCents, memo, referenceId: id, requestId,
        returnUrl: `${publicUrl}/api/paypal/return?paymentId=${id}`,
        cancelUrl: `${publicUrl}/api/paypal/cancel?paymentId=${id}`,
      })))
      store.update(id, { orderId: order.id, approveUrl: approvalLink(order), paypalStatus: 'ORDER_CREATED' })
    } catch {
      store.update(id, { state: STATES.FAILED, failure: FRIENDLY_FAILURE })
    }
    return store.get(id)
  }

  // What happens once PayPal holds an authorization: the rules decide between holding it for the family and capturing it.
  function settleAuthorization(id, order) {
    const p = store.get(id)
    const payee = payeeOf(p)
    const auth = authorizationOf(order)
    const now = clock.now()
    const household = store.household()
    const decision = decide({ payment: p, payee, household })
    const base = { authorizationId: auth.id, authorizedAt: now, paypalStatus: 'AUTHORIZED', signals: decision.signals, holdReason: decision.reason }
    if (decision.hold) {
      store.transition(id, [STATES.CREATED], STATES.HELD, { ...base, voidAt: now + timers.autoVoidMs })
      investigator.start(id)
      return store.get(id)
    }
    store.transition(id, [STATES.CREATED], STATES.CAPTURING, { ...base, opStartedAt: now })
    return captureNow(id)
  }

  // Called when the payer comes back from PayPal and when the CHECKOUT.ORDER.APPROVED webhook arrives. Safe to call twice.
  // The claim is written before the call; a second caller finds it and never reaches PayPal.
  function ensureAuthorized(id) {
    return withLock(id, async () => {
      const p = store.get(id)
      if (!p || p.state !== STATES.CREATED) return p
      if (!store.claim(id, 'authorize', clock.now())) return p
      const payee = payeeOf(p)
      const requestId = `${id}:authorize`
      let order
      try {
        order = await traced(id, 'authorize', requestId, () => retry(() => gateway.authorizeOrder(payee, p.orderId, requestId)))
      } catch (err) {
        if (err.issue === UNKNOWN_OUTCOME) return store.get(id) // claim stays: pickUpApproved reads the order and settles it
        store.releaseClaim(id, 'authorize')
        if (err.issue === 'ORDER_NOT_APPROVED') return p
        store.transition(id, [STATES.CREATED], STATES.FAILED, { failure: FRIENDLY_FAILURE })
        return store.get(id)
      }
      return settleAuthorization(id, order)
    })
  }

  // For an order the payer approved but whose return page and webhook never reached us (closed window, lost event), or
  // whose authorize answer was lost: ask PayPal. An authorization already there is settled; an approved order is
  // authorized again with the same request id; an order that is not approved yet is left alone and costs no trace entry.
  async function pickUpApproved(id) {
    const p = store.get(id)
    if (!p || p.state !== STATES.CREATED || !p.orderId) return p
    let order
    try {
      order = await gateway.getOrder(payeeOf(p), p.orderId)
    } catch {
      return p
    }
    if (authorizationOf(order)) {
      return withLock(id, async () => (store.get(id)?.state === STATES.CREATED ? settleAuthorization(id, order) : store.get(id)))
    }
    if (order.status !== 'APPROVED') return p
    await withLock(id, async () => { if (store.get(id)?.state === STATES.CREATED) store.releaseClaim(id, 'authorize') })
    return ensureAuthorized(id)
  }

  return { createPayment, ensureAuthorized, pickUpApproved, captureNow, voidNow, applyFact, reconcile }
}
