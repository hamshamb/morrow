import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Drag-to-resize a panel's width (or height), with an optional
 * "drag below N px and it snaps closed" collapse threshold.
 *
 * The mousedown/mousemove/mouseup drag algorithm below is adapted from
 * opencode's `<ResizeHandle>` (`packages/ui/src/components/resize-handle.tsx`,
 * MIT License, https://github.com/anomalyco/opencode) — a small,
 * zero-dependency vanilla-DOM implementation that ports almost directly
 * from Solid to a React hook; only the reactivity wiring (refs/state
 * instead of Solid signals) changed. See docs/OPEN_SOURCE_INVENTORY.md.
 */
export function useResizablePanel(options: {
  direction: 'horizontal' | 'vertical'
  initialSize: number
  min: number
  max: number
  /** Dragging the panel below this size snaps it to `onCollapse`. 0 disables. */
  collapseThreshold?: number
  onCollapse?: () => void
  /** When true, dragging further from the edge shrinks the panel instead of growing it
   * (use for a panel anchored on the right/bottom edge of the screen). */
  reverse?: boolean
}) {
  const { direction, initialSize, min, max, collapseThreshold = 0, onCollapse, reverse = false } = options
  const [size, setSize] = useState(initialSize)
  const [dragging, setDragging] = useState(false)
  const sizeRef = useRef(size)
  useEffect(() => {
    sizeRef.current = size
  }, [size])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const start = direction === 'horizontal' ? e.clientX : e.clientY
      const startSize = sizeRef.current
      document.body.style.userSelect = 'none'
      setDragging(true)

      function onMouseMove(moveEvent: MouseEvent) {
        const pos = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY
        const rawDelta = pos - start
        const delta = reverse ? -rawDelta : rawDelta
        const next = startSize + delta
        if (collapseThreshold > 0 && next < collapseThreshold) {
          onCollapse?.()
        }
        setSize(Math.min(max, Math.max(min, next)))
      }

      function onMouseUp() {
        document.body.style.userSelect = ''
        setDragging(false)
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [direction, min, max, collapseThreshold, onCollapse, reverse],
  )

  // Clean up the (rare) case the component unmounts mid-drag.
  useEffect(
    () => () => {
      document.body.style.userSelect = ''
    },
    [],
  )

  return { size, setSize, dragging, onMouseDown }
}
