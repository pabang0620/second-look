import { HttpError } from '../http.js'
import { STATES, HELD_STATES } from '../store.js'
import { canAskAgain } from '../rules.js'
import { elderReason } from '../agent/investigator.js'

// Human decisions. Each one runs under the payment's lock and re-checks the state, so a double click or a race
// with a timer can only ever do one thing.
export function createDecisions({ store, clock, timers, withLock, lifecycle, investigator }) {
  const need = (id) => {
    const p = store.get(id)
    if (!p) throw new HttpError(404, 'Payment not found')
    return p
  }

  const familyName = () => store.household().family.name

  function approve(id) {
    return withLock(id, async () => {
      const p = need(id)
      if (p.state === STATES.APPROVED_PENDING) return p // double click
      if (!HELD_STATES.includes(p.state)) throw new HttpError(409, 'This payment was already decided.')
      const now = clock.now()
      // Capture after the undo window, but always before the 3 day honor period ends (71 h after authorize).
      const captureAt = Math.min(now + timers.undoMs, p.authorizedAt + timers.captureDeadlineMs)
      const next = store.transition(id, HELD_STATES, STATES.APPROVED_PENDING, { approvedAt: now, captureAt, approvedBy: familyName() })
      store.log({ at: now, kind: 'approved', paymentId: id, by: familyName() })
      if (p.state === STATES.HELD_ASKING) investigator.closeQuestion(id)
      return next
    })
  }

  function stop(id, note = '') {
    return withLock(id, async () => {
      const p = need(id)
      if (p.state === STATES.VOIDING || p.state === STATES.VOIDED) return p // double click
      if (![...HELD_STATES, STATES.APPROVED_PENDING].includes(p.state)) throw new HttpError(409, 'This payment was already decided.')
      const now = clock.now()
      store.transition(id, [...HELD_STATES, STATES.APPROVED_PENDING], STATES.VOIDING, { stoppedBy: familyName(), endedBy: 'stopped', stopNote: note.trim().slice(0, 200), opStartedAt: now })
      store.log({ at: now, kind: 'stopped', paymentId: id, by: familyName() })
      if (p.state === STATES.HELD_ASKING) investigator.closeQuestion(id)
      return lifecycle.voidNow(id)
    })
  }

  function undo(id) {
    return withLock(id, async () => {
      const p = need(id)
      if (p.state === STATES.VOIDING || p.state === STATES.VOIDED) return p
      if (p.state !== STATES.APPROVED_PENDING) throw new HttpError(409, 'There is nothing to undo.')
      const now = clock.now()
      if (now >= p.captureAt) throw new HttpError(409, 'The undo window has closed.')
      store.transition(id, [STATES.APPROVED_PENDING], STATES.VOIDING, { endedBy: 'undone', opStartedAt: now })
      store.log({ at: now, kind: 'undone', paymentId: id, by: familyName() })
      return lifecycle.voidNow(id)
    })
  }

  function autoVoid(id) {
    return withLock(id, async () => {
      const p = store.get(id)
      const now = clock.now()
      if (!p || !HELD_STATES.includes(p.state) || now < p.voidAt) return p
      store.transition(id, HELD_STATES, STATES.VOIDING, { endedBy: 'timeout', opStartedAt: now })
      store.log({ at: now, kind: 'expired', paymentId: id })
      if (p.state === STATES.HELD_ASKING) investigator.closeQuestion(id)
      return lifecycle.voidNow(id)
    })
  }

  function captureDue(id) {
    return withLock(id, async () => {
      const p = store.get(id)
      const now = clock.now()
      if (!p || p.state !== STATES.APPROVED_PENDING || now < p.captureAt) return p
      store.transition(id, [STATES.APPROVED_PENDING], STATES.CAPTURING, { opStartedAt: now })
      return lifecycle.captureNow(id)
    })
  }

  function retryStuck(id) {
    return withLock(id, async () => {
      const p = store.get(id)
      const now = clock.now()
      if (!p || ![STATES.CAPTURING, STATES.VOIDING].includes(p.state) || now - p.opStartedAt < 30000) return p
      store.update(id, { opStartedAt: now })
      if (p.state === STATES.CAPTURING && p.captureId) { // capture is PENDING at PayPal: wait for its answer, do not capture again
        await lifecycle.reconcile(id)
        return store.get(id)
      }
      return p.state === STATES.CAPTURING ? lifecycle.captureNow(id) : lifecycle.voidNow(id)
    })
  }

  // Returns right away; the second investigation segment runs in the background (investigator.settle waits for it).
  function answer(id, choice, { system = false } = {}) {
    const p = need(id)
    if (p.state !== STATES.HELD_ASKING || !p.question) throw new HttpError(409, 'There is no question waiting.')
    if (!system && !p.question.options.includes(choice)) throw new HttpError(400, 'Pick one of the answers shown.')
    if (!investigator.resume(id, choice)) throw new HttpError(409, 'There is no question waiting.')
    return store.get(id)
  }

  async function askAgain(id) {
    const p = need(id)
    if (p.state !== STATES.VOIDED) throw new HttpError(409, 'Only a stopped payment can be asked again.')
    if (!canAskAgain({ payments: store.list(), payeeKey: p.payeeKey, household: store.household() })) {
      throw new HttpError(403, 'Ask Sarah to trust this seller first.')
    }
    return lifecycle.createPayment({ payeeKey: p.payeeKey, amountCents: p.amountCents, memo: p.memo, message: p.message, secondRequest: true })
  }

  function trustPayee(payeeKey) {
    const household = store.household()
    store.updateHousehold({ trustedPayees: new Set([...household.trustedPayees, payeeKey]) })
    store.log({ at: clock.now(), kind: 'trusted', payeeKey, by: familyName() })
  }

  // Turning the rules off is the payer's choice, but it takes 24 hours so a caller cannot make her do it mid call.
  function requestPause() {
    const household = store.household()
    if (household.rulesState !== 'RULES_ON') throw new HttpError(409, 'The rules are already paused or pausing.')
    const now = clock.now()
    store.updateHousehold({ rulesState: 'PAUSE_REQUESTED', pauseRequestedAt: now, pauseEffectiveAt: now + timers.pauseMs })
    store.log({ at: now, kind: 'pause_requested', by: store.household().elder.name })
  }

  function cancelPause() {
    if (store.household().rulesState !== 'PAUSE_REQUESTED') throw new HttpError(409, 'No pause is waiting.')
    store.updateHousehold({ rulesState: 'RULES_ON', pauseRequestedAt: null, pauseEffectiveAt: null })
    store.log({ at: clock.now(), kind: 'pause_cancelled', by: store.household().elder.name })
  }

  function resumeRules() {
    store.updateHousehold({ rulesState: 'RULES_ON', pauseRequestedAt: null, pauseEffectiveAt: null })
    store.log({ at: clock.now(), kind: 'rules_on', by: familyName() })
  }

  function stopReason(p) {
    return p.stopNote || elderReason(p.findings)
  }

  return { approve, stop, undo, autoVoid, captureDue, retryStuck, answer, askAgain, trustPayee, requestPause, cancelPause, resumeRules, stopReason }
}
