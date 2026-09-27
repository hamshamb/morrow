import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'
import { FileIcon } from './icons'

interface StreamingMessage {
  text: string
}

interface Props {
  messages: Message[]
  streaming: StreamingMessage | null
}

function partsToText(message: Message): string {
  return message.parts.map((p) => p.content).join('')
}

function Attribution({ message }: { message: Message }) {
  if (message.role !== 'assistant') return null
  const providerLabel = message.provider ? PROVIDER_LABELS[message.provider] : 'Unknown'
  return (
    <div className="message__attribution">
      {providerLabel}
      {message.model ? ` · ${message.model}` : ''}
      {message.status === 'error' && <span className="message__status message__status--error"> · error</span>}
      {message.status === 'cancelled' && (
        <span className="message__status message__status--cancelled"> · cancelled</span>
      )}
    </div>
  )
}

function AttachmentChips({ message }: { message: Message }) {
  if (message.attachments.length === 0) return null
  return (
    <div className="activity-row-list">
      {message.attachments.map((a) => (
        <div className="activity-row" key={a.id} title={`${a.mimeType} · ${a.sizeBytes.toLocaleString()} bytes`}>
          <span className="activity-row__icon">
            <FileIcon />
          </span>
          <span className="activity-row__title">{a.filename}</span>
          <span className="activity-row__subtitle">{a.mimeType}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Assistant messages render as plain flowing text (no background, border,
 * or padding); only user messages are right-aligned bubbles with a soft
 * raised background. This asymmetric model is ported from OpenCode's
 * `[data-component="assistant-message"]` / `[data-component="user-message"]`
 * rules (`message-part.css`, MIT License) — see
 * docs/UI_REFERENCE_OPENCODE.md §5 and docs/OPEN_SOURCE_INVENTORY.md.
 */
export function MessageList({ messages, streaming }: Props) {
  if (messages.length === 0 && !streaming) {
    return (
      <div className="message-list message-list--empty">
        <p>No messages yet. Say hello below.</p>
      </div>
    )
  }

  return (
    <div className="message-list">
      {messages.map((message) =>
        message.role === 'user' ? (
          <div key={message.id} className="user-message">
            <div className="user-message__body">
              <div className="user-message__text">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{partsToText(message)}</ReactMarkdown>
              </div>
            </div>
            <AttachmentChips message={message} />
          </div>
        ) : (
          <div key={message.id} className="assistant-message">
            <Attribution message={message} />
            <div className="assistant-message__text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{partsToText(message)}</ReactMarkdown>
            </div>
            <AttachmentChips message={message} />
          </div>
        ),
      )}
      {streaming && (
        <div className="assistant-message assistant-message--streaming">
          <div className="message__attribution">Generating…</div>
          <div className="assistant-message__text">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming.text || '…'}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
