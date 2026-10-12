/**
 * Editor and terminal themes derived from the nochan CSS tokens (ADR-033).
 * Monaco and xterm.js ship their own palettes; here both are built from the
 * live `--paper/--ink/--link/...` custom properties, so dark / light / system
 * all follow the app and no color is invented per widget. Pure functions of a
 * token record (no monaco / xterm import) so they stay cheap and unit-testable.
 */

export interface ThemeTokens {
  paper: string
  raised: string
  sunken: string
  ink: string
  muted: string
  rule: string
  ruleStrong: string
  signal: string
  link: string
  ok: string
  highlight: string
  focus: string
  selection: string
  codeFunction: string
  codeChanged: string
}

const CSS_NAMES: Record<keyof ThemeTokens, string> = {
  paper: '--paper',
  raised: '--raised',
  sunken: '--sunken',
  ink: '--ink',
  muted: '--muted',
  rule: '--rule',
  ruleStrong: '--rule-strong',
  signal: '--signal',
  link: '--link',
  ok: '--ok',
  highlight: '--highlight',
  focus: '--focus',
  selection: '--selection',
  codeFunction: '--code-function',
  codeChanged: '--code-changed',
}

/** Light-theme fallbacks, used only if a token can't be read (tests, early boot). */
export const FALLBACK_TOKENS: ThemeTokens = {
  paper: '#eeede7',
  raised: '#f7f6f1',
  sunken: '#e4e2da',
  ink: '#161616',
  muted: '#5f5d57',
  rule: '#b8b5ac',
  ruleStrong: '#85827a',
  signal: '#b8321f',
  link: '#1455d9',
  ok: '#286245',
  highlight: '#f3e7a6',
  focus: '#1455d9',
  selection: '#c9d8f7',
  codeFunction: '#7a3e00',
  codeChanged: '#7a5c00',
}

/** Reads the computed tokens off an element (normally `<html>`). */
export function readThemeTokens(el: Element = document.documentElement): ThemeTokens {
  const style = getComputedStyle(el)
  const out = { ...FALLBACK_TOKENS }
  for (const key of Object.keys(CSS_NAMES) as (keyof ThemeTokens)[]) {
    const value = style.getPropertyValue(CSS_NAMES[key]).trim()
    if (/^#[0-9a-fA-F]{6}$/.test(value)) out[key] = value.toLowerCase()
  }
  return out
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** `#rrggbb` + alpha 0..1 -> `#rrggbbaa`. */
export function withAlpha(hex: string, alpha: number): string {
  return `${hex.slice(0, 7)}${Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')}`
}

/** Linear blend: t=0 -> a, t=1 -> b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a)
  const [br, bg, bb] = channels(b)
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t)
}

/** Relative luminance 0..1; the theme is "dark" when the page background is dim. */
export function isDarkTokens(t: ThemeTokens): boolean {
  const [r, g, b] = channels(t.paper)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
}

const bare = (hex: string): string => hex.slice(1, 7)

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark'
  inherit: boolean
  rules: { token: string; foreground?: string; fontStyle?: string }[]
  colors: Record<string, string>
}

/** The Monaco theme, in `editor.defineTheme` shape. Syntax colors use the tokens nochan reserves for code. */
export function buildMonacoTheme(t: ThemeTokens): MonacoThemeData {
  const dark = isDarkTokens(t)
  const transparent = '#00000000'
  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: bare(t.ink) },
      { token: 'comment', foreground: bare(t.muted), fontStyle: 'italic' },
      { token: 'string', foreground: bare(t.ok) },
      { token: 'string.escape', foreground: bare(t.codeChanged) },
      { token: 'number', foreground: bare(t.codeChanged) },
      { token: 'constant', foreground: bare(t.codeChanged) },
      { token: 'regexp', foreground: bare(t.codeChanged) },
      { token: 'keyword', foreground: bare(t.link) },
      { token: 'type', foreground: bare(t.codeFunction) },
      { token: 'type.identifier', foreground: bare(t.codeFunction) },
      { token: 'tag', foreground: bare(t.codeFunction) },
      { token: 'metatag', foreground: bare(t.codeFunction) },
      { token: 'attribute.name', foreground: bare(t.codeFunction) },
      { token: 'attribute.value', foreground: bare(t.ok) },
      { token: 'predefined', foreground: bare(t.codeFunction) },
      { token: 'function', foreground: bare(t.codeFunction) },
      { token: 'variable', foreground: bare(t.ink) },
      { token: 'operator', foreground: bare(t.muted) },
      { token: 'delimiter', foreground: bare(t.muted) },
      { token: 'invalid', foreground: bare(t.signal) },
    ],
    colors: {
      'editor.background': t.paper,
      'editor.foreground': t.ink,
      'editorLineNumber.foreground': mix(t.paper, t.muted, 0.75),
      'editorLineNumber.activeForeground': t.ink,
      'editorGutter.background': t.paper,
      'editor.lineHighlightBackground': t.raised,
      'editor.lineHighlightBorder': transparent,
      'editor.selectionBackground': t.selection,
      'editor.inactiveSelectionBackground': withAlpha(t.selection, 0.6),
      'editor.selectionHighlightBackground': withAlpha(t.selection, 0.55),
      'editor.wordHighlightBackground': withAlpha(t.selection, 0.5),
      'editor.findMatchBackground': t.highlight,
      'editor.findMatchHighlightBackground': withAlpha(t.highlight, 0.6),
      'editorCursor.foreground': t.ink,
      'editorWhitespace.foreground': t.rule,
      'editorIndentGuide.background1': t.rule,
      'editorIndentGuide.activeBackground1': t.ruleStrong,
      'editorBracketMatch.background': withAlpha(t.selection, 0.6),
      'editorBracketMatch.border': t.ruleStrong,
      'editorRuler.foreground': t.rule,
      'editorOverviewRuler.border': transparent,
      'editorWidget.background': t.raised,
      'editorWidget.border': t.ruleStrong,
      'editorWidget.foreground': t.ink,
      'editorHoverWidget.background': t.raised,
      'editorHoverWidget.border': t.ruleStrong,
      'editorSuggestWidget.background': t.raised,
      'editorSuggestWidget.border': t.ruleStrong,
      'editorSuggestWidget.selectedBackground': t.sunken,
      'input.background': t.paper,
      'input.foreground': t.ink,
      'input.border': t.ruleStrong,
      'inputOption.activeBorder': t.ink,
      'focusBorder': transparent,
      'scrollbarSlider.background': withAlpha(t.rule, 0.7),
      'scrollbarSlider.hoverBackground': withAlpha(t.ruleStrong, 0.7),
      'scrollbarSlider.activeBackground': t.ruleStrong,
      'widget.shadow': transparent,
      'diffEditor.insertedTextBackground': withAlpha(t.ok, dark ? 0.26 : 0.16),
      'diffEditor.removedTextBackground': withAlpha(t.signal, dark ? 0.26 : 0.16),
      'diffEditor.insertedLineBackground': withAlpha(t.ok, dark ? 0.12 : 0.07),
      'diffEditor.removedLineBackground': withAlpha(t.signal, dark ? 0.12 : 0.07),
      'diffEditorGutter.insertedLineBackground': withAlpha(t.ok, 0.14),
      'diffEditorGutter.removedLineBackground': withAlpha(t.signal, 0.14),
      'diffEditor.diagonalFill': t.rule,
      'diffEditor.border': t.rule,
      'editorGroup.border': t.rule,
      'menu.background': t.raised,
      'menu.foreground': t.ink,
      'menu.selectionBackground': t.sunken,
      'menu.selectionForeground': t.ink,
      'menu.border': t.ruleStrong,
    },
  }
}

export interface XtermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionInactiveBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * Terminal palette from the same tokens: the body is `--sunken`, text `--ink`;
 * red/green/yellow/blue are the semantic tokens (signal/ok/code-changed/link),
 * magenta and cyan are blends of them so nothing off-palette appears.
 */
export function buildXtermTheme(t: ThemeTokens): XtermTheme {
  const dark = isDarkTokens(t)
  const magenta = mix(t.link, t.signal, 0.5)
  const cyan = mix(t.link, t.ok, 0.5)
  const lift = (c: string): string => mix(c, dark ? '#ffffff' : '#000000', 0.18)
  return {
    background: t.sunken,
    foreground: t.ink,
    cursor: t.ink,
    cursorAccent: t.sunken,
    selectionBackground: t.selection,
    selectionInactiveBackground: withAlpha(t.selection, 0.6),
    black: dark ? t.rule : t.ink,
    red: t.signal,
    green: t.ok,
    yellow: t.codeChanged,
    blue: t.link,
    magenta,
    cyan,
    white: dark ? t.muted : t.ruleStrong,
    brightBlack: dark ? t.ruleStrong : t.muted,
    brightRed: lift(t.signal),
    brightGreen: lift(t.ok),
    brightYellow: lift(t.codeChanged),
    brightBlue: lift(t.link),
    brightMagenta: lift(magenta),
    brightCyan: lift(cyan),
    brightWhite: dark ? t.ink : t.paper,
  }
}
