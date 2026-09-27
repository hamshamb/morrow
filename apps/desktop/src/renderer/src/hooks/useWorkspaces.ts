import { useCallback, useEffect, useState } from 'react'
import type { CreateWorkspaceInput, Workspace } from '@ai-workspace/shared'

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const list = await window.api.workspaces.list()
      setWorkspaces(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(
    async (input: CreateWorkspaceInput) => {
      const created = await window.api.workspaces.create(input)
      await refresh()
      return created
    },
    [refresh],
  )

  const rename = useCallback(
    async (id: string, name: string) => {
      await window.api.workspaces.update({ id, name })
      await refresh()
    },
    [refresh],
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.workspaces.delete(id)
      await refresh()
    },
    [refresh],
  )

  return { workspaces, loading, error, create, rename, remove, refresh }
}
