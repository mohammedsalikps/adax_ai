/*
 * The doctor's consultation workspace (Doctor HERO): the parts of the page a jump can lead to, a tiny event bus that asks a collapsed module
 * to open, and the one way of bringing a part into view. JSX-free, so that what a jump does can be tested without a browser.
 */

/**
 * Every part of the consultation page that something leads to (the workflow strip, the Overview's "View", a status chip, an evidence item), as
 * the id of its element. The inputs rail, its five modules in order, the Mana area (the result, the first block that waits for the doctor, Ask
 * Mana), the note and the prescription.
 */
export const PART_IDS = [
  'consultation-inputs',
  'tools-conversation',
  'tools-history',
  'tools-devices',
  'tools-stethoscope',
  'tools-thermal',
  'mana-result',
  'mana-review',
  'mana-chat',
  'consultation-note',
  'rx',
] as const
export type PartId = (typeof PART_IDS)[number]

export const isPartId = (id: string): id is PartId => (PART_IDS as readonly string[]).includes(id)

/**
 * The five input modules of the rail, in the order a consultation uses them: the part each one is (`#tools-<key>`, kept from the tools column so
 * the chips, the Overview and the evidence still land there) and its test id. Module 3 keeps the part id `tools-devices`; its test id is
 * `module-vitals`.
 */
export const MODULES = [
  { n: 1, key: 'conversation', part: 'tools-conversation', testId: 'module-conversation' },
  { n: 2, key: 'history', part: 'tools-history', testId: 'module-history' },
  { n: 3, key: 'vitals', part: 'tools-devices', testId: 'module-vitals' },
  { n: 4, key: 'stethoscope', part: 'tools-stethoscope', testId: 'module-stethoscope' },
  { n: 5, key: 'thermal', part: 'tools-thermal', testId: 'module-thermal' },
] as const satisfies readonly { n: number; key: string; part: PartId; testId: string }[]
export type ModuleKey = (typeof MODULES)[number]['key']
export type ModulePart = (typeof MODULES)[number]['part']

export const isModulePart = (id: string): id is ModulePart => MODULES.some((m) => m.part === id)

/**
 * The final workspace (DESIGN §5.4): its five panels in the five-input order, as Alt+1 to Alt+5 go to them (lib/shortcuts.ts PANEL_NAMES).
 * Each keeps the part id its input already had, so the overview's evidence and every other jump still land on it: the live transcription is
 * `tools-conversation`, the clinical inputs `tools-devices`, the stethoscope (inside the clinical inputs) `tools-stethoscope`, the doctor
 * notes `consultation-note`, the thermal context `tools-thermal`. The patient history keeps `tools-history`. The Mana result and the
 * prescription (`mana-result`, `mana-review`, `rx`) are on the prescription page now, and Ask Mana (`mana-chat`) is the global Mana.
 */
export const WORKSPACE_PANELS = [
  { n: 1, key: 'transcription', part: 'tools-conversation' },
  { n: 2, key: 'inputs', part: 'tools-devices' },
  { n: 3, key: 'stethoscope', part: 'tools-stethoscope' },
  { n: 4, key: 'notes', part: 'consultation-note' },
  { n: 5, key: 'thermal', part: 'tools-thermal' },
] as const satisfies readonly { n: number; key: string; part: PartId }[]

/** The parts the workspace page no longer holds: where a jump to one goes instead (the prescription page, or the global Mana); null when on the page. */
export function elsewhereOf(id: PartId): 'prescription' | 'mana' | null {
  if (id === 'mana-chat') return 'mana'
  if (id === 'mana-result' || id === 'mana-review' || id === 'rx') return 'prescription'
  return null
}

/**
 * Parts that are a panel's own element, found by its test id rather than an id of the page's: the stethoscope is a group inside the clinical
 * inputs panel (another unit's component), which has no element id of its own.
 */
export const PART_SELECTORS: Partial<Record<PartId, string>> = { 'tools-stethoscope': '[data-testid="stethoscope-panel"]' }

/**
 * The page as `showPart` reads it, with PART_SELECTORS standing in for the parts that have no element id. Such a panel element is not focusable
 * by itself, so it is made a focus target (tabIndex -1: focus can be moved there, it is not a tab stop) and a jump moves focus to it.
 */
export function workspaceDocument(doc: Pick<Document, 'getElementById' | 'querySelector' | 'defaultView'> = document): PartDocument {
  return {
    getElementById: (id: string) => {
      const own = doc.getElementById(id)
      if (own) return own
      const sel = isPartId(id) ? PART_SELECTORS[id] : undefined
      const panel = sel ? doc.querySelector<HTMLElement>(sel) : null
      if (panel && !panel.hasAttribute('tabindex')) panel.tabIndex = -1
      return panel
    },
    get defaultView() {
      return doc.defaultView
    },
  }
}

// --- expand requests ------------------------------------------------------------------------------------------------------------------------

type ExpandListener = (id: PartId) => void
const expandListeners = new Set<ExpandListener>()

/**
 * Asks the part `id` to open (a module that is collapsed shows its full panel). Every listener hears every request and decides whether it is
 * meant; nothing is remembered, so a module mounted later is not opened by an old request. A part with no listener (the note, the result) is
 * simply not changed.
 */
export function expandPart(id: PartId): void {
  // A copy: a listener added while this request is delivered (a module mounting) does not hear it.
  for (const listener of Array.from(expandListeners)) listener(id)
}

/** Listens for `expandPart` requests (a module listens for its own part id). Returns the function that stops listening. */
export function onExpandPart(listener: ExpandListener): () => void {
  expandListeners.add(listener)
  return () => {
    expandListeners.delete(listener)
  }
}

// --- bringing a part into view --------------------------------------------------------------------------------------------------------------

/** What `showPart` needs of the page (the document by default; a stand-in in the tests). */
export interface PartDocument {
  getElementById(id: string): HTMLElement | null
  readonly defaultView: Pick<Window, 'matchMedia' | 'getComputedStyle'> | null
}

/** Overflow values with which an element is not a scroller of its own: the page then scrolls instead. */
const NOT_SCROLLING = new Set(['visible', 'clip'])

/**
 * Brings a part into view and moves focus there, so a keyboard or screen-reader user arrives with it. When the part is inside a column that
 * scrolls on its own (an ancestor marked `data-scroller` whose overflow scrolls: the inputs rail from 1024px), only that column moves, to put
 * the part at its top, and the page keeps its scroll position, so the note beside it stays where the doctor left it. Otherwise (one column, below
 * 1024px) the page scrolls. Focus goes to the element marked `data-part-focus="<id>"` inside the part when there is one (its heading), else to
 * the part itself (which then needs `tabIndex={-1}`); it never scrolls anything again. Reduced motion jumps instead of gliding. Returns false
 * when the part is not on the page.
 */
export function showPart(id: string, doc: PartDocument = document): boolean {
  const el = doc.getElementById(id)
  if (!el) return false
  const view = doc.defaultView
  const behavior: ScrollBehavior = view?.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  const scroller = el.closest<HTMLElement>('[data-scroller]')
  if (scroller && view && !NOT_SCROLLING.has(view.getComputedStyle(scroller).overflowY)) {
    scroller.scrollTo({ top: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 4, behavior })
  } else {
    el.scrollIntoView({ block: 'start', behavior })
  }
  // Ids here are the page's own (letters, digits and dashes); anything else is not built into a selector.
  const target = /^[\w-]+$/.test(id) ? el.querySelector<HTMLElement>(`[data-part-focus="${id}"]`) : null
  ;(target ?? el).focus({ preventScroll: true })
  return true
}

/**
 * Opens a part and brings it into view: what a jump to a module does (the Overview's "View", a status chip, the workflow strip). The request to
 * open is made first; the part's own top does not move when its body opens below it, so the scroll lands where it should.
 */
export function revealPart(id: PartId, doc?: PartDocument): boolean {
  expandPart(id)
  return showPart(id, doc)
}
