import type { Theme } from '@ai-workspace/shared'

const OPTIONS: Theme[] = ['system', 'light', 'dark']

interface Props {
  theme: Theme
  onChange: (theme: Theme) => void
}

export function ThemeToggle({ theme, onChange }: Props) {
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={theme === option}
          className={`theme-toggle__option${theme === option ? ' is-active' : ''}`}
          onClick={() => onChange(option)}
        >
          {option[0]!.toUpperCase() + option.slice(1)}
        </button>
      ))}
    </div>
  )
}
