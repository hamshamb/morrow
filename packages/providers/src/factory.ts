import type { ProviderId } from '@ai-workspace/shared'
import type { ChatProvider, ProviderCredentials } from './types'
import { resolveProviderRuntime, type ProviderRuntime } from './registry'
import { createSdkProvider, type SdkProviderOptions } from './adapters/sdk-provider'

/**
 * Builds a `ChatProvider` for a registry provider id and credentials. This is
 * the only place that knows about the concrete `@ai-sdk/*` packages — every
 * caller elsewhere only ever sees the `ChatProvider` interface.
 *
 * `runtime` is how the registry says to run this provider (SDK package +
 * base URL). The main process resolves it from the live models.dev catalog;
 * when omitted, the built-in rules apply (Anthropic/OpenAI/Google, Ollama, and
 * a custom endpoint given a `baseUrl`), which keeps this callable without a
 * catalog.
 */
export function createProvider(
  providerId: ProviderId,
  credentials: ProviderCredentials,
  runtime?: ProviderRuntime,
  options?: SdkProviderOptions,
): ChatProvider {
  let resolved = runtime
  if (!resolved) {
    const resolution = resolveProviderRuntime(providerId)
    if (resolution.status !== 'ok') {
      // A provider outside the built-ins with an explicit base URL still runs
      // as OpenAI-compatible; anything else cannot be built without a catalog.
      if (credentials.baseUrl) {
        resolved = {
          providerId,
          factoryKey: '@ai-sdk/openai-compatible',
          kind: 'custom',
          baseUrl: credentials.baseUrl,
          keyRequired: false,
          isLocal: false,
          hasListEndpoint: true,
        }
      } else {
        throw new Error(`Provider "${providerId}" is not available (${resolution.reason}).`)
      }
    } else {
      resolved = resolution
    }
  }
  return createSdkProvider(providerId, resolved, credentials, options)
}
