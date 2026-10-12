import type { SVGProps } from 'react'

/**
 * The few line icons the UI still uses (activity rows and context-source
 * rows). Original, minimal 20x20 `currentColor` SVGs authored for this
 * project. Most chrome is text — slash nav, bracketed actions, kbd chips
 * — in nochan's style (docs/UI_REFERENCE_NOCHAN.md), so the icon set is
 * deliberately small.
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

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M15 15l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </Svg>
  )
}

export function ChatIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M4 4h12v9H9l-3.5 3v-3H4V4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="miter"
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
      <path d="M5 3.5h6.5L15 7v9.5H5v-13z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="miter" />
      <path d="M11.2 3.5V7H15" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="miter" />
    </Svg>
  )
}
