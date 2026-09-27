import { createOpenAI } from '@ai-sdk/openai'
import type { ChatProvider, ProviderChatRequest, ProviderCredentials } from '../types'
import { streamWithModel, type StreamTextProviderOptions } from './shared-stream'
import { buildOpenAiProviderOptions } from './reasoning-options'

export function createOpenAiProvider(credentials: ProviderCredentials): ChatProvider {
  const openai = createOpenAI({
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
  })

  return {
    id: 'openai',
    streamChat(request: ProviderChatRequest) {
      const openaiOptions = buildOpenAiProviderOptions(request.effort, request.model)
      // Cast: see the matching comment in anthropic.ts.
      return streamWithModel(
        openai(request.model),
        request,
        openaiOptions
          ? ({ openai: openaiOptions } as unknown as StreamTextProviderOptions)
          : undefined,
      )
    },
  }
}
