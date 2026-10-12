import { describe, expect, it } from 'vitest'
import { isAppUrl, isSafeExternalUrl } from '../navigation-guard'

describe('isSafeExternalUrl', () => {
  it('allows plain web links', () => {
    expect(isSafeExternalUrl('https://models.dev/')).toBe(true)
    expect(isSafeExternalUrl('http://localhost:3000/x')).toBe(true)
  })

  it('refuses anything that can open local files or programs', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x&crumb=location:\\\\evil\\share',
      'vscode://command/workbench.action.terminal.new',
      'data:text/html,<script>1</script>',
      'smb://host/share',
      'not a url',
      '',
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false)
    }
  })
})

describe('isAppUrl', () => {
  const fileApp = 'file:///C:/app/out/renderer/index.html'

  it('only lets a packaged window reload its own renderer file', () => {
    expect(isAppUrl('file:///C:/app/out/renderer/index.html', fileApp)).toBe(true)
    expect(isAppUrl('file:///C:/Users/me/Downloads/dropped.html', fileApp)).toBe(false)
    expect(isAppUrl('file:///C:/Windows/System32/calc.exe', fileApp)).toBe(false)
    expect(isAppUrl('https://evil.example/', fileApp)).toBe(false)
  })

  it('in dev, allows the dev server origin only', () => {
    const dev = 'http://localhost:5173/'
    expect(isAppUrl('http://localhost:5173/?x=1', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('file:///C:/x.html', dev)).toBe(false)
  })
})
