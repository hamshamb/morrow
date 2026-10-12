import { isValidElement, useState, type ReactNode } from 'react'

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/**
 * Fenced code block in nochan's style: a header bar with the language,
 * a `[copy]` action, muted line numbers, sunken background, square
 * corners. Used as react-markdown's `pre` renderer. No syntax
 * highlighter dependency — monochrome by design.
 */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null
  const language = code?.props.className?.match(/language-([\w+-]+)/)?.[1] ?? 'text'
  const text = textOf(code ? code.props.children : children).replace(/\n$/, '')
  const lines = text.split('\n')

  function copy() {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="code-block">
      <div className="code-block__header">
        <span className="code-block__lang">{language}</span>
        <button type="button" className="link-action" onClick={copy}>
          {copied ? '[copied]' : '[copy]'}
        </button>
      </div>
      <pre className="code-block__body">
        <code>
          {lines.map((line, i) => (
            <span className="code-block__line" key={i}>
              <span className="code-block__num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="code-block__text">{line || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
