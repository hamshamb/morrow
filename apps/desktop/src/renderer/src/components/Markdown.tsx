import { memo } from 'react'
import { Streamdown, type Components } from 'streamdown'
import { CodeBlock } from './CodeBlock'

/**
 * Assistant markdown, rendered by Streamdown (Apache-2.0, Vercel's streaming
 * markdown renderer from the AI Elements ecosystem) instead of react-markdown.
 * It tolerates half-finished markdown while tokens arrive (unclosed fences,
 * bold, links) and re-renders only the block that is still changing.
 *
 * Streamdown ships Tailwind utility classes for its default elements; this app
 * has no Tailwind (ADR-018), so those classes are inert and the nochan `.prose`
 * rules style plain HTML tags exactly as they did for react-markdown. The few
 * elements whose default renderer swaps the semantic tag for a styled
 * `<span>`/`<button>` (strong, links) or draws its own widget (fenced code) are
 * overridden below so they stay real `<strong>`/`<a>`/`CodeBlock`. Streamdown's
 * own code-block, table and link-safety controls are turned off.
 */
const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => <code className={className}>{children}</code>,
  strong: ({ children }) => <strong>{children}</strong>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
}

interface Props {
  children: string
  /** True while the text is still arriving (enables incomplete-markdown repair). */
  streaming?: boolean
}

export const Markdown = memo(function Markdown({ children, streaming = false }: Props) {
  return (
    <Streamdown
      className="prose"
      components={components}
      controls={false}
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      tableMaxHeight={0}
      codeBlockMaxHeight={0}
    >
      {children}
    </Streamdown>
  )
})
