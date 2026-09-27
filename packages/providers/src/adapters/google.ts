import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { ChatProvider, ProviderChatRequest, ProviderCredentials } from '../types'
import { streamWithModel } from './shared-stream'

export function createGoogleProvider(credentials: ProviderCredentials): ChatProvider {
  const google = createGoogleGenerativeAI({
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
  })

  return {
    id: 'google',
    streamChat(request: ProviderChatRequest) {
      return streamWithModel(google(request.model), request)
    },
  }
}
