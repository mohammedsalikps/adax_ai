import { type ReactNode, useEffect, useRef } from 'react'

/** The CSS variable a bar at the bottom of the screen publishes its height in (styles.css keeps focused controls clear of it; the global Mana button sits above it). */
export const ACTION_BAR_VAR = '--action-bar-h'

export interface BottomBarProps {
  /** The quiet left side: the save state, what Mana will read. Muted, small. */
  start?: ReactNode
  /** The actions, right-aligned: secondary ones first, the one primary action last. */
  children: ReactNode
  /** Names the bar as a region for assistive technology ("Consultation actions"). Without it the bar is not a landmark. */
  label?: string
  testId?: string
  className?: string
}

/**
 * The sticky action bar at the bottom of a doctor page (DESIGN §2, §5.4, §5.6): save state on the left, the actions on the right, one
 * primary. Put it as the LAST child of the page (directly in the shell's main): it bleeds to the edges of the main column and sticks to the
 * bottom of the screen at every width, taking its own room in the page (no spacer needed). While mounted it publishes its measured height
 * as `--action-bar-h`, which the page's scroll padding and the floating Mana button honour, and removes it when it goes. Hidden in print.
 */
export function BottomBar({ start, children, label, testId, className = '' }: BottomBarProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const apply = () => root.style.setProperty(ACTION_BAR_VAR, `${el.offsetHeight}px`)
    apply()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    ro?.observe(el)
    window.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      root.style.removeProperty(ACTION_BAR_VAR)
    }
  }, [])
  return (
    <div
      ref={ref}
      role={label ? 'region' : undefined}
      aria-label={label}
      data-testid={testId}
      className={`sticky bottom-0 z-20 -mx-4 mt-6 -mb-6 border-t border-line bg-surface/95 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 print:hidden ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {start && <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">{start}</div>}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
    </div>
  )
}
