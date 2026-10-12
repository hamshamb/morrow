/**
 * Monaco, assembled once, loaded on demand (ADR-033). Only `loader.ts`
 * imports this file, and only through a dynamic `import()`, so Vite emits it -
 * with the editor engine, the codicon font and the per-language tokenizers -
 * as separate chunks that chat startup never downloads.
 *
 * Deliberately NOT `monaco-editor`'s full entry (`editor.main`): that pulls in
 * the TypeScript / CSS / HTML / JSON language *services* (multi-megabyte
 * workers that would add project-less, noisy diagnostics to a workspace app).
 * We take the editor API, the editing features, lazy Monarch syntax
 * highlighting for the bundled languages, and the base editor worker (used
 * for diffing). The feature list mirrors `editor.main` minus hover, suggest,
 * rename, code actions and the other language-service-backed features.
 */
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/features/codeEditor/register.js'
import 'monaco-editor/features/codicon/register.js'
import 'monaco-editor/features/anchorSelect/register.js'
import 'monaco-editor/features/bracketMatching/register.js'
import 'monaco-editor/features/caretOperations/register.js'
import 'monaco-editor/features/clipboard/register.js'
import 'monaco-editor/features/comment/register.js'
import 'monaco-editor/features/contextmenu/register.js'
import 'monaco-editor/features/cursorUndo/register.js'
import 'monaco-editor/features/diffEditor/register.js'
import 'monaco-editor/features/diffEditorBreadcrumbs/register.js'
import 'monaco-editor/features/find/register.js'
import 'monaco-editor/features/folding/register.js'
import 'monaco-editor/features/fontZoom/register.js'
import 'monaco-editor/features/gotoLine/register.js'
import 'monaco-editor/features/indentation/register.js'
import 'monaco-editor/features/lineSelection/register.js'
import 'monaco-editor/features/linesOperations/register.js'
import 'monaco-editor/features/longLinesHelper/register.js'
import 'monaco-editor/features/middleScroll/register.js'
import 'monaco-editor/features/multicursor/register.js'
import 'monaco-editor/features/readOnlyMessage/register.js'
import 'monaco-editor/features/smartSelect/register.js'
import 'monaco-editor/features/tokenization/register.js'
import 'monaco-editor/features/unicodeHighlighter/register.js'
import 'monaco-editor/features/wordHighlighter/register.js'
import 'monaco-editor/features/wordOperations/register.js'
import 'monaco-editor/features/wordPartOperations/register.js'
// Syntax highlighting: each language registers a lazy loader; its tokenizer is
// a separate chunk fetched the first time a file of that language is opened.
import 'monaco-editor/languages/definitions/register.all.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'

type MonacoEnvironment = { getWorker: (workerId: string, label: string) => Worker }
;(self as unknown as { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
  // One worker kind: the base editor worker (diff computation, word-based
  // helpers). No language-service workers exist in this build.
  getWorker: () => new EditorWorker(),
}

// JSON has no Monarch definition in monaco-editor (its highlighting lives in the
// JSON language service we deliberately leave out), so register a small tokenizer.
monaco.languages.register({
  id: 'json',
  extensions: ['.json', '.jsonc', '.json5', '.webmanifest', '.code-workspace'],
  filenames: ['.babelrc', '.eslintrc', 'tsconfig.json', 'package.json'],
  aliases: ['JSON', 'json'],
})
monaco.languages.setMonarchTokensProvider('json', {
  defaultToken: '',
  tokenPostfix: '.json',
  keywords: ['true', 'false', 'null'],
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'attribute.name'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/[{}[\],:]/, 'delimiter'],
    ],
    comment: [
      [/[^*/]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[*/]/, 'comment'],
    ],
  },
})
monaco.languages.setLanguageConfiguration('json', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}', notIn: ['string'] },
    { open: '[', close: ']', notIn: ['string'] },
    { open: '"', close: '"', notIn: ['string'] },
  ],
})

export { monaco }
