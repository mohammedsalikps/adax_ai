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

/** The title of a doctor page (DESIGN §1-2; UI/UX redesign: the reference's large title): an h1, an optional subtitle and a right slot. */
export function PageTitle({ title, subtitle, actions, className = '' }: PageTitleProps) {
  return (
    <div className={`mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
        {subtitle && <p className="mt-1 text-[0.9375rem] text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
