import { useState, type ReactNode } from 'react'
import type { Message, ProviderId } from '@ai-workspace/shared'
import { useProviderRegistry } from '../hooks/useProviderRegistry'
import { describeProviderError } from '../lib/provider-error'
import { formatRelativeTime } from '../lib/time'
import { Markdown } from './Markdown'
import { FileIcon } from './icons'

interface StreamingMessage {
  text: string
}

interface Props {
  messages: Message[]
  streaming: StreamingMessage | null
  /** Short model name for attribution chips (catalog display name aware). */
  modelName: (modelId: string) => string
  /** The provider/model the next response would come from — shown on the
   * streaming placeholder before the message is persisted. */
  pendingModel: { provider: ProviderId; model: string } | null
  /** Transient error from the last send (useChat) — rendered in plain
   * language under the failed message, never raw. */
  error: string | null
  busy: boolean
  onRegenerate: () => void
  onOpenRegeneratePicker: () => void
  /** The "[regenerate with…]" model picker, rendered under the last
   * response's actions while open. */
  regeneratePicker: ReactNode
}

function textOf(message: Message): string {
  return message.parts.map((p) => p.content).join('')
}

function ModelChip({ provider, label }: { provider: ProviderId | null; label: string }) {
  const registry = useProviderRegistry()
  return (
    <span className="chip chip--outline">
      {label}
      {provider ? ` · ${registry.label(provider)}` : ''}
    </span>
  )
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="link-action"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? '[copied]' : '[copy]'}
    </button>
  )
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
          <span className="activity-row__subtitle">{(a.sizeBytes / 1024).toFixed(1)} kB</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Conversation rendering. Structure from OpenCode (assistant text unboxed,
 * only the user's own turn is a block; compact one-line activity rows);
 * visual language from nochan (outline model chips, serif prose, bracketed
 * text actions, square code blocks). Every assistant turn carries a model
 * chip so a thread that switched models is legible at a glance.
 */
export function MessageList({
  messages,
  streaming,
  modelName,
  pendingModel,
  error,
  busy,
  onRegenerate,
  onOpenRegeneratePicker,
  regeneratePicker,
}: Props) {
  if (messages.length === 0 && !streaming) {
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

  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf('assistant')
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user')
  // A failed send can leave the user turn last (nothing persisted after it).
  const errorAfterUser = !!error && !streaming && lastUserIndex > lastAssistantIndex

  return (
    <div className="message-list">
      {messages.map((message, index) => {
        if (message.role === 'user') {
          return (
            <div key={message.id} className="user-message">
              <div className="user-message__text">{textOf(message)}</div>
              <Attachments message={message} />
              {errorAfterUser && index === lastUserIndex && (
                <ErrorLine error={error} onRetry={onRegenerate} onSwitchModel={onOpenRegeneratePicker} />
              )}
            </div>
          )
        }
        const isLast = index === lastAssistantIndex
        const failed = message.status === 'error'
        return (
          <article key={message.id} className={`assistant-message${failed ? ' is-failed' : ''}`}>
            <header className="assistant-message__meta">
              <ModelChip provider={message.provider} label={message.model ? modelName(message.model) : 'unknown'} />
              <span className="assistant-message__time">{formatRelativeTime(message.createdAt)}</span>
              {message.status === 'cancelled' && <span className="assistant-message__status">stopped</span>}
            </header>
            {textOf(message) && <Markdown>{textOf(message)}</Markdown>}
            <Attachments message={message} />
            {failed && isLast && (
              <ErrorLine error={error} onRetry={onRegenerate} onSwitchModel={onOpenRegeneratePicker} />
            )}
            {/* A failed turn's [retry]/[switch model] replace these. */}
            {!(failed && isLast) && (
            <div className={`message-actions${isLast ? ' is-pinned' : ''}`}>
              <CopyAction text={textOf(message)} />
              {isLast && !busy && (
                <>
                  <button type="button" className="link-action" onClick={onRegenerate}>
                    [regenerate]
                  </button>
                  <button type="button" className="link-action" onClick={onOpenRegeneratePicker}>
                    [regenerate with…]
                  </button>
                </>
              )}
            </div>
            )}
            {isLast && regeneratePicker}
          </article>
        )
      })}
      {streaming && (
        <article className="assistant-message is-streaming">
          <header className="assistant-message__meta">
            {pendingModel && <ModelChip provider={pendingModel.provider} label={modelName(pendingModel.model)} />}
            <span className="assistant-message__time">writing…</span>
          </header>
          {streaming.text ? (
            // The blinking block cursor is drawn by CSS (`::after` on the last
            // paragraph/list item) so it sits at the end of the streamed text.
            <Markdown streaming>{streaming.text}</Markdown>
          ) : (
            <div className="prose">
              <span className="stream-cursor" aria-label="generating">
                ▍
              </span>
            </div>
          )}
        </article>
      )}
      {/* "[regenerate with…]" after a failed first turn (no assistant
          message to anchor to yet). */}
      {lastAssistantIndex === -1 && regeneratePicker}
    </div>
  )
}

function ErrorLine({
  error,
  onRetry,
  onSwitchModel,
}: {
  error: string | null
  onRetry: () => void
  onSwitchModel: () => void
}) {
  return (
    <div className="error-line" role="alert">
      <span className="error-line__text">{describeProviderError(error ?? '')}</span>
      <button type="button" className="link-action" onClick={onRetry}>
        [retry]
      </button>
      <button type="button" className="link-action" onClick={onSwitchModel}>
        [switch model]
      </button>
    </div>
  )
}
