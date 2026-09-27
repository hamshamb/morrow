import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceFileIndexEntry, Workspace } from '@ai-workspace/shared'
import { matchesSearch } from '../lib/search-match'
import { ChatIcon, FileIcon, PanelRightIcon, PlusIcon, SettingsIcon } from './icons'

export interface WorkspaceCommandActions {
  newConversation: () => void
  openModelPicker: () => void
  openContextPanel: () => void
  addFileToContext: (path: string) => void
  indexedFiles: WorkspaceFileIndexEntry[]
}

interface Props {
  onClose: () => void
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSwitchWorkspace: (id: string) => void
  onOpenSettings: () => void
  workspaceActions: WorkspaceCommandActions | null
}

interface CommandEntry {
  id: string
  group: string
  icon: React.ReactNode
  title: string
  subtitle?: string
  keywords: string[]
  run: () => void
}

/**
 * Cmd/Ctrl+K (also Cmd/Ctrl+Shift+P) command palette. Dialog sizing/
 * anchoring is ported from opencode's dialog-command-palette-v2.css (MIT
 * License) — see docs/UI_REFERENCE_OPENCODE.md §6 and
 * docs/OPEN_SOURCE_INVENTORY.md: 640px max width, 36px rows, anchored near
 * the top rather than vertically centered.
 *
 * Only wired to real, working actions — no Compare/Review/Roundtable
 * entries (those backends don't exist yet, see docs/DECISIONS.md ADR-018).
 */
export function CommandPalette({
  onClose,
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onOpenSettings,
  workspaceActions,
}: Props) {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [onClose])

  const entries = useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = []

    if (workspaceActions) {
      list.push({
        id: 'action:new-conversation',
        group: 'Actions',
        icon: <PlusIcon />,
        title: 'New conversation',
        keywords: ['new', 'conversation', 'chat', 'session'],
        run: workspaceActions.newConversation,
      })
      list.push({
        id: 'action:switch-model',
        group: 'Actions',
        icon: <ChatIcon />,
        title: 'Switch model',
        subtitle: 'Open the model picker',
        keywords: ['model', 'provider', 'switch', 'change'],
        run: workspaceActions.openModelPicker,
      })
      list.push({
        id: 'action:context-inspector',
        group: 'Actions',
        icon: <PanelRightIcon />,
        title: 'Open Context Inspector',
        subtitle: "See what's actually sent with the next message",
        keywords: ['context', 'inspector', 'sources'],
        run: workspaceActions.openContextPanel,
      })
    }

    list.push({
      id: 'action:settings',
      group: 'Actions',
      icon: <SettingsIcon />,
      title: 'Open Settings',
      keywords: ['settings', 'preferences', 'providers', 'appearance', 'theme'],
      run: onOpenSettings,
    })

    for (const workspace of workspaces) {
      if (workspace.id === activeWorkspaceId) continue
      list.push({
        id: `workspace:${workspace.id}`,
        group: 'Workspaces',
        icon: <ChatIcon />,
        title: `Switch to ${workspace.name}`,
        keywords: ['workspace', workspace.name],
        run: () => onSwitchWorkspace(workspace.id),
      })
    }

    if (workspaceActions) {
      for (const file of workspaceActions.indexedFiles.slice(0, 50)) {
        list.push({
          id: `file:${file.relativePath}`,
          group: 'Workspace files',
          icon: <FileIcon />,
          title: file.relativePath.split(/[\\/]/).pop() ?? file.relativePath,
          subtitle: `Add to context — ${file.relativePath}`,
          keywords: ['file', file.relativePath],
          run: () => workspaceActions.addFileToContext(file.relativePath),
        })
      }
    }

    return list
  }, [workspaceActions, onOpenSettings, workspaces, activeWorkspaceId, onSwitchWorkspace])

  const filtered = useMemo(() => {
    if (!query.trim()) return entries
    return entries.filter((entry) => matchesSearch(query, [entry.title, ...entry.keywords]))
  }, [entries, query])

  useEffect(() => {
    setHighlighted(0)
  }, [query])

  function run(entry: CommandEntry) {
    entry.run()
    onClose()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const entry = filtered[highlighted]
      if (entry) run(entry)
    }
  }

  let lastGroup = ''

  return (
    <div className="command-palette-overlay">
      <div className="command-palette" ref={containerRef} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="command-palette__input"
          placeholder="Type a command, or search workspaces and files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette__list">
          {filtered.length === 0 && (
            <p className="command-palette__empty">No matching commands.</p>
          )}
          {filtered.map((entry, index) => {
            const showGroup = entry.group !== lastGroup
            lastGroup = entry.group
            return (
              <div key={entry.id}>
                {showGroup && <div className="command-palette__group-title">{entry.group}</div>}
                <button
                  type="button"
                  className="command-palette__row"
                  data-active={index === highlighted || undefined}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => run(entry)}
                >
                  <span className="command-palette__row-icon">{entry.icon}</span>
                  <span className="command-palette__row-title">{entry.title}</span>
                  {entry.subtitle && (
                    <span className="command-palette__row-subtitle">{entry.subtitle}</span>
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
