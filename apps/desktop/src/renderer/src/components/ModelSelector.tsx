import type { ProviderConfigSummary } from '@ai-workspace/shared'
import { PROVIDER_LABELS, PROVIDER_MODELS } from '../lib/models'

interface Props {
  configs: ProviderConfigSummary[]
  providerConfigId: string | null
  model: string | null
  onChange: (providerConfigId: string, model: string) => void
}

export function ModelSelector({ configs, providerConfigId, model, onChange }: Props) {
  if (configs.length === 0) {
    return <span className="model-selector__empty">No providers configured</span>
  }

  const activeConfig = configs.find((c) => c.id === providerConfigId) ?? configs[0]
  const models = activeConfig ? PROVIDER_MODELS[activeConfig.provider] : []
  const activeModel = model ?? models[0]?.id ?? ''

  return (
    <div className="model-selector">
      <select
        aria-label="Provider"
        value={activeConfig?.id ?? ''}
        onChange={(e) => {
          const next = configs.find((c) => c.id === e.target.value)
          if (!next) return
          const nextModel = PROVIDER_MODELS[next.provider][0]?.id ?? ''
          onChange(next.id, nextModel)
        }}
      >
        {configs.map((config) => (
          <option key={config.id} value={config.id}>
            {config.label} ({PROVIDER_LABELS[config.provider]})
          </option>
        ))}
      </select>
      <select
        aria-label="Model"
        value={activeModel}
        onChange={(e) => activeConfig && onChange(activeConfig.id, e.target.value)}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  )
}
