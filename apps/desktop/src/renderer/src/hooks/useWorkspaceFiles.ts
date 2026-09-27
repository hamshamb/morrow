import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceFileIndexEntry, WorkspaceFileRoot, WorkspaceFileSearchResult } from '@ai-workspace/shared'

/**
 * Single owner of a workspace's file-root/index state — lifted here (rather
 * than called independently from both a files browser and the chat
 * composer) to avoid the two-unsynced-copies bug fixed in commit 28eb009
 * (Phase 2): whichever component calls `useProviderConfigs()` a second time
 * showed stale data after the other one saved. See BUILD_STATE.md.
 */
export function useWorkspaceFiles(workspaceId: string | null) {
  const [root, setRoot] = useState<WorkspaceFileRoot | null>(null)
  const [files, setFiles] = useState<WorkspaceFileIndexEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setRoot(null)
      setFiles([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setError(null)
      const currentRoot = await window.api.workspaceFiles.getRoot(workspaceId)
      setRoot(currentRoot)
      setFiles(currentRoot ? await window.api.workspaceFiles.list(workspaceId) : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const pickRoot = useCallback(async () => {
    if (!workspaceId) throw new Error('No active workspace')
    setIndexing(true)
    try {
      setError(null)
      const result = await window.api.workspaceFiles.pickRoot(workspaceId)
      if (result) {
        setRoot(result.root)
        setFiles(await window.api.workspaceFiles.list(workspaceId))
      }
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setIndexing(false)
    }
  }, [workspaceId])

  const reindex = useCallback(async () => {
    if (!workspaceId) throw new Error('No active workspace')
    setIndexing(true)
    try {
      setError(null)
      const result = await window.api.workspaceFiles.reindex(workspaceId)
      setRoot(result.root)
      setFiles(await window.api.workspaceFiles.list(workspaceId))
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setIndexing(false)
    }
  }, [workspaceId])

  const search = useCallback(
    (query: string): Promise<WorkspaceFileSearchResult[]> => {
      if (!workspaceId || !query.trim()) return Promise.resolve([])
      return window.api.workspaceFiles.search(workspaceId, query)
    },
    [workspaceId],
  )

  return { root, files, loading, indexing, error, pickRoot, reindex, search, refresh }
}
