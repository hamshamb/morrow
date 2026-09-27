import { createAnthropic } from '@ai-sdk/anthropic'
import type { ChatProvider, ProviderChatRequest, ProviderCredentials } from '../types'
import { streamWithModel } from './shared-stream'

export function createAnthropicProvider(credentials: ProviderCredentials): ChatProvider {
  const anthropic = createAnthropic({
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
  })

  return {
    id: 'anthropic',
    streamChat(request: ProviderChatRequest) {
      return streamWithModel(anthropic(request.model), request)
    },
  }
}
