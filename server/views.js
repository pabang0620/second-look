import { STATES, HELD_STATES } from './store.js'
import { formatUsd } from './money.js'
import { canAskAgain } from './rules.js'

const RISK_LABEL = { low: 'Low risk', medium: 'Needs a look', high: 'High risk' }

export function moneyStatus(p) {
  switch (p.state) {
    case STATES.CREATED: return 'Waiting for the PayPal approval'
    case STATES.HELD: case STATES.HELD_ASKING: return 'Authorized in PayPal, not captured'
    case STATES.APPROVED_PENDING: return 'Approved. PayPal captures after the undo window'
    case STATES.CAPTURING: return 'Capturing in PayPal'
    case STATES.CAPTURED: return p.refunded ? 'Captured, then refunded by the seller' : 'Captured by PayPal'
    case STATES.VOIDING: return 'Releasing the hold in PayPal'
    case STATES.VOIDED: return 'Authorization voided. Nothing was captured.'
    default: return 'PayPal could not take this payment. Nothing was charged.'
  }
}

// Which model did the investigation, per segment, so a recording or the scripted stand-in is never shown as live Claude.
export function modelLabel(sources) {
  const first = sources?.[1] || []
  const second = sources?.[2] || []
  if (first.length === 0 && second.length === 0) return null
  const head = first.join(', then ')
  const same = second.every((s) => first.includes(s))
  if (second.length === 0 || same) return head
  return `${head}; after Mom's answer: ${second.join(', then ')}`
}

const secondsUntil = (target, now) => (target ? Math.max(0, Math.ceil((target - now) / 1000)) : null)

function base(p, registry, now) {
  const payee = registry.get(p.payeeKey)
  return {
    id: p.id, state: p.state, payeeKey: p.payeeKey, payeeName: payee.displayName, amountCents: p.amountCents, amount: formatUsd(p.amountCents),
    memo: p.memo, message: p.message || '', secondRequest: p.secondRequest, createdAt: p.createdAt, moneyStatus: moneyStatus(p),
    secondsToAutoVoid: HELD_STATES.includes(p.state) ? secondsUntil(p.voidAt, now) : null,
    undoSecondsLeft: p.state === STATES.APPROVED_PENDING ? secondsUntil(p.captureAt, now) : null,
    approveUrl: p.state === STATES.CREATED ? p.approveUrl : null,
    endedBy: p.endedBy,
  }
}

export function familyView(p, { registry, now, household }) {
  const payee = registry.get(p.payeeKey)
  const checks = p.steps.filter((s) => s.kind === 'check')
  return {
    ...base(p, registry, now),
    risk: p.risk, riskLabel: RISK_LABEL[p.risk],
    firstTimeSeller: !household.trustedPayees.has(p.payeeKey),
    signals: p.signals, findings: p.findings, steps: checks,
    checks: checks.length, findingsCount: p.findings.length, questionsAsked: p.question ? 1 : 0,
    question: p.question ? { text: p.question.text, answer: p.question.answer, closedBy: p.question.closedBy } : null,
    askSecondsLeft: p.state === STATES.HELD_ASKING ? secondsUntil(p.askExpiresAt, now) : null,
    report: p.report ? { summary: p.report.familySummary, callQuestions: p.report.callQuestions, source: p.report.source } : null,
    checkedBy: p.investigation.status === 'rules_only' ? 'rules' : 'claude',
    modelLabel: modelLabel(p.modelSources),
    investigation: p.investigation.status,
    canDecide: HELD_STATES.includes(p.state),
    canUndo: p.state === STATES.APPROVED_PENDING,
    trusted: household.trustedPayees.has(p.payeeKey),
    email: payee.email,
    stoppedBy: p.stoppedBy,
    refunded: p.refunded,
  }
}

export function elderView(p, { registry, now, store, stopReason }) {
  const household = store.household()
  const open = p.state === STATES.HELD_ASKING && p.question && !p.question.closedBy
  return {
    ...base(p, registry, now),
    question: open ? { text: p.question.text, options: p.question.options } : null,
    waitingMessage: HELD_STATES.includes(p.state) ? `Payments to new sellers wait for a quick check by ${household.family.name}. Nothing has been charged.` : null,
    reportMessage: p.report?.elderMessage || null,
    stopReason: p.state === STATES.VOIDED && p.stoppedBy ? stopReason(p) : null,
    expired: p.state === STATES.VOIDED && p.endedBy === 'timeout',
    canAskAgain: p.state === STATES.VOIDED && canAskAgain({ payments: store.list(), payeeKey: p.payeeKey, household }),
    failure: p.failure,
    receipt: p.state === STATES.CAPTURED ? { captureId: p.captureId, amount: formatUsd(p.amountCents) } : null,
    familyPhone: household.family.phone,
    familyName: household.family.name,
  }
}

// "What did Second Look do for us": sums from stored payments only, no estimates.
export function impactSummary(store) {
  const sum = (pick) => store.list().filter(pick).reduce((total, p) => total + p.amountCents, 0)
  const stopped = sum((p) => p.state === STATES.VOIDED && p.endedBy === 'stopped')
  const paid = sum((p) => p.state === STATES.CAPTURED && Boolean(p.approvedBy))
  const released = sum((p) => p.state === STATES.VOIDED && p.endedBy === 'timeout')
  return { stopped: formatUsd(stopped), paid: formatUsd(paid), released: formatUsd(released), any: stopped + paid + released > 0 }
}

export function activityList(store, registry) {
  const label = (p) => {
    const by = store.household().family.name
    if (p.refunded) return 'Refunded by seller'
    switch (p.state) {
      case STATES.CAPTURED: return p.approvedBy ? `Approved by ${by}` : 'Paid'
      case STATES.VOIDED: return p.endedBy === 'timeout' ? 'Expired, no answer' : p.endedBy === 'undone' ? `Undone by ${by}` : `Stopped by ${by}`
      case STATES.APPROVED_PENDING: return `Approved by ${by}, waiting to capture`
      case STATES.HELD: case STATES.HELD_ASKING: return 'Waiting for review'
      case STATES.FAILED: return 'Not charged'
      default: return 'In progress'
    }
  }
  const rows = store.list().filter((p) => p.state !== STATES.CREATED).map((p) => ({
    id: p.id, at: p.capturedAt || p.voidedAt || p.approvedAt || p.authorizedAt || p.createdAt, payeeName: registry.get(p.payeeKey).displayName, amount: formatUsd(p.amountCents), label: label(p),
  }))
  const alerts = store.listRequests().map((r) => ({ id: r.id, at: r.createdAt, payeeName: 'Request outside PayPal', amount: r.amountCents ? formatUsd(r.amountCents) : '', label: 'Alert sent to family' }))
  return [...rows, ...alerts].sort((a, b) => b.at - a.at)
}

export function requestView(r) {
  return {
    id: r.id, text: r.text, amount: r.amountCents ? formatUsd(r.amountCents) : null, risk: r.risk, createdAt: r.createdAt,
    steps: r.steps.filter((s) => s.kind === 'check'), findings: r.findings, modelLabel: modelLabel(r.modelSources),
    report: r.report ? { summary: r.report.familySummary, elderMessage: r.report.elderMessage, callQuestions: r.report.callQuestions } : null,
  }
}
