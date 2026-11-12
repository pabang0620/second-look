import { STATES, newId } from '../store.js'
import { raiseRisk } from '../rules.js'
import { claudeTools } from './tools.js'
import { executeTool } from './tools.js'
import { runSegment } from './loop.js'
import { SYSTEM_PROMPT, REQUEST_PROMPT } from './prompt.js'
import { ELDER_REASON_PHRASES } from './knowledge.js'
import { replayKeyOf } from './replayLlm.js'

const answerNote = 'Shown to the family. It does not lower the risk.'

export function elderReason(findings) {
  const phrases = [...new Set(findings.map((f) => ELDER_REASON_PHRASES[f.kind]).filter(Boolean))]
  if (phrases.length === 0) return 'your family wanted a closer look first'
  return phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`
}

function makeSink(read, write, now) {
  return {
    step: (s) => write((cur) => ({ steps: [...cur.steps, { n: cur.steps.length + 1, at: now(), ...s }] })),
    finding: (f) => write((cur) => ({ findings: [...cur.findings, { ...f, at: now() }] })),
    raise(level) {
      let result = 'low'
      write((cur) => { result = raiseRisk(cur.risk, level); return { risk: result } })
      return result
    },
    ask: (q) => write(() => ({ question: { id: 'how_found', text: q.text, options: q.options, askedAt: now(), answer: null, closedBy: null } })),
    report: (r) => write((cur) => ({
      risk: raiseRisk(cur.risk, r.risk_level),
      report: { familySummary: r.family_summary, elderMessage: r.elder_message, callQuestions: r.call_questions, source: 'claude' },
    })),
  }
}

// Fallbacks never lower risk and never touch the hold. They only write the card text.
function rulesReport(payment, signals) {
  return {
    familySummary: `Held by safety rules: ${signals.map((s) => s.text).join('; ') || 'new seller'}. Claude could not check this one.`,
    elderMessage: 'This payment is waiting for a quick check by your family. Nothing has been charged.',
    callQuestions: ['Did you start this payment yourself?', 'How did you find this seller?'],
    source: 'rules',
  }
}

function limitReport(findings, signals) {
  const phrases = [...new Set(findings.map((f) => ELDER_REASON_PHRASES[f.kind]).filter(Boolean))]
  return {
    familySummary: phrases.length ? `Held. Signs found so far: ${phrases.join('; ')}.` : `Held by safety rules: ${signals.map((s) => s.text).join('; ')}.`,
    elderMessage: 'This payment is waiting for a quick check by your family. Nothing has been charged.',
    callQuestions: ['How did you first hear about this seller?', 'Did anyone ask you to keep this payment secret?'],
    source: 'limit',
  }
}

export function createInvestigator({ store, registry, gateway, llm, clock, wall = { now: () => Date.now() }, timers, signalsOf }) {
  const inflight = new Map()

  function track(id, promise) {
    const run = promise.catch((err) => {
      process.stderr.write(`investigation failed for ${id}: ${err?.stack || err}\n`)
    }).finally(() => { if (inflight.get(id) === run) inflight.delete(id) })
    inflight.set(id, run)
    return run
  }

  function paymentContext(id) {
    const payment = store.get(id)
    const payee = registry.get(payment.payeeKey)
    const earlierCaptured = store.list().filter((p) => p.payeeKey === payee.key && p.state === STATES.CAPTURED && p.id !== id).length
    return {
      subject: { kind: 'payment', amountCents: payment.amountCents, memo: payment.memo, message: payment.message, secondRequest: payment.secondRequest, orderId: payment.orderId },
      payee, household: store.household(), gateway, earlierCaptured,
      sink: makeSink(() => store.get(id), (patch) => store.update(id, patch), clock.now),
    }
  }

  async function runPaymentSegment(id, segment, messages, pendingResults) {
    const payment = store.get(id)
    const ctx = paymentContext(id)
    const outcome = await runSegment({
      llm, system: SYSTEM_PROMPT, tools: claudeTools(), messages, segment,
      used: payment.agent?.used || {},
      deadline: wall.now() + (segment === 1 ? timers.segment1Ms : timers.segment2Ms),
      now: wall.now,
      execute: (name, input) => executeTool(name, input, ctx),
      pendingResults,
      replayKey: replayKeyOf(ctx.subject, ctx.payee.key, ctx.payee.credentials.mode),
    })
    store.update(id, (p) => ({ modelSources: { ...(p.modelSources || {}), [segment]: outcome.sources } }))
    const used = { ...(payment.agent?.used || {}), record_finding: outcome.budget.record_finding, raise_risk: outcome.budget.raise_risk, ask_elder: outcome.budget.ask_elder, write_report: outcome.budget.write_report }
    return { outcome, used }
  }

  async function finish(id, segment, messages, pendingResults) {
    const { outcome, used } = await runPaymentSegment(id, segment, messages, pendingResults)
    const current = store.get(id)
    const signals = signalsOf(current)
    if (outcome.outcome === 'asked') {
      const moved = store.transition(id, [STATES.HELD], STATES.HELD_ASKING, {
        askExpiresAt: clock.now() + timers.askTimeoutMs,
        investigation: { status: 'asking', segment: 1 },
        agent: { messages, used, askUseId: outcome.askUseId, pendingResults: outcome.pendingResults },
      })
      // The family already decided while the model was working: the question is moot.
      if (!moved) store.update(id, (p) => ({ question: p.question ? { ...p.question, closedBy: 'family' } : null, investigation: { status: 'ended', segment } }))
      return
    }
    if (outcome.outcome === 'reported') {
      store.update(id, { investigation: { status: 'done', segment }, agent: { messages, used } })
      return
    }
    if (outcome.outcome === 'llm_error') {
      store.update(id, { investigation: { status: 'rules_only', segment, error: outcome.error.slice(0, 120) }, report: rulesReport(current, signals), agent: { messages, used } })
      return
    }
    // timeout, hard cap, or the model stopped without a report: finish with what was found.
    store.update(id, { investigation: { status: 'done', segment, limit: outcome.outcome }, report: limitReport(current.findings, signals), agent: { messages, used } })
  }

  return {
    start(id) {
      store.update(id, { investigation: { status: 'running', segment: 1 } })
      const messages = [{ role: 'user', content: 'A payment is being held. Investigate it, using your tools, and finish with write_report.' }]
      return track(id, finish(id, 1, messages, []))
    },

    // Called when the payer answers, or when the question times out ("No answer"). Returns false if nothing was waiting.
    resume(id, answer) {
      const payment = store.get(id)
      if (!payment || payment.state !== STATES.HELD_ASKING || !payment.agent?.askUseId) return null
      const moved = store.transition(id, [STATES.HELD_ASKING], STATES.HELD, (p) => ({
        question: { ...p.question, answer, answeredAt: clock.now() },
        investigation: { status: 'running', segment: 2 },
      }))
      if (!moved) return null
      const { messages, askUseId, pendingResults } = payment.agent
      const toolResult = { type: 'tool_result', tool_use_id: askUseId, content: JSON.stringify({ elder_answer: answer, note: answerNote }) }
      messages.push({ role: 'user', content: [...pendingResults, toolResult] })
      return track(id, finish(id, 2, messages, []))
    },

    // The family decided while a question was open. No model is running, so there is nothing to stop.
    closeQuestion(id) {
      store.update(id, (p) => ({
        question: p.question && p.question.answer === null ? { ...p.question, closedBy: 'family' } : p.question,
        investigation: { ...p.investigation, status: p.investigation?.status === 'asking' ? 'ended' : p.investigation?.status },
        report: p.report || limitReport(p.findings, signalsOf(p)),
      }))
    },

    settle: (id) => inflight.get(id) || Promise.resolve(),
    settleAll: () => Promise.all([...inflight.values()]),

    // "Check a request": no money, no hold. Investigates the pasted text and tells the family.
    async checkRequest({ text, amountCents }) {
      let record = { id: newId('req'), kind: 'request', text, amountCents: amountCents || null, steps: [], findings: [], risk: 'low', report: null, createdAt: clock.now() }
      const read = () => record
      const write = (patch) => { record = { ...record, ...(typeof patch === 'function' ? patch(record) : patch) } }
      const ctx = { subject: { kind: 'request', amountCents: amountCents || 0, text }, payee: null, household: store.household(), gateway, earlierCaptured: 0, sink: makeSink(read, write, clock.now) }
      const messages = [{ role: 'user', content: 'The payer pasted a request for money. Investigate it and finish with write_report.' }]
      const outcome = await runSegment({
        llm, system: REQUEST_PROMPT, tools: claudeTools({ requestMode: true }), messages, segment: 1, used: {},
        deadline: wall.now() + timers.segment1Ms, now: wall.now, execute: (name, input) => executeTool(name, input, ctx), pendingResults: [],
        replayKey: replayKeyOf(ctx.subject),
      })
      record = { ...record, modelSources: { 1: outcome.sources } }
      if (!record.report) {
        const rules = { familySummary: 'Claude could not read this request. Please call Mom.', elderMessage: 'We told your family about this request. Please do not buy anything until you talk to them.', callQuestions: ['Who asked you for this?'], source: outcome.outcome === 'llm_error' ? 'rules' : 'limit' }
        record = { ...record, report: record.findings.length ? limitReport(record.findings, []) : rules }
      }
      store.addRequest(record)
      store.log({ at: clock.now(), kind: 'request_alert', text: `Mom was asked for ${record.amountCents ? `$${(record.amountCents / 100).toFixed(0)}` : 'money'} outside PayPal. Claude noticed: ${[...new Set(record.findings.map((f) => f.kind.replace(/_/g, ' ')))].join(', ') || 'nothing specific'}.`, requestId: record.id })
      return record
    },
  }
}
