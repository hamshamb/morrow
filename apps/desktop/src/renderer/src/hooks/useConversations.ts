import { useCallback, useEffect, useState } from 'react'
import type { Conversation } from '@ai-workspace/shared'

export function useConversations(workspaceId: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setConversations([])
      setLoading(false)
      return
    }
    setLoading(true)
    const list = await window.api.conversations.list(workspaceId)
    setConversations(list)
    setLoading(false)
  }, [workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Keep the active conversation valid as the list changes (workspace switch,
  // creation, deletion) without ever auto-selecting across a branch/no-op.
  useEffect(() => {
    setActiveId((current) => {
      if (current && conversations.some((c) => c.id === current)) return current
      return conversations[0]?.id ?? null
    })
  }, [conversations])

  const create = useCallback(
    async (title?: string) => {
      if (!workspaceId) throw new Error('No active workspace')
      const created = await window.api.conversations.create({ workspaceId, title })
      await refresh()
      setActiveId(created.id)
      return created
    },
    [workspaceId, refresh],
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.conversations.delete(id)
      await refresh()
    },
    [refresh],
  )

  const rename = useCallback(
    async (id: string, title: string) => {
      await window.api.conversations.rename({ id, title })
      await refresh()
    },
    [refresh],
  )

  return { conversations, activeId, setActiveId, loading, create, remove, rename, refresh }
}
