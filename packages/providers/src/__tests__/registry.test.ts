import { describe, expect, it } from 'vitest'
import { parseModelsDevCatalog } from '../models-dev'
import {
  buildProviderRegistry,
  detectProviderByKeyPrefix,
  isLocalUrl,
  modelListBaseUrl,
  resolveProviderRuntime,
} from '../registry'
import { RAW_FIXTURE } from './fixtures/models-dev-raw'

const catalog = parseModelsDevCatalog(RAW_FIXTURE)

function resolve(id: string) {
  return resolveProviderRuntime(id, catalog[id])
}

describe('resolveProviderRuntime', () => {
  it('uses the bundled factory when models.dev npm is a package we ship', () => {
    for (const [id, factoryKey] of [
      ['anthropic', '@ai-sdk/anthropic'],
      ['openai', '@ai-sdk/openai'],
      ['google', '@ai-sdk/google'],
      ['xai', '@ai-sdk/xai'],
      ['mistral', '@ai-sdk/mistral'],
      ['perplexity', '@ai-sdk/perplexity'],
      ['openrouter', '@openrouter/ai-sdk-provider'],
    ] as const) {
      const r = resolve(id)
      expect(r.status).toBe('ok')
      if (r.status === 'ok') {
        expect(r.factoryKey).toBe(factoryKey)
        expect(r.kind).toBe('bundled')
        expect(r.keyRequired).toBe(true)
      }
    }
  })

  it('routes DeepSeek to the dedicated @ai-sdk/deepseek package although models.dev says openai-compatible', () => {
    const r = resolve('deepseek')
    expect(r).toMatchObject({ status: 'ok', factoryKey: '@ai-sdk/deepseek', kind: 'bundled' })
  })

  it('runs an openai-compatible provider with its models.dev base URL', () => {
    const r = resolve('fireworks-ai')
    expect(r).toMatchObject({
      status: 'ok',
      factoryKey: '@ai-sdk/openai-compatible',
      kind: 'openai-compatible',
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
    })
  })

  it('falls back to openai-compatible when npm is not shipped but a plain api URL exists', () => {
    expect(resolve('some-unbundled')).toMatchObject({
      status: 'ok',
      factoryKey: '@ai-sdk/openai-compatible',
      baseUrl: 'https://api.unbundled.example/v1',
    })
  })

  it('excludes a provider with an unshipped SDK and no api URL', () => {
    const r = resolve('venice')
    expect(r.status).toBe('excluded')
    if (r.status === 'excluded') expect(r.reason).toContain('venice-ai-sdk-provider')
  })

  it('excludes templated endpoints that need extra account settings', () => {
    const r = resolve('cloudflare-workers-ai')
    expect(r.status).toBe('excluded')
    if (r.status === 'excluded') expect(r.reason).toContain('templated')
  })

  it('excludes non-API-key providers (Azure, Bedrock, Vertex, Copilot) even if they have an api URL', () => {
    for (const id of ['azure', 'github-copilot', 'amazon-bedrock', 'google-vertex']) {
      expect(resolveProviderRuntime(id, catalog[id]).status).toBe('excluded')
    }
  })

  it('excludes an id that is neither in the catalog nor built in', () => {
    expect(resolveProviderRuntime('nope').status).toBe('excluded')
  })

  it('still resolves the three launch providers when the catalog lacks them', () => {
    expect(resolveProviderRuntime('anthropic')).toMatchObject({ status: 'ok', factoryKey: '@ai-sdk/anthropic' })
    expect(resolveProviderRuntime('openai')).toMatchObject({ status: 'ok', factoryKey: '@ai-sdk/openai' })
    expect(resolveProviderRuntime('google')).toMatchObject({ status: 'ok', factoryKey: '@ai-sdk/google' })
  })

  it('treats a localhost api URL as a local, keyless provider', () => {
    expect(resolve('lmstudio')).toMatchObject({ status: 'ok', kind: 'local', isLocal: true, keyRequired: false })
  })

  it('Ollama is local, keyless and defaults to localhost:11434/v1', () => {
    expect(resolveProviderRuntime('ollama')).toMatchObject({
      status: 'ok',
      kind: 'local',
      isLocal: true,
      keyRequired: false,
      baseUrl: 'http://localhost:11434/v1',
    })
  })

  it('the custom endpoint is OpenAI-compatible with a user-supplied base URL', () => {
    expect(resolveProviderRuntime('custom')).toMatchObject({
      status: 'ok',
      factoryKey: '@ai-sdk/openai-compatible',
      kind: 'custom',
      baseUrl: null,
      keyRequired: false,
    })
  })
})

describe('modelListBaseUrl', () => {
  it('prefers a user override, then the registry URL, then the SDK default', () => {
    const anthropic = resolve('anthropic')
    const xai = resolve('xai')
    const fireworks = resolve('fireworks-ai')
    if (anthropic.status !== 'ok' || xai.status !== 'ok' || fireworks.status !== 'ok') throw new Error('setup')
    expect(modelListBaseUrl(xai)).toBe('https://api.x.ai/v1')
    expect(modelListBaseUrl(anthropic)).toBe('https://api.anthropic.com/v1')
    expect(modelListBaseUrl(fireworks)).toBe('https://api.fireworks.ai/inference/v1/')
    expect(modelListBaseUrl(xai, 'https://proxy.example/v1')).toBe('https://proxy.example/v1')
  })

  it('is null for providers without a /models endpoint (Perplexity)', () => {
    const r = resolve('perplexity')
    if (r.status !== 'ok') throw new Error('setup')
    expect(modelListBaseUrl(r)).toBeNull()
  })
})

describe('isLocalUrl', () => {
  it('recognizes loopback hosts only', () => {
    expect(isLocalUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLocalUrl('http://[::1]:8080')).toBe(true)
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false)
    expect(isLocalUrl('not a url')).toBe(false)
  })
})

describe('buildProviderRegistry', () => {
  const registry = buildProviderRegistry(catalog)
  const ids = registry.map((e) => e.id)

  it('lists popular providers first in the fixed order, Ollama right after them', () => {
    expect(ids.slice(0, 8)).toEqual(['anthropic', 'openai', 'google', 'xai', 'mistral', 'deepseek', 'openrouter', 'ollama'])
  })

  it('then lists the rest alphabetically and puts the custom endpoint last', () => {
    const rest = registry.slice(8, -1).map((e) => e.name)
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })))
    expect(ids.at(-1)).toBe('custom')
  })

  it('omits excluded providers', () => {
    for (const id of ['venice', 'cloudflare-workers-ai', 'azure', 'github-copilot', 'broken']) {
      expect(ids).not.toContain(id)
    }
  })

  it('includes runnable openai-compatible and local providers', () => {
    expect(ids).toContain('fireworks-ai')
    expect(ids).toContain('some-unbundled')
    expect(registry.find((e) => e.id === 'lmstudio')).toMatchObject({ isLocal: true, keyRequired: false })
  })

  it('fills name, doc link and model count from the catalog', () => {
    const anthropic = registry.find((e) => e.id === 'anthropic')!
    expect(anthropic.name).toBe('Anthropic')
    expect(anthropic.doc).toContain('anthropic.com')
    expect(anthropic.modelCount).toBe(3)
    expect(anthropic.keyPrefix).toBe('sk-ant-')
  })

  it('always includes Anthropic, OpenAI and Google, even from an empty catalog', () => {
    const empty = buildProviderRegistry({})
    expect(empty.map((e) => e.id)).toEqual(['anthropic', 'openai', 'google', 'ollama', 'custom'])
  })
})

describe('detectProviderByKeyPrefix', () => {
  const registry = buildProviderRegistry(catalog)

  it('detects providers with distinctive prefixes', () => {
    expect(detectProviderByKeyPrefix('sk-ant-api03-abc', registry)).toBe('anthropic')
    expect(detectProviderByKeyPrefix('xai-abc123', registry)).toBe('xai')
    expect(detectProviderByKeyPrefix('gsk_abc123', registry)).toBe(null) // groq not in the fixture
    expect(detectProviderByKeyPrefix('sk-or-v1-abc', registry)).toBe('openrouter')
    expect(detectProviderByKeyPrefix('AIzaSyabc', registry)).toBe('google')
    expect(detectProviderByKeyPrefix('sk-proj-abc', registry)).toBe('openai')
  })

  it('prefers the longest matching prefix (sk-or- over a bare sk-)', () => {
    const custom = [
      { id: 'a', keyPrefix: 'sk-' },
      { id: 'b', keyPrefix: 'sk-or-' },
    ]
    expect(detectProviderByKeyPrefix('sk-or-1', custom)).toBe('b')
    expect(detectProviderByKeyPrefix('sk-1', custom)).toBe('a')
  })

  it('returns null for ambiguous or unknown prefixes so the user picks', () => {
    expect(detectProviderByKeyPrefix('sk-0123456789abcdef', registry)).toBeNull()
    expect(detectProviderByKeyPrefix('0123456789abcdef', registry)).toBeNull()
    expect(detectProviderByKeyPrefix('   ', registry)).toBeNull()
  })
})
