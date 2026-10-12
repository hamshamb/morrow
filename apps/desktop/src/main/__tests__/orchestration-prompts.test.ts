import { describe, expect, it } from 'vitest'
import type { ModelCatalogEntry } from '@ai-workspace/shared'
import {
  buildReviewMessages,
  buildRevisionContent,
  buildRoundTableContent,
  renderTranscript,
  withFinalUserContent,
} from '../orchestration-prompts'
import { buildAutoCandidates } from '../auto-candidates'

describe('orchestration prompts', () => {
  it('the reviewer sees the question and the answer, and is told not to rewrite it', () => {
    const messages = buildReviewMessages({ question: 'Q?', answer: 'A.', answeredBy: 'm (p)' })
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(messages[0]?.content).toMatch(/Do NOT rewrite/)
    expect(messages[1]?.content).toContain('Q?')
    expect(messages[1]?.content).toContain('A.')
    expect(messages[1]?.content).toContain('m (p)')
  })

  it('withFinalUserContent swaps only the last user turn and never mutates the input', () => {
    const base = [
      { role: 'user' as const, content: 'old q' },
      { role: 'assistant' as const, content: 'old a' },
      { role: 'system' as const, content: 'ctx' },
      { role: 'user' as const, content: 'q' },
    ]
    const out = withFinalUserContent(base, 'composite')
    expect(out.map((m) => m.content)).toEqual(['old q', 'old a', 'ctx', 'composite'])
    expect(base[3]?.content).toBe('q')
  })

  it('the revision prompt carries the question, the earlier answer and the review', () => {
    const content = buildRevisionContent({ question: 'Q', answer: 'ANS', reviewer: 'rev', report: 'REPORT' })
    expect(content).toContain('Q')
    expect(content).toContain('ANS')
    expect(content).toContain('REPORT')
    expect(content).toMatch(/revised answer/)
  })

  it('round-table turns announce role and round and include the transcript', () => {
    const transcript = [{ role: 'proposal' as const, author: 'm (p)', round: 1, text: 'PLAN' }]
    expect(renderTranscript(transcript)).toBe('[PROPOSAL · round 1 · m (p)]\nPLAN')
    const critique = buildRoundTableContent({ question: 'Q', role: 'critique', round: 1, rounds: 2, transcript })
    expect(critique).toContain('round 1 of 2')
    expect(critique).toContain('your role: CRITIQUE')
    expect(critique).toContain('PLAN')
    const first = buildRoundTableContent({ question: 'Q', role: 'proposal', round: 1, rounds: 1, transcript: [] })
    expect(first).not.toContain('Discussion so far')
    const synth = buildRoundTableContent({ question: 'Q', role: 'synthesis', round: 2, rounds: 2, transcript })
    expect(synth).toContain('final synthesis')
  })
})

describe('buildAutoCandidates', () => {
  const config = (id: string, provider: string) => ({
    id,
    provider,
    label: id,
    maskedKey: 'k',
    baseUrl: null,
    createdAt: 1,
    updatedAt: 1,
  })

  it('flattens every model of every saved config, keeping metadata and display names', () => {
    const entry: ModelCatalogEntry = { id: 'm1', displayName: 'Model One', meta: null }
    const candidates = buildAutoCandidates([config('c1', 'anthropic'), config('c2', 'openai')], (id) => ({
      providerConfigId: id,
      models: id === 'c1' ? [entry, { id: 'm2', displayName: null, meta: null }] : [{ id: 'm3', displayName: null, meta: null }],
      fetchedAt: null,
    }))
    expect(candidates.map((c) => [c.providerConfigId, c.provider, c.modelId, c.name, c.hasKey])).toEqual([
      ['c1', 'anthropic', 'm1', 'Model One', true],
      ['c1', 'anthropic', 'm2', 'm2', true],
      ['c2', 'openai', 'm3', 'm3', true],
    ])
  })

  it('skips a config whose catalog cannot be read instead of failing the pick', () => {
    const candidates = buildAutoCandidates([config('bad', 'x'), config('ok', 'y')], (id) => {
      if (id === 'bad') throw new Error('gone')
      return { providerConfigId: id, models: [{ id: 'm', displayName: null, meta: null }], fetchedAt: null }
    })
    expect(candidates.map((c) => c.providerConfigId)).toEqual(['ok'])
  })
})
