import { useCallback, useEffect, useState } from 'react'
import type {
  AutoPreference,
  ChatStreamEvent,
  ContextSelection,
  Message,
  OrchestrationResult,
  OrchestrationStreamEvent,
  ReasoningEffort,
  RoundTableRole,
} from '@ai-workspace/shared'
import { viewOfMessage, type ReplyView } from '../lib/orchestration-ui'

/** A model to run, with the provider id the UI needs to label it. */
export interface RunTarget {
  providerConfigId: string
  provider: string
  model: string
  effort: ReasoningEffort | null
}

export interface RoundTableTarget extends RunTarget {
  role: RoundTableRole
}

export type LiveKind = 'chat' | 'auto' | 'compare' | 'review' | 'roundtable' | 'apply' | 'retry-review' | 'retry-column'

export interface LiveColumn extends ReplyView {
  requestId: string
}

/** Everything in flight right now, for the active conversation. */
export interface LiveRun {
  kind: LiveKind
  conversationId: string
  /** Cancel key for review / round table / compare (`cancelOrchestration`). */
  orchestrationId: string | null
  /** The question as typed (the persisted user message arrives on refresh). */
  userText: string | null
  /** chat / auto: the single in-flight reply. */
  stream: { requestId: string; text: string; provider: string | null; model: string | null; autoReason: string | null } | null
  /** compare: one entry per column. */
  columns: LiveColumn[]
  /** review / round table / apply: the steps so far. */
  steps: ReplyView[]
  totalSteps: number
  rounds: number
  /** apply / retry-review: the existing group the new step attaches to. */
  attachToGroupId: string | null
  /** retry-column: the persisted reply being run again. */
  retryMessageId: string | null
}

function emptyRun(kind: LiveKind, conversationId: string, extra: Partial<LiveRun> = {}): LiveRun {
  return {
    kind,
    conversationId,
    orchestrationId: null,
    userText: null,
    stream: null,
    columns: [],
    steps: [],
    totalSteps: 0,
    rounds: 1,
    attachToGroupId: null,
    retryMessageId: null,
    ...extra,
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function useChat(conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState<LiveRun | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setMessages([])
      setLoading(false)
      return
    }
    setLoading(true)
    const list = await window.api.conversations.listMessages(conversationId)
    setMessages(list)
    setLoading(false)
  }, [conversationId])

  useEffect(() => {
    // A previous conversation's send error must not follow the user to
    // another conversation.
    setError(null)
    void refresh()
  }, [refresh])

  const patchLive = useCallback((patch: (run: LiveRun) => LiveRun) => {
    setLive((current) => (current ? patch(current) : current))
  }, [])

  /** Runs one live operation: sets the live state, always clears it, refreshes. */
  const runLive = useCallback(
    async (initial: LiveRun, body: (unsubs: (() => void)[]) => Promise<void>) => {
      setError(null)
      setLive(initial)
      const unsubs: (() => void)[] = []
      try {
        await body(unsubs)
      } catch (err) {
        setError(errorText(err))
      } finally {
        for (const unsub of unsubs) unsub()
        setLive(null)
        await refresh()
      }
    },
    [refresh],
  )

  /** Subscribes one request's stream into `live.stream`. */
  const trackStream = useCallback(
    (requestId: string, unsubs: (() => void)[]) => {
      unsubs.push(
        window.api.chat.onStreamEvent(requestId, (event: ChatStreamEvent) => {
          if (event.type === 'start') {
            patchLive((run) =>
              run.stream && run.stream.requestId === requestId
                ? { ...run, stream: { ...run.stream, provider: event.provider, model: event.model, autoReason: event.autoReason } }
                : run,
            )
          } else if (event.type === 'delta') {
            patchLive((run) =>
              run.stream && run.stream.requestId === requestId
                ? { ...run, stream: { ...run.stream, text: run.stream.text + event.delta } }
                : run,
            )
          } else if (event.type === 'error') {
            setError(event.message)
          }
        }),
      )
    },
    [patchLive],
  )

  const send = useCallback(
    async (
      providerConfigId: string,
      provider: string,
      model: string,
      content: string,
      contextSelection?: ContextSelection,
      effort?: ReasoningEffort | null,
      regenerateOfMessageId?: string,
    ) => {
      if (!conversationId) throw new Error('No active conversation')
      const requestId = crypto.randomUUID()
      await runLive(
        emptyRun('chat', conversationId, {
          userText: regenerateOfMessageId ? null : content,
          stream: { requestId, text: '', provider, model, autoReason: null },
        }),
        async (unsubs) => {
          trackStream(requestId, unsubs)
          await window.api.chat.sendMessage({
            requestId,
            conversationId,
            providerConfigId,
            model,
            content,
            contextSelection,
            effort: effort ?? null,
            ...(regenerateOfMessageId ? { regenerateOfMessageId } : {}),
          })
        },
      )
    },
    [conversationId, runLive, trackStream],
  )

  /** Answers the most recent user turn again, as a new sibling reply. */
  const regenerate = useCallback(
    async (target: RunTarget) => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      if (!lastUser) return
      const content = lastUser.parts.map((p) => p.content).join('')
      if (!content) return
      await send(target.providerConfigId, target.provider, target.model, content, undefined, target.effort, lastUser.id)
    },
    [messages, send],
  )

  const sendAuto = useCallback(
    async (content: string, contextSelection: ContextSelection | undefined, preference: AutoPreference) => {
      if (!conversationId) throw new Error('No active conversation')
      const requestId = crypto.randomUUID()
      await runLive(
        emptyRun('auto', conversationId, {
          userText: content,
          stream: { requestId, text: '', provider: null, model: null, autoReason: null },
        }),
        async (unsubs) => {
          trackStream(requestId, unsubs)
          await window.api.chat.auto({ requestId, conversationId, content, contextSelection, preference })
        },
      )
    },
    [conversationId, runLive, trackStream],
  )

  const sendCompare = useCallback(
    async (targets: RunTarget[], content: string, contextSelection: ContextSelection | undefined) => {
      if (!conversationId) throw new Error('No active conversation')
      const orchestrationId = crypto.randomUUID()
      const columns: LiveColumn[] = targets.map((t) => ({
        requestId: crypto.randomUUID(),
        key: `${t.providerConfigId}:${t.model}`,
        messageId: null,
        provider: t.provider,
        model: t.model,
        roleLabel: null,
        round: null,
        text: '',
        phase: 'waiting',
        errorText: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        estCostUsd: null,
        inContext: false,
      }))
      await runLive(
        emptyRun('compare', conversationId, { orchestrationId, userText: content, columns }),
        async (unsubs) => {
          const patchColumn = (requestId: string, change: (c: LiveColumn) => LiveColumn) =>
            patchLive((run) => ({ ...run, columns: run.columns.map((c) => (c.requestId === requestId ? change(c) : c)) }))
          for (const column of columns) {
            unsubs.push(
              window.api.chat.onStreamEvent(column.requestId, (event) => {
                if (event.type === 'start') {
                  patchColumn(column.requestId, (c) => ({ ...c, provider: event.provider || c.provider, phase: 'streaming' }))
                } else if (event.type === 'delta') {
                  patchColumn(column.requestId, (c) => ({ ...c, phase: 'streaming', text: c.text + event.delta }))
                } else if (event.type === 'error') {
                  patchColumn(column.requestId, (c) => ({ ...c, phase: 'error', errorText: event.message }))
                } else if (event.type === 'done') {
                  patchColumn(column.requestId, (c) => ({ ...viewOfMessage(event.message), requestId: c.requestId, key: c.key }))
                }
              }),
            )
          }
          await window.api.chat.compare({
            orchestrationId,
            conversationId,
            content,
            contextSelection,
            targets: columns.map((column, i) => ({
              requestId: column.requestId,
              providerConfigId: targets[i]!.providerConfigId,
              model: targets[i]!.model,
              effort: targets[i]!.effort,
            })),
          })
        },
      )
    },
    [conversationId, patchLive, runLive],
  )

  /** Mirrors review / round-table / apply step events into `live.steps`. */
  const trackSteps = useCallback(
    (orchestrationId: string, unsubs: (() => void)[]) => {
      unsubs.push(
        window.api.chat.onOrchestrationEvent(orchestrationId, (event: OrchestrationStreamEvent) => {
          if (event.type === 'step-start') {
            patchLive((run) => {
              const steps = run.steps.slice()
              steps[event.step] = {
                key: `step-${event.step}`,
                messageId: null,
                provider: event.provider,
                model: event.model,
                roleLabel: event.role,
                round: event.round,
                text: '',
                phase: 'streaming',
                errorText: null,
                latencyMs: null,
                inputTokens: null,
                outputTokens: null,
                estCostUsd: null,
                inContext: false,
              }
              return { ...run, steps, totalSteps: Math.max(run.totalSteps, event.totalSteps) }
            })
          } else if (event.type === 'delta') {
            patchLive((run) => {
              const step = run.steps[event.step]
              if (!step) return run
              const steps = run.steps.slice()
              steps[event.step] = { ...step, text: step.text + event.delta }
              return { ...run, steps }
            })
          } else if (event.type === 'step-done') {
            patchLive((run) => {
              const steps = run.steps.slice()
              steps[event.step] = viewOfMessage(event.message)
              return { ...run, steps }
            })
          }
        }),
      )
    },
    [patchLive],
  )

  const sendReview = useCallback(
    async (primary: RunTarget, reviewer: RunTarget, content: string, contextSelection: ContextSelection | undefined) => {
      if (!conversationId) throw new Error('No active conversation')
      const orchestrationId = crypto.randomUUID()
      await runLive(
        emptyRun('review', conversationId, { orchestrationId, userText: content, totalSteps: 2 }),
        async (unsubs) => {
          trackSteps(orchestrationId, unsubs)
          const result = await window.api.chat.review({
            orchestrationId,
            conversationId,
            content,
            contextSelection,
            primary: { providerConfigId: primary.providerConfigId, model: primary.model, effort: primary.effort },
            reviewer: { providerConfigId: reviewer.providerConfigId, model: reviewer.model, effort: reviewer.effort },
          })
          surfaceFailure(result, setError)
        },
      )
    },
    [conversationId, runLive, trackSteps],
  )

  /** `[retry]` on a failed review: the primary answer is reused as it is. */
  const retryReview = useCallback(
    async (primary: Message, reviewer: RunTarget) => {
      if (!conversationId || !primary.replyGroupId) return
      const orchestrationId = crypto.randomUUID()
      await runLive(
        emptyRun('retry-review', conversationId, { orchestrationId, totalSteps: 1, attachToGroupId: primary.replyGroupId }),
        async (unsubs) => {
          trackSteps(orchestrationId, unsubs)
          const result = await window.api.chat.review({
            orchestrationId,
            conversationId,
            primaryMessageId: primary.id,
            reviewer: { providerConfigId: reviewer.providerConfigId, model: reviewer.model, effort: reviewer.effort },
          })
          surfaceFailure(result, setError)
        },
      )
    },
    [conversationId, runLive, trackSteps],
  )

  const applySuggestions = useCallback(
    async (primary: Message, review: Message, target: RunTarget) => {
      if (!conversationId || !primary.replyGroupId) return
      const orchestrationId = crypto.randomUUID()
      await runLive(
        emptyRun('apply', conversationId, { orchestrationId, totalSteps: 1, attachToGroupId: primary.replyGroupId }),
        async (unsubs) => {
          trackSteps(orchestrationId, unsubs)
          const result = await window.api.chat.applySuggestions({
            orchestrationId,
            conversationId,
            primaryMessageId: primary.id,
            reviewMessageId: review.id,
            target: { providerConfigId: target.providerConfigId, model: target.model, effort: target.effort },
          })
          surfaceFailure(result, setError)
        },
      )
    },
    [conversationId, runLive, trackSteps],
  )

  const sendRoundTable = useCallback(
    async (
      participants: RoundTableTarget[],
      synthesizer: RunTarget | null,
      rounds: number,
      content: string,
      contextSelection: ContextSelection | undefined,
    ) => {
      if (!conversationId) throw new Error('No active conversation')
      const orchestrationId = crypto.randomUUID()
      const totalSteps = participants.length * rounds + (synthesizer ? 1 : 0)
      await runLive(
        emptyRun('roundtable', conversationId, { orchestrationId, userText: content, totalSteps, rounds }),
        async (unsubs) => {
          trackSteps(orchestrationId, unsubs)
          const result = await window.api.chat.roundTable({
            orchestrationId,
            conversationId,
            content,
            contextSelection,
            rounds,
            participants: participants.map((p) => ({
              role: p.role,
              providerConfigId: p.providerConfigId,
              model: p.model,
              effort: p.effort,
            })),
            synthesizer: synthesizer
              ? { providerConfigId: synthesizer.providerConfigId, model: synthesizer.model, effort: synthesizer.effort }
              : null,
          })
          surfaceFailure(result, setError)
        },
      )
    },
    [conversationId, runLive, trackSteps],
  )

  /** `[retry]` / `[switch model]` on one failed compare column. */
  const retryReply = useCallback(
    async (failed: Message, target: RunTarget) => {
      if (!conversationId) return
      const requestId = crypto.randomUUID()
      await runLive(
        emptyRun('retry-column', conversationId, {
          retryMessageId: failed.id,
          stream: { requestId, text: '', provider: target.provider, model: target.model, autoReason: null },
        }),
        async (unsubs) => {
          trackStream(requestId, unsubs)
          await window.api.chat.retryReply({
            requestId,
            messageId: failed.id,
            target: { providerConfigId: target.providerConfigId, model: target.model, effort: target.effort },
          })
        },
      )
    },
    [conversationId, runLive, trackStream],
  )

  /** `[continue with this]`. */
  const chooseReply = useCallback(
    async (messageId: string) => {
      try {
        const group = await window.api.chat.setInContext(messageId)
        setMessages((current) => current.map((m) => group.find((g) => g.id === m.id) ?? m))
      } catch (err) {
        setError(errorText(err))
      }
    },
    [],
  )

  /** Stops whatever is running: one call for a whole compare / review / round table. */
  const cancel = useCallback(() => {
    if (!live) return
    if (live.orchestrationId) void window.api.chat.cancelOrchestration(live.orchestrationId)
    else if (live.stream) void window.api.chat.cancel(live.stream.requestId)
  }, [live])

  /** Stops a single compare column; the others keep going. */
  const cancelColumn = useCallback((requestId: string) => {
    void window.api.chat.cancel(requestId)
  }, [])

  const visible = live && live.conversationId === conversationId ? live : null

  return {
    messages,
    loading,
    live: visible,
    /** True while anything is running (the composer stays locked). */
    sending: live !== null,
    error,
    send,
    regenerate,
    sendAuto,
    sendCompare,
    sendReview,
    retryReview,
    applySuggestions,
    sendRoundTable,
    retryReply,
    chooseReply,
    cancel,
    cancelColumn,
    refresh,
  }
}

/** A result that ran to the end but failed (provider error) becomes the visible error. */
function surfaceFailure(result: OrchestrationResult, setError: (message: string | null) => void): void {
  if (result.status === 'error' && result.error) setError(result.error)
}
