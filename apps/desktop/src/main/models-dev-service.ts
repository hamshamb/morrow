import {
  countChatModels,
  parseModelsDevCatalog,
  resolveProviderRuntime,
  trimModelsDevCatalog,
  type ModelsDevCatalog,
} from '@ai-workspace/providers'
import type { ModelsMetadataStatus, RefreshModelsMetadataResult } from '@ai-workspace/shared'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000
const CACHE_VERSION = 1
/** A catalog with fewer providers than this is a bad download, not a catalog. */
const MIN_PROVIDERS = 5

export interface ModelsDevFetchResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
}
export type ModelsDevFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<ModelsDevFetchResponse>

export interface ModelsDevFileStore {
  /** null when the file does not exist or cannot be read. */
  read(path: string): string | null
  write(path: string, data: string): void
}

export interface ModelsDevServiceDeps {
  /** Where the downloaded catalog is cached (under Electron's userData). */
  cachePath: string
  /** Bundled trimmed snapshot: the offline / first-run floor. */
  bundled: () => ModelsDevCatalog
  fetch: ModelsDevFetch
  files: ModelsDevFileStore
  /** Reads the `modelsDevFetchEnabled` setting at call time. */
  isFetchEnabled: () => boolean
  now?: () => number
  ttlMs?: number
}

interface CacheFile {
  version: number
  fetchedAt: number
  catalog: unknown
}

/**
 * Owns the models.dev catalog (ADR-021).
 *
 *   bundled snapshot  ->  disk cache (userData)  ->  network refresh
 *
 * Startup loads the disk cache if there is one, else the bundled snapshot —
 * never the network — so the app is fully usable offline and on first run.
 * `refreshIfStale` downloads https://models.dev/api.json at most once per 24h
 * and only when the user has not disabled it; `refresh` is the on-demand path.
 * The request is a bare GET: no query string, cookies, identifiers or user
 * data. Electron-free (paths, fs and fetch are injected) so it is unit tested.
 */
export class ModelsDevService {
  private catalog: ModelsDevCatalog
  private source: ModelsMetadataStatus['source'] = 'bundled'
  private fetchedAt: number | null = null
  private inflight: Promise<RefreshModelsMetadataResult> | null = null
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: ModelsDevServiceDeps) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? MODELS_DEV_TTL_MS
    this.catalog = this.loadFromDisk() ?? deps.bundled()
  }

  getCatalog(): ModelsDevCatalog {
    return this.catalog
  }

  /** Called after a refresh replaced the catalog. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  status(): ModelsMetadataStatus {
    return {
      source: this.source,
      fetchedAt: this.fetchedAt,
      networkEnabled: this.deps.isFetchEnabled(),
      providerCount: Object.keys(this.catalog).length,
      modelCount: countChatModels(this.catalog),
    }
  }

  isStale(): boolean {
    return this.fetchedAt === null || this.now() - this.fetchedAt >= this.ttlMs
  }

  /** Background refresh used at startup: respects the opt-out and the 24h TTL. Never throws. */
  async refreshIfStale(): Promise<RefreshModelsMetadataResult | null> {
    if (!this.deps.isFetchEnabled() || !this.isStale()) return null
    return this.refresh()
  }

  /** Downloads the catalog now. Resolves (never rejects) with `ok: false` on any failure. */
  refresh(): Promise<RefreshModelsMetadataResult> {
    if (!this.deps.isFetchEnabled()) {
      return Promise.resolve({
        ok: false,
        message: 'Downloading the model catalog is turned off in Settings; using the built-in snapshot.',
        status: this.status(),
      })
    }
    this.inflight ??= this.download().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async download(): Promise<RefreshModelsMetadataResult> {
    try {
      const res = await this.deps.fetch(MODELS_DEV_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`models.dev responded HTTP ${res.status}`)
      const parsed = parseModelsDevCatalog(JSON.parse(await res.text()) as unknown)
      // Keep what the app can run (the 5 MB original is mostly providers and
      // image/video models we never show) — uncapped, unlike the snapshot.
      const catalog = trimModelsDevCatalog(parsed, {
        keepProvider: (provider) => resolveProviderRuntime(provider.id, provider).status === 'ok',
      })
      if (Object.keys(catalog).length < MIN_PROVIDERS) {
        throw new Error('models.dev returned an unexpectedly small catalog; keeping the previous one')
      }
      const fetchedAt = this.now()
      this.catalog = catalog
      this.source = 'network'
      this.fetchedAt = fetchedAt
      this.persist(catalog, fetchedAt)
      for (const listener of this.listeners) listener()
      return { ok: true, status: this.status() }
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        status: this.status(),
      }
    }
  }

  private persist(catalog: ModelsDevCatalog, fetchedAt: number): void {
    try {
      const file: CacheFile = { version: CACHE_VERSION, fetchedAt, catalog }
      this.deps.files.write(this.deps.cachePath, JSON.stringify(file))
    } catch {
      // A cache-write failure must never break the in-memory catalog.
    }
  }

  private loadFromDisk(): ModelsDevCatalog | null {
    try {
      const text = this.deps.files.read(this.deps.cachePath)
      if (!text) return null
      const file = JSON.parse(text) as Partial<CacheFile>
      if (file.version !== CACHE_VERSION || typeof file.fetchedAt !== 'number') return null
      const catalog = parseModelsDevCatalog(file.catalog)
      if (Object.keys(catalog).length < MIN_PROVIDERS) return null
      this.source = 'cache'
      this.fetchedAt = file.fetchedAt
      return catalog
    } catch {
      return null
    }
  }
}
