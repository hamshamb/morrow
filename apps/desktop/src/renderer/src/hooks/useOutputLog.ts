import { useCallback, useState } from 'react'

export interface OutputLine {
  id: number
  at: number
  level: 'info' | 'error'
  text: string
}

const MAX_LINES = 500
let nextId = 1

/** The bottom panel's "Output" tab: a bounded log of what the code workspace did (saves, git actions, terminal starts, failures). */
export function useOutputLog() {
  const [lines, setLines] = useState<OutputLine[]>([])
  const log = useCallback((level: 'info' | 'error', text: string) => {
    setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), { id: nextId++, at: Date.now(), level, text }])
  }, [])
  const clear = useCallback(() => setLines([]), [])
  return { lines, log, clear }
}

export type OutputLog = ReturnType<typeof useOutputLog>
