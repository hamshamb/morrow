import { useMemo } from 'react'
import { baseName, dirName } from '../../lib/code/paths'
import type { Doc } from '../../hooks/useCodeWorkspace'

interface Props {
  tabs: string[]
  active: string | null
  docs: Record<string, Doc>
  onActivate: (path: string) => void
  onClose: (path: string) => void
}

/**
 * Open files as a tab strip: the active tab is an inverted chip (ink on
 * paper), a dirty file shows a dot that turns into the close mark on hover,
 * and middle-click closes - all in nochan's square, rule-based language.
 */
export function EditorTabs({ tabs, active, docs, onActivate, onClose }: Props) {
  const duplicates = useMemo(() => {
    const seen = new Map<string, number>()
    for (const t of tabs) seen.set(baseName(t), (seen.get(baseName(t)) ?? 0) + 1)
    return seen
  }, [tabs])

  if (tabs.length === 0) return <div className="editor-tabs editor-tabs--empty" role="tablist" />

  return (
    <div className="editor-tabs" role="tablist" aria-label="Open files">
      {tabs.map((path) => {
        const doc = docs[path]
        const dirty = doc?.status === 'ready' && doc.dirty
        const isActive = path === active
        const dir = dirName(path)
        return (
          <div
            key={path}
            role="tab"
            aria-selected={isActive}
            className={`editor-tab${isActive ? ' is-active' : ''}${dirty ? ' is-dirty' : ''}`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onClose(path)
              }
            }}
            title={path}
          >
            <button type="button" className="editor-tab__label" onClick={() => onActivate(path)}>
              <span>{baseName(path)}</span>
              {(duplicates.get(baseName(path)) ?? 0) > 1 && dir && <span className="editor-tab__dir">{dir}</span>}
              {doc?.status === 'ready' && doc.readOnly && <span className="editor-tab__ro">ro</span>}
            </button>
            <button
              type="button"
              className="editor-tab__close"
              aria-label={dirty ? `Close ${baseName(path)} (unsaved changes)` : `Close ${baseName(path)}`}
              onClick={() => onClose(path)}
            >
              <span className="editor-tab__dot" aria-hidden="true">●</span>
              <span className="editor-tab__x" aria-hidden="true">×</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
