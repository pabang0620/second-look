import { createAnthropicLlm } from './anthropicLlm.js'
import { createAccountLlm } from './accountLlm.js'

// Which model runs. Returns undefined for the scripted stand-in. FORCE_MOCK=1 always wins.
// LLM_BACKEND=account uses the local Claude Code login; it never reads ANTHROPIC_API_KEY.
export function selectLlm(config) {
  if (config.forceMock) return undefined
  if (config.llmBackend === 'account') return createAccountLlm({ model: config.anthropicModel })
  if (config.anthropicKey) return createAnthropicLlm({ apiKey: config.anthropicKey, model: config.anthropicModel })
  return undefined
}
