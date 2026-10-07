import type { ReactNode } from 'react'

export interface Segment<T extends string> {
  value: T
  label: ReactNode
}

/**
 * A short row of mutually exclusive choices (a view, a scope). Each is a
 * toggle button whose pressed state is announced; for filtering a list, not
 * for navigating between pages (use links for that).
 */
export function SegmentedControl<T extends string>({ label, value, onChange, options, className = '' }: { label: string; value: T; onChange: (v: T) => void; options: Segment<T>[]; className?: string }) {
  return (
    <div role="group" aria-label={label} className={`inline-flex max-w-full flex-wrap gap-2 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-10 rounded-xl border px-4 text-sm font-medium whitespace-nowrap transition-[background-color,color,border-color,box-shadow] duration-150 ${value === o.value ? 'border-brand bg-brand text-white shadow-[0_6px_14px_-8px_rgb(37_99_235/0.9)]' : 'border-line bg-surface text-ink shadow-card hover:border-brand/40 hover:bg-brand-soft/50'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
