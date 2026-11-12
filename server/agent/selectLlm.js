import { createAnthropicLlm } from './anthropicLlm.js'
import { createAccountLlm } from './accountLlm.js'
import { createMockLlm } from './mockLlm.js'
import { createReplayLlm } from './replayLlm.js'
import { loadRecordedRuns } from './recordedRuns.js'

// Which model runs. Returns undefined for the scripted stand-in. FORCE_MOCK=1 always wins.
// LLM_BACKEND=account uses the local Claude Code login; it never reads ANTHROPIC_API_KEY.
export function selectLlm(config) {
  if (config.forceMock) return undefined
  if (config.llmBackend === 'account') return createAccountLlm({ model: config.anthropicModel })
  if (config.anthropicKey) return createAnthropicLlm({ apiKey: config.anthropicKey, model: config.anthropicModel })
  return undefined
}

// Local mode without a model: replay the recorded Claude runs where the inputs match, the scripted stand-in otherwise.
// FORCE_MOCK=1 (tests) and LLM_BACKEND=scripted keep the plain scripted stand-in.
export function localLlm(config, { runs = loadRecordedRuns() } = {}) {
  const scripted = createMockLlm()
  if (config.forceMock || config.llmBackend === 'scripted' || runs.length === 0) return scripted
  return createReplayLlm({ runs, fallback: scripted })
}
