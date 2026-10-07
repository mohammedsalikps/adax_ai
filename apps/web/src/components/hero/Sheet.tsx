import { X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef } from 'react'
import { CardFrameContext } from '../ui/Layout.tsx'

/** What can take focus inside the sheet (for keeping Tab inside it). */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const RIGHT_WIDTH = { narrow: 'sm:w-[min(100%,26.25rem)]', default: 'sm:w-[min(100%,32rem)]', wide: 'sm:w-[min(100%,48rem)]', xl: 'sm:w-[min(100%,64rem)]' } as const
const CENTER_WIDTH = { narrow: 'sm:max-w-md', default: 'sm:max-w-lg', wide: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' } as const

export interface SheetProps {
  open: boolean
  onClose: () => void
  /** The sheet's heading (an h2) and accessible name. */
  title: ReactNode
  /** One muted line under the title ("About Anaya Demo-Synthetic"); also its accessible description. */
  subtitle?: ReactNode
  /** Small controls in the header, before the close button (a Menu). */
  actions?: ReactNode
  children: ReactNode
  /** A row of buttons fixed at the bottom of the sheet. */
  footer?: ReactNode
  /** `right` (default): a side sheet from the right edge, full height. `center`: a centred dialog ("Preparing the consultation"). */
  placement?: 'right' | 'center'
  /** From 640px: narrow (420px), default (32rem), wide (48rem) or xl (64rem: Mana, the analysis). Under 640px every sheet is full-screen. */
  width?: 'narrow' | 'default' | 'wide' | 'xl'
  /** The accessible description when it is not the visible subtitle (Mana: "About <patient>"); read by assistive technology only. */
  description?: ReactNode
  /** Replaces the header's title block visually (the h2 title stays for its accessible name, visually hidden); Mana's own header. */
  header?: ReactNode
  /** False while something must finish (a request in flight): Escape and the close button do nothing. */
  dismissible?: boolean
  /** What takes focus when it opens (the Mana input); by default the first control (the browser's choice). */
  initialFocus?: RefObject<HTMLElement | null>
  /**
   * Replaces the body's padding and scrolling (for content that scrolls itself, such as a conversation with its input fixed below it): the
   * body is then a `min-h-0 flex-1` box with these classes and no tab stop of its own.
   */
  bodyClassName?: string
  /** The close button's accessible name. */
  closeLabel?: string
  testId?: string
}

/**
 * The doctor app's sheet (DESIGN §2): a modal `<dialog>` like ui/Dialog (the same open/close and `dismissible` handling, cards inside drawn as
 * cards), as a right side sheet or a centred dialog, full-screen under 640px, hidden in print. It is `aria-modal`; the page behind is inert;
 * Tab and Shift+Tab stay inside it; Escape and the close button close it; focus goes back to what had it before it opened. Its content is
 * mounted only while it is open (nothing inside it fetches before then).
 */
export function Sheet({ open, onClose, title, subtitle, description, header, actions, children, footer, placement = 'right', width = 'default', dismissible = true, initialFocus, bodyClassName, closeLabel = 'Close dialog', testId }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const subtitleId = useId()
  const returnTo = useRef<HTMLElement | null>(null)
  const latest = useRef({ open, dismissible })
  latest.current = { open, dismissible }

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      d.showModal()
      initialFocus?.current?.focus()
    }
    if (!open && d.open) d.close()
  }, [open, initialFocus])
  // The page behind does not scroll while the sheet is open (it is inert, but wheel and touch scrolling would still move it), as the shell's drawer.
  useEffect(() => {
    if (!open) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
    }
  }, [open])
  // Focus goes back to what opened it (the browser usually does this; done here so it also holds when that control was re-rendered).
  useEffect(() => {
    if (open) return
    const el = returnTo.current
    returnTo.current = null
    if (el?.isConnected) el.focus({ preventScroll: true })
  }, [open])
  // Closed by its parent unmounting while open: the dialog leaves the top layer with it; focus is handed back the same way.
  useEffect(
    () => () => {
      const el = returnTo.current
      if (el?.isConnected) el.focus({ preventScroll: true })
    },
    [],
  )

  // Tab stays inside the sheet (the page behind is inert, but without this Tab would also reach the browser's own controls).
  const keepTabInside = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'))
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const frame =
    placement === 'right'
      ? `animate-slide-in-right m-0 ml-auto h-dvh max-h-dvh w-full max-w-none rounded-none border-0 sm:rounded-l-2xl sm:border-l sm:border-line ${RIGHT_WIDTH[width]}`
      : `animate-rise-in m-0 h-dvh max-h-dvh w-full max-w-none rounded-none border-0 sm:m-auto sm:h-fit sm:max-h-[90dvh] sm:w-[calc(100%-2rem)] sm:rounded-2xl sm:border sm:border-line ${CENTER_WIDTH[width]}`

  return (
    <dialog
      ref={ref}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description || subtitle ? subtitleId : undefined}
      onKeyDown={keepTabInside}
      onClose={() => {
        const d = ref.current
        // Not dismissible and closed by the browser anyway (Chromium lets a repeated Escape through): shown again.
        if (latest.current.open && !latest.current.dismissible && d && !d.open) {
          d.showModal()
          return
        }
        if (latest.current.open) onClose()
      }}
      onCancel={(e) => {
        e.preventDefault()
        if (latest.current.dismissible) onClose()
      }}
      data-testid={testId}
      className={`overflow-hidden bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/40 print:hidden ${frame}`}
    >
      {open && (
        <CardFrameContext.Provider value="card">
          <div className={`flex max-h-dvh flex-col ${placement === 'right' ? 'h-dvh' : 'h-dvh sm:h-auto sm:max-h-[90dvh]'}`}>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3">
              <div className="min-w-0 py-1">
                <h2 id={titleId} className={header ? 'sr-only' : 'text-lg leading-6 font-semibold [overflow-wrap:anywhere]'}>
                  {title}
                </h2>
                {header}
                {description ? (
                  <p id={subtitleId} className="sr-only">
                    {description}
                  </p>
                ) : (
                  subtitle && (
                    <p id={subtitleId} className="mt-0.5 text-sm text-ink-muted [overflow-wrap:anywhere]">
                      {subtitle}
                    </p>
                  )
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {actions}
                <button type="button" onClick={onClose} disabled={!dismissible} aria-label={closeLabel} className="inline-flex size-control items-center justify-center rounded-md text-ink-muted hover:bg-canvas hover:text-ink disabled:opacity-40">
                  <X aria-hidden="true" className="size-5" />
                </button>
              </div>
            </div>
            {bodyClassName !== undefined ? (
              <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
            ) : (
              // Focusable so keyboard users can scroll long content that has no controls.
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2" tabIndex={0}>
                {children}
              </div>
            )}
            {footer && <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
          </div>
        </CardFrameContext.Provider>
      )}
    </dialog>
  )
}
