import { describe, expect, it } from 'vitest'
import {
  AUTO_COMPLEX_PROMPT_CHARS,
  AUTO_OUTPUT_RESERVE_TOKENS,
  AutoInputSchema,
  CompareInputSchema,
  MessageSchema,
  ROUND_TABLE_MAX_CALLS,
  ROUND_TABLE_MAX_ROUNDS,
  ReviewInputSchema,
  RoundTableInputSchema,
  RetryReplyInputSchema,
  estimateCostUsd,
  formatAutoLine,
  formatEstimatedCost,
  isComplexPrompt,
  pickAutoModel,
  requiredModalities,
  type AutoCandidate,
  type AutoRouteInput,
  type ModelMetadata,
} from '../index'

// --------------------------------------------------------------- fixtures

function meta(over: Partial<ModelMetadata> & { id: string }): ModelMetadata {
  return {
    name: over.id,
    family: null,
    reasoning: false,
    reasoningEfforts: [],
    reasoningToggle: false,
    reasoningBudget: null,
    attachment: false,
    vision: false,
    inputModalities: ['text'],
    toolCall: true,
    structuredOutput: false,
    contextWindow: 200_000,
    maxOutput: 8_000,
    cost: { input: 1, output: 5, cacheRead: null, cacheWrite: null },
    knowledge: null,
    releaseDate: '2025-01-01',
    openWeights: false,
    status: null,
    ...over,
  }
}

function cand(
  id: string,
  over: Partial<ModelMetadata> = {},
  extra: Partial<AutoCandidate> = {},
): AutoCandidate {
  return {
    providerConfigId: `cfg-${extra.provider ?? 'p'}`,
    provider: 'p',
    modelId: id,
    name: id,
    hasKey: true,
    meta: meta({ id, ...over }),
    ...extra,
  }
}

const SHORT: AutoRouteInput = { promptText: 'hello there', estimatedContextTokens: 100, attachmentMimeTypes: [] }
const prefs = (preference: 'cheapest' | 'balanced' | 'best') => ({ preference })

// --------------------------------------------------------------- cost

describe('estimateCostUsd', () => {
  const cost = { input: 3, output: 15, cacheRead: null, cacheWrite: null }

  it('is price per 1M tokens x reported usage', () => {
    expect(estimateCostUsd(cost, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18)
    expect(estimateCostUsd(cost, { inputTokens: 2_000, outputTokens: 500 })).toBeCloseTo(0.0135, 10)
    expect(estimateCostUsd(cost, { inputTokens: 0, outputTokens: 0 })).toBe(0)
  })

  it('is null — never a made-up number — when pricing is unknown', () => {
    expect(estimateCostUsd(null, { inputTokens: 100, outputTokens: 100 })).toBeNull()
    expect(estimateCostUsd(undefined, { inputTokens: 100, outputTokens: 100 })).toBeNull()
  })

  it('is null when the provider reported no (or partial) usage', () => {
    expect(estimateCostUsd(cost, null)).toBeNull()
    expect(estimateCostUsd(cost, undefined)).toBeNull()
    expect(estimateCostUsd(cost, { inputTokens: null, outputTokens: null })).toBeNull()
    expect(estimateCostUsd(cost, { inputTokens: 100, outputTokens: null })).toBeNull()
    expect(estimateCostUsd(cost, { inputTokens: undefined, outputTokens: 5 })).toBeNull()
  })

  it('rejects nonsense usage', () => {
    expect(estimateCostUsd(cost, { inputTokens: -1, outputTokens: 5 })).toBeNull()
    expect(estimateCostUsd(cost, { inputTokens: Number.NaN, outputTokens: 5 })).toBeNull()
  })

  it('a free model with usage is $0, not unknown', () => {
    const free = { input: 0, output: 0, cacheRead: null, cacheWrite: null }
    expect(estimateCostUsd(free, { inputTokens: 500, outputTokens: 500 })).toBe(0)
  })
})

describe('formatEstimatedCost', () => {
  it('labels estimates and shows a dash for unknown', () => {
    expect(formatEstimatedCost(null)).toBe('—')
    expect(formatEstimatedCost(undefined)).toBe('—')
    expect(formatEstimatedCost(0)).toBe('est. $0')
    expect(formatEstimatedCost(0.00001)).toBe('est. <$0.0001')
    expect(formatEstimatedCost(0.0042)).toBe('est. $0.0042')
    expect(formatEstimatedCost(0.1234)).toBe('est. $0.123')
    expect(formatEstimatedCost(1.2)).toBe('est. $1.20')
  })
})

// --------------------------------------------------------------- auto

describe('isComplexPrompt', () => {
  it('is false for a short plain question', () => {
    expect(isComplexPrompt('what is the capital of France?')).toBe(false)
  })
  it('is true for a long prompt, a code fence, or a reasoning-heavy keyword', () => {
    expect(isComplexPrompt('x'.repeat(AUTO_COMPLEX_PROMPT_CHARS))).toBe(true)
    expect(isComplexPrompt('x'.repeat(AUTO_COMPLEX_PROMPT_CHARS - 1))).toBe(false)
    expect(isComplexPrompt('why does this fail?\n```ts\nfoo()\n```')).toBe(true)
    expect(isComplexPrompt('Please debug this')).toBe(true)
    expect(isComplexPrompt('explain the TRADE-OFFS here')).toBe(true)
    expect(isComplexPrompt('walk me through it step by step')).toBe(true)
  })
  it('matches whole words only', () => {
    expect(isComplexPrompt('the designer was undesignated')).toBe(false)
  })
})

describe('requiredModalities', () => {
  it('maps attachment MIME types to input modalities, deduped and sorted', () => {
    expect(requiredModalities([])).toEqual([])
    expect(requiredModalities(['text/plain', 'text/markdown'])).toEqual([])
    expect(requiredModalities(['image/png', 'IMAGE/JPEG'])).toEqual(['image'])
    expect(requiredModalities(['application/pdf', 'image/png'])).toEqual(['image', 'pdf'])
  })
})

describe('pickAutoModel — eligibility', () => {
  it('only picks models the user has a key for', () => {
    const cheapNoKey = cand('cheap', { cost: { input: 0.1, output: 0.1, cacheRead: null, cacheWrite: null } }, { hasKey: false })
    const keyed = cand('dear', { cost: { input: 9, output: 9, cacheRead: null, cacheWrite: null } })
    const result = pickAutoModel(SHORT, [cheapNoKey, keyed], prefs('cheapest'))
    expect(result.choice?.modelId).toBe('dear')
  })

  it('has no pick (and says why) when nothing is keyed or the list is empty', () => {
    const none = pickAutoModel(SHORT, [cand('a', {}, { hasKey: false })], prefs('cheapest'))
    expect(none.choice).toBeNull()
    expect(none.reason).toMatch(/no configured model/)
    expect(pickAutoModel(SHORT, [], prefs('best')).choice).toBeNull()
  })

  it('never picks a deprecated model', () => {
    const old = cand('old', { status: 'deprecated', cost: { input: 0.01, output: 0.01, cacheRead: null, cacheWrite: null } })
    const ok = cand('ok')
    expect(pickAutoModel(SHORT, [old, ok], prefs('cheapest')).choice?.modelId).toBe('ok')
    const onlyOld = pickAutoModel(SHORT, [old], prefs('cheapest'))
    expect(onlyOld.choice).toBeNull()
    expect(onlyOld.reason).toMatch(/deprecated/)
  })

  it('needs vision when an image is attached; excludes models without it', () => {
    const text = cand('text', { cost: { input: 0.1, output: 0.1, cacheRead: null, cacheWrite: null } })
    const eyes = cand('eyes', { vision: true, inputModalities: ['text', 'image'] })
    const result = pickAutoModel({ ...SHORT, attachmentMimeTypes: ['image/png'] }, [text, eyes], prefs('cheapest'))
    expect(result.choice?.modelId).toBe('eyes')
    expect(result.rules).toContain('needs vision')
    expect(result.reason).toBe('needs vision, cheapest capable')
  })

  it('accepts the flat vision flag as image support', () => {
    const flagOnly = cand('flag', { vision: true, inputModalities: ['text'] })
    expect(pickAutoModel({ ...SHORT, attachmentMimeTypes: ['image/jpeg'] }, [flagOnly], prefs('best')).choice?.modelId).toBe('flag')
  })

  it('needs pdf input for a PDF and does not treat vision as pdf support', () => {
    const vision = cand('vision', { vision: true, inputModalities: ['text', 'image'] })
    const pdf = cand('pdf', { inputModalities: ['text', 'pdf'] })
    const result = pickAutoModel({ ...SHORT, attachmentMimeTypes: ['application/pdf'] }, [vision, pdf], prefs('cheapest'))
    expect(result.choice?.modelId).toBe('pdf')
    expect(result.reason).toMatch(/needs pdf input/)
  })

  it('refuses (no pick) when no model can read the attachment — never drops it silently', () => {
    const result = pickAutoModel({ ...SHORT, attachmentMimeTypes: ['image/png'] }, [cand('a'), cand('b')], prefs('cheapest'))
    expect(result.choice).toBeNull()
    expect(result.reason).toMatch(/supports vision/)
  })

  it('excludes models whose context window cannot hold the prompt plus the answer reserve', () => {
    const small = cand('small', { contextWindow: 8_000, cost: { input: 0.1, output: 0.1, cacheRead: null, cacheWrite: null } })
    const big = cand('big', { contextWindow: 1_000_000 })
    const result = pickAutoModel({ ...SHORT, estimatedContextTokens: 6_000 }, [small, big], prefs('cheapest'))
    expect(result.choice?.modelId).toBe('big')
    expect(result.rules).toContain('fits context window')
  })

  it('context fit is inclusive at exactly the window and exclusive one token over', () => {
    const edge = cand('edge', { contextWindow: 10_000 })
    const tokensThatJustFit = 10_000 - AUTO_OUTPUT_RESERVE_TOKENS
    expect(pickAutoModel({ ...SHORT, estimatedContextTokens: tokensThatJustFit }, [edge], prefs('best')).choice?.modelId).toBe('edge')
    expect(pickAutoModel({ ...SHORT, estimatedContextTokens: tokensThatJustFit + 1 }, [edge], prefs('best')).choice).toBeNull()
  })

  it('has no pick when the prompt overflows every window', () => {
    const result = pickAutoModel({ ...SHORT, estimatedContextTokens: 500_000 }, [cand('a'), cand('b')], prefs('cheapest'))
    expect(result.choice).toBeNull()
    expect(result.reason).toMatch(/exceeds every configured model's context window/)
  })

  it('keeps a model with an unknown context window', () => {
    const unknown = cand('unknown', { contextWindow: null })
    expect(pickAutoModel({ ...SHORT, estimatedContextTokens: 900_000 }, [unknown], prefs('cheapest')).choice?.modelId).toBe('unknown')
  })

  it('combines vision and context rules in the reason', () => {
    const smallEyes = cand('small-eyes', { vision: true, inputModalities: ['text', 'image'], contextWindow: 8_000 })
    const bigEyes = cand('big-eyes', { vision: true, inputModalities: ['text', 'image'], contextWindow: 500_000 })
    const result = pickAutoModel(
      { promptText: 'look', estimatedContextTokens: 20_000, attachmentMimeTypes: ['image/png'] },
      [smallEyes, bigEyes],
      prefs('cheapest'),
    )
    expect(result.choice?.modelId).toBe('big-eyes')
    expect(result.reason).toBe('needs vision, fits context window, cheapest capable')
  })
})

describe('pickAutoModel — unrated models', () => {
  it('uses models without models.dev metadata only when nothing is rated, first by id', () => {
    const b: AutoCandidate = { providerConfigId: 'c', provider: 'ollama', modelId: 'b-local', name: 'b', hasKey: true, meta: null }
    const a: AutoCandidate = { providerConfigId: 'c', provider: 'ollama', modelId: 'a-local', name: 'a', hasKey: true, meta: null }
    const result = pickAutoModel(SHORT, [b, a], prefs('best'))
    expect(result.choice?.modelId).toBe('a-local')
    expect(result.reason).toMatch(/no models.dev metadata/)
  })

  it('prefers a rated model over an unrated one', () => {
    const unrated: AutoCandidate = { providerConfigId: 'c', provider: 'ollama', modelId: 'a', name: 'a', hasKey: true, meta: null }
    expect(pickAutoModel(SHORT, [unrated, cand('rated')], prefs('cheapest')).choice?.modelId).toBe('rated')
  })
})

describe('pickAutoModel — complexity', () => {
  const plain = cand('plain', { cost: { input: 0.5, output: 1, cacheRead: null, cacheWrite: null } })
  const thinker = cand('thinker', { reasoning: true, cost: { input: 3, output: 15, cacheRead: null, cacheWrite: null } })

  it('prefers reasoning-capable models for a complex prompt', () => {
    const result = pickAutoModel({ ...SHORT, promptText: 'please debug this race condition' }, [plain, thinker], prefs('cheapest'))
    expect(result.choice?.modelId).toBe('thinker')
    expect(result.reason).toBe('reasoning for a complex prompt, cheapest capable')
  })

  it('ignores reasoning for a simple prompt', () => {
    const result = pickAutoModel(SHORT, [plain, thinker], prefs('cheapest'))
    expect(result.choice?.modelId).toBe('plain')
    expect(result.rules).not.toContain('reasoning for a complex prompt')
  })

  it('does not constrain when no reasoning model remains', () => {
    const result = pickAutoModel({ ...SHORT, promptText: 'debug it' }, [plain], prefs('cheapest'))
    expect(result.choice?.modelId).toBe('plain')
    expect(result.rules).not.toContain('reasoning for a complex prompt')
  })
})

describe('pickAutoModel — preference', () => {
  const price = (i: number, o: number) => ({ input: i, output: o, cacheRead: null, cacheWrite: null })
  const low = cand('low', { cost: price(0.1, 0.4) })
  const mid = cand('mid', { cost: price(1, 4) })
  const high = cand('high', { cost: price(5, 25) })
  const pool = [high, low, mid] // deliberately unsorted

  it('cheapest = lowest input+output price', () => {
    expect(pickAutoModel(SHORT, pool, prefs('cheapest')).choice?.modelId).toBe('low')
    expect(pickAutoModel(SHORT, pool, prefs('cheapest')).reason).toBe('cheapest capable')
  })

  it('best = highest price tier among the capable', () => {
    const result = pickAutoModel(SHORT, pool, prefs('best'))
    expect(result.choice?.modelId).toBe('high')
    expect(result.reason).toBe('strongest capable')
  })

  it('best prefers a reasoning model over a pricier non-reasoning one', () => {
    const thinker = cand('thinker', { reasoning: true, cost: price(2, 8) })
    expect(pickAutoModel(SHORT, [high, thinker], prefs('best')).choice?.modelId).toBe('thinker')
  })

  it('balanced = the (upper) median price', () => {
    expect(pickAutoModel(SHORT, pool, prefs('balanced')).choice?.modelId).toBe('mid')
    expect(pickAutoModel(SHORT, pool, prefs('balanced')).reason).toBe('balanced price')
    // even count -> upper median
    expect(pickAutoModel(SHORT, [low, mid], prefs('balanced')).choice?.modelId).toBe('mid')
    expect(pickAutoModel(SHORT, [low, mid, high, cand('top', { cost: price(9, 40) })], prefs('balanced')).choice?.modelId).toBe('high')
  })

  it('balanced with a single capable model says so', () => {
    const result = pickAutoModel(SHORT, [mid], prefs('balanced'))
    expect(result.choice?.modelId).toBe('mid')
    expect(result.reason).toBe('only capable model')
  })

  it('unpriced models rank last for cheapest/balanced and are used for best only when none is priced', () => {
    const unpriced = cand('unpriced', { cost: null })
    expect(pickAutoModel(SHORT, [unpriced, mid], prefs('cheapest')).choice?.modelId).toBe('mid')
    expect(pickAutoModel(SHORT, [unpriced, mid], prefs('balanced')).choice?.modelId).toBe('mid')
    expect(pickAutoModel(SHORT, [unpriced, mid], prefs('best')).choice?.modelId).toBe('mid')
    expect(pickAutoModel(SHORT, [unpriced], prefs('cheapest')).choice?.modelId).toBe('unpriced')
    expect(pickAutoModel(SHORT, [unpriced], prefs('balanced')).choice?.modelId).toBe('unpriced')
  })

  it('a free model (cost 0) is the cheapest, an unpriced one is not', () => {
    const free = cand('free', { cost: price(0, 0) })
    expect(pickAutoModel(SHORT, [cand('unpriced', { cost: null }), free, low], prefs('cheapest')).choice?.modelId).toBe('free')
  })
})

describe('pickAutoModel — determinism and tie-breaks', () => {
  const same = { cost: { input: 1, output: 1, cacheRead: null, cacheWrite: null } }

  it('same input, same pick, regardless of candidate order', () => {
    const list = [cand('m-c', same), cand('m-a', same), cand('m-b', same)]
    for (const preference of ['cheapest', 'balanced', 'best'] as const) {
      const forward = pickAutoModel(SHORT, list, prefs(preference)).choice?.modelId
      const backward = pickAutoModel(SHORT, [...list].reverse(), prefs(preference)).choice?.modelId
      const shuffled = pickAutoModel(SHORT, [list[1]!, list[2]!, list[0]!], prefs(preference)).choice?.modelId
      expect(forward).toBe(backward)
      expect(forward).toBe(shuffled)
    }
  })

  it('price tie: newest release wins, then fast family (cheapest), then provider/model id', () => {
    const older = cand('older', { ...same, releaseDate: '2024-01-01' })
    const newer = cand('newer', { ...same, releaseDate: '2026-01-01' })
    expect(pickAutoModel(SHORT, [older, newer], prefs('best')).choice?.modelId).toBe('newer')

    const flash = cand('x-flash', { ...same, family: 'flash', releaseDate: '2025-01-01' })
    const pro = cand('x-pro', { ...same, family: 'pro', releaseDate: '2025-01-01' })
    expect(pickAutoModel(SHORT, [pro, flash], prefs('cheapest')).choice?.modelId).toBe('x-flash')

    const a = cand('aaa', same)
    const z = cand('zzz', same)
    expect(pickAutoModel(SHORT, [z, a], prefs('cheapest')).choice?.modelId).toBe('aaa')
  })

  it('identical models under two keys: the lower provider/config id wins', () => {
    const one = cand('shared', same, { provider: 'openai', providerConfigId: 'cfg-2' })
    const two = cand('shared', same, { provider: 'openai', providerConfigId: 'cfg-1' })
    expect(pickAutoModel(SHORT, [one, two], prefs('cheapest')).choice?.providerConfigId).toBe('cfg-1')
  })

  it('does not mutate the candidate list', () => {
    const list = [cand('b', same), cand('a', same)]
    const copy = list.map((c) => c.modelId)
    pickAutoModel(SHORT, list, prefs('cheapest'))
    expect(list.map((c) => c.modelId)).toEqual(copy)
  })
})

describe('formatAutoLine', () => {
  it('renders the transparent line shown on the message', () => {
    expect(formatAutoLine('Claude Sonnet 5', 'needs vision, cheapest capable')).toBe(
      'Auto → Claude Sonnet 5 · reason: needs vision, cheapest capable',
    )
  })
})

// --------------------------------------------------------------- schemas

const target = (n: number) => ({ providerConfigId: `cfg-${n}`, model: `model-${n}` })
const compareTarget = (n: number) => ({ ...target(n), requestId: `req-${n}` })
const base = { orchestrationId: 'o-1', conversationId: 'c-1' }

describe('CompareInputSchema', () => {
  const ok = { ...base, content: 'hi', targets: [compareTarget(1), compareTarget(2)] }

  it('accepts 2-4 distinct models', () => {
    expect(CompareInputSchema.safeParse(ok).success).toBe(true)
    expect(CompareInputSchema.safeParse({ ...ok, targets: [1, 2, 3, 4].map(compareTarget) }).success).toBe(true)
  })

  it('rejects 1 model and 5 models', () => {
    expect(CompareInputSchema.safeParse({ ...ok, targets: [compareTarget(1)] }).success).toBe(false)
    expect(CompareInputSchema.safeParse({ ...ok, targets: [1, 2, 3, 4, 5].map(compareTarget) }).success).toBe(false)
  })

  it('rejects duplicate request ids and duplicate models', () => {
    expect(CompareInputSchema.safeParse({ ...ok, targets: [compareTarget(1), { ...compareTarget(2), requestId: 'req-1' }] }).success).toBe(false)
    expect(CompareInputSchema.safeParse({ ...ok, targets: [compareTarget(1), { ...compareTarget(1), requestId: 'other' }] }).success).toBe(false)
  })

  it('rejects empty content', () => {
    expect(CompareInputSchema.safeParse({ ...ok, content: '' }).success).toBe(false)
  })
})

describe('RoundTableInputSchema — the iteration cap', () => {
  const participants = [
    { ...target(1), role: 'proposal' },
    { ...target(2), role: 'critique' },
    { ...target(3), role: 'alternative' },
  ]
  const ok = { ...base, content: 'q', participants }

  it('defaults to one round', () => {
    const parsed = RoundTableInputSchema.parse(ok)
    expect(parsed.rounds).toBe(1)
  })

  it('accepts 1..3 rounds and rejects 0, 4 and fractions', () => {
    for (const rounds of [1, 2, 3]) expect(RoundTableInputSchema.safeParse({ ...ok, rounds }).success).toBe(true)
    for (const rounds of [0, 4, 100, -1, 1.5]) expect(RoundTableInputSchema.safeParse({ ...ok, rounds }).success).toBe(false)
    expect(ROUND_TABLE_MAX_ROUNDS).toBe(3)
  })

  it('needs 2-4 participants and a proposal first', () => {
    expect(RoundTableInputSchema.safeParse({ ...ok, participants: participants.slice(0, 1) }).success).toBe(false)
    expect(RoundTableInputSchema.safeParse({ ...ok, participants: [...participants, { ...target(4), role: 'critique' }, { ...target(5), role: 'critique' }] }).success).toBe(false)
    expect(RoundTableInputSchema.safeParse({ ...ok, participants: [participants[1], participants[0]] }).success).toBe(false)
  })

  it('accepts an optional synthesizer', () => {
    expect(RoundTableInputSchema.safeParse({ ...ok, synthesizer: target(9) }).success).toBe(true)
    expect(RoundTableInputSchema.safeParse({ ...ok, synthesizer: null }).success).toBe(true)
  })

  it('the worst case is bounded', () => {
    expect(ROUND_TABLE_MAX_CALLS).toBe(13)
  })
})

describe('ReviewInputSchema / RetryReplyInputSchema / AutoInputSchema', () => {
  it('a review needs a question or an existing answer', () => {
    const input = { ...base, primary: target(1), reviewer: target(2) }
    expect(ReviewInputSchema.safeParse(input).success).toBe(false)
    expect(ReviewInputSchema.safeParse({ ...input, content: 'q' }).success).toBe(true)
    expect(ReviewInputSchema.safeParse({ ...input, primaryMessageId: 'm-1' }).success).toBe(true)
  })

  it('a retry names the model to run on', () => {
    expect(RetryReplyInputSchema.safeParse({ requestId: 'r', messageId: 'm' }).success).toBe(false)
    expect(RetryReplyInputSchema.safeParse({ requestId: 'r', messageId: 'm', target: target(1) }).success).toBe(true)
  })

  it('auto validates its preference', () => {
    const input = { requestId: 'r', conversationId: 'c', content: 'hi' }
    expect(AutoInputSchema.safeParse(input).success).toBe(true)
    expect(AutoInputSchema.safeParse({ ...input, preference: 'best' }).success).toBe(true)
    expect(AutoInputSchema.safeParse({ ...input, preference: 'fastest' }).success).toBe(false)
  })
})

describe('MessageSchema — orchestration fields default for pre-Phase-6 payloads', () => {
  it('parses a legacy message and fills the defaults', () => {
    const parsed = MessageSchema.parse({
      id: 'm',
      conversationId: 'c',
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      status: 'complete',
      createdAt: 1,
      updatedAt: 1,
      parts: [],
    })
    expect(parsed.inContext).toBe(true)
    expect(parsed.orchestrationMode).toBe('normal')
    expect(parsed.replyGroupId).toBeNull()
    expect(parsed.roleLabel).toBeNull()
    expect(parsed.autoReason).toBeNull()
    expect(parsed.estCostUsd).toBeNull()
    expect(parsed.errorText).toBeNull()
  })
})
