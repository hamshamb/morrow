import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConversationRepository,
  MessageRepository,
  WorkspaceRepository,
  openDatabase,
  type AppDatabase,
} from '@ai-workspace/storage'
import {
  createMockProvider,
  type MockProviderOptions,
  type ProviderChatMessage,
  type ProviderChatRequest,
} from '@ai-workspace/providers'
import {
  ROUND_TABLE_MAX_CALLS,
  type AutoCandidate,
  type ChatStreamEvent,
  type Message,
  type ModelMetadata,
  type OrchestrationStreamEvent,
  type RoundTableInput,
} from '@ai-workspace/shared'
import { ChatService } from '../chat-service'
import { OrchestrationLimitError, OrchestrationService } from '../orchestration-service'

// --------------------------------------------------------------- harness

interface ProviderSpec {
  providerId: string
  options?: Omit<MockProviderOptions, 'id' | 'respond'>
  /** Static chunks, or a function of the request. */
  respond?: MockProviderOptions['respond']
  meta?: Partial<ModelMetadata>
  /** Make resolveProvider itself throw for this config. */
  unresolvable?: boolean
}

interface Call {
  configId: string
  model: string
  messages: ProviderChatMessage[]
}

function meta(over: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'm',
    name: 'M',
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
    cost: { input: 2, output: 10, cacheRead: null, cacheWrite: null },
    knowledge: null,
    releaseDate: '2026-01-01',
    openWeights: false,
    status: null,
    ...over,
  }
}

const textOf = (m: Message): string => m.parts.map((p) => p.content).join('')

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('OrchestrationService (integration, mock providers — no network)', () => {
  let db: AppDatabase
  let conversations: ConversationRepository
  let messages: MessageRepository
  let conversationId: string
  let calls: Call[]
  let specs: Record<string, ProviderSpec>
  let chat: ChatService
  let candidates: AutoCandidate[]
  let autoPreference: 'cheapest' | 'balanced' | 'best'
  let orchestration: OrchestrationService
  let seq: number

  beforeEach(() => {
    db = openDatabase(':memory:')
    const workspaceId = new WorkspaceRepository(db).create({ name: 'W' }).id
    conversations = new ConversationRepository(db)
    messages = new MessageRepository(db)
    conversationId = conversations.create({ workspaceId }).id
    calls = []
    seq = 0
    specs = {
      a: { providerId: 'anthropic' },
      b: { providerId: 'openai' },
      c: { providerId: 'google' },
      d: { providerId: 'xai' },
      e: { providerId: 'groq' },
    }
    candidates = []
    autoPreference = 'balanced'
    chat = new ChatService({
      conversations,
      messages,
      resolveProvider: (configId) => {
        const spec = specs[configId]
        if (!spec || spec.unresolvable) throw new Error(`Provider config not found: ${configId}`)
        const respond = (request: ProviderChatRequest): string[] => {
          calls.push({ configId, model: request.model, messages: request.messages })
          const configured = spec.respond
          if (typeof configured === 'function') return configured(request)
          return configured ?? [`reply from ${configId}/${request.model}`]
        }
        return {
          provider: spec.providerId,
          chatProvider: createMockProvider({ id: spec.providerId, ...spec.options, respond }),
          getModelMeta: () => meta(spec.meta),
        }
      },
    })
    orchestration = new OrchestrationService({
      chat,
      conversations,
      messages,
      listAutoCandidates: () => candidates,
      getAutoPreference: () => autoPreference,
    })
  })

  afterEach(() => {
    db.close()
  })

  const target = (configId: string, model = `${configId}-model`) => ({ providerConfigId: configId, model })
  const cmpTarget = (configId: string, model = `${configId}-model`) => ({
    ...target(configId, model),
    requestId: `req-${configId}`,
  })
  const oid = () => `orch-${++seq}`

  async function compare(configIds: string[], content = 'which is better?') {
    const events: Record<string, ChatStreamEvent[]> = {}
    const result = await orchestration.compare(
      {
        orchestrationId: oid(),
        conversationId,
        content,
        targets: configIds.map((id) => cmpTarget(id)),
      },
      (requestId, event) => (events[requestId] ??= []).push(event),
    )
    return { result, events }
  }

  // ------------------------------------------------------------- compare

  describe('compare', () => {
    it('persists one user turn and one reply per model, all in the same reply group', async () => {
      const { result } = await compare(['a', 'b', 'c'])
      expect(result.status).toBe('complete')
      expect(result.userMessage?.role).toBe('user')
      expect(result.replies).toHaveLength(3)
      expect(result.replies.map((r) => r.model)).toEqual(['a-model', 'b-model', 'c-model'])
      expect(result.replies.map((r) => r.provider)).toEqual(['anthropic', 'openai', 'google'])
      for (const reply of result.replies) {
        expect(reply.replyGroupId).toBe(result.userMessage?.id)
        expect(reply.orchestrationMode).toBe('compare')
      }
      expect(result.replies.map((r) => r.replyIndex)).toEqual([0, 1, 2])
      const thread = messages.listByConversation(conversationId)
      expect(thread.filter((m) => m.role === 'user')).toHaveLength(1)
      expect(thread.filter((m) => m.role === 'assistant')).toHaveLength(3)
    })

    it('streams the models concurrently, not one after another', async () => {
      // A cannot produce its first chunk until B has *started*. A sequential
      // implementation would never start B and this test would time out.
      const bStarted = deferred()
      specs.a!.options = { beforeChunk: () => bStarted.promise }
      specs.b!.options = {
        beforeChunk: () => {
          bStarted.resolve()
        },
      }
      const { result } = await compare(['a', 'b'])
      expect(result.replies.map((r) => r.status)).toEqual(['complete', 'complete'])
    })

    it('gives every column its own stream channel with start, delta and done events', async () => {
      specs.a!.respond = ['one ', 'two']
      specs.b!.respond = ['alpha']
      const { events } = await compare(['a', 'b'])
      expect(Object.keys(events).sort()).toEqual(['req-a', 'req-b'])
      expect(events['req-a']!.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done'])
      expect(events['req-b']!.map((e) => e.type)).toEqual(['start', 'delta', 'done'])
      const start = events['req-a']![0]
      expect(start).toMatchObject({ type: 'start', provider: 'anthropic', model: 'a-model', autoReason: null })
      const done = events['req-b']!.at(-1)
      expect(done?.type === 'done' && textOf(done.message)).toBe('alpha')
    })

    it('one failing column does not stop the others, and says why', async () => {
      specs.b!.options = { failWith: 'HTTP 429: rate limited' }
      const { result, events } = await compare(['a', 'b', 'c'])
      expect(result.status).toBe('complete')
      const [a, b, c] = result.replies
      expect(a?.status).toBe('complete')
      expect(textOf(a!)).toBe('reply from a/a-model')
      expect(b?.status).toBe('error')
      expect(b?.errorText).toBe('HTTP 429: rate limited')
      expect(c?.status).toBe('complete')
      expect(textOf(c!)).toBe('reply from c/c-model')
      expect(events['req-b']!.some((e) => e.type === 'error')).toBe(true)
      expect(events['req-a']!.some((e) => e.type === 'error')).toBe(false)
    })

    it('a column whose provider cannot even be resolved becomes an error reply, not an exception', async () => {
      specs.b!.unresolvable = true
      const { result } = await compare(['a', 'b', 'c'])
      expect(result.replies.map((r) => r.status)).toEqual(['complete', 'error', 'complete'])
      expect(result.replies[1]?.errorText).toMatch(/not found/)
      expect(result.replies[1]?.provider).toBeNull()
    })

    it('when every column fails the whole result is an error', async () => {
      specs.a!.options = { failWith: 'boom' }
      specs.b!.options = { failWith: 'boom' }
      const { result } = await compare(['a', 'b'])
      expect(result.status).toBe('error')
      expect(result.error).toBe('boom')
      expect(result.replies.every((r) => !r.inContext)).toBe(true)
    })

    it('the first column is the default in-context reply — by column order, not finish order', async () => {
      const aMayFinish = deferred()
      specs.a!.options = { beforeChunk: () => aMayFinish.promise }
      specs.b!.options = {
        beforeChunk: async () => {
          // b is done long before a gets going
          setTimeout(() => aMayFinish.resolve(), 20)
        },
      }
      const { result } = await compare(['a', 'b', 'c'])
      expect(result.replies.map((r) => [r.model, r.inContext])).toEqual([
        ['a-model', true],
        ['b-model', false],
        ['c-model', false],
      ])
    })

    it('if the first column failed, the first column that succeeded is the default', async () => {
      specs.a!.options = { failWith: 'down' }
      const { result } = await compare(['a', 'b', 'c'])
      expect(result.replies.map((r) => r.inContext)).toEqual([false, true, false])
    })

    it('stores usage and an estimated cost from the model price; unknown price stays null', async () => {
      specs.a!.options = { usage: { inputTokens: 1_000, outputTokens: 500 } }
      specs.a!.meta = { cost: { input: 3, output: 15, cacheRead: null, cacheWrite: null } }
      specs.b!.options = { usage: { inputTokens: 1_000, outputTokens: 500 } }
      specs.b!.meta = { cost: null }
      specs.c!.meta = { cost: { input: 3, output: 15, cacheRead: null, cacheWrite: null } } // no usage reported
      const { result } = await compare(['a', 'b', 'c'])
      const [a, b, c] = result.replies
      expect(a).toMatchObject({ inputTokens: 1_000, outputTokens: 500 })
      expect(a?.estCostUsd).toBeCloseTo(0.0105, 10)
      expect(b).toMatchObject({ inputTokens: 1_000, outputTokens: 500, estCostUsd: null })
      expect(c).toMatchObject({ inputTokens: null, outputTokens: null, estCostUsd: null })
      for (const r of result.replies) expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('rejects fewer than 2 or more than 4 models without persisting anything', async () => {
      const run = (ids: string[]) =>
        orchestration.compare(
          { orchestrationId: oid(), conversationId, content: 'q', targets: ids.map((id) => cmpTarget(id)) },
          () => undefined,
        )
      await expect(run(['a'])).rejects.toBeInstanceOf(OrchestrationLimitError)
      await expect(run(['a', 'b', 'c', 'd', 'e'])).rejects.toBeInstanceOf(OrchestrationLimitError)
      expect(messages.listByConversation(conversationId)).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })

    it('cancel-all stops every running column; each is persisted as cancelled with its partial text', async () => {
      const started = deferred()
      let startedCount = 0
      const slow = (chunks: string[]): NonNullable<ProviderSpec['options']> => ({
        beforeChunk: async (index, request) => {
          if (index === 1) {
            startedCount += 1
            if (startedCount === 2) started.resolve()
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener('abort', () => resolve(), { once: true })
              if (request.signal?.aborted) resolve()
            })
          }
          void chunks
        },
      })
      specs.a!.respond = ['partial ', 'never']
      specs.a!.options = slow(['partial ', 'never'])
      specs.b!.respond = ['half ', 'never']
      specs.b!.options = slow(['half ', 'never'])
      const id = oid()
      const running = orchestration.compare(
        { orchestrationId: id, conversationId, content: 'q', targets: [cmpTarget('a'), cmpTarget('b')] },
        () => undefined,
      )
      await started.promise
      orchestration.cancelOrchestration(id)
      const result = await running
      expect(result.status).toBe('cancelled')
      expect(result.replies.map((r) => r.status)).toEqual(['cancelled', 'cancelled'])
      expect(textOf(result.replies[0]!)).toBe('partial ')
      expect(textOf(result.replies[1]!)).toBe('half ')
    })

    it('a single column can be cancelled alone (its requestId) while the others finish', async () => {
      const started = deferred()
      specs.a!.respond = ['x ', 'y']
      specs.a!.options = {
        beforeChunk: async (index, request) => {
          if (index === 1) {
            started.resolve()
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener('abort', () => resolve(), { once: true })
              if (request.signal?.aborted) resolve()
            })
          }
        },
      }
      const running = orchestration.compare(
        { orchestrationId: oid(), conversationId, content: 'q', targets: [cmpTarget('a'), cmpTarget('b')] },
        () => undefined,
      )
      await started.promise
      chat.cancel('req-a')
      const result = await running
      expect(result.replies.map((r) => r.status)).toEqual(['cancelled', 'complete'])
      expect(result.status).toBe('complete')
    })

    it('refuses to start the same orchestration id twice at once', async () => {
      const gate = deferred()
      specs.a!.options = { beforeChunk: () => gate.promise }
      const id = oid()
      const first = orchestration.compare(
        { orchestrationId: id, conversationId, content: 'q', targets: [cmpTarget('a'), cmpTarget('b')] },
        () => undefined,
      )
      await expect(
        orchestration.compare(
          { orchestrationId: id, conversationId, content: 'q', targets: [cmpTarget('c'), cmpTarget('d')] },
          () => undefined,
        ),
      ).rejects.toThrow(/already running/)
      gate.resolve()
      await first
    })
  })

  // ------------------------------------------------------------- in-context semantics

  describe('history replay honors in_context', () => {
    it('after a compare, the next turn sends only the chosen reply — never the siblings', async () => {
      specs.a!.respond = ['ANSWER-A']
      specs.b!.respond = ['ANSWER-B']
      specs.c!.respond = ['ANSWER-C']
      await compare(['a', 'b', 'c'], 'first question')
      calls.length = 0

      await chat.sendMessage(
        { requestId: 'r-next', conversationId, providerConfigId: 'd', model: 'next', content: 'follow up' },
        () => undefined,
      )
      const sent = calls[0]!.messages.map((m) => m.content)
      expect(sent).toEqual(['first question', 'ANSWER-A', 'follow up'])
      expect(sent.join('\n')).not.toMatch(/ANSWER-B|ANSWER-C/)
    })

    it('[continue with this] switches which sibling later turns see', async () => {
      specs.a!.respond = ['ANSWER-A']
      specs.b!.respond = ['ANSWER-B']
      const { result } = await compare(['a', 'b'], 'q1')
      const b = result.replies[1]!
      const group = orchestration.setInContext(b.id)
      expect(group.map((m) => [m.model, m.inContext])).toEqual([
        ['a-model', false],
        ['b-model', true],
      ])
      calls.length = 0
      await chat.sendMessage(
        { requestId: 'r-2', conversationId, providerConfigId: 'c', model: 'x', content: 'q2' },
        () => undefined,
      )
      expect(calls[0]!.messages.map((m) => m.content)).toEqual(['q1', 'ANSWER-B', 'q2'])
      // the excluded sibling is still persisted and visible
      expect(messages.get(result.replies[0]!.id)?.parts[0]?.content).toBe('ANSWER-A')
    })

    it('legacy rows (no group, in_context default) are replayed exactly as before', async () => {
      messages.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [{ type: 'text', content: 'old q' }] })
      messages.create({ conversationId, role: 'assistant', provider: 'openai', model: 'gpt', status: 'complete', parts: [{ type: 'text', content: 'old a' }] })
      await chat.sendMessage(
        { requestId: 'r-3', conversationId, providerConfigId: 'a', model: 'x', content: 'new q' },
        () => undefined,
      )
      expect(calls[0]!.messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'old q'],
        ['assistant', 'old a'],
        ['user', 'new q'],
      ])
    })

    it('a failed empty reply is not replayed as an empty assistant turn', async () => {
      specs.a!.options = { failWith: 'down' }
      specs.a!.respond = []
      await chat.sendMessage({ requestId: 'r-f', conversationId, providerConfigId: 'a', model: 'x', content: 'q1' }, () => undefined)
      calls.length = 0
      await chat.sendMessage({ requestId: 'r-g', conversationId, providerConfigId: 'b', model: 'x', content: 'q2' }, () => undefined)
      expect(calls[0]!.messages.map((m) => m.content)).toEqual(['q1', 'q2'])
    })

    it('[regenerate] answers the same user turn again as a sibling and swaps the context', async () => {
      specs.a!.respond = ['FIRST']
      const first = await chat.sendMessage({ requestId: 'r-1', conversationId, providerConfigId: 'a', model: 'x', content: 'ask' }, () => undefined)
      const userId = first.replyGroupId!
      specs.b!.respond = ['SECOND']
      const second = await chat.sendMessage(
        { requestId: 'r-2', conversationId, providerConfigId: 'b', model: 'y', content: 'ask', regenerateOfMessageId: userId },
        () => undefined,
      )
      const thread = messages.listByConversation(conversationId)
      expect(thread.filter((m) => m.role === 'user')).toHaveLength(1) // no duplicated question
      expect(second.replyGroupId).toBe(userId)
      expect(messages.get(first.id)?.inContext).toBe(false)
      expect(messages.get(second.id)?.inContext).toBe(true)
      calls.length = 0
      await chat.sendMessage({ requestId: 'r-3', conversationId, providerConfigId: 'c', model: 'z', content: 'next' }, () => undefined)
      expect(calls[0]!.messages.map((m) => m.content)).toEqual(['ask', 'SECOND', 'next'])
    })

    it('a failed regenerate leaves the earlier reply in context', async () => {
      const first = await chat.sendMessage({ requestId: 'r-1', conversationId, providerConfigId: 'a', model: 'x', content: 'ask' }, () => undefined)
      specs.b!.options = { failWith: 'nope' }
      specs.b!.respond = []
      const failed = await chat.sendMessage(
        { requestId: 'r-2', conversationId, providerConfigId: 'b', model: 'y', content: 'ask', regenerateOfMessageId: first.replyGroupId! },
        () => undefined,
      )
      expect(failed.status).toBe('error')
      expect(messages.get(first.id)?.inContext).toBe(true)
    })

    it('regenerate refuses a message that is not a user turn of this conversation', async () => {
      const first = await chat.sendMessage({ requestId: 'r-1', conversationId, providerConfigId: 'a', model: 'x', content: 'ask' }, () => undefined)
      await expect(
        chat.sendMessage({ requestId: 'r-2', conversationId, providerConfigId: 'a', model: 'x', content: 'ask', regenerateOfMessageId: first.id }, () => undefined),
      ).rejects.toThrow(/not found/)
    })
  })

  // ------------------------------------------------------------- review

  describe('review', () => {
    async function review(over: Partial<Parameters<OrchestrationService['review']>[0]> = {}) {
      const events: OrchestrationStreamEvent[] = []
      const result = await orchestration.review(
        {
          orchestrationId: oid(),
          conversationId,
          content: 'is 17 prime?',
          primary: target('a', 'primary'),
          reviewer: target('b', 'reviewer'),
          ...over,
        },
        (e) => events.push(e),
      )
      return { result, events }
    }

    it('the primary answers first; the reviewer gets the question and that answer and writes a separate report', async () => {
      specs.a!.respond = ['Yes, 17 is prime.']
      specs.b!.respond = ['Verdict: correct.\nIssues: none.\nSuggestions: none.']
      const { result } = await review()
      expect(result.status).toBe('complete')
      const [primary, report] = result.replies
      expect(textOf(primary!)).toBe('Yes, 17 is prime.')
      expect(primary).toMatchObject({ model: 'primary', roleLabel: null, orchestrationMode: 'review', inContext: true })
      expect(report).toMatchObject({ model: 'reviewer', roleLabel: 'review', orchestrationMode: 'review', inContext: false })
      expect(report?.replyGroupId).toBe(primary?.replyGroupId)

      const reviewerCall = calls.find((c) => c.configId === 'b')!
      const sent = reviewerCall.messages.map((m) => m.content).join('\n')
      expect(reviewerCall.messages[0]?.role).toBe('system')
      expect(sent).toContain('is 17 prime?')
      expect(sent).toContain('Yes, 17 is prime.')
    })

    it('NEVER modifies the primary answer — before, during or after the review', async () => {
      specs.a!.respond = ['The answer is 42.']
      specs.b!.respond = ['This answer is wrong. It should be 41.']
      const seenWhileReviewing: Message[] = []
      specs.b!.options = {
        beforeChunk: () => {
          const group = messages.listByConversation(conversationId).filter((m) => m.role === 'assistant')
          seenWhileReviewing.push(...group)
        },
      }
      const { result } = await review()
      const primary = result.replies[0]!
      const stored = messages.get(primary.id)!
      expect(stored).toEqual(primary) // byte-for-byte what was first persisted
      expect(textOf(stored)).toBe('The answer is 42.')
      expect(stored.updatedAt).toBe(primary.updatedAt)
      expect(seenWhileReviewing.map(textOf)).toEqual(['The answer is 42.'])
      expect(messages.listByConversation(conversationId).filter((m) => m.role === 'assistant')).toHaveLength(2)
    })

    it('does not call the reviewer when the primary fails', async () => {
      specs.a!.options = { failWith: 'primary down' }
      const { result } = await review()
      expect(result.status).toBe('error')
      expect(result.replies).toHaveLength(1)
      expect(calls.filter((c) => c.configId === 'b')).toHaveLength(0)
    })

    it('a failing reviewer leaves the primary answer intact and reports the error on the review message', async () => {
      specs.b!.options = { failWith: 'reviewer down' }
      const { result } = await review()
      const [primary, report] = result.replies
      expect(primary?.status).toBe('complete')
      expect(report?.status).toBe('error')
      expect(report?.errorText).toBe('reviewer down')
    })

    it('streams step events for each phase over the orchestration channel', async () => {
      const { events } = await review()
      expect(events.map((e) => e.type)).toEqual([
        'user-message',
        'step-start',
        'delta',
        'step-done',
        'step-start',
        'delta',
        'step-done',
        'done',
      ])
      const starts = events.filter((e) => e.type === 'step-start')
      expect(starts.map((e) => e.type === 'step-start' && e.role)).toEqual(['proposal', 'review'])
    })

    it('the review is not part of the next turn’s context; the primary is', async () => {
      specs.a!.respond = ['PRIMARY']
      specs.b!.respond = ['REVIEW TEXT']
      await review()
      calls.length = 0
      await chat.sendMessage({ requestId: 'r', conversationId, providerConfigId: 'c', model: 'x', content: 'thanks' }, () => undefined)
      expect(calls[0]!.messages.map((m) => m.content)).toEqual(['is 17 prime?', 'PRIMARY', 'thanks'])
    })

    it('[apply suggestions] creates a NEW sibling reply and leaves the original and the review untouched', async () => {
      specs.a!.respond = ['draft v1']
      specs.b!.respond = ['Verdict: weak. Suggestions: add an example.']
      const { result } = await review()
      const [primary, report] = result.replies
      specs.a!.respond = ['draft v2 with an example']
      const events: OrchestrationStreamEvent[] = []
      const applied = await orchestration.applySuggestions(
        {
          orchestrationId: oid(),
          conversationId,
          primaryMessageId: primary!.id,
          reviewMessageId: report!.id,
          target: target('a', 'primary'),
        },
        (e) => events.push(e),
      )
      const revision = applied.replies[0]!
      expect(revision.id).not.toBe(primary!.id)
      expect(textOf(revision)).toBe('draft v2 with an example')
      expect(revision).toMatchObject({ roleLabel: 'revision', replyGroupId: primary!.replyGroupId, inContext: false })
      expect(messages.get(primary!.id)).toEqual(primary)
      expect(messages.get(report!.id)).toEqual(report)

      const sent = calls.at(-1)!.messages.at(-1)!.content
      expect(sent).toContain('is 17 prime?')
      expect(sent).toContain('draft v1')
      expect(sent).toContain('add an example')
    })

    it('[apply suggestions] refuses a review that belongs to another answer or is unfinished', async () => {
      specs.b!.options = { failWith: 'x' }
      const { result } = await review()
      const [primary, report] = result.replies
      await expect(
        orchestration.applySuggestions(
          { orchestrationId: oid(), conversationId, primaryMessageId: primary!.id, reviewMessageId: report!.id, target: target('a') },
          () => undefined,
        ),
      ).rejects.toThrow(/no finished review/)
      await expect(
        orchestration.applySuggestions(
          { orchestrationId: oid(), conversationId, primaryMessageId: primary!.id, reviewMessageId: 'ghost', target: target('a') },
          () => undefined,
        ),
      ).rejects.toThrow(/no longer exists/)
    })

    it('retrying a failed review reuses the primary answer and replaces the failed report', async () => {
      specs.b!.options = { failWith: 'flaky' }
      const first = await review()
      const primary = first.result.replies[0]!
      const failed = first.result.replies[1]!
      specs.b!.options = {}
      specs.b!.respond = ['second try worked']
      calls.length = 0
      const retry = await review({ content: undefined, primaryMessageId: primary.id })
      expect(calls.filter((c) => c.configId === 'a')).toHaveLength(0) // primary not re-asked
      expect(retry.result.replies).toHaveLength(1)
      expect(textOf(retry.result.replies[0]!)).toBe('second try worked')
      expect(messages.get(failed.id)).toBeNull()
      expect(messages.get(primary.id)).toEqual(primary)
    })

    it('cancelling during the review keeps the finished primary and stops', async () => {
      const reviewStarted = deferred()
      specs.b!.respond = ['part one ', 'part two']
      specs.b!.options = {
        beforeChunk: async (index, request) => {
          if (index === 1) {
            reviewStarted.resolve()
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener('abort', () => resolve(), { once: true })
              if (request.signal?.aborted) resolve()
            })
          }
        },
      }
      const id = oid()
      const running = orchestration.review(
        { orchestrationId: id, conversationId, content: 'q', primary: target('a'), reviewer: target('b') },
        () => undefined,
      )
      await reviewStarted.promise
      orchestration.cancelOrchestration(id)
      const result = await running
      expect(result.status).toBe('cancelled')
      expect(result.replies[0]?.status).toBe('complete')
      expect(result.replies[1]?.status).toBe('cancelled')
    })
  })

  // ------------------------------------------------------------- round table

  describe('round table', () => {
    const roles = [
      { ...target('a', 'proposer'), role: 'proposal' as const },
      { ...target('b', 'critic'), role: 'critique' as const },
      { ...target('c', 'contrarian'), role: 'alternative' as const },
    ]
    const table = (over: Partial<RoundTableInput> = {}): RoundTableInput => ({
      orchestrationId: oid(),
      conversationId,
      content: 'rewrite or refactor?',
      participants: roles,
      rounds: 1,
      ...over,
    })
    async function run(input: RoundTableInput) {
      const events: OrchestrationStreamEvent[] = []
      const result = await orchestration.roundTable(input, (e) => events.push(e))
      return { result, events }
    }

    it('runs the participants in the user’s order, each labelled with its role', async () => {
      const { result } = await run(table())
      expect(result.status).toBe('complete')
      expect(result.replies.map((r) => [r.model, r.roleLabel, r.roundIndex, r.replyIndex])).toEqual([
        ['proposer', 'proposal', 1, 0],
        ['critic', 'critique', 1, 1],
        ['contrarian', 'alternative', 1, 2],
      ])
      expect(result.replies.every((r) => r.orchestrationMode === 'roundtable')).toBe(true)
      expect(new Set(result.replies.map((r) => r.replyGroupId)).size).toBe(1)
    })

    it('is strictly sequential and each turn sees the transcript so far', async () => {
      specs.a!.respond = ['PROPOSAL-TEXT']
      specs.b!.respond = ['CRITIQUE-TEXT']
      specs.c!.respond = ['ALTERNATIVE-TEXT']
      await run(table())
      expect(calls.map((c) => c.configId)).toEqual(['a', 'b', 'c'])
      const last = (i: number) => calls[i]!.messages.at(-1)!.content
      expect(last(0)).toContain('rewrite or refactor?')
      expect(last(0)).not.toContain('PROPOSAL-TEXT')
      expect(last(1)).toContain('PROPOSAL-TEXT')
      expect(last(1)).toContain('your role: CRITIQUE')
      expect(last(2)).toContain('PROPOSAL-TEXT')
      expect(last(2)).toContain('CRITIQUE-TEXT')
      expect(last(2)).toContain('your role: ALTERNATIVE')
    })

    it('an optional synthesizer closes the table and becomes the in-context reply', async () => {
      const { result } = await run(table({ synthesizer: target('d', 'synth') }))
      expect(result.replies.map((r) => r.roleLabel)).toEqual(['proposal', 'critique', 'alternative', 'synthesis'])
      expect(result.replies.map((r) => r.inContext)).toEqual([false, false, false, true])
      expect(calls.at(-1)!.messages.at(-1)!.content).toContain('final synthesis')
    })

    it('without a synthesizer the last finished turn is the in-context reply', async () => {
      const { result } = await run(table())
      expect(result.replies.map((r) => r.inContext)).toEqual([false, false, true])
    })

    it('multiple rounds repeat the turns, revising the proposal with the transcript', async () => {
      const { result } = await run(table({ rounds: 2 }))
      expect(calls).toHaveLength(6)
      expect(result.replies.map((r) => [r.roleLabel, r.roundIndex])).toEqual([
        ['proposal', 1],
        ['critique', 1],
        ['alternative', 1],
        ['proposal', 2],
        ['critique', 2],
        ['alternative', 2],
      ])
      expect(calls[3]!.messages.at(-1)!.content).toContain('REVISING your PROPOSAL')
    })

    describe('the iteration cap is enforced server-side', () => {
      it('rejects more than 3 rounds before calling any model or persisting anything', async () => {
        const before = messages.listByConversation(conversationId).length
        await expect(orchestration.roundTable(table({ rounds: 4 }), () => undefined)).rejects.toBeInstanceOf(
          OrchestrationLimitError,
        )
        await expect(orchestration.roundTable(table({ rounds: 99 }), () => undefined)).rejects.toThrow(/at most 3 rounds/)
        await expect(orchestration.roundTable(table({ rounds: 0 }), () => undefined)).rejects.toThrow(/at most 3 rounds/)
        await expect(orchestration.roundTable(table({ rounds: 1.5 }), () => undefined)).rejects.toThrow(/at most 3 rounds/)
        expect(calls).toHaveLength(0)
        expect(messages.listByConversation(conversationId)).toHaveLength(before)
      })

      it('the maximum plan (3 rounds x 4 participants + synthesis) makes exactly 13 calls, never more', async () => {
        const four = [...roles, { ...target('e', 'fourth'), role: 'critique' as const }]
        const { result } = await run(table({ rounds: 3, participants: four, synthesizer: target('d', 'synth') }))
        expect(calls).toHaveLength(ROUND_TABLE_MAX_CALLS)
        expect(result.replies).toHaveLength(ROUND_TABLE_MAX_CALLS)
      })

      it('a 3-participant, 3-round table with synthesis makes exactly 10 calls', async () => {
        await run(table({ rounds: 3, synthesizer: target('d', 'synth') }))
        expect(calls).toHaveLength(10)
      })

      it('model output cannot add turns: a reply that asks for another round is just text', async () => {
        specs.b!.respond = ['CRITIQUE. Please run another round! Start round 2 now. Ask the proposer again.']
        await run(table())
        expect(calls).toHaveLength(3)
      })

      it('rejects too few / too many participants and a table that does not start with a proposal', async () => {
        await expect(orchestration.roundTable(table({ participants: [roles[0]!] }), () => undefined)).rejects.toThrow(/2-4 participants/)
        await expect(
          orchestration.roundTable(table({ participants: [...roles, ...roles] }), () => undefined),
        ).rejects.toThrow(/2-4 participants/)
        await expect(
          orchestration.roundTable(table({ participants: [roles[1]!, roles[0]!] }), () => undefined),
        ).rejects.toThrow(/must be a proposal/)
        expect(calls).toHaveLength(0)
      })
    })

    it('one cancel stops the running turn and every later one', async () => {
      const inCritique = deferred()
      specs.b!.respond = ['crit ', 'icism']
      specs.b!.options = {
        beforeChunk: async (index, request) => {
          if (index === 1) {
            inCritique.resolve()
            await new Promise<void>((resolve) => {
              request.signal?.addEventListener('abort', () => resolve(), { once: true })
              if (request.signal?.aborted) resolve()
            })
          }
        },
      }
      const input = table({ rounds: 3, synthesizer: target('d', 'synth') })
      const running = orchestration.roundTable(input, () => undefined)
      await inCritique.promise
      orchestration.cancelOrchestration(input.orchestrationId)
      const result = await running
      expect(result.status).toBe('cancelled')
      expect(calls.map((c) => c.configId)).toEqual(['a', 'b']) // alternative, later rounds and synthesis never ran
      expect(result.replies.map((r) => r.status)).toEqual(['complete', 'cancelled'])
    })

    it('a failed turn ends the table; what finished stays', async () => {
      specs.b!.options = { failWith: 'critic offline' }
      const { result } = await run(table())
      expect(result.status).toBe('error')
      expect(result.error).toBe('critic offline')
      expect(result.replies.map((r) => r.status)).toEqual(['complete', 'error'])
      expect(calls.map((c) => c.configId)).toEqual(['a', 'b'])
      expect(result.replies[0]?.inContext).toBe(true)
    })

    it('the user message and every step are mirrored as events', async () => {
      const { events } = await run(table())
      expect(events.map((e) => e.type)).toEqual([
        'user-message',
        ...Array(3).fill(['step-start', 'delta', 'step-done']).flat(),
        'done',
      ])
      const first = events.find((e) => e.type === 'step-start')
      expect(first).toMatchObject({ step: 0, totalSteps: 3, role: 'proposal', model: 'proposer', round: 1 })
    })
  })

  // ------------------------------------------------------------- auto

  describe('auto', () => {
    const cheap: AutoCandidate = {
      providerConfigId: 'a',
      provider: 'anthropic',
      modelId: 'haiku',
      name: 'Haiku',
      hasKey: true,
      meta: meta({ id: 'haiku', cost: { input: 1, output: 5, cacheRead: null, cacheWrite: null } }),
    }
    const eyes: AutoCandidate = {
      providerConfigId: 'b',
      provider: 'openai',
      modelId: 'gpt-vision',
      name: 'GPT Vision',
      hasKey: true,
      meta: meta({ id: 'gpt-vision', vision: true, inputModalities: ['text', 'image'], cost: { input: 2, output: 10, cacheRead: null, cacheWrite: null } }),
    }

    it('answers on the model the rules picked and records mode + reason on the message', async () => {
      candidates = [eyes, cheap]
      autoPreference = 'cheapest'
      const events: ChatStreamEvent[] = []
      const reply = await orchestration.auto({ requestId: 'ra', conversationId, content: 'hi' }, (e) => events.push(e))
      expect(reply).toMatchObject({
        provider: 'anthropic',
        model: 'haiku',
        orchestrationMode: 'auto',
        autoReason: 'cheapest capable',
      })
      expect(events[0]).toMatchObject({ type: 'start', model: 'haiku', autoReason: 'cheapest capable' })
      expect(calls).toEqual([expect.objectContaining({ configId: 'a', model: 'haiku' })])
    })

    it('an image attachment forces a vision model and says so', async () => {
      candidates = [cheap, eyes]
      autoPreference = 'cheapest'
      const reply = await orchestration.auto(
        {
          requestId: 'rb',
          conversationId,
          content: 'what is in this picture?',
          contextSelection: {
            includeHistory: true,
            attachments: [{ filename: 'cat.png', mimeType: 'image/png', sizeBytes: 10, content: 'x' }],
            workspaceFilePaths: [],
            retrievalSnippetPaths: [],
          },
        },
        () => undefined,
      )
      expect(reply.model).toBe('gpt-vision')
      expect(reply.autoReason).toBe('needs vision, cheapest capable')
    })

    it('uses the saved preference, and a per-turn preference overrides it', async () => {
      candidates = [cheap, eyes]
      autoPreference = 'best'
      expect((await orchestration.auto({ requestId: 'r1', conversationId, content: 'hi' }, () => undefined)).model).toBe('gpt-vision')
      expect(
        (await orchestration.auto({ requestId: 'r2', conversationId, content: 'hi', preference: 'cheapest' }, () => undefined)).model,
      ).toBe('haiku')
    })

    it('refuses with the reason when no configured model qualifies, and persists nothing', async () => {
      candidates = [{ ...cheap, hasKey: false }]
      await expect(orchestration.auto({ requestId: 'rc', conversationId, content: 'hi' }, () => undefined)).rejects.toThrow(
        /Auto could not pick a model: no configured model/,
      )
      expect(messages.listByConversation(conversationId)).toHaveLength(0)
    })

    it('counts only in-context history toward the context estimate (excluded siblings do not exclude models)', async () => {
      // Two huge excluded replies must not push a small-window model out.
      const small: AutoCandidate = { ...cheap, meta: meta({ id: 'haiku', contextWindow: 10_000, cost: { input: 0.1, output: 0.1, cacheRead: null, cacheWrite: null } }) }
      candidates = [small]
      const user = messages.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [{ type: 'text', content: 'q' }] })
      for (let i = 0; i < 2; i += 1) {
        messages.create({
          conversationId,
          role: 'assistant',
          provider: 'openai',
          model: 'x',
          status: 'complete',
          parts: [{ type: 'text', content: 'z'.repeat(80_000) }],
          replyGroupId: user.id,
          inContext: false,
        })
      }
      const reply = await orchestration.auto({ requestId: 'rd', conversationId, content: 'hi' }, () => undefined)
      expect(reply.model).toBe('haiku')
    })
  })

  // ------------------------------------------------------------- retry

  describe('retryReply', () => {
    it('re-runs a failed compare column in the same slot and replaces the failure', async () => {
      specs.b!.options = { failWith: 'rate limit' }
      const { result } = await compare(['a', 'b'])
      const failed = result.replies[1]!
      specs.b!.options = {}
      specs.b!.respond = ['recovered']
      const events: ChatStreamEvent[] = []
      const fresh = await orchestration.retryReply(
        { requestId: 'retry-1', messageId: failed.id, target: target('b', 'b-model') },
        (e) => events.push(e),
      )
      expect(textOf(fresh)).toBe('recovered')
      expect(fresh).toMatchObject({ replyIndex: 1, replyGroupId: failed.replyGroupId, orchestrationMode: 'compare', status: 'complete' })
      expect(messages.get(failed.id)).toBeNull()
      expect(events.at(-1)?.type).toBe('done')
      // A's reply is still the one in context
      const group = messages.listGroupReplies(failed.replyGroupId!)
      expect(group.map((m) => [m.model, m.inContext])).toEqual([
        ['a-model', true],
        ['b-model', false],
      ])
    })

    it('[switch model] runs the slot on another model', async () => {
      specs.b!.options = { failWith: 'rate limit' }
      const { result } = await compare(['a', 'b'])
      specs.c!.respond = ['from c']
      const fresh = await orchestration.retryReply(
        { requestId: 'retry-2', messageId: result.replies[1]!.id, target: target('c', 'c-model') },
        () => undefined,
      )
      expect(fresh).toMatchObject({ provider: 'google', model: 'c-model', replyIndex: 1 })
    })

    it('becomes the in-context reply when the whole group had none (every column failed)', async () => {
      specs.a!.options = { failWith: 'x' }
      specs.b!.options = { failWith: 'x' }
      const { result } = await compare(['a', 'b'])
      specs.a!.options = {}
      const fresh = await orchestration.retryReply(
        { requestId: 'retry-3', messageId: result.replies[0]!.id, target: target('a') },
        () => undefined,
      )
      expect(messages.get(fresh.id)?.inContext).toBe(true)
    })

    it('refuses a finished reply and a review/round-table step', async () => {
      const { result } = await compare(['a', 'b'])
      await expect(
        orchestration.retryReply({ requestId: 'x', messageId: result.replies[0]!.id, target: target('a') }, () => undefined),
      ).rejects.toThrow(/failed or stopped/)
      specs.b!.options = { failWith: 'x' }
      const review = await orchestration.review(
        { orchestrationId: oid(), conversationId, content: 'q', primary: target('a'), reviewer: target('b') },
        () => undefined,
      )
      await expect(
        orchestration.retryReply({ requestId: 'y', messageId: review.replies[1]!.id, target: target('b') }, () => undefined),
      ).rejects.toThrow(/cannot be retried on its own/)
    })
  })
})
