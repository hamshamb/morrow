import {
  COMPARE_MAX_MODELS,
  ROUND_TABLE_MAX_PARTICIPANTS,
  ROUND_TABLE_MAX_ROUNDS,
  ROUND_TABLE_MIN_PARTICIPANTS,
  formatEstimatedCost,
  type ComposerMode,
  type Message,
  type ModelRef,
  type ProviderModelCatalog,
  type ReasoningEffort,
  type RoleLabel,
  type RoundTableRole,
} from '@ai-workspace/shared'
import { formatTokens, pickDefaultModel } from './model-meta'

/** What one reply looks like on screen, whether it is still streaming (live)
 * or already persisted — compare columns, round-table turns and review blocks
 * all render from this. */
export interface ReplyView {
  key: string
  messageId: string | null
  provider: string | null
  model: string | null
  roleLabel: RoleLabel | null
  round: number | null
  text: string
  phase: 'waiting' | 'streaming' | 'done' | 'error' | 'cancelled'
  errorText: string | null
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  estCostUsd: number | null
  inContext: boolean
}

export function viewOfMessage(message: Message): ReplyView {
  return {
    key: message.id,
    messageId: message.id,
    provider: message.provider,
    model: message.model,
    roleLabel: message.roleLabel,
    round: message.roundIndex,
    text: message.parts.map((p) => p.content).join(''),
    phase:
      message.status === 'error'
        ? 'error'
        : message.status === 'cancelled'
          ? 'cancelled'
          : message.status === 'streaming'
            ? 'streaming'
            : 'done',
    errorText: message.errorText,
    latencyMs: message.latencyMs,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
    estCostUsd: message.estCostUsd,
    inContext: message.inContext,
  }
}

/** `0.8s`, `12s`, `1m 05s`. */
export function formatLatency(ms: number | null | undefined): string | null {
  if (ms == null || ms < 0) return null
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** `1.2K in · 340 out`, or null when the provider reported nothing. */
export function formatUsage(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): string | null {
  if (inputTokens == null && outputTokens == null) return null
  const parts: string[] = []
  if (inputTokens != null) parts.push(`${formatTokens(inputTokens)} in`)
  if (outputTokens != null) parts.push(`${formatTokens(outputTokens)} out`)
  return parts.join(' · ')
}

/** `2.4s · 1.2K in · 340 out · est. $0.0042` — each part omitted when unknown;
 * the cost is `—` when the price or the usage is unknown (never invented). */
export function replyStats(view: Pick<ReplyView, 'latencyMs' | 'inputTokens' | 'outputTokens' | 'estCostUsd'>): string {
  const parts = [
    formatLatency(view.latencyMs),
    formatUsage(view.inputTokens, view.outputTokens),
    formatEstimatedCost(view.estCostUsd),
  ].filter((p): p is string => !!p)
  return parts.join(' · ')
}

/** Sum of the known estimated costs; `—` when none is known. A partial sum is
 * marked with `+` because some replies had no price or usage. */
export function totalEstimatedCost(views: Pick<ReplyView, 'estCostUsd'>[]): string {
  const known = views.filter((v) => v.estCostUsd != null)
  if (known.length === 0) return '—'
  const sum = known.reduce((acc, v) => acc + (v.estCostUsd ?? 0), 0)
  const label = formatEstimatedCost(sum)
  return known.length < views.length ? `${label}+` : label
}

// ------------------------------------------------------------------ composer mode config

export interface ModelSlot extends ModelRef {
  effort: ReasoningEffort | null
}

export interface RoundTableSlot extends ModelSlot {
  role: RoundTableRole
}

export interface ModeConfig {
  mode: ComposerMode
  /** Plan / Build: the agent to run as (null = the mode's default agent). */
  agentId: string | null
  compare: ModelSlot[]
  reviewer: ModelSlot | null
  roundTable: RoundTableSlot[]
  synthesizer: ModelSlot | null
  rounds: number
}

const sameModel = (a: ModelRef, b: ModelRef): boolean =>
  a.providerConfigId === b.providerConfigId && a.model === b.model

/**
 * Models to pre-fill a mode with: starred first, then recently used, then each
 * configured provider's default model, then anything else in the catalogs —
 * never one already in `exclude`, never a duplicate.
 */
export function suggestModels(opts: {
  catalogs: Record<string, ProviderModelCatalog>
  configIds: string[]
  favorites: ModelRef[]
  recents: ModelRef[]
  exclude: ModelRef[]
  count: number
}): ModelRef[] {
  const out: ModelRef[] = []
  const exists = (ref: ModelRef) => opts.configIds.includes(ref.providerConfigId)
  const consider = (ref: ModelRef) => {
    if (out.length >= opts.count) return
    if (!exists(ref)) return
    if (opts.exclude.some((e) => sameModel(e, ref)) || out.some((o) => sameModel(o, ref))) return
    out.push({ providerConfigId: ref.providerConfigId, model: ref.model })
  }
  for (const ref of opts.favorites) consider(ref)
  for (const ref of opts.recents) consider(ref)
  for (const configId of opts.configIds) {
    const picked = pickDefaultModel(opts.catalogs[configId]?.models ?? [])
    if (picked) consider({ providerConfigId: configId, model: picked })
  }
  for (const configId of opts.configIds) {
    for (const model of opts.catalogs[configId]?.models ?? []) consider({ providerConfigId: configId, model: model.id })
  }
  return out
}

/** Why the current mode config cannot be sent yet (null = ready). */
export function modeProblem(
  config: ModeConfig,
  hasPrimaryModel: boolean,
  agent: { toolSupport: 'yes' | 'no' | 'unknown'; hasFolder: boolean } = { toolSupport: 'unknown', hasFolder: true },
): string | null {
  switch (config.mode) {
    case 'chat':
      return hasPrimaryModel ? null : 'choose a model first'
    case 'plan':
    case 'build':
      if (!hasPrimaryModel) return 'choose a model first'
      if (agent.toolSupport === 'no') return 'this model has no tool support (models.dev tool_call: false) — pick another model, or use chat'
      if (!agent.hasFolder) return 'the agent works inside the workspace folder — choose one in /code first'
      return null
    case 'compare':
      if (config.compare.length < 2) return 'pick at least 2 models to compare'
      if (config.compare.length > COMPARE_MAX_MODELS) return `compare takes at most ${COMPARE_MAX_MODELS} models`
      return null
    case 'review':
      if (!hasPrimaryModel) return 'choose the model that answers first'
      if (!config.reviewer) return 'choose a reviewer model'
      return null
    case 'roundtable':
      if (config.roundTable.length < ROUND_TABLE_MIN_PARTICIPANTS) return 'a round table needs at least 2 turns'
      if (config.roundTable.length > ROUND_TABLE_MAX_PARTICIPANTS) return `at most ${ROUND_TABLE_MAX_PARTICIPANTS} turns`
      if (config.roundTable[0]?.role !== 'proposal') return 'the first turn must be a proposal'
      if (config.rounds < 1 || config.rounds > ROUND_TABLE_MAX_ROUNDS) return `rounds must be 1-${ROUND_TABLE_MAX_ROUNDS}`
      return null
    case 'auto':
      return null
  }
}

/** Role cycle for a round-table turn button. */
export const ROUND_TABLE_ROLES: RoundTableRole[] = ['proposal', 'critique', 'alternative']

export function nextRole(role: RoundTableRole): RoundTableRole {
  const index = ROUND_TABLE_ROLES.indexOf(role)
  return ROUND_TABLE_ROLES[(index + 1) % ROUND_TABLE_ROLES.length] ?? 'proposal'
}

/** Roles for a freshly pre-filled round table: proposal, critique, alternative, ... */
export function defaultRoleAt(index: number): RoundTableRole {
  return ROUND_TABLE_ROLES[Math.min(index, ROUND_TABLE_ROLES.length - 1)] ?? 'proposal'
}

/** Swaps entry `index` with its neighbour; the first turn stays a proposal. Pure. */
export function moveSlot<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta
  if (target < 0 || target >= list.length) return list
  const copy = list.slice()
  const a = copy[index]
  const b = copy[target]
  if (a === undefined || b === undefined) return list
  copy[index] = b
  copy[target] = a
  return copy
}
