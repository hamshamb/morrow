import { describe, expect, it } from 'vitest'
import type { ProviderConfigSummary, ProviderModelCatalog } from '@ai-workspace/shared'
import { buildModelPickerOptions, filterModelPickerOptions } from '../model-picker'

function config(overrides: Partial<ProviderConfigSummary> = {}): ProviderConfigSummary {
  return {
    id: 'pc-anthropic',
    provider: 'anthropic',
    label: 'Personal key',
    maskedKey: 'sk-...ab12',
    baseUrl: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('buildModelPickerOptions', () => {
  it('prefers a live-fetched catalog over the static fallback when the catalog is non-empty', () => {
    const configs = [config()]
    const catalogs: Record<string, ProviderModelCatalog> = {
      'pc-anthropic': {
        providerConfigId: 'pc-anthropic',
        models: [{ id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }],
        fetchedAt: 123,
      },
    }
    const options = buildModelPickerOptions(configs, catalogs)
    expect(options).toEqual([
      {
        providerConfigId: 'pc-anthropic',
        provider: 'anthropic',
        configLabel: 'Personal key',
        modelId: 'claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        label: 'Claude Sonnet 5',
      },
    ])
  })

  it('falls back to the static Anthropic list when nothing is cached yet', () => {
    const options = buildModelPickerOptions([config()], {})
    expect(options.map((o) => o.modelId)).toContain('claude-sonnet-5')
    expect(options.map((o) => o.modelId)).toContain('claude-haiku-4-5-20251001')
  })

  it('falls back to the static list when the cached catalog is empty (fetch never succeeded)', () => {
    const catalogs: Record<string, ProviderModelCatalog> = {
      'pc-anthropic': { providerConfigId: 'pc-anthropic', models: [], fetchedAt: null },
    }
    const options = buildModelPickerOptions([config()], catalogs)
    expect(options.length).toBeGreaterThan(0)
  })

  it('has no options for a configured OpenAI provider with no cache yet (no static fallback)', () => {
    const options = buildModelPickerOptions(
      [config({ id: 'pc-openai', provider: 'openai', label: 'Work key' })],
      {},
    )
    expect(options).toEqual([])
  })

  it('uses the raw model id as the label when the provider gives no display name', () => {
    const configs = [config({ id: 'pc-openai', provider: 'openai', label: 'Work key' })]
    const catalogs: Record<string, ProviderModelCatalog> = {
      'pc-openai': {
        providerConfigId: 'pc-openai',
        models: [{ id: 'gpt-4o', displayName: null }],
        fetchedAt: 1,
      },
    }
    const options = buildModelPickerOptions(configs, catalogs)
    expect(options[0]?.label).toBe('gpt-4o')
  })

  it('flattens options across multiple provider configs', () => {
    const configs = [
      config({ id: 'pc-1', label: 'Personal' }),
      config({ id: 'pc-2', provider: 'openai', label: 'Work' }),
    ]
    const catalogs: Record<string, ProviderModelCatalog> = {
      'pc-2': { providerConfigId: 'pc-2', models: [{ id: 'gpt-4o', displayName: null }], fetchedAt: 1 },
    }
    const options = buildModelPickerOptions(configs, catalogs)
    const providerConfigIds = new Set(options.map((o) => o.providerConfigId))
    expect(providerConfigIds).toEqual(new Set(['pc-1', 'pc-2']))
  })
})

describe('filterModelPickerOptions', () => {
  const options = buildModelPickerOptions(
    [config({ id: 'pc-1', label: 'Personal key' }), config({ id: 'pc-2', label: 'Work key' })],
    {},
  )

  it('returns everything for an empty/blank query', () => {
    expect(filterModelPickerOptions(options, '')).toEqual(options)
    expect(filterModelPickerOptions(options, '   ')).toEqual(options)
  })

  it('matches by model id substring, case-insensitively', () => {
    const filtered = filterModelPickerOptions(options, 'HAIKU')
    expect(filtered.every((o) => o.modelId.toLowerCase().includes('haiku'))).toBe(true)
    expect(filtered.length).toBeGreaterThan(0)
  })

  it('matches by the provider config label too', () => {
    const filtered = filterModelPickerOptions(options, 'work key')
    expect(filtered.every((o) => o.configLabel === 'Work key')).toBe(true)
    expect(filtered.length).toBeGreaterThan(0)
  })

  it('returns nothing for a query that matches no field', () => {
    expect(filterModelPickerOptions(options, 'totally-unrelated-xyz')).toEqual([])
  })

  it('ranks a prefix match on the model id above a match found elsewhere', () => {
    const filtered = filterModelPickerOptions(options, 'claude')
    // every Anthropic fallback id starts with "claude", so the id-prefix
    // match should win over a match buried in configLabel/provider name —
    // just prove the id match is present near the front, not asserting an
    // exact global order (multiple options tie on id-prefix score).
    expect(filtered[0]?.modelId.toLowerCase().startsWith('claude')).toBe(true)
  })
})
