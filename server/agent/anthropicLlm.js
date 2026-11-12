import Anthropic from '@anthropic-ai/sdk'

// The live model. Never constructed without an API key.
export function createAnthropicLlm({ apiKey, model }) {
  const client = new Anthropic({ apiKey })
  return {
    mode: 'live',
    async step({ system, tools, messages, deadline, now }) {
      const remaining = Math.max(1000, deadline - now())
      const response = await client.messages.create(
        { model, max_tokens: 2000, system, tools, tool_choice: { type: 'auto' }, messages },
        { signal: AbortSignal.timeout(remaining) },
      )
      return { stop_reason: response.stop_reason, content: response.content }
    },
  }
}
