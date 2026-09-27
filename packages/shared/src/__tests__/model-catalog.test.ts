import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_FALLBACK_MODELS,
  ANTHROPIC_THINKING_BUDGET_TOKENS,
  ModelCatalogEntrySchema,
  ProviderModelCatalogSchema,
  ReasoningEffortSchema,
  RefreshModelCatalogResultSchema,
  isReasoningCapableModel,
} from '../model-catalog'
import { LastModelSelectionSchema } from '../settings'

describe('ReasoningEffortSchema', () => {
  it('accepts low/medium/high', () => {
    expect(ReasoningEffortSchema.parse('low')).toBe('low')
    expect(ReasoningEffortSchema.parse('medium')).toBe('medium')
    expect(ReasoningEffortSchema.parse('high')).toBe('high')
  })

  it('rejects an unsupported tier', () => {
    expect(() => ReasoningEffortSchema.parse('xhigh')).toThrow()
    expect(() => ReasoningEffortSchema.parse('off')).toThrow()
  })
})

describe('ModelCatalogEntrySchema / ProviderModelCatalogSchema', () => {
  it('accepts an entry with a null display name (e.g. OpenAI has none)', () => {
    const entry = { id: 'gpt-4o', displayName: null }
    expect(ModelCatalogEntrySchema.parse(entry)).toEqual(entry)
  })

  it('rejects an entry with an empty id', () => {
    expect(() => ModelCatalogEntrySchema.parse({ id: '', displayName: null })).toThrow()
  })

  it('accepts a catalog with a null fetchedAt (never fetched yet)', () => {
    const catalog = { providerConfigId: 'pc-1', models: [], fetchedAt: null }
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

describe('ANTHROPIC_FALLBACK_MODELS', () => {
  it('contains exactly the four confirmed-current ids, nothing invented', () => {
    expect(ANTHROPIC_FALLBACK_MODELS.map((m) => m.id)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5-5',
      'claude-haiku-4-5-20251001',
      'claude-fable-5-1',
    ])
  })

  it('every entry parses as a valid ModelCatalogEntry', () => {
    for (const entry of ANTHROPIC_FALLBACK_MODELS) {
      expect(ModelCatalogEntrySchema.parse(entry)).toEqual(entry)
    }
  })
})

describe('ANTHROPIC_THINKING_BUDGET_TOKENS', () => {
  it('every tier meets the documented 1024-token Anthropic minimum', () => {
    for (const value of Object.values(ANTHROPIC_THINKING_BUDGET_TOKENS)) {
      expect(value).toBeGreaterThanOrEqual(1024)
    }
  })

  it('tiers strictly increase from low to high', () => {
    expect(ANTHROPIC_THINKING_BUDGET_TOKENS.low).toBeLessThan(ANTHROPIC_THINKING_BUDGET_TOKENS.medium)
    expect(ANTHROPIC_THINKING_BUDGET_TOKENS.medium).toBeLessThan(ANTHROPIC_THINKING_BUDGET_TOKENS.high)
  })
})

describe('isReasoningCapableModel', () => {
  it('excludes Anthropic Haiku models (no extended-thinking support)', () => {
    expect(isReasoningCapableModel('anthropic', 'claude-haiku-4-5-20251001')).toBe(false)
    expect(isReasoningCapableModel('anthropic', 'CLAUDE-HAIKU-4-5-20251001')).toBe(false)
  })

  it('includes non-Haiku Anthropic models', () => {
    expect(isReasoningCapableModel('anthropic', 'claude-sonnet-5')).toBe(true)
    expect(isReasoningCapableModel('anthropic', 'claude-opus-5-5')).toBe(true)
    expect(isReasoningCapableModel('anthropic', 'claude-fable-5-1')).toBe(true)
  })

  it('includes OpenAI o-series and gpt-5 models by id prefix', () => {
    expect(isReasoningCapableModel('openai', 'o1')).toBe(true)
    expect(isReasoningCapableModel('openai', 'o3-mini')).toBe(true)
    expect(isReasoningCapableModel('openai', 'o4-mini-2025-04-16')).toBe(true)
    expect(isReasoningCapableModel('openai', 'gpt-5')).toBe(true)
    expect(isReasoningCapableModel('openai', 'gpt-5-mini')).toBe(true)
  })

  it('excludes non-reasoning OpenAI models', () => {
    expect(isReasoningCapableModel('openai', 'gpt-4o')).toBe(false)
    expect(isReasoningCapableModel('openai', 'gpt-4o-mini')).toBe(false)
  })

  it('always returns false for Google (not wired up in V1)', () => {
    expect(isReasoningCapableModel('google', 'gemini-2.0-flash')).toBe(false)
  })

  it('returns false for an empty/blank model id', () => {
    expect(isReasoningCapableModel('anthropic', '')).toBe(false)
    expect(isReasoningCapableModel('anthropic', '   ')).toBe(false)
  })
})

describe('LastModelSelectionSchema', () => {
  it('round-trips a full selection', () => {
    const selection = { providerConfigId: 'pc-1', model: 'claude-sonnet-5', effort: 'high' as const }
    expect(LastModelSelectionSchema.parse(selection)).toEqual(selection)
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
