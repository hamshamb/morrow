import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
// IBM Plex Mono (SIL OFL-1.1, via @fontsource) — bundled locally, latin
// subset, only the weights the UI uses. Offline-first: no font CDN, and
// the renderer CSP is 'self' anyway.
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@fontsource/ibm-plex-mono/latin-600.css'
import './styles/global.css'
import './styles/providers.css'
import './styles/orchestration.css'
import './styles/code.css'
import './styles/agent.css'

async function bootstrap() {
  // Dev-only escape hatch: when the renderer is opened in a plain browser
  // tab (via the Vite dev server) rather than inside Electron, there is no
  // preload script and `window.api` is undefined. `import.meta.env.DEV` is
  // statically false in a production build, so this whole branch — and the
  // dynamically-imported mock module — is dead-code-eliminated and never
  // bundled into `dist` (verified via `pnpm --filter @ai-workspace/desktop
  // build` + inspecting the output, see docs/BUILD_STATE.md).
  if (import.meta.env.DEV && typeof window !== 'undefined' && !window.api) {
    const { installMockApi } = await import('./dev/mock-api')
    installMockApi()
  }

  // A file dropped anywhere but the composer would make Chromium navigate to
  // it (main also refuses that navigation — see navigation-guard.ts).
  for (const type of ['dragover', 'drop'] as const) {
    window.addEventListener(type, (e) => e.preventDefault())
  }

  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('#root element not found')

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

void bootstrap()
