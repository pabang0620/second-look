import { createBudget, LIMITS } from './budget.js'

const RETRY_ATTEMPTS = 2

// A call cut off by our own segment deadline is not an API failure: the caller finishes with what was found.
const ABORT_NAMES = new Set(['AbortError', 'TimeoutError', 'APIUserAbortError', 'APIConnectionTimeoutError'])
const SLACK_MS = 50
export const isDeadlineError = (err, { deadline, now }) => ABORT_NAMES.has(err?.name) || now() >= deadline - SLACK_MS

async function callModel(llm, args) {
  let lastError
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await llm.step(args)
    } catch (err) {
      lastError = err
      if (isDeadlineError(err, args)) break // no retry once the time is up
    }
  }
  throw lastError
}

const errorResult = (use, message) => ({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ error: message }), is_error: true })

// One investigation segment. Segment 1 ends at ask_elder, write_report, a time limit or the hard call cap.
// Segment 2 starts after the answer. The model is never running while we wait for a person.
export async function runSegment({ llm, system, tools, messages, segment, used, deadline, now, execute, pendingResults = [], replayKey }) {
  const budget = createBudget({ segment, used })
  const results = [...pendingResults]
  const sources = new Set() // which model answered each turn, for the label the family sees
  const end = (fields) => ({ ...fields, budget: budget.snapshot(), sources: [...sources] })
  for (;;) {
    if (now() >= deadline) return end({ outcome: 'timeout' })
    if (budget.snapshot().total >= LIMITS.hardCap) return end({ outcome: 'hard_cap' })
    let response
    try {
      response = await callModel(llm, { system, tools, messages, deadline, now, replayKey })
    } catch (err) {
      if (isDeadlineError(err, { deadline, now })) return end({ outcome: 'timeout' })
      return end({ outcome: 'llm_error', error: String(err.message || err) })
    }
    sources.add(response.source || llm.label || 'Claude')
    messages.push({ role: 'assistant', content: response.content })
    const uses = response.content.filter((b) => b.type === 'tool_use')
    if (uses.length === 0) return end({ outcome: 'no_report' })

    let asked = null
    let reported = false
    for (const use of uses) {
      const verdict = budget.check(use.name)
      budget.count(use.name) // blocked calls count too, so a stuck model still ends at the hard cap
      if (!verdict.ok) {
        results.push(errorResult(use, verdict.message))
        continue
      }
      const out = await execute(use.name, use.input)
      if (use.name === 'ask_elder' && out.ok) { asked = use; continue }
      if (use.name === 'write_report' && out.ok) reported = true
      results.push(out.ok
        ? { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out.result).slice(0, 8000) }
        : errorResult(use, out.error))
    }
    if (asked) return end({ outcome: 'asked', askUseId: asked.id, pendingResults: results })
    if (reported) return end({ outcome: 'reported' })
    messages.push({ role: 'user', content: results.splice(0, results.length) })
  }
}
