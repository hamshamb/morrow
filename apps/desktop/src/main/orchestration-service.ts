import type { ConversationRepository, MessageRepository } from '@ai-workspace/storage'
import {
  COMPARE_MAX_MODELS,
  COMPARE_MIN_MODELS,
  ROUND_TABLE_MAX_CALLS,
  ROUND_TABLE_MAX_PARTICIPANTS,
  ROUND_TABLE_MAX_ROUNDS,
  ROUND_TABLE_MIN_PARTICIPANTS,
  estimateTokens,
  pickAutoModel,
  type ApplySuggestionsInput,
  type AutoCandidate,
  type AutoChatInput,
  type AutoPreference,
  type ChatStreamEvent,
  type CompareInput,
  type Message,
  type ModelTarget,
  type OrchestrationResult,
  type OrchestrationStatus,
  type OrchestrationStreamEvent,
  type RetryReplyInput,
  type ReviewInput,
  type RoleLabel,
  type RoundTableInput,
} from '@ai-workspace/shared'
import type { ChatService } from './chat-service'
import {
  buildReviewMessages,
  buildRevisionContent,
  buildRoundTableContent,
  withFinalUserContent,
  type TranscriptTurn,
} from './orchestration-prompts'

export interface OrchestrationServiceDeps {
  chat: ChatService
  conversations: ConversationRepository
  messages: MessageRepository
  /** Every model of every configured provider, with models.dev metadata (Auto's pool). */
  listAutoCandidates: () => AutoCandidate[]
  /** The saved Auto preference (Settings). */
  getAutoPreference: () => AutoPreference
}

/** A request the server refuses because it exceeds a hard limit. */
export class OrchestrationLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrchestrationLimitError'
  }
}

interface RunGroup {
  cancelled: boolean
  /** requestIds currently streaming for this orchestration. */
  active: Set<string>
}

function textOf(message: Message): string {
  return message.parts.map((p) => p.content).join('')
}

function authorOf(message: { model: string | null; provider: string | null }): string {
  return `${message.model ?? 'unknown model'}${message.provider ? ` (${message.provider})` : ''}`
}

/**
 * Multi-model orchestration (ADR-027): compare, review, round table and auto,
 * composed from `ChatService`'s single-reply primitives. Electron-free like
 * `ChatService`, so every flow — including cancellation and the hard iteration
 * cap — is unit-tested with the mock provider and an in-memory database.
 *
 * Invariants:
 * - Limits (2-4 compare models, round-table rounds/participants/total calls)
 *   are enforced HERE, independent of the IPC schema or the UI.
 * - A provider reply is never edited after it is persisted: a review is its own
 *   message; `[apply suggestions]` creates a new sibling.
 * - Every reply of one user turn shares `replyGroupId`; at most one assistant
 *   reply of a group is `inContext` once the turn settles (ADR-028).
 */
export class OrchestrationService {
  private readonly groups = new Map<string, RunGroup>()

  constructor(private readonly deps: OrchestrationServiceDeps) {}

  // ---------------------------------------------------------------- control

  private begin(orchestrationId: string): RunGroup {
    if (this.groups.has(orchestrationId)) {
      throw new Error(`Orchestration already running: ${orchestrationId}`)
    }
    const group: RunGroup = { cancelled: false, active: new Set() }
    this.groups.set(orchestrationId, group)
    return group
  }

  private end(orchestrationId: string): void {
    this.groups.delete(orchestrationId)
  }

  /** Stops everything this orchestration is running and prevents later steps. */
  cancelOrchestration(orchestrationId: string): void {
    const group = this.groups.get(orchestrationId)
    if (!group) return
    group.cancelled = true
    for (const requestId of group.active) this.deps.chat.cancel(requestId)
  }

  /** `[continue with this]`. */
  setInContext(messageId: string): Message[] {
    return this.deps.messages.chooseReply(messageId)
  }

  private finish(
    group: RunGroup,
    userMessage: Message | null,
    replies: Message[],
    failure: string | null,
  ): OrchestrationResult {
    const anyOk = replies.some((r) => r.status === 'complete' || (r.status !== 'error' && r.parts.length > 0))
    let status: OrchestrationStatus = 'complete'
    if (group.cancelled) status = 'cancelled'
    else if (!anyOk && replies.length > 0) status = 'error'
    else if (failure) status = 'error'
    return {
      userMessage,
      replies,
      status,
      error: status === 'error' ? (failure ?? replies.find((r) => r.errorText)?.errorText ?? 'The request failed.') : null,
    }
  }

  // ---------------------------------------------------------------- compare

  /**
   * COMPARE: one user turn, `targets.length` models in parallel. Each column
   * has its own requestId (its own stream channel and cancel key) and runs
   * with `isolateFailures`, so one column erroring (or not even resolving)
   * leaves the others untouched. Afterwards the FIRST COMPLETE column (by
   * column order, not finish order) becomes the in-context reply; the rest stay
   * persisted and visible but excluded until the user picks one.
   */
  async compare(
    input: CompareInput,
    onColumnEvent: (requestId: string, event: ChatStreamEvent) => void,
  ): Promise<OrchestrationResult> {
    const { chat, messages } = this.deps
    if (input.targets.length < COMPARE_MIN_MODELS || input.targets.length > COMPARE_MAX_MODELS) {
      throw new OrchestrationLimitError(
        `Compare needs ${COMPARE_MIN_MODELS}-${COMPARE_MAX_MODELS} models (got ${input.targets.length}).`,
      )
    }
    const group = this.begin(input.orchestrationId)
    try {
      const userMessage = chat.persistUserTurn({
        conversationId: input.conversationId,
        content: input.content,
        contextSelection: input.contextSelection,
      })
      const providerMessages = chat.buildProviderMessages({
        conversationId: input.conversationId,
        selection: input.contextSelection,
      })
      for (const target of input.targets) group.active.add(target.requestId)

      const settled = await Promise.allSettled(
        input.targets.map((target, index) =>
          chat
            .runTurn(
              {
                conversationId: input.conversationId,
                requestId: target.requestId,
                providerConfigId: target.providerConfigId,
                model: target.model,
                effort: target.effort ?? null,
                providerMessages,
                replyGroupId: userMessage.id,
                orchestrationMode: 'compare',
                replyIndex: index,
                inContext: false,
                isolateFailures: true,
              },
              (event) => onColumnEvent(target.requestId, event),
            )
            .finally(() => group.active.delete(target.requestId)),
        ),
      )

      const firstOk = settled
        .map((s) => (s.status === 'fulfilled' ? s.value : null))
        .find((m): m is Message => !!m && m.status === 'complete' && m.parts.length > 0)
      if (firstOk) messages.chooseReply(firstOk.id)

      const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
      const replies = messages.listGroupReplies(userMessage.id)
      return this.finish(
        group,
        userMessage,
        replies,
        failure ? (failure.reason instanceof Error ? failure.reason.message : String(failure.reason)) : null,
      )
    } finally {
      this.end(input.orchestrationId)
    }
  }

  // ---------------------------------------------------------------- shared step runner

  /** Runs one pipeline step on `chat.runTurn` and mirrors it as orchestration events. */
  private async runStep(
    group: RunGroup,
    orchestrationId: string,
    emit: (event: OrchestrationStreamEvent) => void,
    step: { index: number; total: number; role: RoleLabel; round: number | null },
    turn: {
      conversationId: string
      target: ModelTarget
      providerMessages: Parameters<ChatService['runTurn']>[0]['providerMessages']
      replyGroupId: string
      mode: 'review' | 'roundtable'
      replyIndex: number
      inContext: boolean
    },
  ): Promise<Message> {
    const requestId = `${orchestrationId}:${step.index}`
    group.active.add(requestId)
    try {
      const message = await this.deps.chat.runTurn(
        {
          conversationId: turn.conversationId,
          requestId,
          providerConfigId: turn.target.providerConfigId,
          model: turn.target.model,
          effort: turn.target.effort ?? null,
          providerMessages: turn.providerMessages,
          replyGroupId: turn.replyGroupId,
          orchestrationMode: turn.mode,
          roleLabel: step.role === 'proposal' && turn.mode === 'review' ? null : step.role,
          replyIndex: turn.replyIndex,
          roundIndex: step.round,
          inContext: turn.inContext,
          isolateFailures: true,
        },
        (event) => {
          if (event.type === 'start') {
            emit({
              type: 'step-start',
              step: step.index,
              totalSteps: step.total,
              role: step.role,
              provider: event.provider,
              model: event.model,
              round: step.round,
            })
          } else if (event.type === 'delta') {
            emit({ type: 'delta', step: step.index, delta: event.delta })
          }
        },
      )
      emit({ type: 'step-done', step: step.index, message })
      return message
    } finally {
      group.active.delete(requestId)
    }
  }

  // ---------------------------------------------------------------- review

  /**
   * REVIEW: the primary model answers (persisted, untouched from then on), then
   * the reviewer gets the question + that answer and writes a report that is
   * its own message (`roleLabel: 'review'`, out of the context by default).
   * With `primaryMessageId` the primary step is skipped and the existing answer
   * is reviewed again (a failed review's `[retry]`).
   */
  async review(
    input: ReviewInput,
    emit: (event: OrchestrationStreamEvent) => void,
  ): Promise<OrchestrationResult> {
    const { chat, messages } = this.deps
    const group = this.begin(input.orchestrationId)
    try {
      let userMessage: Message | null = null
      let primary: Message
      let question: string
      const replies: Message[] = []
      const reusing = input.primaryMessageId !== undefined

      if (input.primaryMessageId) {
        const existing = messages.get(input.primaryMessageId)
        if (!existing || existing.role !== 'assistant' || existing.conversationId !== input.conversationId) {
          throw new Error(`Message not found: ${input.primaryMessageId}`)
        }
        if (existing.status !== 'complete' || textOf(existing).length === 0) {
          throw new Error('Only a finished answer can be reviewed.')
        }
        primary = existing
        question = this.questionFor(existing)
        // A previous review attempt that failed is replaced by this one.
        for (const old of messages.listGroupReplies(existing.replyGroupId ?? '')) {
          if (old.roleLabel === 'review' && old.status !== 'complete') messages.delete(old.id)
        }
      } else {
        if (!input.content || !input.primary) throw new Error('A review needs a question and a primary model.')
        question = input.content
        userMessage = chat.persistUserTurn({
          conversationId: input.conversationId,
          content: input.content,
          contextSelection: input.contextSelection,
        })
        emit({ type: 'user-message', message: userMessage })
        const providerMessages = chat.buildProviderMessages({
          conversationId: input.conversationId,
          selection: input.contextSelection,
        })
        primary = await this.runStep(
          group,
          input.orchestrationId,
          emit,
          { index: 0, total: 2, role: 'proposal', round: null },
          {
            conversationId: input.conversationId,
            target: input.primary,
            providerMessages,
            replyGroupId: userMessage.id,
            mode: 'review',
            replyIndex: 0,
            // The primary answer is what later turns continue from.
            inContext: true,
          },
        )
        replies.push(primary)
      }

      const groupId = primary.replyGroupId
      const primaryOk = primary.status === 'complete' && textOf(primary).length > 0
      if (primaryOk && !group.cancelled && groupId) {
        const total = reusing ? 1 : 2
        const index = reusing ? 0 : 1
        const report = await this.runStep(
          group,
          input.orchestrationId,
          emit,
          { index, total, role: 'review', round: null },
          {
            conversationId: input.conversationId,
            target: input.reviewer,
            providerMessages: buildReviewMessages({
              question,
              answer: textOf(primary),
              answeredBy: authorOf(primary),
            }),
            replyGroupId: groupId,
            mode: 'review',
            replyIndex: messages.listGroupReplies(groupId).length,
            inContext: false,
          },
        )
        replies.push(report)
      }

      const result = this.finish(group, userMessage, replies, null)
      emit({ type: 'done', result })
      return result
    } finally {
      this.end(input.orchestrationId)
    }
  }

  /** The user question a stored reply answered. */
  private questionFor(reply: Message): string {
    const { messages } = this.deps
    if (reply.replyGroupId) {
      const user = messages.get(reply.replyGroupId)
      if (user && user.role === 'user') return textOf(user)
    }
    // Rows from before reply groups: the closest earlier user message.
    const thread = messages.listByConversation(reply.conversationId)
    const at = thread.findIndex((m) => m.id === reply.id)
    for (let i = at - 1; i >= 0; i -= 1) {
      const candidate = thread[i]
      if (candidate?.role === 'user') return textOf(candidate)
    }
    throw new Error('Could not find the question this reply answered.')
  }

  /**
   * `[apply suggestions]`: the target model (normally the primary) rewrites its
   * answer using the review. The result is a NEW sibling reply in the same
   * group (`roleLabel: 'revision'`); the original answer and the review are
   * left exactly as they were, and the revision is not in the context until
   * the user picks it (`[continue with this]`).
   */
  async applySuggestions(
    input: ApplySuggestionsInput,
    emit: (event: OrchestrationStreamEvent) => void,
  ): Promise<OrchestrationResult> {
    const { chat, messages } = this.deps
    const group = this.begin(input.orchestrationId)
    try {
      const primary = messages.get(input.primaryMessageId)
      const review = messages.get(input.reviewMessageId)
      if (!primary || !review || primary.role !== 'assistant' || review.role !== 'assistant') {
        throw new Error('The answer or its review no longer exists.')
      }
      if (
        primary.conversationId !== input.conversationId ||
        review.conversationId !== input.conversationId ||
        !primary.replyGroupId ||
        primary.replyGroupId !== review.replyGroupId
      ) {
        throw new Error('The review does not belong to this answer.')
      }
      if (review.status !== 'complete' || textOf(review).length === 0) {
        throw new Error('There is no finished review to apply.')
      }
      const question = this.questionFor(primary)
      const base = chat.buildProviderMessages({
        conversationId: input.conversationId,
        untilMessageId: primary.replyGroupId,
      })
      const providerMessages = withFinalUserContent(
        base,
        buildRevisionContent({
          question,
          answer: textOf(primary),
          reviewer: authorOf(review),
          report: textOf(review),
        }),
      )
      const revision = await this.runStep(
        group,
        input.orchestrationId,
        emit,
        { index: 0, total: 1, role: 'revision', round: null },
        {
          conversationId: input.conversationId,
          target: input.target,
          providerMessages,
          replyGroupId: primary.replyGroupId,
          mode: 'review',
          replyIndex: messages.listGroupReplies(primary.replyGroupId).length,
          inContext: false,
        },
      )
      const result = this.finish(group, null, [revision], null)
      emit({ type: 'done', result })
      return result
    } finally {
      this.end(input.orchestrationId)
    }
  }

  // ---------------------------------------------------------------- round table

  /**
   * The plan for a round table, or an `OrchestrationLimitError`. This is the
   * server-side iteration cap: `rounds` above ROUND_TABLE_MAX_ROUNDS, too many
   * or too few participants, or a plan above ROUND_TABLE_MAX_CALLS provider
   * calls is refused before anything is persisted or any model is called.
   */
  planRoundTable(input: Pick<RoundTableInput, 'participants' | 'synthesizer' | 'rounds'>): RoundTableStep[] {
    const rounds = input.rounds
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > ROUND_TABLE_MAX_ROUNDS) {
      throw new OrchestrationLimitError(`A round table runs at most ${ROUND_TABLE_MAX_ROUNDS} rounds (got ${rounds}).`)
    }
    const n = input.participants.length
    if (n < ROUND_TABLE_MIN_PARTICIPANTS || n > ROUND_TABLE_MAX_PARTICIPANTS) {
      throw new OrchestrationLimitError(
        `A round table needs ${ROUND_TABLE_MIN_PARTICIPANTS}-${ROUND_TABLE_MAX_PARTICIPANTS} participants (got ${n}).`,
      )
    }
    if (input.participants[0]?.role !== 'proposal') {
      throw new OrchestrationLimitError('The first round-table turn must be a proposal.')
    }
    const steps: RoundTableStep[] = []
    for (let round = 1; round <= rounds; round += 1) {
      for (const participant of input.participants) {
        steps.push({ role: participant.role, target: participant, round })
      }
    }
    if (input.synthesizer) steps.push({ role: 'synthesis', target: input.synthesizer, round: rounds })
    if (steps.length > ROUND_TABLE_MAX_CALLS) {
      throw new OrchestrationLimitError(`A round table makes at most ${ROUND_TABLE_MAX_CALLS} model calls.`)
    }
    return steps
  }

  /**
   * ROUND TABLE: the planned steps run strictly one after another, each seeing
   * the transcript so far. The plan is fixed (and capped) up front — no model
   * output can add a step, so there is no unbounded model-to-model loop. A
   * failed step ends the table (later steps would argue with nothing); one
   * `cancelOrchestration` stops the current step and every later one. The
   * synthesis (or, without one, the last finished turn) becomes the in-context
   * reply; the rest of the transcript stays visible and persisted.
   */
  async roundTable(
    input: RoundTableInput,
    emit: (event: OrchestrationStreamEvent) => void,
  ): Promise<OrchestrationResult> {
    const { chat, messages } = this.deps
    const steps = this.planRoundTable(input)
    const group = this.begin(input.orchestrationId)
    try {
      const userMessage = chat.persistUserTurn({
        conversationId: input.conversationId,
        content: input.content,
        contextSelection: input.contextSelection,
      })
      emit({ type: 'user-message', message: userMessage })
      const base = chat.buildProviderMessages({
        conversationId: input.conversationId,
        selection: input.contextSelection,
      })

      const transcript: TranscriptTurn[] = []
      const replies: Message[] = []
      let failure: string | null = null

      for (const [index, step] of steps.entries()) {
        if (group.cancelled) break
        const content = buildRoundTableContent({
          question: input.content,
          role: step.role,
          round: step.round,
          rounds: input.rounds,
          transcript,
        })
        const reply = await this.runStep(
          group,
          input.orchestrationId,
          emit,
          { index, total: steps.length, role: step.role, round: step.round },
          {
            conversationId: input.conversationId,
            target: step.target,
            providerMessages: withFinalUserContent(base, content),
            replyGroupId: userMessage.id,
            mode: 'roundtable',
            replyIndex: index,
            inContext: false,
          },
        )
        replies.push(reply)
        if (reply.status !== 'complete' || textOf(reply).length === 0) {
          if (reply.status === 'error') failure = reply.errorText ?? 'A round-table turn failed.'
          break
        }
        transcript.push({ role: step.role, author: authorOf(reply), round: step.round, text: textOf(reply) })
      }

      const finished = replies.filter((r) => r.status === 'complete' && textOf(r).length > 0)
      const synthesis = finished.find((r) => r.roleLabel === 'synthesis')
      const keep = synthesis ?? finished[finished.length - 1]
      if (keep) messages.chooseReply(keep.id)

      const final = messages.listGroupReplies(userMessage.id)
      const result = this.finish(group, userMessage, final, failure)
      emit({ type: 'done', result })
      return result
    } finally {
      this.end(input.orchestrationId)
    }
  }

  // ---------------------------------------------------------------- auto

  /**
   * AUTO: pick a configured model with `pickAutoModel` (deterministic rules over
   * models.dev metadata), then answer like a normal turn on that model. The
   * reply records `orchestrationMode: 'auto'` and the human-readable reason.
   * Refuses (throws) when no model qualifies — it never falls back silently to
   * something that violates a rule.
   */
  async auto(input: AutoChatInput, onEvent: (event: ChatStreamEvent) => void): Promise<Message> {
    const { chat, messages } = this.deps
    const attachments = input.contextSelection?.attachments ?? []
    const historyChars = messages
      .listByConversation(input.conversationId)
      .filter((m) => m.inContext)
      .reduce((sum, m) => sum + m.parts.reduce((s, p) => s + p.content.length, 0), 0)
    const attachmentChars = attachments.reduce((sum, a) => sum + a.content.length, 0)
    const estimatedContextTokens = estimateTokens(historyChars + input.content.length + attachmentChars)

    const picked = pickAutoModel(
      {
        promptText: input.content,
        estimatedContextTokens,
        attachmentMimeTypes: attachments.map((a) => a.mimeType),
      },
      this.deps.listAutoCandidates(),
      { preference: input.preference ?? this.deps.getAutoPreference() },
    )
    if (!picked.choice) throw new Error(`Auto could not pick a model: ${picked.reason}.`)

    return chat.sendMessage(
      {
        requestId: input.requestId,
        conversationId: input.conversationId,
        providerConfigId: picked.choice.providerConfigId,
        model: picked.choice.modelId,
        content: input.content,
        contextSelection: input.contextSelection,
        effort: null,
      },
      onEvent,
      { orchestrationMode: 'auto', autoReason: picked.reason },
    )
  }

  // ---------------------------------------------------------------- retry

  /**
   * `[retry]` / `[switch model]` on one failed or stopped reply: runs it again
   * (on `target`) against the same user turn, in the same slot of the same
   * group, and replaces the failed message with the new one. If nothing in the
   * group is in the context afterwards and the new reply succeeded, it becomes
   * the in-context reply. The Context Inspector selection of the original send
   * is not stored, so a retry replays the conversation without it.
   */
  async retryReply(input: RetryReplyInput, onEvent: (event: ChatStreamEvent) => void): Promise<Message> {
    const { chat, messages } = this.deps
    const failed = messages.get(input.messageId)
    if (!failed || failed.role !== 'assistant') throw new Error(`Message not found: ${input.messageId}`)
    if (failed.status === 'complete') throw new Error('Only a failed or stopped reply can be retried.')
    if (!failed.replyGroupId) throw new Error('This reply predates reply groups; use [regenerate] instead.')
    if (failed.orchestrationMode === 'review' || failed.orchestrationMode === 'roundtable') {
      throw new Error('A review or round-table step cannot be retried on its own; run it again.')
    }
    const providerMessages = chat.buildProviderMessages({
      conversationId: failed.conversationId,
      untilMessageId: failed.replyGroupId,
    })
    const replacement = await chat.runTurn(
      {
        conversationId: failed.conversationId,
        requestId: input.requestId,
        providerConfigId: input.target.providerConfigId,
        model: input.target.model,
        effort: input.target.effort ?? null,
        providerMessages,
        replyGroupId: failed.replyGroupId,
        orchestrationMode: failed.orchestrationMode,
        roleLabel: failed.roleLabel,
        replyIndex: failed.replyIndex,
        roundIndex: failed.roundIndex,
        autoReason: failed.autoReason,
        inContext: false,
        isolateFailures: true,
      },
      onEvent,
    )
    messages.delete(failed.id)
    if (replacement.status === 'complete' && replacement.parts.length > 0) {
      const siblings = messages.listGroupReplies(failed.replyGroupId)
      if (!siblings.some((s) => s.inContext && s.id !== replacement.id)) {
        messages.chooseReply(replacement.id)
        return messages.get(replacement.id) ?? replacement
      }
    }
    return messages.get(replacement.id) ?? replacement
  }
}

export interface RoundTableStep {
  role: 'proposal' | 'critique' | 'alternative' | 'synthesis'
  target: ModelTarget
  round: number
}
