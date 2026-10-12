import type { ProviderChatMessage } from '@ai-workspace/providers'
import { ROLE_LABEL_TEXT, type RoleLabel } from '@ai-workspace/shared'

/**
 * Prompt construction for review / round table / apply-suggestions. Pure
 * string functions so the exact text a model sees is unit-tested and the
 * orchestration service stays about control flow. Role instructions are
 * appended to the final user turn (not sent as extra mid-conversation system
 * messages), which every provider accepts.
 */

export const REVIEW_SYSTEM_PROMPT = [
  'You are a careful reviewer. You are given a question and another assistant\'s answer to it.',
  'Write a review report. Do NOT rewrite or replace the answer.',
  'Use exactly these sections: "Verdict" (one sentence), "Issues" (bulleted: errors, gaps, risks, unsupported claims — quote the part concerned), "Suggestions" (bulleted, concrete, actionable).',
  'If the answer is sound, say so plainly and keep the report short. Do not invent problems.',
].join('\n')

/** Messages for the reviewer: the question and the primary answer only. */
export function buildReviewMessages(opts: {
  question: string
  answer: string
  answeredBy: string
}): ProviderChatMessage[] {
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        'QUESTION',
        opts.question,
        '',
        `ANSWER TO REVIEW (written by ${opts.answeredBy})`,
        opts.answer,
      ].join('\n'),
    },
  ]
}

/** Replaces the content of the final (user) message — the question — with `content`. */
export function withFinalUserContent(messages: ProviderChatMessage[], content: string): ProviderChatMessage[] {
  const copy = messages.slice()
  const last = copy[copy.length - 1]
  if (last && last.role === 'user') copy[copy.length - 1] = { role: 'user', content }
  else copy.push({ role: 'user', content })
  return copy
}

/** The primary model's follow-up that turns a review into a revised answer. */
export function buildRevisionContent(opts: {
  question: string
  answer: string
  reviewer: string
  report: string
}): string {
  return [
    opts.question,
    '',
    '---',
    'Your earlier answer to the question above:',
    opts.answer,
    '',
    `A reviewer (${opts.reviewer}) wrote this report on it:`,
    opts.report,
    '',
    'Write a revised answer that fixes the valid issues and applies the useful suggestions. Keep what was already right. Reply with the full revised answer only, not with commentary about the changes.',
  ].join('\n')
}

export interface TranscriptTurn {
  role: RoleLabel
  /** `model (provider)` of whoever wrote it. */
  author: string
  round: number | null
  text: string
}

const ROLE_INSTRUCTIONS: Record<'proposal' | 'critique' | 'alternative' | 'synthesis', string> = {
  proposal: 'You are PROPOSING. Give your best, complete answer to the question.',
  critique:
    'You are CRITIQUING. Identify concrete flaws, risks, gaps and wrong assumptions in the latest proposal (and in any alternative). Be specific and brief. Do not rewrite the proposal.',
  alternative:
    'You are offering an ALTERNATIVE. Propose a materially different approach to the question and say when it beats the proposal.',
  synthesis:
    'You are SYNTHESIZING. Combine the strongest points of the discussion into one final answer to the question. Note any disagreement that remains, briefly.',
}

export function renderTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => {
      const round = t.round !== null ? ` · round ${t.round}` : ''
      return `[${ROLE_LABEL_TEXT[t.role]}${round} · ${t.author}]\n${t.text}`
    })
    .join('\n\n')
}

/** The final user turn for one round-table step. */
export function buildRoundTableContent(opts: {
  question: string
  role: 'proposal' | 'critique' | 'alternative' | 'synthesis'
  round: number
  rounds: number
  transcript: TranscriptTurn[]
}): string {
  const revising = opts.role === 'proposal' && opts.round > 1
  const instruction = revising
    ? 'You are REVISING your PROPOSAL. Address the critique and the alternative above where they are right, keep what holds up, and give the full revised proposal.'
    : ROLE_INSTRUCTIONS[opts.role]
  const header =
    opts.role === 'synthesis'
      ? 'ROUND TABLE · final synthesis'
      : `ROUND TABLE · round ${opts.round} of ${opts.rounds} · your role: ${ROLE_LABEL_TEXT[opts.role]}`
  const parts = [opts.question, '', '---', header, instruction]
  if (opts.transcript.length > 0) {
    parts.push('', 'Discussion so far:', renderTranscript(opts.transcript))
  }
  return parts.join('\n')
}
