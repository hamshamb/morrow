import { describe, expect, it } from 'vitest'
import { lookupModelMetadata } from '../catalog'
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
