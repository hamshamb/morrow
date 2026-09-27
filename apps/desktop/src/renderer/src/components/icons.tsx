import type { SVGProps } from 'react'

/**
 * Small icon set for the OpenCode-inspired redesign (see
 * docs/UI_REFERENCE_OPENCODE.md §9). All icons render on a 20x20 viewBox
 * and use `currentColor` so they theme automatically via CSS `color`,
 * matching OpenCode's own icon convention.
 *
 * `chevronDown` and `stop` are the two path strings given verbatim in the
 * research doc (`packages/ui/src/components/icon.tsx`, opencode, MIT
 * License, https://github.com/anomalyco/opencode) — reused directly per
 * docs/OPEN_SOURCE_INVENTORY.md. Every other icon here is an original,
 * minimal SVG authored for this project (not copied from OpenCode — the
 * research doc only gave us those two literal path strings), just
 * following the same 20x20/currentColor convention for visual consistency.
 */

type IconProps = SVGProps<SVGSVGElement>

function Svg(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    />
  )
}

/** Source: opencode packages/ui/src/components/icon.tsx, MIT License. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      />
    </Svg>
  )
}

/** Source: opencode packages/ui/src/components/icon.tsx, MIT License. */
export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" />
    </Svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </Svg>
  )
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M10 15.5V5M10 5L5 10M10 5l5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M5 6h10M8.5 6V4.5h3V6M6.5 6l.6 9h5.8l.6-9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M12.7 4.3l3 3L6.5 16.5 3 17l.5-3.5L12.7 4.3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function DotIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="3.5" fill="currentColor" />
    </Svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M15 15l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M5.5 5.5l9 9m0-9l-9 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M3 6.5A1.5 1.5 0 014.5 5H8l1.5 2H15.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function TerminalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6.5 8l2.5 2.5L6.5 13M10.5 13h3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function GitBranchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="15" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="14" cy="9" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6 6.7V13.3M6 8.5c0 2.5 2.2 2.8 4 2.8h2.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function CodeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M7 6l-4 4 4 4M13 6l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function ChatIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M4 5.5A1.5 1.5 0 015.5 4h9A1.5 1.5 0 0116 5.5v6A1.5 1.5 0 0114.5 13H9l-3.5 3v-3H5.5A1.5 1.5 0 014 11.5v-6z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10 3.5v2M10 14.5v2M16.5 10h-2M5.5 10h-2M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4M14.6 14.6l-1.4-1.4M6.8 6.8L5.4 5.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function PanelRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M13 4.5v11" stroke="currentColor" strokeWidth="1.3" />
    </Svg>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="10" r="1.3" fill="currentColor" />
      <circle cx="10" cy="10" r="1.3" fill="currentColor" />
      <circle cx="15" cy="10" r="1.3" fill="currentColor" />
    </Svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M4.5 10.5l3.2 3.2L15.5 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function PaperclipIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M13.5 6.5l-6 6a2.1 2.1 0 003 3l6.2-6.2a3.5 3.5 0 00-5-5L5.8 10.2a4.9 4.9 0 007 7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M6 3.5h5.5L15 7v9a1 1 0 01-1 1H6a1 1 0 01-1-1v-11.5a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M11.2 3.5V7H15" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </Svg>
  )
}

export function CommandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7v6M12 7v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </Svg>
  )
}
