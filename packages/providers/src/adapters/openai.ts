import { createOpenAI } from '@ai-sdk/openai'
import type { ChatProvider, ProviderChatRequest, ProviderCredentials } from '../types'
import { streamWithModel } from './shared-stream'

export function createOpenAiProvider(credentials: ProviderCredentials): ChatProvider {
  const openai = createOpenAI({
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
  })

  return {
    id: 'openai',
    streamChat(request: ProviderChatRequest) {
      return streamWithModel(openai(request.model), request)
    },
  }
}
