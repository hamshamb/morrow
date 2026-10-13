import { useEffect, useState } from 'react'
import type { AttachFilesResult, McpResourceInfo, McpServerState } from '@ai-workspace/shared'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@ai-workspace/shared'
import { STATUS_TEXT, cleanIpcError } from '../../lib/mcp-ui'

interface Props {
  onAttach: (result: AttachFilesResult) => void
  onClose: () => void
}

/**
 * Composer -> + -> "MCP resource…": pick a server, pick resources (a server lists documents, files or records it can
 * show), and they are read in the main process and added as ordinary pending attachments - text only, untrusted data
 * in the same `<attached_context>` block as a file you picked. Choosing a server connects it (that is the explicit action).
 */
export function McpResourcePicker({ onAttach, onClose }: Props) {
  const [servers, setServers] = useState<McpServerState[] | null>(null)
  const [serverId, setServerId] = useState<string | null>(null)
  const [resources, setResources] = useState<McpResourceInfo[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.mcp
      .list()
      .then((list) => setServers(list.filter((s) => s.config.enabled)))
      .catch((err) => setError(cleanIpcError(err)))
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function choose(id: string) {
    setServerId(id)
    setResources(null)
    setSelected(new Set())
    setError(null)
    setLoading(true)
    try {
      setResources(await window.api.mcp.resources(id))
    } catch (err) {
      setResources([])
      setError(cleanIpcError(err))
    } finally {
      setLoading(false)
    }
  }

  function toggle(uri: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(uri)) next.delete(uri)
      else if (next.size < MAX_ATTACHMENTS_PER_MESSAGE) next.add(uri)
      return next
    })
  }

  async function attach() {
    if (!serverId || selected.size === 0) return
    setReading(true)
    setError(null)
    try {
      const result = await window.api.mcp.readResources({ id: serverId, uris: [...selected] })
      onAttach(result)
      onClose()
    } catch (err) {
      setError(cleanIpcError(err))
      setReading(false)
    }
  }

  return (
    <div className="overlay" role="dialog" aria-label="Attach MCP resources" onMouseDown={onClose}>
      <div className="dialog mcp-picker" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 className="dialog__title">MCP resources</h2>
          <button type="button" className="link-action" onClick={onClose}>
            [close] <kbd>esc</kbd>
          </button>
        </header>
        <div className="mcp-picker__body">
          {servers === null ? (
            <p className="muted">loading…</p>
          ) : servers.length === 0 ? (
            <p className="muted">No enabled MCP servers. Add one in Settings, then come back.</p>
          ) : (
            <>
              <div className="label">server</div>
              <div className="rule-list" role="radiogroup" aria-label="Server">
                {servers.map((s) => (
                  <button
                    key={s.config.id}
                    type="button"
                    role="radio"
                    aria-checked={serverId === s.config.id}
                    className={`rule-list__row mcp-picker__server${serverId === s.config.id ? ' is-active' : ''}`}
                    onClick={() => void choose(s.config.id)}
                  >
                    <span className="mcp-server__name">{s.config.name}</span>
                    <span className={`chip chip--outline mcp-status mcp-status--${s.diagnostics.status}`}>{STATUS_TEXT[s.diagnostics.status]}</span>
                    <span className="muted">{s.config.transport}</span>
                  </button>
                ))}
              </div>

              {serverId && (
                <>
                  <div className="label mcp-picker__label">resources</div>
                  {loading ? (
                    <p className="muted">connecting and listing…</p>
                  ) : resources && resources.length === 0 ? (
                    <p className="muted">{error ? '' : 'This server offers no resources.'}</p>
                  ) : (
                    <div className="rule-list mcp-picker__list" role="group" aria-label="Resources">
                      {resources?.map((r) => (
                        <label key={r.uri} className="rule-list__row mcp-resource">
                          <input type="checkbox" checked={selected.has(r.uri)} onChange={() => toggle(r.uri)} />
                          <span className="mcp-resource__main">
                            <span className="mcp-resource__name">{r.title ?? r.name}</span>
                            <span className="muted mcp-resource__uri">{r.uri}</span>
                          </span>
                          <span className="muted mcp-resource__mime">{r.mimeType ?? ''}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {error && (
            <p className="signal" role="alert">
              {error}
            </p>
          )}
          <p className="muted mcp-picker__note">Only text is attached, and it is treated as untrusted reference data, like any attached file.</p>
        </div>
        <footer className="mcp-picker__footer">
          <button type="button" className="link-action" disabled={selected.size === 0 || reading} onClick={() => void attach()}>
            {reading ? '[reading…]' : selected.size === 0 ? '[attach]' : `[attach ${selected.size}]`}
          </button>
          <button type="button" className="link-action" onClick={onClose}>
            [cancel]
          </button>
        </footer>
      </div>
    </div>
  )
}
