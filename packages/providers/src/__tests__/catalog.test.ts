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
  it('chooses the cheapest priced chat model, preferring non-reasoning, from the data (no hardcoded ids)', () => {
    expect(pickProbeModel(catalog.openai)).toBe('gpt-4o-mini')
  })

  it('falls back to the cheapest reasoning model when every model reasons', () => {
    // Anthropic fixture: haiku $1+$5 < opus $5+$25 < sonnet $2+$10 -> haiku
    expect(pickProbeModel(catalog.anthropic)).toBe('claude-haiku-4-5')
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
