import type { RendererApi } from '@ai-workspace/shared'

declare global {
  interface Window {
    api: RendererApi
  }
}
