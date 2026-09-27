import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'

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
      {messages.map((message) => (
        <div key={message.id} className={`message message--${message.role}`}>
          <Attribution message={message} />
          <div className="message__content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{partsToText(message)}</ReactMarkdown>
          </div>
          {message.attachments.length > 0 && (
            <div className="message__attachments">
              {message.attachments.map((a) => (
                <span key={a.id} className="message__attachment-chip" title={`${a.mimeType} · ${a.sizeBytes} bytes`}>
                  📎 {a.filename}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      {streaming && (
        <div className="message message--assistant message--streaming">
          <div className="message__attribution">Generating…</div>
          <div className="message__content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming.text || '…'}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
