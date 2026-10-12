import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadBundledCatalog } from '../bundled-snapshot'
import { buildProviderRegistry, resolveProviderRuntime } from '../registry'
import { isChatModel, parseModelsDevCatalog } from '../models-dev'

const snapshotPath = fileURLToPath(new URL('../data/models-dev-snapshot.json', import.meta.url))
const catalog = loadBundledCatalog()

describe('bundled models.dev snapshot (offline floor)', () => {
  it('stays well under 1 MB', () => {
    expect(statSync(snapshotPath).size).toBeLessThan(600 * 1024)
  })

  it('contains the launch providers with real models', () => {
    for (const id of ['anthropic', 'openai', 'google', 'xai', 'mistral', 'groq', 'deepseek', 'openrouter']) {
      expect(Object.keys(catalog[id]?.models ?? {}).length, id).toBeGreaterThan(0)
    }
  })

  it('only holds providers the registry can run', () => {
    for (const provider of Object.values(catalog)) {
      expect(resolveProviderRuntime(provider.id, provider).status, provider.id).toBe('ok')
    }
  })

  it('only holds non-deprecated chat models', () => {
    for (const provider of Object.values(catalog)) {
      for (const model of Object.values(provider.models)) {
        expect(isChatModel(model), `${provider.id}/${model.id}`).toBe(true)
        expect(model.status).not.toBe('deprecated')
      }
    }
  })

  it('is stable under re-parsing (already reduced)', () => {
    expect(parseModelsDevCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog)
  })

  it('yields a registry with the popular providers first and Ollama + custom available', () => {
    const ids = buildProviderRegistry(catalog).map((e) => e.id)
    expect(ids.slice(0, 3)).toEqual(['anthropic', 'openai', 'google'])
    expect(ids).toContain('ollama')
    expect(ids.at(-1)).toBe('custom')
    expect(ids.length).toBeGreaterThan(50)
  })
})
