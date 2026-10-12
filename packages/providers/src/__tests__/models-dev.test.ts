import { describe, expect, it } from 'vitest'
import {
  countChatModels,
  isChatModel,
  modelEfforts,
  normalizeModel,
  parseModelsDevCatalog,
  trimModelsDevCatalog,
} from '../models-dev'
import { RAW_FIXTURE } from './fixtures/models-dev-raw'

const catalog = parseModelsDevCatalog(RAW_FIXTURE)

describe('parseModelsDevCatalog', () => {
  it('skips malformed providers instead of throwing', () => {
    expect(catalog.broken).toBeUndefined()
    expect(catalog.alsoBroken).toBeUndefined()
    expect(catalog.anthropic?.name).toBe('Anthropic')
  })

  it('returns an empty catalog for non-object input', () => {
    expect(parseModelsDevCatalog(null)).toEqual({})
    expect(parseModelsDevCatalog('nope')).toEqual({})
    expect(parseModelsDevCatalog([1, 2])).toEqual({})
  })

  it('drops fields the app does not use (descriptions etc.)', () => {
    const model = catalog.anthropic!.models['claude-sonnet-5']!
    expect(model).not.toHaveProperty('description')
    expect(model).not.toHaveProperty('temperature')
    expect(model).not.toHaveProperty('last_updated')
  })

  it('drops models that carry a per-model transport override', () => {
    expect(Object.keys(catalog.gateway!.models)).toEqual(['ok'])
  })
})

describe('isChatModel', () => {
  it('excludes image generators and embeddings, keeps text-output models', () => {
    expect(isChatModel(catalog.openai!.models['gpt-image-1']!)).toBe(false)
    expect(isChatModel(catalog.openai!.models['text-embedding-3-small']!)).toBe(false)
    expect(isChatModel(catalog.openai!.models['gpt-4o-mini']!)).toBe(true)
  })

  it('treats a model with no modality data as text', () => {
    expect(isChatModel({ id: 'x', name: 'x' })).toBe(true)
  })

  it('excludes embedders, rerankers and transcribers that models.dev labels as text output with no type', () => {
    const textOut = { modalities: { input: ['text'], output: ['text'] } }
    for (const [id, family] of [
      ['text-embedding-3-small', 'text-embedding'],
      ['e5-large-v2', 'embedding'],
      ['bge-reranker-v2-m3', 'bge'],
      ['whisper-large-v3', 'whisper'],
      ['gpt-4o-mini-transcribe', 'gpt'],
      ['omni-moderation-latest', 'moderation'],
    ] as const) {
      expect(isChatModel({ id, name: id, family, ...textOut }), id).toBe(false)
    }
    expect(isChatModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini', family: 'gpt', ...textOut })).toBe(true)
    expect(isChatModel({ id: 'gpt-oss-safeguard-20b', name: 'safeguard', family: 'gpt-oss', ...textOut })).toBe(true)
  })
})

describe('normalizeModel', () => {
  it('reads exact effort values, including xhigh and max, weakest to strongest', () => {
    const meta = normalizeModel(catalog.anthropic!.models['claude-sonnet-5']!)
    expect(meta.reasoning).toBe(true)
    expect(meta.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(meta.reasoningToggle).toBe(false)
    expect(meta.contextWindow).toBe(1_000_000)
    expect(meta.maxOutput).toBe(128_000)
    expect(meta.cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
    expect(meta.vision).toBe(true)
    expect(meta.attachment).toBe(true)
    expect(meta.toolCall).toBe(true)
    expect(meta.knowledge).toBe('2026-01-31')
  })

  it('lists `none` and `max` for models that have them and nothing else invented', () => {
    expect(normalizeModel(catalog.openai!.models['gpt-5.6']!).reasoningEfforts).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(normalizeModel(catalog.openai!.models['gpt-5-mini']!).reasoningEfforts).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ])
  })

  it('has no efforts for a non-reasoning model', () => {
    const meta = normalizeModel(catalog.openai!.models['gpt-4o-mini']!)
    expect(meta.reasoning).toBe(false)
    expect(meta.reasoningEfforts).toEqual([])
  })

  it('a budget-only model has no effort levels but exposes its budget range', () => {
    const meta = normalizeModel(catalog.anthropic!.models['claude-haiku-4-5']!)
    expect(meta.reasoning).toBe(true)
    expect(meta.reasoningEfforts).toEqual([])
    expect(meta.reasoningBudget).toEqual({ min: 1024, max: null })
  })

  it('drops the `default` / null sentinels models.dev uses in effort lists', () => {
    expect(
      modelEfforts({
        id: 'q',
        name: 'q',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'default', 'low', 'high'] }],
      }),
    ).toEqual(['none', 'low', 'high'])
  })

  it('marks toggle-only models', () => {
    const meta = normalizeModel({
      id: 't',
      name: 't',
      reasoning: true,
      reasoning_options: [{ type: 'toggle' }],
    })
    expect(meta.reasoningToggle).toBe(true)
    expect(meta.reasoningEfforts).toEqual([])
  })

  it('reports unknown limits and prices as null, not zero', () => {
    const meta = normalizeModel({ id: 'u', name: 'u', limit: { context: 0, output: 0 } })
    expect(meta.contextWindow).toBeNull()
    expect(meta.maxOutput).toBeNull()
    expect(meta.cost).toBeNull()
  })
})

describe('trimModelsDevCatalog (offline snapshot)', () => {
  it('keeps chat models only and removes deprecated, image and embedding rows', () => {
    const trimmed = trimModelsDevCatalog(catalog)
    expect(Object.keys(trimmed.anthropic!.models)).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'claude-sonnet-5',
    ])
    expect(Object.keys(trimmed.openai!.models)).toEqual(['gpt-4o-mini', 'gpt-5-mini', 'gpt-5.6'])
  })

  it('honours a provider allowlist and a provider predicate', () => {
    expect(Object.keys(trimModelsDevCatalog(catalog, { providers: ['xai', 'groq'] }))).toEqual(['xai'])
    const noNpm = trimModelsDevCatalog(catalog, { keepProvider: (p) => p.npm === '@ai-sdk/xai' })
    expect(Object.keys(noNpm)).toEqual(['xai'])
  })

  it('caps models per provider keeping the newest releases', () => {
    const trimmed = trimModelsDevCatalog(catalog, { providers: ['anthropic'], maxModelsPerProvider: 2 })
    expect(Object.keys(trimmed.anthropic!.models).sort()).toEqual(['claude-opus-4-5', 'claude-sonnet-5'])
    const perProvider = trimModelsDevCatalog(catalog, {
      providers: ['anthropic'],
      maxModelsPerProvider: 1,
      maxModelsByProvider: { anthropic: 3 },
    })
    expect(Object.keys(perProvider.anthropic!.models)).toHaveLength(3)
  })

  it('is deterministic (sorted) and idempotent, and re-parses to the same thing', () => {
    const once = trimModelsDevCatalog(catalog)
    const twice = trimModelsDevCatalog(parseModelsDevCatalog(JSON.parse(JSON.stringify(once))))
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    expect(Object.keys(once)).toEqual([...Object.keys(once)].sort())
  })

  it('shrinks the document substantially', () => {
    const full = JSON.stringify(RAW_FIXTURE).length
    const small = JSON.stringify(trimModelsDevCatalog(catalog)).length
    expect(small).toBeLessThan(full)
  })

  it('countChatModels counts only selectable chat models', () => {
    // anthropic 3 + openai 3 + google 2 + 13 single-model providers (the
    // deprecated Claude, embedding, image and overridden rows do not count)
    expect(countChatModels(catalog)).toBe(21)
  })
})
