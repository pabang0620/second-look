import { formatUsd } from './money.js'

export const RISK_ORDER = ['low', 'medium', 'high']
export const raiseRisk = (current, next) => (RISK_ORDER.indexOf(next) > RISK_ORDER.indexOf(current) ? next : current)

// Hold rules are plain code. The model never decides whether money is held.
export function signalsFor({ payment, payee, household }) {
  const signals = []
  if (!household.trustedPayees.has(payee.key)) signals.push({ kind: 'first_time_seller', text: `First payment to ${payee.displayName}` })
  if (payment.amountCents > household.limitCents) signals.push({ kind: 'amount_above_limit', text: `${formatUsd(payment.amountCents)} is above the ${formatUsd(household.limitCents)} limit` })
  if (payment.secondRequest) signals.push({ kind: 'second_request', text: `Second request for ${payee.displayName}` })
  return signals
}

export function rulesActive(household) {
  return household.rulesState !== 'RULES_OFF'
}

export function decide({ payment, payee, household }) {
  if (!rulesActive(household)) return { hold: false, reason: 'rules_off', signals: [] }
  const signals = signalsFor({ payment, payee, household })
  return { hold: signals.length > 0, reason: signals.length ? 'rules' : 'known_under_limit', signals }
}

// Ask again is offered twice per seller. After that the family has to trust the seller first.
export function canAskAgain({ payments, payeeKey, household }) {
  const stops = payments.filter((p) => p.payeeKey === payeeKey && p.stoppedBy).length
  return stops < 2 || household.trustedPayees.has(payeeKey)
}

// Facts the model may use as "typical" for this person.
export function typicalRange(household) {
  const amounts = household.history.map((h) => h.amountCents)
  return { minCents: Math.min(...amounts), maxCents: Math.max(...amounts), count: amounts.length }
}
