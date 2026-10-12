import { describe, expect, it } from 'vitest'
import type { Message, ProviderModelCatalog } from '@ai-workspace/shared'
import { buildThread } from '../reply-groups'
import {
  defaultRoleAt,
  formatLatency,
  formatUsage,
  modeProblem,
  moveSlot,
  nextRole,
  replyStats,
  suggestModels,
  totalEstimatedCost,
  viewOfMessage,
  type ModeConfig,
} from '../orchestration-ui'

function message(over: Partial<Message> & { id: string }): Message {
  return {
    conversationId: 'c',
    role: 'assistant',
    provider: 'anthropic',
    model: 'm',
    status: 'complete',
    createdAt: 1,
    updatedAt: 1,
    parts: [{ id: `p-${over.id}`, messageId: over.id, type: 'text', content: `text ${over.id}`, position: 0, createdAt: 1 }],
    attachments: [],
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
    ...over,
  }
}

describe('buildThread', () => {
  it('leaves a plain chat thread as one item per message, in order', () => {
    const items = buildThread([
      message({ id: 'u1', role: 'user', provider: null, model: null }),
      message({ id: 'a1' }),
      message({ id: 'u2', role: 'user', provider: null, model: null }),
      message({ id: 'a2' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'reply', 'user', 'reply'])
    expect(items[1]).toMatchObject({ kind: 'reply', siblingCount: 1 })
  })

  it('groups compare columns into one block in column order, placed where the first reply sits', () => {
    const items = buildThread([
      message({ id: 'u', role: 'user', provider: null, model: null }),
      message({ id: 'c2', replyGroupId: 'u', orchestrationMode: 'compare', replyIndex: 2 }),
      message({ id: 'c0', replyGroupId: 'u', orchestrationMode: 'compare', replyIndex: 0, inContext: true }),
      message({ id: 'c1', replyGroupId: 'u', orchestrationMode: 'compare', replyIndex: 1, status: 'error' }),
      message({ id: 'next', role: 'user', provider: null, model: null }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'compare', 'user'])
    const compare = items[1]
    expect(compare?.kind === 'compare' && compare.replies.map((r) => r.id)).toEqual(['c0', 'c1', 'c2'])
  })

  it('separates a review into the untouched primary, the review and later revisions', () => {
    const items = buildThread([
      message({ id: 'u', role: 'user', provider: null, model: null }),
      message({ id: 'p', replyGroupId: 'u', orchestrationMode: 'review', replyIndex: 0 }),
      message({ id: 'r', replyGroupId: 'u', orchestrationMode: 'review', replyIndex: 1, roleLabel: 'review', inContext: false }),
      message({ id: 'v', replyGroupId: 'u', orchestrationMode: 'review', replyIndex: 2, roleLabel: 'revision', inContext: false }),
    ])
    expect(items).toHaveLength(2)
    const review = items[1]
    expect(review?.kind).toBe('review')
    if (review?.kind === 'review') {
      expect(review.primary?.id).toBe('p')
      expect(review.reviews.map((m) => m.id)).toEqual(['r'])
      expect(review.revisions.map((m) => m.id)).toEqual(['v'])
    }
  })

  it('turns a round table into one ordered transcript', () => {
    const items = buildThread([
      message({ id: 'u', role: 'user', provider: null, model: null }),
      message({ id: 't1', replyGroupId: 'u', orchestrationMode: 'roundtable', replyIndex: 1, roleLabel: 'critique' }),
      message({ id: 't0', replyGroupId: 'u', orchestrationMode: 'roundtable', replyIndex: 0, roleLabel: 'proposal' }),
    ])
    const table = items[1]
    expect(table?.kind === 'roundtable' && table.turns.map((t) => t.id)).toEqual(['t0', 't1'])
  })

  it('regenerated siblings (same group, normal mode) stay separate replies and report their count', () => {
    const items = buildThread([
      message({ id: 'u', role: 'user', provider: null, model: null }),
      message({ id: 'a1', replyGroupId: 'u', inContext: false }),
      message({ id: 'a2', replyGroupId: 'u', inContext: true }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'reply', 'reply'])
    expect(items[1]).toMatchObject({ siblingCount: 2 })
  })

  it('keeps Auto replies as plain replies', () => {
    const items = buildThread([
      message({ id: 'u', role: 'user', provider: null, model: null }),
      message({ id: 'a', replyGroupId: 'u', orchestrationMode: 'auto', autoReason: 'cheapest capable' }),
    ])
    expect(items.map((i) => i.kind)).toEqual(['user', 'reply'])
  })
})

describe('reply formatting', () => {
  it('formats latency', () => {
    expect(formatLatency(null)).toBeNull()
    expect(formatLatency(800)).toBe('0.8s')
    expect(formatLatency(12_400)).toBe('12s')
    expect(formatLatency(65_000)).toBe('1m 05s')
  })

  it('formats usage and omits what the provider did not report', () => {
    expect(formatUsage(null, null)).toBeNull()
    expect(formatUsage(1_800, 340)).toBe('1.8K in · 340 out')
    expect(formatUsage(120, null)).toBe('120 in')
  })

  it('stats line: cost is "—" when unknown, never invented', () => {
    const base = { latencyMs: 2_400, inputTokens: 1_800, outputTokens: 340 }
    expect(replyStats({ ...base, estCostUsd: 0.0042 })).toBe('2.4s · 1.8K in · 340 out · est. $0.0042')
    expect(replyStats({ ...base, estCostUsd: null })).toBe('2.4s · 1.8K in · 340 out · —')
    expect(replyStats({ latencyMs: null, inputTokens: null, outputTokens: null, estCostUsd: null })).toBe('—')
  })

  it('total cost sums known estimates and flags a partial sum', () => {
    expect(totalEstimatedCost([{ estCostUsd: null }, { estCostUsd: null }])).toBe('—')
    expect(totalEstimatedCost([{ estCostUsd: 0.01 }, { estCostUsd: 0.02 }])).toBe('est. $0.030')
    expect(totalEstimatedCost([{ estCostUsd: 0.01 }, { estCostUsd: null }])).toBe('est. $0.010+')
  })

  it('maps a persisted message onto a view', () => {
    const view = viewOfMessage(message({ id: 'x', status: 'error', errorText: 'boom', parts: [] }))
    expect(view).toMatchObject({ phase: 'error', errorText: 'boom', text: '', messageId: 'x' })
    expect(viewOfMessage(message({ id: 'y', status: 'cancelled' })).phase).toBe('cancelled')
  })
})

describe('suggestModels', () => {
  const catalog = (id: string, models: string[]): ProviderModelCatalog => ({
    providerConfigId: id,
    fetchedAt: null,
    models: models.map((m) => ({ id: m, displayName: null, meta: null })),
  })
  const catalogs = { a: catalog('a', ['a1', 'a2']), b: catalog('b', ['b1']), c: catalog('c', ['c1']) }

  it('prefers favorites, then recents, then each provider’s default, never repeating or excluding', () => {
    const out = suggestModels({
      catalogs,
      configIds: ['a', 'b', 'c'],
      favorites: [{ providerConfigId: 'c', model: 'c1' }],
      recents: [{ providerConfigId: 'b', model: 'b1' }],
      exclude: [{ providerConfigId: 'a', model: 'a1' }],
      count: 3,
    })
    expect(out.map((r) => r.model)).toEqual(['c1', 'b1', 'a2'])
  })

  it('ignores favorites whose key was removed and stops at the requested count', () => {
    const out = suggestModels({
      catalogs,
      configIds: ['a'],
      favorites: [{ providerConfigId: 'gone', model: 'x' }],
      recents: [],
      exclude: [],
      count: 1,
    })
    expect(out).toEqual([{ providerConfigId: 'a', model: 'a1' }])
  })
})

describe('modeProblem', () => {
  const slot = (n: number) => ({ providerConfigId: `c${n}`, model: `m${n}`, effort: null })
  const config = (over: Partial<ModeConfig>): ModeConfig => ({
    mode: 'chat',
    compare: [],
    agentId: null,
    reviewer: null,
    roundTable: [],
    synthesizer: null,
    rounds: 1,
    ...over,
  })

  it('chat needs a model; auto needs nothing', () => {
    expect(modeProblem(config({}), true)).toBeNull()
    expect(modeProblem(config({}), false)).toMatch(/choose a model/)
    expect(modeProblem(config({ mode: 'auto' }), false)).toBeNull()
  })

  it('plan and build need a model that supports tools, and a workspace folder to work in', () => {
    for (const mode of ['plan', 'build'] as const) {
      expect(modeProblem(config({ mode }), true, { toolSupport: 'yes', hasFolder: true })).toBeNull()
      // Unknown metadata (a custom endpoint) is allowed; only an explicit `tool_call: false` blocks.
      expect(modeProblem(config({ mode }), true, { toolSupport: 'unknown', hasFolder: true })).toBeNull()
      expect(modeProblem(config({ mode }), true, { toolSupport: 'no', hasFolder: true })).toMatch(/no tool support/)
      expect(modeProblem(config({ mode }), true, { toolSupport: 'yes', hasFolder: false })).toMatch(/choose one in \/code/)
      expect(modeProblem(config({ mode }), false, { toolSupport: 'yes', hasFolder: true })).toMatch(/choose a model/)
    }
  })

  it('compare needs 2-4 models', () => {
    expect(modeProblem(config({ mode: 'compare', compare: [slot(1)] }), true)).toMatch(/at least 2/)
    expect(modeProblem(config({ mode: 'compare', compare: [slot(1), slot(2)] }), true)).toBeNull()
    expect(modeProblem(config({ mode: 'compare', compare: [1, 2, 3, 4, 5].map(slot) }), true)).toMatch(/at most 4/)
  })

  it('review needs the answering model and a reviewer', () => {
    expect(modeProblem(config({ mode: 'review' }), true)).toMatch(/reviewer/)
    expect(modeProblem(config({ mode: 'review', reviewer: slot(2) }), false)).toMatch(/answers first/)
    expect(modeProblem(config({ mode: 'review', reviewer: slot(2) }), true)).toBeNull()
  })

  it('round table needs 2-4 turns starting with a proposal and 1-3 rounds', () => {
    const turn = (n: number, role: 'proposal' | 'critique' | 'alternative') => ({ ...slot(n), role })
    expect(modeProblem(config({ mode: 'roundtable', roundTable: [turn(1, 'proposal')] }), true)).toMatch(/at least 2 turns/)
    expect(modeProblem(config({ mode: 'roundtable', roundTable: [turn(1, 'critique'), turn(2, 'proposal')] }), true)).toMatch(/proposal/)
    const ok = [turn(1, 'proposal'), turn(2, 'critique')]
    expect(modeProblem(config({ mode: 'roundtable', roundTable: ok, rounds: 3 }), true)).toBeNull()
    expect(modeProblem(config({ mode: 'roundtable', roundTable: ok, rounds: 4 }), true)).toMatch(/1-3/)
    expect(modeProblem(config({ mode: 'roundtable', roundTable: ok, rounds: 0 }), true)).toMatch(/1-3/)
  })
})

describe('round table slots', () => {
  it('cycles roles and defaults proposal, critique, alternative', () => {
    expect(nextRole('proposal')).toBe('critique')
    expect(nextRole('alternative')).toBe('proposal')
    expect([0, 1, 2, 3].map(defaultRoleAt)).toEqual(['proposal', 'critique', 'alternative', 'alternative'])
  })

  it('moveSlot swaps neighbours and clamps at the ends without mutating', () => {
    const list = ['a', 'b', 'c']
    expect(moveSlot(list, 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveSlot(list, 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveSlot(list, 0, -1)).toBe(list)
    expect(moveSlot(list, 2, 1)).toBe(list)
    expect(list).toEqual(['a', 'b', 'c'])
  })
})
