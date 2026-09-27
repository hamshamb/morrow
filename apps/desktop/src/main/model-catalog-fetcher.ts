import type { ModelCatalogEntry, ProviderId } from '@ai-workspace/shared'

export interface ModelFetchResult {
  ok: boolean
  models: ModelCatalogEntry[]
  message?: string
}

/** Matches the global `fetch` signature closely enough to inject a mock in
 * tests without depending on `node-fetch`/`undici` types directly. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

async function describeHttpError(res: Awaited<ReturnType<FetchLike>>): Promise<string> {
  try {
    const body = await res.text()
    return `HTTP ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`
  } catch {
    return `HTTP ${res.status}`
  }
}

interface AnthropicModelsResponse {
  data?: Array<{ id: string; display_name?: string }>
}

/**
 * Anthropic's models-list endpoint. Headers match exactly what
 * `@ai-sdk/anthropic` sends elsewhere in this codebase for the chat request
 * (`x-api-key` + `anthropic-version: 2023-06-01`) — verified against the
 * installed `@ai-sdk/anthropic@4.0.65` source (`anthropic-provider.ts`).
 */
export async function fetchAnthropicModels(
  apiKey: string,
  baseUrl: string | null,
  fetchImpl: FetchLike,
): Promise<ModelFetchResult> {
  const base = (baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  try {
    const res = await fetchImpl(`${base}/v1/models?limit=1000`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    })
    if (!res.ok) {
      return { ok: false, models: [], message: await describeHttpError(res) }
    }
    const json = (await res.json()) as AnthropicModelsResponse
    const models: ModelCatalogEntry[] = (json.data ?? []).map((m) => ({
      id: m.id,
      displayName: m.display_name ?? null,
    }))
    return { ok: true, models }
  } catch (err) {
    return { ok: false, models: [], message: err instanceof Error ? err.message : String(err) }
  }
}

interface OpenAiModelsResponse {
  data?: Array<{ id: string }>
}

/**
 * OpenAI's models-list endpoint (`GET /v1/models`, Bearer auth). OpenAI's
 * API does not return a separate display name per model, so `displayName`
 * is always null here — the renderer falls back to showing the id.
 */
export async function fetchOpenAiModels(
  apiKey: string,
  baseUrl: string | null,
  fetchImpl: FetchLike,
): Promise<ModelFetchResult> {
  const base = (baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '')
  try {
    const res = await fetchImpl(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      return { ok: false, models: [], message: await describeHttpError(res) }
    }
    const json = (await res.json()) as OpenAiModelsResponse
    const models: ModelCatalogEntry[] = (json.data ?? []).map((m) => ({
      id: m.id,
      displayName: null,
    }))
    return { ok: true, models }
  } catch (err) {
    return { ok: false, models: [], message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Dispatches to the right provider's fetch function. Google is
 * deliberately not wired up to a live fetch in V1 — it keeps its small
 * static fallback list in the renderer (see DECISIONS.md "Known
 * limitations"). Calling this for `google` is a programming error in this
 * codebase (the IPC handler never does it), so it throws rather than
 * returning a silent empty result.
 */
export function fetchProviderModels(
  provider: ProviderId,
  apiKey: string,
  baseUrl: string | null,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ModelFetchResult> {
  switch (provider) {
    case 'anthropic':
      return fetchAnthropicModels(apiKey, baseUrl, fetchImpl)
    case 'openai':
      return fetchOpenAiModels(apiKey, baseUrl, fetchImpl)
    case 'google':
      throw new Error('Live model fetch is not implemented for Google in V1')
  }
}
