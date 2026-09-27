import type { ProviderId } from '@ai-workspace/shared'

export type ProviderChatRole = 'user' | 'assistant' | 'system'

export interface ProviderChatMessage {
  role: ProviderChatRole
  content: string
}

export interface ProviderChatRequest {
  model: string
  messages: ProviderChatMessage[]
  signal?: AbortSignal
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
  apiKey: string
  baseUrl?: string | null
}
