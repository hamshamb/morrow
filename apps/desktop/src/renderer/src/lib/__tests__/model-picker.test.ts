import { describe, expect, it } from 'vitest'
import type { ModelMetadata, ProviderConfigSummary, ProviderModelCatalog } from '@ai-workspace/shared'
import { buildModelPickerOptions, filterModelPickerOptions } from '../model-picker'

const LABELS: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', groq: 'Groq' }
const label = (id: string) => LABELS[id] ?? id

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

function meta(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    family: 'claude-sonnet',
    reasoning: true,
    reasoningEfforts: ['low', 'high', 'xhigh', 'max'],
    reasoningToggle: false,
    reasoningBudget: null,
    attachment: true,
    vision: true,
    inputModalities: ['text', 'image'],
    toolCall: true,
    structuredOutput: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cost: { input: 2, output: 10, cacheRead: null, cacheWrite: null },
    knowledge: null,
    releaseDate: null,
    openWeights: false,
    status: null,
    ...overrides,
  }
}

function catalog(id: string, models: ProviderModelCatalog['models']): ProviderModelCatalog {
  return { providerConfigId: id, models, fetchedAt: 1, source: 'live' }
}

const CATALOGS: Record<string, ProviderModelCatalog> = {
  'pc-1': catalog('pc-1', [
    { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', meta: meta() },
    { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', meta: meta({ id: 'claude-haiku-4-5', family: 'claude-haiku' }) },
  ]),
  'pc-2': catalog('pc-2', [{ id: 'llama-3.3-70b-versatile', displayName: null, meta: null }]),
}

describe('buildModelPickerOptions', () => {
  it('flattens each config catalog into options carrying the provider label and models.dev metadata', () => {
    const options = buildModelPickerOptions([config({ id: 'pc-1' })], CATALOGS, label)
    expect(options).toHaveLength(2)
    expect(options[0]).toMatchObject({
      providerConfigId: 'pc-1',
      provider: 'anthropic',
      providerLabel: 'Anthropic',
      configLabel: 'Personal key',
      modelId: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      label: 'Claude Sonnet 5',
    })
    expect(options[0]?.meta?.contextWindow).toBe(1_000_000)
  })

  it('uses the raw model id as the label and null meta when neither is known', () => {
    const options = buildModelPickerOptions([config({ id: 'pc-2', provider: 'groq' })], CATALOGS, label)
    expect(options[0]).toMatchObject({ label: 'llama-3.3-70b-versatile', meta: null, providerLabel: 'Groq' })
  })

  it('has no options (and no hardcoded fallback list) for a config whose catalog has not loaded yet', () => {
    expect(buildModelPickerOptions([config()], {}, label)).toEqual([])
  })

  it('flattens options across multiple provider configs', () => {
    const options = buildModelPickerOptions(
      [config({ id: 'pc-1' }), config({ id: 'pc-2', provider: 'groq' })],
      CATALOGS,
      label,
    )
    expect(new Set(options.map((o) => o.providerConfigId))).toEqual(new Set(['pc-1', 'pc-2']))
  })

  it('resolves labels for providers that did not exist when the app shipped (registry-driven)', () => {
    const options = buildModelPickerOptions(
      [config({ id: 'pc-2', provider: 'some-new-provider' })],
      CATALOGS,
      (id) => (id === 'some-new-provider' ? 'Some New Provider' : id),
    )
    expect(options[0]?.providerLabel).toBe('Some New Provider')
  })
})

describe('filterModelPickerOptions', () => {
  const options = buildModelPickerOptions(
    [config({ id: 'pc-1', label: 'Personal key' }), config({ id: 'pc-2', provider: 'groq', label: 'Work key' })],
    CATALOGS,
    label,
  )

  it('returns everything for an empty/blank query', () => {
    expect(filterModelPickerOptions(options, '')).toEqual(options)
    expect(filterModelPickerOptions(options, '   ')).toEqual(options)
  })

  it('matches by model id substring, case-insensitively', () => {
    const filtered = filterModelPickerOptions(options, 'HAIKU')
    expect(filtered.map((o) => o.modelId)).toEqual(['claude-haiku-4-5'])
  })

  it('matches by provider name and by config label', () => {
    expect(filterModelPickerOptions(options, 'groq').map((o) => o.providerConfigId)).toEqual(['pc-2'])
    expect(filterModelPickerOptions(options, 'work key').every((o) => o.configLabel === 'Work key')).toBe(true)
  })

  it('matches by models.dev family', () => {
    expect(filterModelPickerOptions(options, 'claude-haiku').map((o) => o.modelId)).toEqual(['claude-haiku-4-5'])
  })

  it('returns nothing for a query that matches no field', () => {
    expect(filterModelPickerOptions(options, 'totally-unrelated-xyz')).toEqual([])
  })

  it('ranks a prefix match on the model id above a match found elsewhere', () => {
    expect(filterModelPickerOptions(options, 'claude')[0]?.modelId.startsWith('claude')).toBe(true)
  })
})
