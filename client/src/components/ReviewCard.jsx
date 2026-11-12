import { useState } from 'react'
import { clock } from '../usePoll.js'
import Icon from './Icon.jsx'

const RISK = { low: ['chip-low', 'check'], medium: ['chip-mid', 'alert'], high: ['chip-high', 'alert'] }

// Sarah's decision card: what it is, what Claude found, then three plain boxes (the payment, who decides,
// what PayPal will do) and the two choices. Stop comes first because it is the safe choice.
export default function ReviewCard({ p, hint = '', phone, familyName = 'You', undoSeconds = null, onApprove, onStop, onTrust }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = async (fn) => {
    setBusy(true)
    setError('')
    try { await fn() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const [riskClass, riskIcon] = RISK[p.risk] || RISK.medium
  const undo = undoSeconds ? `a ${undoSeconds >= 120 ? `${Math.round(undoSeconds / 60)} minute` : `${undoSeconds} second`} undo window` : 'a short undo window'
  return (
    <article className="card review" aria-label={`Payment to ${p.payeeName}`}>
      <p className="eyebrow"><Icon name="alert" />Your decision</p>
      <h3>Mom wants to pay {p.amount} to {p.payeeName}{p.firstTimeSeller ? ' (new)' : ''}</h3>
      <div className="chips">
        <span className={`chip ${riskClass}`}><Icon name={riskIcon} />{p.riskLabel}</span>
        <span className="chip chip-held"><Icon name="lock" />Money: {p.moneyStatus}</span>
        {p.secondRequest && <span className="chip chip-mid"><Icon name="alert" />Second request for this seller</span>}
        {p.secondsToAutoVoid !== null && <span className="chip chip-time"><Icon name="clock" />Voids itself in {clock(p.secondsToAutoVoid)}</span>}
      </div>
      <h4>What Claude found</h4>
      <ul className="found">
        {p.signals.map((s) => <li key={s.kind} className="plain-signal"><Icon name="info" /><span>{s.text}</span></li>)}
        {p.findings.map((f, i) => <li key={`${f.kind}-${i}`}><Icon name="alert" /><span><strong>{label(f.kind)}</strong>: "{f.quote}"</span></li>)}
      </ul>
      {p.question?.answer && <p className="said">Mom said: <strong>"{p.question.answer}"</strong> (shown to you, never used to clear the payment)</p>}
      {p.question && !p.question.answer && !p.question.closedBy && <p className="waiting-note"><Icon name="clock" /><span>Asked Mom one question. Waiting for her answer{p.askSecondsLeft !== null ? ` (Claude finishes without it in ${clock(p.askSecondsLeft)})` : ''}.</span></p>}
      {p.investigation === 'running' && <p className="waiting-note"><Icon name="clock" /><span>Claude is still checking...</span></p>}
      {p.checkedBy === 'rules' && <p className="chip chip-mid"><Icon name="alert" />Checked by safety rules only</p>}
      {p.report && <p className="summary">{p.report.summary}</p>}
      {p.report?.callQuestions?.length > 0 && <p>Ask on the phone: {p.report.callQuestions.join(' / ')}</p>}
      <div className="trust">
        <div><h4>The payment</h4><p>{p.amount} to {p.payeeName}{p.firstTimeSeller ? ', a first payment to this seller' : ''}. Nothing is charged unless you approve.</p></div>
        <div><h4>Who decides</h4><p>{familyName}. You can approve or stop. You cannot change the seller or the amount.</p></div>
        <div><h4>What PayPal will do</h4><p><strong>Stop</strong>: cancel the hold, nothing is charged. <strong>Approve</strong>: take the payment after {undo}. Nobody answers: the hold cancels itself.</p></div>
      </div>
      {hint && <p className="hint">{hint}</p>}
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" className="btn danger" disabled={busy} onClick={() => go(onStop)}><Icon name="stop" />Stop</button>
        <button type="button" className="btn" disabled={busy} onClick={() => go(onApprove)}><Icon name="check" />Approve</button>
        <a className="btn secondary" href={`tel:${phone.replace(/[^\d+]/g, '')}`}><Icon name="phone" />Call Mom</a>
      </div>
      <p className="note">Mom's number: {phone}.{p.modelLabel && <span className="model-source"> Investigation: {p.modelLabel}</span>}</p>
      <div className="card-links">
        {!p.trusted && <button type="button" className="link" onClick={() => go(onTrust)}>Always trust {p.payeeName}</button>}
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'How Claude checked'} ({p.checks} checks)</button>
      </div>
      {open && <HowChecked p={p} />}
    </article>
  )
}

const label = (kind) => {
  const words = kind.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function HowChecked({ p }) {
  return (
    <ol className="how">
      {p.steps.map((s) => <li key={s.n}><code>{s.tool}</code> {s.summary}{s.source ? <span> (source: {s.source})</span> : null}</li>)}
      <li>{p.findingsCount} findings, {p.questionsAsked} question{p.questionsAsked === 1 ? '' : 's'}. Claude can only raise the risk. It cannot approve, stop, capture or void.</li>
    </ol>
  )
}
