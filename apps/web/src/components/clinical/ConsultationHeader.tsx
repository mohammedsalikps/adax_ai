import { ArrowLeft } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { fmtDateTime, fmtTime } from '../../lib/format.ts'
import { Badge } from '../ui/Feedback.tsx'

/** Time since the consultation was started, as m:ss or h:mm:ss; null once it has run long enough that a clock stops being useful. */
export function useElapsed(startedAt: string): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  if (s > 4 * 3600) return null
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** Whether `ref`'s element is on screen (below the top bars). True where the browser cannot tell, so nothing extra is shown. */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    // The sticky bars cover the top of the viewport (the application bar and this header): the element counts as gone once it is behind them.
    // Fully in view or not: the name and the allergy chips are at the top of the banner, so the strip takes over as soon as any of it is behind the bars.
    const io = new IntersectionObserver(([entry]) => setVisible(!!entry && entry.intersectionRatio >= 0.98), { rootMargin: '-120px 0px 0px 0px', threshold: [0.98] })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return visible
}

/**
 * Publishes a measured height as a CSS variable on the page while `ref`'s element is mounted, and 0 where `when` says the element does not
 * take that room (for the bottom bar: where it is not fixed). The page uses these to leave exactly that much room, and to keep focused controls clear.
 */
function usePublishedHeight(ref: RefObject<HTMLElement | null>, name: string, when: (el: HTMLElement) => boolean) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const apply = () => root.style.setProperty(name, when(el) ? `${el.offsetHeight}px` : '0px')
    apply()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    ro?.observe(el)
    window.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      root.style.removeProperty(name)
    }
  }, [ref, name, when])
}

const isFixed = (el: HTMLElement) => getComputedStyle(el).position === 'fixed'
const isSticky = (el: HTMLElement) => getComputedStyle(el).position === 'sticky'

/**
 * The bar above a consultation: the way back, whose consultation it is, that it
 * is in progress and for how long, and its actions (save state, save, complete,
 * more), with the patient's banner (`banner`: who they are, allergies, why they
 * came, alerts, the state of the devices and the local AI) under them.
 *
 * From 1024px wide all of it stays at the top of the page, so the name, the MRN
 * and the allergies are never scrolled away; its height is published as
 * `--consult-header-h` for the tools column beside the note, which stays in view
 * under it. On narrower screens the banner scrolls with the page and the actions
 * stay at the bottom of the screen (a bar whose height is measured, and which
 * never takes more than 45% of it), so the save state and "Complete
 * consultation" are never scrolled away; once the banner has gone, `patient`
 * (name, MRN, allergies) is shown with that bar instead, so the prescriber always
 * sees who this is and what they are allergic to. The elapsed time is for the eye
 * only; it is not announced every second.
 */
export function ConsultationHeader({ patientName, startedAt, backTo, backLabel, actions, patient, banner }: { patientName: string; startedAt: string; backTo: string; backLabel: string; actions?: ReactNode; patient?: ReactNode; banner?: ReactNode }) {
  const elapsed = useElapsed(startedAt)
  const header = useRef<HTMLElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  usePublishedHeight(bar, '--action-bar-h', isFixed)
  usePublishedHeight(header, '--consult-header-h', isSticky)
  return (
    <header ref={header} className="mb-4 lg:sticky lg:top-topbar lg:z-20 lg:-mx-8 lg:border-b lg:border-line lg:bg-canvas/95 lg:px-8 lg:py-2.5 lg:backdrop-blur" data-testid="consultation-header">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Link to={backTo} className="-ml-2 inline-flex size-control items-center justify-center rounded-md text-ink-muted hover:bg-surface hover:text-ink">
            <ArrowLeft aria-hidden="true" className="size-5" />
            <span className="sr-only">{backLabel}</span>
          </Link>
          {/* The patient is what the doctor must not get wrong: their name is the heading; "Consultation" is said to a screen reader first. */}
          <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words">
            <span className="sr-only">Consultation: </span>
            {patientName}
          </h1>
          <Badge tone="brand" dot>
            Draft · in progress
          </Badge>
          <p className="text-sm text-ink-muted tabular-nums">
            {elapsed ? (
              <>
                <span aria-hidden="true">{elapsed}</span>
                <span className="sr-only">Started at {fmtTime(startedAt)}</span>
              </>
            ) : (
              <>Started {fmtDateTime(startedAt)}</>
            )}
          </p>
        </div>
        <div ref={bar} className="max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-20 max-lg:max-h-[45dvh] max-lg:overflow-y-auto max-lg:border-t max-lg:border-line max-lg:bg-surface max-lg:px-4 max-lg:py-2 max-lg:shadow-pop" data-testid="consultation-actions">
          {patient && <div className="mb-2 lg:hidden">{patient}</div>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>
      {banner}
    </header>
  )
}
