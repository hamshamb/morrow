import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitChange, GitCommitSummary, GitStatus } from '@ai-workspace/shared'
import { ipcErrorMessage } from '../lib/code/paths'

const POLL_MS = 4000

interface Options {
  workspaceId: string | null
  hasRoot: boolean
  /** The git view (or anything showing status) is on screen: poll while true. */
  visible: boolean
  log: (level: 'info' | 'error', text: string) => void
  /** Called after a commit / stage change so open editors can re-read disk. */
  onRepoChanged?: () => void
}

/** Pass both names of a renamed file so staging moves the whole rename. */
export function pathsOf(change: GitChange): string[] {
  return change.origPath ? [change.path, change.origPath] : [change.path]
}

/**
 * Single owner of the repository status (branch, commit, staged / unstaged /
 * untracked) and the few mutating actions: stage, unstage, commit. Refreshes
 * on mount, window focus, after every action and every few seconds while the
 * git view is visible. There is no push / reset / clean anywhere.
 */
export function useGitStatus({ workspaceId, hasRoot, visible, log, onRepoChanged }: Options) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const idRef = useRef(workspaceId)

  useEffect(() => {
    idRef.current = workspaceId
  }, [workspaceId])

  const refresh = useCallback(async (): Promise<void> => {
    const id = idRef.current
    if (!id || !hasRoot) {
      setStatus(null)
      return
    }
    const mine = ++seq.current
    setLoading(true)
    try {
      const next = await window.api.git.status(id)
      if (mine === seq.current && idRef.current === id) setStatus(next)
    } catch (err) {
      if (mine === seq.current) setStatus({ state: 'error', message: ipcErrorMessage(err) })
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [hasRoot])

  useEffect(() => {
    setStatus(null)
    setError(null)
    void refresh()
  }, [workspaceId, hasRoot, refresh])

  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => {
    if (!visible) return
    void refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [visible, refresh, busy])

  const run = useCallback(
    async (label: string, action: (workspaceId: string) => Promise<unknown>, quiet = false): Promise<boolean> => {
      const id = idRef.current
      if (!id) return false
      setBusy(true)
      setError(null)
      try {
        await action(id)
        if (!quiet) log('info', label)
        return true
      } catch (err) {
        const message = ipcErrorMessage(err)
        setError(message)
        log('error', `${label} failed: ${message}`)
        return false
      } finally {
        setBusy(false)
        await refresh()
        onRepoChanged?.()
      }
    },
    [log, onRepoChanged, refresh],
  )

  const stage = useCallback(
    (changes: GitChange[]) => {
      const paths = [...new Set(changes.flatMap(pathsOf))]
      return run(`staged ${paths.length === 1 ? (paths[0] ?? '') : `${paths.length} paths`}`, (workspaceId) => window.api.git.stage({ workspaceId, paths }))
    },
    [run],
  )
  const unstage = useCallback(
    (changes: GitChange[]) => {
      const paths = [...new Set(changes.flatMap(pathsOf))]
      return run(`unstaged ${paths.length === 1 ? (paths[0] ?? '') : `${paths.length} paths`}`, (workspaceId) => window.api.git.unstage({ workspaceId, paths }))
    },
    [run],
  )
  const stageAll = useCallback(() => run('staged all changes', (workspaceId) => window.api.git.stageAll(workspaceId)), [run])
  const unstageAll = useCallback(() => run('unstaged all changes', (workspaceId) => window.api.git.unstageAll(workspaceId)), [run])

  const commit = useCallback(
    async (message: string): Promise<GitCommitSummary | null> => {
      let summary: GitCommitSummary | null = null
      const ok = await run(
        'commit',
        async (workspaceId) => {
          const created = await window.api.git.commit({ workspaceId, message })
          summary = created
          log('info', `committed ${created.shortSha} ${created.subject}`)
        },
        true,
      )
      return ok ? summary : null
    },
    [log, run],
  )

  return { status, loading, busy, error, refresh, stage, unstage, stageAll, unstageAll, commit, clearError: () => setError(null) }
}

export type GitState = ReturnType<typeof useGitStatus>
