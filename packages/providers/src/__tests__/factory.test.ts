import { describe, expect, it } from 'vitest'
import { lookupModelMetadata } from '../catalog'
import { describeStreamError } from '../adapters/shared-stream'
import { createProvider } from '../factory'
import { parseModelsDevCatalog } from '../models-dev'
import { resolveProviderRuntime } from '../registry'
import { RAW_FIXTURE } from './fixtures/models-dev-raw'

const catalog = parseModelsDevCatalog(RAW_FIXTURE)

function runtimeFor(id: string) {
  const r = resolveProviderRuntime(id, catalog[id])
  if (r.status !== 'ok') throw new Error(`fixture provider ${id} not runnable`)
  return r
}

describe('createProvider', () => {
  it('builds the three launch providers without a catalog, carrying the right id', () => {
    for (const id of ['anthropic', 'openai', 'google']) {
      expect(createProvider(id, { apiKey: 'sk-test' }).id).toBe(id)
    }
  })

  it('builds every bundled SDK provider from its registry runtime', () => {
    for (const id of ['xai', 'mistral', 'deepseek', 'perplexity', 'openrouter', 'fireworks-ai', 'some-unbundled']) {
      expect(createProvider(id, { apiKey: 'k' }, runtimeFor(id)).id).toBe(id)
    }
  })

  it('builds Ollama with no key (keyless local endpoint)', () => {
    expect(createProvider('ollama', { apiKey: '' }).id).toBe('ollama')
  })

  it('a custom endpoint needs a base URL', () => {
    expect(() => createProvider('custom', { apiKey: '' })).toThrow(/not available|base URL/)
    expect(createProvider('custom', { apiKey: '', baseUrl: 'http://localhost:8080/v1' }).id).toBe('custom')
  })

  it('refuses an unknown provider without a catalog runtime or base URL', () => {
    expect(() => createProvider('nope', { apiKey: 'k' })).toThrow(/not available/)
  })
})

describe('describeStreamError', () => {
  it('never returns a blank message', () => {
    expect(describeStreamError(new Error('boom'))).toBe('boom')
    const unparsed = Object.assign(new Error(''), { statusCode: 502, responseBody: '<html>Bad gateway</html>' })
    expect(describeStreamError(unparsed)).toBe('HTTP 502: <html>Bad gateway</html>')
    expect(describeStreamError(new TypeError(''))).toBe('TypeError')
    expect(describeStreamError('plain')).toBe('plain')
  })

  it('unwraps a retry wrapper so the status and the provider text survive for error classification', () => {
    const last = Object.assign(new Error(''), {
      name: 'AI_APICallError',
      statusCode: 429,
      responseBody: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded, limit: 0"}}',
    })
    const retry = Object.assign(new Error('Failed after 3 attempts. Last error: AI_APICallError'), { lastError: last })
    const text = describeStreamError(retry)
    expect(text).toMatch(/^HTTP 429: /)
    expect(text).toContain('Quota exceeded')
  })

  it('prefixes the HTTP status to a provider message that lacks it', () => {
    const err = Object.assign(new Error('invalid x-api-key'), { statusCode: 401 })
    expect(describeStreamError(err)).toBe('HTTP 401: invalid x-api-key')
  })
})

/** Records the request body, then returns a canned SSE chat completion. */
function recordingFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'x',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    const sse = chunk({ role: 'assistant', content: 'pong' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('system messages through the real SDK (stubbed fetch, no network)', () => {
  // ai@7 throws "System messages are not allowed in the prompt or messages
  // fields" before any request when a system message sits in `messages`.
  // Mock providers never hit that check, so this goes through the real SDK.
  const request = {
    model: 'm',
    messages: [
      { role: 'system' as const, content: 'REVIEW-INSTRUCTIONS' },
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'second question' },
    ],
  }

  for (const [id, model] of [
    ['anthropic', 'claude-sonnet-5'],
    ['openai', 'gpt-5.6'],
  ] as const) {
    it(`${id}: a request with a system prompt and history passes SDK validation and is sent`, async () => {
      const bodies: string[] = []
      const fetchImpl = (async (_input: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''))
        return new Response(JSON.stringify({ error: { type: 'stub', message: 'stub' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch
      const provider = createProvider(id, { apiKey: 'k' }, undefined, { fetch: fetchImpl })
      const events = []
      for await (const e of provider.streamChat({ ...request, model })) events.push(e)

      const error = events.find((e) => e.type === 'error')
      expect(error && 'error' in error ? error.error : '').not.toMatch(/System messages are not allowed/)
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toContain('REVIEW-INSTRUCTIONS')
      expect(bodies[0]).toContain('second question')
      if (id === 'anthropic') {
        const body = JSON.parse(bodies[0]!) as { system?: unknown; messages: { role: string }[] }
        expect(JSON.stringify(body.system)).toContain('REVIEW-INSTRUCTIONS')
        expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
      }
    })
  }
})

describe('wire format (stubbed fetch, no network)', () => {
  it('an openai-compatible provider posts to <baseURL>/chat/completions with the reasoning effort the model allows', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const runtime = runtimeFor('fireworks-ai')
    const provider = createProvider('fireworks-ai', { apiKey: 'fw-key' }, runtime, { fetch: fetchImpl })
    const modelMeta = {
      ...lookupModelMetadata(catalog['fireworks-ai'], 'accounts/fireworks/models/kimi-k2', runtime.factoryKey)!,
      reasoning: true,
      reasoningEfforts: ['low' as const, 'max' as const],
    }

    const events = []
    for await (const e of provider.streamChat({
      model: 'accounts/fireworks/models/kimi-k2',
      messages: [{ role: 'user', content: 'ping' }],
      effort: 'max',
      modelMeta,
    })) {
      events.push(e)
    }

    expect(events.some((e) => e.type === 'text-delta' && e.delta === 'pong')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'done', text: 'pong' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions')
    expect(calls[0]!.body.model).toBe('accounts/fireworks/models/kimi-k2')
    expect(calls[0]!.body.reasoning_effort).toBe('max')
  })

  it('reports the token usage the provider sent on the done event', async () => {
    const fetchImpl = (async () => {
      const chunk = (delta: object, finish: string | null, usage?: object) =>
        `data: ${JSON.stringify({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'm',
          choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`
      const sse =
        chunk({ role: 'assistant', content: 'pong' }, null) +
        chunk({}, 'stop') +
        chunk({}, null, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }) +
        'data: [DONE]\n\n'
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const runtime = runtimeFor('fireworks-ai')
    const provider = createProvider('fireworks-ai', { apiKey: 'k' }, runtime, { fetch: fetchImpl })
    const events = []
    for await (const e of provider.streamChat({ model: 'kimi', messages: [{ role: 'user', content: 'ping' }] })) {
      events.push(e)
    }
    expect(events.at(-1)).toEqual({ type: 'done', text: 'pong', usage: { inputTokens: 12, outputTokens: 5 } })
  })

  it('sends no reasoning parameter when the model does not list the requested effort', async () => {
    const { calls, fetchImpl } = recordingFetch()
    const runtime = runtimeFor('fireworks-ai')
    const provider = createProvider('fireworks-ai', { apiKey: 'k' }, runtime, { fetch: fetchImpl })
    const modelMeta = lookupModelMetadata(catalog['fireworks-ai'], 'accounts/fireworks/models/kimi-k2', runtime.factoryKey)!
    for await (const e of provider.streamChat({
      model: 'accounts/fireworks/models/kimi-k2',
      messages: [{ role: 'user', content: 'ping' }],
      effort: 'high',
      modelMeta,
    })) {
      void e
    }
    expect(calls[0]!.body).not.toHaveProperty('reasoning_effort')
  })

  it('Ollama posts to localhost:11434/v1 with no Authorization header', async () => {
    let seenUrl = ''
    let seenAuth: string | null = 'unset'
    const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(input)
      seenAuth = new Headers(init?.headers).get('authorization')
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const provider = createProvider('ollama', { apiKey: '' }, undefined, { fetch: fetchImpl })
    for await (const e of provider.streamChat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] })) {
      void e
    }
    expect(seenUrl).toBe('http://localhost:11434/v1/chat/completions')
    expect(seenAuth).toBeNull()
  })
})
