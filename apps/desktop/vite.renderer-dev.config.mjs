// Renderer-only dev server for browser-based UI work and screenshot QA:
//
//   pnpm --filter @ai-workspace/desktop dev:renderer     # http://localhost:5199
//
// No Electron, no main process, no real database — `window.api` is undefined
// in a plain browser tab, so `main.tsx` installs the dev-only mock RendererApi
// (src/renderer/src/dev/mock-api.ts). Query flags: ?theme=light|dark,
// ?fixture=empty|error, ?ollama=down, ?ctx=<estimated prompt tokens>.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: resolve(here, 'src/renderer'),
  resolve: { alias: { '@renderer': resolve(here, 'src/renderer/src') } },
  plugins: [react()],
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  // The workspace packages ship TypeScript source; let Vite compile them.
  optimizeDeps: { exclude: ['@ai-workspace/shared'] },
})
