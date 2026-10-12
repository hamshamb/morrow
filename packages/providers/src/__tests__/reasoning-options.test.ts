import { describe, expect, it } from 'vitest'
import type { ModelMetadata, ReasoningEffort } from '@ai-workspace/shared'
import { lookupModelMetadata } from '../catalog'
import { parseModelsDevCatalog } from '../models-dev'
import {
  ANTHROPIC_THINKING_BUDGET_TOKENS,
  buildReasoningProviderOptions,
  sdkSupportedEfforts,
  usableEfforts,
  validateEffort,
} from '../reasoning-options'
import type { FactoryKey } from '../registry'
import { RAW_FIXTURE } from './fixtures/models-dev-raw'

const catalog = parseModelsDevCatalog(RAW_FIXTURE)

function meta(provider: string, id: string, key: FactoryKey): ModelMetadata {
  const m = lookupModelMetadata(catalog[provider], id, key)
  if (!m) throw new Error(`fixture missing ${provider}/${id}`)
  return m
}

function build(key: FactoryKey, effort: ReasoningEffort | null, model: ModelMetadata | null) {
  return buildReasoningProviderOptions({ factoryKey: key, effort, model })
}

describe('validateEffort', () => {
  const sonnet = meta('anthropic', 'claude-sonnet-5', '@ai-sdk/anthropic')

  it('accepts only values the model lists', () => {
    expect(validateEffort('@ai-sdk/anthropic', 'xhigh', sonnet)).toBe('xhigh')
    expect(validateEffort('@ai-sdk/anthropic', 'max', sonnet)).toBe('max')
    expect(validateEffort('@ai-sdk/anthropic', 'minimal', sonnet)).toBeUndefined()
    expect(validateEffort('@ai-sdk/anthropic', 'none', sonnet)).toBeUndefined()
  })

  it('rejects everything for a non-reasoning, unknown or missing model', () => {
    const gpt4o = meta('openai', 'gpt-4o-mini', '@ai-sdk/openai')
    expect(validateEffort('@ai-sdk/openai', 'high', gpt4o)).toBeUndefined()
    expect(validateEffort('@ai-sdk/openai', 'high', null)).toBeUndefined()
    expect(validateEffort('@ai-sdk/openai', null, sonnet)).toBeUndefined()
  })

  it('rejects a value the SDK cannot send even if the data lists it', () => {
    const fake = { ...sonnet, reasoningEfforts: ['max' as const] }
    expect(validateEffort('@openrouter/ai-sdk-provider', 'max', fake)).toBeUndefined()
    expect(validateEffort('@ai-sdk/perplexity', 'high', { ...sonnet, reasoningEfforts: ['high' as const] })).toBeUndefined()
  })
})

describe('usableEfforts / sdkSupportedEfforts', () => {
  it('intersects the model values with the SDK values, weakest first', () => {
    expect(usableEfforts('@ai-sdk/groq', ['high', 'max', 'low', 'none'])).toEqual(['none', 'low', 'high'])
    expect(usableEfforts('@ai-sdk/perplexity', ['low', 'high'])).toEqual([])
    expect(sdkSupportedEfforts('@ai-sdk/openai')).toContain('max')
  })
})

describe('buildReasoningProviderOptions', () => {
  it('sends nothing without an effort or without metadata', () => {
    const sonnet = meta('anthropic', 'claude-sonnet-5', '@ai-sdk/anthropic')
    expect(build('@ai-sdk/anthropic', null, sonnet)).toBeUndefined()
    expect(build('@ai-sdk/anthropic', 'high', null)).toBeUndefined()
  })

  it('Anthropic adaptive model: passes xhigh/max straight through as effort with adaptive thinking', () => {
    const sonnet = meta('anthropic', 'claude-sonnet-5', '@ai-sdk/anthropic')
    expect(build('@ai-sdk/anthropic', 'xhigh', sonnet)).toEqual({
      anthropic: { effort: 'xhigh', thinking: { type: 'adaptive' } },
    })
    expect(build('@ai-sdk/anthropic', 'max', sonnet)).toEqual({
      anthropic: { effort: 'max', thinking: { type: 'adaptive' } },
    })
  })

  it('Anthropic effort+budget model (Opus 4.5): sends effort and an explicit increasing thinking budget', () => {
    const opus = meta('anthropic', 'claude-opus-4-5', '@ai-sdk/anthropic')
    const low = build('@ai-sdk/anthropic', 'low', opus)!.anthropic as { effort: string; thinking: { budgetTokens: number; type: string } }
    const high = build('@ai-sdk/anthropic', 'high', opus)!.anthropic as { effort: string; thinking: { budgetTokens: number; type: string } }
    expect(low.effort).toBe('low')
    expect(low.thinking.type).toBe('enabled')
    expect(low.thinking.budgetTokens).toBe(ANTHROPIC_THINKING_BUDGET_TOKENS.low)
    expect(high.thinking.budgetTokens).toBeGreaterThan(low.thinking.budgetTokens)
  })

  it('Anthropic budget-only model (Haiku 4.5) offers no effort, so nothing is sent', () => {
    const haiku = meta('anthropic', 'claude-haiku-4-5', '@ai-sdk/anthropic')
    expect(haiku.reasoningEfforts).toEqual([])
    expect(build('@ai-sdk/anthropic', 'high', haiku)).toBeUndefined()
  })

  it('Anthropic: none disables thinking', () => {
    const model = { ...meta('anthropic', 'claude-sonnet-5', '@ai-sdk/anthropic'), reasoningEfforts: ['none' as const, 'high' as const] }
    expect(build('@ai-sdk/anthropic', 'none', model)).toEqual({ anthropic: { thinking: { type: 'disabled' } } })
  })

  it('OpenAI: reasoningEffort carries none / xhigh / max verbatim', () => {
    const gpt = meta('openai', 'gpt-5.6', '@ai-sdk/openai')
    for (const e of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(build('@ai-sdk/openai', e, gpt)).toEqual({ openai: { reasoningEffort: e } })
    }
    const mini = meta('openai', 'gpt-5-mini', '@ai-sdk/openai')
    expect(build('@ai-sdk/openai', 'minimal', mini)).toEqual({ openai: { reasoningEffort: 'minimal' } })
    expect(build('@ai-sdk/openai', 'max', mini)).toBeUndefined() // not in this model's list
  })

  it('Google: maps to thinkingConfig.thinkingLevel; budget-only Gemini 2.5 Pro offers none', () => {
    const flash = meta('google', 'gemini-3.5-flash', '@ai-sdk/google')
    expect(build('@ai-sdk/google', 'minimal', flash)).toEqual({ google: { thinkingConfig: { thinkingLevel: 'minimal' } } })
    const pro = meta('google', 'gemini-2.5-pro', '@ai-sdk/google')
    expect(pro.reasoningEfforts).toEqual([])
    expect(build('@ai-sdk/google', 'high', pro)).toBeUndefined()
  })

  it('xAI, Mistral, Groq, Cerebras, DeepSeek, OpenRouter, openai-compatible each use their own option name', () => {
    const grok = meta('xai', 'grok-4.7', '@ai-sdk/xai')
    expect(build('@ai-sdk/xai', 'xhigh', grok)).toEqual({ xai: { reasoningEffort: 'xhigh' } })

    const mistral = meta('mistral', 'mistral-small-latest', '@ai-sdk/mistral')
    expect(build('@ai-sdk/mistral', 'high', mistral)).toEqual({ mistral: { reasoningEffort: 'high' } })

    const synthetic = { ...grok, reasoningEfforts: ['low' as const, 'medium' as const, 'high' as const] }
    expect(build('@ai-sdk/groq', 'medium', synthetic)).toEqual({ groq: { reasoningEffort: 'medium' } })
    expect(build('@ai-sdk/cerebras', 'low', synthetic)).toEqual({ cerebras: { reasoningEffort: 'low' } })
    expect(build('@ai-sdk/togetherai', 'high', synthetic)).toEqual({ openaiCompatible: { reasoningEffort: 'high' } })
    expect(build('@ai-sdk/openai-compatible', 'high', synthetic)).toEqual({ openaiCompatible: { reasoningEffort: 'high' } })

    const ds = meta('deepseek', 'deepseek-v4-flash', '@ai-sdk/deepseek')
    expect(build('@ai-sdk/deepseek', 'max', ds)).toEqual({
      deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'max' },
    })

    const or = meta('openrouter', 'anthropic/claude-sonnet-5', '@openrouter/ai-sdk-provider')
    expect(build('@openrouter/ai-sdk-provider', 'xhigh', or)).toEqual({ openrouter: { reasoning: { effort: 'xhigh' } } })
    expect(build('@openrouter/ai-sdk-provider', 'max', or)).toBeUndefined() // dropped: OpenRouter has no max
  })

  it('Perplexity never sends a reasoning option', () => {
    const sonar = meta('perplexity', 'sonar-deep-research', '@ai-sdk/perplexity')
    expect(build('@ai-sdk/perplexity', 'high', sonar)).toBeUndefined()
  })
})
