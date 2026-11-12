import { z } from 'zod'
import { toolkitGetOrder } from '../paypal/toolkit.js'
import { lookalikeCheck, searchPatterns } from './knowledge.js'
import { toolKind } from './budget.js'
import { toValue, formatUsd } from '../money.js'
import { typicalRange } from '../rules.js'

export const FINDING_KINDS = ['name_domain_mismatch', 'lookalike_brand', 'urgency', 'secrecy', 'gift_card', 'crypto', 'remote_access', 'family_impersonation', 'amount_above_usual', 'amount_mismatch', 'social_media_origin']
export const ELDER_OPTIONS = ['An ad or post', 'They contacted me', 'I found them', 'Not sure']
export const QUESTIONS = Object.freeze({ how_found: { text: 'How did you first hear about this seller?', options: ELDER_OPTIONS } })

const empty = z.object({}).strict()
const defs = [
  { name: 'get_payment_request', description: 'Read the payment request: amount, seller name, memo and any pasted message.', schema: empty, properties: {} },
  { name: 'get_order', description: 'Read the PayPal order and compare its amount, memo and seller email with the request.', schema: empty, properties: {} },
  { name: 'get_payee_profile', description: 'History of this seller with this family: first time or not, earlier payments, allowlist.', schema: empty, properties: {} },
  { name: 'check_lookalike', description: 'Check whether the seller name imitates a bank, agency or known company, and whether the name matches the email domain.', schema: empty, properties: {} },
  { name: 'search_scam_patterns', description: 'Match the pasted message against known scam patterns (pressure, secrecy, gift cards, crypto, remote access, family impersonation).', schema: empty, properties: {} },
  { name: 'get_elder_context', description: 'Typical payment amounts for this person.', schema: empty, properties: {} },
  { name: 'ask_elder', description: 'Ask the payer one short question with buttons. Ends this turn; the answer comes back later. Use only when you cannot tell where the seller came from and the risk is high.', schema: z.object({ question_id: z.enum(['how_found']) }).strict(), properties: { question_id: { type: 'string', enum: ['how_found'] } }, required: ['question_id'] },
  { name: 'record_finding', description: 'Save one signal with a quoted sentence as evidence.', schema: z.object({ kind: z.enum(FINDING_KINDS), quote: z.string().min(3).max(240), source_tool: z.string().max(40) }).strict(), properties: { kind: { type: 'string', enum: FINDING_KINDS }, quote: { type: 'string', minLength: 3, maxLength: 240 }, source_tool: { type: 'string', maxLength: 40 } }, required: ['kind', 'quote', 'source_tool'] },
  { name: 'raise_risk', description: 'Raise the risk level. It can never be lowered and it never releases the hold.', schema: z.object({ level: z.enum(['low', 'medium', 'high']), reason: z.string().min(3).max(240) }).strict(), properties: { level: { type: 'string', enum: ['low', 'medium', 'high'] }, reason: { type: 'string', minLength: 3, maxLength: 240 } }, required: ['level', 'reason'] },
  { name: 'write_report', description: 'You get one attempt, so keep within the limits: family summary up to 600 characters, payer message up to 300, each phone question up to 200. Finish with a short report for the family, two calm sentences for the payer, and two questions the family can ask on the phone.', schema: z.object({ risk_level: z.enum(['low', 'medium', 'high']), family_summary: z.string().min(3).max(600), elder_message: z.string().min(3).max(300), call_questions: z.array(z.string().max(200)).min(1).max(2) }).strict(), properties: { risk_level: { type: 'string', enum: ['low', 'medium', 'high'] }, family_summary: { type: 'string', maxLength: 600 }, elder_message: { type: 'string', maxLength: 300 }, call_questions: { type: 'array', items: { type: 'string', maxLength: 200 }, minItems: 1, maxItems: 2 } }, required: ['risk_level', 'family_summary', 'elder_message', 'call_questions'] },
]

const byName = new Map(defs.map((d) => [d.name, d]))

// Tool list for the model. There is deliberately no capture, void or release tool.
export function claudeTools({ requestMode = false } = {}) {
  const allowed = requestMode ? ['get_payment_request', 'search_scam_patterns', 'record_finding', 'write_report'] : defs.map((d) => d.name)
  return defs.filter((d) => allowed.includes(d.name)).map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: { type: 'object', properties: d.properties, required: d.required || [], additionalProperties: false },
  }))
}

const dollars = (cents) => formatUsd(cents)

// subject: { kind: 'payment'|'request', amountCents, memo, message, secondRequest, orderId, text }
async function runInvestigation(name, ctx) {
  const { subject, payee, household, gateway } = ctx
  switch (name) {
    case 'get_payment_request': {
      if (subject.kind === 'request') {
        return { result: { kind: 'request', amount_usd: subject.amountCents ? toValue(subject.amountCents) : null, message: subject.text }, summary: 'Read the request text' }
      }
      return {
        result: { kind: 'payment', amount_usd: toValue(subject.amountCents), payee_display_name: payee.displayName, memo: subject.memo, message: subject.message || null, second_request: !!subject.secondRequest },
        summary: `Read the request: ${dollars(subject.amountCents)} to ${payee.displayName}${subject.message ? ', with a pasted message' : ', no message'}`,
      }
    }
    case 'get_order': {
      const order = payee.credentials.mode === 'sandbox' ? await toolkitGetOrder(payee, subject.orderId) : await gateway.getOrder(payee, subject.orderId)
      const unit = order.purchase_units?.[0] || {}
      const amountMatches = unit.amount?.value === toValue(subject.amountCents)
      const memoMatches = (unit.description || '') === subject.memo.slice(0, 120)
      return {
        result: { order_id: order.id, status: order.status, amount_usd: unit.amount?.value, memo: unit.description, payee_email: unit.payee?.email_address, merchant_id: unit.payee?.merchant_id, amount_matches_request: amountMatches, memo_matches_request: memoMatches },
        summary: amountMatches ? `Compared with the PayPal order: amount matches, seller email ${unit.payee?.email_address}` : 'The PayPal order amount does not match the request',
        source: payee.credentials.mode === 'sandbox' ? 'PayPal Agent Toolkit, sandbox' : 'local PayPal stand-in',
      }
    }
    case 'get_payee_profile': {
      const earlier = ctx.earlierCaptured
      const trusted = household.trustedPayees.has(payee.key)
      return {
        result: { display_name: payee.displayName, email: payee.email, email_domain: payee.domain, first_time: !trusted && earlier === 0, earlier_captured_payments: earlier, on_family_allowlist: trusted },
        summary: trusted ? 'Seller is on the family allowlist' : earlier === 0 ? 'First payment to this seller' : `${earlier} earlier payment(s) to this seller`,
      }
    }
    case 'check_lookalike': {
      const check = lookalikeCheck({ displayName: payee.displayName, domain: payee.domain })
      return {
        result: { display_name: payee.displayName, email_domain: payee.domain, name_matches_domain: check.nameMatchesDomain, impersonates: check.impersonates },
        summary: !check.nameMatchesDomain ? `Name "${payee.displayName}" does not match the email domain ${payee.domain}` : check.impersonates.length ? `Name resembles: ${check.impersonates.join(', ')}` : 'Name and email domain are consistent, no imitation found',
      }
    }
    case 'search_scam_patterns': {
      const matches = searchPatterns(subject.kind === 'request' ? subject.text : subject.message)
      return {
        result: { matches, checked: Boolean(subject.kind === 'request' ? subject.text : subject.message) },
        summary: matches.length ? `Message matches: ${matches.map((m) => m.label.toLowerCase()).join('; ')}` : 'No known scam pattern in the message',
        source: matches.find((m) => m.source)?.source?.org,
      }
    }
    case 'get_elder_context': {
      const range = typicalRange(household)
      const over = subject.amountCents > range.maxCents
      const wellOver = subject.amountCents > range.maxCents * 2
      const under = subject.amountCents < range.minCents
      const span = `${dollars(range.minCents)} to ${dollars(range.maxCents)}`
      const summary = wellOver ? `${dollars(subject.amountCents)} is well above the usual range (${span})`
        : over ? `${dollars(subject.amountCents)} is above the usual range (${span})`
          : under ? `${dollars(subject.amountCents)} is below the usual range (${span})`
            : `${dollars(subject.amountCents)} is within the usual range (${span})`
      return {
        result: { typical_min_usd: toValue(range.minCents), typical_max_usd: toValue(range.maxCents), this_payment_usd: toValue(subject.amountCents), above_usual_range: over, well_above_usual: wellOver, below_usual_range: under },
        summary,
      }
    }
    default:
      throw new Error(`Unknown tool ${name}`)
  }
}

// Runs one tool call. Recording and ending tools go through ctx.sink, which owns persistence.
export async function executeTool(name, input, ctx) {
  const def = byName.get(name)
  if (!def) return { ok: false, error: `Unknown tool ${name}` }
  const parsed = def.schema.safeParse(input ?? {})
  if (!parsed.success) return { ok: false, error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}` }
  try {
    const kind = toolKind(name)
    if (kind === 'investigate') {
      const out = await runInvestigation(name, ctx)
      ctx.sink.step({ tool: name, kind: 'check', summary: out.summary, source: out.source || null })
      return { ok: true, result: out.result }
    }
    if (name === 'record_finding') {
      ctx.sink.finding({ kind: parsed.data.kind, quote: parsed.data.quote, sourceTool: parsed.data.source_tool })
      return { ok: true, result: { saved: true } }
    }
    if (name === 'raise_risk') {
      const level = ctx.sink.raise(parsed.data.level, parsed.data.reason)
      return parsed.data.level === level ? { ok: true, result: { risk: level } } : { ok: false, error: `Risk stays ${level}. It can only go up.` }
    }
    if (name === 'ask_elder') {
      const question = QUESTIONS[parsed.data.question_id]
      ctx.sink.ask(question)
      return { ok: true, result: { asked: true } }
    }
    ctx.sink.report(parsed.data)
    return { ok: true, result: { saved: true } }
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) }
  }
}
