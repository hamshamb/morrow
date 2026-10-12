/**
 * Prints what the registry/catalog join produce from a models.dev document
 * (the bundled snapshot by default, or a downloaded cache file) — a quick
 * real-data sanity check, not part of the test suite.
 *
 *   tsx scripts/inspect-catalog.ts [path-to-models-dev-cache.json]
 */
import { readFileSync } from 'node:fs'
import {
  buildProviderRegistry,
  joinCatalog,
  loadBundledCatalog,
  parseModelsDevCatalog,
  resolveProviderRuntime,
  type ModelsDevCatalog,
} from '../packages/providers/src/index'

const file = process.argv[2]
let catalog: ModelsDevCatalog
if (file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { catalog?: unknown }
  catalog = parseModelsDevCatalog(parsed.catalog ?? parsed)
} else {
  catalog = loadBundledCatalog()
}

const registry = buildProviderRegistry(catalog)
const models = Object.values(catalog).reduce((n, p) => n + Object.keys(p.models).length, 0)
console.log(`${Object.keys(catalog).length} providers, ${models} models in the catalog; ${registry.length} in the registry`)
console.log('first 12:', registry.slice(0, 12).map((e) => `${e.id}(${e.modelCount})`).join(' '))

for (const [providerId, modelId] of [
  ['anthropic', 'claude-sonnet-5'],
  ['openai', 'gpt-5.6'],
  ['google', 'gemini-3.5-flash'],
  ['xai', 'grok-4.7'],
  ['deepseek', 'deepseek-v4-pro'],
  ['mistral', 'mistral-small-latest'],
]) {
  const runtime = resolveProviderRuntime(providerId!, catalog[providerId!])
  if (runtime.status !== 'ok') {
    console.log(providerId, 'excluded:', runtime.reason)
    continue
  }
  const joined = joinCatalog({ provider: catalog[providerId!], factoryKey: runtime.factoryKey, live: [{ id: modelId!, displayName: null }] })
  const meta = joined.models[0]?.meta
  console.log(
    `${providerId}/${modelId} via ${runtime.factoryKey}:`,
    meta ? `ctx=${meta.contextWindow} cost=${meta.cost?.input}/${meta.cost?.output} efforts=[${meta.reasoningEfforts.join(',')}]` : 'no metadata',
  )
}
