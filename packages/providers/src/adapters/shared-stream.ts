import { streamText, type LanguageModel, type ModelMessage } from 'ai'
import type { ProviderChatRequest, ProviderStreamEvent } from '../types'

/** `streamText`'s own `providerOptions` type, read off its parameters
 * rather than imported directly — it's assembled internally from
 * `@ai-sdk/provider-utils` and not part of `ai`'s public export surface, so
 * this stays correct across versions without reaching into an internal
 * package. */
export type StreamTextProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

function toModelMessage(message: ProviderChatRequest['messages'][number]): ModelMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content }
    case 'assistant':
      return { role: 'assistant', content: message.content }
    case 'user':
    default:
      return { role: 'user', content: message.content }
  }
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
  const messages: ModelMessage[] = request.messages.map(toModelMessage)

  const result = streamText({
    model,
    messages,
    ...(request.signal ? { abortSignal: request.signal } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  })

  let accumulated = ''
  try {
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        accumulated += part.text
        yield { type: 'text-delta', delta: part.text }
      } else if (part.type === 'error') {
        yield {
          type: 'error',
          error: part.error instanceof Error ? part.error.message : String(part.error),
        }
        return
      }
    }
    yield { type: 'done', text: accumulated }
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}
