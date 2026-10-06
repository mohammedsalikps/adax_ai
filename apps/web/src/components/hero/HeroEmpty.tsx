import type { ReactNode } from 'react'

export interface HeroEmptyProps {
  /** One muted sentence ("Not recorded yet"). */
  children: ReactNode
  /** At most one action (a small button or link: "Record"). */
  action?: ReactNode
  className?: string
  testId?: string
}

/**
 * The empty state of the doctor's app (DESIGN §1): one muted sentence and at most one action, on one line where it fits ("Not recorded yet ·
 * [Record]"). No illustration, no dashed box. Missing is said as missing ("Not recorded", "Not available yet"), never as none or 0.
 */
export function HeroEmpty({ children, action, className = '', testId }: HeroEmptyProps) {
  return (
    <div data-testid={testId} className={`flex flex-wrap items-center gap-x-3 gap-y-2 py-1 text-sm text-ink-muted ${className}`}>
      <p className="min-w-0">{children}</p>
      {action}
    </div>
  )
}
