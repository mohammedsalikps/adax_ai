import type { ReactNode } from 'react'
import { statValue } from './spec.ts'

export interface StatTileProps {
  label: string
  /** The count from the server. Null: not available (not loaded, or not counted) — shown as a dash with "not available" for a screen reader, never as 0. */
  value: number | null
  /** One short muted line under the number ("2 in consultation"). */
  hint?: ReactNode
  testId?: string
  /** `li` when the tiles are a list (put them in a `<ul>`); `div` otherwise. */
  as?: 'div' | 'li'
  className?: string
}

/**
 * One dashboard number (DESIGN §1-2): the label, the number in the stat size (semibold, tabular), an optional hint. A calm surface, no
 * shadow, no tinted icon tile. Values only ever come from the server; `aria-busy` while one is not available yet.
 */
export function StatTile({ label, value, hint, testId, as = 'div', className = '' }: StatTileProps) {
  const v = statValue(value)
  const Tag = as
  return (
    <Tag data-testid={testId} aria-busy={v.missing || undefined} className={`min-w-0 rounded-xl border border-line bg-surface p-4 xl:p-5 ${className}`}>
      <p className="text-sm text-ink-muted">{label}</p>
      <p className="mt-1 text-stat font-semibold tabular-nums">
        {v.missing ? (
          <>
            <span aria-hidden="true">{v.text}</span>
            <span className="sr-only">{v.spoken}</span>
          </>
        ) : (
          v.text
        )}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </Tag>
  )
}
