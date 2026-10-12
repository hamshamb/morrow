import { describe, expect, it } from 'vitest'
import {
  ModelCatalogEntrySchema,
  ProviderModelCatalogSchema,
  RefreshModelCatalogResultSchema,
} from '../model-catalog'
import {
  ModelMetadataSchema,
  REASONING_EFFORT_VALUES,
  ReasoningEffortSchema,
  sortEfforts,
  type ModelMetadata,
} from '../model-metadata'
import { LastModelSelectionSchema } from '../settings'

const META: ModelMetadata = {
  id: 'claude-sonnet-5',
  name: 'Claude Sonnet 5',
  family: 'claude-sonnet',
  reasoning: true,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  reasoningToggle: false,
  reasoningBudget: null,
  attachment: true,
  vision: true,
  inputModalities: ['text', 'image', 'pdf'],
  toolCall: true,
  structuredOutput: true,
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  knowledge: '2026-01-31',
  releaseDate: '2026-06-29',
  openWeights: false,
  status: null,
}

describe('ReasoningEffortSchema', () => {
  it('accepts every effort value that appears in models.dev', () => {
    for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(ReasoningEffortSchema.parse(value)).toBe(value)
    }
  })

  it('rejects sentinels and unknown tiers', () => {
    expect(() => ReasoningEffortSchema.parse('default')).toThrow()
    expect(() => ReasoningEffortSchema.parse('off')).toThrow()
    expect(() => ReasoningEffortSchema.parse(null)).toThrow()
  })

  it('lists efforts weakest to strongest and sortEfforts follows that order', () => {
    expect(REASONING_EFFORT_VALUES).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(sortEfforts(['max', 'low', 'high', 'low', 'xhigh'])).toEqual(['low', 'high', 'xhigh', 'max'])
  })
})

describe('ModelCatalogEntrySchema / ProviderModelCatalogSchema', () => {
  it('accepts an entry with a null display name and no metadata (e.g. an Ollama tag)', () => {
    const entry = { id: 'llama3.2:latest', displayName: null }
    expect(ModelCatalogEntrySchema.parse(entry)).toEqual(entry)
  })

  it('accepts an entry carrying models.dev metadata', () => {
    const entry = { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', meta: META }
    expect(ModelCatalogEntrySchema.parse(entry)).toEqual(entry)
    expect(ModelMetadataSchema.parse(META)).toEqual(META)
  })

  it('rejects an entry with an empty id', () => {
    expect(() => ModelCatalogEntrySchema.parse({ id: '', displayName: null })).toThrow()
  })

  it('accepts a catalog with a null fetchedAt (never fetched yet) and a source', () => {
    const catalog = { providerConfigId: 'pc-1', models: [], fetchedAt: null, source: 'metadata' as const }
    expect(ProviderModelCatalogSchema.parse(catalog)).toEqual(catalog)
  })
})

describe('RefreshModelCatalogResultSchema', () => {
  it('accepts a failed refresh that still carries the (possibly stale) cached catalog', () => {
    const result = {
      ok: false,
      message: 'HTTP 401: invalid api key',
      catalog: { providerConfigId: 'pc-1', models: [], fetchedAt: null },
    }
    expect(RefreshModelCatalogResultSchema.parse(result)).toEqual(result)
  })
})

describe('LastModelSelectionSchema', () => {
  it('round-trips a full selection', () => {
    const selection = { providerConfigId: 'pc-1', model: 'claude-sonnet-5', effort: 'high' as const }
    expect(LastModelSelectionSchema.parse(selection)).toEqual(selection)
  })

  it('round-trips the new effort values (xhigh / max)', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const selection = { providerConfigId: 'pc-1', model: 'claude-opus-5-5', effort }
      expect(LastModelSelectionSchema.parse(selection)).toEqual(selection)
    }
  })

  it('accepts a null effort (no reasoning tier selected)', () => {
    const selection = { providerConfigId: 'pc-1', model: 'gpt-4o', effort: null }
    expect(LastModelSelectionSchema.parse(selection)).toEqual(selection)
  })

  it('rejects a missing model', () => {
    expect(() =>
      LastModelSelectionSchema.parse({ providerConfigId: 'pc-1', effort: null }),
    ).toThrow()
  })
})
