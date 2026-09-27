import { describe, expect, it } from 'vitest'
import { buildAnthropicProviderOptions, buildOpenAiProviderOptions } from '../adapters/reasoning-options'

describe('buildAnthropicProviderOptions', () => {
  it('returns undefined when no effort is selected', () => {
    expect(buildAnthropicProviderOptions(null, 'claude-sonnet-5')).toBeUndefined()
    expect(buildAnthropicProviderOptions(undefined, 'claude-sonnet-5')).toBeUndefined()
  })

  it('returns undefined for a Haiku model even with an effort selected', () => {
    expect(buildAnthropicProviderOptions('high', 'claude-haiku-4-5-20251001')).toBeUndefined()
  })

  it('sends both the top-level effort and a thinking budget for a non-Haiku model', () => {
    const options = buildAnthropicProviderOptions('medium', 'claude-sonnet-5')
    expect(options).toEqual({
      effort: 'medium',
      thinking: { type: 'enabled', budgetTokens: 10_000 },
    })
  })

  it('maps low/medium/high to strictly increasing budget tiers', () => {
    const low = buildAnthropicProviderOptions('low', 'claude-opus-5-5')
    const medium = buildAnthropicProviderOptions('medium', 'claude-opus-5-5')
    const high = buildAnthropicProviderOptions('high', 'claude-opus-5-5')
    expect(low?.thinking.budgetTokens).toBeLessThan(medium!.thinking.budgetTokens)
    expect(medium?.thinking.budgetTokens).toBeLessThan(high!.thinking.budgetTokens)
    expect(low?.effort).toBe('low')
    expect(high?.effort).toBe('high')
  })
})

describe('buildOpenAiProviderOptions', () => {
  it('returns undefined when no effort is selected', () => {
    expect(buildOpenAiProviderOptions(null, 'o3-mini')).toBeUndefined()
  })

  it('returns undefined for a non-reasoning model even with an effort selected', () => {
    expect(buildOpenAiProviderOptions('high', 'gpt-4o')).toBeUndefined()
    expect(buildOpenAiProviderOptions('high', 'gpt-4o-mini')).toBeUndefined()
  })

  it('maps the effort directly onto reasoningEffort for an o-series model', () => {
    expect(buildOpenAiProviderOptions('low', 'o1')).toEqual({ reasoningEffort: 'low' })
    expect(buildOpenAiProviderOptions('high', 'o3-mini')).toEqual({ reasoningEffort: 'high' })
  })

  it('maps the effort directly onto reasoningEffort for a gpt-5 model', () => {
    expect(buildOpenAiProviderOptions('medium', 'gpt-5-mini')).toEqual({ reasoningEffort: 'medium' })
  })
})
