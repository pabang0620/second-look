import { useState } from 'react'
import { clock } from '../usePoll.js'

const RISK_CLASS = { low: 'risk-low', medium: 'risk-mid', high: 'risk-high' }

export default function ReviewCard({ p, hint = '', phone, onApprove, onStop, onTrust }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = async (fn) => {
    setBusy(true)
    setError('')
    try { await fn() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return (
    <article className="card review" aria-label={`Payment to ${p.payeeName}`}>
      <h3>Mom wants to pay {p.amount} to {p.payeeName}{p.firstTimeSeller ? ' (new)' : ''}</h3>
      <p className="meta">
        <span className={`badge ${RISK_CLASS[p.risk]}`}>{p.riskLabel}</span>
        {p.secondRequest && <span className="badge risk-mid">Second request for this seller</span>}
        {p.secondsToAutoVoid !== null && <span className="small">Voids itself in {clock(p.secondsToAutoVoid)}</span>}
      </p>
      <p className="money">Money: {p.moneyStatus}</p>
      <ul className="signals">
        {p.signals.map((s) => <li key={s.kind}>{s.text}</li>)}
        {p.findings.map((f, i) => <li key={`${f.kind}-${i}`}><strong>{label(f.kind)}</strong>: "{f.quote}"</li>)}
      </ul>
      {p.question?.answer && <p className="said">Mom said: "{p.question.answer}" <span className="small">(shown to you, never used to clear the payment)</span></p>}
      {p.question && !p.question.answer && !p.question.closedBy && <p className="small">Asked Mom one question. Waiting for her answer{p.askSecondsLeft !== null ? ` (Claude finishes without it in ${clock(p.askSecondsLeft)})` : ''}.</p>}
      {p.investigation === 'running' && <p className="small">Claude is still checking...</p>}
      {p.checkedBy === 'rules' && <p className="badge risk-mid">Checked by safety rules only</p>}
      {p.report && <p className="summary">{p.report.summary}</p>}
      {p.modelLabel && <p className="small model-source">Investigation: {p.modelLabel}</p>}
      {p.report?.callQuestions?.length > 0 && <p className="small">Ask on the phone: {p.report.callQuestions.join(' / ')}</p>}
      {hint && <p className="small hint">{hint}</p>}
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => go(onApprove)}>Approve</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => go(onStop)}>Stop</button>
        <a className="btn secondary" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>Call Mom</a>
      </div>
      <p className="small">Mom's number: {phone}</p>
      {!p.trusted && <button type="button" className="link" onClick={() => go(onTrust)}>Always trust {p.payeeName}</button>}
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'How Claude checked'} ({p.checks} checks)</button>
      {open && <HowChecked p={p} />}
    </article>
  )
}

const label = (kind) => kind.replace(/_/g, ' ')

function HowChecked({ p }) {
  return (
    <ol className="how">
      {p.steps.map((s) => <li key={s.n}><code>{s.tool}</code> {s.summary}{s.source ? <span className="small"> (source: {s.source})</span> : null}</li>)}
      <li className="small">{p.findingsCount} findings, {p.questionsAsked} question{p.questionsAsked === 1 ? '' : 's'}. Claude can only raise the risk. It cannot approve, stop, capture or void.</li>
    </ol>
  )
}
