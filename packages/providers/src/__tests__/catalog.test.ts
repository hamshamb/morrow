import { describe, expect, it } from 'vitest'
import { joinCatalog, lookupModelMetadata, pickProbeModel } from '../catalog'
import { parseModelsDevCatalog } from '../models-dev'
import { RAW_FIXTURE } from './fixtures/models-dev-raw'

const catalog = parseModelsDevCatalog(RAW_FIXTURE)

describe('joinCatalog', () => {
  it('enriches the live list (what the key can access) with models.dev metadata by id', () => {
    const { models, source } = joinCatalog({
      provider: catalog.anthropic,
      factoryKey: '@ai-sdk/anthropic',
      live: [
        { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5 (live)' },
        { id: 'claude-brand-new', displayName: null },
      ],
    })
    expect(source).toBe('live')
    expect(models.map((m) => m.id)).toEqual(['claude-brand-new', 'claude-sonnet-5'])
    const sonnet = models.find((m) => m.id === 'claude-sonnet-5')!
    expect(sonnet.displayName).toBe('Claude Sonnet 5 (live)')
    expect(sonnet.meta?.contextWindow).toBe(1_000_000)
    expect(sonnet.meta?.reasoningEfforts).toContain('xhigh')
    // an id models.dev has never heard of is still offered, just without metadata
    expect(models.find((m) => m.id === 'claude-brand-new')?.meta).toBeNull()
  })

  it('only lists models the key can access: models.dev models missing from the live list are not added', () => {
    const { models } = joinCatalog({
      provider: catalog.anthropic,
      factoryKey: '@ai-sdk/anthropic',
      live: [{ id: 'claude-sonnet-5', displayName: null }],
    })
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-5'])
  })

  it('falls back to the models.dev list when there is no live list, newest first, deprecated hidden', () => {
    const { models, source } = joinCatalog({ provider: catalog.anthropic, factoryKey: '@ai-sdk/anthropic', live: null })
    expect(source).toBe('metadata')
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-5', 'claude-opus-4-5', 'claude-haiku-4-5'])
    expect(models[0]?.displayName).toBe('Claude Sonnet 5')
    expect(models.every((m) => m.meta !== null)).toBe(true)
  })

  it('treats an empty live list like a missing one', () => {
    expect(joinCatalog({ provider: catalog.xai, factoryKey: '@ai-sdk/xai', live: [] }).source).toBe('metadata')
  })

  it('removes non-chat models the live list returns when models.dev knows they are not chat models', () => {
    const { models } = joinCatalog({
      provider: catalog.openai,
      factoryKey: '@ai-sdk/openai',
      live: [
        { id: 'gpt-4o-mini', displayName: null },
        { id: 'text-embedding-3-small', displayName: null },
        { id: 'gpt-image-1', displayName: null },
        { id: 'whisper-1', displayName: null }, // unknown to models.dev: filtered by name
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['gpt-4o-mini'])
  })

  it('matches live ids with a date or latest suffix to the undated models.dev row', () => {
    const { models } = joinCatalog({
      provider: catalog.anthropic,
      factoryKey: '@ai-sdk/anthropic',
      live: [{ id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' }],
    })
    expect(models[0]?.id).toBe('claude-haiku-4-5-20251001')
    expect(models[0]?.meta?.id).toBe('claude-haiku-4-5-20251001')
    expect(models[0]?.meta?.contextWindow).toBe(200_000)
  })

  it('is empty (not an error) for a provider with neither a live list nor models.dev data', () => {
    expect(joinCatalog({ provider: undefined, factoryKey: '@ai-sdk/openai-compatible', live: null })).toEqual({
      models: [],
      source: 'empty',
    })
  })

  it('a custom/Ollama live list works with no provider metadata at all', () => {
    const { models, source } = joinCatalog({
      provider: undefined,
      factoryKey: '@ai-sdk/openai-compatible',
      live: [{ id: 'llama3.2:latest', displayName: null }],
    })
    expect(source).toBe('live')
    expect(models).toEqual([{ id: 'llama3.2:latest', displayName: null, meta: null }])
  })
})

describe('lookupModelMetadata', () => {
  it('narrows efforts to what the provider SDK can send', () => {
    // models.dev lists none/minimal/low/medium/high for Perplexity's deep research,
    // but @ai-sdk/perplexity has no reasoning option: nothing is offered.
    const perplexity = lookupModelMetadata(catalog.perplexity, 'sonar-deep-research', '@ai-sdk/perplexity')
    expect(perplexity?.reasoning).toBe(true)
    expect(perplexity?.reasoningEfforts).toEqual([])
    // Mistral's SDK sends only high|none; xAI's tops out at xhigh.
    expect(lookupModelMetadata(catalog.mistral, 'mistral-small-latest', '@ai-sdk/mistral')?.reasoningEfforts).toEqual([
      'none',
      'high',
    ])
    expect(lookupModelMetadata(catalog.xai, 'grok-4.7', '@ai-sdk/xai')?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  it('keeps max for OpenAI but drops it for OpenRouter (which tops out at xhigh)', () => {
    expect(lookupModelMetadata(catalog.openai, 'gpt-5.6', '@ai-sdk/openai')?.reasoningEfforts).toContain('max')
    expect(
      lookupModelMetadata(catalog.openrouter, 'anthropic/claude-sonnet-5', '@openrouter/ai-sdk-provider')
        ?.reasoningEfforts,
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('returns null for an unknown id', () => {
    expect(lookupModelMetadata(catalog.openai, 'nope', '@ai-sdk/openai')).toBeNull()
    expect(lookupModelMetadata(undefined, 'gpt-5.6', '@ai-sdk/openai')).toBeNull()
  })
})

describe('pickProbeModel', () => {
  it('chooses the cheapest priced chat model from the data (no hardcoded ids)', () => {
    expect(pickProbeModel(catalog.openai)).toBe('gpt-4o-mini')
  })

  it('picks the cheapest model even when every model reasons', () => {
    // Anthropic fixture: haiku $1+$5 < sonnet $2+$10 < opus $5+$25 -> haiku
    expect(pickProbeModel(catalog.anthropic)).toBe('claude-haiku-4-5')
  })

  const google = parseModelsDevCatalog({
    google: {
      id: 'google',
      name: 'Google',
      env: ['GOOGLE_GENERATIVE_AI_API_KEY'],
      npm: '@ai-sdk/google',
      models: {
        // Real models.dev shapes: the only non-reasoning "chat" rows are specials.
        'gemini-3.5-live-translate-preview': { id: 'gemini-3.5-live-translate-preview', name: 'Live translate', reasoning: false, modalities: { input: ['text', 'audio'], output: ['text', 'audio'] }, cost: { input: 3.5, output: 21 }, release_date: '2026-09-01' },
        'lyria-3-clip-preview': { id: 'lyria-3-clip-preview', name: 'Lyria', reasoning: false, modalities: { input: ['text'], output: ['text'] }, cost: { input: 0, output: 0 }, release_date: '2026-09-02' },
        'gemini-3.5-flash-lite-preview': { id: 'gemini-3.5-flash-lite-preview', name: 'Flash-Lite preview', reasoning: true, modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.05, output: 0.2 }, release_date: '2026-09-10' },
        'gemini-3.1-flash-lite': { id: 'gemini-3.1-flash-lite', name: 'Flash-Lite', reasoning: true, modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.1, output: 0.4 }, release_date: '2026-03-01' },
        'gemini-3.5-flash': { id: 'gemini-3.5-flash', name: 'Flash', reasoning: true, modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.3, output: 2.5 }, release_date: '2026-05-01' },
      },
    },
  }).google

  it('skips live/translation/music specials and previews: Google probes a stable Flash-Lite', () => {
    expect(pickProbeModel(google)).toBe('gemini-3.1-flash-lite')
  })

  it('only considers models the key currently lists', () => {
    expect(pickProbeModel(google, new Set(['gemini-3.5-flash', 'gemini-3.5-live-translate-preview']))).toBe('gemini-3.5-flash')
    expect(pickProbeModel(google, new Set(['lyria-3-clip-preview']))).toBeNull()
  })

  it('a preview is used when it is the only listed chat model', () => {
    expect(pickProbeModel(google, new Set(['gemini-3.5-flash-lite-preview']))).toBe('gemini-3.5-flash-lite-preview')
  })

  const router = parseModelsDevCatalog({
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      env: ['OPENROUTER_API_KEY'],
      npm: '@openrouter/ai-sdk-provider',
      models: {
        'vendor/small:free': { id: 'vendor/small:free', name: 'Small (free)', modalities: { input: ['text'], output: ['text'] }, cost: { input: 0, output: 0 }, release_date: '2026-06-01' },
        'vendor/small': { id: 'vendor/small', name: 'Small', modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.02, output: 0.05 }, release_date: '2026-06-01' },
      },
    },
  }).openrouter

  it('prefers a free model when the key\'s own list confirms it, but not a $0 row on catalog data alone', () => {
    expect(pickProbeModel(router, new Set(['vendor/small:free', 'vendor/small']))).toBe('vendor/small:free')
    expect(pickProbeModel(router)).toBe('vendor/small')
  })

  it('never picks a deprecated or non-chat model', () => {
    expect(pickProbeModel(catalog.anthropic)).not.toBe('claude-old-deprecated')
    expect(pickProbeModel(catalog.openai)).not.toBe('text-embedding-3-small')
  })

  it('returns null when the provider has no priced model or does not exist', () => {
    expect(pickProbeModel(catalog['some-unbundled'])).toBeNull()
    expect(pickProbeModel(undefined)).toBeNull()
  })
})
