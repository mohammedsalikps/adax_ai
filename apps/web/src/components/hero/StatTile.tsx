import type { ComponentType, ReactNode } from 'react'
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
  /** Jury design: a small icon beside the label, and a pastel tone for the tile. */
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>
  tone?: StatTone
}

export type StatTone = 'ok' | 'pending' | 'brand' | 'neutral'
const TONES: Record<StatTone, { tile: string; icon: string }> = {
  ok: { tile: 'border-ok/15 bg-ok-soft/45', icon: 'bg-ok-soft text-ok' },
  pending: { tile: 'border-pending/15 bg-pending-soft/45', icon: 'bg-pending-soft text-pending' },
  brand: { tile: 'border-brand/15 bg-brand-soft', icon: 'bg-white text-brand' },
  neutral: { tile: 'border-line bg-surface', icon: 'bg-canvas text-ink-muted' },
}

/**
 * One dashboard number (DESIGN §1-2): the label, the number in the stat size (semibold, tabular), an optional hint. A calm surface, no
 * shadow, no tinted icon tile. Values only ever come from the server; `aria-busy` while one is not available yet.
 */
export function StatTile({ label, value, hint, testId, as = 'div', className = '', icon: Icon, tone }: StatTileProps) {
  const v = statValue(value)
  const Tag = as
  const t = tone ? TONES[tone] : null
  return (
    <Tag data-testid={testId} aria-busy={v.missing || undefined} className={`min-w-0 rounded-xl border p-4 xl:p-5 ${t ? t.tile : 'border-line bg-surface'} ${className}`}>
      <p className="flex items-center justify-between gap-2 text-sm text-ink-muted">
        {label}
        {Icon && (
          <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg ${t?.icon ?? 'bg-canvas text-ink-muted'}`}>
            <Icon aria-hidden="true" className="size-4" />
          </span>
        )}
      </p>
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
