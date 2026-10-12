import { describe, expect, it } from 'vitest'
import { compactSearch, matchesSearch, normalizeSearch } from '../search-match'

describe('normalizeSearch', () => {
  it('lowercases and collapses punctuation/whitespace to single spaces', () => {
    expect(normalizeSearch('  GPT-4o  Mini ')).toBe('gpt 4o mini')
  })
})

describe('compactSearch', () => {
  it('removes all spaces after normalizing', () => {
    expect(compactSearch('GPT-4o Mini')).toBe('gpt4omini')
  })
})

describe('matchesSearch', () => {
  it('matches an empty query against anything', () => {
    expect(matchesSearch('', ['Anthropic', 'Claude Sonnet 5'])).toBe(true)
  })

  it('matches a normalized substring', () => {
    expect(matchesSearch('claude sonnet', ['Anthropic', 'Claude Sonnet 5'])).toBe(true)
  })

  it('matches a compacted query against a punctuated value (e.g. "gpt4o" vs "GPT-4o")', () => {
    expect(matchesSearch('gpt4o', ['OpenAI', 'GPT-4o'])).toBe(true)
  })

  it('returns false when no value matches either way', () => {
    expect(matchesSearch('gemini', ['Anthropic', 'Claude Sonnet 5'])).toBe(false)
  })
})
