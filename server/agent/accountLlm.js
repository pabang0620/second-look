import { z } from 'zod'

// Local development only (LLM_BACKEND=account): one model turn through the Claude Agent SDK, which uses the
// developer's Claude Code login. ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are removed from the child environment,
// so this path can never bill an API key.
//
// The investigation loop (budget, segments, the human wait) stays in loop.js. This adapter only answers
// "what is the next tool call?": the tools are exposed as an in-process MCP server whose handlers do nothing but
// record the call, maxTurns is 1, and the recorded calls are returned as tool_use blocks, exactly the shape the
// API adapter returns. The server then runs the real tool itself.
const SERVER_NAME = 'secondlook'
const PREFIX = `mcp__${SERVER_NAME}__`
const RESULT_LIMIT = 8000

const FORMAT_NOTE = 'The conversation so far is given as a transcript. Reply with your next tool call or calls only. The server runs the tools between turns and returns their results in the next transcript.'

export function withoutApiKey(env = process.env) {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = env
  return rest
}

// Messages in the Messages API shape -> one plain-text transcript.
export function transcriptOf(messages) {
  const names = new Map()
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name)
  }
  const lines = []
  for (const m of messages) {
    if (typeof m.content === 'string') { lines.push(`${m.role === 'user' ? 'USER' : 'YOU'}: ${m.content}`); continue }
    for (const b of m.content) {
      if (b.type === 'text') lines.push(`${m.role === 'user' ? 'USER' : 'YOU'}: ${b.text}`)
      else if (b.type === 'tool_use') lines.push(`YOU CALLED ${b.name} ${JSON.stringify(b.input)}`)
      else if (b.type === 'tool_result') lines.push(`RESULT of ${names.get(b.tool_use_id) || b.tool_use_id}${b.is_error ? ' (error)' : ''}: ${String(b.content).slice(0, RESULT_LIMIT)}`)
    }
  }
  return `${lines.join('\n')}\n\nYOUR NEXT TOOL CALL:`
}

function buildServer(agentSdk, tools) {
  const defs = tools.map((def) =>
    agentSdk.tool(def.name, def.description, z.fromJSONSchema(def.input_schema).shape, async () => ({ content: [{ type: 'text', text: 'recorded' }] })),
  )
  return agentSdk.createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools: defs })
}

const finish = (content) => ({ stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content })

export function createAccountLlm({ model, loadSdk = () => import('@anthropic-ai/claude-agent-sdk'), env = process.env }) {
  return {
    mode: 'account',
    label: 'Claude Sonnet (local account)',
    async step({ system, tools, messages, deadline, now }) {
      const agentSdk = await loadSdk()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(1000, deadline - now()))
      const content = []
      const seen = new Set()
      try {
        const stream = agentSdk.query({
          prompt: transcriptOf(messages),
          options: {
            model,
            systemPrompt: `${system}\n\n${FORMAT_NOTE}`,
            tools: [],
            allowedTools: [`${PREFIX}*`],
            mcpServers: { [SERVER_NAME]: buildServer(agentSdk, tools) },
            maxTurns: 1,
            settingSources: [],
            env: withoutApiKey(env),
            abortController: controller,
          },
        })
        for await (const message of stream) {
          if (message.type === 'assistant' && !message.parent_tool_use_id) {
            for (const b of message.message?.content || []) {
              if (b.type === 'tool_use' && b.name.startsWith(PREFIX) && !seen.has(b.id)) {
                seen.add(b.id)
                content.push({ type: 'tool_use', id: b.id, name: b.name.slice(PREFIX.length), input: b.input ?? {} })
              } else if (b.type === 'text' && b.text.trim()) content.push({ type: 'text', text: b.text })
            }
          }
          if (message.type === 'result' && message.is_error && message.subtype !== 'error_max_turns') {
            throw new Error(`Account model failed: ${message.subtype}`)
          }
        }
      } catch (err) {
        // maxTurns 1 ends the run right after the tool turn; the SDK reports that as an error. The calls are what we wanted.
        const turnLimit = /maximum number of turns/i.test(String(err?.message))
        if (turnLimit && content.length > 0) return finish(content)
        if (controller.signal.aborted) { const e = new Error('Model call timed out'); e.name = 'AbortError'; throw e }
        throw err
      } finally {
        clearTimeout(timer)
      }
      return finish(content)
    },
  }
}
