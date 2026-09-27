import type { ProviderId } from '@ai-workspace/shared'

export interface ModelOption {
  id: string
  label: string
}

/**
 * A small, hardcoded model catalog per provider. Model ids are freeform
 * strings on the wire (see `SendMessageInput.model`) — this list only drives
 * the renderer's dropdown and can grow without touching the IPC contract.
 */
export const PROVIDER_MODELS: Record<ProviderId, ModelOption[]> = {
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'o3-mini', label: 'o3-mini' },
  ],
  google: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ],
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
}
