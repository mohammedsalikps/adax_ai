import type { ReactNode } from 'react'

export interface PageTitleProps {
  /** The page's h1 (sentence case). */
  title: ReactNode
  /** One muted line under it (a date, a short context). */
  subtitle?: ReactNode
  /** The right slot (a SegmentedControl, one quiet link); wraps under the title on narrow screens. */
  actions?: ReactNode
  className?: string
}

/** The title of a doctor page (DESIGN §1-2): an h1 (`text-xl font-semibold`), an optional subtitle and a right slot. */
export function PageTitle({ title, subtitle, actions, className = '' }: PageTitleProps) {
  return (
    <div className={`mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
