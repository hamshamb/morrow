import { useState } from 'react'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  ProviderId,
  TestProviderConfigInput,
  TestProviderConfigResult,
  Theme,
} from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'
import { ThemeToggle } from './ThemeToggle'
import { ChevronDownIcon, CloseIcon, TrashIcon } from './icons'

interface Props {
  configs: ProviderConfigSummary[]
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  remove: (id: string) => Promise<void>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onClose: () => void
}

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google']

type SettingsSection = 'providers' | 'appearance'

function ProviderRow({
  provider,
  configs,
  expanded,
  onToggle,
  add,
  remove,
  test,
}: {
  provider: ProviderId
  configs: ProviderConfigSummary[]
  expanded: boolean
  onToggle: () => void
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  remove: (id: string) => Promise<void>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
}) {
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const connected = configs.length > 0

  async function handleTest() {
    if (!apiKey.trim()) return
    setBusy(true)
    setTestResult(null)
    try {
      const result = await test({ provider, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || null })
      setTestResult(result.ok ? 'Connection OK' : `Failed: ${result.message ?? 'unknown error'}`)
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleAdd() {
    setFormError(null)
    if (!label.trim() || !apiKey.trim()) {
      setFormError('Label and API key are required.')
      return
    }
    setBusy(true)
    try {
      await add({ provider, label: label.trim(), apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || null })
      setLabel('')
      setApiKey('')
      setBaseUrl('')
      setTestResult(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="provider-row">
      <button type="button" className="provider-row__header" onClick={onToggle} aria-expanded={expanded}>
        <span className="provider-row__name">{PROVIDER_LABELS[provider]}</span>
        <span className={`provider-row__status${connected ? ' is-connected' : ''}`}>
          {connected ? `Connected · ${configs.length}` : 'Not connected'}
        </span>
        <span className={`provider-row__chevron${expanded ? ' is-open' : ''}`}>
          <ChevronDownIcon />
        </span>
      </button>

      {expanded && (
        <div className="provider-row__body">
          {configs.length > 0 && (
            <ul className="settings-panel__configs">
              {configs.map((config) => (
                <li key={config.id}>
                  <span>
                    <strong>{config.label}</strong> · {config.maskedKey}
                  </span>
                  <button type="button" onClick={() => void remove(config.id)} aria-label={`Remove ${config.label}`}>
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="settings-panel__form"
            onSubmit={(e) => {
              e.preventDefault()
              void handleAdd()
            }}
          >
            <input
              placeholder="Label (e.g. Personal key)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <input
              type="password"
              autoComplete="off"
              placeholder="API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <input
              placeholder="Custom base URL (optional)"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <div className="settings-panel__form-actions">
              <button type="button" onClick={() => void handleTest()} disabled={busy || !apiKey.trim()}>
                Test connection
              </button>
              <button type="submit" disabled={busy}>
                Add key
              </button>
            </div>
            {testResult && <p className="settings-panel__test-result">{testResult}</p>}
            {formError && <p className="settings-panel__error">{formError}</p>}
          </form>
        </div>
      )}
    </div>
  )
}

/**
 * A proper Settings view (not a small overlay) with sections for Providers
 * (per-provider Connected/Not connected status, click to expand and
 * configure — same add/test/remove key flow as before) and Appearance
 * (theme, moved here from the old header toggle). Models stays folded into
 * Providers rather than getting its own section — the live catalog is
 * already surfaced in the composer's model picker, so a separate Models
 * view would just duplicate it. Agents/MCP/Permissions are deliberately
 * not present — those backends don't exist yet (roadmap Phase 5/7), see
 * docs/DECISIONS.md ADR-018.
 */
export function SettingsPanel({ configs, add, remove, test, theme, onThemeChange, onClose }: Props) {
  const [section, setSection] = useState<SettingsSection>('providers')
  const [expandedProvider, setExpandedProvider] = useState<ProviderId | null>(
    configs.length === 0 ? 'anthropic' : null,
  )

  return (
    <div className="settings-overlay" role="dialog" aria-label="Settings">
      <div className="settings-panel">
        <header className="settings-panel__header">
          <h2>Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </header>

        <div className="settings-panel__body">
          <nav className="settings-panel__nav">
            <button
              type="button"
              className={`settings-panel__nav-item${section === 'providers' ? ' is-active' : ''}`}
              onClick={() => setSection('providers')}
            >
              Providers
            </button>
            <button
              type="button"
              className={`settings-panel__nav-item${section === 'appearance' ? ' is-active' : ''}`}
              onClick={() => setSection('appearance')}
            >
              Appearance
            </button>
          </nav>

          <div className="settings-panel__content">
            {section === 'providers' && (
              <section className="settings-panel__section">
                <p className="settings-panel__hint">
                  Keys are encrypted at rest with your OS keychain and never leave this device
                  except to call the provider you select.
                </p>
                <div className="provider-row-list">
                  {PROVIDERS.map((provider) => (
                    <ProviderRow
                      key={provider}
                      provider={provider}
                      configs={configs.filter((c) => c.provider === provider)}
                      expanded={expandedProvider === provider}
                      onToggle={() =>
                        setExpandedProvider((current) => (current === provider ? null : provider))
                      }
                      add={add}
                      remove={remove}
                      test={test}
                    />
                  ))}
                </div>
              </section>
            )}

            {section === 'appearance' && (
              <section className="settings-panel__section">
                <h3>Theme</h3>
                <ThemeToggle theme={theme} onChange={onThemeChange} />
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
