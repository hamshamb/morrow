import {
  ANTHROPIC_THINKING_BUDGET_TOKENS,
  isReasoningCapableModel,
  type ReasoningEffort,
} from '@ai-workspace/shared'

/**
 * Builds `providerOptions.anthropic` for the extended-thinking effort knob.
 * Verified against the installed `@ai-sdk/anthropic@4.0.65` option types
 * (`anthropic-language-model-options.ts`):
 *
 * - `effort` (`'low'|'medium'|'high'|'xhigh'|'max'`) is the lever for
 *   models that always use adaptive thinking (e.g. `claude-opus-5-5`,
 *   `claude-fable-5-1`) — those models reject an explicit `thinking.enabled`
 *   budget.
 * - `thinking: { type: 'enabled', budgetTokens }` is the lever for models
 *   still on the legacy explicit-budget thinking mode.
 *
 * Both fields are independent (not a discriminated union against each
 * other), so we send both every time: whichever one a given model doesn't
 * support is dropped by the SDK with a warning, never a hard error — see
 * ADR "Reasoning effort mapping" in DECISIONS.md. This means we don't need
 * to know in advance which generation a given (possibly live-fetched,
 * previously-unseen) model id belongs to.
 */
export interface AnthropicReasoningProviderOptions {
  effort: ReasoningEffort
  thinking: { type: 'enabled'; budgetTokens: number }
}

export function buildAnthropicProviderOptions(
  effort: ReasoningEffort | null | undefined,
  modelId: string,
): AnthropicReasoningProviderOptions | undefined {
  if (!effort || !isReasoningCapableModel('anthropic', modelId)) return undefined
  return {
    effort,
    thinking: { type: 'enabled', budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS[effort] },
  }
}

/**
 * Builds `providerOptions.openai` for the reasoning-effort knob. Verified
 * against the installed `@ai-sdk/openai@4.0.78` option types
 * (`openai-chat-language-model-options.ts`): `reasoningEffort` accepts
 * `'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`; our three-tier
 * selector maps directly onto the matching `'low'|'medium'|'high'` values.
 */
export interface OpenAiReasoningProviderOptions {
  reasoningEffort: ReasoningEffort
}

export function buildOpenAiProviderOptions(
  effort: ReasoningEffort | null | undefined,
  modelId: string,
): OpenAiReasoningProviderOptions | undefined {
  if (!effort || !isReasoningCapableModel('openai', modelId)) return undefined
  return { reasoningEffort: effort }
}
