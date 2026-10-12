/**
 * Reasoning-effort -> provider request mapping.
 *
 * Which effort values a model accepts comes from models.dev
 * (`ModelMetadata.reasoningEfforts`), not from id patterns. This module adds
 * the second half: which of those values each provider SDK can actually put on
 * the wire, and where. A value the SDK cannot send is never offered and never
 * sent ("unsupported -> send nothing").
 *
 * Per-SDK option names were verified against the installed packages' option
 * schemas (src/*-options.ts), and cross-checked with OpenCode's variant
 * builder (MIT, Copyright (c) 2025 opencode — packages/opencode/src/provider/
 * transform.ts `variants()` / `sdkKey()`), which this adapts:
 *
 *   @ai-sdk/anthropic   anthropic.effort low|medium|high|xhigh|max + anthropic.thinking
 *   @ai-sdk/openai      openai.reasoningEffort (string: none…max)
 *   @ai-sdk/google      google.thinkingConfig.thinkingLevel minimal|low|medium|high
 *   @ai-sdk/xai         xai.reasoningEffort none|low|medium|high|xhigh
 *   @ai-sdk/mistral     mistral.reasoningEffort high|none
 *   @ai-sdk/groq        groq.reasoningEffort none|low|medium|high
 *   @ai-sdk/cerebras    cerebras.reasoningEffort none|low|medium|high
 *   @ai-sdk/deepseek    deepseek.reasoningEffort low|high|max + deepseek.thinking
 *   @openrouter/…       openrouter.reasoning.effort none…xhigh
 *   @ai-sdk/togetherai, @ai-sdk/openai-compatible
 *                       openaiCompatible.reasoningEffort (free string)
 *   @ai-sdk/perplexity  no reasoning option -> nothing is sent
 */
import type { ModelMetadata, ReasoningEffort } from '@ai-workspace/shared'
import { sortEfforts } from '@ai-workspace/shared'
import type { FactoryKey } from './registry'

const ALL: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Effort values each SDK can send. */
const SDK_EFFORTS: Readonly<Record<FactoryKey, readonly ReasoningEffort[]>> = {
  '@ai-sdk/anthropic': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  '@ai-sdk/openai': ALL,
  '@ai-sdk/google': ['minimal', 'low', 'medium', 'high'],
  '@ai-sdk/xai': ['none', 'low', 'medium', 'high', 'xhigh'],
  '@ai-sdk/mistral': ['none', 'high'],
  '@ai-sdk/groq': ['none', 'low', 'medium', 'high'],
  '@ai-sdk/cerebras': ['none', 'low', 'medium', 'high'],
  '@ai-sdk/deepseek': ['none', 'low', 'high', 'max'],
  '@ai-sdk/togetherai': ALL,
  '@ai-sdk/openai-compatible': ALL,
  '@openrouter/ai-sdk-provider': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  '@ai-sdk/perplexity': [],
}

export function sdkSupportedEfforts(factoryKey: FactoryKey): readonly ReasoningEffort[] {
  return SDK_EFFORTS[factoryKey]
}

/** The efforts a model offers in this app: its models.dev values ∩ what the SDK can send. */
export function usableEfforts(
  factoryKey: FactoryKey,
  modelEfforts: readonly ReasoningEffort[],
): ReasoningEffort[] {
  const supported = new Set(SDK_EFFORTS[factoryKey])
  return sortEfforts(modelEfforts.filter((e) => supported.has(e)))
}

/**
 * Anthropic budget tiers for models that think with an explicit token budget
 * (`thinking.type = 'enabled'`). Each is >= Anthropic's 1024-token minimum
 * and they strictly increase. Adaptive-only models ignore the budget.
 */
export const ANTHROPIC_THINKING_BUDGET_TOKENS: Readonly<Record<ReasoningEffort, number>> = {
  none: 0,
  minimal: 2_000,
  low: 4_000,
  medium: 10_000,
  high: 24_000,
  xhigh: 32_000,
  max: 48_000,
}

export type ReasoningModelInfo = Pick<ModelMetadata, 'reasoning' | 'reasoningEfforts' | 'reasoningBudget' | 'maxOutput'>

export interface BuildReasoningOptionsInput {
  factoryKey: FactoryKey
  effort: ReasoningEffort | null | undefined
  /** models.dev metadata for the model; without it nothing is sent. */
  model: ReasoningModelInfo | null | undefined
}

/** `{ [providerOptionsKey]: options }`, as `streamText({ providerOptions })` takes it. */
export type ReasoningProviderOptions = Record<string, Record<string, unknown>>

/** Returns the effort if the model accepts it and the SDK can send it, else undefined. */
export function validateEffort(
  factoryKey: FactoryKey,
  effort: ReasoningEffort | null | undefined,
  model: ReasoningModelInfo | null | undefined,
): ReasoningEffort | undefined {
  if (!effort || !model || !model.reasoning) return undefined
  if (!model.reasoningEfforts.includes(effort)) return undefined
  if (!SDK_EFFORTS[factoryKey].includes(effort)) return undefined
  return effort
}

function anthropicBudget(effort: ReasoningEffort, model: ReasoningModelInfo): number {
  let budget = ANTHROPIC_THINKING_BUDGET_TOKENS[effort]
  const range = model.reasoningBudget
  if (range?.max != null) budget = Math.min(budget, range.max)
  if (model.maxOutput != null) budget = Math.min(budget, model.maxOutput - 1_024)
  return Math.max(budget, range?.min ?? 1_024, 1_024)
}

export function buildReasoningProviderOptions(input: BuildReasoningOptionsInput): ReasoningProviderOptions | undefined {
  const { factoryKey, model } = input
  const effort = validateEffort(factoryKey, input.effort, model)
  if (!effort || !model) return undefined

  switch (factoryKey) {
    case '@ai-sdk/anthropic':
      if (effort === 'none') return { anthropic: { thinking: { type: 'disabled' } } }
      // Models that also list `budget_tokens` (Opus 4.5/4.6, Sonnet 4.6) think
      // with an explicit budget; effort-only models are adaptive-thinking. The
      // SDK itself converts a budgeted request to adaptive for models that
      // reject budgets, so this never produces a 400.
      return {
        anthropic: {
          effort,
          thinking: model.reasoningBudget
            ? { type: 'enabled', budgetTokens: anthropicBudget(effort, model) }
            : { type: 'adaptive' },
        },
      }
    case '@ai-sdk/openai':
      return { openai: { reasoningEffort: effort } }
    case '@ai-sdk/google':
      return { google: { thinkingConfig: { thinkingLevel: effort } } }
    case '@ai-sdk/xai':
      return { xai: { reasoningEffort: effort } }
    case '@ai-sdk/mistral':
      return { mistral: { reasoningEffort: effort } }
    case '@ai-sdk/groq':
      return { groq: { reasoningEffort: effort } }
    case '@ai-sdk/cerebras':
      return { cerebras: { reasoningEffort: effort } }
    case '@ai-sdk/deepseek':
      if (effort === 'none') return { deepseek: { thinking: { type: 'disabled' } } }
      return { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: effort } }
    case '@openrouter/ai-sdk-provider':
      return { openrouter: { reasoning: { effort } } }
    case '@ai-sdk/togetherai':
    case '@ai-sdk/openai-compatible':
      return { openaiCompatible: { reasoningEffort: effort } }
    case '@ai-sdk/perplexity':
      return undefined
  }
}
