import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelRef, ProviderId, Workspace, WorkspaceFileIndexEntry } from '@ai-workspace/shared'
import { matchesSearch } from '../lib/search-match'
import { PROVIDER_LABELS } from '../lib/models'

export interface WorkspaceCommandActions {
  newConversation: () => void
  openModelPicker: () => void
  openContextPanel: () => void
  openFilesPanel: () => void
  addFileToContext: (path: string) => void
  useModel: (ref: ModelRef) => void
  indexedFiles: WorkspaceFileIndexEntry[]
  favorites: FavoriteModelEntry[]
}

export interface FavoriteModelEntry {
  ref: ModelRef
  name: string
  provider: ProviderId
}

interface Props {
  onClose: () => void
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSwitchWorkspace: (id: string) => void
  onOpenSettings: () => void
  onOpenKeyboard: () => void
  workspaceActions: WorkspaceCommandActions | null
}

interface CommandEntry {
  id: string
  group: string
  title: string
  hint?: string
  keys?: string[]
  keywords: string[]
  run: () => void
}

/**
 * Cmd/Ctrl+K (also Cmd/Ctrl+Shift+P). Dialog sizing/anchoring ported from
 * opencode's dialog-command-palette-v2.css (MIT License — 640px max width,
 * 36px rows, anchored near the top); search matching from
 * lib/search-match.ts (adapted from opencode, MIT). Visuals follow nochan
 * (square, rules, uppercase group labels, kbd chips). Wired to real
 * actions only — no Compare/Review/Roundtable entries (not built yet; see
 * docs/DECISIONS.md ADR-018/ADR-019 — the "Models" group is where a
 * future "compare across models" command belongs).
 */
export function CommandPalette({
  onClose,
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onOpenSettings,
  onOpenKeyboard,
  workspaceActions,
}: Props) {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const entries = useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = []
    if (workspaceActions) {
      list.push(
        {
          id: 'new',
          group: 'actions',
          title: 'New session',
          keys: ['c'],
          keywords: ['new', 'conversation', 'chat', 'session'],
          run: workspaceActions.newConversation,
        },
        {
          id: 'model',
          group: 'actions',
          title: 'Switch model',
          keys: ['Ctrl', 'M'],
          keywords: ['model', 'provider', 'switch', 'change'],
          run: workspaceActions.openModelPicker,
        },
        {
          id: 'context',
          group: 'actions',
          title: 'Open context panel',
          hint: "what's sent with the next message",
          keywords: ['context', 'inspector', 'sources'],
          run: workspaceActions.openContextPanel,
        },
        {
          id: 'files',
          group: 'actions',
          title: 'Workspace files…',
          hint: 'choose or reindex the folder',
          keywords: ['files', 'folder', 'index', 'root'],
          run: workspaceActions.openFilesPanel,
        },
      )
    }
    list.push(
      {
        id: 'settings',
        group: 'actions',
        title: 'Settings',
        hint: 'providers, appearance',
        keywords: ['settings', 'preferences', 'providers', 'keys', 'theme'],
        run: onOpenSettings,
      },
      {
        id: 'keyboard',
        group: 'actions',
        title: 'Keyboard shortcuts',
        keywords: ['keyboard', 'shortcuts', 'keys', 'help'],
        run: onOpenKeyboard,
      },
    )
    // Groups render in insertion order — keep every "actions" entry above.
    if (workspaceActions) {
      for (const fav of workspaceActions.favorites) {
        list.push({
          id: `fav:${fav.ref.providerConfigId}:${fav.ref.model}`,
          group: 'models',
          title: `Use ${fav.name}`,
          hint: `★ ${PROVIDER_LABELS[fav.provider]}`,
          keywords: ['model', 'use', fav.name, fav.ref.model, PROVIDER_LABELS[fav.provider]],
          run: () => workspaceActions.useModel(fav.ref),
        })
      }
    }
    for (const workspace of workspaces) {
      if (workspace.id === activeWorkspaceId) continue
      list.push({
        id: `ws:${workspace.id}`,
        group: 'workspaces',
        title: workspace.name,
        hint: 'switch workspace',
        keywords: ['workspace', 'switch', workspace.name],
        run: () => onSwitchWorkspace(workspace.id),
      })
    }
    if (workspaceActions) {
      for (const file of workspaceActions.indexedFiles.slice(0, 50)) {
        list.push({
          id: `file:${file.relativePath}`,
          group: 'add file to context',
          title: file.relativePath.split(/[\\/]/).pop() ?? file.relativePath,
          hint: file.relativePath,
          keywords: ['file', file.relativePath],
          run: () => workspaceActions.addFileToContext(file.relativePath),
        })
      }
    }
    return list
  }, [workspaceActions, onOpenSettings, onOpenKeyboard, workspaces, activeWorkspaceId, onSwitchWorkspace])

  const filtered = useMemo(
    () => (query.trim() ? entries.filter((e) => matchesSearch(query, [e.title, ...e.keywords])) : entries),
    [entries, query],
  )

  useEffect(() => {
    setHighlighted(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  function run(entry: CommandEntry) {
    onClose()
    entry.run()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = filtered[highlighted]
      if (entry) run(entry)
    }
  }

  let lastGroup = ''
  return (
    <div className="overlay overlay--top" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette__input"
          placeholder="type a command, a model, a workspace or a file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette__list" ref={listRef}>
          {filtered.length === 0 && <p className="command-palette__empty muted">no matching commands</p>}
          {filtered.map((entry, index) => {
            const showGroup = entry.group !== lastGroup
            lastGroup = entry.group
            return (
              <div key={entry.id}>
                {showGroup && <div className="label command-palette__group">{entry.group}</div>}
                <button
                  type="button"
                  className="command-palette__row"
                  data-active={index === highlighted || undefined}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => run(entry)}
                >
                  <span className="command-palette__title">{entry.title}</span>
                  {entry.hint && <span className="command-palette__hint">{entry.hint}</span>}
                  {entry.keys && (
                    <span className="command-palette__keys">
                      {entry.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
