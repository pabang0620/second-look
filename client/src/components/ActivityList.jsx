import Icon from './Icon.jsx'

// The label already says what happened; the icon repeats it.
const iconFor = (label) => {
  if (/^(Waiting|In progress)|waiting to capture/.test(label)) return 'clock'
  if (/^(Paid|Approved by)/.test(label)) return 'check'
  if (/^(Stopped|Expired|Undone|Not charged)/.test(label)) return 'stop'
  if (/^Alert/.test(label)) return 'alert'
  return 'info'
}

export default function ActivityList({ items }) {
  if (items.length === 0) return null
  return (
    <section className="activity" aria-label="Activity">
      <h3>This month</h3>
      <ul>
        {items.map((a) => (
          <li key={a.id}><span>{a.payeeName} {a.amount}</span><span className="label"><Icon name={iconFor(a.label)} />{a.label} <time>{new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></span></li>
        ))}
      </ul>
    </section>
  )
}
