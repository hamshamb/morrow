/**
 * Regenerates the bundled offline models.dev snapshot
 * (packages/providers/src/data/models-dev-snapshot.json).
 *
 *   pnpm models:snapshot                       # download https://models.dev/api.json
 *   pnpm models:snapshot <path-to-api.json>    # use a local copy
 *
 * The snapshot is the first-run / offline floor of the metadata service. It
 * keeps only the fields the app reads, only providers the registry can run,
 * only text-output non-deprecated models, and caps the long tail so the file
 * stays well under 1 MB (the live catalog, ~5 MB, is fetched at runtime and
 * cached on disk — it is not limited by these caps).
 *
 * Data: models.dev (anomalyco/models.dev, MIT).
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseModelsDevCatalog,
  resolveProviderRuntime,
  trimModelsDevCatalog,
  POPULAR_PROVIDER_ORDER,
} from '../packages/providers/src/index'

/** Providers kept whole-ish (their full chat-model list matters most). */
const FULL_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'mistral',
  'groq',
  'deepseek',
  'cerebras',
  'togetherai',
  'perplexity',
  'fireworks-ai',
  'deepinfra',
  'moonshotai',
  'zai',
  'lmstudio',
]
const CAPS: Record<string, number> = {
  // Aggregators list hundreds of models; the snapshot keeps the newest slice.
  openrouter: 40,
}
/** Every other runnable provider keeps this many newest models. */
const DEFAULT_CAP = 4

const here = fileURLToPath(new URL('.', import.meta.url))
const outPath = resolve(here, '../packages/providers/src/data/models-dev-snapshot.json')

async function loadRaw(): Promise<unknown> {
  const arg = process.argv[2]
  if (arg) return JSON.parse(readFileSync(resolve(arg), 'utf8'))
  const res = await fetch('https://models.dev/api.json', { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`models.dev responded ${res.status}`)
  return res.json()
}

const catalog = parseModelsDevCatalog(await loadRaw())
const keep = new Set<string>([...FULL_PROVIDERS, ...POPULAR_PROVIDER_ORDER])
const trimmed = trimModelsDevCatalog(catalog, {
  keepProvider: (provider) => resolveProviderRuntime(provider.id, provider).status === 'ok',
  maxModelsPerProvider: DEFAULT_CAP,
  maxModelsByProvider: {
    ...Object.fromEntries([...keep].map((id) => [id, 100])),
    ...CAPS,
  },
})

const document = {
  _meta: {
    source: 'https://models.dev/api.json',
    note: 'Trimmed by scripts/update-models-snapshot.ts. Do not edit by hand.',
    generatedAt: new Date().toISOString().slice(0, 10),
  },
  ...trimmed,
}
writeFileSync(outPath, JSON.stringify(document) + '\n')

const modelCount = Object.values(trimmed).reduce((n, p) => n + Object.keys(p.models).length, 0)
const bytes = statSync(outPath).size
console.log(
  `wrote ${outPath}\n  ${Object.keys(trimmed).length} providers, ${modelCount} models, ${(bytes / 1024).toFixed(0)} KB`,
)
