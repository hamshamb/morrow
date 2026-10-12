// Tiny Electron main used ONLY by the screenshot-QA script (qa-mock.mjs): it
// opens a window on the renderer dev server (which installs the dev-only mock
// RendererApi because there is no preload). Not part of the app.
const { app, BrowserWindow } = require('electron')

const width = Number(process.env.QA_WIDTH || 1280)
const height = Number(process.env.QA_HEIGHT || 720)
const url = process.env.QA_URL || 'http://127.0.0.1:5199/'

app.whenReady().then(() => {
  const win = new BrowserWindow({ width, height, useContentSize: true, show: true, webPreferences: { contextIsolation: true } })
  // The renderer guards unsaved editor files with beforeunload; the real app answers with a
  // native dialog - this harness just lets the window close.
  win.webContents.on('will-prevent-unload', (event) => event.preventDefault())
  win.loadURL(url)
})
app.on('window-all-closed', () => app.quit())
