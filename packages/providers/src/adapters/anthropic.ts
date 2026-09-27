import { createAnthropic } from '@ai-sdk/anthropic'
import type { ChatProvider, ProviderChatRequest, ProviderCredentials } from '../types'
import { streamWithModel, type StreamTextProviderOptions } from './shared-stream'
import { buildAnthropicProviderOptions } from './reasoning-options'

export function createAnthropicProvider(credentials: ProviderCredentials): ChatProvider {
  const anthropic = createAnthropic({
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
  })

  return {
    id: 'anthropic',
    streamChat(request: ProviderChatRequest) {
      const anthropicOptions = buildAnthropicProviderOptions(request.effort, request.model)
      // Cast: `anthropicOptions` is a plain JSON-serializable object (verified
      // against the installed @ai-sdk/anthropic option types in
      // reasoning-options.ts), but TS won't structurally match our named
      // interface against `ai`'s `JSONObject` index signature without one.
      return streamWithModel(
        anthropic(request.model),
        request,
        anthropicOptions
          ? ({ anthropic: anthropicOptions } as unknown as StreamTextProviderOptions)
          : undefined,
      )
    },
  }
}
