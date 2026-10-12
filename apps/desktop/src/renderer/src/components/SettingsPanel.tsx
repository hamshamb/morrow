import { useEffect, useState } from 'react'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  TestProviderConfigInput,
  TestProviderConfigResult,
  Theme,
} from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'
import { KeyEntry } from './KeyEntry'
import { ConfirmAction } from './ConfirmAction'

interface Props {
  configs: ProviderConfigSummary[]
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  remove: (id: string) => Promise<void>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onClose: () => void
}

type Section = 'providers' | 'appearance'
const THEMES: Theme[] = ['system', 'light', 'dark']

/**
 * Settings view: Providers (connected keys + one paste-a-key field) and
 * Appearance (theme). Agents/MCP/Permissions are deliberately absent —
 * those backends don't exist yet (see docs/DECISIONS.md ADR-018). Models
 * stay folded into the composer's picker rather than a duplicate view.
 */
export function SettingsPanel({
  configs,
  add,
  remove,
  test,
  theme,
  onThemeChange,
  onClose,
}: Props) {
  const [section, setSection] = useState<Section>('providers')

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
            {(['providers', 'appearance'] as Section[]).map((s) => (
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
                  <p className="muted">No keys yet. Paste one below.</p>
                ) : (
                  <div className="rule-list">
                    {configs.map((config) => (
                      <div key={config.id} className="rule-list__row settings__key">
                        <span className="chip chip--outline">{PROVIDER_LABELS[config.provider]}</span>
                        <span className="settings__key-label">{config.label}</span>
                        <span className="muted settings__key-mask">{config.maskedKey}</span>
                        <span className="ok">connected</span>
                        <ConfirmAction
                          label="[remove]"
                          confirmLabel="[confirm remove]"
                          onConfirm={() => void remove(config.id)}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <div className="label settings__add-label">add a key</div>
                {/* The new key's model catalog is fetched automatically by
                    useModelCatalogs once the config list updates. */}
                <KeyEntry add={add} test={test} autoSave={false} onSaved={() => undefined} />
              </>
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
