import { createAnthropic } from '@ai-sdk/anthropic'
import { createCerebras } from '@ai-sdk/cerebras'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createPerplexity } from '@ai-sdk/perplexity'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createXai } from '@ai-sdk/xai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import type { ChatProvider, ProviderChatRequest, ProviderCredentials } from '../types'
import type { ProviderRuntime } from '../registry'
import { buildReasoningProviderOptions } from '../reasoning-options'
import { streamWithModel, type StreamTextProviderOptions } from './shared-stream'

type ModelFactory = (modelId: string) => LanguageModel

/**
 * Maps a registry runtime to the matching AI SDK factory. Every provider talks
 * to its own endpoint directly with the user's key — no gateway is involved.
 * The `as LanguageModel` casts bridge `@ai-sdk/provider` patch versions that
 * differ between packages (4.0.18 vs 4.0.26); the model spec is the same.
 */
function buildModelFactory(
  runtime: ProviderRuntime,
  credentials: ProviderCredentials,
  fetchImpl?: typeof fetch,
): ModelFactory {
  const baseURL = credentials.baseUrl || runtime.baseUrl || undefined
  const apiKey = credentials.apiKey || undefined
  const common = {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  }
  switch (runtime.factoryKey) {
    case '@ai-sdk/anthropic': {
      const p = createAnthropic(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/openai': {
      const p = createOpenAI(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/google': {
      const p = createGoogleGenerativeAI(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/xai': {
      const p = createXai(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/mistral': {
      const p = createMistral(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/groq': {
      const p = createGroq(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/deepseek': {
      const p = createDeepSeek(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/cerebras': {
      const p = createCerebras(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/togetherai': {
      const p = createTogetherAI(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/perplexity': {
      const p = createPerplexity(common)
      return (id) => p(id) as LanguageModel
    }
    case '@openrouter/ai-sdk-provider': {
      const p = createOpenRouter(common)
      return (id) => p(id) as LanguageModel
    }
    case '@ai-sdk/openai-compatible': {
      if (!baseURL) {
        throw new Error(`Provider "${runtime.providerId}" needs a base URL (OpenAI-compatible endpoint).`)
      }
      // `name` is the providerOptions key the SDK also reads; `includeUsage`
      // matches OpenCode's default for OpenAI-compatible routes.
      const p = createOpenAICompatible({
        name: runtime.providerId,
        baseURL,
        includeUsage: true,
        ...(apiKey ? { apiKey } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      })
      return (id) => p(id) as LanguageModel
    }
  }
}

export interface SdkProviderOptions {
  /** Test seam: replaces the network `fetch` used by the SDK. */
  fetch?: typeof fetch
}

/** One adapter for every `ai`-backed provider; only the model factory and the
 * reasoning option shape differ, both chosen from the registry runtime. */
export function createSdkProvider(
  providerId: string,
  runtime: ProviderRuntime,
  credentials: ProviderCredentials,
  options: SdkProviderOptions = {},
): ChatProvider {
  const modelFactory = buildModelFactory(runtime, credentials, options.fetch)
  return {
    id: providerId,
    streamChat(request: ProviderChatRequest) {
      const reasoning = buildReasoningProviderOptions({
        factoryKey: runtime.factoryKey,
        effort: request.effort,
        model: request.modelMeta,
      })
      // Cast: the options are plain JSON objects, but TS cannot match our
      // `Record<string, Record<string, unknown>>` against `ai`'s `JSONObject`.
      return streamWithModel(
        modelFactory(request.model),
        request,
        reasoning ? (reasoning as unknown as StreamTextProviderOptions) : undefined,
      )
    },
  }
}
