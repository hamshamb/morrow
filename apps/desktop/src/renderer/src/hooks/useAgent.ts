import { useCallback, useEffect, useReducer, useState } from 'react'
import type { AgentRunDetail, PermissionDecision, RespondPermissionResult } from '@ai-workspace/shared'
import { initialAgentState, reduceAgent, upsertRun } from '../lib/agent-ui'

/**
 * The renderer's view of agent runs. ONE instance (owned by `WorkspaceView`, the single-owner pattern) listens to the
 * main process's event stream and holds: the run in progress, the permission prompts waiting for an answer, the
 * persisted runs of the active conversation, and the log of command output for the bottom panel. The renderer only
 * displays and answers: the main process decides what may run (ADR-041).
 */
export function useAgent(conversationId: string | null) {
  const [state, dispatch] = useReducer(reduceAgent, initialAgentState)
  const [runs, setRuns] = useState<AgentRunDetail[]>([])
  const [error, setError] = useState<string | null>(null)

  // One subscription for the lifetime of the view.
  useEffect(() => {
    const unsubscribe = window.api.agent.onEvent((event) => {
      dispatch({ type: 'event', event })
      if (event.type === 'run-end') setRuns((current) => upsertRun(current, event.detail))
    })
    // Prompts that were already waiting when this view mounted (a renderer reload mid-run).
    void window.api.agent
      .pendingPermissions()
      .then((requests) => dispatch({ type: 'pending', requests }))
      .catch(() => undefined)
    return unsubscribe
  }, [])

  // Persisted runs of the open conversation.
  useEffect(() => {
    let cancelled = false
    if (!conversationId) {
      setRuns([])
      return
    }
    void window.api.agent
      .listRuns(conversationId)
      .then((list) => {
        if (!cancelled) setRuns(list.filter((r) => r.status !== 'running'))
      })
      .catch(() => {
        if (!cancelled) setRuns([])
      })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  const respond = useCallback(async (requestId: string, decision: PermissionDecision): Promise<RespondPermissionResult> => {
    try {
      const result = await window.api.agent.respondPermission({ requestId, decision })
      if (!result.ok) setError(result.reason ?? 'That answer was not accepted.')
      return result
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      setError(reason)
      return { ok: false, reason }
    }
  }, [])

  const cancel = useCallback((runId: string) => void window.api.agent.cancel(runId), [])
  const clearOutput = useCallback(() => dispatch({ type: 'reset-output' }), [])

  return {
    live: state.live,
    endedText: state.endedText,
    permissions: state.permissions,
    outputLog: state.outputLog,
    runs: conversationId ? runs.filter((r) => r.conversationId === conversationId) : [],
    error,
    clearError: () => setError(null),
    respond,
    cancel,
    clearOutput,
  }
}

export type AgentState = ReturnType<typeof useAgent>
