/**
 * Data-driven provider registry.
 *
 * Providers come from the models.dev catalog (keyed by its provider id). How a
 * provider is run is decided by one rule (ADR-022), adapted from OpenCode's
 * provider loader (MIT, Copyright (c) 2025 opencode —
 * packages/opencode/src/provider/provider.ts: BUNDLED_PROVIDERS and the
 * `@ai-sdk/openai-compatible` + `api` base-URL route):
 *
 *   1. models.dev `npm` names an SDK package we ship  -> that factory;
 *   2. otherwise, if models.dev gives a plain `api` URL -> OpenAI-compatible;
 *   3. otherwise                                         -> excluded.
 *
 * Deliberately NOT supported (non-API-key auth or extra required settings):
 * Azure OpenAI, Amazon Bedrock, Google Vertex, SAP AI Core, watsonx, GitLab,
 * GitHub Copilot (OAuth), Cloudflare Workers AI / AI Gateway, Vercel AI
 * Gateway, Snowflake, Databricks. The Vercel AI Gateway is never required —
 * every route here talks to the provider directly with the user's own key.
 */
import {
  CUSTOM_PROVIDER_ID,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_PROVIDER_ID,
  type ProviderKind,
  type ProviderRegistryEntry,
} from '@ai-workspace/shared'
import { isSelectableModel, type ModelsDevCatalog, type ModelsDevProvider } from './models-dev'

/** AI SDK packages bundled in the app (all Apache-2.0). */
export const BUNDLED_FACTORY_KEYS = [
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@ai-sdk/xai',
  '@ai-sdk/mistral',
  '@ai-sdk/groq',
  '@ai-sdk/deepseek',
  '@ai-sdk/cerebras',
  '@ai-sdk/togetherai',
  '@ai-sdk/perplexity',
  '@openrouter/ai-sdk-provider',
  '@ai-sdk/openai-compatible',
] as const
export type FactoryKey = (typeof BUNDLED_FACTORY_KEYS)[number]

const BUNDLED_SET: ReadonlySet<string> = new Set(BUNDLED_FACTORY_KEYS)
export function isBundledFactoryKey(npm: string | undefined): npm is FactoryKey {
  return npm !== undefined && BUNDLED_SET.has(npm)
}

/**
 * models.dev lists DeepSeek under `@ai-sdk/openai-compatible`; we ship the
 * dedicated `@ai-sdk/deepseek` package (it round-trips `reasoning_content` and
 * has typed thinking/effort options), so DeepSeek is routed to it by provider id.
 */
export const PROVIDER_FACTORY_OVERRIDES: Readonly<Record<string, FactoryKey>> = {
  deepseek: '@ai-sdk/deepseek',
}

/** Providers excluded even though models.dev gives them an `api` URL. */
const EXCLUDED_PROVIDERS: Readonly<Record<string, string>> = {
  'github-copilot': 'GitHub Copilot signs in with an OAuth device flow, not an API key',
  'google-vertex': 'Google Vertex uses Google Cloud credentials',
  'google-vertex-anthropic': 'Google Vertex uses Google Cloud credentials',
  'amazon-bedrock': 'Amazon Bedrock uses AWS credentials',
  azure: 'Azure OpenAI needs a resource name and Azure credentials',
  'azure-cognitive-services': 'Azure needs a resource name and Azure credentials',
}

/**
 * Base URLs the provider SDKs use when none is configured. Needed because the
 * live model-list call (`GET <base>/models`) is made outside the SDK.
 * Verified against the installed SDK sources (`*-provider.ts` defaults).
 */
export const SDK_DEFAULT_BASE_URLS: Readonly<Partial<Record<FactoryKey, string>>> = {
  '@ai-sdk/anthropic': 'https://api.anthropic.com/v1',
  '@ai-sdk/openai': 'https://api.openai.com/v1',
  '@ai-sdk/google': 'https://generativelanguage.googleapis.com/v1beta',
  '@ai-sdk/xai': 'https://api.x.ai/v1',
  '@ai-sdk/mistral': 'https://api.mistral.ai/v1',
  '@ai-sdk/groq': 'https://api.groq.com/openai/v1',
  '@ai-sdk/deepseek': 'https://api.deepseek.com',
  '@ai-sdk/cerebras': 'https://api.cerebras.ai/v1',
  '@ai-sdk/togetherai': 'https://api.together.xyz/v1',
  '@ai-sdk/perplexity': 'https://api.perplexity.ai',
  '@openrouter/ai-sdk-provider': 'https://openrouter.ai/api/v1',
}

/** Factories whose provider has no `GET /models` endpoint. */
const NO_LIST_ENDPOINT: ReadonlySet<FactoryKey> = new Set(['@ai-sdk/perplexity'])

/**
 * Distinctive key prefixes, used only to pre-select a provider in onboarding;
 * every key is still validated by a real connection test before it is saved.
 * Anthropic/OpenAI/Google are documented widely; xAI/Groq/OpenRouter/
 * Perplexity/Cerebras prefixes were confirmed from provider-key guides (the
 * vendors' own docs show only placeholders). Providers whose keys have no
 * reliable prefix (Mistral, DeepSeek `sk-…`, Together) are intentionally
 * absent — onboarding asks the user to pick instead. A wrong guess is
 * harmless: the connection test fails and the user can choose another.
 */
export const KEY_PREFIXES: Readonly<Record<string, string>> = {
  anthropic: 'sk-ant-',
  openrouter: 'sk-or-',
  google: 'AIza',
  xai: 'xai-',
  groq: 'gsk_',
  perplexity: 'pplx-',
  cerebras: 'csk-',
  // Bare `sk-` is shared with DeepSeek (and older OpenAI keys), so only the
  // project-key form is treated as distinctive.
  openai: 'sk-proj-',
}

/** Shown first, in this order. */
export const POPULAR_PROVIDER_ORDER = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'mistral',
  'groq',
  'deepseek',
  'openrouter',
  OLLAMA_PROVIDER_ID,
] as const

/** Minimal runtime for the three launch providers when the catalog lacks them. */
const BUILT_IN: Readonly<Record<string, { name: string; factoryKey: FactoryKey }>> = {
  anthropic: { name: 'Anthropic', factoryKey: '@ai-sdk/anthropic' },
  openai: { name: 'OpenAI', factoryKey: '@ai-sdk/openai' },
  google: { name: 'Google', factoryKey: '@ai-sdk/google' },
}

export interface ProviderRuntime {
  providerId: string
  factoryKey: FactoryKey
  kind: ProviderKind
  /** Base URL to pass the SDK (null = the SDK's own default). */
  baseUrl: string | null
  keyRequired: boolean
  isLocal: boolean
  /** Whether `GET <base>/models` exists for the live list. */
  hasListEndpoint: boolean
}

export type ProviderResolution =
  | ({ status: 'ok' } & ProviderRuntime)
  | { status: 'excluded'; providerId: string; reason: string }

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/**
 * Decides how to run one provider. `provider` is its models.dev entry (absent
 * for the synthetic `ollama` / `custom` ids and for the built-in fallbacks).
 */
export function resolveProviderRuntime(providerId: string, provider?: ModelsDevProvider): ProviderResolution {
  if (providerId === OLLAMA_PROVIDER_ID) {
    return {
      status: 'ok',
      providerId,
      factoryKey: '@ai-sdk/openai-compatible',
      kind: 'local',
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      keyRequired: false,
      isLocal: true,
      hasListEndpoint: true,
    }
  }
  if (providerId === CUSTOM_PROVIDER_ID) {
    return {
      status: 'ok',
      providerId,
      factoryKey: '@ai-sdk/openai-compatible',
      kind: 'custom',
      baseUrl: null,
      keyRequired: false,
      isLocal: false,
      hasListEndpoint: true,
    }
  }

  const excludedReason = EXCLUDED_PROVIDERS[providerId]
  if (excludedReason) return { status: 'excluded', providerId, reason: excludedReason }

  const api = provider?.api
  if (api && api.includes('${')) {
    return { status: 'excluded', providerId, reason: 'its endpoint needs extra account settings (templated URL)' }
  }

  const override = PROVIDER_FACTORY_OVERRIDES[providerId]
  if (override) {
    return {
      status: 'ok',
      providerId,
      factoryKey: override,
      kind: 'bundled',
      baseUrl: api ?? null,
      keyRequired: true,
      isLocal: false,
      hasListEndpoint: !NO_LIST_ENDPOINT.has(override),
    }
  }

  const builtIn = BUILT_IN[providerId]
  const npm = provider?.npm
  if (isBundledFactoryKey(npm) && npm !== '@ai-sdk/openai-compatible') {
    return {
      status: 'ok',
      providerId,
      factoryKey: npm,
      kind: 'bundled',
      baseUrl: api ?? null,
      keyRequired: true,
      isLocal: false,
      hasListEndpoint: !NO_LIST_ENDPOINT.has(npm),
    }
  }
  if (builtIn && !provider) {
    return {
      status: 'ok',
      providerId,
      factoryKey: builtIn.factoryKey,
      kind: 'bundled',
      baseUrl: null,
      keyRequired: true,
      isLocal: false,
      hasListEndpoint: true,
    }
  }
  if (!provider) return { status: 'excluded', providerId, reason: 'unknown provider' }

  if (api) {
    const isLocal = isLocalUrl(api)
    return {
      status: 'ok',
      providerId,
      factoryKey: '@ai-sdk/openai-compatible',
      kind: isLocal ? 'local' : 'openai-compatible',
      baseUrl: api,
      keyRequired: !isLocal && provider.env.length > 0,
      isLocal,
      hasListEndpoint: true,
    }
  }
  return {
    status: 'excluded',
    providerId,
    reason: npm ? `needs the unbundled SDK ${npm} and has no plain API URL` : 'no SDK package or API URL',
  }
}

/** The URL `GET <base>/models` should be called on, or null if there is none. */
export function modelListBaseUrl(runtime: ProviderRuntime, override?: string | null): string | null {
  if (!runtime.hasListEndpoint) return null
  return override ?? runtime.baseUrl ?? SDK_DEFAULT_BASE_URLS[runtime.factoryKey] ?? null
}

function chatModelCount(provider: ModelsDevProvider | undefined): number {
  if (!provider) return 0
  let n = 0
  for (const model of Object.values(provider.models)) if (isSelectableModel(model)) n++
  return n
}

/**
 * All providers the app can run, from the current catalog plus Ollama and the
 * custom endpoint. Popular providers first (fixed order), then the rest
 * alphabetically, custom endpoint last. Anthropic/OpenAI/Google are present
 * even if a catalog is missing them.
 */
export function buildProviderRegistry(catalog: ModelsDevCatalog): ProviderRegistryEntry[] {
  const entries: ProviderRegistryEntry[] = []
  const ids = new Set<string>([...Object.keys(catalog), ...Object.keys(BUILT_IN)])
  for (const id of ids) {
    const provider = catalog[id]
    const resolution = resolveProviderRuntime(id, provider)
    if (resolution.status !== 'ok') continue
    const rank = POPULAR_PROVIDER_ORDER.indexOf(id as (typeof POPULAR_PROVIDER_ORDER)[number])
    entries.push({
      id,
      name: provider?.name ?? BUILT_IN[id]?.name ?? id,
      kind: resolution.kind,
      doc: provider?.doc ?? null,
      keyRequired: resolution.keyRequired,
      isLocal: resolution.isLocal,
      defaultBaseUrl: resolution.baseUrl,
      keyPrefix: KEY_PREFIXES[id] ?? null,
      popularRank: rank >= 0 ? rank : null,
      modelCount: chatModelCount(provider),
    })
  }
  entries.push({
    id: OLLAMA_PROVIDER_ID,
    name: 'Ollama',
    kind: 'local',
    doc: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    keyRequired: false,
    isLocal: true,
    defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL,
    keyPrefix: null,
    popularRank: POPULAR_PROVIDER_ORDER.indexOf(OLLAMA_PROVIDER_ID),
    modelCount: 0,
  })
  entries.sort((a, b) => {
    if (a.popularRank !== null && b.popularRank !== null) return a.popularRank - b.popularRank
    if (a.popularRank !== null) return -1
    if (b.popularRank !== null) return 1
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
  })
  entries.push({
    id: CUSTOM_PROVIDER_ID,
    name: 'Custom OpenAI-compatible endpoint',
    kind: 'custom',
    doc: null,
    keyRequired: false,
    isLocal: false,
    defaultBaseUrl: null,
    keyPrefix: null,
    popularRank: null,
    modelCount: 0,
  })
  return entries
}

/**
 * Detects the provider a pasted key belongs to from its prefix. Longer
 * prefixes win (`sk-ant-` / `sk-or-` before OpenAI's `sk-`). Returns null when
 * the prefix is unknown or shared, so the caller asks the user to choose.
 */
export function detectProviderByKeyPrefix(
  rawKey: string,
  registry: readonly Pick<ProviderRegistryEntry, 'id' | 'keyPrefix'>[],
): string | null {
  const key = rawKey.trim()
  if (!key) return null
  let best: { id: string; length: number } | null = null
  for (const entry of registry) {
    const prefix = entry.keyPrefix
    if (!prefix || !key.startsWith(prefix)) continue
    if (!best || prefix.length > best.length) best = { id: entry.id, length: prefix.length }
  }
  return best?.id ?? null
}
