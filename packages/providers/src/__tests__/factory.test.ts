import { describe, expect, it } from 'vitest'
import { createProvider } from '../factory'

describe('createProvider', () => {
  it('builds an anthropic provider carrying the right id', () => {
    const provider = createProvider('anthropic', { apiKey: 'sk-test' })
    expect(provider.id).toBe('anthropic')
  })

  it('builds an openai provider carrying the right id', () => {
    const provider = createProvider('openai', { apiKey: 'sk-test' })
    expect(provider.id).toBe('openai')
  })

  it('builds a google provider carrying the right id', () => {
    const provider = createProvider('google', { apiKey: 'test-key' })
    expect(provider.id).toBe('google')
  })
})
