import { useEffect, useState } from 'react'
import type { ProviderConfigSummary } from '@ai-workspace/shared'
import { useConversations } from '../hooks/useConversations'
import { useChat } from '../hooks/useChat'
import { ModelSelector } from './ModelSelector'
import { MessageList } from './MessageList'
import { PROVIDER_MODELS } from '../lib/models'

interface Props {
  workspaceId: string
  providerConfigs: ProviderConfigSummary[]
}

export function ChatPanel({ workspaceId, providerConfigs }: Props) {
  const { conversations, activeId, setActiveId, create, remove } = useConversations(workspaceId)
  const { messages, sending, streaming, error, send, regenerate, cancel } = useChat(activeId)

  const [providerConfigId, setProviderConfigId] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (providerConfigId || providerConfigs.length === 0) return
    const first = providerConfigs[0]
    if (!first) return
    setProviderConfigId(first.id)
    setModel(PROVIDER_MODELS[first.provider][0]?.id ?? null)
  }, [providerConfigId, providerConfigs])

  async function handleSend() {
    const trimmed = draft.trim()
    if (!trimmed || !providerConfigId || !model || sending) return
    setDraft('')
    await send(providerConfigId, model, trimmed)
  }

  return (
    <div className="chat-panel">
      <aside className="chat-panel__conversations">
        <div className="chat-panel__conversations-header">
          <span>Conversations</span>
          <button type="button" onClick={() => void create()} aria-label="New conversation">
            +
          </button>
        </div>
        <nav>
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`chat-panel__conversation${conversation.id === activeId ? ' is-active' : ''}`}
            >
              <button type="button" onClick={() => setActiveId(conversation.id)}>
                {conversation.title}
              </button>
              <button
                type="button"
                className="chat-panel__conversation-delete"
                aria-label="Delete conversation"
                onClick={() => void remove(conversation.id)}
              >
                ×
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="chat-panel__empty">No conversations yet.</p>
          )}
        </nav>
      </aside>

      <div className="chat-panel__thread">
        {!activeId ? (
          <div className="chat-panel__placeholder">
            <p>Create a conversation to start chatting.</p>
          </div>
        ) : (
          <>
            <div className="chat-panel__messages">
              <MessageList messages={messages} streaming={streaming} />
            </div>

            {error && <p className="chat-panel__error">{error}</p>}

            <div className="chat-panel__composer">
              <div className="chat-panel__composer-row">
                <ModelSelector
                  configs={providerConfigs}
                  providerConfigId={providerConfigId}
                  model={model}
                  onChange={(pc, m) => {
                    setProviderConfigId(pc)
                    setModel(m)
                  }}
                />
                {sending ? (
                  <button type="button" onClick={cancel} className="chat-panel__cancel-btn">
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => providerConfigId && model && void regenerate(providerConfigId, model)}
                    disabled={messages.every((m) => m.role !== 'user')}
                    className="chat-panel__regenerate-btn"
                  >
                    Regenerate
                  </button>
                )}
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
                placeholder={
                  providerConfigs.length === 0
                    ? 'Add a provider API key in Settings to start chatting…'
                    : 'Message… (Enter to send, Shift+Enter for a new line)'
                }
                disabled={sending || providerConfigs.length === 0}
              />
              <button
                type="button"
                className="chat-panel__send-btn"
                onClick={() => void handleSend()}
                disabled={sending || !draft.trim() || providerConfigs.length === 0}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
