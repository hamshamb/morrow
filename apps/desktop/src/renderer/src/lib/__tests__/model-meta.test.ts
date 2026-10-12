import { describe, expect, it } from 'vitest'
import type { ModelMetadata, ProviderModelCatalog } from '@ai-workspace/shared'
import {
  capabilityMarks,
  contextBudget,
  effortLabel,
  effortsOf,
  findModelMeta,
  formatContext,
  formatPrice,
  formatTokens,
  keepEffort,
  metaSummary,
  pickDefaultModel,
} from '../model-meta'

const BASE: ModelMetadata = {
  id: 'm',
  name: 'M',
  family: null,
  reasoning: true,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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
}
const meta = (o: Partial<ModelMetadata> = {}): ModelMetadata => ({ ...BASE, ...o })

describe('formatTokens / formatContext', () => {
  it('abbreviates token counts compactly', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_048_576)).toBe('1M')
    expect(formatTokens(1_050_000)).toBe('1.1M')
    expect(formatTokens(200_000)).toBe('200K')
    expect(formatTokens(131_072)).toBe('131K')
    expect(formatTokens(18_300)).toBe('18K')
    expect(formatTokens(1_500)).toBe('1.5K')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(0)).toBe('0')
  })

  it('formats a context window as "<n> ctx" and omits unknown windows', () => {
    expect(formatContext(1_000_000)).toBe('1M ctx')
    expect(formatContext(128_000)).toBe('128K ctx')
    expect(formatContext(null)).toBeNull()
    expect(formatContext(0)).toBeNull()
  })
})

describe('formatPrice', () => {
  it('formats USD per 1M input/output tokens compactly', () => {
    expect(formatPrice({ input: 2, output: 10, cacheRead: null, cacheWrite: null })).toBe('$2/$10')
    expect(formatPrice({ input: 0.15, output: 0.6, cacheRead: null, cacheWrite: null })).toBe('$0.15/$0.6')
    expect(formatPrice({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: null })).toBe('$2.5/$15')
    expect(formatPrice({ input: 0.075, output: 0.3, cacheRead: null, cacheWrite: null })).toBe('$0.075/$0.3')
  })

  it('says free for zero-priced models and nothing for unpriced ones', () => {
    expect(formatPrice({ input: 0, output: 0, cacheRead: null, cacheWrite: null })).toBe('free')
    expect(formatPrice(null)).toBeNull()
  })
})

describe('capabilityMarks / metaSummary', () => {
  it('lists vision, tools and reasoning in a stable order', () => {
    expect(capabilityMarks(meta())).toEqual(['vision', 'tools', 'reasoning'])
    expect(capabilityMarks(meta({ vision: false, reasoning: false }))).toEqual(['tools'])
    expect(capabilityMarks(null)).toEqual([])
  })

  it('builds the single muted line shown in the picker', () => {
    expect(metaSummary(meta())).toBe('1M ctx · $2/$10 · vision tools reasoning')
    expect(metaSummary(meta({ cost: null, contextWindow: null, vision: false, toolCall: false, reasoning: false }))).toBe('')
    expect(metaSummary(meta({ cost: null }))).toBe('1M ctx · vision tools reasoning')
    expect(metaSummary(null)).toBe('')
  })
})

describe('efforts', () => {
  it('offers exactly the efforts the model lists, including xhigh and max', () => {
    expect(effortsOf(meta())).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('hides the control (empty list) for non-reasoning, unknown and effort-less models', () => {
    expect(effortsOf(meta({ reasoning: false }))).toEqual([])
    expect(effortsOf(meta({ reasoningEfforts: [] }))).toEqual([])
    expect(effortsOf(null)).toEqual([])
  })

  it('keeps a selected effort only if the new model supports it', () => {
    expect(keepEffort('max', meta())).toBe('max')
    expect(keepEffort('max', meta({ reasoningEfforts: ['low', 'high'] }))).toBeNull()
    expect(keepEffort('high', meta({ reasoning: false }))).toBeNull()
    expect(keepEffort(null, meta())).toBeNull()
  })

  it('labels "none" as off', () => {
    expect(effortLabel('none')).toBe('off')
    expect(effortLabel('xhigh')).toBe('xhigh')
  })
})

describe('pickDefaultModel', () => {
  it('prefers the newest tool-capable model by models.dev release date', () => {
    const models = [
      { id: 'old', meta: meta({ releaseDate: '2024-01-01' }) },
      { id: 'newest', meta: meta({ releaseDate: '2026-06-29' }) },
      { id: 'no-tools', meta: meta({ releaseDate: '2027-01-01', toolCall: false }) },
    ]
    expect(pickDefaultModel(models)).toBe('newest')
  })

  it('falls back to the first listed model when nothing has metadata (Ollama, custom)', () => {
    expect(pickDefaultModel([{ id: 'llama3.2:latest' }, { id: 'qwen3:8b', meta: null }])).toBe('llama3.2:latest')
  })

  it('is null for an empty list', () => {
    expect(pickDefaultModel([])).toBeNull()
  })
})

describe('findModelMeta', () => {
  const catalogs: Record<string, ProviderModelCatalog> = {
    pc: { providerConfigId: 'pc', fetchedAt: null, models: [{ id: 'm', displayName: null, meta: BASE }, { id: 'u', displayName: null }] },
  }
  it('looks metadata up by config and model id', () => {
    expect(findModelMeta(catalogs, 'pc', 'm')).toEqual(BASE)
    expect(findModelMeta(catalogs, 'pc', 'u')).toBeNull()
    expect(findModelMeta(catalogs, 'other', 'm')).toBeNull()
    expect(findModelMeta(catalogs, null, 'm')).toBeNull()
  })
})

describe('contextBudget', () => {
  it('reports ~used / limit against the selected model window', () => {
    const b = contextBudget(18_300, 1_000_000)
    expect(b.label).toBe('~18K / 1M')
    expect(b.level).toBe('ok')
    expect(b.ratio).toBeCloseTo(0.0183)
  })

  it('warns at 80% and flags over-budget at 100%', () => {
    expect(contextBudget(79_999, 100_000).level).toBe('ok')
    expect(contextBudget(80_000, 100_000).level).toBe('warn')
    expect(contextBudget(99_999, 100_000).level).toBe('warn')
    expect(contextBudget(100_000, 100_000).level).toBe('over')
    expect(contextBudget(250_000, 200_000).level).toBe('over')
  })

  it('degrades to just the estimate when the model window is unknown', () => {
    const b = contextBudget(18_300, null)
    expect(b).toMatchObject({ level: 'unknown', ratio: null, limit: null, label: '~18K' })
  })

  it('never reports negative usage', () => {
    expect(contextBudget(-5, 1000).usedTokens).toBe(0)
  })
})
