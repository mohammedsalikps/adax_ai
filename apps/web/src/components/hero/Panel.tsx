import type { LucideIcon } from 'lucide-react'
import { createContext, type ReactNode, useContext, useId } from 'react'
import { CardFrameContext } from '../ui/Layout.tsx'

/**
 * The section label of the Doctor HERO (DESIGN §1, the spec's "LIVE TRANSCRIPTION" style): small, semibold, uppercase, tracked, muted. Written
 * in sentence case in the source ("Live transcription"): the capitals are CSS only, so a screen reader reads words, not letters.
 */
export const SECTION_LABEL = 'text-[0.6875rem] leading-4 font-semibold uppercase tracking-[0.08em] text-ink-muted'

/** The heading level of the panel around a PanelGroup (its own heading is one below). */
const PanelLevelContext = createContext<2 | 3 | null>(null)

export interface PanelProps {
  /** The section label, in sentence case (shown uppercase). It is the panel's heading and names its region. */
  label: ReactNode
  /** A lucide icon drawn 16px, muted, before the label (decorative). */
  icon?: LucideIcon
  /** Small controls at the right of the header (a menu, a ghost button). */
  actions?: ReactNode
  children: ReactNode
  id?: string
  testId?: string
  className?: string
  /** The heading element: h2 (default, a panel on a page whose h1 is the page title) or h3 (a panel inside an area that has its own h2). */
  as?: 'h2' | 'h3'
  /** Replaces the body's padding (for a body that scrolls on its own or runs edge to edge, such as a list with dividers). */
  bodyClassName?: string
}

/**
 * A calm panel (DESIGN §1-2): `bg-surface`, a `line` border, `rounded-xl`, no shadow, with the section-label header. A `<section>` named by
 * its heading. Inside it, separate groups with PanelGroup (a line above), never a card inside a card: an existing `Card` placed in a panel
 * draws itself flat (CardFrameContext), as it does inside a consultation module.
 */
export function Panel({ label, icon: Icon, actions, children, id, testId, className = '', as = 'h2', bodyClassName }: PanelProps) {
  const headingId = useId()
  const Heading = as
  return (
    <section id={id} aria-labelledby={headingId} data-testid={testId} className={`min-w-0 rounded-xl border border-line bg-surface ${className}`}>
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3 xl:px-5">
        <Heading id={headingId} className={`flex min-w-0 items-center gap-2 ${SECTION_LABEL}`}>
          {Icon && <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />}
          <span className="min-w-0">{label}</span>
        </Heading>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={bodyClassName ?? 'px-4 pt-2 pb-4 xl:px-5 xl:pb-5'}>
        <PanelLevelContext.Provider value={as === 'h2' ? 2 : 3}>
          <CardFrameContext.Provider value="flat">{children}</CardFrameContext.Provider>
        </PanelLevelContext.Provider>
      </div>
    </section>
  )
}

export interface PanelGroupProps {
  /** Optional section label of the group (an h3 in an h2 panel, an h4 in an h3 panel). */
  label?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
}

/**
 * A group inside a Panel, set apart by a line above it (DESIGN §1: "separate groups with border-t border-line rather than nested cards"), with
 * an optional section label one heading level below the panel's. Outside a Panel its heading is an h3.
 */
export function PanelGroup({ label, icon: Icon, actions, children, className = '', testId }: PanelGroupProps) {
  const level = useContext(PanelLevelContext) ?? 2
  const headingId = useId()
  const Heading = level === 2 ? 'h3' : 'h4'
  return (
    <div role={label ? 'group' : undefined} aria-labelledby={label ? headingId : undefined} data-testid={testId} className={`mt-4 border-t border-line pt-3 first:mt-0 first:border-t-0 first:pt-0 ${className}`}>
      {(label || actions) && (
        <div className="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {label && (
            <Heading id={headingId} className={`flex min-w-0 items-center gap-2 ${SECTION_LABEL}`}>
              {Icon && <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />}
              <span className="min-w-0">{label}</span>
            </Heading>
          )}
          {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
