import { parseModelsDevCatalog, type ModelsDevCatalog } from '@ai-workspace/providers'

const text = { input: ['text'], output: ['text'] }

function provider(id: string, npm: string, models: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id, name: id.toUpperCase(), env: [`${id.toUpperCase()}_API_KEY`], npm, models, ...extra }
}

/** Five+ runnable providers so a "catalog" passes the service's sanity check. */
export function smallRawCatalog(label = 'v1'): Record<string, unknown> {
  return {
    anthropic: provider('anthropic', '@ai-sdk/anthropic', {
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: `Claude Sonnet 5 (${label})`,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
        tool_call: true,
        release_date: '2026-06-29',
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 2, output: 10 },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        reasoning: true,
        reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
        release_date: '2025-10-01',
        modalities: text,
        limit: { context: 200_000, output: 64_000 },
        cost: { input: 1, output: 5 },
      },
    }),
    openai: provider('openai', '@ai-sdk/openai', {
      'gpt-4o-mini': {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        reasoning: false,
        release_date: '2024-07-18',
        modalities: text,
        limit: { context: 128_000, output: 16_384 },
        cost: { input: 0.15, output: 0.6 },
      },
      'gpt-5.6': {
        id: 'gpt-5.6',
        name: 'GPT-5.6',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }],
        release_date: '2026-03-01',
        modalities: text,
        limit: { context: 1_050_000, output: 128_000 },
        cost: { input: 2.5, output: 15 },
      },
      'text-embedding-3-small': { id: 'text-embedding-3-small', name: 'emb', type: 'embedding', modalities: text, limit: { context: 8191, output: 0 } },
    }),
    google: provider('google', '@ai-sdk/google', {
      'gemini-3.5-flash': { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', release_date: '2026-05-01', modalities: text, limit: { context: 1_048_576, output: 65_536 }, cost: { input: 0.3, output: 2.5 } },
    }),
    xai: provider('xai', '@ai-sdk/xai', {
      'grok-4.7': { id: 'grok-4.7', name: 'Grok 4.7', release_date: '2026-04-01', modalities: text, limit: { context: 500_000, output: 64_000 }, cost: { input: 3, output: 15 } },
    }),
    groq: provider('groq', '@ai-sdk/groq', {
      'llama-3.3-70b-versatile': { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', release_date: '2024-12-01', modalities: text, limit: { context: 131_072, output: 32_768 }, cost: { input: 0.59, output: 0.79 } },
    }),
    perplexity: provider('perplexity', '@ai-sdk/perplexity', {
      sonar: { id: 'sonar', name: 'Sonar', release_date: '2025-01-01', modalities: text, limit: { context: 128_000, output: 8_000 }, cost: { input: 1, output: 1 } },
    }),
    'fireworks-ai': provider('fireworks-ai', '@ai-sdk/openai-compatible', {
      kimi: { id: 'kimi', name: 'Kimi', release_date: '2025-07-01', modalities: text, limit: { context: 131_072, output: 16_384 }, cost: { input: 0.6, output: 2.5 } },
    }, { api: 'https://api.fireworks.ai/inference/v1' }),
  }
}

export function smallCatalog(label = 'v1'): ModelsDevCatalog {
  return parseModelsDevCatalog(smallRawCatalog(label))
}
