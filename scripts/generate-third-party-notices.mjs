// Generates THIRD_PARTY_NOTICES.txt for the packaged desktop app.
//
// Lists every production dependency of apps/desktop (from `pnpm licenses list --prod`), with the
// license text each package ships, plus the notices for things that are not npm dependencies:
// code adapted from opencode, the Codicons font inside monaco-editor (CC-BY-4.0) and the models.dev
// catalog snapshot. electron-builder copies the output next to Morrow.exe (see `extraFiles` in
// apps/desktop/package.json). Electron's and Chromium's own notices are added by electron-builder.
//
// Usage: node scripts/generate-third-party-notices.mjs [outFile]
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'apps', 'desktop')
const outFile = resolve(process.argv[2] ?? join(desktop, '.generated', 'THIRD_PARTY_NOTICES.txt'))

const LICENSE_FILE = /^(licen[cs]e|copying|notice|thirdpartynotices)([-_.].*)?$/i
const RULE = '='.repeat(78)

const json = execSync('pnpm licenses list --prod --json', {
  cwd: desktop,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const byLicense = JSON.parse(json)

const packages = Object.values(byLicense)
  .flat()
  .filter((pkg) => !pkg.name.startsWith('@ai-workspace/'))
  .sort((a, b) => a.name.localeCompare(b.name))

function licenseTexts(pkgPath) {
  let entries
  try {
    entries = readdirSync(pkgPath, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ file: e.name, text: readFileSync(join(pkgPath, e.name), 'utf8').trim() }))
}

const missing = []
const sections = packages.map((pkg) => {
  const texts = licenseTexts(pkg.paths[0])
  if (texts.length === 0) missing.push(pkg.name)
  const head = [
    RULE,
    `${pkg.name} ${pkg.versions.join(', ')}`,
    `License: ${pkg.license}`,
    ...(pkg.homepage ? [`Homepage: ${pkg.homepage}`] : []),
    ...(pkg.author ? [`Author: ${typeof pkg.author === 'string' ? pkg.author : pkg.author.name}`] : []),
    RULE,
  ]
  const body = texts.length
    ? texts.map((t) => (texts.length > 1 ? `--- ${t.file} ---\n${t.text}` : t.text))
    : [
        `This package does not include a license file. It is distributed under the ${pkg.license} license.` +
          (pkg.license === 'Apache-2.0' ? ' The full Apache License 2.0 text appears elsewhere in this file.' : ''),
      ]
  return [...head, '', ...body, ''].join('\n')
})

const MIT_OPENCODE = `MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const extras = [
  [
    'Codicons (bundled inside monaco-editor as codicon.ttf)',
    'License: CC-BY-4.0',
    'Codicons (c) Microsoft Corporation, https://github.com/microsoft/vscode-codicons,',
    'licensed under the Creative Commons Attribution 4.0 International license',
    '(https://creativecommons.org/licenses/by/4.0/). The font is used unmodified.',
  ].join('\n'),
  [
    'opencode (https://github.com/anomalyco/opencode)',
    'License: MIT',
    'Portions of the user interface (resize handle, command palette search matching and',
    'geometry, diff summary) and of the provider layer (provider factory table,',
    'reasoning-option mapping) are adapted from opencode.',
    '',
    MIT_OPENCODE,
  ].join('\n'),
  [
    'models.dev (https://github.com/sst/models.dev)',
    'License: MIT',
    'The bundled model catalog snapshot is derived from data published by models.dev.',
  ].join('\n'),
].map((text) => [RULE, text, ''].join('\n'))

const header = `Morrow third-party notices

Morrow is licensed under the MIT license (see LICENSE.txt). It includes the third-party
software listed below, each under its own license. Electron and Chromium notices are in
LICENSE.electron.txt and LICENSES.chromium.html in this folder.

Where a package offers a choice of licenses, Morrow uses it under the permissive option
(Apache-2.0 for dompurify, BSD-3-Clause for json-schema).

${packages.length} npm packages, plus the bundled assets and adapted code listed first.
`

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, [header, ...extras, ...sections].join('\n'), 'utf8')
console.log(`Wrote ${outFile} (${packages.length} packages)`)
if (missing.length) console.log(`No license file shipped by: ${missing.join(', ')}`)
