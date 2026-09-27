import type { ProviderId } from '@ai-workspace/shared'
import type { ChatProvider, ProviderCredentials } from './types'
import { createAnthropicProvider } from './adapters/anthropic'
import { createOpenAiProvider } from './adapters/openai'
import { createGoogleProvider } from './adapters/google'

/**
 * Builds a `ChatProvider` for a given provider id and credentials. This is
 * the only place that knows about the concrete `@ai-sdk/*` adapters — every
 * caller elsewhere in the app only ever sees the `ChatProvider` interface.
 */
export function createProvider(providerId: ProviderId, credentials: ProviderCredentials): ChatProvider {
  switch (providerId) {
    case 'anthropic':
      return createAnthropicProvider(credentials)
    case 'openai':
      return createOpenAiProvider(credentials)
    case 'google':
      return createGoogleProvider(credentials)
  }
}
