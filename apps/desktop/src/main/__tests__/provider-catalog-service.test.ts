import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ModelCatalogRepository,
  ProviderConfigRepository,
  openDatabase,
  type AppDatabase,
} from '@ai-workspace/storage'
import { ProviderConfigSummarySchema } from '@ai-workspace/shared'
import { ModelsDevService } from '../models-dev-service'
import { ProviderCatalogService } from '../provider-catalog-service'
import type { FetchLike } from '../model-catalog-fetcher'
import { smallCatalog } from './fixtures'

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

describe('ProviderCatalogService', () => {
  let db: AppDatabase
  let configs: ProviderConfigRepository
  let catalogs: ModelCatalogRepository

  beforeEach(() => {
    db = openDatabase(':memory:')
    configs = new ProviderConfigRepository(db)
    catalogs = new ModelCatalogRepository(db)
  })
  afterEach(() => db.close())

  function service(opts: { fetch?: FetchLike; sdkFetch?: typeof fetch } = {}) {
    const models = new ModelsDevService({
      cachePath: '/none',
      bundled: () => smallCatalog(),
      fetch: () => Promise.reject(new Error('no network in tests')),
      files: { read: () => null, write: () => {} },
      isFetchEnabled: () => false,
    })
    return new ProviderCatalogService({
      models,
      configs,
      catalogs,
      decrypt: (buf) => buf.toString('utf8'),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sdkFetch ? { sdkFetch: opts.sdkFetch } : {}),
    })
  }

  function addConfig(provider: string, key = 'secret-key', baseUrl: string | null = null) {
    return configs.create({
      provider,
      label: provider,
      maskedKey: key ? 'se...ey' : 'no key',
      encryptedKey: Buffer.from(key, 'utf8'),
      baseUrl,
    })
  }

  describe('registry', () => {
    it('is built from the current catalog, popular first, with Ollama and the custom endpoint', () => {
      const ids = service().registry().map((e) => e.id)
      expect(ids.slice(0, 5)).toEqual(['anthropic', 'openai', 'google', 'xai', 'groq'])
      expect(ids).toContain('ollama')
      expect(ids).toContain('fireworks-ai')
      expect(ids.at(-1)).toBe('custom')
    })

    it('throws a clear error for a provider that cannot be run', () => {
      expect(() => service().runtime('azure')).toThrow(/not available/)
    })
  })

  describe('existing data stays valid (no migration needed)', () => {
    it('rows saved by older builds (anthropic/openai/google) parse and resolve', () => {
      const a = addConfig('anthropic')
      const o = addConfig('openai')
      const g = addConfig('google')
      for (const summary of configs.list()) {
        expect(ProviderConfigSummarySchema.safeParse(summary).success).toBe(true)
      }
      expect(configs.list().map((c) => c.id)).toEqual([a.id, o.id, g.id])
      const svc = service()
      for (const id of [a.id, o.id, g.id]) expect(svc.listCatalog(id).models.length).toBeGreaterThan(0)
    })

    it('a registry provider and a keyless local one can be stored next to them', () => {
      addConfig('anthropic')
      const groq = addConfig('groq')
      const ollama = addConfig('ollama', '')
      expect(configs.getSummary(groq.id)?.provider).toBe('groq')
      expect(configs.getCredential(ollama.id)?.encryptedKey.length).toBe(0)
    })
  })

  describe('catalog join', () => {
    it('before any live fetch, lists models.dev models for the provider (no network needed)', () => {
      const cfg = addConfig('anthropic')
      const catalog = service().listCatalog(cfg.id)
      expect(catalog.source).toBe('metadata')
      expect(catalog.fetchedAt).toBeNull()
      expect(catalog.models.map((m) => m.id)).toEqual(['claude-sonnet-5', 'claude-haiku-4-5'])
      expect(catalog.models[0]?.meta?.contextWindow).toBe(1_000_000)
    })

    it('refresh stores the live ids and the list becomes live + enriched', async () => {
      const cfg = addConfig('openai')
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-5.6' }, { id: 'text-embedding-3-small' }, { id: 'gpt-brand-new' }] }),
      )
      const svc = service({ fetch: fetchImpl as unknown as FetchLike })
      const result = await svc.refreshCatalog(cfg.id)

      expect(result.ok).toBe(true)
      expect((fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers).toEqual({
        Authorization: 'Bearer secret-key',
      })
      expect(result.catalog.source).toBe('live')
      expect(result.catalog.fetchedAt).not.toBeNull()
      expect(result.catalog.models.map((m) => m.id)).toEqual(['gpt-4o-mini', 'gpt-5.6', 'gpt-brand-new'])
      expect(result.catalog.models.find((m) => m.id === 'gpt-5.6')?.meta?.reasoningEfforts).toEqual([
        'none',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ])
      expect(result.catalog.models.find((m) => m.id === 'gpt-brand-new')?.meta).toBeNull()
      // and it persisted
      expect(svc.listCatalog(cfg.id).source).toBe('live')
    })

    it('a failed refresh keeps the models.dev list and reports ok: false', async () => {
      const cfg = addConfig('anthropic')
      const svc = service({ fetch: vi.fn().mockResolvedValue(jsonResponse(401, { error: 'bad key' })) as unknown as FetchLike })
      const result = await svc.refreshCatalog(cfg.id)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('401')
      expect(result.catalog.source).toBe('metadata')
      expect(result.catalog.models.length).toBe(2)
    })

    it('a failed refresh does not wipe a previously cached live list', async () => {
      const cfg = addConfig('openai')
      const svc = service({
        fetch: vi
          .fn()
          .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'gpt-4o-mini' }] }))
          .mockRejectedValueOnce(new Error('offline')) as unknown as FetchLike,
      })
      await svc.refreshCatalog(cfg.id)
      const second = await svc.refreshCatalog(cfg.id)
      expect(second.ok).toBe(false)
      expect(second.catalog.models.map((m) => m.id)).toEqual(['gpt-4o-mini'])
    })

    it('an Ollama config lists /api/tags models with no metadata', async () => {
      const cfg = addConfig('ollama', '')
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { models: [{ name: 'llama3.2:latest' }] }))
      const result = await service({ fetch: fetchImpl as unknown as FetchLike }).refreshCatalog(cfg.id)
      expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('http://localhost:11434/api/tags')
      expect(result.catalog.models).toEqual([{ id: 'llama3.2:latest', displayName: null, meta: null }])
    })

    it('a provider without a list endpoint (Perplexity) just shows the models.dev list', async () => {
      const cfg = addConfig('perplexity')
      const fetchImpl = vi.fn()
      const result = await service({ fetch: fetchImpl as unknown as FetchLike }).refreshCatalog(cfg.id)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(result.ok).toBe(false)
      expect(result.catalog.models.map((m) => m.id)).toEqual(['sonar'])
    })
  })

  describe('chat provider resolution', () => {
    it('returns the provider id and a metadata lookup for its models', () => {
      const cfg = addConfig('anthropic')
      const resolved = service().resolveChatProvider(cfg.id)
      expect(resolved.provider).toBe('anthropic')
      expect(resolved.chatProvider.id).toBe('anthropic')
      expect(resolved.getModelMeta('claude-sonnet-5')?.reasoningEfforts).toContain('max')
      expect(resolved.getModelMeta('unknown-model')).toBeNull()
    })
  })

  describe('testConnection', () => {
    function recorder(status: number, body: string, contentType = 'application/json') {
      const calls: { url: string; body: Record<string, unknown> }[] = []
      const impl = (async (input: unknown, init?: { body?: unknown }) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
        return new Response(body, { status, headers: { 'content-type': contentType } })
      }) as unknown as typeof fetch
      return { calls, impl }
    }

    it('probes with a cheap text model picked from models.dev, not a hardcoded id', async () => {
      const { calls, impl } = recorder(401, JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
      const result = await service({ sdkFetch: impl }).testConnection({ provider: 'anthropic', apiKey: 'sk-ant-bad' })
      expect(result.ok).toBe(false)
      expect(result.message).toContain('invalid x-api-key')
      expect(calls).toHaveLength(1)
      // fixture prices: haiku $1+$5 < sonnet $2+$10
      expect(calls[0]!.body.model).toBe('claude-haiku-4-5')
    })

    it('works for any registry provider (OpenAI-compatible route) and succeeds on the first streamed token', async () => {
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      const sse = chunk({ role: 'assistant', content: 'pong' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'
      const { calls, impl } = recorder(200, sse, 'text/event-stream')
      const result = await service({ sdkFetch: impl }).testConnection({ provider: 'fireworks-ai', apiKey: 'fw-key' })
      expect(result.ok).toBe(true)
      expect(calls[0]!.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions')
      expect(calls[0]!.body.model).toBe('kimi')
    })

    it('requires a key for cloud providers without calling the network', async () => {
      const { calls, impl } = recorder(200, '{}')
      const result = await service({ sdkFetch: impl }).testConnection({ provider: 'openai', apiKey: '  ' })
      expect(result).toEqual({ ok: false, message: 'An API key is required for this provider.' })
      expect(calls).toHaveLength(0)
    })

    it('verifies Ollama (keyless) by listing models, reporting how many are installed', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { models: [{ name: 'a' }, { name: 'b' }] }))
      const result = await service({ fetch: fetchImpl as unknown as FetchLike }).testConnection({ provider: 'ollama', apiKey: '' })
      expect(result).toEqual({ ok: true, message: '2 models available' })
    })

    it('reports Ollama not running as a failed test, not an exception', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const result = await service({ fetch: fetchImpl as unknown as FetchLike }).testConnection({ provider: 'ollama', apiKey: '' })
      expect(result).toEqual({ ok: false, message: 'ECONNREFUSED' })
    })

    it('a custom endpoint needs a base URL and is verified by listing', async () => {
      expect((await service().testConnection({ provider: 'custom', apiKey: '' })).ok).toBe(false)
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: 'm' }] }))
      const ok = await service({ fetch: fetchImpl as unknown as FetchLike }).testConnection({
        provider: 'custom',
        apiKey: '',
        baseUrl: 'http://10.0.0.5:8000/v1',
      })
      expect(ok).toEqual({ ok: true, message: '1 model available' })
      expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('http://10.0.0.5:8000/v1/models')
    })

    it('an unavailable provider fails cleanly', async () => {
      const result = await service().testConnection({ provider: 'azure', apiKey: 'k' })
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/not available/)
    })
  })

  describe('detectLocal', () => {
    it('probes Ollama (and LM Studio if the catalog lists it) and never throws', async () => {
      const fetchImpl = vi.fn().mockImplementation((url: string) =>
        url.includes('11434') ? Promise.resolve(jsonResponse(200, { models: [{ name: 'llama3.2' }] })) : Promise.reject(new Error('ECONNREFUSED')),
      )
      const statuses = await service({ fetch: fetchImpl as unknown as FetchLike }).detectLocal()
      expect(statuses).toEqual([{ id: 'ollama', baseUrl: 'http://localhost:11434/v1', running: true, modelCount: 1 }])
    })

    it('reports Ollama as not running when nothing answers', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const [ollama] = await service({ fetch: fetchImpl as unknown as FetchLike }).detectLocal()
      expect(ollama).toMatchObject({ id: 'ollama', running: false, modelCount: 0 })
    })
  })
})
