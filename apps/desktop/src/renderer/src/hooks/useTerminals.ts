import { useCallback, useEffect, useRef, useState } from 'react'
import type { TerminalEvent, TerminalInfo } from '@ai-workspace/shared'
import { ipcErrorMessage } from '../lib/code/paths'

const REPLAY_CHARS = 400_000

interface Options {
  workspaceId: string | null
  hasRoot: boolean
  log: (level: 'info' | 'error', text: string) => void
}

interface Channel {
  /** Output so far (bounded) - replayed into a view that attaches late or re-mounts. */
  history: string
  writer: ((data: string) => void) | null
}

/**
 * Single owner of the terminal tabs for a workspace. It subscribes ONCE to the
 * main process's terminal event stream, keeps each terminal's recent output,
 * and hands a view the backlog + live data when it attaches - so the first
 * prompt is never lost between `create` resolving and xterm mounting.
 *
 * `create` is only ever called from a user action (the panel's toggle / the
 * [+ new terminal] button); nothing here, and nothing an AI feature can reach,
 * writes to a terminal.
 */
export function useTerminals({ workspaceId, hasRoot, log }: Options) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const channels = useRef(new Map<string, Channel>())
  const idRef = useRef(workspaceId)
  const terminalsRef = useRef<TerminalInfo[]>([])

  useEffect(() => {
    idRef.current = workspaceId
  }, [workspaceId])

  /** Updates the list and its ref together, so back-to-back changes (restart = create + close) never see a stale list. */
  const apply = useCallback((update: (prev: TerminalInfo[]) => TerminalInfo[]): TerminalInfo[] => {
    const next = update(terminalsRef.current)
    terminalsRef.current = next
    setTerminals(next)
    return next
  }, [])

  const channel = useCallback((id: string): Channel => {
    let c = channels.current.get(id)
    if (!c) {
      c = { history: '', writer: null }
      channels.current.set(id, c)
    }
    return c
  }, [])

  useEffect(() => {
    return window.api.terminal.onEvent((event: TerminalEvent) => {
      if (event.type === 'data') {
        const c = channel(event.id)
        c.history += event.data
        if (c.history.length > REPLAY_CHARS) c.history = c.history.slice(-REPLAY_CHARS)
        c.writer?.(event.data)
        return
      }
      apply((prev) => prev.map((t) => (t.id === event.id ? { ...t, status: 'exited', exitCode: event.exitCode, pid: null } : t)))
      const code = event.exitCode
      log('info', `terminal exited${code === null ? '' : ` with code ${code}`}`)
    })
  }, [apply, channel, log])

  // Re-adopt terminals still alive in the main process (renderer reload, workspace switch back).
  useEffect(() => {
    apply(() => [])
    setActiveId(null)
    setError(null)
    if (!workspaceId || !hasRoot) return
    let cancelled = false
    void window.api.terminal
      .list(workspaceId)
      .then(async (list) => {
        if (cancelled) return
        for (const t of list) {
          const c = channel(t.id)
          if (c.history === '') c.history = await window.api.terminal.getBuffer(t.id)
        }
        if (cancelled) return
        apply(() => list)
        setActiveId((current) => current ?? list[0]?.id ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceId, hasRoot, channel, apply])

  const create = useCallback(async (): Promise<TerminalInfo | null> => {
    const id = idRef.current
    if (!id) return null
    setError(null)
    try {
      const info = await window.api.terminal.create({ workspaceId: id, cols: 100, rows: 24 })
      if (idRef.current !== id) {
        // The user switched workspace meanwhile; the shell stays alive in the main process.
        return info
      }
      apply((prev) => [...prev, info])
      setActiveId(info.id)
      log('info', `started ${info.title} in ${info.cwd}`)
      return info
    } catch (err) {
      const message = ipcErrorMessage(err)
      setError(message)
      log('error', `could not start a terminal: ${message}`)
      return null
    }
  }, [apply, log])

  /** Closes the tab and kills the process if it is still running. */
  const close = useCallback(
    async (id: string) => {
      channels.current.delete(id)
      const next = apply((prev) => prev.filter((t) => t.id !== id))
      setActiveId((current) => (current === id ? (next[next.length - 1]?.id ?? null) : current))
      try {
        await window.api.terminal.kill(id)
      } catch {
        // already gone
      }
    },
    [apply],
  )

  /** Kill + start a fresh shell in the same workspace; the new tab takes the old one's place. */
  const restart = useCallback(
    async (id: string) => {
      const created = await create()
      if (created) await close(id)
    },
    [close, create],
  )

  const attach = useCallback(
    (id: string, writer: (data: string) => void): { replay: string; detach: () => void } => {
      const c = channel(id)
      c.writer = writer
      return {
        replay: c.history,
        detach: () => {
          if (c.writer === writer) c.writer = null
        },
      }
    },
    [channel],
  )

  const write = useCallback((id: string, data: string) => {
    void window.api.terminal.write(id, data).catch(() => undefined)
  }, [])

  const resize = useCallback((id: string, cols: number, rows: number) => {
    void window.api.terminal.resize({ id, cols, rows }).catch(() => undefined)
  }, [])

  return { terminals, activeId, setActiveId, error, create, close, restart, attach, write, resize }
}

export type TerminalsState = ReturnType<typeof useTerminals>
