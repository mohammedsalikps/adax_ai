import type { ReactNode } from 'react'
import { isMissingValue } from './spec.ts'

/**
 * Compact label/value rows (DESIGN §2 `KeyValue`): "Allergies   Penicillin". Put KeyValue rows in a KeyValueList (a `<dl>`). Missing is not
 * none: a row whose value is null, undefined or blank says "Not recorded" (or `missing`), muted, never a bare dash.
 */
export function KeyValueList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <dl className={`divide-y divide-line text-sm ${className}`}>{children}</dl>
}

export interface KeyValueProps {
  label: ReactNode
  /** The value. Null, undefined, blank text or an empty list count as missing. */
  value: ReactNode
  /** What a missing value is called (default "Not recorded"; e.g. "Not available yet" for something not read yet). */
  missing?: string
  /** A muted note after the value (a date, "From the record"). */
  hint?: ReactNode
  testId?: string
}

/** One row: the label (muted, a fixed column from 640px) and the value, which wraps. */
export function KeyValue({ label, value, missing = 'Not recorded', hint, testId }: KeyValueProps) {
  const absent = isMissingValue(value)
  return (
    <div data-testid={testId} data-missing={absent || undefined} className="grid grid-cols-1 gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">
        {absent ? <span className="text-ink-muted">{missing}</span> : value}
        {hint && <span className="ml-2 text-xs text-ink-muted">{hint}</span>}
      </dd>
    </div>
  )
}
