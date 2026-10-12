import { useMemo, type ReactNode } from 'react'
import { formatAutoLine, type AgentRunDetail, type Message, type PermissionDecision, type PermissionRequest } from '@ai-workspace/shared'
import type { LiveRun } from '../hooks/useChat'
import { buildThread, type ThreadItem } from '../lib/reply-groups'
import { replyStats, viewOfMessage, type ReplyView } from '../lib/orchestration-ui'
import { describeProviderError } from '../lib/provider-error'
import { formatRelativeTime } from '../lib/time'
import { Markdown } from './Markdown'
import { FileIcon } from './icons'
import { CompareView, type CompareColumn } from './CompareView'
import { ReviewGroup } from './ReviewGroup'
import { RoundTableView } from './RoundTableView'
import { CopyAction, ErrorLine, ModelChip } from './ReplyParts'
import { formatFileSize } from '../lib/file-size'
import type { LiveAgent } from '../lib/agent-ui'
import { FinishedAgentBlock, LiveAgentBlock, ReportBlock } from './agent/AgentRunBlock'

interface Props {
  messages: Message[]
  /** What is running right now for this conversation (null = idle). */
  live: LiveRun | null
  /** Short model name for attribution chips (catalog display name aware). */
  modelName: (modelId: string) => string
  /** Transient error from the last send (useChat) — rendered in plain
   * language under the failed message, never raw. */
  error: string | null
  busy: boolean
  onRegenerate: () => void
  onOpenRegeneratePicker: () => void
  /** The "[regenerate with…]" model picker, rendered under the last
   * response's actions while open. */
  regeneratePicker: ReactNode
  /** `[continue with this]` / `[use this reply]`. */
  onChoose: (messageId: string) => void
  onRetryColumn: (messageId: string) => void
  onSwitchColumn: (messageId: string) => void
  columnPicker: { messageId: string; node: ReactNode } | null
  onCancelColumn: (requestId: string) => void
  onStop: () => void
  onApplySuggestions: (primaryMessageId: string, reviewMessageId: string) => void
  onRetryReview: (primaryMessageId: string) => void
  /** Plan / Build runs of this conversation (persisted), the run in progress, and the prompts waiting. */
  agentRuns: AgentRunDetail[]
  agentLive: LiveAgent | null
  /** Narrative of the run that just ended (shown until the saved reply loads). */
  agentEndedText: { runId: string; text: string } | null
  agentPermissions: PermissionRequest[]
  agentName: (agentId: string) => string
  onAgentRespond: (requestId: string, decision: PermissionDecision) => Promise<unknown>
  onOpenChanges: () => void
}

function textOf(message: Message): string {
  return message.parts.map((p) => p.content).join('')
}

function Attachments({ message }: { message: Message }) {
  if (message.attachments.length === 0) return null
  return (
    <div className="activity-rows activity-rows--end">
      {message.attachments.map((a) => (
        <div className="activity-row" key={a.id} title={`${a.mimeType} · ${a.sizeBytes.toLocaleString()} bytes`}>
          <span className="activity-row__icon">
            <FileIcon />
          </span>
          <span className="activity-row__title">{a.filename}</span>
          <span className="activity-row__subtitle">{formatFileSize(a.sizeBytes)}</span>
        </div>
      ))}
    </div>
  )
}

/** The assistant turn of a Plan / Build run that is still going: activity rows, prompts, then the model's words. */
function AgentLiveReply({
  live,
  finished,
  endedText,
  agentName,
  permissions,
  onRespond,
  onStop,
  modelName,
  onOpenChanges,
}: {
  live: LiveAgent | null
  finished: AgentRunDetail | null
  endedText: string
  agentName: (agentId: string) => string
  permissions: PermissionRequest[]
  onRespond: (requestId: string, decision: PermissionDecision) => Promise<unknown>
  onStop: () => void
  modelName: (modelId: string) => string
  onOpenChanges: () => void
}) {
  const model = live?.model ?? finished?.model ?? null
  const provider = live?.provider ?? finished?.provider ?? null
  return (
    <article className="assistant-message is-streaming">
      <header className="assistant-message__meta">
        {model ? <ModelChip provider={provider} label={modelName(model)} /> : <span className="chip chip--outline">AGENT</span>}
        <span className="assistant-message__time">{finished ? 'finishing…' : live ? 'working…' : 'starting…'}</span>
      </header>
      {live && <LiveAgentBlock live={live} agentName={agentName} permissions={permissions} onRespond={onRespond} onStop={onStop} />}
      {finished && <FinishedAgentBlock run={finished} agentName={agentName} permissions={permissions} onRespond={onRespond} />}
      {live && live.text !== '' && <Markdown streaming>{live.text}</Markdown>}
      {!live && endedText !== '' && <Markdown>{endedText}</Markdown>}
      {live && live.text === '' && live.toolRuns.length === 0 && (
        <div className="prose">
          <span className="stream-cursor" aria-label="working">
            ▍
          </span>
        </div>
      )}
      {finished && <ReportBlock run={finished} onOpenChanges={onOpenChanges} />}
    </article>
  )
}

/**
 * Conversation rendering. Structure from OpenCode (assistant text unboxed,
 * only the user's own turn is a block; compact one-line activity rows);
 * visual language from nochan (outline model chips, serif prose, bracketed
 * text actions, square code blocks). Every assistant turn carries a model
 * chip so a thread that switched models is legible at a glance.
 *
 * Orchestrated turns (compare columns, a review block, a round-table
 * transcript) are gathered by `buildThread` and rendered by their own views;
 * a plain chat thread renders exactly as it did before Phase 6.
 */
export function MessageList({
  messages,
  live,
  modelName,
  error,
  busy,
  onRegenerate,
  onOpenRegeneratePicker,
  regeneratePicker,
  onChoose,
  onRetryColumn,
  onSwitchColumn,
  columnPicker,
  onCancelColumn,
  onStop,
  onApplySuggestions,
  onRetryReview,
  agentRuns,
  agentLive,
  agentEndedText,
  agentPermissions,
  agentName,
  onAgentRespond,
  onOpenChanges,
}: Props) {
  const items = useMemo(() => buildThread(messages), [messages])
  const runByMessage = useMemo(() => new Map(agentRuns.filter((r) => r.assistantMessageId).map((r) => [r.assistantMessageId as string, r])), [agentRuns])

  if (messages.length === 0 && !live) {
    return (
      <div className="message-list message-list--empty empty-state">
        <p className="empty-state__title">New session</p>
        <p className="empty-state__hint">
          Type below to start. <kbd>+</kbd> attaches files · <kbd>Ctrl</kbd> <kbd>M</kbd> switches model ·{' '}
          <kbd>Ctrl</kbd> <kbd>K</kbd> opens commands
        </p>
      </div>
    )
  }

  const lastItem = items[items.length - 1]
  const lastReplyId = lastItem && lastItem.kind === 'reply' ? lastItem.message.id : null
  const lastUserIndex = items.map((i) => i.kind).lastIndexOf('user')
  const lastAnswerIndex = Math.max(
    ...items.map((item, index) => (item.kind === 'user' ? -1 : index)),
    -1,
  )
  // A failed send can leave the user turn last (nothing persisted after it).
  const errorAfterUser = !!error && !live && lastUserIndex > lastAnswerIndex

  const retrying = live?.kind === 'retry-column' ? live : null
  // A refusal or failure that no reply carries (a limit error, a missing key, an IPC
  // error before anything was persisted) would otherwise be invisible.
  const lastReplyFailed = lastItem?.kind === 'reply' && lastItem.message.status === 'error'
  const orphanError = !!error && !live && !errorAfterUser && !lastReplyFailed

  function renderItem(item: ThreadItem, index: number): ReactNode {
    switch (item.kind) {
      case 'user':
        return (
          <div key={item.message.id} className="user-message">
            <div className="user-message__text">{textOf(item.message)}</div>
            <Attachments message={item.message} />
            {errorAfterUser && index === lastUserIndex && (
              <ErrorLine error={error} onRetry={onRegenerate} onSwitchModel={onOpenRegeneratePicker} />
            )}
          </div>
        )
      case 'reply': {
        const message = item.message
        const isLast = message.id === lastReplyId
        const failed = message.status === 'error'
        const siblings = item.siblingCount > 1
        const dim = siblings && !message.inContext
        const agentRun = runByMessage.get(message.id) ?? null
        return (
          <article
            key={message.id}
            className={`assistant-message${failed ? ' is-failed' : ''}${dim ? ' is-dim' : ''}`}
          >
            <header className="assistant-message__meta">
              <ModelChip provider={message.provider} label={message.model ? modelName(message.model) : 'unknown'} />
              <span className="assistant-message__time">{formatRelativeTime(message.createdAt)}</span>
              {message.status === 'cancelled' && <span className="assistant-message__status">stopped</span>}
              {dim && <span className="chip chip--outline">NOT IN CONTEXT</span>}
            </header>
            {message.autoReason && message.model && (
              <p className="auto-line">{formatAutoLine(modelName(message.model), message.autoReason)}</p>
            )}
            {agentRun && (
              <FinishedAgentBlock run={agentRun} agentName={agentName} permissions={agentPermissions} onRespond={onAgentRespond} />
            )}
            {textOf(message) && <Markdown>{textOf(message)}</Markdown>}
            {agentRun && <ReportBlock run={agentRun} onOpenChanges={onOpenChanges} />}
            <Attachments message={message} />
            {failed && isLast && (
              <ErrorLine
                error={error ?? message.errorText}
                onRetry={onRegenerate}
                onSwitchModel={onOpenRegeneratePicker}
              />
            )}
            {/* A failed turn's [retry]/[switch model] replace these. */}
            {!(failed && isLast) && (
              <div className={`message-actions${isLast ? ' is-pinned' : ''}`}>
                <CopyAction text={textOf(message)} />
                {dim && (
                  <button type="button" className="link-action" onClick={() => onChoose(message.id)}>
                    [use this reply]
                  </button>
                )}
                {isLast && !busy && !agentRun && (
                  <>
                    <button type="button" className="link-action" onClick={onRegenerate}>
                      [regenerate]
                    </button>
                    <button type="button" className="link-action" onClick={onOpenRegeneratePicker}>
                      [regenerate with…]
                    </button>
                  </>
                )}
                {message.status === 'complete' && replyStats(viewOfMessage(message)) && (
                  <span className="message-actions__stats">{replyStats(viewOfMessage(message))}</span>
                )}
              </div>
            )}
            {isLast && regeneratePicker}
          </article>
        )
      }
      case 'compare': {
        const columns: CompareColumn[] = item.replies.map((reply) => {
          if (retrying && retrying.retryMessageId === reply.id && retrying.stream) {
            return {
              ...viewOfMessage(reply),
              phase: 'streaming',
              text: retrying.stream.text,
              errorText: null,
              requestId: retrying.stream.requestId,
              messageId: null,
            }
          }
          return viewOfMessage(reply)
        })
        return (
          <CompareView
            key={`group:${item.groupId}`}
            columns={columns}
            live={!!retrying}
            modelName={modelName}
            onChoose={onChoose}
            onRetry={onRetryColumn}
            onSwitchModel={onSwitchColumn}
            onCancelColumn={onCancelColumn}
            onStopAll={onStop}
            columnPicker={columnPicker}
          />
        )
      }
      case 'review': {
        const attached = live && live.attachToGroupId === item.groupId ? live : null
        const reviews =
          attached?.kind === 'retry-review'
            ? item.reviews.filter((r) => r.status === 'complete')
            : item.reviews
        return (
          <ReviewGroup
            key={`group:${item.groupId}`}
            primary={item.primary ? viewOfMessage(item.primary) : null}
            primaryCreatedAt={item.primary?.createdAt ?? null}
            reviews={reviews.map(viewOfMessage)}
            revisions={item.revisions.map(viewOfMessage)}
            modelName={modelName}
            liveBlock={attached?.steps[0] ?? null}
            busy={busy}
            onChoose={onChoose}
            onApplySuggestions={(reviewId) => item.primary && onApplySuggestions(item.primary.id, reviewId)}
            onRetryReview={() => item.primary && onRetryReview(item.primary.id)}
            onStop={onStop}
          />
        )
      }
      case 'roundtable':
        return (
          <RoundTableView
            key={`group:${item.groupId}`}
            turns={item.turns.map(viewOfMessage)}
            rounds={Math.max(1, ...item.turns.map((t) => t.roundIndex ?? 1))}
            live={false}
            modelName={modelName}
            onChoose={onChoose}
            onStop={onStop}
          />
        )
    }
  }

  return (
    <div className="message-list">
      {items.map(renderItem)}

      {live?.userText && (
        <div className="user-message">
          <div className="user-message__text">{live.userText}</div>
        </div>
      )}

      {(live?.kind === 'chat' || live?.kind === 'auto') && live.stream && (
        <article className="assistant-message is-streaming">
          <header className="assistant-message__meta">
            {live.stream.model ? (
              <ModelChip provider={live.stream.provider} label={modelName(live.stream.model)} />
            ) : (
              <span className="chip chip--outline">AUTO</span>
            )}
            <span className="assistant-message__time">{live.kind === 'auto' && !live.stream.model ? 'choosing a model…' : 'writing…'}</span>
          </header>
          {live.stream.autoReason && live.stream.model && (
            <p className="auto-line">{formatAutoLine(modelName(live.stream.model), live.stream.autoReason)}</p>
          )}
          {live.stream.text ? (
            // The blinking block cursor is drawn by CSS (`::after` on the last
            // paragraph/list item) so it sits at the end of the streamed text.
            <Markdown streaming>{live.stream.text}</Markdown>
          ) : (
            <div className="prose">
              <span className="stream-cursor" aria-label="generating">
                ▍
              </span>
            </div>
          )}
        </article>
      )}

      {live?.kind === 'compare' && (
        <CompareView
          columns={live.columns}
          live
          modelName={modelName}
          onChoose={onChoose}
          onRetry={onRetryColumn}
          onSwitchModel={onSwitchColumn}
          onCancelColumn={onCancelColumn}
          onStopAll={onStop}
          columnPicker={null}
        />
      )}

      {live?.kind === 'review' && (
        <ReviewGroup
          primary={(live.steps[0] as ReplyView | undefined) ?? null}
          primaryCreatedAt={null}
          reviews={[]}
          revisions={[]}
          modelName={modelName}
          liveBlock={live.steps[1] ?? null}
          busy
          onChoose={onChoose}
          onApplySuggestions={() => undefined}
          onRetryReview={() => undefined}
          onStop={onStop}
        />
      )}

      {live?.kind === 'roundtable' && (
        <RoundTableView
          turns={live.steps.filter(Boolean)}
          rounds={live.rounds}
          totalSteps={live.totalSteps}
          planned={live.planned}
          live
          modelName={modelName}
          onChoose={onChoose}
          onStop={onStop}
        />
      )}

      {live?.kind === 'agent' && (
        <AgentLiveReply
          live={agentLive && agentLive.runId === live.agentRunId ? agentLive : null}
          finished={agentRuns.find((r) => r.id === live.agentRunId) ?? null}
          endedText={agentEndedText && agentEndedText.runId === live.agentRunId ? agentEndedText.text : ''}
          agentName={agentName}
          permissions={agentPermissions}
          onRespond={onAgentRespond}
          onStop={onStop}
          modelName={modelName}
          onOpenChanges={onOpenChanges}
        />
      )}

      {orphanError && (
        <div className="error-line" role="alert">
          <span className="error-line__text">{describeProviderError(error ?? '')}</span>
        </div>
      )}

      {/* "[regenerate with…]" after a failed first turn (no assistant
          message to anchor to yet). */}
      {lastAnswerIndex === -1 && regeneratePicker}
    </div>
  )
}
