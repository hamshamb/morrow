import { useCallback, useEffect, useState } from 'react'
import type { McpDiagnostics, McpServerState, SaveMcpServerInput } from '@ai-workspace/shared'
import { cleanIpcError } from '../lib/mcp-ui'

/**
 * The renderer's view of MCP servers: the saved definitions with their live status. It only displays and asks; every
 * connection, spawn and secret is the main process's (ADR-047). Status pushes from main update rows in place.
 */
export function useMcp() {
  const [servers, setServers] = useState<McpServerState[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setServers(await window.api.mcp.list())
      setError(null)
    } catch (err) {
      setError(cleanIpcError(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.api.mcp.onEvent((event) => {
      if (event.type === 'removed') {
        setServers((current) => current?.filter((s) => s.config.id !== event.serverId) ?? current)
        return
      }
      setServers((current) => current?.map((s) => (s.config.id === event.diagnostics.serverId ? { ...s, diagnostics: event.diagnostics } : s)) ?? current)
    })
  }, [refresh])

  const replace = useCallback((state: McpServerState) => {
    setServers((current) => {
      if (!current) return [state]
      return current.some((s) => s.config.id === state.config.id) ? current.map((s) => (s.config.id === state.config.id ? state : s)) : [...current, state]
    })
  }, [])

  const save = useCallback(
    async (input: SaveMcpServerInput): Promise<McpServerState> => {
      try {
        const state = await window.api.mcp.save(input)
        replace(state)
        return state
      } catch (err) {
        throw new Error(cleanIpcError(err))
      }
    },
    [replace],
  )

  const remove = useCallback(async (id: string) => {
    try {
      await window.api.mcp.delete(id)
      setServers((current) => current?.filter((s) => s.config.id !== id) ?? current)
    } catch (err) {
      setError(cleanIpcError(err))
    }
  }, [])

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        replace(await window.api.mcp.setEnabled({ id, enabled }))
      } catch (err) {
        setError(cleanIpcError(err))
      }
    },
    [replace],
  )

  const test = useCallback(
    async (id: string): Promise<McpDiagnostics | null> => {
      try {
        const diagnostics = await window.api.mcp.test(id)
        setServers((current) => current?.map((s) => (s.config.id === id ? { ...s, diagnostics } : s)) ?? current)
        return diagnostics
      } catch (err) {
        setError(cleanIpcError(err))
        return null
      }
    },
    [],
  )

  return { servers, error, refresh, save, remove, setEnabled, test, clearError: () => setError(null) }
}
