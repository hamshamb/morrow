import { describe, expect, it } from 'vitest'
import { detectProviderFromKey, looksLikeCompleteKey } from '../provider-key'
import { DEFAULT_SESSION_TITLE, deriveSessionTitle } from '../session-title'
import { describeProviderError } from '../provider-error'
import { findDisplayName, shortModelName } from '../model-label'
import { formatRelativeTime } from '../time'

describe('formatRelativeTime', () => {
  const now = 10_000_000_000
  it('formats compact relative times', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m')
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h')
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d')
    expect(formatRelativeTime(now - 21 * 86_400_000, now)).toBe('3w')
  })
  it('never goes negative for a timestamp slightly in the future', () => {
    expect(formatRelativeTime(now + 5_000, now)).toBe('now')
  })
})
describe('detectProviderFromKey (registry-driven)', () => {
  const registry = [
    { id: 'anthropic', keyPrefix: 'sk-ant-' },
    { id: 'openai', keyPrefix: 'sk-proj-' },
    { id: 'openrouter', keyPrefix: 'sk-or-' },
    { id: 'google', keyPrefix: 'AIza' },
    { id: 'xai', keyPrefix: 'xai-' },
    { id: 'deepseek', keyPrefix: null },
  ]

  it('uses the prefixes the registry advertises, including providers added later', () => {
    expect(detectProviderFromKey('sk-ant-api03-abcdefghijklmnop', registry)).toBe('anthropic')
    expect(detectProviderFromKey('xai-abcdefghijklmnopqrstuvwx', registry)).toBe('xai')
    expect(detectProviderFromKey('sk-or-v1-abcdefghijklmnop', registry)).toBe('openrouter')
    expect(detectProviderFromKey('AIzaSyA1234567890abcdefghij', registry)).toBe('google')
  })

  it('ignores surrounding whitespace from a paste', () => {
    expect(detectProviderFromKey('  sk-ant-api03-abcdefghijklmnop\n', registry)).toBe('anthropic')
  })

  it('asks the user to pick when the prefix is shared or unknown (bare sk- is OpenAI and DeepSeek)', () => {
    expect(detectProviderFromKey('sk-abcdefghijklmnopqrstuvwx', registry)).toBeNull()
    expect(detectProviderFromKey('0123456789abcdefghijklmnop', registry)).toBeNull()
    expect(detectProviderFromKey('sk-', registry)).toBeNull()
    expect(detectProviderFromKey('', registry)).toBeNull()
  })

  it('looksLikeCompleteKey only accepts a plausible full, single-token key', () => {
    expect(looksLikeCompleteKey('sk-ant-api03-abcdefghijklmnop')).toBe(true)
    expect(looksLikeCompleteKey('sk-ant-')).toBe(false)
    expect(looksLikeCompleteKey('sk-ant-api03 abcdefghijklmnop')).toBe(false)
  })
})

describe('deriveSessionTitle', () => {
  it('takes the first six words and marks truncation', () => {
    expect(deriveSessionTitle('Can you help me redesign the auth flow to be more secure?')).toBe(
      'Can you help me redesign the…',
    )
  })

  it('keeps a short message whole, without trailing punctuation', () => {
    expect(deriveSessionTitle('What changed in the last deploy?')).toBe(
      'What changed in the last deploy',
    )
  })

  it('strips markdown noise and fenced code', () => {
    expect(deriveSessionTitle('## Fix **this** bug\n```ts\nconst x = 1\n```')).toBe('Fix this bug')
  })

  it('caps very long words at 60 characters', () => {
    const title = deriveSessionTitle('a'.repeat(100))
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)
  })

  it('falls back to the default title when there are no usable words', () => {
    expect(deriveSessionTitle('   ')).toBe(DEFAULT_SESSION_TITLE)
    expect(deriveSessionTitle('```\nonly code\n```')).toBe(DEFAULT_SESSION_TITLE)
  })
})

describe('describeProviderError', () => {
  it('explains a rejected key without echoing the raw JSON', () => {
    const msg = describeProviderError(
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    )
    expect(msg).toMatch(/rejected the API key/)
    expect(msg).not.toContain('{')
  })

  it('maps model-not-found, rate limits, overload and network failures', () => {
    expect(describeProviderError('404 not_found_error: model: claude-x')).toMatch(/isn't available/)
    expect(describeProviderError('429 Too Many Requests')).toMatch(/Rate limited/)
    expect(describeProviderError('529 overloaded_error')).toMatch(/overloaded/)
    expect(describeProviderError('TypeError: fetch failed')).toMatch(/Couldn't reach/)
  })

  it('summarizes an unknown error as one JSON-free line', () => {
    const msg = describeProviderError('Something odd {"detail":"x"}\n    at foo (bar.js:1:1)')
    expect(msg).toBe('Something odd')
  })

  it('does not point to Settings while the user is already entering a key', () => {
    const msg = describeProviderError('401 authentication_error', 'key')
    expect(msg).toMatch(/rejected this key/)
    expect(msg).not.toMatch(/Settings/)
  })

  it('handles an empty error', () => {
    expect(describeProviderError('')).toMatch(/failed/)
    expect(describeProviderError(null)).toMatch(/failed/)
  })
})

describe('model labels', () => {
  it('shortModelName prefers the display name and drops a leading "Claude"', () => {
    expect(shortModelName('claude-sonnet-5', 'Claude Sonnet 5')).toBe('Sonnet 5')
    expect(shortModelName('gpt-5.1', 'GPT-5.1')).toBe('GPT-5.1')
    expect(shortModelName('claude-opus-5-5', null)).toBe('opus-5-5')
  })

  it('findDisplayName searches every cached catalog', () => {
    const catalogs = {
      a: { providerConfigId: 'a', fetchedAt: 1, models: [{ id: 'gpt-5.1', displayName: 'GPT-5.1' }] },
      b: { providerConfigId: 'b', fetchedAt: 1, models: [{ id: 'm', displayName: null }] },
    }
    expect(findDisplayName(catalogs, 'gpt-5.1')).toBe('GPT-5.1')
    expect(findDisplayName(catalogs, 'm')).toBeNull()
    expect(findDisplayName(catalogs, 'missing')).toBeNull()
  })
})
