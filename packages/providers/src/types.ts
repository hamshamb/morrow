import type { ModelMetadata, ProviderId, ReasoningEffort } from '@ai-workspace/shared'

export type ProviderChatRole = 'user' | 'assistant' | 'system'

export interface ProviderChatMessage {
  role: ProviderChatRole
  content: string
}

export interface ProviderChatRequest {
  model: string
  messages: ProviderChatMessage[]
  signal?: AbortSignal
  /** Reasoning/thinking effort for this turn, if the composer had one
   * selected. Each adapter maps this to its own provider's parameter (see
   * `reasoning-options.ts`) and sends nothing when `modelMeta` says the model
   * does not accept it. */
  effort?: ReasoningEffort | null
  /** models.dev metadata for `model` (null/absent = unknown model: no
   * reasoning parameter is sent). */
  modelMeta?: ModelMetadata | null
}

export type ProviderStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: string }

/**
 * Our own provider-independent interface. Adapters translate this into
 * whatever `ai` + `@ai-sdk/*` (or, for the mock adapter, nothing at all)
 * requires — the rest of the app never imports SDK types directly (see
 * ADR-003).
 */
export interface ChatProvider {
  readonly id: ProviderId
  streamChat(request: ProviderChatRequest): AsyncIterable<ProviderStreamEvent>
}

export interface ProviderCredentials {
  /** May be empty for local / keyless endpoints. */
  apiKey: string
  /** Overrides the registry's base URL (custom endpoint, proxy, remote Ollama). */
  baseUrl?: string | null
}
