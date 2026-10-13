import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpServerState, McpToolInfo } from '@ai-workspace/shared'
import { cleanIpcError, connectedSince, hintBadges } from '../../lib/mcp-ui'

interface Props {
  state: McpServerState
}

/**
 * What is going on with one server: the handshake, the counts, the last error, the tail of a stdio server's stderr and
 * its tools - each with a switch and the hints the server claims about it. The hints are shown as claims
 * ("says read-only"): the app asks about every call either way, and a "destructive" claim only makes it ask louder.
 */
export function McpDiagnosticsPanel({ state }: Props) {
  const { config, diagnostics: d } = state
  const [tools, setTools] = useState<McpToolInfo[] | null>(null)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const stderrRef = useRef<HTMLPreElement>(null)
  const connected = d.status === 'connected'

  const loadTools = useCallback(async () => {
    try {
      setTools(await window.api.mcp.tools(config.id))
      setToolsError(null)
    } catch (err) {
      setTools([])
      setToolsError(cleanIpcError(err))
    }
  }, [config.id])

  // The tool list is read from the live connection, so it follows connect / reconnect / list_changed.
  useEffect(() => {
    if (connected) void loadTools()
    else setTools(null)
  }, [connected, d.toolCount, loadTools])

  useEffect(() => {
    const el = stderrRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [d.stderrTail.length])

  async function toggle(tool: McpToolInfo) {
    try {
      setTools(await window.api.mcp.setToolEnabled({ id: config.id, tool: tool.name, enabled: !tool.enabled }))
    } catch (err) {
      setToolsError(cleanIpcError(err))
    }
  }

  const facts: [string, string][] = [
    ['server', d.serverInfo ? `${d.serverInfo.title ?? d.serverInfo.name} ${d.serverInfo.version}` : '–'],
    ['protocol', d.protocolVersion ?? '–'],
    ['transport', d.transportUsed ?? config.transport],
    ['tools', String(d.toolCount)],
    ['resources', String(d.resourceCount)],
    ['connected', d.status === 'connected' ? connectedSince(d) : '–'],
    ...(config.transport === 'stdio' ? ([['process', d.pid === null ? '–' : `pid ${d.pid}`]] as [string, string][]) : []),
  ]

  return (
    <div className="mcp-diag" aria-label={`Diagnostics for ${config.name}`}>
      <dl className="mcp-diag__facts">
        {facts.map(([key, value]) => (
          <div key={key} className="mcp-diag__fact">
            <dt className="label">{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {d.lastError && (
        <p className="signal mcp-diag__error" role="alert">
          {d.lastError}
        </p>
      )}

      {config.transport === 'stdio' && (
        <>
          <div className="label">stderr · last {d.stderrTail.length} line{d.stderrTail.length === 1 ? '' : 's'}</div>
          <pre className="mcp-diag__stderr" ref={stderrRef} tabIndex={0} aria-label="Server stderr">
            {d.stderrTail.length > 0 ? d.stderrTail.join('\n') : '(nothing written to stderr yet)'}
          </pre>
        </>
      )}

      <div className="label">tools</div>
      {!config.enabled ? (
        <p className="muted">Enable the server to see its tools.</p>
      ) : !connected ? (
        <p className="muted">{d.status === 'connecting' ? 'Connecting…' : 'Not connected. Use [test] to connect and list the tools.'}</p>
      ) : tools === null ? (
        <p className="muted">loading…</p>
      ) : tools.length === 0 ? (
        <p className="muted">{toolsError ?? 'This server offers no tools.'}</p>
      ) : (
        <>
          <p className="muted mcp-diag__note">Only Build mode can use these, and every call asks first. Hints are the server&rsquo;s own claims: they can make the app ask louder, never quieter.</p>
          <div className="rule-list" role="list">
            {tools.map((tool) => (
              <div key={tool.name} className={`rule-list__row mcp-tool${tool.enabled ? '' : ' is-off'}`} role="listitem">
                <button
                  type="button"
                  className={`mcp-tool__switch${tool.enabled ? ' is-on' : ''}`}
                  role="switch"
                  aria-checked={tool.enabled}
                  aria-label={`${tool.name} ${tool.enabled ? 'on' : 'off'}`}
                  onClick={() => void toggle(tool)}
                >
                  {tool.enabled ? 'on' : 'off'}
                </button>
                <span className="mcp-tool__main">
                  <span className="mcp-tool__name">{tool.name}</span>
                  {hintBadges(tool.hints).map((badge) => (
                    <span key={badge.label} className={`chip chip--outline${badge.tone === 'danger' ? ' mcp-chip--danger' : ''}`}>
                      {badge.label}
                    </span>
                  ))}
                  {tool.wireName === null && <span className="chip chip--outline">not offered: no object schema</span>}
                  {tool.description && <span className="muted mcp-tool__desc">{tool.description}</span>}
                </span>
              </div>
            ))}
          </div>
          {toolsError && <p className="signal">{toolsError}</p>}
        </>
      )}
    </div>
  )
}
