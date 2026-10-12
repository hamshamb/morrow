import {
  estimateCostUsd,
  pickAutoModel,
  type AutoCandidate,
  type AutoPreference,
  type ChatStreamEvent,
  type Conversation,
  type Message,
  type ModelCost,
  type ProviderConfigSummary,
  type ProviderModelCatalog,
  type RendererApi,
  type RoleLabel,
} from '@ai-workspace/shared'

/**
 * Dev-only (never bundled in production — see mock-api.ts): fixtures and mock
 * behavior for the Phase 6 orchestration modes, so every mode can be opened
 * in a browser tab and screenshotted without an Electron main process.
 */

const ORCHESTRATION_DEFAULTS = {
  replyGroupId: null,
  orchestrationMode: 'normal',
  roleLabel: null,
  inContext: true,
  autoReason: null,
  replyIndex: null,
  roundIndex: null,
  inputTokens: null,
  outputTokens: null,
  latencyMs: null,
  estCostUsd: null,
  errorText: null,
} as const

type OrchestrationKeys = keyof typeof ORCHESTRATION_DEFAULTS
/** A `Message` where the Phase 6 fields may be left out (they default). */
export type MessageSeed = Omit<Message, OrchestrationKeys> & Partial<Pick<Message, OrchestrationKeys>>

export function fillMessage(seed: MessageSeed): Message {
  return { ...ORCHESTRATION_DEFAULTS, ...seed } as Message
}

let counter = 0
const nid = (prefix: string): string => {
  counter += 1
  return `${prefix}-o${counter}`
}

function text(messageId: string, content: string, at: number): Message['parts'] {
  return content ? [{ id: nid('part'), messageId, type: 'text', content, position: 0, createdAt: at }] : []
}

function userMsg(conversationId: string, id: string, content: string, at: number, attachments: Message['attachments'] = []): Message {
  return fillMessage({
    id,
    conversationId,
    role: 'user',
    provider: null,
    model: null,
    status: 'complete',
    createdAt: at,
    updatedAt: at,
    parts: text(id, content, at),
    attachments,
  })
}

interface ReplySeed {
  id: string
  provider: string
  model: string
  content: string
  at: number
  status?: Message['status']
  mode: Message['orchestrationMode']
  group: string
  index: number
  roleLabel?: RoleLabel | null
  round?: number | null
  inContext: boolean
  latencyMs?: number
  usage?: [number, number]
  /** USD per 1M [input, output]; omitted = unknown price. */
  price?: [number, number]
  errorText?: string
  autoReason?: string
}

function reply(conversationId: string, seed: ReplySeed): Message {
  const cost: ModelCost | null = seed.price
    ? { input: seed.price[0], output: seed.price[1], cacheRead: null, cacheWrite: null }
    : null
  const usage = seed.usage ? { inputTokens: seed.usage[0], outputTokens: seed.usage[1] } : null
  return fillMessage({
    id: seed.id,
    conversationId,
    role: 'assistant',
    provider: seed.provider,
    model: seed.model,
    status: seed.status ?? 'complete',
    createdAt: seed.at,
    updatedAt: seed.at,
    parts: text(seed.id, seed.content, seed.at),
    attachments: [],
    replyGroupId: seed.group,
    orchestrationMode: seed.mode,
    roleLabel: seed.roleLabel ?? null,
    inContext: seed.inContext,
    replyIndex: seed.index,
    roundIndex: seed.round ?? null,
    autoReason: seed.autoReason ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    latencyMs: seed.latencyMs ?? null,
    estCostUsd: estimateCostUsd(cost, usage),
    errorText: seed.errorText ?? null,
  })
}

const CACHE_SONNET = `Use a **two-tier cache**: a small in-process LRU in front of Redis.

1. **In-process LRU** (per server instance) holds hot sessions for 30–60 seconds. It absorbs repeated lookups inside a single request burst and costs no network hop.
2. **Redis** is the shared source of truth. Key sessions by \`session:{id}\`, store a compact JSON payload, and set the TTL to the session lifetime so expiry is automatic.

\`\`\`ts
const local = new LRUCache<string, Session>({ max: 5_000, ttl: 45_000 })

export async function getSession(id: string) {
  const hit = local.get(id)
  if (hit) return hit
  const raw = await redis.get(\`session:\${id}\`)
  if (!raw) return null
  const session = JSON.parse(raw) as Session
  local.set(id, session)
  return session
}
\`\`\`

**Invalidate on write**: publish the session id on a Redis channel so other instances drop their local copy. Without that, a revoked session stays valid for up to the LRU TTL — keep the TTL short enough that this is acceptable.`

const CACHE_GPT = `I'd keep it simpler: **cache in Redis only**, and add the in-process layer later if profiling shows the network hop matters.

- One cache means one invalidation path. Revoking a session is a single \`DEL\`, immediately visible everywhere.
- Redis round trips are ~0.3 ms inside a region — far below the cost of the database query you are avoiding.
- Use \`GET\` + \`EXPIRE\` with a sliding TTL so active sessions stay warm.

If you do need a local layer, make it opt-in per route and keep its TTL under 10 seconds.`

const REVIEW_PRIMARY = `Yes — on modern Postgres (11+) adding a \`NOT NULL\` column **with a constant default** is a metadata-only change, so it is safe on a 40M-row table.

\`\`\`sql
ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free';
\`\`\`

The default is stored in the catalog and applied lazily when rows are read, so there is no table rewrite. The statement still needs a brief \`ACCESS EXCLUSIVE\` lock, so set a lock timeout and retry if it cannot get the lock:

\`\`\`sql
SET lock_timeout = '3s';
\`\`\``

const REVIEW_REPORT = `**Verdict.** Mostly correct, but it overstates the safety.

**Issues**
- "Safe" is only true for a *constant* default. A volatile default such as \`now()\` or \`gen_random_uuid()\` still rewrites the whole table on versions before 17 — the answer does not say so.
- It does not mention that a long-running transaction holding a lock on \`users\` makes the \`ALTER\` queue, and every query behind it then queues too.
- No mention of the replica lag risk if the migration is wrapped in a larger transaction.

**Suggestions**
- State the constant-default condition explicitly and name the volatile-default exception.
- Add a \`lock_timeout\` plus a retry loop to the example, and say to check \`pg_stat_activity\` for long transactions first.
- Recommend running it outside a wrapping transaction.`

const RT_PROPOSAL = `**Proposal: a modular monolith first.** Keep one deployable, but enforce module boundaries now — separate packages, no cross-module table access, and an internal interface for every dependency.

- Cheapest to operate: one pipeline, one database, one on-call surface.
- Boundaries become real seams, so a module can be extracted later with a mechanical change.
- Revisit only when a module has a different scaling profile or an independent team owns it.`

const RT_CRITIQUE = `**The weak points:**

- "Enforce boundaries" is the hard part and the proposal gives no mechanism. Without a lint rule or build-time check, boundaries erode within a quarter.
- A shared database is the real coupling. Schema ownership per module is not mentioned.
- It assumes the team is small. If two teams already block each other on releases, the single deployable is the bottleneck, not the architecture.`

const RT_ALTERNATIVE = `**Alternative: extract exactly one service now** — the one with a different load shape (here, the image-processing worker) — and keep everything else together.

That gets real operational experience with a network boundary, a separate deploy and tracing across services, at the cost of a single extraction rather than a full migration. If it goes badly, the blast radius is one module.`

const RT_SYNTHESIS = `**Recommendation:** modular monolith **plus** one deliberate extraction.

1. Make the boundaries enforceable first: per-module schema ownership and a dependency lint that fails the build.
2. Extract the image-processing worker as the pilot service. It already scales differently, so the cost is justified.
3. Defer splitting anything else until a module has an owning team or a scaling need that the monolith cannot meet.

*Disagreement left open:* the critique argues release contention may already justify more services — measure deploy-queue time for a month before deciding.`

const AUTO_REPLY = `The screenshot shows a **404 from the \`/api/sessions/refresh\` route** — the request is being sent to a path that no longer exists after the middleware move.

The handler now lives at \`/api/auth/refresh\`. Update the fetch URL in \`session-client.ts\` (line 41) and the 404 goes away.`

/** Fixture conversations for every orchestration mode (with their messages). */
export function orchestrationFixtures(now: number, hour: number): {
  conversations: Conversation[]
  messages: Record<string, Message[]>
} {
  const conv = (id: string, title: string, ageH: number): Conversation => ({
    id,
    workspaceId: 'ws-website',
    title,
    createdAt: now - ageH * hour,
    updatedAt: now - (ageH - 0.2) * hour,
  })

  // --- compare: 3 columns, the first chosen, the third failed -----------------
  const cmp = 'conv-compare'
  const cmpUser = 'm-cmp-user'
  const t0 = now - 3 * hour
  const compare: Message[] = [
    userMsg(cmp, cmpUser, "What's the best way to cache session lookups in a Next.js app?", t0),
    reply(cmp, {
      id: 'm-cmp-0', provider: 'anthropic', model: 'claude-sonnet-5', content: CACHE_SONNET, at: t0 + 3_000,
      mode: 'compare', group: cmpUser, index: 0, inContext: true, latencyMs: 3_240, usage: [1_840, 612], price: [3, 15],
    }),
    reply(cmp, {
      id: 'm-cmp-1', provider: 'openai', model: 'gpt-5.6', content: CACHE_GPT, at: t0 + 4_000,
      mode: 'compare', group: cmpUser, index: 1, inContext: false, latencyMs: 4_105, usage: [1_790, 388], price: [2.5, 15],
    }),
    reply(cmp, {
      id: 'm-cmp-2', provider: 'google', model: 'gemini-3.5-flash', content: '', at: t0 + 1_200, status: 'error',
      mode: 'compare', group: cmpUser, index: 2, inContext: false, latencyMs: 1_190,
      errorText: '429 {"error":{"code":429,"message":"Quota exceeded for metric generate_content_requests_per_minute","status":"RESOURCE_EXHAUSTED"}}',
    }),
  ]

  // --- review ----------------------------------------------------------------
  const rev = 'conv-review'
  const revUser = 'm-rev-user'
  const t1 = now - 5 * hour
  const review: Message[] = [
    userMsg(rev, revUser, 'Is it safe to add a NOT NULL column with a default to a 40M-row Postgres table in production?', t1),
    reply(rev, {
      id: 'm-rev-0', provider: 'anthropic', model: 'claude-sonnet-5', content: REVIEW_PRIMARY, at: t1 + 3_000,
      mode: 'review', group: revUser, index: 0, inContext: true, latencyMs: 2_880, usage: [210, 330], price: [3, 15],
    }),
    reply(rev, {
      id: 'm-rev-1', provider: 'openai', model: 'gpt-5.6', content: REVIEW_REPORT, at: t1 + 9_000,
      mode: 'review', group: revUser, index: 1, roleLabel: 'review', inContext: false, latencyMs: 5_920, usage: [690, 410], price: [2.5, 15],
    }),
  ]

  // --- round table -----------------------------------------------------------
  const rt = 'conv-roundtable'
  const rtUser = 'm-rt-user'
  const t2 = now - 7 * hour
  const roundtable: Message[] = [
    userMsg(rt, rtUser, 'Should we split the monolith into services, or keep a modular monolith?', t2),
    reply(rt, { id: 'm-rt-0', provider: 'anthropic', model: 'claude-sonnet-5', content: RT_PROPOSAL, at: t2 + 3_000, mode: 'roundtable', group: rtUser, index: 0, roleLabel: 'proposal', round: 1, inContext: false, latencyMs: 2_600, usage: [180, 190], price: [3, 15] }),
    reply(rt, { id: 'm-rt-1', provider: 'openai', model: 'gpt-5.6', content: RT_CRITIQUE, at: t2 + 8_000, mode: 'roundtable', group: rtUser, index: 1, roleLabel: 'critique', round: 1, inContext: false, latencyMs: 3_900, usage: [520, 240], price: [2.5, 15] }),
    reply(rt, { id: 'm-rt-2', provider: 'google', model: 'gemini-3.5-flash', content: RT_ALTERNATIVE, at: t2 + 12_000, mode: 'roundtable', group: rtUser, index: 2, roleLabel: 'alternative', round: 1, inContext: false, latencyMs: 1_800, usage: [790, 150], price: [0.3, 2.5] }),
    reply(rt, { id: 'm-rt-3', provider: 'anthropic', model: 'claude-opus-5-5', content: RT_SYNTHESIS, at: t2 + 18_000, mode: 'roundtable', group: rtUser, index: 3, roleLabel: 'synthesis', round: 1, inContext: true, latencyMs: 6_300, usage: [1_240, 310], price: [15, 75] }),
  ]

  // --- auto ------------------------------------------------------------------
  const auto = 'conv-auto'
  const autoUser = 'm-auto-user'
  const t3 = now - 9 * hour
  const autoMessages: Message[] = [
    userMsg(auto, autoUser, 'Why is this request failing? Screenshot attached.', t3, [
      { id: 'att-auto', messageId: autoUser, filename: 'network-tab.png', mimeType: 'image/png', sizeBytes: 148_300, content: '', createdAt: t3 },
    ]),
    reply(auto, {
      id: 'm-auto-0', provider: 'anthropic', model: 'claude-sonnet-5', content: AUTO_REPLY, at: t3 + 4_000,
      mode: 'auto', group: autoUser, index: 0, inContext: true, latencyMs: 2_150, usage: [1_120, 96], price: [3, 15],
      autoReason: 'needs vision, cheapest capable',
    }),
  ]

  return {
    conversations: [
      conv(cmp, 'Compare: session caching', 3),
      conv(rev, 'Review: Postgres migration', 5),
      conv(rt, 'Round table: monolith or services', 7),
      conv(auto, 'Auto: failing request', 9),
    ],
    messages: { [cmp]: compare, [rev]: review, [rt]: roundtable, [auto]: autoMessages },
  }
}

// ---------------------------------------------------------------------- behavior

export interface OrchestrationMockContext {
  messages: Record<string, Message[]>
  providerConfigs: ProviderConfigSummary[]
  modelCatalogs: Record<string, ProviderModelCatalog>
  streamListeners: Map<string, (event: ChatStreamEvent) => void>
  getAutoPreference: () => AutoPreference
  nextId: (prefix: string) => string
}

type ChatApiAdditions = Pick<
  RendererApi['chat'],
  | 'compare'
  | 'review'
  | 'applySuggestions'
  | 'roundTable'
  | 'auto'
  | 'retryReply'
  | 'setInContext'
  | 'cancelOrchestration'
  | 'onOrchestrationEvent'
>

/** Request / orchestration ids the user asked to stop (shared with the mock `chat.cancel`). */
export const cancelledIds = new Set<string>()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** `?failmodel=gemini-3.5-flash` makes that model fail in compare/retry. */
const FAIL_MODEL = new URLSearchParams(window.location.search).get('failmodel')

const SAMPLE =
  'Here is a short mock answer. It streams in word by word so that the columns, the review block and the round table can be seen filling in. Nothing here came from a real model.'

export function createOrchestrationMock(ctx: OrchestrationMockContext): ChatApiAdditions {
  const orchestrationListeners = new Map<string, (event: Parameters<Parameters<RendererApi['chat']['onOrchestrationEvent']>[1]>[0]) => void>()
  const cancelled = cancelledIds

  const providerOf = (configId: string): string => ctx.providerConfigs.find((c) => c.id === configId)?.provider ?? 'anthropic'
  const priceOf = (configId: string, model: string): ModelCost | null =>
    ctx.modelCatalogs[configId]?.models.find((m) => m.id === model)?.meta?.cost ?? null

  const add = (conversationId: string, message: Message) => {
    ctx.messages[conversationId] = [...(ctx.messages[conversationId] ?? []), message]
  }

  function persistUser(conversationId: string, content: string): Message {
    const id = ctx.nextId('msg')
    const message = userMsg(conversationId, id, content, Date.now())
    add(conversationId, message)
    return message
  }

  /** Streams `content` through `emit` word by word; stops early when `isCancelled()`. */
  async function streamWords(content: string, emit: (delta: string) => void, isCancelled: () => boolean, pace = 22): Promise<string> {
    let out = ''
    for (const word of content.split(' ')) {
      if (isCancelled()) break
      await sleep(pace)
      const piece = `${word} `
      out += piece
      emit(piece)
    }
    return out
  }

  function persistReply(
    conversationId: string,
    seed: Omit<ReplySeed, 'id' | 'at' | 'provider'> & { configId: string; startedAt: number },
  ): Message {
    const price = priceOf(seed.configId, seed.model)
    const message = reply(conversationId, {
      ...seed,
      id: ctx.nextId('msg'),
      at: Date.now(),
      provider: providerOf(seed.configId),
      latencyMs: Date.now() - seed.startedAt,
      ...(seed.usage ? { usage: seed.usage } : {}),
      ...(price ? { price: [price.input, price.output] as [number, number] } : {}),
    })
    add(conversationId, message)
    return message
  }

  function chooseReply(messageId: string): Message[] {
    let groupId: string | null = null
    let conversationId = ''
    for (const [cid, list] of Object.entries(ctx.messages)) {
      const hit = list.find((m) => m.id === messageId)
      if (hit) {
        groupId = hit.replyGroupId
        conversationId = cid
      }
    }
    const list = ctx.messages[conversationId] ?? []
    ctx.messages[conversationId] = list.map((m) =>
      m.role === 'assistant' && (m.id === messageId || (groupId && m.replyGroupId === groupId))
        ? { ...m, inContext: m.id === messageId }
        : m,
    )
    return (ctx.messages[conversationId] ?? []).filter((m) => m.id === messageId || (groupId !== null && m.replyGroupId === groupId && m.role === 'assistant'))
  }

  async function runColumn(
    conversationId: string,
    group: string,
    index: number,
    target: { requestId: string; providerConfigId: string; model: string },
    isCancelled: () => boolean,
  ): Promise<Message> {
    const listener = ctx.streamListeners.get(target.requestId)
    const provider = providerOf(target.providerConfigId)
    const startedAt = Date.now()
    listener?.({ type: 'start', provider, model: target.model, autoReason: null })
    await sleep(80 + index * 70)
    if (FAIL_MODEL && target.model === FAIL_MODEL) {
      await sleep(250)
      const errorText = '429 {"error":{"message":"Quota exceeded for requests per minute"}}'
      listener?.({ type: 'error', message: errorText })
      const failed = persistReply(conversationId, {
        configId: target.providerConfigId, startedAt, model: target.model, content: '', status: 'error',
        mode: 'compare', group, index, inContext: false, errorText,
      })
      listener?.({ type: 'done', message: failed })
      return failed
    }
    const body = `${target.model}: ${SAMPLE}`
    const streamed = await streamWords(body, (delta) => listener?.({ type: 'delta', delta }), isCancelled, 18 + index * 9)
    const wasCancelled = isCancelled()
    const message = persistReply(conversationId, {
      configId: target.providerConfigId, startedAt, model: target.model, content: streamed.trim(),
      status: wasCancelled ? 'cancelled' : 'complete', mode: 'compare', group, index, inContext: false,
      usage: [400 + index * 90, Math.round(streamed.length / 4)],
    })
    listener?.({ type: 'done', message })
    return message
  }

  const emitOrchestration = (id: string, event: Parameters<NonNullable<ReturnType<typeof orchestrationListeners.get>>>[0]) =>
    orchestrationListeners.get(id)?.(event)

  async function runStep(
    orchestrationId: string,
    conversationId: string,
    step: number,
    total: number,
    role: RoleLabel,
    round: number | null,
    target: { providerConfigId: string; model: string },
    persist: { mode: Message['orchestrationMode']; group: string; index: number; roleLabel: RoleLabel | null; inContext: boolean },
    content: string,
  ): Promise<Message> {
    const provider = providerOf(target.providerConfigId)
    const startedAt = Date.now()
    emitOrchestration(orchestrationId, { type: 'step-start', step, totalSteps: total, role, provider, model: target.model, round })
    await sleep(100)
    const streamed = await streamWords(content, (delta) => emitOrchestration(orchestrationId, { type: 'delta', step, delta }), () => cancelled.has(orchestrationId), 16)
    const wasCancelled = cancelled.has(orchestrationId)
    const message = persistReply(conversationId, {
      configId: target.providerConfigId, startedAt, model: target.model, content: streamed.trim(),
      status: wasCancelled ? 'cancelled' : 'complete', mode: persist.mode, group: persist.group, index: persist.index,
      roleLabel: persist.roleLabel, round, inContext: persist.inContext, usage: [500, Math.round(streamed.length / 4)],
    })
    emitOrchestration(orchestrationId, { type: 'step-done', step, message })
    return message
  }

  const doneResult = (user: Message | null, replies: Message[], wasCancelled: boolean) => ({
    userMessage: user,
    replies,
    status: wasCancelled ? ('cancelled' as const) : ('complete' as const),
    error: null,
  })

  return {
    compare: async (input) => {
      const user = persistUser(input.conversationId, input.content)
      const replies = await Promise.all(
        input.targets.map((t, i) => runColumn(input.conversationId, user.id, i, t, () => cancelled.has(input.orchestrationId) || cancelled.has(t.requestId))),
      )
      const first = replies.find((r) => r.status === 'complete')
      if (first) chooseReply(first.id)
      const wasCancelled = cancelled.delete(input.orchestrationId)
      const fresh = (ctx.messages[input.conversationId] ?? []).filter((m) => m.replyGroupId === user.id)
      return doneResult(user, fresh, wasCancelled)
    },

    review: async (input) => {
      const orchestrationId = input.orchestrationId
      let user: Message | null = null
      let primary: Message
      const replies: Message[] = []
      if (input.primaryMessageId) {
        const found = Object.values(ctx.messages).flat().find((m) => m.id === input.primaryMessageId)
        if (!found) throw new Error('Message not found')
        primary = found
        ctx.messages[input.conversationId] = (ctx.messages[input.conversationId] ?? []).filter(
          (m) => !(m.replyGroupId === primary.replyGroupId && m.roleLabel === 'review' && m.status !== 'complete'),
        )
      } else {
        user = persistUser(input.conversationId, input.content ?? '')
        emitOrchestration(orchestrationId, { type: 'user-message', message: user })
        const target = input.primary
        if (!target) throw new Error('A review needs a primary model.')
        primary = await runStep(orchestrationId, input.conversationId, 0, 2, 'proposal', null, target, { mode: 'review', group: user.id, index: 0, roleLabel: null, inContext: true }, `${target.model}: ${SAMPLE}`)
        replies.push(primary)
      }
      if (!cancelled.has(orchestrationId) && primary.replyGroupId) {
        const report = await runStep(orchestrationId, input.conversationId, input.primaryMessageId ? 0 : 1, input.primaryMessageId ? 1 : 2, 'review', null, input.reviewer, { mode: 'review', group: primary.replyGroupId, index: 5, roleLabel: 'review', inContext: false }, REVIEW_REPORT)
        replies.push(report)
      }
      const wasCancelled = cancelled.delete(orchestrationId)
      const result = doneResult(user, replies, wasCancelled)
      emitOrchestration(orchestrationId, { type: 'done', result })
      return result
    },

    applySuggestions: async (input) => {
      const primary = Object.values(ctx.messages).flat().find((m) => m.id === input.primaryMessageId)
      if (!primary?.replyGroupId) throw new Error('Message not found')
      const revision = await runStep(input.orchestrationId, input.conversationId, 0, 1, 'revision', null, input.target, { mode: 'review', group: primary.replyGroupId, index: 9, roleLabel: 'revision', inContext: false }, `${REVIEW_PRIMARY}\n\n**Revised:** only a constant default avoids the rewrite; set a lock timeout and check for long transactions first.`)
      const wasCancelled = cancelled.delete(input.orchestrationId)
      const result = doneResult(null, [revision], wasCancelled)
      emitOrchestration(input.orchestrationId, { type: 'done', result })
      return result
    },

    roundTable: async (input) => {
      const user = persistUser(input.conversationId, input.content)
      emitOrchestration(input.orchestrationId, { type: 'user-message', message: user })
      const steps = [
        ...Array.from({ length: input.rounds }, (_, r) => input.participants.map((p) => ({ role: p.role as RoleLabel, target: p, round: r + 1 }))).flat(),
        ...(input.synthesizer ? [{ role: 'synthesis' as RoleLabel, target: input.synthesizer, round: input.rounds }] : []),
      ]
      const replies: Message[] = []
      for (const [i, step] of steps.entries()) {
        if (cancelled.has(input.orchestrationId)) break
        const content = { proposal: RT_PROPOSAL, critique: RT_CRITIQUE, alternative: RT_ALTERNATIVE, synthesis: RT_SYNTHESIS, review: '', revision: '' }[step.role]
        const message = await runStep(input.orchestrationId, input.conversationId, i, steps.length, step.role, step.round, step.target, { mode: 'roundtable', group: user.id, index: i, roleLabel: step.role, inContext: false }, content)
        replies.push(message)
      }
      const last = [...replies].reverse().find((r) => r.status === 'complete')
      const synth = replies.find((r) => r.roleLabel === 'synthesis' && r.status === 'complete')
      if (synth ?? last) chooseReply((synth ?? last)!.id)
      const wasCancelled = cancelled.delete(input.orchestrationId)
      const result = doneResult(user, (ctx.messages[input.conversationId] ?? []).filter((m) => m.replyGroupId === user.id), wasCancelled)
      emitOrchestration(input.orchestrationId, { type: 'done', result })
      return result
    },

    auto: async (input) => {
      const attachments = input.contextSelection?.attachments ?? []
      const candidates: AutoCandidate[] = ctx.providerConfigs.flatMap((config) =>
        (ctx.modelCatalogs[config.id]?.models ?? []).map((m) => ({
          providerConfigId: config.id,
          provider: config.provider,
          modelId: m.id,
          name: m.displayName ?? m.meta?.name ?? m.id,
          hasKey: true,
          meta: m.meta ?? null,
        })),
      )
      const picked = pickAutoModel(
        { promptText: input.content, estimatedContextTokens: Math.ceil(input.content.length / 4), attachmentMimeTypes: attachments.map((a) => a.mimeType) },
        candidates,
        { preference: input.preference ?? ctx.getAutoPreference() },
      )
      if (!picked.choice) throw new Error(`Auto could not pick a model: ${picked.reason}.`)
      const listener = ctx.streamListeners.get(input.requestId)
      const user = persistUser(input.conversationId, input.content)
      const startedAt = Date.now()
      listener?.({ type: 'start', provider: picked.choice.provider, model: picked.choice.modelId, autoReason: picked.reason })
      const streamed = await streamWords(`${picked.choice.modelId}: ${SAMPLE}`, (delta) => listener?.({ type: 'delta', delta }), () => false)
      const message = persistReply(input.conversationId, {
        configId: picked.choice.providerConfigId, startedAt, model: picked.choice.modelId, content: streamed.trim(),
        mode: 'auto', group: user.id, index: 0, inContext: true, autoReason: picked.reason, usage: [320, Math.round(streamed.length / 4)],
      })
      listener?.({ type: 'done', message })
      return message
    },

    retryReply: async (input) => {
      const failed = Object.values(ctx.messages).flat().find((m) => m.id === input.messageId)
      if (!failed?.replyGroupId) throw new Error('Message not found')
      const listener = ctx.streamListeners.get(input.requestId)
      const provider = providerOf(input.target.providerConfigId)
      const startedAt = Date.now()
      listener?.({ type: 'start', provider, model: input.target.model, autoReason: null })
      const streamed = await streamWords(`${input.target.model}: ${SAMPLE}`, (delta) => listener?.({ type: 'delta', delta }), () => false)
      const fresh = persistReply(failed.conversationId, {
        configId: input.target.providerConfigId, startedAt, model: input.target.model, content: streamed.trim(),
        mode: failed.orchestrationMode, group: failed.replyGroupId, index: failed.replyIndex ?? 0, inContext: false, usage: [410, 120],
      })
      ctx.messages[failed.conversationId] = (ctx.messages[failed.conversationId] ?? []).filter((m) => m.id !== failed.id)
      const group = (ctx.messages[failed.conversationId] ?? []).filter((m) => m.replyGroupId === failed.replyGroupId && m.role === 'assistant')
      if (!group.some((m) => m.inContext)) chooseReply(fresh.id)
      listener?.({ type: 'done', message: fresh })
      return fresh
    },

    setInContext: async (messageId) => chooseReply(messageId),

    cancelOrchestration: async (orchestrationId) => {
      cancelled.add(orchestrationId)
    },

    onOrchestrationEvent: (orchestrationId, listener) => {
      orchestrationListeners.set(orchestrationId, listener)
      return () => orchestrationListeners.delete(orchestrationId)
    },
  }
}
