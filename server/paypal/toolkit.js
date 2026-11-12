// Live reads go through the PayPal Agent Toolkit (get_order), one toolkit per payee so credentials never mix.
// Created lazily, so the mock path never loads it.
const toolkits = new Map()

async function toolkitFor(payee) {
  const id = payee.credentials.clientId
  if (!toolkits.has(id)) {
    const { PayPalAgentToolkit } = await import('@paypal/agent-toolkit/openai')
    toolkits.set(id, new PayPalAgentToolkit({
      clientId: id,
      clientSecret: payee.credentials.clientSecret,
      configuration: { actions: { orders: { get: true } }, context: { sandbox: true } },
    }))
  }
  return toolkits.get(id)
}

export async function toolkitGetOrder(payee, orderId) {
  const toolkit = await toolkitFor(payee)
  const result = await toolkit.handleToolCall({ id: `get_${orderId}`, type: 'function', function: { name: 'get_order', arguments: JSON.stringify({ id: orderId }) } })
  const parsed = JSON.parse(result.content)
  if (parsed?.error) throw new Error(`PayPal get_order: ${typeof parsed.error === 'string' ? parsed.error : parsed.error.message}`)
  return parsed
}
