import { describe, expect, it, vi } from 'vitest'
import { resolveProviderRuntime, type ProviderRuntime } from '@ai-workspace/providers'
import {
  detectOllama,
  detectOpenAiCompatible,
  fetchAnthropicModels,
  fetchGoogleModels,
  fetchLiveModels,
  fetchOllamaModels,
  fetchOpenAiCompatibleModels,
  ollamaRootUrl,
  type FetchLike,
} from '../model-catalog-fetcher'

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}
const asFetch = (fn: unknown): FetchLike => fn as FetchLike

function runtime(id: string, provider?: Parameters<typeof resolveProviderRuntime>[1]): ProviderRuntime {
  const r = resolveProviderRuntime(id, provider)
  if (r.status !== 'ok') throw new Error('setup')
  return r
}

describe('fetchAnthropicModels', () => {
  it('sends x-api-key and anthropic-version headers to <base>/models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchAnthropicModels('sk-ant-secret', 'https://api.anthropic.com/v1', asFetch(fetchImpl))

    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(init.headers).toEqual({ 'x-api-key': 'sk-ant-secret', 'anthropic-version': '2023-06-01' })
  })

  it('strips a trailing slash from a custom base and maps display names', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }),
    )
    const result = await fetchAnthropicModels('k', 'https://proxy.example.com/v1/', asFetch(fetchImpl))
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('https://proxy.example.com/v1/models?limit=1000')
    expect(result).toEqual({ ok: true, models: [{ id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }] })
  })

  it('returns ok: false with the HTTP status or the network error, never throws', async () => {
    const http = await fetchAnthropicModels('bad', 'https://x/v1', asFetch(vi.fn().mockResolvedValue(jsonResponse(401, { error: 'invalid' }))))
    expect(http.ok).toBe(false)
    expect(http.message).toContain('401')
    const net = await fetchAnthropicModels('k', 'https://x/v1', asFetch(vi.fn().mockRejectedValue(new Error('ENOTFOUND'))))
    expect(net).toEqual({ ok: false, models: [], message: 'ENOTFOUND' })
  })

  it('always passes an abort signal so a hung server cannot hang the UI', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchAnthropicModels('k', 'https://x/v1', asFetch(fetchImpl))
    expect((fetchImpl.mock.calls[0] as [string, { signal?: AbortSignal }])[1].signal).toBeInstanceOf(AbortSignal)
  })
})

describe('fetchGoogleModels', () => {
  it('uses x-goog-api-key, strips the models/ prefix, and keeps only generateContent models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        models: [
          { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    )
    const result = await fetchGoogleModels('AIza-key', 'https://generativelanguage.googleapis.com/v1beta', asFetch(fetchImpl))
    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
    expect(init.headers).toEqual({ 'x-goog-api-key': 'AIza-key' })
    expect(result.models).toEqual([{ id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' }])
  })
})

describe('fetchOpenAiCompatibleModels', () => {
  it('sends a Bearer header and maps ids with a null name (OpenAI has none)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: 'gpt-4o' }, { id: 'o3-mini' }] }))
    const result = await fetchOpenAiCompatibleModels('sk-secret', 'https://api.openai.com/v1', asFetch(fetchImpl))
    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-secret' })
    expect(result.models).toEqual([
      { id: 'gpt-4o', displayName: null },
      { id: 'o3-mini', displayName: null },
    ])
  })

  it('uses OpenRouter-style human names as the display name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5' }] }))
    const result = await fetchOpenAiCompatibleModels('k', 'https://openrouter.ai/api/v1', asFetch(fetchImpl))
    expect(result.models[0]).toEqual({ id: 'anthropic/claude-sonnet-5', displayName: 'Anthropic: Claude Sonnet 5' })
  })

  it('accepts the bare-array response Together returns', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, [{ id: 'meta-llama/Llama-3.3-70B' }, { nope: true }]))
    const result = await fetchOpenAiCompatibleModels('k', 'https://api.together.xyz/v1', asFetch(fetchImpl))
    expect(result.models.map((m) => m.id)).toEqual(['meta-llama/Llama-3.3-70B'])
  })

  it('sends no Authorization header for a keyless local endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchOpenAiCompatibleModels('', 'http://localhost:1234/v1', asFetch(fetchImpl))
    expect((fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers).toEqual({})
  })

  it('returns ok: false on an HTTP error', async () => {
    const result = await fetchOpenAiCompatibleModels('k', 'https://x/v1', asFetch(vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden' }))))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('403')
  })
})

describe('Ollama', () => {
  it('derives the native API root from the OpenAI-compatible base URL', () => {
    expect(ollamaRootUrl('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(ollamaRootUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434')
    expect(ollamaRootUrl('http://gpu-box:11434')).toBe('http://gpu-box:11434')
  })

  it('lists local models from GET /api/tags', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { models: [{ name: 'llama3.2:latest' }, { model: 'qwen3:8b' }, {}] }),
    )
    const result = await fetchOllamaModels('http://localhost:11434/v1', asFetch(fetchImpl))
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('http://localhost:11434/api/tags')
    expect(result.models).toEqual([
      { id: 'llama3.2:latest', displayName: null },
      { id: 'qwen3:8b', displayName: null },
    ])
  })

  it('detects a running Ollama and counts its models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { models: [{ name: 'a' }, { name: 'b' }] }))
    expect(await detectOllama('http://localhost:11434/v1', asFetch(fetchImpl))).toEqual({
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      running: true,
      modelCount: 2,
    })
  })

  it('reports not running (no throw) when the connection is refused', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'))
    expect(await detectOllama('http://localhost:11434/v1', asFetch(fetchImpl))).toEqual({
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      running: false,
      modelCount: 0,
    })
  })

  it('probes with a short timeout', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { models: [] }))
    const spy = vi.spyOn(AbortSignal, 'timeout')
    await detectOllama('http://localhost:11434/v1', asFetch(fetchImpl))
    expect(spy).toHaveBeenCalledWith(1_500)
    spy.mockRestore()
  })

  it('detects another local OpenAI-compatible server via GET /models', async () => {
    const up = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: 'x' }] }))
    expect(await detectOpenAiCompatible('lmstudio', 'http://127.0.0.1:1234/v1', asFetch(up))).toMatchObject({
      running: true,
      modelCount: 1,
    })
    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await detectOpenAiCompatible('lmstudio', 'http://127.0.0.1:1234/v1', asFetch(down))).toMatchObject({
      running: false,
    })
  })
})

describe('fetchLiveModels (dispatch)', () => {
  it('routes by SDK: Anthropic, Google and the OpenAI-compatible family', async () => {
    const anthropic = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchLiveModels({ providerId: 'anthropic', runtime: runtime('anthropic'), apiKey: 'k', baseUrl: null }, asFetch(anthropic))
    expect((anthropic.mock.calls[0] as [string])[0]).toBe('https://api.anthropic.com/v1/models?limit=1000')

    const google = vi.fn().mockResolvedValue(jsonResponse(200, { models: [] }))
    await fetchLiveModels({ providerId: 'google', runtime: runtime('google'), apiKey: 'k', baseUrl: null }, asFetch(google))
    expect((google.mock.calls[0] as [string])[0]).toContain('generativelanguage.googleapis.com/v1beta/models')

    const xai = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchLiveModels(
      {
        providerId: 'xai',
        runtime: runtime('xai', { id: 'xai', name: 'xAI', env: ['XAI_API_KEY'], npm: '@ai-sdk/xai', models: {} }),
        apiKey: 'k',
        baseUrl: null,
      },
      asFetch(xai),
    )
    expect((xai.mock.calls[0] as [string])[0]).toBe('https://api.x.ai/v1/models')
  })

  it('uses a config base URL override and a custom endpoint URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchLiveModels({ providerId: 'custom', runtime: runtime('custom'), apiKey: '', baseUrl: 'http://10.0.0.5:8000/v1' }, asFetch(fetchImpl))
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('http://10.0.0.5:8000/v1/models')
  })

  it('uses /api/tags for Ollama', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { models: [{ name: 'llama3.2' }] }))
    const result = await fetchLiveModels({ providerId: 'ollama', runtime: runtime('ollama'), apiKey: '', baseUrl: null }, asFetch(fetchImpl))
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('http://localhost:11434/api/tags')
    expect(result.models).toEqual([{ id: 'llama3.2', displayName: null }])
  })

  it('explains (ok: false, no network call) when a provider has no list endpoint', async () => {
    const fetchImpl = vi.fn()
    const perplexity = runtime('perplexity', { id: 'perplexity', name: 'Perplexity', env: ['K'], npm: '@ai-sdk/perplexity', models: {} })
    const result = await fetchLiveModels({ providerId: 'perplexity', runtime: perplexity, apiKey: 'k', baseUrl: null }, asFetch(fetchImpl))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no model-list endpoint/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
