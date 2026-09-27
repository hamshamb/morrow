import { streamText, type LanguageModel, type ModelMessage } from 'ai'
import type { ProviderChatRequest, ProviderStreamEvent } from '../types'

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
): AsyncGenerator<ProviderStreamEvent> {
  const messages: ModelMessage[] = request.messages.map(toModelMessage)

  const result = streamText({
    model,
    messages,
    ...(request.signal ? { abortSignal: request.signal } : {}),
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
