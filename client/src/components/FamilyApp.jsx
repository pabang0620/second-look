import { call } from '../api.js'
import { clock } from '../usePoll.js'
import ReviewCard from './ReviewCard.jsx'
import ActivityList from './ActivityList.jsx'

// The family's side: waiting payments with the evidence, approved ones that can still be undone, and the activity list.
export default function FamilyApp({ family, refresh, judgeMode = false }) {
  if (!family) return <p>Loading...</p>
  const { household, waiting, activity, requests, impact } = family
  const act = async (path, body) => { await call('family', 'POST', path, body || {}); await refresh() }
  return (
    <div className="family">
      <header className="family-head">
        <h2>{household.familyName}: payments that need a look</h2>
        <p className="small">Rules: {household.rulesState === 'RULES_ON' ? 'on' : household.rulesState === 'PAUSE_REQUESTED' ? 'pause requested, takes 24 hours' : 'off'}.
          {household.rulesState !== 'RULES_ON' && <> <button type="button" className="link" onClick={() => act('/api/family/rules/resume')}>Turn rules on</button></>}</p>
      </header>
      {impact.any && (
        <p className="impact" aria-label="What Second Look did">
          Stopped before charge: <strong>{impact.stopped}</strong> / Paid after a check: <strong>{impact.paid}</strong> / Released, no answer: <strong>{impact.released}</strong>
        </p>
      )}
      {requests.map((r) => (
        <article key={r.id} className="card alert">
          <h3>Mom was asked for {r.amount || 'money'} outside PayPal</h3>
          <p>Claude noticed: {[...new Set(r.findings.map((f) => f.kind.replace(/_/g, ' ')))].join(', ') || 'nothing specific'}.</p>
          <a className="btn secondary" href={`tel:${household.elderPhone.replace(/[^\d+]/g, '')}`}>Call Mom {household.elderPhone}</a>
        </article>
      ))}
      {waiting.length === 0 && <p className="empty">Nothing waiting. Payments to known sellers go straight through.</p>}
      {waiting.map((p) => (
        p.canUndo
          ? (
            <article key={p.id} className="card ok">
              <h3>Approved: {p.payeeName} {p.amount}</h3>
              <p>Approved. PayPal will capture in <strong>{clock(p.undoSecondsLeft)}</strong>.</p>
              <button type="button" className="btn secondary" onClick={() => act(`/api/family/payments/${p.id}/undo`)}>Undo</button>
            </article>
          )
          : <ReviewCard key={p.id} p={p} hint={judgeMode && p.payeeKey === 'lakeside_tickets' ? 'Judge mode: leave this one alone and watch the timer. Nobody answered, so it voids itself.' : ''} phone={household.elderPhone} onApprove={() => act(`/api/family/payments/${p.id}/approve`)} onStop={() => act(`/api/family/payments/${p.id}/stop`)} onTrust={() => act(`/api/family/payees/${p.payeeKey}/trust`)} />
      ))}
      <ActivityList items={activity} />
      <p className="small">Settings: pausing the rules takes 24 hours. You can only approve or stop; you cannot change the seller or the amount.</p>
    </div>
  )
}
