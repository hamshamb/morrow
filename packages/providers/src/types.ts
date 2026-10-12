import type { ModelMetadata, ProviderId, ReasoningEffort } from '@ai-workspace/shared'

export type ProviderChatRole = 'user' | 'assistant' | 'system'

export interface ProviderChatMessage {
  role: ProviderChatRole
  content: string
}

/** What a tool returns to the model: text, plus whether it is an error result. */
export interface AgentToolOutcome {
  text: string
  isError?: boolean
}

/**
 * One tool offered to the model (Phase 5). Provider-independent: the app's
 * tool layer builds these and every adapter translates them into its SDK's
 * format in the one `streamWithModel` call site (ADR-040). `execute` is OUR
 * code — it runs the permission engine and the audit log before and after the
 * real work; the provider layer only calls it when the model asks.
 */
export interface AgentToolSpec {
  /** Wire name. Must match `^[a-zA-Z0-9_-]{1,64}$` (Anthropic and OpenAI both reject dots). */
  name: string
  description: string
  /** JSON Schema (draft 7) for the arguments object. */
  inputJsonSchema: Record<string, unknown>
  /** Validates the model's arguments; failures go back to the model as an error result. */
  validate?: (value: unknown) => { success: true; value: unknown } | { success: false; error: Error }
  execute(input: unknown, context: { toolCallId: string; signal: AbortSignal }): Promise<AgentToolOutcome>
}

/** Tool-use options for a request. Absent = a plain one-shot chat turn. */
export interface ProviderToolOptions {
  tools: AgentToolSpec[]
  /** Hard cap on model calls in this request (the loop is bounded here, not by the model). */
  maxSteps: number
}

export interface ProviderChatRequest {
  model: string
  messages: ProviderChatMessage[]
  /** Tools + step cap: turns the request into a bounded tool-calling loop. */
  toolOptions?: ProviderToolOptions
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

/** Token usage as the provider reported it; a field is null when it did not. */
export interface ProviderUsage {
  inputTokens: number | null
  outputTokens: number | null
}

export type ProviderStreamEvent =
  | { type: 'text-delta'; delta: string }
  /** A model call (step) is starting; 1-based. Only emitted for tool requests. */
  | { type: 'step-start'; step: number }
  /** The model asked for a tool. `invalid` is set when the call could not be parsed or names an unknown tool. */
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; invalid?: string }
  /** The result our `execute` produced, as it was handed back to the model. */
  | { type: 'tool-result'; toolCallId: string; toolName: string; text: string; isError: boolean }
  /** A tool call failed before/without returning an outcome (invalid input, unknown tool, thrown error). */
  | { type: 'tool-error'; toolCallId: string; toolName: string; error: string }
  | { type: 'step-finish'; step: number; finishReason: string }
  | { type: 'done'; text: string; usage?: ProviderUsage; steps?: number; finishReason?: string }
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
