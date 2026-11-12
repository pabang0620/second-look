import { randomBytes } from 'node:crypto'

// Replays a recorded run of the real model (Claude Sonnet through the Claude Code account, scripts/recordRuns.js).
// A recorded turn is replayed only while every earlier tool result equals the recorded one, so the replayed
// decisions always belong to the same inputs. Anything else (a different answer, a different seller, an earlier
// payment that changes a tool result) goes to the fallback model, and the source label says so.
export const SCRIPTED_LABEL = 'Scripted stand-in'
const VOLATILE_KEYS = new Set(['order_id', 'merchant_id', 'id'])
const DEFAULT_PACE_MS = 1200

// The same key is computed when recording and when replaying.
export function replayKeyOf(subject, payeeKey) {
  if (subject.kind === 'request') return `request|${subject.amountCents || 0}|${subject.text}`
  return ['payment', payeeKey, subject.amountCents, subject.memo, subject.message || '', subject.secondRequest ? 1 : 0].join('|')
}

export const recordedLabel = (run) => `Recorded run: ${run.modelName}, ${run.recordedAt}`

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).filter((k) => !VOLATILE_KEYS.has(k)).sort().map((k) => [k, stable(value[k])]))
  }
  return value
}

// Tool result content with ids that change per run (order ids) removed.
export function normalizeResult(content) {
  try { return JSON.stringify(stable(JSON.parse(content))) } catch { return String(content) }
}

const assistantTurns = (messages) => messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content))
const toolUses = (content) => content.filter((b) => b.type === 'tool_use')

function resultsById(messages) {
  const map = new Map()
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === 'tool_result') map.set(b.tool_use_id, b)
  }
  return map
}

// The answer the payer gave, if the conversation has reached segment 2.
function elderAnswer(messages) {
  for (const b of resultsById(messages).values()) {
    try {
      const parsed = JSON.parse(b.content)
      if (parsed && typeof parsed.elder_answer === 'string') return parsed.elder_answer
    } catch { /* not JSON */ }
  }
  return null
}

// True when the actual turns so far called the same tools with the same inputs and got the same results.
function prefixMatches(actual, recorded, results) {
  if (actual.length > recorded.length) return false
  return actual.every((turn, i) => {
    const got = toolUses(turn.content)
    const want = recorded[i].calls
    if (got.length !== want.length) return false
    return got.every((use, j) => {
      const rec = want[j]
      if (use.name !== rec.name || JSON.stringify(use.input) !== JSON.stringify(rec.input)) return false
      if (rec.name === 'ask_elder' || rec.result === undefined) return true // the answer picks the branch
      const res = results.get(use.id)
      return Boolean(res) && normalizeResult(res.content) === rec.result
    })
  })
}

function turnsFor(run, messages) {
  const answer = elderAnswer(messages)
  if (answer === null) return run.segment1
  const after = run.afterAnswer?.[answer]
  return after ? [...run.segment1, ...after] : null
}

const freshId = () => `toolu_r${randomBytes(6).toString('hex')}`

function toContent(turn) {
  const text = turn.text ? [{ type: 'text', text: turn.text }] : []
  return [...text, ...turn.calls.map((c) => ({ type: 'tool_use', id: freshId(), name: c.name, input: c.input }))]
}

export function createReplayLlm({ runs, fallback, paceMs = DEFAULT_PACE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const byKey = new Map(runs.map((r) => [r.key, r]))
  const fallbackLabel = fallback.label || SCRIPTED_LABEL
  return {
    mode: 'replay',
    label: runs.length ? `${recordedLabel(runs[0])} where one matches, ${fallbackLabel.toLowerCase()} otherwise` : fallbackLabel,
    hasRecording: (key) => byKey.has(key),
    async step(args) {
      const run = byKey.get(args.replayKey)
      const turns = run ? turnsFor(run, args.messages) : null
      const actual = assistantTurns(args.messages)
      if (turns && actual.length < turns.length && prefixMatches(actual, turns, resultsById(args.messages))) {
        const turn = turns[actual.length]
        if (paceMs > 0) await sleep(Math.min(turn.ms || 0, paceMs))
        const content = toContent(turn)
        return { stop_reason: 'tool_use', content, source: recordedLabel(run) }
      }
      const response = await fallback.step(args)
      return { ...response, source: response.source || fallbackLabel }
    },
  }
}
