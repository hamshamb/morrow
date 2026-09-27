import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@ai-workspace/shared'

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
  }, [])

  const update = useCallback(async (partial: Partial<AppSettings>) => {
    const next = await window.api.settings.set(partial)
    setSettings(next)
    return next
  }, [])

  return { settings, update }
}
