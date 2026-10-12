interface Props {
  onMouseDown: (e: React.MouseEvent) => void
  dragging: boolean
  ariaLabel: string
  /** 'vertical' (default) divides left/right panels; 'horizontal' divides stacked panels (the bottom panel). */
  orientation?: 'vertical' | 'horizontal'
}

/**
 * The draggable edge of a resizable panel: an 8px invisible hit target
 * straddling the panel boundary, with a thin 3px affordance bar that only
 * fades in on hover/active — invisible until interacted with, per
 * opencode's `resize-handle.css` (MIT License,
 * https://github.com/anomalyco/opencode) — see `.resize-handle` rules in
 * global.css and docs/OPEN_SOURCE_INVENTORY.md.
 */
export function ResizeHandle({ onMouseDown, dragging, ariaLabel, orientation = 'vertical' }: Props) {
  return (
    <div
      className={`resize-handle${orientation === 'horizontal' ? ' resize-handle--row' : ''}${dragging ? ' is-dragging' : ''}`}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={orientation === 'horizontal' ? 'horizontal' : 'vertical'}
      aria-label={ariaLabel}
    />
  )
}
