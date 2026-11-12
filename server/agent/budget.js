export const INVESTIGATIVE = Object.freeze(['get_payment_request', 'get_order', 'get_payee_profile', 'check_lookalike', 'search_scam_patterns', 'get_elder_context'])
export const RECORDING = Object.freeze(['record_finding', 'raise_risk'])

export const LIMITS = Object.freeze({
  investigateSegment1: 6,
  investigateSegment2: 2,
  recordFinding: 8,
  raiseRisk: 3,
  hardCap: 16,
  focusAt: 13, // after 13 calls (from the 14th call on) only ask_elder (if not yet used) and write_report are allowed
})

export function toolKind(name) {
  if (INVESTIGATIVE.includes(name)) return 'investigate'
  if (RECORDING.includes(name)) return 'record'
  return name === 'ask_elder' || name === 'write_report' ? name : 'unknown'
}

// Counts calls for one payment. Only investigative tools use the investigation cap.
// Recording tools have their own caps, so a risky payment (many findings) still reaches its question.
export function createBudget({ segment, used = {}, total = 0 }) {
  const counts = {
    investigate: 0,
    total,
    record_finding: used.record_finding || 0,
    raise_risk: used.raise_risk || 0,
    ask_elder: used.ask_elder || 0,
    write_report: used.write_report || 0,
  }
  const investigateCap = segment === 1 ? LIMITS.investigateSegment1 : LIMITS.investigateSegment2

  function check(name) {
    const kind = toolKind(name)
    if (kind === 'unknown') return { ok: false, message: `Unknown tool ${name}` }
    if (counts.total >= LIMITS.hardCap) return { ok: false, message: 'Call limit reached. Stop investigating.' }
    const focused = counts.total >= LIMITS.focusAt
    if (kind === 'investigate') {
      if (focused) return { ok: false, message: 'Near the call limit. Only ask_elder or write_report are allowed now.' }
      if (counts.investigate >= investigateCap) return { ok: false, message: `Investigation limit reached (${investigateCap}). Record findings, then ask_elder or write_report.` }
    }
    if (kind === 'record') {
      if (focused) return { ok: false, message: 'Near the call limit. Only ask_elder or write_report are allowed now.' }
      if (name === 'record_finding' && counts.record_finding >= LIMITS.recordFinding) return { ok: false, message: 'Finding limit reached.' }
      if (name === 'raise_risk' && counts.raise_risk >= LIMITS.raiseRisk) return { ok: false, message: 'Risk change limit reached.' }
    }
    if (kind === 'ask_elder') {
      if (segment !== 1) return { ok: false, message: 'The question can only be asked before the answer arrives.' }
      if (counts.ask_elder >= 1) return { ok: false, message: 'You already asked the question.' }
    }
    if (kind === 'write_report' && counts.write_report >= 1) return { ok: false, message: 'The report is already written.' }
    return { ok: true }
  }

  function count(name) {
    const kind = toolKind(name)
    counts.total += 1
    if (kind === 'investigate') counts.investigate += 1
    else if (counts[name] !== undefined) counts[name] += 1
  }

  return { check, count, snapshot: () => ({ ...counts, investigateCap }) }
}
