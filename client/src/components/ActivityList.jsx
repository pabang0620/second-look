export default function ActivityList({ items }) {
  if (items.length === 0) return null
  return (
    <section className="activity" aria-label="Activity">
      <h3>This month</h3>
      <ul>
        {items.map((a) => (
          <li key={a.id}><span>{a.payeeName} {a.amount}</span><span className="label">{a.label} <time>{new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></span></li>
        ))}
      </ul>
    </section>
  )
}
