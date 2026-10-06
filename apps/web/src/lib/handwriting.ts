import { HANDWRITING_FORMAT_VERSION, HANDWRITING_LIMITS, HANDWRITING_PAGE, type HandwritingDocument, type HandwritingStroke } from '@adaxai/contracts'

/**
 * The digital pen's stroke model (DESIGN §5.4 "Doctor notes", spec §11), with no DOM: what is written (strokes in page units, pages), undo and
 * redo, the document that is saved, how a version conflict (or writing a closed pad could not save) is resolved without losing writing, the
 * smoothing the pad draws with, palm rejection, and the pad's words. Unit-tested in node (test/handwriting.test.ts); the canvas and pointer
 * handling are in components/pen/HandwritingPad.tsx.
 *
 * Nothing here reads or recognises the writing (spec F): the original strokes are the record.
 */

export type InkStroke = HandwritingStroke
export type InkInput = NonNullable<HandwritingStroke['input']>

/** The pad's inks: the design's own colours (ink, brand-strong, down), never new ones. */
export const INK_COLORS = [
  { value: '#0f172a', name: 'Black' },
  { value: '#1d4ed8', name: 'Blue' },
  { value: '#b91c1c', name: 'Red' },
] as const
/** Line widths in page units (a page is 1000 units wide, about 0.2 mm per unit on A4). */
export const INK_WIDTHS = [
  { value: 3, name: 'Fine' },
  { value: 6, name: 'Bold' },
] as const

/** A change that undo and redo can take back and do again. */
export type InkAction = { kind: 'add'; stroke: InkStroke } | { kind: 'clear'; page: number; removed: { index: number; stroke: InkStroke }[] } | { kind: 'page' }

/**
 * What is written in one consultation: the strokes (in the order they were written, each on its page) and the number of pages, with an undo
 * and a redo history. Strokes are never changed once added (undo removes the same object, redo puts it back), so a stroke's identity tells
 * which strokes the server already has (see `mergeAfterConflict`). `revision` changes with every change (the autosave compares it).
 */
export class InkModel {
  private list: InkStroke[]
  private pages: number
  private undoStack: InkAction[] = []
  private redoStack: InkAction[] = []
  private rev = 0

  constructor(doc?: Pick<HandwritingDocument, 'pageCount' | 'strokes'> | null) {
    this.list = doc ? [...doc.strokes] : []
    this.pages = pagesFor(this.list, Math.max(1, doc?.pageCount ?? 1))
  }

  get pageCount(): number {
    return this.pages
  }
  get strokeCount(): number {
    return this.list.length
  }
  get strokes(): readonly InkStroke[] {
    return this.list
  }
  get revision(): number {
    return this.rev
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }
  /** At the limit of strokes a document may hold: nothing more can be written. */
  get full(): boolean {
    return this.list.length >= HANDWRITING_LIMITS.maxStrokes
  }

  pageStrokes(page: number): InkStroke[] {
    return this.list.filter((s) => s.page === page)
  }

  /** Adds a finished stroke (false when the document is full or the stroke is on a page it does not have). Clears the redo history. */
  add(stroke: InkStroke): boolean {
    if (this.full || stroke.page < 0 || stroke.page >= this.pages || stroke.points.length < 3) return false
    this.list.push(stroke)
    this.done({ kind: 'add', stroke })
    return true
  }

  /** Removes every stroke of a page, as one change that undo brings back (nothing is asked first). False when the page is already empty. */
  clearPage(page: number): boolean {
    const removed = this.list.flatMap((stroke, index) => (stroke.page === page ? [{ index, stroke }] : []))
    if (!removed.length) return false
    this.list = this.list.filter((s) => s.page !== page)
    this.done({ kind: 'clear', page, removed })
    return true
  }

  /** Adds an empty page at the end; returns its index, or null at the page limit. */
  addPage(): number | null {
    if (this.pages >= HANDWRITING_LIMITS.maxPages) return null
    this.pages++
    this.done({ kind: 'page' })
    return this.pages - 1
  }

  /** Takes back the last change; returns the page it was on (the pad shows that page), or null when there is nothing to undo. */
  undo(): number | null {
    const a = this.undoStack.pop()
    if (!a) return null
    this.redoStack.push(a)
    this.rev++
    return this.revert(a)
  }

  /** Does the last undone change again; returns its page, or null when there is nothing to redo. */
  redo(): number | null {
    const a = this.redoStack.pop()
    if (!a) return null
    this.undoStack.push(a)
    this.rev++
    return this.apply(a)
  }

  /** The document that is saved: every stroke, in order, with the page count. */
  toDocument(): HandwritingDocument {
    return { format: HANDWRITING_FORMAT_VERSION, page: { ...HANDWRITING_PAGE }, pageCount: this.pages, strokes: [...this.list] }
  }

  private done(a: InkAction) {
    this.undoStack.push(a)
    this.redoStack = []
    this.rev++
  }

  private revert(a: InkAction): number {
    if (a.kind === 'add') {
      const i = this.list.lastIndexOf(a.stroke)
      if (i >= 0) this.list.splice(i, 1)
      return a.stroke.page
    }
    if (a.kind === 'clear') {
      // In the order they were removed, each back at its index: the list is exactly as it was before the clear.
      for (const { index, stroke } of a.removed) this.list.splice(index, 0, stroke)
      return a.page
    }
    this.pages--
    return this.pages - 1
  }

  private apply(a: InkAction): number {
    if (a.kind === 'add') {
      this.list.push(a.stroke)
      return a.stroke.page
    }
    if (a.kind === 'clear') {
      const gone = new Set(a.removed.map((r) => r.stroke))
      this.list = this.list.filter((s) => !gone.has(s))
      return a.page
    }
    this.pages++
    return this.pages - 1
  }
}

/** At least `min` pages, and enough for every stroke's page (a loop: thousands of strokes are never spread into one call). */
function pagesFor(strokes: readonly InkStroke[], min: number): number {
  let pages = min
  for (const s of strokes) if (s.page + 1 > pages) pages = s.page + 1
  return pages
}

/** The same stroke written twice (the same page, ink, width and points): used to keep a stroke once when two copies meet. */
export const strokeKey = (s: InkStroke): string => `${s.page}|${s.color}|${s.width}|${s.points.join(',')}`

/**
 * A save was refused because another screen saved a newer version (409): the result keeps everything. It is the server's latest document plus
 * every stroke written here since the version this screen started from (`base`, the strokes it loaded or last saved), except a stroke the
 * server already holds (a save that reached the server although its answer was lost). Strokes cleared here are not removed from the
 * server's version: writing is never lost by a merge. Pages: the larger count.
 */
export function mergeAfterConflict(server: Pick<HandwritingDocument, 'pageCount' | 'strokes'> | null, local: InkModel, base: ReadonlySet<InkStroke>): { document: HandwritingDocument; added: number } {
  const serverStrokes = server?.strokes ?? []
  const known = new Set(serverStrokes.map(strokeKey))
  const room = HANDWRITING_LIMITS.maxStrokes - serverStrokes.length
  const added = local.strokes.filter((s) => !base.has(s) && !known.has(strokeKey(s))).slice(0, Math.max(0, room))
  const pageCount = Math.min(HANDWRITING_LIMITS.maxPages, pagesFor(added, Math.max(1, server?.pageCount ?? 1, local.pageCount)))
  return { document: { format: HANDWRITING_FORMAT_VERSION, page: { ...HANDWRITING_PAGE }, pageCount, strokes: [...serverStrokes, ...added] }, added: added.length }
}

type Ink = Pick<HandwritingDocument, 'pageCount' | 'strokes'>

/** The same pages and the same strokes in the same order (no document is one empty page). */
export function sameInk(a: Ink | null, b: Ink | null): boolean {
  const as = a?.strokes ?? []
  const bs = b?.strokes ?? []
  return (a?.pageCount ?? 1) === (b?.pageCount ?? 1) && as.length === bs.length && as.every((s, i) => strokeKey(s) === strokeKey(bs[i]!))
}

/** Writing a pad could not save as it went away: the writing, the version it was written on, and that version's strokes as the pad held them. */
export interface LeftUnsaved {
  document: HandwritingDocument
  baseVersion: number
  base: ReadonlySet<InkStroke>
}

/**
 * Where the next pad of the consultation starts when the last one went away with writing it could not save (`left`). Nothing was saved
 * since that writing's version: the writing exactly as it was (a cleared page stays cleared). A newer version: that version plus every stroke
 * written there since its own version, as after a conflict (`conflict` when strokes from both are kept; none when the newer version is that
 * writing itself, stored although its answer was lost). `base` is what a later conflict is resolved against; `unsaved` when the result is not
 * the latest version, so the pad saves it.
 */
export function resumeUnsaved(latest: { version: number; document: Ink | null }, left: LeftUnsaved): { document: HandwritingDocument; base: ReadonlySet<InkStroke>; unsaved: boolean; conflict: boolean } {
  if (latest.version === left.baseVersion) return { document: left.document, base: left.base, unsaved: !sameInk(left.document, latest.document), conflict: false }
  const merged = mergeAfterConflict(latest.document, new InkModel(left.document), left.base)
  const unsaved = merged.added > 0 || merged.document.pageCount !== (latest.document?.pageCount ?? 1)
  return { document: merged.document, base: new Set(latest.document?.strokes ?? []), unsaved, conflict: merged.added > 0 }
}

// ---------------------------------------------------------------------------
// Palm rejection: what a touch does once a pen has been used.
// ---------------------------------------------------------------------------

/** After the pen lifts, a touch that comes down is still the resting hand for this long. */
export const PALM_GRACE_MS = 300

/**
 * Once a pen has been used on the pad a touch never writes, and a finger scrolls the page, but the hand resting on the pad while the pen
 * writes must never move the page under the pen (the stroke would be stored displaced). A touch that comes down while the pen writes, or
 * within PALM_GRACE_MS after it lifted, is ignored for its whole contact; a touch that was scrolling stops, for the rest of its contact, when
 * the pen comes down. No DOM: the pad passes the pointer's id, its clientY and the event's time.
 */
export class TouchScroller {
  private touch: { id: number; y: number } | null = null
  private penUpAt = Number.NEGATIVE_INFINITY

  /** A touch came down (`penWriting`: a pen stroke is being written). True when it scrolls the page. */
  down(pointerId: number, clientY: number, now: number, penWriting: boolean): boolean {
    if (penWriting || now - this.penUpAt < PALM_GRACE_MS) return false
    this.touch = { id: pointerId, y: clientY }
    return true
  }

  /** A pointer moved: how far to scroll the page (CSS pixels, positive is down), or null when it is not a scrolling touch. */
  move(pointerId: number, clientY: number): number | null {
    const t = this.touch
    if (!t || t.id !== pointerId) return null
    const dy = t.y - clientY
    t.y = clientY
    return dy
  }

  /** A pointer went up or was cancelled: true when it was the scrolling touch (it is then done). */
  end(pointerId: number): boolean {
    if (this.touch?.id !== pointerId) return false
    this.touch = null
    return true
  }

  /** A pen stroke started: a touch that was scrolling is the hand coming to rest. */
  penDown(): void {
    this.touch = null
  }

  /** The pen lifted (the event's time). */
  penUp(now: number): void {
    this.penUpAt = now
  }
}

// ---------------------------------------------------------------------------
// Points: page coordinates, pressure, density.
// ---------------------------------------------------------------------------

const round1 = (v: number) => Math.round(v * 10) / 10
const round2 = (v: number) => Math.round(v * 100) / 100
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)

/** A screen position (CSS pixels) as a page position: the page is HANDWRITING_PAGE.width units wide whatever the pad's width, kept on the page. */
export function toPagePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number }): { x: number; y: number } {
  const scale = rect.width > 0 ? HANDWRITING_PAGE.width / rect.width : 1
  return { x: round1(clamp((clientX - rect.left) * scale, 0, HANDWRITING_PAGE.width)), y: round1(clamp((clientY - rect.top) * scale, 0, HANDWRITING_PAGE.height)) }
}

/**
 * The pressure kept for a point: a pen's own (at least 0.05: some pens report 0 at first contact), 0.5 for touch and mouse (a finger's or a
 * mouse's "pressure" is not a pen's, so their lines keep one width).
 */
export function pointPressure(input: string, pressure: number): number {
  if (input !== 'pen') return 0.5
  return round2(clamp(pressure, 0.05, 1))
}

/** Points closer than this (page units) to the previous one add nothing visible: they are not kept. */
export const MIN_POINT_DISTANCE = 0.6

/**
 * Appends one point [x, y, pressure] to a stroke's flat list unless it is closer than MIN_POINT_DISTANCE to the last one (`force` keeps it
 * anyway: the point where the pen lifted). Returns whether it was kept.
 */
export function appendPoint(points: number[], x: number, y: number, pressure: number, force = false): boolean {
  const n = points.length
  if (n >= 3 && !force) {
    const dx = x - points[n - 3]!
    const dy = y - points[n - 2]!
    if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) return false
  }
  if (n >= 3 && force && x === points[n - 3] && y === points[n - 2]) return false
  points.push(x, y, pressure)
  return true
}

// ---------------------------------------------------------------------------
// Smoothing: quadratic curves through the midpoints.
// ---------------------------------------------------------------------------

/** One piece of a stroke: a quadratic curve from (x0, y0) through the control (cx, cy) to (x1, y1), drawn `w` wide. A dot when it has no length. */
export interface InkSegment {
  x0: number
  y0: number
  cx: number
  cy: number
  x1: number
  y1: number
  w: number
}

/** The drawn width at a pressure: the line's width at 0.5 (touch, mouse), half of it at no pressure, one and a half at full pressure. */
export const pressureWidth = (width: number, pressure: number): number => width * (0.5 + clamp(pressure, 0, 1))

/** How many segments a stroke of `n` points has: while it is drawn (`final` false) the last piece waits for the next point. */
export function segmentCount(n: number, final: boolean): number {
  if (n <= 0) return 0
  if (final) return n === 1 ? 1 : n
  return n - 1
}

/**
 * The smoothed segments of a stroke (flat [x, y, pressure, ...] points), from segment `from`. With points P0..Pn-1 and Mi the midpoint of Pi
 * and Pi+1: a line P0 → M0, then curves Mi-1 → (control Pi) → Mi, and when the stroke is finished a line Mn-2 → Pn-1. A finished stroke of
 * one point is a dot. A segment depends only on the points up to the one after its control, so while the pen moves the segments already
 * drawn never change: the pad draws only the new ones.
 */
export function strokeSegments(points: ArrayLike<number>, width: number, final: boolean, from = 0): InkSegment[] {
  const n = Math.floor(points.length / 3)
  const count = segmentCount(n, final)
  const P = (i: number) => ({ x: points[i * 3]!, y: points[i * 3 + 1]!, p: points[i * 3 + 2]! })
  const mid = (i: number) => {
    const a = P(i)
    const b = P(i + 1)
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, p: number): InkSegment => ({ x0: a.x, y0: a.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x1: b.x, y1: b.y, w: pressureWidth(width, p) })
  const out: InkSegment[] = []
  for (let k = Math.max(0, from); k < count; k++) {
    if (n === 1) {
      const a = P(0)
      out.push({ x0: a.x, y0: a.y, cx: a.x, cy: a.y, x1: a.x, y1: a.y, w: pressureWidth(width, a.p) })
    } else if (k === 0) out.push(line(P(0), mid(0), P(0).p))
    else if (k <= n - 2) {
      const c = P(k)
      const a = mid(k - 1)
      const b = mid(k)
      out.push({ x0: a.x, y0: a.y, cx: c.x, cy: c.y, x1: b.x, y1: b.y, w: pressureWidth(width, c.p) })
    } else out.push(line(mid(n - 2), P(n - 1), P(n - 1).p))
  }
  return out
}

// ---------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The pad's text alternative: "Handwritten notes, 2 pages, 34 strokes". */
export function handwritingSummary(pageCount: number, strokeCount: number): string {
  return `Handwritten notes, ${plural(Math.max(1, pageCount), 'page', 'pages')}, ${plural(strokeCount, 'stroke', 'strokes')}`
}

export type PadSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'blocked'

/** The save state as the pad says it: 'Saved', 'Saving…' (also while the autosave waits for the doctor to pause), 'Not saved — retry'. */
export function saveStateText(state: PadSaveState): string {
  switch (state) {
    case 'pending':
    case 'saving':
      return 'Saving…'
    case 'saved':
      return 'Saved'
    case 'error':
      return 'Not saved — retry'
    case 'blocked':
      return 'Not saved'
    default:
      return ''
  }
}

/** Waits before an automatic retry of a failed save: 2 s, 5 s, 15 s, then every 30 s. */
export function retryDelayMs(attempt: number): number {
  return [2_000, 5_000, 15_000][attempt] ?? 30_000
}

// ---------------------------------------------------------------------------
// The autosave scheduler.
// ---------------------------------------------------------------------------

export interface SaveTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
  now: () => number
}

const realTimers: SaveTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now() }

export interface SaveScheduler {
  /** Something changed: save `delayMs` after the last change (but no later than `maxWaitMs` after the first unsaved one), or after `ms`. */
  touch: (ms?: number) => void
  /** Save now (a save already running is followed by one more). Resolves when the saving is done. */
  flush: () => Promise<void>
  /** Stops a waiting save (the one running finishes). */
  cancel: () => void
  /** Resolves when no save is running (starts none). */
  idle: () => Promise<void>
  readonly waiting: boolean
  readonly running: boolean
}

/**
 * Debounced autosave that never runs two saves at once: `run` saves whatever is unsaved when it is called (and returns quickly when nothing
 * is). A change while a save runs makes one more run after it. Timers are injected for the unit tests.
 */
export function createSaveScheduler(opts: { delayMs: number; maxWaitMs?: number; run: () => Promise<void>; timers?: SaveTimers }): SaveScheduler {
  const t = opts.timers ?? realTimers
  let timer: unknown = null
  let firstChangeAt: number | null = null
  let current: Promise<void> | null = null
  let again = false

  const stopTimer = () => {
    if (timer !== null) t.clear(timer)
    timer = null
  }
  const fire = (): Promise<void> => {
    stopTimer()
    if (current) {
      again = true
      return current
    }
    firstChangeAt = null
    current = (async () => {
      try {
        await opts.run()
      } catch {
        // `run` reports its own failures (the pad shows them and asks for a retry); the scheduler only keeps the order.
      }
    })().finally(() => {
      current = null
      if (again) {
        again = false
        void fire()
      }
    })
    return current
  }

  return {
    touch(ms) {
      const now = t.now()
      firstChangeAt ??= now
      let wait = ms ?? opts.delayMs
      if (ms === undefined && opts.maxWaitMs !== undefined) wait = Math.max(0, Math.min(wait, firstChangeAt + opts.maxWaitMs - now))
      stopTimer()
      timer = t.set(() => {
        timer = null
        void fire()
      }, wait)
    },
    async flush() {
      await fire()
      // A run that was asked for while another one was going: wait for it too.
      while (current) await current
    },
    async idle() {
      while (current) await current
    },
    cancel() {
      stopTimer()
      firstChangeAt = null
      again = false
    },
    get waiting() {
      return timer !== null
    },
    get running() {
      return current !== null
    },
  }
}
