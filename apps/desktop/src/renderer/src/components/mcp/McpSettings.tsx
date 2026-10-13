import { useEffect, useState } from 'react'
import type { McpServerState } from '@ai-workspace/shared'
import { useMcp } from '../../hooks/useMcp'
import { STATUS_TEXT, draftFromConfig, emptyDraft, serverSummary, type McpDraft } from '../../lib/mcp-ui'
import { ConfirmAction } from '../ConfirmAction'
import { McpDiagnosticsPanel } from './McpDiagnosticsPanel'
import { McpServerForm } from './McpServerForm'

function StatusChip({ state }: { state: McpServerState }) {
  const status = state.diagnostics.status
  return (
    <span className={`chip chip--outline mcp-status mcp-status--${status}`} data-status={status}>
      {STATUS_TEXT[status]}
    </span>
  )
}

/**
 * Settings -> MCP: the servers you added, how each is doing, a form to add or edit one, and per-server diagnostics.
 * Adding a server does not start it. [test] connects (starting the program for a stdio server); a Build run connects
 * enabled servers on its own. Everything a server offers is untrusted and goes through the same permission prompt.
 */
export function McpSettings() {
  const mcp = useMcp()
  const [form, setForm] = useState<McpDraft | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)

  // Output of a running stdio server (stderr) and a reconnect after a crash do not push events of their own.
  const { refresh } = mcp
  useEffect(() => {
    if (!openId) return
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [openId, refresh])

  async function test(id: string) {
    setTesting(id)
    setOpenId(id)
    await mcp.test(id)
    setTesting(null)
  }

  async function save(input: Parameters<typeof mcp.save>[0]) {
    const saved = await mcp.save(input)
    setForm(null)
    setOpenId(saved.config.id)
  }

  const servers = mcp.servers

  return (
    <>
      <h3 className="section-title">MCP</h3>
      <p className="settings__note">
        MCP servers give the agent extra tools and resources. A server is a program on this computer (stdio) or a remote endpoint (http) that{' '}
        <strong>you</strong> add: a stdio server runs with your user account&rsquo;s access. Its tools work in Build mode only, and every call asks first.
      </p>

      {mcp.error && (
        <p className="signal" role="alert">
          {mcp.error}{' '}
          <button type="button" className="link-action" onClick={mcp.clearError}>
            [dismiss]
          </button>
        </p>
      )}

      {form ? (
        <McpServerForm initial={form} onSave={save} onCancel={() => setForm(null)} />
      ) : (
        <>
          {servers === null ? (
            <p className="muted">loading…</p>
          ) : servers.length === 0 ? (
            <div className="mcp-empty">
              <div className="label">no servers</div>
              <p className="muted">
                Nothing is connected. Add a server to let the agent read a database, search the web or call an API: for example a filesystem or GitHub MCP server.
                Nothing starts until you press [test] or run the agent in Build mode.
              </p>
            </div>
          ) : (
            <div className="rule-list" role="list">
              {servers.map((state) => {
                const { config, diagnostics: d } = state
                const open = openId === config.id
                return (
                  <div key={config.id} role="listitem" className="mcp-server" data-server={config.name}>
                    <div className="rule-list__row mcp-server__row">
                      <button type="button" className="mcp-server__toggle" aria-expanded={open} onClick={() => setOpenId(open ? null : config.id)}>
                        <span className="agent-row__chevron" aria-hidden="true">
                          {open ? '▾' : '▸'}
                        </span>
                        <span className="mcp-server__name">{config.name}</span>
                      </button>
                      <StatusChip state={state} />
                      <span className="chip chip--outline">{config.transport}</span>
                      <span className="muted mcp-server__summary" title={serverSummary(config)}>
                        {serverSummary(config)}
                      </span>
                      {d.status === 'connected' && <span className="muted mcp-server__count">{d.toolCount} tools</span>}
                      <span className="mcp-server__actions">
                        <button type="button" className="link-action" disabled={!config.enabled || testing === config.id} onClick={() => void test(config.id)}>
                          {testing === config.id ? '[testing…]' : '[test]'}
                        </button>
                        <button type="button" className="link-action" onClick={() => setForm(draftFromConfig(config))}>
                          [edit]
                        </button>
                        <button type="button" className="link-action" onClick={() => void mcp.setEnabled(config.id, !config.enabled)}>
                          {config.enabled ? '[disable]' : '[enable]'}
                        </button>
                        <ConfirmAction label="[remove]" confirmLabel="[confirm remove]" onConfirm={() => void mcp.remove(config.id)} />
                      </span>
                    </div>
                    {open && <McpDiagnosticsPanel state={state} />}
                  </div>
                )
              })}
            </div>
          )}
          <div className="settings__actions">
            <button type="button" className="link-action" onClick={() => setForm(emptyDraft())}>
              [+ add server]
            </button>
          </div>
        </>
      )}
    </>
  )
}
