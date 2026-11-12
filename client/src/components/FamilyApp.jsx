import { useEffect, useState } from 'react'
import { bootstrap, call } from '../api.js'
import { clock } from '../usePoll.js'
import ReviewCard from './ReviewCard.jsx'
import ActivityList from './ActivityList.jsx'
import Icon from './Icon.jsx'

const RULES = {
  RULES_ON: ['chip-low', 'check', 'Checks are on'],
  PAUSE_REQUESTED: ['chip-mid', 'clock', 'Pause requested, takes 24 hours'],
  RULES_OFF: ['chip-high', 'stop', 'Checks are off'],
}

// The family's side: waiting payments with the evidence, approved ones that can still be undone, and the activity list.
export default function FamilyApp({ family, refresh, judgeMode = false }) {
  const [undoSeconds, setUndoSeconds] = useState(null)
  useEffect(() => { bootstrap().then((b) => setUndoSeconds(Math.round(b.timers.undoMs / 1000))).catch(() => {}) }, [])
  if (!family) return <p>Loading...</p>
  const { household, waiting, activity, requests, impact } = family
  const act = async (path, body) => { await call('family', 'POST', path, body || {}); await refresh() }
  const [rulesClass, rulesIcon, rulesWords] = RULES[household.rulesState] || RULES.RULES_OFF
  return (
    <div className="family">
      <header className="family-head">
        <h2>{judgeMode ? 'Payments that need a look' : `${household.familyName}: payments that need a look`}</h2>
        <span className={`chip ${rulesClass}`} aria-label={`Rules: ${rulesWords}`}><Icon name={rulesIcon} />{rulesWords}</span>
        {household.rulesState !== 'RULES_ON' && <button type="button" className="link" onClick={() => act('/api/family/rules/resume')}>Turn rules on</button>}
      </header>
      {impact.any && (
        <div className="impact" aria-label="What Second Look did">
          <p className="stat"><span>Stopped before charge</span><strong>{impact.stopped}</strong></p>
          <p className="stat"><span>Paid after a check</span><strong>{impact.paid}</strong></p>
          <p className="stat"><span>Released, no answer</span><strong>{impact.released}</strong></p>
        </div>
      )}
      {requests.map((r) => (
        <article key={r.id} className="card alert">
          <p className="eyebrow"><Icon name="alert" />Alert</p>
          <h3>Mom was asked for {r.amount || 'money'} outside PayPal</h3>
          <p>Claude noticed: {[...new Set(r.findings.map((f) => f.kind.replace(/_/g, ' ')))].join(', ') || 'nothing specific'}.</p>
          {r.modelLabel && <p className="note model-source">Investigation: {r.modelLabel}</p>}
          <a className="btn secondary" href={`tel:${household.elderPhone.replace(/[^\d+]/g, '')}`}><Icon name="phone" />Call Mom {household.elderPhone}</a>
        </article>
      ))}
      {waiting.length === 0 && <p className="empty">Nothing waiting. Payments to known sellers go straight through.</p>}
      {waiting.map((p) => (
        p.canUndo
          ? (
            <article key={p.id} className="card ok">
              <p className="eyebrow"><Icon name="check" />Approved</p>
              <h3>Approved: {p.payeeName} {p.amount}</h3>
              <p>Approved. PayPal will capture in <strong>{clock(p.undoSecondsLeft)}</strong>. Changed your mind? Undo cancels the hold and nothing is charged.</p>
              <button type="button" className="btn secondary" onClick={() => act(`/api/family/payments/${p.id}/undo`)}>Undo</button>
            </article>
          )
          : <ReviewCard key={p.id} p={p} familyName={household.familyName} undoSeconds={undoSeconds} hint={judgeMode && p.payeeKey === 'lakeside_tickets' ? 'Judge mode: leave this one alone and watch the timer. Nobody answered, so it voids itself.' : ''} phone={household.elderPhone} onApprove={() => act(`/api/family/payments/${p.id}/approve`)} onStop={() => act(`/api/family/payments/${p.id}/stop`)} onTrust={() => act(`/api/family/payees/${p.payeeKey}/trust`)} />
      ))}
      <ActivityList items={activity} />
      <p className="note">Settings: pausing the rules takes 24 hours. You can only approve or stop; you cannot change the seller or the amount.</p>
    </div>
  )
}
