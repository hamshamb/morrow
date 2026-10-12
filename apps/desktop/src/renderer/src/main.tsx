import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

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

  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('#root element not found')

  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

void bootstrap()
