import { streamText, type LanguageModel, type ModelMessage, type SystemModelMessage } from 'ai'
import type { ProviderChatRequest, ProviderStreamEvent, ProviderUsage } from '../types'

/** `streamText`'s own `providerOptions` type, read off its parameters
 * rather than imported directly — it's assembled internally from
 * `@ai-sdk/provider-utils` and not part of `ai`'s public export surface, so
 * this stays correct across versions without reaching into an internal
 * package. */
export type StreamTextProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/**
 * `ai@7` rejects any `system` message inside `messages` ("System messages are
 * not allowed in the prompt or messages fields. Use the instructions option
 * instead.") — before a request is even sent, for every provider. So system
 * messages are lifted out into `instructions`, in order, and only user /
 * assistant turns stay in `messages`. Callers should only ever send our own
 * trusted prompts as `system`; untrusted content (attached files) belongs in
 * the user turn (see ChatService.buildProviderMessages).
 */
export function splitInstructions(messages: ProviderChatRequest['messages']): {
  instructions: SystemModelMessage[]
  messages: ModelMessage[]
} {
  const instructions: SystemModelMessage[] = []
  const rest: ModelMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') instructions.push({ role: 'system', content: message.content })
    else if (message.role === 'assistant') rest.push({ role: 'assistant', content: message.content })
    else rest.push({ role: 'user', content: message.content })
  }
  return { instructions, messages: rest }
}

/**
 * A readable message for any thrown/streamed error. Some providers answer
 * with an error body the SDK cannot parse, which leaves `Error.message`
 * empty; fall back to the HTTP status and the raw body so the user (and the
 * connection test) never see a blank failure.
 */
export function describeStreamError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message
    const detail = err as Error & { statusCode?: number; responseBody?: string }
    const body = detail.responseBody?.trim()
    if (detail.statusCode !== undefined || body) {
      return `HTTP ${detail.statusCode ?? '?'}${body ? `: ${body.slice(0, 500)}` : ''}`
    }
    return err.name || 'Unknown error'
  }
  return String(err)
}

/**
 * Shared streaming loop used by every real (`ai`-backed) adapter. Only the
 * `LanguageModel` instance differs between providers; the translation from
 * `ai`'s `stream` (text-delta/error parts) into our own `ProviderStreamEvent`
 * union is identical across Anthropic/OpenAI/Google.
 */
export async function* streamWithModel(
  model: LanguageModel,
  request: ProviderChatRequest,
  providerOptions?: StreamTextProviderOptions,
): AsyncGenerator<ProviderStreamEvent> {
  const { instructions, messages } = splitInstructions(request.messages)

  const result = streamText({
    model,
    ...(instructions.length > 0 ? { instructions } : {}),
    messages,
    ...(request.signal ? { abortSignal: request.signal } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  })

  let accumulated = ''
  let usage: ProviderUsage | undefined
  try {
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        accumulated += part.text
        yield { type: 'text-delta', delta: part.text }
      } else if (part.type === 'finish') {
        const inputTokens = part.totalUsage.inputTokens ?? null
        const outputTokens = part.totalUsage.outputTokens ?? null
        // A provider that reports nothing yields no usage at all (never zeros).
        if (inputTokens !== null || outputTokens !== null) usage = { inputTokens, outputTokens }
      } else if (part.type === 'error') {
        yield {
          type: 'error',
          error: describeStreamError(part.error),
        }
        return
      }
    }
    yield { type: 'done', text: accumulated, ...(usage ? { usage } : {}) }
  } catch (err) {
    yield { type: 'error', error: describeStreamError(err) }
  }
}
