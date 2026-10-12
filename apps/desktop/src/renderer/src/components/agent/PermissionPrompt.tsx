import { useEffect, useRef, useState } from 'react'
import type { PermissionDecision, PermissionRequest } from '@ai-workspace/shared'
import { promptHeading } from '../../lib/agent-ui'
import { DiffChanges } from '../git/DiffChanges'
import { DiffText } from './ActivityRow'

interface Props {
  request: PermissionRequest
  onRespond: (requestId: string, decision: PermissionDecision) => Promise<unknown>
}

const BUTTONS: { decision: PermissionDecision; label: string; key: string }[] = [
  { decision: 'allow_once', label: '[allow once]', key: 'o' },
  { decision: 'allow_session', label: '[allow session]', key: 's' },
  { decision: 'allow_workspace', label: '[allow workspace]', key: 'w' },
  { decision: 'deny', label: '[deny]', key: 'd' },
]

/**
 * The inline permission prompt (not a modal): exactly what will happen - the tool, its risk, the path or the exact
 * command with its working directory, and for an edit the diff - and the answers the main process will accept.
 * A destructive request (or one flagged ask-every-time) offers only `[allow once]` and `[deny]` and says why; the
 * main process refuses anything else even if this UI were bypassed.
 *
 * Keyboard: the prompt takes focus when it appears; O / S / W / D answer, Esc denies, arrow keys move between the
 * buttons. Nothing is pre-approved: no key press answers "allow" unless it names it.
 */
export function PermissionPrompt({ request, onRespond }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [answered, setAnswered] = useState(false)
  const destructive = request.risk === 'destructive'
  const buttons = BUTTONS.filter((b) => request.allowedDecisions.includes(b.decision))
  const preview = request.preview

  useEffect(() => {
    ref.current?.focus({ preventScroll: false })
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [request.requestId])

  function answer(decision: PermissionDecision) {
    if (answered) return
    setAnswered(true)
    void onRespond(request.requestId, decision).then((result) => {
      // A refused answer leaves the request open - let the user try again.
      if (result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false) setAnswered(false)
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const key = e.key.toLowerCase()
    const hit = buttons.find((b) => b.key === key)
    if (hit) {
      e.preventDefault()
      e.stopPropagation()
      answer(hit.decision)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      answer('deny')
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('.permission__actions button') ?? [])
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      if (items.length === 0) return
      e.preventDefault()
      const next = e.key === 'ArrowRight' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
      items[next === -1 ? 0 : next]?.focus()
    }
  }

  return (
    <div
      ref={ref}
      className={`permission${destructive ? ' permission--destructive' : ''}`}
      role="group"
      aria-label={`${promptHeading(request)}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-request-id={request.requestId}
    >
      <div className="permission__heading label">
        <span className={destructive ? 'signal' : undefined}>{promptHeading(request)}</span>
        {destructive && <span className="chip chip--outline permission__warn">destructive</span>}
        {!destructive && request.allowedDecisions.length === 2 && <span className="chip chip--outline">asks every time</span>}
      </div>

      {preview.kind === 'command' && (
        <>
          <pre className="permission__command">{preview.command}</pre>
          <div className="permission__facts muted">
            <span>in {preview.cwd}</span>
            <span>{preview.shell}</span>
            <span>timeout {preview.timeoutSeconds}s</span>
          </div>
          {preview.reasons.length > 0 && (
            <ul className={`permission__reasons${destructive ? ' signal' : ''}`}>
              {preview.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {(preview.kind === 'patch' || preview.kind === 'write') && (
        <>
          <div className="permission__path">
            <span className="permission__path-name">{preview.path}</span>
            {preview.kind === 'write' && preview.isNew && <span className="chip chip--outline">new file</span>}
            <DiffChanges additions={preview.added} deletions={preview.removed} />
          </div>
          <DiffText diff={preview.diff} maxHeight={260} />
        </>
      )}

      {preview.kind === 'other' && <p className="permission__other">{preview.description}</p>}

      {destructive && (
        <p className="permission__note signal">
          This can lose work and cannot be undone by the app. It can only be allowed once; it will ask again next time.
        </p>
      )}

      <div className="permission__actions" role="group" aria-label="Answer">
        {buttons.map((b) => (
          <button
            key={b.decision}
            type="button"
            className={`link-action${b.decision === 'deny' ? ' link-action--danger' : ''}`}
            onClick={() => answer(b.decision)}
            disabled={answered}
            title={`${b.key.toUpperCase()}${b.decision === 'deny' ? ' or Esc' : ''}`}
          >
            {b.label}
          </button>
        ))}
        <span className="permission__hint muted">
          <kbd>O</kbd> <kbd>S</kbd> <kbd>W</kbd> <kbd>D</kbd>
        </span>
      </div>
      {request.grantScopeNote && buttons.length > 2 && (
        <p className="permission__note muted">session and workspace grants cover {request.grantScopeNote} only.</p>
      )}
    </div>
  )
}
