import { useCallback, useEffect, useState } from 'react'
import type { ChatStreamEvent, Message } from '@ai-workspace/shared'

interface StreamingState {
  requestId: string
  text: string
}

export function useChat(conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [streaming, setStreaming] = useState<StreamingState | null>(null)
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
    void refresh()
  }, [refresh])

  const send = useCallback(
    async (providerConfigId: string, model: string, content: string) => {
      if (!conversationId) throw new Error('No active conversation')
      setError(null)
      setSending(true)
      const requestId = crypto.randomUUID()
      setStreaming({ requestId, text: '' })

      const unsubscribe = window.api.chat.onStreamEvent(requestId, (event: ChatStreamEvent) => {
        if (event.type === 'delta') {
          setStreaming((current) =>
            current && current.requestId === requestId
              ? { ...current, text: current.text + event.delta }
              : current,
          )
        } else if (event.type === 'error') {
          setError(event.message)
        }
      })

      try {
        await window.api.chat.sendMessage({ requestId, conversationId, providerConfigId, model, content })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        unsubscribe()
        setStreaming(null)
        setSending(false)
        await refresh()
      }
    },
    [conversationId, refresh],
  )

  /** Re-submits the most recent user turn, optionally against a different provider/model. */
  const regenerate = useCallback(
    async (providerConfigId: string, model: string) => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      if (!lastUser) return
      const content = lastUser.parts.map((p) => p.content).join('')
      if (!content) return
      await send(providerConfigId, model, content)
    },
    [messages, send],
  )

  const cancel = useCallback(() => {
    if (streaming) void window.api.chat.cancel(streaming.requestId)
  }, [streaming])

  return { messages, loading, sending, streaming, error, send, regenerate, cancel, refresh }
}
