import { X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { CardFrameContext } from './Layout.tsx'

/**
 * Modal dialog on the native <dialog> element: focus is trapped and restored
 * by the browser, Escape closes it, and the page behind is inert.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  dismissible = true,
  placement = 'center',
  testId,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Centred: up to 48rem instead of 32rem. A side sheet: up to 48rem wide instead of 32rem (never wider than the screen). */
  wide?: boolean
  dismissible?: boolean
  /** `right`: a panel from the right edge (a side sheet), full height, that keeps the page visible behind it; everything else is the same dialog. */
  placement?: 'center' | 'right'
  testId?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // `dismissible: false` (a request is in flight) keeps the dialog open: Escape and the close button do nothing, and if the
  // browser closes it anyway (Chromium makes a repeated Escape uncancellable) it is shown again.
  const latest = useRef({ open, dismissible })
  latest.current = { open, dismissible }
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        const d = ref.current
        if (latest.current.open && !latest.current.dismissible && d && !d.open) {
          d.showModal()
          return
        }
        onClose()
      }}
      onCancel={(e) => {
        e.preventDefault()
        if (latest.current.dismissible) onClose()
      }}
      data-testid={testId}
      className={
        placement === 'right'
          ? `animate-slide-in-right m-0 mr-0 ml-auto h-dvh max-h-dvh ${wide ? 'w-[min(100%,48rem)]' : 'w-[min(100%,32rem)]'} max-w-none overflow-hidden rounded-none rounded-l-2xl border-l border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/40`
          : `m-auto max-h-[90dvh] w-[calc(100%-2rem)] overflow-hidden ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl border border-line bg-surface p-0 text-ink shadow-pop backdrop:bg-ink/40`
      }
    >
      {open && (
        // Header and footer stay fixed; only the body scrolls (min-h-0 lets it shrink). Cards in a dialog are drawn as cards, also when the
        // dialog was opened from inside a consultation module (whose open body draws the cards in it flat).
        <CardFrameContext.Provider value="card">
        <div className={placement === 'right' ? 'flex h-dvh max-h-dvh flex-col' : 'flex max-h-[90dvh] flex-col'}>
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-3.5">
            <h2 id={titleId} className="text-lg font-semibold">
              {title}
            </h2>
            <button type="button" onClick={onClose} disabled={!dismissible} className="rounded-md p-2 text-ink-muted hover:bg-canvas disabled:opacity-40" aria-label="Close dialog">
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>
          {/* Focusable so keyboard users can scroll long content even when it has no controls. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2" tabIndex={0}>
            {children}
          </div>
          {footer && <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
        </CardFrameContext.Provider>
      )}
    </dialog>
  )
}
