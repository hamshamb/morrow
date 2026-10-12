import {
  buildProviderRegistry,
  createProvider,
  joinCatalog,
  lookupModelMetadata,
  pickProbeModel,
  resolveProviderRuntime,
  type ChatProvider,
  type ProviderRuntime,
} from '@ai-workspace/providers'
import {
  OLLAMA_PROVIDER_ID,
  type LocalProviderStatus,
  type ModelMetadata,
  type ProviderModelCatalog,
  type ProviderRegistryEntry,
  type RefreshModelCatalogResult,
  type TestProviderConfigResult,
} from '@ai-workspace/shared'
import type { ModelCatalogRepository, ProviderConfigRepository } from '@ai-workspace/storage'
import type { ModelsDevService } from './models-dev-service'
import {
  detectOllama,
  detectOpenAiCompatible,
  fetchLiveModels,
  type FetchLike,
} from './model-catalog-fetcher'

export interface ProviderCatalogDeps {
  models: ModelsDevService
  configs: ProviderConfigRepository
  catalogs: ModelCatalogRepository
  /** Decrypts a stored key (Electron safeStorage in production). */
  decrypt: (encrypted: Buffer) => string
  fetch?: FetchLike
  /** Test seam for the SDK's own network calls (connection test). */
  sdkFetch?: typeof fetch
}

export class ProviderNotAvailableError extends Error {}

/**
 * Everything the main process knows about providers and their models, in one
 * Electron-free class: the registry (from the models.dev catalog), how to run
 * a provider, the joined model catalog, live refresh and the connection test.
 * IPC handlers are thin wrappers (ipc/*.ts).
 */
export class ProviderCatalogService {
  private readonly fetchImpl: FetchLike

  constructor(private readonly deps: ProviderCatalogDeps) {
    this.fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike)
  }

  registry(): ProviderRegistryEntry[] {
    return buildProviderRegistry(this.deps.models.getCatalog())
  }

  /** How to run `providerId`; throws `ProviderNotAvailableError` for excluded ones. */
  runtime(providerId: string): ProviderRuntime {
    const resolution = resolveProviderRuntime(providerId, this.deps.models.getCatalog()[providerId])
    if (resolution.status !== 'ok') {
      throw new ProviderNotAvailableError(`Provider "${providerId}" is not available: ${resolution.reason}.`)
    }
    return resolution
  }

  modelMeta(providerId: string, modelId: string): ModelMetadata | null {
    const runtime = this.runtime(providerId)
    return lookupModelMetadata(this.deps.models.getCatalog()[providerId], modelId, runtime.factoryKey)
  }

  /** The config's model list: live ids joined with models.dev metadata, or models.dev's own list. */
  listCatalog(providerConfigId: string): ProviderModelCatalog {
    const credential = this.deps.configs.getCredential(providerConfigId)
    if (!credential) throw new Error(`Provider config not found: ${providerConfigId}`)
    const stored = this.deps.catalogs.listForProviderConfig(providerConfigId)
    let runtime: ProviderRuntime
    try {
      runtime = this.runtime(credential.provider)
    } catch {
      // The provider left the catalog after this key was saved: show what we
      // cached rather than failing the whole picker.
      return { providerConfigId, models: stored.models, fetchedAt: stored.fetchedAt, source: stored.models.length > 0 ? 'live' : 'empty' }
    }
    const joined = joinCatalog({
      provider: this.deps.models.getCatalog()[credential.provider],
      factoryKey: runtime.factoryKey,
      live: stored.models,
    })
    return {
      providerConfigId,
      models: joined.models,
      fetchedAt: stored.fetchedAt,
      source: joined.source,
    }
  }

  /**
   * Runtime for a *saved* key. Its base URL is only ever the one pinned on
   * the config when the key was saved (null = the SDK's built-in default) —
   * never models.dev's current `api` value. models.dev is downloaded at
   * runtime, so letting a later refresh change where an existing key is sent
   * would let a bad catalog entry redirect the user's key to another host.
   */
  private savedRuntime(credential: { provider: string; baseUrl: string | null }): ProviderRuntime {
    return { ...this.runtime(credential.provider), baseUrl: credential.baseUrl }
  }

  /** Calls the provider's own list endpoint, caches the ids, returns the joined catalog. */
  async refreshCatalog(providerConfigId: string): Promise<RefreshModelCatalogResult> {
    const credential = this.deps.configs.getCredential(providerConfigId)
    if (!credential) throw new Error(`Provider config not found: ${providerConfigId}`)
    const runtime = this.savedRuntime(credential)
    const apiKey = credential.encryptedKey.length > 0 ? this.deps.decrypt(credential.encryptedKey) : ''

    const result = await fetchLiveModels(
      { providerId: credential.provider, runtime, apiKey, baseUrl: credential.baseUrl },
      this.fetchImpl,
    )
    if (!result.ok) {
      // Not fatal: the picker keeps working from models.dev / the last live list.
      return { ok: false, message: result.message, catalog: this.listCatalog(providerConfigId) }
    }
    this.deps.catalogs.replaceForProviderConfig(
      providerConfigId,
      result.models.map((m) => ({ id: m.id, displayName: m.displayName })),
      Date.now(),
    )
    return { ok: true, catalog: this.listCatalog(providerConfigId) }
  }

  /** Builds the `ChatProvider` for a stored config plus a metadata lookup for its models. */
  resolveChatProvider(providerConfigId: string): {
    provider: string
    chatProvider: ChatProvider
    getModelMeta: (modelId: string) => ModelMetadata | null
  } {
    const credential = this.deps.configs.getCredential(providerConfigId)
    if (!credential) throw new Error(`Provider config not found: ${providerConfigId}`)
    const runtime = this.savedRuntime(credential)
    const apiKey = credential.encryptedKey.length > 0 ? this.deps.decrypt(credential.encryptedKey) : ''
    return {
      provider: credential.provider,
      chatProvider: createProvider(credential.provider, { apiKey, baseUrl: credential.baseUrl }, runtime),
      getModelMeta: (modelId) =>
        lookupModelMetadata(this.deps.models.getCatalog()[credential.provider], modelId, runtime.factoryKey),
    }
  }

  /**
   * Verifies a key/base URL. Cloud providers get a one-token chat request to a
   * cheap text model chosen from models.dev (`pickProbeModel` — no hardcoded
   * ids); providers with no priced model, and local/custom endpoints, are
   * verified by listing their models instead.
   */
  async testConnection(input: {
    provider: string
    apiKey: string
    baseUrl?: string | null | undefined
  }): Promise<TestProviderConfigResult> {
    let runtime: ProviderRuntime
    try {
      runtime = this.runtime(input.provider)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    if (runtime.keyRequired && input.apiKey.trim().length === 0) {
      return { ok: false, message: 'An API key is required for this provider.' }
    }
    if (input.provider === 'custom' && !input.baseUrl) {
      return { ok: false, message: 'A base URL is required for a custom endpoint.' }
    }

    const probe = runtime.isLocal || runtime.kind === 'custom' ? null : pickProbeModel(this.deps.models.getCatalog()[input.provider])
    if (!probe) return this.testByListing(input, runtime)

    const controller = new AbortController()
    try {
      const chatProvider = createProvider(
        input.provider,
        { apiKey: input.apiKey, baseUrl: input.baseUrl ?? null },
        runtime,
        this.deps.sdkFetch ? { fetch: this.deps.sdkFetch } : undefined,
      )
      for await (const event of chatProvider.streamChat({
        model: probe,
        messages: [{ role: 'user', content: 'ping' }],
        signal: controller.signal,
      })) {
        if (event.type === 'error') return { ok: false, message: event.error }
        if (event.type === 'text-delta' || event.type === 'done') {
          controller.abort()
          return { ok: true }
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  private async testByListing(
    input: { provider: string; apiKey: string; baseUrl?: string | null | undefined },
    runtime: ProviderRuntime,
  ): Promise<TestProviderConfigResult> {
    const result = await fetchLiveModels(
      { providerId: input.provider, runtime, apiKey: input.apiKey, baseUrl: input.baseUrl ?? null },
      this.fetchImpl,
    )
    if (!result.ok) return { ok: false, message: result.message }
    return { ok: true, message: `${result.models.length} model${result.models.length === 1 ? '' : 's'} available` }
  }

  /** Probes localhost for Ollama and any other local registry provider. Never throws. */
  async detectLocal(): Promise<LocalProviderStatus[]> {
    const probes: Promise<LocalProviderStatus>[] = []
    for (const entry of this.registry()) {
      if (!entry.isLocal || !entry.defaultBaseUrl) continue
      probes.push(
        entry.id === OLLAMA_PROVIDER_ID
          ? detectOllama(entry.defaultBaseUrl, this.fetchImpl)
          : detectOpenAiCompatible(entry.id, entry.defaultBaseUrl, this.fetchImpl),
      )
    }
    return Promise.all(probes)
  }
}
