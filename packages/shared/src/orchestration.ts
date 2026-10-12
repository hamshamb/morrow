import { z } from 'zod'
import { ContextSelectionSchema } from './context'
import { MessageSchema, RoleLabelSchema, type RoleLabel } from './conversation'
import { ReasoningEffortSchema, type ModelCost, type ModelMetadata } from './model-metadata'
import { ProviderIdSchema } from './provider'

/**
 * Phase 6 — multi-model orchestration (ADR-027..031). Everything here is
 * provider- and Electron-free: IPC input/event schemas, the hard limits that
 * the main process re-enforces server-side, the cost estimator and the Auto
 * router (pure functions, unit-tested exhaustively).
 */

// ------------------------------------------------------------------ limits

export const COMPARE_MIN_MODELS = 2
export const COMPARE_MAX_MODELS = 4
export const ROUND_TABLE_MIN_PARTICIPANTS = 2
export const ROUND_TABLE_MAX_PARTICIPANTS = 4
export const ROUND_TABLE_DEFAULT_ROUNDS = 1
/** Hard cap on round-table iterations; also enforced in the main process. */
export const ROUND_TABLE_MAX_ROUNDS = 3
/** The most provider calls one round table may ever make: every participant
 * once per round, plus one optional synthesis. */
export const ROUND_TABLE_MAX_CALLS = ROUND_TABLE_MAX_ROUNDS * ROUND_TABLE_MAX_PARTICIPANTS + 1

/** Composer mode (UI state). `chat` is the unchanged default. */
export const COMPOSER_MODES = ['chat', 'compare', 'review', 'roundtable', 'auto'] as const
export type ComposerMode = (typeof COMPOSER_MODES)[number]

export const COMPOSER_MODE_LABELS: Record<ComposerMode, string> = {
  chat: 'chat',
  compare: 'compare',
  review: 'review',
  roundtable: 'round table',
  auto: 'auto',
}

/** The three roles a round-table participant can play (synthesis is the optional last step). */
export const RoundTableRoleSchema = z.enum(['proposal', 'critique', 'alternative'])
export type RoundTableRole = z.infer<typeof RoundTableRoleSchema>

export const ROLE_LABEL_TEXT: Record<RoleLabel, string> = {
  proposal: 'PROPOSAL',
  critique: 'CRITIQUE',
  alternative: 'ALTERNATIVE',
  synthesis: 'SYNTHESIS',
  review: 'REVIEW',
  revision: 'REVISED',
}

// ------------------------------------------------------------------ cost

export interface TokenUsage {
  inputTokens: number | null | undefined
  outputTokens: number | null | undefined
}

/**
 * Estimated cost in USD: models.dev `cost` (USD per 1M tokens) x the usage the
 * provider reported. Returns null — never a made-up number — when the model's
 * price is unknown or the provider reported no usage. Cache read/write
 * discounts are not applied (the stream reports totals only), so this is an
 * estimate and the UI labels it "est.".
 */
export function estimateCostUsd(cost: ModelCost | null | undefined, usage: TokenUsage | null | undefined): number | null {
  if (!cost || !usage) return null
  const { inputTokens, outputTokens } = usage
  if (inputTokens == null || outputTokens == null) return null
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null
  if (inputTokens < 0 || outputTokens < 0) return null
  return (inputTokens * cost.input + outputTokens * cost.output) / 1_000_000
}

/** `est. $0.0042`, `est. $1.20`, or `—` when unknown. */
export function formatEstimatedCost(usd: number | null | undefined): string {
  if (usd == null) return '—'
  if (usd === 0) return 'est. $0'
  if (usd < 0.0001) return 'est. <$0.0001'
  if (usd < 0.01) return `est. $${usd.toFixed(4)}`
  if (usd < 1) return `est. $${usd.toFixed(3)}`
  return `est. $${usd.toFixed(2)}`
}

// ------------------------------------------------------------------ auto

export const AutoPreferenceSchema = z.enum(['cheapest', 'balanced', 'best'])
export type AutoPreference = z.infer<typeof AutoPreferenceSchema>
export const AUTO_PREFERENCES = AutoPreferenceSchema.options
export const DEFAULT_AUTO_PREFERENCE: AutoPreference = 'balanced'

export interface AutoCandidate {
  providerConfigId: string
  provider: string
  modelId: string
  /** Display name for the "Auto → …" line. */
  name: string
  /** The user has a configured provider (a key, or a keyless local/custom
   * endpoint) for this model. Candidates without one are never picked. */
  hasKey: boolean
  /** models.dev metadata; null for ids models.dev does not know. */
  meta: ModelMetadata | null
}

export interface AutoRouteInput {
  /** The user's prompt, used for the complexity heuristic. */
  promptText: string
  /** Estimated tokens the request will carry (history + prompt + attachments + context). */
  estimatedContextTokens: number
  /** MIME types of attachments on this turn (image/*, application/pdf need input support). */
  attachmentMimeTypes: string[]
}

export interface AutoPrefs {
  preference: AutoPreference
}

export interface AutoResult {
  choice: AutoCandidate | null
  /** Human-readable rules that decided the pick: "needs vision, cheapest capable". */
  reason: string
  /** The same rules as a list (stable identifiers for tests and display). */
  rules: string[]
}

/** Tokens kept free for the answer when checking a prompt against a context window. */
export const AUTO_OUTPUT_RESERVE_TOKENS = 4096
/** A prompt at least this long counts as complex. */
export const AUTO_COMPLEX_PROMPT_CHARS = 1200

const COMPLEXITY_KEYWORDS =
  /\b(prove|proof|derive|debug|refactor|architect(?:ure)?|optimi[sz]e|step[- ]by[- ]step|trade-?offs?|algorithm|analy[sz]e|design|investigate|migrate|root cause)\b/i

/**
 * The documented complexity heuristic (ADR-030): a prompt is "complex" when it
 * is long (>= 1200 chars), contains a fenced code block, or names a
 * reasoning-heavy task (prove, derive, debug, refactor, architecture,
 * optimize, step-by-step, trade-offs, algorithm, analyze, design, investigate,
 * migrate, root cause). Nothing learned, nothing hidden.
 */
export function isComplexPrompt(text: string): boolean {
  return text.length >= AUTO_COMPLEX_PROMPT_CHARS || text.includes('```') || COMPLEXITY_KEYWORDS.test(text)
}

/** Input modalities the attachments need: image/* -> 'image', application/pdf -> 'pdf'. */
export function requiredModalities(mimeTypes: string[]): ('image' | 'pdf')[] {
  const needs = new Set<'image' | 'pdf'>()
  for (const mime of mimeTypes) {
    const type = mime.toLowerCase()
    if (type.startsWith('image/')) needs.add('image')
    else if (type === 'application/pdf') needs.add('pdf')
  }
  return [...needs].sort()
}

function acceptsModality(meta: ModelMetadata, modality: 'image' | 'pdf'): boolean {
  if (meta.inputModalities.includes(modality)) return true
  // models.dev's flat `vision` flag predates the modality list for images.
  return modality === 'image' && meta.vision
}

/** Blended list price (USD per 1M tokens, input + output), or null when unpriced. */
function priceOf(candidate: AutoCandidate): number | null {
  const cost = candidate.meta?.cost
  return cost ? cost.input + cost.output : null
}

const FAST_FAMILY = /\b(haiku|flash|mini|nano|lite|small|instant|turbo)\b/i

function isFastFamily(candidate: AutoCandidate): boolean {
  const meta = candidate.meta
  return FAST_FAMILY.test(`${meta?.family ?? ''} ${meta?.name ?? ''} ${candidate.modelId}`)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Last resort ordering that makes every pick fully deterministic. */
function compareIdentity(a: AutoCandidate, b: AutoCandidate): number {
  return (
    compareStrings(a.provider, b.provider) ||
    compareStrings(a.providerConfigId, b.providerConfigId) ||
    compareStrings(a.modelId, b.modelId)
  )
}

function newestFirst(a: AutoCandidate, b: AutoCandidate): number {
  return compareStrings(b.meta?.releaseDate ?? '', a.meta?.releaseDate ?? '')
}

/** Ascending price, unpriced last. */
function byPriceAsc(a: AutoCandidate, b: AutoCandidate): number {
  const pa = priceOf(a)
  const pb = priceOf(b)
  if (pa === null && pb === null) return 0
  if (pa === null) return 1
  if (pb === null) return -1
  return pa - pb
}

function byPriceDesc(a: AutoCandidate, b: AutoCandidate): number {
  const pa = priceOf(a)
  const pb = priceOf(b)
  if (pa === null && pb === null) return 0
  if (pa === null) return 1
  if (pb === null) return -1
  return pb - pa
}

const NONE: AutoResult = { choice: null, reason: '', rules: [] }

/**
 * Deterministic, transparent model routing from models.dev metadata (ADR-030).
 * No ML, no randomness, no hidden state — same input, same pick. Rules, in order:
 *
 * 1. Only candidates the user has a key for (`hasKey`); deprecated models never.
 * 2. Models without models.dev metadata are "unrated": used only when no rated
 *    candidate exists (then the first by provider/model id, reason says so).
 * 3. Attachments need input support: image/* -> image input, PDF -> pdf input.
 *    No capable model -> no pick (never silently drops the attachment).
 * 4. Context fit: estimated tokens + 4096 reserved for the answer must fit the
 *    model's `limit.context` (unknown window: kept).
 * 5. Complex prompt (see `isComplexPrompt`): prefer reasoning-capable models
 *    when any remain.
 * 6. Preference over what is left, using list price (input + output $/1M):
 *    - cheapest: lowest price; unpriced last; ties -> fast family (haiku, flash,
 *      mini, nano, lite, …), then newest release.
 *    - balanced: the upper-median price; ties -> newest release.
 *    - best: reasoning-capable first, then highest price, then newest release.
 *    Final tie-break everywhere: provider id, config id, model id (ascending).
 */
export function pickAutoModel(input: AutoRouteInput, candidates: AutoCandidate[], prefs: AutoPrefs): AutoResult {
  const rules: string[] = []
  const done = (choice: AutoCandidate | null, reason?: string): AutoResult => ({
    choice,
    reason: reason ?? rules.join(', '),
    rules: [...rules],
  })

  // 1. keys + deprecation
  const keyed = candidates.filter((c) => c.hasKey)
  if (keyed.length === 0) return { ...NONE, reason: 'no configured model — add a provider key first' }
  const usable = keyed.filter((c) => c.meta?.status !== 'deprecated')
  if (usable.length === 0) return { ...NONE, reason: 'every configured model is deprecated' }

  // 2. rated vs unrated
  const rated = usable.filter((c) => c.meta !== null)
  if (rated.length === 0) {
    const first = [...usable].sort(compareIdentity)[0] ?? null
    rules.push('no models.dev metadata for your models', 'first configured')
    return done(first)
  }
  let pool = rated

  // 3. attachments need modalities
  const needs = requiredModalities(input.attachmentMimeTypes)
  if (needs.length > 0) {
    pool = pool.filter((c) => c.meta !== null && needs.every((m) => acceptsModality(c.meta as ModelMetadata, m)))
    const label = needs.map((m) => (m === 'image' ? 'vision' : 'pdf input')).join(' + ')
    if (pool.length === 0) {
      return { ...NONE, reason: `no configured model supports ${label}` }
    }
    rules.push(`needs ${label}`)
  }

  // 4. context fit
  const needTokens = input.estimatedContextTokens + AUTO_OUTPUT_RESERVE_TOKENS
  const fitting = pool.filter((c) => {
    const window = c.meta?.contextWindow
    return !window || needTokens <= window
  })
  if (fitting.length === 0) {
    return { ...NONE, reason: `prompt (~${input.estimatedContextTokens} tokens) exceeds every configured model's context window` }
  }
  if (fitting.length < pool.length) rules.push('fits context window')
  pool = fitting

  // 5. complexity -> reasoning
  if (isComplexPrompt(input.promptText)) {
    const reasoners = pool.filter((c) => c.meta?.reasoning)
    if (reasoners.length > 0) {
      pool = reasoners
      rules.push('reasoning for a complex prompt')
    }
  }

  // 6. preference
  let ordered: AutoCandidate[]
  switch (prefs.preference) {
    case 'cheapest': {
      ordered = [...pool].sort(
        (a, b) =>
          byPriceAsc(a, b) ||
          Number(isFastFamily(b)) - Number(isFastFamily(a)) ||
          newestFirst(a, b) ||
          compareIdentity(a, b),
      )
      rules.push('cheapest capable')
      return done(ordered[0] ?? null)
    }
    case 'best': {
      ordered = [...pool].sort(
        (a, b) =>
          Number(Boolean(b.meta?.reasoning)) - Number(Boolean(a.meta?.reasoning)) ||
          byPriceDesc(a, b) ||
          newestFirst(a, b) ||
          compareIdentity(a, b),
      )
      rules.push('strongest capable')
      return done(ordered[0] ?? null)
    }
    case 'balanced':
    default: {
      const priced = pool.filter((c) => priceOf(c) !== null)
      const basis = priced.length > 0 ? priced : pool
      ordered = [...basis].sort((a, b) => byPriceAsc(a, b) || newestFirst(a, b) || compareIdentity(a, b))
      const middle = ordered[Math.floor(ordered.length / 2)] ?? null
      rules.push(ordered.length === 1 ? 'only capable model' : 'balanced price')
      return done(middle)
    }
  }
}

/** `Auto → Claude Sonnet 5 · reason: needs vision, cheapest capable`. */
export function formatAutoLine(modelName: string, reason: string): string {
  return `Auto → ${modelName} · reason: ${reason}`
}

// ------------------------------------------------------------------ IPC inputs

export const ModelTargetSchema = z.object({
  providerConfigId: z.string().min(1),
  model: z.string().min(1).max(200),
  effort: ReasoningEffortSchema.nullable().optional(),
})
export type ModelTarget = z.infer<typeof ModelTargetSchema>

const contentField = z.string().min(1).max(100_000)

const OrchestrationBaseSchema = z.object({
  /** Renderer-generated id of the whole orchestration; the key for
   * `cancelOrchestration` and (review / round table) the stream channel. */
  orchestrationId: z.string().min(1),
  conversationId: z.string().min(1),
  contextSelection: ContextSelectionSchema.optional(),
})

/** One compare column: its own requestId (= its own stream channel and cancel key). */
export const CompareTargetSchema = ModelTargetSchema.extend({ requestId: z.string().min(1) })
export type CompareTarget = z.infer<typeof CompareTargetSchema>

export const CompareInputSchema = OrchestrationBaseSchema.extend({
  content: contentField,
  targets: z.array(CompareTargetSchema).min(COMPARE_MIN_MODELS).max(COMPARE_MAX_MODELS),
}).superRefine((input, ctx) => {
  const requestIds = new Set(input.targets.map((t) => t.requestId))
  if (requestIds.size !== input.targets.length) {
    ctx.addIssue({ code: 'custom', path: ['targets'], message: 'each compare column needs its own requestId' })
  }
  const models = new Set(input.targets.map((t) => `${t.providerConfigId}\u0000${t.model}`))
  if (models.size !== input.targets.length) {
    ctx.addIssue({ code: 'custom', path: ['targets'], message: 'compare needs distinct models' })
  }
})
export type CompareInput = z.infer<typeof CompareInputSchema>

export const ReviewInputSchema = OrchestrationBaseSchema.extend({
  /** The question. Omit only with `primaryMessageId` (re-run the review step). */
  content: contentField.optional(),
  primary: ModelTargetSchema,
  reviewer: ModelTargetSchema,
  /** Review an already-persisted primary answer instead of generating one. */
  primaryMessageId: z.string().min(1).optional(),
}).refine((input) => input.content !== undefined || input.primaryMessageId !== undefined, {
  message: 'a review needs a question or an existing primary answer',
  path: ['content'],
})
export type ReviewInput = z.infer<typeof ReviewInputSchema>

export const ApplySuggestionsInputSchema = OrchestrationBaseSchema.extend({
  primaryMessageId: z.string().min(1),
  reviewMessageId: z.string().min(1),
  /** The model that writes the revision (the primary model by default). */
  target: ModelTargetSchema,
})
export type ApplySuggestionsInput = z.infer<typeof ApplySuggestionsInputSchema>

export const RoundTableParticipantSchema = ModelTargetSchema.extend({ role: RoundTableRoleSchema })
export type RoundTableParticipant = z.infer<typeof RoundTableParticipantSchema>

export const RoundTableInputSchema = OrchestrationBaseSchema.extend({
  content: contentField,
  /** Turn order is the array order, chosen by the user. */
  participants: z
    .array(RoundTableParticipantSchema)
    .min(ROUND_TABLE_MIN_PARTICIPANTS)
    .max(ROUND_TABLE_MAX_PARTICIPANTS),
  synthesizer: ModelTargetSchema.nullable().optional(),
  rounds: z.number().int().min(1).max(ROUND_TABLE_MAX_ROUNDS).default(ROUND_TABLE_DEFAULT_ROUNDS),
}).refine((input) => input.participants[0]?.role === 'proposal', {
  message: 'the first round-table turn must be a proposal',
  path: ['participants'],
})
export type RoundTableInput = z.infer<typeof RoundTableInputSchema>

export const AutoInputSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  content: contentField,
  contextSelection: ContextSelectionSchema.optional(),
  /** Overrides the saved Auto preference for this turn. */
  preference: AutoPreferenceSchema.optional(),
})
export type AutoChatInput = z.infer<typeof AutoInputSchema>

export const RetryReplyInputSchema = z.object({
  requestId: z.string().min(1),
  /** The failed/cancelled reply to run again (it is replaced by the new one). */
  messageId: z.string().min(1),
  /** The model to run it on — the same one to `[retry]`, another for `[switch model]`.
   * Required because a stored reply records its provider, not which key it used. */
  target: ModelTargetSchema,
})
export type RetryReplyInput = z.infer<typeof RetryReplyInputSchema>

// ------------------------------------------------------------------ IPC results / events

export const OrchestrationStatusSchema = z.enum(['complete', 'error', 'cancelled'])
export type OrchestrationStatus = z.infer<typeof OrchestrationStatusSchema>

export const OrchestrationResultSchema = z.object({
  /** The persisted user turn (null when re-running a step of an existing turn). */
  userMessage: MessageSchema.nullable(),
  /** Every reply persisted by this call, in step order. */
  replies: z.array(MessageSchema),
  status: OrchestrationStatusSchema,
  error: z.string().nullable(),
})
export type OrchestrationResult = z.infer<typeof OrchestrationResultSchema>

/** Review / round-table progress, pushed over `orchestrationStreamChannel(orchestrationId)`. */
export const OrchestrationStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user-message'), message: MessageSchema }),
  z.object({
    type: z.literal('step-start'),
    step: z.number().int(),
    totalSteps: z.number().int(),
    role: RoleLabelSchema,
    provider: ProviderIdSchema,
    model: z.string(),
    round: z.number().int().nullable(),
  }),
  z.object({ type: z.literal('delta'), step: z.number().int(), delta: z.string() }),
  z.object({ type: z.literal('step-done'), step: z.number().int(), message: MessageSchema }),
  z.object({ type: z.literal('done'), result: OrchestrationResultSchema }),
])
export type OrchestrationStreamEvent = z.infer<typeof OrchestrationStreamEventSchema>
