import { randomBytes } from 'node:crypto'
import { ELDER_REASON_PHRASES } from './knowledge.js'

const FTC_SOCIAL = 'Among older adults\' losses that started on social media, online shopping scams were the most reported (FTC). An ad or post may fit this pattern.'

// Reads the conversation back as [{ name, input, result }] so the next move depends on what tools returned.
function history(messages) {
  const results = new Map()
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b)
  }
  const calls = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue
      const r = results.get(b.id)
      calls.push({ name: b.name, input: b.input, result: r ? safeJson(r.content) : null, id: b.id })
    }
  }
  return calls
}

const safeJson = (text) => { try { return JSON.parse(text) } catch { return null } }
const use = (name, input = {}) => ({ type: 'tool_use', id: `toolu_${randomBytes(6).toString('hex')}`, name, input })

function plan(calls, messages) {
  const done = (name) => calls.find((c) => c.name === name)
  const recorded = (kind) => calls.some((c) => c.name === 'record_finding' && c.input.kind === kind)
  const request = done('get_payment_request')
  if (!request) return use('get_payment_request')
  const info = request.result || {}
  const isRequest = info.kind === 'request'
  const matches = done('search_scam_patterns')?.result?.matches || []

  if (isRequest) {
    if (!done('search_scam_patterns')) return use('search_scam_patterns')
    const next = matches.find((m) => !recorded(m.type))
    if (next) return use('record_finding', { kind: next.type, quote: next.quote, source_tool: 'search_scam_patterns' })
    const kinds = matches.map((m) => m.type)
    return reportCall({ level: matches.length ? 'high' : 'low', kinds, info, isRequest })
  }

  if (!done('get_order')) return use('get_order')
  if (!done('check_lookalike')) return use('check_lookalike')
  const look = done('check_lookalike').result || {}
  const odd = look.name_matches_domain === false || (look.impersonates || []).length > 0
  if (odd && !recorded('name_domain_mismatch') && !recorded('lookalike_brand')) {
    const kind = look.name_matches_domain === false ? 'name_domain_mismatch' : 'lookalike_brand'
    return use('record_finding', { kind, quote: look.name_matches_domain === false ? `${look.display_name} / ${look.email_domain}` : `${look.display_name} resembles ${look.impersonates.join(', ')}`, source_tool: 'check_lookalike' })
  }
  const hasMessage = Boolean(info.message)
  if (hasMessage && !done('search_scam_patterns')) return use('search_scam_patterns')
  if (!hasMessage && !odd && !done('get_elder_context')) return use('get_elder_context')
  const unrecorded = matches.find((m) => !recorded(m.type))
  if (unrecorded) return use('record_finding', { kind: unrecorded.type, quote: unrecorded.quote, source_tool: 'search_scam_patterns' })
  const context = done('get_elder_context')?.result
  if (context?.well_above_usual && !recorded('amount_above_usual')) return use('record_finding', { kind: 'amount_above_usual', quote: `${context.this_payment_usd} vs usual ${context.typical_min_usd} to ${context.typical_max_usd}`, source_tool: 'get_elder_context' })

  const findings = calls.filter((c) => c.name === 'record_finding').length
  const raised = done('raise_risk')
  if (findings >= 2 && !raised) return use('raise_risk', { level: 'high', reason: 'Several independent warning signs together' })
  if (findings === 1 && !raised) return use('raise_risk', { level: 'medium', reason: 'One warning sign' })

  const high = raised?.input.level === 'high'
  const asked = done('ask_elder')
  if (high && !asked) return use('ask_elder', { question_id: 'how_found' })
  if (asked) {
    const answer = lastAnswer(messages)
    if (answer === 'An ad or post' && !recorded('social_media_origin')) return use('record_finding', { kind: 'social_media_origin', quote: FTC_SOCIAL, source_tool: 'ask_elder' })
  }
  const kinds = calls.filter((c) => c.name === 'record_finding').map((c) => c.input.kind)
  return reportCall({ level: high ? 'high' : kinds.length ? 'medium' : 'low', kinds, info, answer: asked ? lastAnswer(messages) : null })
}

function lastAnswer(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && String(b.content).includes('elder_answer')))
  const block = last?.content.find((b) => String(b.content).includes('elder_answer'))
  return block ? safeJson(block.content)?.elder_answer : null
}

function reportCall({ level, kinds, info, answer, isRequest }) {
  const phrases = kinds.map((k) => ELDER_REASON_PHRASES[k]).filter(Boolean)
  if (isRequest) {
    return use('write_report', {
      risk_level: level,
      family_summary: phrases.length ? `The request ${phrases.join(' and ')}.` : 'Nothing unusual found in this request.',
      elder_message: 'We told your family about this request. Please do not buy anything until you talk to them.',
      call_questions: ['Who asked you for this, and how did they contact you?', 'Did they ask you to keep it secret?'],
    })
  }
  if (level === 'low') {
    return use('write_report', {
      risk_level: 'low',
      family_summary: 'New seller, nothing else unusual found.',
      elder_message: 'This is a new seller, so a family member takes a quick look first. Nothing has been charged.',
      call_questions: ['Did you order this yourself?', 'Is this something you were planning to buy?'],
    })
  }
  return use('write_report', {
    risk_level: level,
    family_summary: `New seller. Signs found: ${phrases.join('; ')}.`,
    elder_message: 'This payment is waiting for a quick check by your family. Nothing has been charged.',
    call_questions: ['How did you first hear about this seller?', 'Did anyone ask you to keep this payment secret?'],
  })
}

// A scripted stand-in for Claude with the same message shapes as the Messages API.
// Used whenever there is no API key. Each step depends on earlier tool results, like the live model.
export function createMockLlm() {
  return {
    mode: 'mock',
    async step({ messages }) {
      const call = plan(history(messages), messages)
      return { stop_reason: 'tool_use', content: [call] }
    },
  }
}
