import { useState } from 'react'
import type { ProviderId } from '@ai-workspace/shared'
import { useProviderConfigs } from '../hooks/useProviderConfigs'
import { PROVIDER_LABELS } from '../lib/models'

interface Props {
  onClose: () => void
}

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google']

export function SettingsPanel({ onClose }: Props) {
  const { configs, add, remove, test } = useProviderConfigs()

  const [provider, setProvider] = useState<ProviderId>('anthropic')
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  async function handleTest() {
    if (!apiKey.trim()) return
    setBusy(true)
    setTestResult(null)
    try {
      const result = await test({
        provider,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || null,
      })
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
      await add({
        provider,
        label: label.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || null,
      })
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
    <div className="settings-overlay" role="dialog" aria-label="Settings">
      <div className="settings-panel">
        <header className="settings-panel__header">
          <h2>Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>

        <section className="settings-panel__section">
          <h3>Provider API keys</h3>
          <p className="settings-panel__hint">
            Keys are encrypted at rest with your OS keychain and never leave this device except to
            call the provider you select.
          </p>

          <ul className="settings-panel__configs">
            {configs.map((config) => (
              <li key={config.id}>
                <span>
                  <strong>{config.label}</strong> — {PROVIDER_LABELS[config.provider]} ·{' '}
                  {config.maskedKey}
                </span>
                <button type="button" onClick={() => void remove(config.id)}>
                  Remove
                </button>
              </li>
            ))}
            {configs.length === 0 && <li className="settings-panel__empty">No providers added yet.</li>}
          </ul>

          <form
            className="settings-panel__form"
            onSubmit={(e) => {
              e.preventDefault()
              void handleAdd()
            }}
          >
            <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
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
                Save
              </button>
            </div>
            {testResult && <p className="settings-panel__test-result">{testResult}</p>}
            {formError && <p className="settings-panel__error">{formError}</p>}
          </form>
        </section>
      </div>
    </div>
  )
}
