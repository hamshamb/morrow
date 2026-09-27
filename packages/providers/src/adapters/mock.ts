import type { ProviderId } from '@ai-workspace/shared'
import type { ChatProvider, ProviderChatRequest, ProviderStreamEvent } from '../types'

export interface MockProviderOptions {
  /** The provider identity this mock pretends to be, for attribution testing. */
  id: ProviderId
  /**
   * Either a fixed list of text chunks to stream, or a function of the
   * request that returns one (so tests can vary the response per call).
   * Defaults to echoing the last user message back in chunks.
   */
  respond?: string[] | ((request: ProviderChatRequest) => string[])
  /** If set, the stream ends with an error event instead of `done`. */
  failWith?: string
}

/**
 * A network-free `ChatProvider` used in tests (and available for offline
 * development) to prove a message flows through the provider abstraction
 * without requiring a real Anthropic/OpenAI/Google API key.
 */
export function createMockProvider(options: MockProviderOptions): ChatProvider {
  return {
    id: options.id,
    async *streamChat(request: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
      if (request.signal?.aborted) {
        yield { type: 'error', error: 'Aborted' }
        return
      }

      const chunks =
        typeof options.respond === 'function'
          ? options.respond(request)
          : (options.respond ?? [
              `Mock reply to: ${request.messages.at(-1)?.content ?? ''}`,
            ])

      let accumulated = ''
      for (const chunk of chunks) {
        if (request.signal?.aborted) {
          yield { type: 'error', error: 'Aborted' }
          return
        }
        accumulated += chunk
        yield { type: 'text-delta', delta: chunk }
      }

      if (options.failWith) {
        yield { type: 'error', error: options.failWith }
        return
      }

      yield { type: 'done', text: accumulated }
    },
  }
}
