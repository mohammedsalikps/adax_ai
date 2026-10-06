import type { Me } from '@adaxai/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import { flushSync } from 'react-dom'
import { moduleStorage, readModuleOpen, writeModuleOpen } from '../../lib/moduleState.ts'
import { ME_KEY } from '../../lib/session.ts'
import { expandPart, MODULES, type ModulePart, onExpandPart, showPart } from '../../lib/workspace.ts'
import { CardFrameContext } from '../ui/Layout.tsx'
import { PanelBoundary, PanelFaultContext } from '../ui/PanelBoundary.tsx'

/**
 * What a module's summary shows only while the module is closed (its one or two short lines), and only while it is open (the fuller lines, the
 * source and time). Both are always in the page (only hidden), so what is said is the same for every reader at any time; the module's `data-open`
 * decides which is seen.
 */
export const CLOSED_ONLY = 'group-data-[open=true]/module:hidden'
export const OPEN_ONLY = 'hidden group-data-[open=true]/module:block'

/** A module's state tones: the status colours only. Violet is for model output, never for an input. */
export type ModuleTone = 'ok' | 'warn' | 'down' | 'notice' | 'neutral'

/** What the module's chip says (always a word; the colour only repeats it). */
export interface ModuleState {
  word: string
  tone: ModuleTone
}

/**
 * The chip's word in the module's own row, where the module's title already says what it is about: "Unavailable" under Conversation for
 * "Speech-to-text unavailable", "Not connected" under Vitals for "Device not connected (2 of 2)" (the bar's chip keeps the count). What a
 * word says is never changed, only what the title makes plain is left out; the full word is the chip's tooltip and is read out with it.
 */
export function moduleChipWord(word: string): string {
  const [head = word, ...rest] = word.split(' · ')
  const tail = rest.length ? ` · ${rest.join(' · ')}` : ''
  const short = head
    .replace(/^Speech-to-text unavailable$/, 'Unavailable')
    .replace(/^Speech-to-text not set up$/, 'Not set up')
    .replace(/^Device live \((\d+) of (\d+)\)$/, 'Live $1 of $2')
    .replace(/^Device live$/, 'Live')
    .replace(/^Device not connected( \(\d+ of \d+\))?$/, 'Not connected')
    .replace(/^Device reading stale( \(\d+ of \d+\))?$/, 'Stale')
    .replace(/^Device unavailable( \(\d+ of \d+\))?$/, 'Unavailable')
    .replace(/^Device: no data( \(\d+ of \d+\))?$/, 'No data')
    .replace(/^Simulated devices?$/, 'Simulated')
    .replace(/^No device attached$/, 'No device')
    .replace(/^History recorded$/, 'Recorded')
    .replace(/^No history recorded$/, 'None recorded')
  return short + tail
}

const CHIP_TONE: Record<ModuleTone, string> = {
  neutral: 'bg-canvas text-ink-muted border-line',
  ok: 'bg-ok-soft text-ok border-ok/20',
  warn: 'bg-pending-soft text-pending border-pending/20',
  down: 'bg-down-soft text-down border-down/20',
  notice: 'bg-notice-soft text-notice border-notice/20',
}

/**
 * A module's quick action (Record, Attach device, Capture thermal, Open thermal, Research): an icon and a word in a small secondary button, drawn
 * 24px high so a summary line stays one line, with a target of 36px (the dense-list size) made by an invisible edge above and below it. Nothing
 * in a summary sits within 6px above or below one, so that edge never covers another control.
 */
export function QuickAction({
  icon: Icon,
  children,
  onClick,
  disabled,
  title,
  testId,
  className = '',
}: {
  icon: LucideIcon
  children: ReactNode
  onClick: () => void
  disabled?: boolean | undefined
  title?: string | undefined
  testId?: string | undefined
  className?: string | undefined
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`relative inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-xs font-medium whitespace-nowrap text-ink shadow-card transition-colors before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
    </button>
  )
}

/** A control inside a module's full panel that a quick action uses: by its test id, or by its visible words (a button, or a tab with role). */
export type PanelTarget = { testId: string } | { text: string | RegExp; role?: 'tab' | 'button' }

function findTarget(root: HTMLElement, t: PanelTarget): HTMLElement | null {
  if ('testId' in t) return /^[\w-]+$/.test(t.testId) ? root.querySelector<HTMLElement>(`[data-testid="${t.testId}"]`) : null
  const candidates = root.querySelectorAll<HTMLElement>(t.role === 'tab' ? '[role="tab"]' : 'button')
  for (const el of candidates) {
    const words = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (typeof t.text === 'string' ? words === t.text : t.text.test(words)) return el
  }
  return null
}

/**
 * What a quick action does: it opens the module (now, not at the next render, so that its full panel is on the screen), brings it into view,
 * and then uses the panel's own controls, in order (a tab, then its "Add allergy"), each focused and clicked as the doctor would, so there is one
 * recorder, one device dialog and one thermal workspace on the page and focus comes back to the panel's control when a dialog closes. When a
 * control is not there or is disabled (no consent yet, the speech service down), it stops with the module open and focused, where the panel
 * says why. Returns whether every control was used.
 */
export function runModuleAction(part: ModulePart, ...targets: PanelTarget[]): boolean {
  flushSync(() => expandPart(part))
  showPart(part)
  const root = document.getElementById(part)
  if (!root) return false
  let last: HTMLElement | null = null
  for (const t of targets) {
    const el = findTarget(root, t)
    if (!el || (el instanceof HTMLButtonElement && el.disabled)) return false
    el.focus({ preventScroll: true })
    flushSync(() => el.click())
    last = el
  }
  if (last) focusBackAfterDialog(root, last)
  return true
}

/**
 * When the control used opened a dialog in the module, and that dialog is taken out of the page when it closes (as the panels' dialogs are),
 * the browser has nowhere to put focus back and leaves it on the page itself: then it is put back on that control (or on the module when the
 * control has gone), so a keyboard user continues where they were. Where the dialog's owner put focus somewhere itself, nothing is moved.
 */
function focusBackAfterDialog(root: HTMLElement, control: HTMLElement) {
  if (typeof MutationObserver === 'undefined' || !root.querySelector('dialog[open]')) return
  const watch = new MutationObserver(() => {
    if (root.querySelector('dialog[open]')) return
    watch.disconnect()
    requestAnimationFrame(() => {
      const now = document.activeElement
      if (now && now !== document.body) return
      ;(control.isConnected && control.getClientRects().length ? control : root).focus({ preventScroll: true })
    })
  })
  watch.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
}

/**
 * One of the five numbered inputs of a consultation (conversation, history, vitals, stethoscope, thermal): a compact card that is always
 * visible above the full panel. Closed, it is one header row (the number, the icon, the title and its state chip on one line, 24px) and one or
 * two short summary lines, with the module's quick actions where they help (an empty module offers the one thing to do: Record, Attach device,
 * Capture thermal); open, the summary's fuller lines, where the data came from and when, and the full panel, whose own cards are drawn flat
 * inside this one.
 *
 * The Show/Hide button is 44px square in the card's top right corner; the summary's first line steps around it (a small float), so the card
 * is no taller than its rows of words (a closed module is about 64 to 90px).
 *
 * The full panel is always mounted, only hidden while the module is closed: a recording, the device poller and the panels' queries keep
 * running, and the summaries and the header's chips, which only observe those queries, stay current. It opens:
 * - with its button (an icon button named "Show <title>" / "Hide <title>", with aria-expanded and aria-controls, 44px); that choice is
 *   remembered for the person signed in on this browser (lib/moduleState.ts);
 * - when another part leads here (the workflow strip, the overview, a chip, a quick action): expandPart(id) from lib/workspace.ts;
 * - by itself when anything inside it fails to draw, wherever the boundary that caught it is (PanelFaultContext), so the failure and its
 *   "Try again" are seen, not hidden behind "Show".
 * The last two do not change what is remembered.
 *
 * `id` is the module's part (lib/workspace.ts MODULES: tools-conversation, tools-history, tools-devices, tools-stethoscope, tools-thermal),
 * the id of this element; its test id (module-<key>) and its number come from the same table. The module is a group named by its h2, and
 * focusable (tabIndex -1) so that arriving here by showPart moves focus to it.
 */
export function ModuleShell({
  id,
  index,
  title,
  icon: Icon,
  state,
  summary,
  meta,
  actions,
  defaultOpen = false,
  children,
}: {
  id: ModulePart
  /** Its place in the consultation's order, beside the icon; MODULES says it already. */
  index?: 1 | 2 | 3 | 4 | 5
  title: string
  icon: LucideIcon
  state: ModuleState
  /**
   * Read from data the page already has; numbers are set in tabular figures. What it shows only closed (one or two short lines) or only open
   * (the fuller lines) it marks with CLOSED_ONLY / OPEN_ONLY. Its outermost elements are plain blocks (not flex boxes), so that its first line
   * steps around the Show/Hide button instead of the whole summary being narrowed.
   */
  summary: ReactNode
  /** Where it came from and when (source · time): shown while the module is open. */
  meta?: ReactNode
  /** Quick actions that work while the module is closed, in one dense row under the summary (most summaries carry their own). */
  actions?: ReactNode
  /** Open when this person has not chosen; closed (compact) unless the page says otherwise. */
  defaultOpen?: boolean
  /** The full panel. */
  children: ReactNode
}) {
  const entry = MODULES.find((m) => m.part === id) ?? MODULES[0]
  const headingId = useId()
  const bodyId = `${id}-body`
  // Who is signed in is already in the cache (the routing guard loaded it, and rebuilds the page for another person): no request.
  const viewer = useQueryClient().getQueryData<Me | null>(ME_KEY)?.id
  const [open, setOpen] = useState(() => readModuleOpen(moduleStorage(), viewer, entry.key) ?? defaultOpen)
  const reveal = useCallback(() => setOpen(true), [])
  useEffect(
    () =>
      onExpandPart((part) => {
        if (part === id) setOpen(true)
      }),
    [id],
  )
  const chip = moduleChipWord(state.word)
  const toggle = () => {
    setOpen(!open)
    writeModuleOpen(moduleStorage(), viewer, entry.key, !open)
  }

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={headingId}
      tabIndex={-1}
      data-testid={entry.testId}
      data-open={open}
      className="group/module @container/module relative min-w-0 scroll-mt-20 rounded-xl border border-line bg-surface shadow-card focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand lg:scroll-mt-0"
    >
      {/* One row, 24px (8px above it): the number and the icon (both repeat what the title and the order on the page say), the title and its
          state chip on one line (the chip gives way first, never the title). The Show/Hide button is in the card's corner (pr-11 keeps the row
          clear of it). */}
      <div className="flex h-8 items-end gap-1.5 pr-11 pl-3">
        <span aria-hidden="true" className="flex h-6 shrink-0 items-center gap-1.5 text-ink-muted">
          <span className="w-2 text-center text-xs font-semibold tabular-nums">{index ?? entry.n}</span>
          <Icon className="size-4" />
        </span>
        <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5">
          <h2 id={headingId} className="shrink-0 text-sm leading-5 font-semibold">
            {title}
          </h2>
          <span className="flex min-w-0" data-module-chip title={state.word}>
            <span className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${CHIP_TONE[state.tone]}`}>
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
              {chip === state.word ? (
                <span className="truncate">{chip}</span>
              ) : (
                <>
                  <span aria-hidden="true" className="truncate">
                    {chip}
                  </span>
                  <span className="sr-only">{state.word}</span>
                </>
              )}
            </span>
          </span>
        </div>
        <button
          type="button"
          className="absolute top-0 right-0 inline-flex size-11 items-center justify-center rounded-tr-xl rounded-bl-md text-ink-muted transition-colors hover:bg-canvas hover:text-ink"
          aria-label={`${open ? 'Hide' : 'Show'} ${title}`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <ChevronDown aria-hidden="true" className={`size-5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {/* Closed, the first 12px of the summary are beside the corner button: this float makes its first line step around it. Open, the summary
          starts below the button instead (12px lower), so its tiles and lines have the module's full width. */}
      <span aria-hidden="true" className="float-right h-3 w-11 group-data-[open=true]/module:hidden" />
      {/* The summary reads the panel's own data: if it cannot be drawn, it says so here and the module opens on the full panel. Closed, it is
          one or two short lines; open, the summary's fuller lines and where the data came from (source · time) are shown above the panel. */}
      {/* pb-1.5: a quick action on the last line reaches down to the card's edge with its 36px target, no further. */}
      <PanelBoundary label={`The ${title.toLowerCase()} summary`} neutral onFault={reveal} className="px-3 pb-1.5 group-data-[open=true]/module:pt-3 group-data-[open=true]/module:pb-2.5">
        <div className="min-w-0 text-sm break-words tabular-nums">{summary}</div>
        {meta && <p className={`mt-1 text-xs text-ink-muted ${OPEN_ONLY}`}>{meta}</p>}
        {actions && <div className="flex flex-wrap gap-2 pt-2 pb-1">{actions}</div>}
      </PanelBoundary>
      {/* Hidden, never unmounted. The panel is part of this card: its own cards are drawn flat (a line above each, no box of their own), so
          nothing is a card inside a card. */}
      <div id={bodyId} hidden={!open} className="clear-both animate-rise-in">
        <CardFrameContext.Provider value="flat">
          <PanelBoundary label={`The ${title.toLowerCase()} panel`} onFault={reveal} className="space-y-0">
            <PanelFaultContext.Provider value={reveal}>{children}</PanelFaultContext.Provider>
          </PanelBoundary>
        </CardFrameContext.Provider>
      </div>
    </div>
  )
}
