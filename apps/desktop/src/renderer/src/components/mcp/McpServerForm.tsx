import { useState } from 'react'
import type { McpTransport } from '@ai-workspace/shared'
import { draftProblems, draftToInput, type DraftEntry, type McpDraft } from '../../lib/mcp-ui'

interface Props {
  initial: McpDraft
  onSave: (input: ReturnType<typeof draftToInput>) => Promise<void>
  onCancel: () => void
}

const TRANSPORTS: McpTransport[] = ['stdio', 'http']

function EntryRows({
  label,
  keyLabel,
  entries,
  onChange,
  defaultSecret,
  addLabel,
  keyPlaceholder,
}: {
  label: string
  keyLabel: string
  entries: DraftEntry[]
  onChange: (next: DraftEntry[]) => void
  defaultSecret: boolean
  addLabel: string
  keyPlaceholder: string
}) {
  const update = (index: number, patch: Partial<DraftEntry>) => onChange(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)))
  return (
    <div className="mcp-form__field">
      <div className="label">{label}</div>
      {entries.map((entry, index) => (
        <div key={index} className="mcp-entry">
          <input
            className="input mcp-entry__key"
            value={entry.key}
            placeholder={keyPlaceholder}
            aria-label={keyLabel}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => update(index, { key: e.target.value })}
          />
          <input
            className="input mcp-entry__value"
            type={entry.secret ? 'password' : 'text'}
            value={entry.value}
            placeholder={entry.secret && entry.existing ? '(set - leave blank to keep)' : 'value'}
            aria-label={`${keyLabel} value`}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => update(index, { value: e.target.value })}
          />
          <label className="mcp-entry__secret" title="Stored encrypted. Never shown again, never sent to the model.">
            <input type="checkbox" checked={entry.secret} onChange={(e) => update(index, { secret: e.target.checked, existing: e.target.checked ? entry.existing : false })} />
            secret
          </label>
          <button type="button" className="link-action link-action--danger" onClick={() => onChange(entries.filter((_, i) => i !== index))}>
            [remove]
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="link-action" onClick={() => onChange([...entries, { key: '', value: '', secret: defaultSecret, existing: false }])}>
          {addLabel}
        </button>
      </div>
    </div>
  )
}

/**
 * Add / edit one MCP server. Nothing here starts anything: saving stores the definition; connecting is a separate,
 * explicit [test] (or the start of a Build run). Secret values are write-only: a stored one shows as "set" and an
 * empty field keeps it.
 */
export function McpServerForm({ initial, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<McpDraft>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const editing = initial.id !== undefined
  const problems = draftProblems(draft)
  const set = (patch: Partial<McpDraft>) => setDraft((d) => ({ ...d, ...patch }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (problems.length > 0) return
    setSaving(true)
    setError(null)
    try {
      await onSave(draftToInput(draft))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <form className="mcp-form" onSubmit={(e) => void submit(e)} aria-label={editing ? 'Edit MCP server' : 'Add MCP server'}>
      <div className="label">{editing ? 'edit server' : 'add a server'}</div>

      <label className="mcp-form__field">
        <span className="label">name</span>
        <input
          className="input"
          value={draft.name}
          placeholder="files"
          aria-label="Server name"
          autoFocus
          spellCheck={false}
          onChange={(e) => set({ name: e.target.value })}
        />
        <span className="muted mcp-form__hint">Used in tool names (mcp__name__tool) and permission grants. Lowercase letters, digits, hyphens.</span>
      </label>

      <div className="mcp-form__field">
        <div className="label">transport</div>
        <div className="segmented" role="radiogroup" aria-label="Transport">
          {TRANSPORTS.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={draft.transport === t} className={draft.transport === t ? 'is-active' : ''} onClick={() => set({ transport: t })}>
              {t}
            </button>
          ))}
        </div>
        <span className="muted mcp-form__hint">
          {draft.transport === 'stdio' ? 'Runs a program on this computer with your user account. No shell is involved.' : 'Connects to a server over the network (streamable HTTP, with a fallback to the older SSE transport).'}
        </span>
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <label className="mcp-form__field">
            <span className="label">command</span>
            <input className="input" value={draft.command} placeholder="npx" aria-label="Command" spellCheck={false} onChange={(e) => set({ command: e.target.value })} />
          </label>
          <label className="mcp-form__field">
            <span className="label">arguments · one per line</span>
            <textarea
              className="input mcp-form__args"
              rows={3}
              value={draft.argsText}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:/projects'}
              aria-label="Arguments"
              spellCheck={false}
              onChange={(e) => set({ argsText: e.target.value })}
            />
          </label>
          <label className="mcp-form__field">
            <span className="label">working directory · optional</span>
            <input className="input" value={draft.cwd} placeholder="default: your home folder" aria-label="Working directory" spellCheck={false} onChange={(e) => set({ cwd: e.target.value })} />
          </label>
          <EntryRows
            label="environment variables"
            keyLabel="Variable name"
            keyPlaceholder="NAME"
            entries={draft.env}
            onChange={(env) => set({ env })}
            defaultSecret={false}
            addLabel="[+ variable]"
          />
          <p className="muted mcp-form__hint">The server gets PATH, your home folder and a few basics - not the rest of your environment - plus the variables listed here.</p>
        </>
      ) : (
        <>
          <label className="mcp-form__field">
            <span className="label">url</span>
            <input className="input" value={draft.url} placeholder="https://mcp.example.com/mcp" aria-label="URL" spellCheck={false} onChange={(e) => set({ url: e.target.value })} />
            <span className="muted mcp-form__hint">https only (plain http is allowed for localhost). OAuth sign-in is not supported; use an Authorization header.</span>
          </label>
          <EntryRows
            label="headers"
            keyLabel="Header name"
            keyPlaceholder="Authorization"
            entries={draft.headers}
            onChange={(headers) => set({ headers })}
            defaultSecret
            addLabel="[+ header]"
          />
        </>
      )}

      <label className="mcp-form__check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> enabled
        <span className="muted"> - an enabled server is connected when a Build run starts</span>
      </label>

      {/* Always in view (the form is taller than the dialog), so the problems and the buttons never scroll away. */}
      <div className="mcp-form__footer">
        {(touched || error) && (problems.length > 0 || error) && (
          <ul className="signal mcp-form__problems" role="alert">
            {(error ? [error] : problems).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="settings__actions">
          <button type="submit" className="link-action" disabled={saving}>
            {saving ? '[saving…]' : '[save]'}
          </button>
          <button type="button" className="link-action" onClick={onCancel} disabled={saving}>
            [cancel]
          </button>
        </div>
      </div>
    </form>
  )
}
