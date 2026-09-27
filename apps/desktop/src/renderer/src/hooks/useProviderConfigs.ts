import { useCallback, useEffect, useState } from 'react'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  TestProviderConfigInput,
  TestProviderConfigResult,
} from '@ai-workspace/shared'

export function useProviderConfigs() {
  const [configs, setConfigs] = useState<ProviderConfigSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const list = await window.api.providerConfigs.list()
      setConfigs(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const add = useCallback(
    async (input: AddProviderConfigInput) => {
      const created = await window.api.providerConfigs.add(input)
      await refresh()
      return created
    },
    [refresh],
  )

  const remove = useCallback(
    async (id: string) => {
      await window.api.providerConfigs.remove(id)
      await refresh()
    },
    [refresh],
  )

  const test = useCallback(
    (input: TestProviderConfigInput): Promise<TestProviderConfigResult> =>
      window.api.providerConfigs.test(input),
    [],
  )

  return { configs, loading, error, add, remove, test, refresh }
}
