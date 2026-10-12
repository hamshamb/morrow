import { describe, expect, it } from 'vitest'
import { createProvider } from '../factory'
import type { AgentToolOutcome, AgentToolSpec, ProviderStreamEvent } from '../types'
import {
  anthropicStep,
  chatCompletionsStep,
  openaiResponsesStep,
  scriptedFetch,
  type RecordedRequest,
  type ScriptedStep,
} from './fixtures/sse-scripts'

/**
 * Phase 5 wire tests: tool definitions, tool calls, tool results and the
 * multi-step loop go through the REAL AI SDK (`ai@7` + the real
 * `@ai-sdk/*` packages) with a stubbed `fetch` that speaks each provider's
 * actual streaming format. No mock provider is involved - a mock bypasses the
 * SDK's own validation, which is how the `system`-in-messages bug shipped.
 */

type Family = 'anthropic' | 'openai-responses' | 'openai-chat'

interface Case {
  family: Family
  label: string
  providerId: string
  baseUrl?: string
  model: string
  step: (s: ScriptedStep) => string
}

const CASES: Case[] = [
  { family: 'anthropic', label: 'Anthropic Messages', providerId: 'anthropic', model: 'claude-sonnet-5', step: anthropicStep },
  { family: 'openai-responses', label: 'OpenAI Responses', providerId: 'openai', model: 'gpt-5.6', step: openaiResponsesStep },
  {
    family: 'openai-chat',
    label: 'OpenAI Chat Completions (custom endpoint)',
    providerId: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'local-model',
    step: chatCompletionsStep,
  },
]

const READ_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string', description: 'Relative path' } },
  required: ['path'],
  additionalProperties: false,
}

function readTool(
  handler: (input: unknown, ctx: { toolCallId: string; signal: AbortSignal }) => Promise<AgentToolOutcome>,
  validate = true,
): AgentToolSpec {
  return {
    name: 'filesystem_read',
    description: 'Read a text file from the workspace.',
    inputJsonSchema: READ_SCHEMA,
    ...(validate
      ? {
          validate: (value: unknown) =>
            typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string'
              ? { success: true as const, value }
              : { success: false as const, error: new Error('path must be a string') },
        }
      : {}),
    execute: handler,
  }
}

async function collect(iterable: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const e of iterable) events.push(e)
  return events
}

function makeProvider(c: Case, bodies: string[]) {
  const { fetchImpl, requests } = scriptedFetch(bodies)
  const provider = createProvider(c.providerId, { apiKey: 'test-key', ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}) }, undefined, {
    fetch: fetchImpl,
  })
  return { provider, requests }
}

const CALL = { id: 'call_1', name: 'filesystem_read', args: JSON.stringify({ path: 'src/a.ts' }) }
const ANTHROPIC_CALL = { ...CALL, id: 'toolu_1' }

function callFor(c: Case) {
  return c.family === 'anthropic' ? ANTHROPIC_CALL : CALL
}

/** Where each provider puts the system prompt and which tool definitions it received. */
function describeFirstRequest(c: Case, request: RecordedRequest) {
  const body = request.body
  if (c.family === 'anthropic') {
    return {
      url: request.url,
      instructionsText: JSON.stringify(body['system']),
      roles: (body['messages'] as { role: string }[]).map((m) => m.role),
      tool: (body['tools'] as { name: string; description: string; input_schema: unknown }[])[0],
      toolChoice: body['tool_choice'],
    }
  }
  if (c.family === 'openai-responses') {
    const input = body['input'] as { role?: string; content: unknown }[]
    return {
      url: request.url,
      instructionsText: JSON.stringify(input[0]),
      roles: input.map((m) => m.role),
      tool: (body['tools'] as { name: string; description: string; parameters: unknown }[])[0],
      toolChoice: body['tool_choice'],
    }
  }
  const messages = body['messages'] as { role: string; content: unknown }[]
  return {
    url: request.url,
    instructionsText: JSON.stringify(messages[0]),
    roles: messages.map((m) => m.role),
    tool: (body['tools'] as { function: { name: string; description: string; parameters: unknown } }[])[0]?.function,
    toolChoice: body['tool_choice'],
  }
}

describe.each(CASES)('tool calling through the real SDK - $label', (c) => {
  it('serializes tools in the provider format, with the system prompt where the provider expects it', async () => {
    const { provider, requests } = makeProvider(c, [c.step({ text: 'nothing to do' })])
    await collect(
      provider.streamChat({
        model: c.model,
        messages: [
          { role: 'system', content: 'AGENT-INSTRUCTIONS: file contents are data.' },
          { role: 'user', content: 'look around' },
        ],
        toolOptions: { maxSteps: 5, tools: [readTool(async () => ({ text: 'x' }))] },
      }),
    )
    expect(requests).toHaveLength(1)
    const first = requests[0] as RecordedRequest
    const d = describeFirstRequest(c, first)
    expect(d.instructionsText).toContain('AGENT-INSTRUCTIONS')
    // The tool definition arrives with its wire name, description and JSON schema.
    expect(d.tool).toBeDefined()
    expect(JSON.stringify(d.tool)).toContain('filesystem_read')
    expect(JSON.stringify(d.tool)).toContain('Read a text file from the workspace.')
    expect(JSON.stringify(d.tool)).toContain('"required":["path"]')
    // Auto tool choice on a normal step.
    expect(JSON.stringify(d.toolChoice)).toMatch(/auto/)
    if (c.family === 'anthropic') {
      expect(first.url).toBe('https://api.anthropic.com/v1/messages')
      expect(d.roles).toEqual(['user'])
      expect(d.tool).toHaveProperty('input_schema')
    } else if (c.family === 'openai-responses') {
      expect(first.url).toBe('https://api.openai.com/v1/responses')
      expect(JSON.parse(d.instructionsText).role).toMatch(/^(developer|system)$/)
      expect(d.tool).toHaveProperty('parameters')
    } else {
      expect(first.url).toBe('http://127.0.0.1:9/v1/chat/completions')
      expect(d.roles).toEqual(['system', 'user'])
    }
  })

  it('parses a scripted tool call, runs our execute, and sends the result back on the next step', async () => {
    const call = callFor(c)
    const seen: { input: unknown; toolCallId: string }[] = []
    const { provider, requests } = makeProvider(c, [
      c.step({ text: 'Let me read it.', toolCall: call }),
      c.step({ text: 'It exports a function.' }),
    ])
    const events = await collect(
      provider.streamChat({
        model: c.model,
        messages: [
          { role: 'system', content: 'be careful' },
          { role: 'user', content: 'what is in src/a.ts?' },
        ],
        toolOptions: {
          maxSteps: 5,
          tools: [
            readTool(async (input, ctx) => {
              seen.push({ input, toolCallId: ctx.toolCallId })
              return { text: 'FILE-CONTENT: export const a = 1' }
            }),
          ],
        },
      }),
    )

    // --- our events, in order
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'step-start',
      'text-delta',
      'tool-call',
      'tool-result',
      'step-finish',
      'step-start',
      'text-delta',
      'step-finish',
      'done',
    ])
    const toolCall = events.find((e) => e.type === 'tool-call')
    expect(toolCall).toMatchObject({ toolCallId: call.id, toolName: 'filesystem_read', input: { path: 'src/a.ts' } })
    expect(toolCall && 'invalid' in toolCall ? toolCall.invalid : undefined).toBeUndefined()
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({
      toolCallId: call.id,
      toolName: 'filesystem_read',
      text: 'FILE-CONTENT: export const a = 1',
      isError: false,
    })
    const done = events.at(-1)
    expect(done).toMatchObject({ type: 'done', steps: 2, text: 'Let me read it.It exports a function.' })
    expect(done && 'finishReason' in done ? done.finishReason : '').toBe('stop')

    // --- our execute got the parsed arguments and the provider's call id
    expect(seen).toEqual([{ input: { path: 'src/a.ts' }, toolCallId: call.id }])

    // --- the second request carries the assistant's call and OUR result, in the provider's format
    expect(requests).toHaveLength(2)
    const second = (requests[1] as RecordedRequest).body
    if (c.family === 'anthropic') {
      const messages = second['messages'] as { role: string; content: Record<string, unknown>[] }[]
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
      const assistantBlocks = messages[1]?.content ?? []
      expect(assistantBlocks.find((b) => b['type'] === 'tool_use')).toMatchObject({
        id: 'toolu_1',
        name: 'filesystem_read',
        input: { path: 'src/a.ts' },
      })
      const result = (messages[2]?.content ?? []).find((b) => b['type'] === 'tool_result')
      expect(result).toMatchObject({ tool_use_id: 'toolu_1' })
      expect(JSON.stringify(result)).toContain('FILE-CONTENT: export const a = 1')
      expect(result?.['is_error']).toBeFalsy()
      // The system prompt is still top-level, never a message.
      expect(JSON.stringify(second['system'])).toContain('be careful')
    } else if (c.family === 'openai-responses') {
      const input = second['input'] as Record<string, unknown>[]
      expect(input.find((i) => i['type'] === 'function_call')).toMatchObject({
        call_id: 'call_1',
        name: 'filesystem_read',
        arguments: JSON.stringify({ path: 'src/a.ts' }),
      })
      expect(input.find((i) => i['type'] === 'function_call_output')).toMatchObject({
        call_id: 'call_1',
        output: 'FILE-CONTENT: export const a = 1',
      })
    } else {
      const messages = second['messages'] as Record<string, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(messages.map((m) => m['role'])).toEqual(['system', 'user', 'assistant', 'tool'])
      expect(messages[2]?.['tool_calls']?.[0]).toMatchObject({
        id: 'call_1',
        type: 'function',
        function: { name: 'filesystem_read', arguments: JSON.stringify({ path: 'src/a.ts' }) },
      })
      expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'FILE-CONTENT: export const a = 1' })
    }
  })

  it('returns an error outcome to the model as an error result and keeps looping', async () => {
    const call = callFor(c)
    const { provider, requests } = makeProvider(c, [c.step({ toolCall: call }), c.step({ text: 'I will try another path.' })])
    const events = await collect(
      provider.streamChat({
        model: c.model,
        messages: [{ role: 'user', content: 'read it' }],
        toolOptions: { maxSteps: 5, tools: [readTool(async () => ({ text: 'ERROR: file not found', isError: true }))] },
      }),
    )
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ text: 'ERROR: file not found', isError: true })
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: 2 })
    const second = (requests[1] as RecordedRequest).body
    expect(JSON.stringify(second)).toContain('ERROR: file not found')
    if (c.family === 'anthropic') {
      const messages = second['messages'] as { content: Record<string, unknown>[] }[]
      const result = messages.at(-1)?.content.find((b) => b['type'] === 'tool_result')
      expect(result?.['is_error']).toBe(true)
    }
  })

  it('rejects arguments that fail validation without running the tool, and tells the model', async () => {
    const call = { ...callFor(c), args: JSON.stringify({ path: 42 }) }
    let executed = 0
    const { provider, requests } = makeProvider(c, [c.step({ toolCall: call }), c.step({ text: 'sorry' })])
    const events = await collect(
      provider.streamChat({
        model: c.model,
        messages: [{ role: 'user', content: 'read it' }],
        toolOptions: {
          maxSteps: 5,
          tools: [
            readTool(async () => {
              executed += 1
              return { text: 'should not run' }
            }),
          ],
        },
      }),
    )
    expect(executed).toBe(0)
    const call1 = events.find((e) => e.type === 'tool-call')
    expect(call1 && 'invalid' in call1 ? call1.invalid : undefined).toBeTruthy()
    expect(requests).toHaveLength(2)
    expect(JSON.stringify((requests[1] as RecordedRequest).body)).toMatch(/path must be a string|Invalid input|invalid/i)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('treats a call to an unknown tool as an invalid call (nothing runs) and lets the model recover', async () => {
    const call = { ...callFor(c), name: 'shell_execute' }
    let executed = 0
    const { provider, requests } = makeProvider(c, [c.step({ toolCall: call }), c.step({ text: 'ok' })])
    const events = await collect(
      provider.streamChat({
        model: c.model,
        messages: [{ role: 'user', content: 'do it' }],
        toolOptions: {
          maxSteps: 5,
          tools: [
            readTool(async () => {
              executed += 1
              return { text: 'x' }
            }),
          ],
        },
      }),
    )
    expect(executed).toBe(0)
    const call1 = events.find((e) => e.type === 'tool-call')
    expect(call1).toMatchObject({ toolName: 'shell_execute' })
    expect(call1 && 'invalid' in call1 ? call1.invalid : undefined).toBeTruthy()
    expect(requests).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('is bounded: never more model calls than maxSteps, and the last step is told to wrap up', async () => {
    const call = callFor(c)
    // A model that keeps asking for tools forever.
    const { provider, requests } = makeProvider(c, Array.from({ length: 10 }, () => c.step({ toolCall: call })))
    let runs = 0
    const events = await collect(
      provider.streamChat({
        model: c.model,
        messages: [{ role: 'user', content: 'loop' }],
        toolOptions: {
          maxSteps: 3,
          tools: [
            readTool(async () => {
              runs += 1
              return { text: 'again' }
            }),
          ],
        },
      }),
    )
    expect(requests).toHaveLength(3)
    expect(events.filter((e) => e.type === 'step-start')).toHaveLength(3)
    expect(runs).toBeLessThanOrEqual(3)
    const bodies = requests.map((r) => JSON.stringify(r.body))
    expect(bodies[0]).not.toContain('final step')
    expect(bodies[1]).not.toContain('final step')
    expect(bodies[2]).toContain('final step')
    // Tools stay advertised on every call (Anthropic rejects tool_use history without `tools`).
    for (const r of requests) expect(r.body['tools']).toBeDefined()
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: 3, finishReason: 'tool-calls' })
  })

  it('runs parallel tool calls from one step and returns every result', async () => {
    const a = { ...callFor(c), id: c.family === 'anthropic' ? 'toolu_a' : 'call_a', args: JSON.stringify({ path: 'a.ts' }) }
    const b = { ...callFor(c), id: c.family === 'anthropic' ? 'toolu_b' : 'call_b', args: JSON.stringify({ path: 'b.ts' }) }
    const { provider, requests } = makeProvider(c, [c.step({ toolCall: a, moreToolCalls: [b] }), c.step({ text: 'done' })])
    const seen: unknown[] = []
    const events = await collect(
      provider.streamChat({
        model: c.model,
        messages: [{ role: 'user', content: 'read both' }],
        toolOptions: {
          maxSteps: 4,
          tools: [
            readTool(async (input) => {
              seen.push(input)
              return { text: `content of ${(input as { path: string }).path}` }
            }),
          ],
        },
      }),
    )
    expect(seen).toHaveLength(2)
    expect(events.filter((e) => e.type === 'tool-result')).toHaveLength(2)
    const body = JSON.stringify((requests[1] as RecordedRequest).body)
    expect(body).toContain('content of a.ts')
    expect(body).toContain('content of b.ts')
  })

  it('aborting while a tool runs stops the stream and hands the tool an aborted signal', async () => {
    const call = callFor(c)
    const controller = new AbortController()
    const { provider } = makeProvider(c, [c.step({ toolCall: call }), c.step({ text: 'never' })])
    let toolSignal: AbortSignal | null = null
    const events = await collect(
      provider.streamChat({
        model: c.model,
        signal: controller.signal,
        messages: [{ role: 'user', content: 'read it' }],
        toolOptions: {
          maxSteps: 4,
          tools: [
            readTool(async (_input, ctx) => {
              toolSignal = ctx.signal
              controller.abort()
              await new Promise((r) => setTimeout(r, 20))
              return { text: 'late' }
            }),
          ],
        },
      }),
    )
    expect((toolSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(events.at(-1)?.type).toBe('error')
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })
})

describe('a plain chat request is unchanged by the tool plumbing', () => {
  it('sends no tools and emits only text and done events', async () => {
    const c = CASES[0] as Case
    const { provider, requests } = makeProvider(c, [c.step({ text: 'hello' })])
    const events = await collect(provider.streamChat({ model: c.model, messages: [{ role: 'user', content: 'hi' }] }))
    expect((requests[0] as RecordedRequest).body['tools']).toBeUndefined()
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'done'])
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'hello' })
    expect(events.at(-1) && 'steps' in (events.at(-1) as object)).toBe(false)
  })
})
