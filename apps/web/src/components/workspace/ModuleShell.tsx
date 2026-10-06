import type { Me } from '@adaxai/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import { moduleStorage, readModuleOpen, writeModuleOpen } from '../../lib/moduleState.ts'
import { ME_KEY } from '../../lib/session.ts'
import { MODULES, type ModulePart, onExpandPart } from '../../lib/workspace.ts'
import { Button } from '../ui/Button.tsx'
import { CardFrameContext } from '../ui/Layout.tsx'
import { PanelBoundary, PanelFaultContext } from '../ui/PanelBoundary.tsx'

/**
 * What a module's summary shows only while the module is closed (its two short lines), and only while it is open (the fuller lines, the source
 * and time). Both are always in the page (only hidden), so what is said is the same for every reader at any time; the module's `data-open`
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
 * One of the five numbered inputs of a consultation (conversation, history, vitals, stethoscope, thermal): a compact card that is always
 * visible above the full panel. Closed, it is one header row (the number, the icon, the title and its state chip on one line, and the Show
 * button) and at most two short summary lines (with the module's quick actions, if it has any); open, the summary's fuller lines, where the
 * data came from and when, and the full panel, whose own cards are drawn flat inside this one.
 *
 * The full panel is always mounted, only hidden while the module is closed: a recording, the device poller and the panels' queries keep
 * running, and the summaries and the header's chips, which only observe those queries, stay current. It opens:
 * - with its button (an icon button named "Show <title>" / "Hide <title>", with aria-expanded and aria-controls, 44px); that choice is
 *   remembered for the person signed in on this browser (lib/moduleState.ts);
 * - when another part leads here (the workflow strip, the overview, a chip): expandPart(id) from lib/workspace.ts;
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
  /** Its place in the consultation's order, on the icon tile; MODULES says it already. */
  index?: 1 | 2 | 3 | 4 | 5
  title: string
  icon: LucideIcon
  state: ModuleState
  /**
   * Read from data the page already has; numbers are set in tabular figures. What it shows only closed (at most two short lines) or only open
   * (the fuller lines) it marks with CLOSED_ONLY / OPEN_ONLY.
   */
  summary: ReactNode
  /** Where it came from and when (source · time): shown while the module is open. */
  meta?: ReactNode
  /** Quick actions that work while the module is closed (Open thermal imaging, Pediatric shock research), in one dense row. */
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
      className="group/module @container/module min-w-0 scroll-mt-20 rounded-xl border border-line bg-surface shadow-card focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand lg:scroll-mt-0"
    >
      {/* One row: the number and the icon (both repeat what the title and the order on the page say), the title and its state chip on one
          line (the chip gives way first, never the title), and the Show/Hide icon button: 44px, drawn into the card's padding so the row
          itself is no taller than the icon. */}
      <div className="flex items-center gap-2 pt-2 pr-0.5 pl-2.5">
        <span aria-hidden="true" className="flex shrink-0 items-center gap-1 text-ink-muted">
          <span className="w-2.5 text-center text-xs font-semibold tabular-nums">{index ?? entry.n}</span>
          {/* Not in the narrowest rail (20rem, 1024 to 1279px), where the title and its chip need the room. */}
          <span className="flex size-7 items-center justify-center rounded-md bg-canvas lg:max-xl:hidden">
            <Icon className="size-4" />
          </span>
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
        <Button
          variant="ghost"
          className="-my-2 w-control shrink-0 px-0!"
          aria-label={`${open ? 'Hide' : 'Show'} ${title}`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
          icon={<ChevronDown aria-hidden="true" className={`size-5 transition-transform ${open ? 'rotate-180' : ''}`} />}
        />
      </div>
      {/* The summary reads the panel's own data: if it cannot be drawn, it says so here and the module opens on the full panel. Closed, it is
          at most two short lines; open, the summary's fuller lines and where the data came from (source · time) are shown above the panel. */}
      <PanelBoundary label={`The ${title.toLowerCase()} summary`} neutral onFault={reveal} className="flex flex-col gap-1.5 px-3 pt-1.5 pb-2.5">
        <div className="min-w-0 text-sm break-words tabular-nums">{summary}</div>
        {meta && <p className={`text-xs text-ink-muted ${OPEN_ONLY}`}>{meta}</p>}
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </PanelBoundary>
      {/* Hidden, never unmounted. The panel is part of this card: its own cards are drawn flat (a line above each, no box of their own), so
          nothing is a card inside a card. */}
      <div id={bodyId} hidden={!open} className="animate-rise-in">
        <CardFrameContext.Provider value="flat">
          <PanelBoundary label={`The ${title.toLowerCase()} panel`} onFault={reveal} className="space-y-0">
            <PanelFaultContext.Provider value={reveal}>{children}</PanelFaultContext.Provider>
          </PanelBoundary>
        </CardFrameContext.Provider>
      </div>
    </div>
  )
}
