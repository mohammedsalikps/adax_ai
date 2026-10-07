import { type KeyboardEvent, type ReactNode, useRef } from 'react'

export interface TabItem<T extends string = string> {
  id: T
  label: ReactNode
  /** A number after the label (how many there are). */
  count?: number | undefined
  /** Plain-text name when `label` is not text. */
  name?: string
}

const ids = (prefix: string, id: string) => ({ tab: `${prefix}-tab-${id}`, panel: `${prefix}-panel-${id}` })

/**
 * A row of tabs that switch a panel in place (not pages: use links for that).
 * Arrow keys, Home and End move between tabs (the selected one is the only
 * tab stop), and each tab names its panel. Pair every tab with a `TabPanel`
 * carrying the same `prefix` and `id`.
 *
 * `underline` is for sections inside a card; `pill` is for the filters above a
 * list, where a count says how many are in each.
 */
export function Tabs<T extends string>({ label, prefix, tabs, value, onChange, variant = 'underline', className = '' }: { label: string; prefix: string; tabs: TabItem<T>[]; value: T; onChange: (id: T) => void; variant?: 'underline' | 'pill'; className?: string }) {
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const move = (to: number) => {
    const next = tabs[(to + tabs.length) % tabs.length]!
    onChange(next.id)
    refs.current.get(next.id)?.focus()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight') move(i + 1)
    else if (e.key === 'ArrowLeft') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(tabs.length - 1)
    else return
    e.preventDefault()
  }
  const wrap = variant === 'underline' ? 'flex flex-wrap gap-x-1 border-b border-line' : 'inline-flex flex-wrap gap-1 rounded-xl border border-line bg-canvas/70 p-1'
  return (
    <div role="tablist" aria-label={label} className={`${wrap} ${className}`}>
      {tabs.map((t, i) => {
        const selected = t.id === value
        const base = 'inline-flex min-h-control-sm items-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors'
        // UI/UX redesign: underline tabs read like the reference's record tabs; pill tabs are a quiet track with the choice filled in blue.
        const look =
          variant === 'underline'
            ? `-mb-px border-b-2 px-3 text-[0.9375rem] ${selected ? 'border-brand font-semibold text-brand-strong' : 'border-transparent text-ink-muted hover:border-line-strong hover:text-ink'}`
            : `rounded-lg border px-3.5 ${selected ? 'border-brand bg-brand text-white shadow-[0_4px_12px_-6px_rgb(37_99_235/0.8)]' : 'border-transparent text-ink-muted hover:bg-surface hover:text-ink'}`
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el)
              else refs.current.delete(t.id)
            }}
            type="button"
            role="tab"
            id={ids(prefix, t.id).tab}
            aria-selected={selected}
            aria-controls={ids(prefix, t.id).panel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`${base} ${look}`}
          >
            {t.label}
            {t.count !== undefined && <span className={`rounded-full px-1.5 text-xs tabular-nums ${selected ? (variant === 'pill' ? 'bg-white/20' : 'bg-brand/10') : 'bg-canvas'}`}>{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The panel a tab shows. Inactive panels stay in the page, hidden, so their state is kept. A panel is a tab stop of its own
 * unless `focusable={false}`, for a panel that starts with something focusable (a button, a link): the next Tab reaches that instead.
 */
export function TabPanel({ prefix, id, active, children, className = '', focusable = true }: { prefix: string; id: string; active: boolean; children: ReactNode; className?: string; focusable?: boolean }) {
  return (
    <div role="tabpanel" id={ids(prefix, id).panel} aria-labelledby={ids(prefix, id).tab} hidden={!active} {...(focusable && { tabIndex: 0 })} className={`focus-visible:outline-2 focus-visible:-outline-offset-2 ${className}`}>
      {children}
    </div>
  )
}
