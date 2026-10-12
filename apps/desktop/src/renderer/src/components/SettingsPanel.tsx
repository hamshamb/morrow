import { useEffect, useState } from 'react'
import type {
  AddProviderConfigInput,
  AgentLimits,
  ProviderConfigSummary,
  TestProviderConfigInput,
  TestProviderConfigResult,
  Theme,
} from '@ai-workspace/shared'
import { useProviderRegistry } from '../hooks/useProviderRegistry'
import { formatRelativeTime } from '../lib/time'
import { AddProvider } from './AddProvider'
import { ConfirmAction } from './ConfirmAction'
import { AgentSettings } from './agent/AgentSettings'
import { PermissionSettings } from './agent/PermissionSettings'

interface Props {
  configs: ProviderConfigSummary[]
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  remove: (id: string) => Promise<void>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
  theme: Theme
  onThemeChange: (theme: Theme) => void
  modelsDevFetchEnabled: boolean
  onModelsDevFetchChange: (enabled: boolean) => void
  /** The workspace whose grants Permissions lists. */
  activeWorkspace: { id: string; name: string } | null
  agentLimits: AgentLimits
  onAgentLimitsChange: (limits: AgentLimits) => void
  onAgentsChanged: () => void
  onClose: () => void
}

type Section = 'providers' | 'models' | 'agents' | 'permissions' | 'appearance'
const SECTIONS: Section[] = ['providers', 'models', 'agents', 'permissions', 'appearance']
const THEMES: Theme[] = ['system', 'light', 'dark']

const SOURCE_LABELS = {
  bundled: 'built-in snapshot',
  cache: 'cached download',
  network: 'downloaded this session',
} as const

function ago(timestamp: number): string {
  const relative = formatRelativeTime(timestamp)
  return relative === 'now' ? 'just now' : `${relative} ago`
}

/**
 * Settings view: Providers (connected keys + the searchable add-a-provider
 * list), Models (where the models.dev catalog comes from, and the opt-out for
 * downloading it), Agents (run limits + the agent definitions), Permissions (the
 * grants you gave the agent, with revoke) and Appearance (theme). MCP is still
 * absent — its backend doesn't exist yet (see docs/DECISIONS.md ADR-018).
 */
export function SettingsPanel({
  configs,
  add,
  remove,
  test,
  theme,
  onThemeChange,
  modelsDevFetchEnabled,
  onModelsDevFetchChange,
  activeWorkspace,
  agentLimits,
  onAgentLimitsChange,
  onAgentsChanged,
  onClose,
}: Props) {
  const registry = useProviderRegistry()
  const [section, setSection] = useState<Section>('providers')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNote, setRefreshNote] = useState<{ ok: boolean; text: string } | null>(null)

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

  async function refreshNow() {
    setRefreshing(true)
    setRefreshNote(null)
    try {
      const result = await registry.refreshMetadata()
      setRefreshNote({
        ok: result.ok,
        text: result.ok
          ? `updated — ${result.status.modelCount.toLocaleString()} models from ${result.status.providerCount} providers`
          : (result.message ?? 'refresh failed'),
      })
    } catch (err) {
      setRefreshNote({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRefreshing(false)
    }
  }

  const status = registry.metadataStatus

  return (
    <div className="overlay" role="dialog" aria-label="Settings" onMouseDown={onClose}>
      <div className="dialog settings" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 className="dialog__title">Settings</h2>
          <button type="button" className="link-action" onClick={onClose}>
            [close] <kbd>esc</kbd>
          </button>
        </header>

        <div className="settings__body">
          <nav className="settings__nav">
            {SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className={`settings__nav-item${section === s ? ' is-active' : ''}`}
                onClick={() => setSection(s)}
              >
                {s}
              </button>
            ))}
          </nav>

          <div className="settings__content">
            {section === 'providers' && (
              <>
                <h3 className="section-title">Providers</h3>
                {configs.length === 0 ? (
                  <p className="muted">No keys yet. Pick a provider below.</p>
                ) : (
                  <div className="rule-list">
                    {configs.map((config) => {
                      const entry = registry.byId(config.provider)
                      const localStatus = registry.local[config.provider]
                      return (
                        <div key={config.id} className="rule-list__row settings__key">
                          <span className="chip chip--outline">{registry.label(config.provider)}</span>
                          <span className="settings__key-label">{config.label}</span>
                          <span className="muted settings__key-mask">
                            {entry?.isLocal
                              ? `${config.baseUrl ?? entry.defaultBaseUrl ?? ''}`
                              : config.maskedKey}
                          </span>
                          {entry?.isLocal && !localStatus?.running ? (
                            <span className="muted">not running</span>
                          ) : (
                            <span className="ok">connected</span>
                          )}
                          <ConfirmAction
                            label="[remove]"
                            confirmLabel="[confirm remove]"
                            onConfirm={() => void remove(config.id)}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="label settings__add-label">add a provider</div>
                {/* The new key's model list is fetched automatically by
                    useModelCatalogs once the config list updates. */}
                <AddProvider add={add} test={test} autoSave={false} onSaved={() => undefined} configs={configs} />
              </>
            )}

            {section === 'models' && (
              <>
                <h3 className="section-title">Models</h3>
                <div className="label">model catalog · models.dev</div>
                <p className="settings__note">
                  Context windows, prices, capabilities and each model&rsquo;s exact thinking-effort levels come from
                  the open <span className="settings__mono">models.dev</span> database. The app ships a snapshot, so it
                  works fully offline; with the download on, it refreshes at most once a day.
                </p>
                {status && (
                  <div className="rule-list settings__status">
                    <div className="rule-list__row">
                      <span className="muted settings__status-key">source</span>
                      <span>
                        {SOURCE_LABELS[status.source]}
                        {status.fetchedAt ? ` · ${ago(status.fetchedAt)}` : ''}
                      </span>
                    </div>
                    <div className="rule-list__row">
                      <span className="muted settings__status-key">contents</span>
                      <span>
                        {status.modelCount.toLocaleString()} chat models · {status.providerCount} providers
                      </span>
                    </div>
                  </div>
                )}

                <div className="label settings__add-label">download from models.dev</div>
                <div className="segmented" role="radiogroup" aria-label="Download the model catalog">
                  {([true, false] as const).map((value) => (
                    <button
                      key={String(value)}
                      type="button"
                      role="radio"
                      aria-checked={modelsDevFetchEnabled === value}
                      className={modelsDevFetchEnabled === value ? 'is-active' : ''}
                      onClick={() => onModelsDevFetchChange(value)}
                    >
                      {value ? 'on' : 'off'}
                    </button>
                  ))}
                </div>
                <p className="settings__note muted">
                  {modelsDevFetchEnabled
                    ? 'One plain GET of https://models.dev/api.json (~5 MB). No key, account or usage data is sent.'
                    : 'Off: nothing is downloaded. The built-in snapshot is used (some newer models may be missing metadata).'}
                </p>
                <div className="settings__actions">
                  <button
                    type="button"
                    className="link-action"
                    disabled={refreshing || !modelsDevFetchEnabled}
                    onClick={() => void refreshNow()}
                  >
                    {refreshing ? '[refreshing…]' : '[refresh now]'}
                  </button>
                  {refreshNote && <span className={refreshNote.ok ? 'ok' : 'signal'}>{refreshNote.text}</span>}
                </div>
              </>
            )}

            {section === 'agents' && (
              <AgentSettings limits={agentLimits} onLimitsChange={onAgentLimitsChange} onAgentsChanged={onAgentsChanged} />
            )}

            {section === 'permissions' && (
              <PermissionSettings workspaceId={activeWorkspace?.id ?? null} workspaceName={activeWorkspace?.name ?? null} />
            )}

            {section === 'appearance' && (
              <>
                <h3 className="section-title">Appearance</h3>
                <div className="label">theme</div>
                <div className="segmented" role="radiogroup" aria-label="Theme">
                  {THEMES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={theme === t}
                      className={theme === t ? 'is-active' : ''}
                      onClick={() => onThemeChange(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
