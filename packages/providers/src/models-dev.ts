/**
 * models.dev catalog: lenient parsing, reduction and normalization.
 *
 * Data source: https://models.dev/api.json (anomalyco/models.dev, MIT). The
 * live file is ~5 MB; this module keeps only the fields the app uses, which
 * serves three jobs with one code path:
 *
 *   1. `parseModelsDevCatalog` — read an untrusted JSON document (network,
 *      disk cache, bundled snapshot) without ever throwing: malformed
 *      providers/models are skipped, not fatal.
 *   2. `trimModelsDevCatalog` — produce the small snapshot bundled for
 *      offline/first-run use (`scripts/update-models-snapshot.ts`).
 *   3. `normalizeModel` — turn a raw model into the app's `ModelMetadata`.
 *
 * The reduced shape is itself a valid subset of api.json, so a trimmed
 * snapshot and a freshly downloaded catalog are read by the same parser.
 *
 * Inspired by OpenCode's models.dev loader (MIT, Copyright (c) 2025 opencode —
 * packages/opencode/src/provider/models.ts and packages/core/src/models-dev.ts):
 * the 24h-style cache + bundled-snapshot-floor architecture and the
 * `reasoning_options` interpretation come from there; the code is
 * re-implemented without Effect/Bun.
 */
import {
  REASONING_EFFORT_VALUES,
  sortEfforts,
  type ModelMetadata,
  type ReasoningEffort,
} from '@ai-workspace/shared'

export type ModelsDevReasoningOption =
  | { type: 'toggle' }
  | { type: 'effort'; values: string[] }
  | { type: 'budget_tokens'; min?: number; max?: number }

export interface ModelsDevModel {
  id: string
  name: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  reasoning_options?: ModelsDevReasoningOption[]
  tool_call?: boolean
  structured_output?: boolean
  knowledge?: string
  release_date?: string
  modalities?: { input: string[]; output: string[] }
  open_weights?: boolean
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  status?: 'alpha' | 'beta' | 'deprecated'
  /** models.dev marks non-chat models (`embedding`, `reranking`). */
  type?: string
}

export interface ModelsDevProvider {
  id: string
  name: string
  env: string[]
  /** AI SDK package models.dev names for this provider (`@ai-sdk/anthropic`). */
  npm?: string
  /** Base URL for OpenAI-compatible providers. */
  api?: string
  doc?: string
  models: Record<string, ModelsDevModel>
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>

// ---- lenient readers -------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

function readReasoningOptions(v: unknown): ModelsDevReasoningOption[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ModelsDevReasoningOption[] = []
  for (const item of v) {
    if (!isRecord(item)) continue
    if (item.type === 'toggle') out.push({ type: 'toggle' })
    else if (item.type === 'effort') {
      // `null`/"default" appear as sentinels in the wild; keep only strings here
      // and let normalizeModel drop the non-selectable ones.
      out.push({ type: 'effort', values: strArray(item.values) })
    } else if (item.type === 'budget_tokens') {
      const min = num(item.min)
      const max = num(item.max)
      out.push({ type: 'budget_tokens', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) })
    }
  }
  return out
}

function readModel(key: string, v: unknown): ModelsDevModel | null {
  if (!isRecord(v)) return null
  const id = str(v.id) ?? key
  const name = str(v.name) ?? id
  // A per-model `provider` block means a different SDK / base URL than the
  // provider-level one (e.g. a gateway fronting Anthropic models). The
  // registry wires one transport per provider, so such models are not
  // runnable here and are dropped rather than sent to the wrong endpoint.
  if (isRecord(v.provider)) return null

  const model: ModelsDevModel = { id, name }
  const family = str(v.family)
  if (family) model.family = family
  const attachment = bool(v.attachment)
  if (attachment !== undefined) model.attachment = attachment
  const reasoning = bool(v.reasoning)
  if (reasoning !== undefined) model.reasoning = reasoning
  const options = readReasoningOptions(v.reasoning_options)
  if (options) model.reasoning_options = options
  const toolCall = bool(v.tool_call)
  if (toolCall !== undefined) model.tool_call = toolCall
  const structured = bool(v.structured_output)
  if (structured !== undefined) model.structured_output = structured
  const knowledge = str(v.knowledge)
  if (knowledge) model.knowledge = knowledge
  const release = str(v.release_date)
  if (release) model.release_date = release
  if (isRecord(v.modalities)) {
    model.modalities = { input: strArray(v.modalities.input), output: strArray(v.modalities.output) }
  }
  const openWeights = bool(v.open_weights)
  if (openWeights !== undefined) model.open_weights = openWeights
  if (isRecord(v.limit)) {
    const context = num(v.limit.context)
    const output = num(v.limit.output)
    model.limit = { ...(context !== undefined ? { context } : {}), ...(output !== undefined ? { output } : {}) }
  }
  if (isRecord(v.cost)) {
    const input = num(v.cost.input)
    const output = num(v.cost.output)
    const cacheRead = num(v.cost.cache_read)
    const cacheWrite = num(v.cost.cache_write)
    model.cost = {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}),
    }
  }
  if (v.status === 'alpha' || v.status === 'beta' || v.status === 'deprecated') model.status = v.status
  const type = str(v.type)
  if (type) model.type = type
  return model
}

/**
 * Reads a models.dev-shaped document into the reduced catalog. Never throws:
 * anything that is not a provider object with a models map is skipped.
 */
export function parseModelsDevCatalog(raw: unknown): ModelsDevCatalog {
  const catalog: ModelsDevCatalog = {}
  if (!isRecord(raw)) return catalog
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || !isRecord(value.models)) continue
    const id = str(value.id) ?? key
    const models: Record<string, ModelsDevModel> = {}
    for (const [modelKey, modelValue] of Object.entries(value.models)) {
      const model = readModel(modelKey, modelValue)
      if (model) models[model.id] = model
    }
    const provider: ModelsDevProvider = {
      id,
      name: str(value.name) ?? id,
      env: strArray(value.env),
      models,
    }
    const npm = str(value.npm)
    if (npm) provider.npm = npm
    const api = str(value.api)
    if (api) provider.api = api
    const doc = str(value.doc)
    if (doc) provider.doc = doc
    catalog[id] = provider
  }
  return catalog
}

// ---- chat-model predicate & normalization ----------------------------------

/**
 * A chat model produces text. models.dev lists image/video/audio generators,
 * embeddings and rerankers next to chat models; those are not offered in the
 * chat picker. A model with no modality data is assumed to be text.
 */
export function isChatModel(model: ModelsDevModel): boolean {
  if (model.type === 'embedding' || model.type === 'reranking') return false
  const output = model.modalities?.output
  return !output || output.length === 0 || output.includes('text')
}

export function isSelectableModel(model: ModelsDevModel): boolean {
  return isChatModel(model) && model.status !== 'deprecated'
}

const KNOWN_EFFORTS: ReadonlySet<string> = new Set(REASONING_EFFORT_VALUES)

/** Effort values the data lists for a model, sorted weakest -> strongest.
 * `default` / `null` sentinels and anything the app has no name for are dropped. */
export function modelEfforts(model: ModelsDevModel): ReasoningEffort[] {
  if (!model.reasoning) return []
  const found: ReasoningEffort[] = []
  for (const option of model.reasoning_options ?? []) {
    if (option.type !== 'effort') continue
    for (const value of option.values) if (KNOWN_EFFORTS.has(value)) found.push(value as ReasoningEffort)
  }
  return sortEfforts(found)
}

export function normalizeModel(model: ModelsDevModel): ModelMetadata {
  const options = model.reasoning_options ?? []
  const efforts = modelEfforts(model)
  const budget = options.find(
    (o): o is Extract<ModelsDevReasoningOption, { type: 'budget_tokens' }> => o.type === 'budget_tokens',
  )
  const inputModalities = model.modalities?.input ?? ['text']
  const context = model.limit?.context
  const maxOutput = model.limit?.output
  const cost = model.cost
  return {
    id: model.id,
    name: model.name,
    family: model.family ?? null,
    reasoning: model.reasoning === true,
    reasoningEfforts: efforts,
    reasoningToggle: model.reasoning === true && efforts.length === 0 && options.some((o) => o.type === 'toggle'),
    reasoningBudget: model.reasoning === true && budget ? { min: budget.min ?? null, max: budget.max ?? null } : null,
    attachment: model.attachment === true,
    vision: inputModalities.includes('image'),
    inputModalities,
    toolCall: model.tool_call === true,
    structuredOutput: model.structured_output === true,
    contextWindow: context && context > 0 ? context : null,
    maxOutput: maxOutput && maxOutput > 0 ? maxOutput : null,
    cost:
      cost && (cost.input !== undefined || cost.output !== undefined)
        ? {
            input: cost.input ?? 0,
            output: cost.output ?? 0,
            cacheRead: cost.cache_read ?? null,
            cacheWrite: cost.cache_write ?? null,
          }
        : null,
    knowledge: model.knowledge ?? null,
    releaseDate: model.release_date ?? null,
    openWeights: model.open_weights === true,
    status: model.status ?? null,
  }
}

export function countChatModels(catalog: ModelsDevCatalog): number {
  let n = 0
  for (const provider of Object.values(catalog)) {
    for (const model of Object.values(provider.models)) if (isSelectableModel(model)) n++
  }
  return n
}

// ---- trimming (offline snapshot) -------------------------------------------

export interface TrimOptions {
  /** Keep only these provider ids (undefined = every provider passing `keepProvider`). */
  providers?: readonly string[]
  /** Extra provider-level predicate (the snapshot script passes "is runnable"). */
  keepProvider?: (provider: ModelsDevProvider) => boolean
  /** Keep at most this many models per provider, newest `release_date` first. */
  maxModelsPerProvider?: number
  /** Per-provider override of `maxModelsPerProvider` (providers listed here). */
  maxModelsByProvider?: Readonly<Record<string, number>>
}

/**
 * Reduces a catalog to what the app needs: chat models only (no
 * image/video/embedding/deprecated), no descriptions, optionally capped per
 * provider (newest first) and limited to a provider allowlist. The result is
 * deterministic (sorted keys) so regenerating the snapshot produces a clean
 * diff.
 */
export function trimModelsDevCatalog(catalog: ModelsDevCatalog, options: TrimOptions = {}): ModelsDevCatalog {
  const allow = options.providers ? new Set(options.providers) : null
  const out: ModelsDevCatalog = {}
  for (const id of Object.keys(catalog).sort()) {
    const provider = catalog[id]!
    if (allow && !allow.has(id)) continue
    if (options.keepProvider && !options.keepProvider(provider)) continue
    let models = Object.values(provider.models).filter(isSelectableModel)
    if (models.length === 0) continue
    const cap = options.maxModelsByProvider?.[id] ?? options.maxModelsPerProvider
    if (cap !== undefined && models.length > cap) {
      models = [...models]
        .sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? '') || a.id.localeCompare(b.id))
        .slice(0, cap)
    }
    const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id))
    out[id] = { ...provider, models: Object.fromEntries(sorted.map((m) => [m.id, m])) }
  }
  return out
}
