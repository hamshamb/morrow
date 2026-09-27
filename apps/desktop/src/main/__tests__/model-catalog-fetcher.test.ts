import { describe, expect, it, vi } from 'vitest'
import {
  fetchAnthropicModels,
  fetchOpenAiModels,
  fetchProviderModels,
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

describe('fetchAnthropicModels', () => {
  it('sends x-api-key and anthropic-version headers to the models endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchAnthropicModels('sk-ant-secret', null, fetchImpl as unknown as FetchLike)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(init.headers).toEqual({
      'x-api-key': 'sk-ant-secret',
      'anthropic-version': '2023-06-01',
    })
  })

  it('respects a custom base url, stripping a trailing slash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchAnthropicModels('key', 'https://proxy.example.com/', fetchImpl as unknown as FetchLike)
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://proxy.example.com/v1/models?limit=1000')
  })

  it('maps the response data into ModelCatalogEntry objects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [
          { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
          { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
        ],
      }),
    )
    const result = await fetchAnthropicModels('key', null, fetchImpl as unknown as FetchLike)
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
    ])
  })

  it('returns ok: false with a message on an HTTP error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'invalid api key' }))
    const result = await fetchAnthropicModels('bad-key', null, fetchImpl as unknown as FetchLike)
    expect(result.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.message).toContain('401')
  })

  it('returns ok: false with a message on a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))
    const result = await fetchAnthropicModels('key', null, fetchImpl as unknown as FetchLike)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('ENOTFOUND')
  })
})

describe('fetchOpenAiModels', () => {
  it('sends a Bearer authorization header to the models endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    await fetchOpenAiModels('sk-openai-secret', null, fetchImpl as unknown as FetchLike)

    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-openai-secret' })
  })

  it('maps ids with a null display name (OpenAI never returns one)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [{ id: 'gpt-4o' }, { id: 'o3-mini' }] }))
    const result = await fetchOpenAiModels('key', null, fetchImpl as unknown as FetchLike)
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([
      { id: 'gpt-4o', displayName: null },
      { id: 'o3-mini', displayName: null },
    ])
  })

  it('returns ok: false with a message on an HTTP error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden' }))
    const result = await fetchOpenAiModels('key', null, fetchImpl as unknown as FetchLike)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('403')
  })
})

describe('fetchProviderModels', () => {
  it('dispatches to the anthropic fetcher', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    const result = await fetchProviderModels('anthropic', 'key', null, fetchImpl as unknown as FetchLike)
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('api.anthropic.com'),
      expect.anything(),
    )
  })

  it('dispatches to the openai fetcher', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }))
    const result = await fetchProviderModels('openai', 'key', null, fetchImpl as unknown as FetchLike)
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('api.openai.com'), expect.anything())
  })

  it('throws for google — live fetch is not implemented in V1', async () => {
    const fetchImpl = vi.fn()
    expect(() => fetchProviderModels('google', 'key', null, fetchImpl as unknown as FetchLike)).toThrow()
  })
})
