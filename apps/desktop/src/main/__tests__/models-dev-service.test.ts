import { describe, expect, it, vi } from 'vitest'
import {
  MODELS_DEV_TTL_MS,
  MODELS_DEV_URL,
  ModelsDevService,
  type ModelsDevFetch,
  type ModelsDevFileStore,
} from '../models-dev-service'
import { smallCatalog, smallRawCatalog } from './fixtures'

function memoryFiles(initial: Record<string, string> = {}): ModelsDevFileStore & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    read: (path) => data[path] ?? null,
    write: (path, text) => {
      data[path] = text
    },
  }
}

function okFetch(raw: unknown): ModelsDevFetch {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(raw)) })
}

const CACHE = '/userData/models-dev-cache.json'

function make(opts: {
  files?: ReturnType<typeof memoryFiles>
  fetch?: ModelsDevFetch
  enabled?: boolean
  now?: () => number
}) {
  const files = opts.files ?? memoryFiles()
  const fetch = opts.fetch ?? okFetch(smallRawCatalog('net'))
  const state = { enabled: opts.enabled ?? true }
  const service = new ModelsDevService({
    cachePath: CACHE,
    bundled: () => smallCatalog('bundled'),
    fetch,
    files,
    isFetchEnabled: () => state.enabled,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { service, files, fetch, state }
}

describe('ModelsDevService', () => {
  it('starts from the bundled snapshot with no network and no cache (first run / offline)', () => {
    const { service, fetch } = make({})
    expect(service.status()).toMatchObject({ source: 'bundled', fetchedAt: null, networkEnabled: true })
    expect(service.getCatalog().anthropic?.models['claude-sonnet-5']?.name).toContain('bundled')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('starts from a valid disk cache instead of the snapshot', () => {
    const files = memoryFiles({
      [CACHE]: JSON.stringify({ version: 1, fetchedAt: 1_000, catalog: smallRawCatalog('cached') }),
    })
    const { service } = make({ files, now: () => 2_000 })
    expect(service.status()).toMatchObject({ source: 'cache', fetchedAt: 1_000 })
    expect(service.getCatalog().anthropic?.models['claude-sonnet-5']?.name).toContain('cached')
  })

  it('ignores a corrupt, wrong-version or implausibly small cache file', () => {
    for (const content of ['{not json', JSON.stringify({ version: 99, fetchedAt: 1, catalog: smallRawCatalog() }), JSON.stringify({ version: 1, fetchedAt: 1, catalog: { x: 1 } })]) {
      const { service } = make({ files: memoryFiles({ [CACHE]: content }) })
      expect(service.status().source).toBe('bundled')
    }
  })

  describe('freshness (24h)', () => {
    it('does not download while the cache is fresh', async () => {
      let now = 10 * MODELS_DEV_TTL_MS
      const files = memoryFiles({
        [CACHE]: JSON.stringify({ version: 1, fetchedAt: now - (MODELS_DEV_TTL_MS - 1000), catalog: smallRawCatalog('cached') }),
      })
      const { service, fetch } = make({ files, now: () => now })
      expect(service.isStale()).toBe(false)
      expect(await service.refreshIfStale()).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
      now += 2000
      expect(service.isStale()).toBe(true)
    })

    it('downloads when the cache is 24h old, then is fresh again', async () => {
      let now = 10 * MODELS_DEV_TTL_MS
      const files = memoryFiles({
        [CACHE]: JSON.stringify({ version: 1, fetchedAt: now - MODELS_DEV_TTL_MS, catalog: smallRawCatalog('cached') }),
      })
      const { service, fetch } = make({ files, now: () => now })
      const result = await service.refreshIfStale()
      expect(result?.ok).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(service.status()).toMatchObject({ source: 'network', fetchedAt: now })
      expect(service.getCatalog().anthropic?.models['claude-sonnet-5']?.name).toContain('net')
      expect(await service.refreshIfStale()).toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('downloads on first run (no cache at all)', async () => {
      const { service, fetch } = make({})
      expect(service.isStale()).toBe(true)
      await service.refreshIfStale()
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('the opt-out', () => {
    it('never touches the network when disabled, on startup or on demand', async () => {
      const { service, fetch } = make({ enabled: false })
      expect(await service.refreshIfStale()).toBeNull()
      const result = await service.refresh()
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/turned off/)
      expect(result.status).toMatchObject({ source: 'bundled', networkEnabled: false })
      expect(fetch).not.toHaveBeenCalled()
    })

    it('is read at call time, so toggling it back on works without a restart', async () => {
      const { service, fetch, state } = make({ enabled: false })
      await service.refresh()
      state.enabled = true
      expect((await service.refresh()).ok).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('the request', () => {
    it('is a bare GET to models.dev/api.json: only an Accept header, no query, body or identifiers', async () => {
      const { service, fetch } = make({})
      await service.refresh()
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>]
      expect(url).toBe(MODELS_DEV_URL)
      expect(url).not.toContain('?')
      expect(Object.keys(init).sort()).toEqual(['headers', 'signal'])
      expect(init.headers).toEqual({ accept: 'application/json' })
    })

    it('shares one in-flight download between concurrent callers', async () => {
      const { service, fetch } = make({})
      await Promise.all([service.refresh(), service.refresh(), service.refresh()])
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('persistence', () => {
    it('writes the downloaded catalog to disk and a new instance picks it up', async () => {
      const files = memoryFiles()
      const { service } = make({ files, now: () => 5_000 })
      await service.refresh()
      expect(JSON.parse(files.data[CACHE]!)).toMatchObject({ version: 1, fetchedAt: 5_000 })
      const reloaded = make({ files, now: () => 6_000 })
      expect(reloaded.service.status()).toMatchObject({ source: 'cache', fetchedAt: 5_000 })
    })

    it('stores only runnable providers and chat models (not the 5 MB original)', async () => {
      const raw = {
        ...smallRawCatalog('net'),
        azure: { id: 'azure', name: 'Azure', env: [], npm: '@ai-sdk/azure', models: { a: { id: 'a', name: 'a', modalities: { input: ['text'], output: ['text'] } } } },
      }
      const files = memoryFiles()
      const { service } = make({ files, fetch: okFetch(raw) })
      await service.refresh()
      const stored = JSON.parse(files.data[CACHE]!) as { catalog: Record<string, { models: Record<string, unknown> }> }
      expect(stored.catalog.azure).toBeUndefined()
      expect(stored.catalog.openai?.models['text-embedding-3-small']).toBeUndefined()
      expect(stored.catalog.openai?.models['gpt-5.6']).toBeDefined()
    })

    it('survives a failing cache write', async () => {
      const files = memoryFiles()
      files.write = () => {
        throw new Error('disk full')
      }
      const { service } = make({ files })
      expect((await service.refresh()).ok).toBe(true)
      expect(service.status().source).toBe('network')
    })
  })

  describe('failure handling', () => {
    it('keeps the previous catalog and reports the error on HTTP failure', async () => {
      const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('') })
      const { service } = make({ fetch })
      const result = await service.refresh()
      expect(result.ok).toBe(false)
      expect(result.message).toContain('503')
      expect(service.status().source).toBe('bundled')
    })

    it('keeps the previous catalog on a network error or invalid JSON', async () => {
      for (const fetch of [
        vi.fn().mockRejectedValue(new Error('ENOTFOUND models.dev')),
        vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('<html>captive portal</html>') }),
      ]) {
        const { service, files } = make({ fetch })
        const result = await service.refresh()
        expect(result.ok).toBe(false)
        expect(service.status().source).toBe('bundled')
        expect(files.data[CACHE]).toBeUndefined()
      }
    })

    it('rejects an implausibly small catalog instead of overwriting a good one', async () => {
      const { service, files } = make({ fetch: okFetch({ only: smallRawCatalog().anthropic }) })
      const result = await service.refresh()
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/small/)
      expect(files.data[CACHE]).toBeUndefined()
      expect(service.getCatalog().openai).toBeDefined()
    })

    it('a failed refresh after a good one leaves the good catalog in place', async () => {
      let call = 0
      const fetch = vi.fn().mockImplementation(() => {
        call += 1
        return call === 1
          ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(smallRawCatalog('first'))) })
          : Promise.reject(new Error('offline'))
      })
      const { service } = make({ fetch })
      await service.refresh()
      expect((await service.refresh()).ok).toBe(false)
      expect(service.getCatalog().anthropic?.models['claude-sonnet-5']?.name).toContain('first')
      expect(service.status().source).toBe('network')
    })
  })

  it('notifies listeners when a refresh replaces the catalog', async () => {
    const { service } = make({})
    const listener = vi.fn()
    service.onChange(listener)
    await service.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
