import { useEffect } from 'react'
import { useSettings } from './hooks/useSettings'
import { useWorkspaces } from './hooks/useWorkspaces'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { ThemeToggle } from './components/ThemeToggle'

export function App() {
  const { settings, update: updateSettings } = useSettings()
  const { workspaces, loading, error, create, rename, remove } = useWorkspaces()

  useEffect(() => {
    if (!settings) return
    document.documentElement.setAttribute('data-theme', settings.theme)
  }, [settings])

  const activeWorkspace =
    workspaces.find((w) => w.id === settings?.activeWorkspaceId) ?? workspaces[0] ?? null

  useEffect(() => {
    if (!settings || loading) return
    if (!settings.activeWorkspaceId && activeWorkspace) {
      void updateSettings({ activeWorkspaceId: activeWorkspace.id })
    }
  }, [settings, loading, activeWorkspace, updateSettings])

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar__brand">AI Workspace</span>
        {settings && (
          <ThemeToggle
            theme={settings.theme}
            onChange={(theme) => void updateSettings({ theme })}
          />
        )}
      </header>

      <div className="app-shell__body">
        <Sidebar
          workspaces={workspaces}
          activeId={activeWorkspace?.id ?? null}
          onSelect={(id) => void updateSettings({ activeWorkspaceId: id })}
          onCreate={async (name) => {
            const created = await create({ name })
            await updateSettings({ activeWorkspaceId: created.id })
          }}
        />
        <main className="app-shell__main">
          {error && <p className="app-shell__error">Failed to load workspaces: {error}</p>}
          {!loading && (
            <WorkspaceView
              workspace={activeWorkspace}
              onRename={rename}
              onDelete={async (id) => {
                await remove(id)
                await updateSettings({ activeWorkspaceId: null })
              }}
            />
          )}
        </main>
      </div>
    </div>
  )
}
