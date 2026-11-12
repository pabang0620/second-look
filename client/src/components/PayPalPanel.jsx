export default function PayPalPanel({ panel, coverage }) {
  if (!panel || !panel.paymentId) return <section className="paypal-panel"><p>PayPal: no order yet. Pick a scenario above.</p></section>
  const calls = panel.calls.slice(-6)
  return (
    <section className="paypal-panel" aria-label="PayPal state">
      <p>
        <strong>PayPal</strong> order <code>{panel.payeeMode === 'sandbox' ? panel.orderId : panel.orderId?.slice(0, 10)}</code> {panel.payee} ({panel.payeeMode === 'mock' ? 'local mode' : 'sandbox'}):
        {' '}<span className="status">{panel.paypalStatus || '-'}</span>
      </p>
      <div className="panel-grid">
        <div>
          <h4>Calls (Request-Id)</h4>
          <ul>{calls.map((c, i) => <li key={i}><code>{c.op}</code> <code>{c.requestId}</code> {c.outcome}{c.detail ? ` (${c.detail})` : ''}</li>)}</ul>
        </div>
        <div>
          <h4>Webhooks (signature verified)</h4>
          <ul>
            {panel.webhooks.map((w) => <li key={w.id}><code>{w.type}</code> verify-webhook-signature: <strong>{w.verification}</strong></li>)}
            {panel.webhooks.length === 0 && <li>{panel.payeeMode === 'sandbox' ? 'Webhooks need a public URL (VERIFY V4)' : 'None yet'}</li>}
          </ul>
          <p className="small">Rejected for a bad signature: {panel.rejectedWebhooks}</p>
        </div>
      </div>
      <p className="small">{coverage}</p>
    </section>
  )
}
