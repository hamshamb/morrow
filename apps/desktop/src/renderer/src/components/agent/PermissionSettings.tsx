import { useCallback, useEffect, useState } from 'react'
import type { PermissionGrant } from '@ai-workspace/shared'
import { RISK_TEXT } from '../../lib/agent-ui'
import { formatRelativeTime } from '../../lib/time'
import { ConfirmAction } from '../ConfirmAction'

function grantedAgo(createdAt: number): string {
  const relative = formatRelativeTime(createdAt)
  return relative === 'now' ? 'granted just now' : `granted ${relative} ago`
}

const TOOL_TEXT: Record<string, string> = {
  'filesystem.write': 'write files',
  'filesystem.patch': 'edit files',
  'terminal.execute': 'run a command',
}

/**
 * Settings -> Permissions: what you have allowed beyond "ask me". Reads (list, search, git status/diff/log) never
 * ask; everything else asks every time unless it is covered by a grant below. Destructive commands and commits can
 * never be granted and so never appear here.
 */
export function PermissionSettings({ workspaceId, workspaceName }: { workspaceId: string | null; workspaceName: string | null }) {
  const [grants, setGrants] = useState<PermissionGrant[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspaceId) {
      setGrants([])
      return
    }
    try {
      setGrants(await window.api.agent.listGrants(workspaceId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  async function revoke(id: string) {
    try {
      await window.api.agent.revokeGrant(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    await load()
  }

  return (
    <>
      <h3 className="section-title">Permissions</h3>
      <p className="settings__note">
        The agent never decides what it may do — this app does, before anything runs. Reading files, searching and looking at git
        never asks. <strong>Edits and commands ask every time</strong> unless you chose &ldquo;allow session&rdquo; or &ldquo;allow
        workspace&rdquo; in a prompt. A command grant covers that exact command only.
      </p>
      <ul className="settings__facts">
        <li>
          <span className="chip chip--outline">never grantable</span> destructive commands (deleting files, git reset / clean / force-push,
          writing outside the workspace) and commits are always asked, and can only be allowed once.
        </li>
        <li>
          <span className="chip chip--outline">plan mode</span> the terminal asks every time, whatever is granted.
        </li>
      </ul>

      <div className="label settings__add-label">grants{workspaceName ? ` · ${workspaceName}` : ''}</div>
      {error && <p className="signal">{error}</p>}
      {grants === null ? (
        <p className="muted">loading…</p>
      ) : grants.length === 0 ? (
        <p className="muted">No grants. Every edit and command asks first.</p>
      ) : (
        <div className="rule-list" role="list">
          {grants.map((grant) => (
            <div key={grant.id} className="rule-list__row permission-grant" role="listitem">
              <span className={`chip ${grant.scope === 'workspace' ? 'chip--inverted' : 'chip--outline'}`}>{grant.scope === 'workspace' ? 'workspace' : 'session'}</span>
              <span className="permission-grant__tool">{TOOL_TEXT[grant.toolId] ?? grant.toolId}</span>
              <span className="chip chip--outline">{RISK_TEXT[grant.risk]}</span>
              <span className="permission-grant__main">
                {grant.command ? <code className="permission-grant__command">{grant.command}</code> : <span className="muted">any file in this workspace</span>}
              </span>
              <span className="muted permission-grant__when">{grant.scope === 'session' ? 'until the app closes' : grantedAgo(grant.createdAt)}</span>
              <ConfirmAction label="[revoke]" confirmLabel="[confirm revoke]" onConfirm={() => void revoke(grant.id)} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}
