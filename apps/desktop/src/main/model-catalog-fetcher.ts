import {
  modelListBaseUrl,
  type ProviderRuntime,
} from '@ai-workspace/providers'
import type { LocalProviderStatus, ModelCatalogEntry } from '@ai-workspace/shared'

export interface ModelFetchResult {
  ok: boolean
  models: ModelCatalogEntry[]
  message?: string
}

/** Matches the global `fetch` signature closely enough to inject a mock in
 * tests without depending on `node-fetch`/`undici` types directly. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export const LIST_TIMEOUT_MS = 15_000
/** Local-server probes must not make the UI wait: a closed port answers fast,
 * a firewalled one must not hang. */
export const DETECT_TIMEOUT_MS = 1_500

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

async function describeHttpError(res: Awaited<ReturnType<FetchLike>>): Promise<string> {
  try {
    const body = await res.text()
    return `HTTP ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`
  } catch {
    return `HTTP ${res.status}`
  }
}

function failure(err: unknown): ModelFetchResult {
  return { ok: false, models: [], message: err instanceof Error ? err.message : String(err) }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ ok: true; json: unknown } | { ok: false; message: string }> {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, message: await describeHttpError(res) }
    return { ok: true, json: await res.json() }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

interface AnthropicModelsResponse {
  data?: Array<{ id: string; display_name?: string }>
}

/**
 * Anthropic's models-list endpoint. Headers match exactly what
 * `@ai-sdk/anthropic` sends elsewhere in this codebase for the chat request
 * (`x-api-key` + `anthropic-version: 2023-06-01`). `baseUrl` is the SDK-style
 * base including `/v1` (`https://api.anthropic.com/v1`).
 */
export async function fetchAnthropicModels(
  apiKey: string,
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<ModelFetchResult> {
  const result = await getJson(
    `${trimSlash(baseUrl)}/models?limit=1000`,
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    fetchImpl,
    LIST_TIMEOUT_MS,
  )
  if (!result.ok) return { ok: false, models: [], message: result.message }
  const json = result.json as AnthropicModelsResponse
  return {
    ok: true,
    models: (json.data ?? []).map((m) => ({ id: m.id, displayName: m.display_name ?? null })),
  }
}

interface GoogleModelsResponse {
  models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>
}

/**
 * Google's Generative Language `GET /v1beta/models` (header `x-goog-api-key`).
 * Only models that support `generateContent` are chat-capable; the `models/`
 * prefix is stripped so ids match what `@ai-sdk/google` and models.dev use.
 * (Verified against Google's public API shape; not exercised against a live
 * key in this repo's tests.)
 */
export async function fetchGoogleModels(
  apiKey: string,
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<ModelFetchResult> {
  const result = await getJson(
    `${trimSlash(baseUrl)}/models?pageSize=1000`,
    { 'x-goog-api-key': apiKey },
    fetchImpl,
    LIST_TIMEOUT_MS,
  )
  if (!result.ok) return { ok: false, models: [], message: result.message }
  const json = result.json as GoogleModelsResponse
  const models: ModelCatalogEntry[] = []
  for (const m of json.models ?? []) {
    if (m.supportedGenerationMethods && !m.supportedGenerationMethods.includes('generateContent')) continue
    models.push({ id: m.name.replace(/^models\//, ''), displayName: m.displayName ?? null })
  }
  return { ok: true, models }
}

/**
 * `GET <base>/models` as every OpenAI-compatible server offers it (OpenAI,
 * xAI, Mistral, Groq, DeepSeek, Cerebras, OpenRouter, LM Studio, vLLM, custom
 * endpoints, …). Accepts `{ data: [...] }` and the bare-array form Together
 * returns. OpenRouter adds a human `name`, used as the display name.
 */
export async function fetchOpenAiCompatibleModels(
  apiKey: string,
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<ModelFetchResult> {
  const result = await getJson(
    `${trimSlash(baseUrl)}/models`,
    apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    fetchImpl,
    LIST_TIMEOUT_MS,
  )
  if (!result.ok) return { ok: false, models: [], message: result.message }
  const json = result.json as unknown
  const rows: unknown[] = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown })?.data)
      ? ((json as { data: unknown[] }).data)
      : []
  const models: ModelCatalogEntry[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const { id, name } = row as { id?: unknown; name?: unknown }
    if (typeof id !== 'string' || !id) continue
    models.push({ id, displayName: typeof name === 'string' && name ? name : null })
  }
  return { ok: true, models }
}

/** Ollama serves its native API next to the OpenAI-compatible `/v1` prefix. */
export function ollamaRootUrl(baseUrl: string): string {
  return trimSlash(baseUrl).replace(/\/v1$/, '')
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>
}

/** Lists local models from Ollama's `GET /api/tags`. */
export async function fetchOllamaModels(
  baseUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number = LIST_TIMEOUT_MS,
): Promise<ModelFetchResult> {
  const result = await getJson(`${ollamaRootUrl(baseUrl)}/api/tags`, {}, fetchImpl, timeoutMs)
  if (!result.ok) return { ok: false, models: [], message: result.message }
  const json = result.json as OllamaTagsResponse
  const models: ModelCatalogEntry[] = []
  for (const m of json.models ?? []) {
    const id = m.name ?? m.model
    if (id) models.push({ id, displayName: null })
  }
  return { ok: true, models }
}

/** Detects a running Ollama with a short timeout. Never throws. */
export async function detectOllama(baseUrl: string, fetchImpl: FetchLike): Promise<LocalProviderStatus> {
  const result = await fetchOllamaModels(baseUrl, fetchImpl, DETECT_TIMEOUT_MS)
  return { id: 'ollama', baseUrl, running: result.ok, modelCount: result.models.length }
}

/** Detects any other local OpenAI-compatible server (LM Studio, …). Never throws. */
export async function detectOpenAiCompatible(
  id: string,
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<LocalProviderStatus> {
  const result = await getJson(`${trimSlash(baseUrl)}/models`, {}, fetchImpl, DETECT_TIMEOUT_MS)
  if (!result.ok) return { id, baseUrl, running: false, modelCount: 0 }
  const json = result.json as unknown
  const data = Array.isArray(json) ? json : (json as { data?: unknown })?.data
  return { id, baseUrl, running: true, modelCount: Array.isArray(data) ? data.length : 0 }
}

export interface LiveModelsRequest {
  providerId: string
  runtime: ProviderRuntime
  apiKey: string
  /** The config's own base URL override, if any. */
  baseUrl: string | null
}

/**
 * Fetches the live model list for a provider config, choosing the right
 * endpoint from the registry runtime. Providers with no list endpoint
 * (Perplexity) report `ok: false` with an explanation — the caller then shows
 * models.dev's list instead, which is not an error for the user.
 */
export async function fetchLiveModels(
  request: LiveModelsRequest,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ModelFetchResult> {
  const { runtime, apiKey, providerId } = request
  try {
    if (providerId === 'ollama') {
      return fetchOllamaModels(request.baseUrl ?? runtime.baseUrl ?? '', fetchImpl)
    }
    const base = modelListBaseUrl(runtime, request.baseUrl)
    if (!base) {
      return { ok: false, models: [], message: 'This provider has no model-list endpoint; showing the models.dev list.' }
    }
    switch (runtime.factoryKey) {
      case '@ai-sdk/anthropic':
        return await fetchAnthropicModels(apiKey, base, fetchImpl)
      case '@ai-sdk/google':
        return await fetchGoogleModels(apiKey, base, fetchImpl)
      default:
        return await fetchOpenAiCompatibleModels(apiKey, base, fetchImpl)
    }
  } catch (err) {
    return failure(err)
  }
}
