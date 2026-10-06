import { HANDWRITING_LIMITS, HANDWRITING_PAGE, HANDWRITING_VERSION_CONFLICT, type HandwritingDocument, type HandwritingLatest, type Me } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Eraser, FilePlus2, LoaderCircle, type LucideIcon, PenLine, Redo2, Undo2 } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { ApiError } from '../../lib/api.ts'
import { useStillSamePerson } from '../../lib/auth.tsx'
import {
  appendPoint,
  createSaveScheduler,
  handwritingSummary,
  INK_COLORS,
  INK_WIDTHS,
  type InkInput,
  InkModel,
  type InkSegment,
  type InkStroke,
  mergeAfterConflict,
  type PadSaveState,
  pointPressure,
  resumeUnsaved,
  retryDelayMs,
  saveStateText,
  strokeSegments,
  TouchScroller,
  toPagePoint,
} from '../../lib/handwriting.ts'
import {
  fetchHandwriting,
  fetchLatestHandwriting,
  handwritingQueryKey,
  keepUnsavedHandwriting,
  saveHandwriting,
  sendHandwritingOnExit,
  takeUnsavedHandwriting,
  trackHandwritingExit,
} from '../../lib/handwritingApi.ts'
import { ME_KEY } from '../../lib/session.ts'
import { HeroEmpty } from '../hero/HeroEmpty.tsx'
import { Button } from '../ui/Button.tsx'

/** Props of the doctor's handwriting pad (DESIGN §5.4 "Doctor notes" → Pen tab, §7). */
export interface HandwritingPadProps {
  encounterId: string
  /** The consultation's patient (part of the contract; the server takes the patient from the consultation). */
  patientId: string
  /** A signed consultation (or another reader): the strokes are shown, nothing can be written. */
  readOnly?: boolean
  className?: string
}

/** Autosave: this long after the last stroke, and at the latest this long after the first unsaved one (continuous writing still saves). */
const SAVE_DELAY_MS = 1_500
const SAVE_MAX_WAIT_MS = 10_000
/** Device pixels per canvas at most (a tall page on a dense screen would otherwise need hundreds of megabytes). */
const MAX_CANVAS_PIXELS = 8_000_000
/** The paper: the surface colour, with ruled lines in the line colour every RULE_GAP page units (design tokens, no new colours). */
const PAPER = '#ffffff'
const RULE = '#e3e8ef'
const RULE_GAP = 50
const RULE_TOP = 100

const CONFLICT_NOTICE = 'These notes were also changed on another screen. Both versions are kept.'
const CLOSED_NOTICE = 'This consultation can no longer be changed, so the latest writing was not saved. It is still shown here.'
const LEFT_CLOSED_NOTICE = 'The last writing on this pad was not saved before the consultation closed, so it is not part of the record.'
const FULL_NOTICE = `This pad is full (${HANDWRITING_LIMITS.maxStrokes.toLocaleString('en')} strokes). Continue in the typed note.`

interface Active {
  pointerId: number
  input: InkInput
  color: string
  width: number
  page: number
  points: number[]
  /** Segments already drawn on the live layer. */
  drawn: number
  dot: boolean
}

/**
 * The digital pen pad of a consultation (spec §11, DESIGN §5.4): writing with a stylus, pen, finger or mouse on pages of the HANDWRITING_PAGE
 * coordinate system scaled to the panel's width. Pointer Events with pressure and coalesced points; the stroke being written is drawn in
 * animation frames on a live layer with quadratic smoothing, finished strokes on a committed layer (no React state per point); both layers
 * follow the device pixel ratio. Once a pen has been used, touch never writes (the hand may rest on the pad) and a finger scrolls the page,
 * but never while the pen writes or has just lifted (lib/handwriting.ts TouchScroller: the page never moves under the pen).
 * Undo, redo (Ctrl+Z, Ctrl+Shift+Z), clear page (undoable, asks nothing), pages, and autosave as a new version ~1.5 s after the last stroke,
 * when the page is hidden and when the pad goes away. A save that meets a newer version from another screen reloads it and keeps both. The
 * next pad of the consultation opens after the last save of the one that went away, and saves what that one could not (lib/handwritingApi.ts).
 * Read-only for a signed record or another reader. Nothing reads or recognises the writing: the original strokes are the record.
 */
export function HandwritingPad(props: HandwritingPadProps) {
  // Another consultation is another pad: nothing of one is ever kept for the next.
  return <Pad key={props.encounterId} {...props} />
}

function Pad({ encounterId, readOnly = false, className = '' }: HandwritingPadProps) {
  const queryClient = useQueryClient()
  const key = handwritingQueryKey(encounterId)
  // Always the latest version when the pad opens (a version saved as the pad last closed may not be in the cache yet).
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => fetchHandwriting(encounterId, signal), refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity })
  const { mutateAsync } = useMutation({ mutationFn: (v: { doc: HandwritingDocument; expected: number; json: string }) => saveHandwriting(encounterId, v.doc, v.expected, v.json) })
  const mutateRef = useRef(mutateAsync)
  mutateRef.current = mutateAsync
  // Who opened the pad: writing is saved on the way out, or kept for the next pad, only while it is still them.
  const stillSamePerson = useStillSamePerson()
  const writerRef = useRef(queryClient.getQueryData<Me | null>(ME_KEY)?.id ?? null)

  const modelRef = useRef<InkModel | null>(null)
  /** The version this screen started from and the strokes it holds (by identity): what a conflict is resolved against. */
  const baseRef = useRef<{ version: number; strokes: ReadonlySet<InkStroke> }>({ version: 0, strokes: new Set() })
  const savedRevRef = useRef(0)
  const attemptsRef = useRef(0)
  const blockedRef = useRef(false)
  const aliveRef = useRef(true)
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  const [page, setPage] = useState(0)
  const [penOn, setPenOn] = useState(true)
  const [color, setColor] = useState<string>(INK_COLORS[0].value)
  const [width, setWidth] = useState<number>(INK_WIDTHS[0].value)
  const [save, setSave] = useState<PadSaveState>('idle')
  const [blocked, setBlocked] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const pageRef = useRef(0)
  const penOnRef = useRef(true)
  const colorRef = useRef<string>(INK_COLORS[0].value)
  const widthRef = useRef<number>(INK_WIDTHS[0].value)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const baseCanvasRef = useRef<HTMLCanvasElement>(null)
  const liveCanvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ cssW: 0, dpr: 1 })
  const activeRef = useRef<Active | null>(null)
  const penSeenRef = useRef(false)
  const frameRef = useRef<number | null>(null)

  const data = query.data
  const ready = query.isFetchedAfterMount && !!data
  const model = modelRef.current
  const editable = !readOnly && !!model && !!data && !data.readOnly && !blocked

  // ---- Drawing -------------------------------------------------------------------------------------------------------------------------

  function redrawBase() {
    const ctx = baseCanvasRef.current?.getContext('2d', { alpha: false })
    const { cssW, dpr } = sizeRef.current
    if (!ctx || !cssW) return
    prepare(ctx, cssW, dpr)
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, HANDWRITING_PAGE.width, HANDWRITING_PAGE.height)
    ctx.strokeStyle = RULE
    ctx.lineWidth = HANDWRITING_PAGE.width / cssW
    ctx.beginPath()
    for (let y = RULE_TOP; y < HANDWRITING_PAGE.height; y += RULE_GAP) {
      ctx.moveTo(0, y)
      ctx.lineTo(HANDWRITING_PAGE.width, y)
    }
    ctx.stroke()
    for (const s of modelRef.current?.pageStrokes(pageRef.current) ?? []) drawSegments(ctx, strokeSegments(s.points, s.width, true), s.color)
  }

  function clearLive() {
    const c = liveCanvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
  }

  /** Draws what is new of the stroke being written (the live layer is never cleared while it is written). */
  function drawLive(from: 'new' | 'all') {
    const a = activeRef.current
    const ctx = liveCanvasRef.current?.getContext('2d')
    const { cssW, dpr } = sizeRef.current
    if (!a || !ctx || !cssW) return
    if (from === 'all') {
      clearLive()
      a.drawn = 0
      a.dot = false
    }
    prepare(ctx, cssW, dpr)
    const n = a.points.length / 3
    if (n === 1 && !a.dot) {
      // The pen touched: show it at once (the final stroke covers this dot exactly).
      drawSegments(ctx, strokeSegments(a.points, a.width, true), a.color)
      a.dot = true
    }
    const segs = strokeSegments(a.points, a.width, false, a.drawn)
    drawSegments(ctx, segs, a.color)
    a.drawn += segs.length
  }

  function requestFrame() {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      drawLive('new')
    })
  }

  function stopFrame() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }

  // ---- Changes ---------------------------------------------------------------------------------------------------------------------------

  function changed() {
    rerender()
    setSave('pending')
    scheduler.touch()
  }

  function goToPage(p: number) {
    const last = (modelRef.current?.pageCount ?? 1) - 1
    const next = Math.max(0, Math.min(p, last))
    pageRef.current = next
    setPage(next)
    redrawBase()
  }

  /** Ends the stroke being written: it becomes part of the notes (drawn on the committed layer) unless `keep` is false (a resting hand). */
  function finish(keep: boolean) {
    const a = activeRef.current
    activeRef.current = null
    stopFrame()
    clearLive()
    const m = modelRef.current
    if (!a || !m || !keep || a.points.length < 3) return
    const stroke: InkStroke = { page: a.page, width: a.width, color: a.color, input: a.input, points: a.points }
    if (!m.add(stroke)) {
      setNotice(FULL_NOTICE)
      return
    }
    if (a.page === pageRef.current) {
      const ctx = baseCanvasRef.current?.getContext('2d', { alpha: false })
      const { cssW, dpr } = sizeRef.current
      if (ctx && cssW) {
        prepare(ctx, cssW, dpr)
        drawSegments(ctx, strokeSegments(stroke.points, stroke.width, true), stroke.color)
      }
    }
    changed()
  }

  function undo() {
    const m = modelRef.current
    if (!editable || !m || activeRef.current) return
    const p = m.undo()
    if (p === null) return
    goToPage(p)
    changed()
  }

  function redo() {
    const m = modelRef.current
    if (!editable || !m || activeRef.current) return
    const p = m.redo()
    if (p === null) return
    goToPage(p)
    changed()
  }

  function clearPage() {
    const m = modelRef.current
    if (!editable || !m || activeRef.current || !m.clearPage(pageRef.current)) return
    redrawBase()
    changed()
  }

  function newPage() {
    const m = modelRef.current
    if (!editable || !m || activeRef.current) return
    const p = m.addPage()
    if (p === null) return
    goToPage(p)
    changed()
  }

  // ---- Saving ----------------------------------------------------------------------------------------------------------------------------

  function block(message: string) {
    blockedRef.current = true
    setBlocked(true)
    setSave('blocked')
    setNotice(message)
    scheduler.cancel()
  }

  function retryLater() {
    setSave('error')
    scheduler.touch(retryDelayMs(attemptsRef.current++))
  }

  async function runSave() {
    const m = modelRef.current
    if (!m || blockedRef.current || !aliveRef.current) return
    if (m.revision === savedRevRef.current) {
      setSave((s) => (s === 'pending' || s === 'saving' || s === 'error' ? 'saved' : s))
      return
    }
    const doc = m.toDocument()
    const rev = m.revision
    const json = JSON.stringify(doc)
    if (json.length > HANDWRITING_LIMITS.maxFileBytes) {
      block(`These notes are too large to save (more than ${HANDWRITING_LIMITS.maxFileBytes / (1024 * 1024)} MB). Continue in the typed note.`)
      return
    }
    setSave('saving')
    try {
      const saved = await mutateRef.current({ doc, expected: baseRef.current.version, json })
      baseRef.current = { version: saved.version, strokes: new Set(doc.strokes) }
      if (modelRef.current === m) savedRevRef.current = rev
      attemptsRef.current = 0
      setSave(modelRef.current === m && m.revision === rev ? 'saved' : 'pending')
      queryClient.setQueryData<HandwritingLatest>(key, (old) =>
        old ? { ...old, version: saved.version, strokeCount: saved.strokeCount, pageCount: saved.pageCount, document: doc, savedAt: saved.savedAt, strokesFileId: saved.strokesFileId ?? old.strokesFileId, savedByName: saved.savedByName ?? old.savedByName } : old,
      )
    } catch (err) {
      if (!aliveRef.current) return
      if (err instanceof ApiError && err.code === HANDWRITING_VERSION_CONFLICT) return reconcile()
      if (err instanceof ApiError && isClosed(err)) return block(CLOSED_NOTICE)
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) return block(`The notes were not saved: ${err.message}`)
      retryLater()
    }
  }

  /** Another screen saved a newer version: load it, keep what was written here since this screen's version, and save the result. */
  async function reconcile() {
    try {
      // The latest as it is now (not after this pad's own last save: a reconcile can be what that save is waiting for).
      const latest = await fetchLatestHandwriting(encounterId)
      if (!aliveRef.current) return
      if (latest.readOnly) return block(CLOSED_NOTICE)
      const local = modelRef.current
      if (!local) return
      const merged = mergeAfterConflict(latest.document, local, baseRef.current.strokes)
      const next = new InkModel(merged.document)
      modelRef.current = next
      baseRef.current = { version: latest.version, strokes: new Set(latest.document?.strokes ?? []) }
      const differs = merged.added > 0 || merged.document.pageCount !== (latest.document?.pageCount ?? 1)
      savedRevRef.current = differs ? -1 : next.revision
      queryClient.setQueryData(key, latest)
      setNotice(CONFLICT_NOTICE)
      goToPage(pageRef.current)
      rerender()
      if (differs) {
        setSave('pending')
        scheduler.touch(0)
      } else setSave('saved')
    } catch {
      if (aliveRef.current) retryLater()
    }
  }

  const schedulerRef = useRef<ReturnType<typeof createSaveScheduler> | null>(null)
  const runSaveRef = useRef(runSave)
  runSaveRef.current = runSave
  schedulerRef.current ??= createSaveScheduler({ delayMs: SAVE_DELAY_MS, maxWaitMs: SAVE_MAX_WAIT_MS, run: () => runSaveRef.current() })
  const scheduler = schedulerRef.current

  /**
   * The last save as the pad goes away, after a save in flight (so it starts from the version that one stores). What it cannot store is kept
   * in memory for the next pad of this consultation, which saves it; nothing goes out, and nothing is kept, once another person is signed in.
   */
  async function saveOnExit(): Promise<void> {
    await scheduler.idle()
    const m = modelRef.current
    if (!m || blockedRef.current || m.revision === savedRevRef.current || !stillSamePerson()) return
    const document = m.toDocument()
    const { version, strokes } = baseRef.current
    const result = await sendHandwritingOnExit(encounterId, document, version)
    // Stored (the next pad reads it), or the session ended (nothing of it is kept for whoever signs in next).
    if (result.ok || result.status === 401) return
    const writer = writerRef.current
    if (writer && stillSamePerson()) keepUnsavedHandwriting(encounterId, { userId: writer, document, baseVersion: version, base: strokes })
  }

  // ---- Effects ---------------------------------------------------------------------------------------------------------------------------

  // The first answer read after the pad opened is what it starts from (later answers are this pad's own saves), with any writing the last
  // pad of this consultation could not save: restored and saved now (or, when the consultation has closed, the doctor is told).
  useEffect(() => {
    if (!ready || modelRef.current || !data) return
    const closed = data.readOnly
    // A view-only pad of a consultation still open leaves that writing to the editable pad.
    const left = readOnly && !closed ? null : takeUnsavedHandwriting(encounterId, writerRef.current)
    const resumed = left && !closed && !readOnly ? resumeUnsaved(data, left) : null
    if (left && !resumed) setNotice(LEFT_CLOSED_NOTICE)
    if (resumed?.conflict) setNotice(CONFLICT_NOTICE)
    modelRef.current = new InkModel(resumed ? resumed.document : data.document)
    baseRef.current = { version: data.version, strokes: resumed ? resumed.base : new Set(data.document?.strokes ?? []) }
    const unsaved = !!resumed?.unsaved
    savedRevRef.current = unsaved ? -1 : modelRef.current.revision
    setSave(unsaved ? 'pending' : data.version > 0 ? 'saved' : 'idle')
    goToPage(0)
    rerender()
    if (unsaved) scheduler.touch(0)
  }, [ready])

  // Canvas size: the page's width is the panel's; both layers follow the device pixel ratio (capped for very dense, very large screens).
  const hasSurface = !!model && !(data && data.version === 0 && (readOnly || data.readOnly))
  useLayoutEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const apply = () => {
      const cssW = el.clientWidth
      if (!cssW) return
      const cssH = (cssW * HANDWRITING_PAGE.height) / HANDWRITING_PAGE.width
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH))))
      sizeRef.current = { cssW, dpr }
      for (const c of [baseCanvasRef.current, liveCanvasRef.current]) {
        if (!c) continue
        c.width = Math.round(cssW * dpr)
        c.height = Math.round(cssH * dpr)
      }
      redrawBase()
      drawLive('all')
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasSurface])

  // Pointer input on the live layer (native listeners: coalesced points, capture, no React work per point).
  useEffect(() => {
    const canvas = liveCanvasRef.current
    if (!canvas || !editable) return
    const inputOf = (e: PointerEvent): InkInput => (e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse')
    const scroller = new TouchScroller()
    let scrollEl: Element | null = null
    const addPoints = (stroke: Active, e: PointerEvent, last: boolean) => {
      const rect = canvas.getBoundingClientRect()
      const list = !last && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
      let a = stroke
      for (const ev of list.length ? list : [e]) {
        const p = toPagePoint(ev.clientX, ev.clientY, rect)
        appendPoint(a.points, p.x, p.y, pointPressure(a.input, ev.pressure), last)
        if (a.points.length >= HANDWRITING_LIMITS.maxPointsPerStroke * 3) {
          // A very long stroke goes on as a new one from the same point.
          const tail = a.points.slice(-3)
          finish(true)
          if (modelRef.current?.full) return
          a = { ...a, points: tail, drawn: 0, dot: true }
          activeRef.current = a
        }
      }
    }
    const down = (e: PointerEvent) => {
      const input = inputOf(e)
      if (input === 'pen') penSeenRef.current = true
      if (!penOnRef.current) return
      if (input === 'touch' && penSeenRef.current) {
        // A pen is in use: a finger (or the resting hand) does not write; it scrolls the page, except the hand that comes to rest while the
        // pen writes or has just lifted, which is ignored (the page must not move under the pen).
        if (scroller.down(e.pointerId, e.clientY, e.timeStamp, activeRef.current?.input === 'pen')) scrollEl = scrollParent(canvas)
        return
      }
      if (input === 'mouse' && e.button !== 0) return
      // A pen's eraser end (or eraser button) never writes ink; the pad has no eraser (Undo and Clear page take writing back).
      if (input === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0)) return
      const current = activeRef.current
      if (current) {
        // The hand touched before the pen: what the hand drew is not writing.
        if (current.input === 'touch' && input === 'pen') finish(false)
        else return
      }
      if (modelRef.current?.full) {
        setNotice(FULL_NOTICE)
        return
      }
      e.preventDefault()
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // A pointer that is already gone: the stroke still ends on pointerup or pointercancel.
      }
      surfaceRef.current?.focus({ preventScroll: true })
      // A finger that was scrolling when the pen came down is the hand coming to rest: it scrolls no more.
      if (input === 'pen') scroller.penDown()
      const a: Active = { pointerId: e.pointerId, input, color: colorRef.current, width: widthRef.current, page: pageRef.current, points: [], drawn: 0, dot: false }
      activeRef.current = a
      addPoints(a, e, false)
      requestFrame()
    }
    const move = (e: PointerEvent) => {
      const dy = scroller.move(e.pointerId, e.clientY)
      if (dy !== null) {
        if (dy && scrollEl) scrollEl.scrollBy(0, dy)
        return
      }
      const a = activeRef.current
      if (!a || a.pointerId !== e.pointerId) return
      addPoints(a, e, false)
      requestFrame()
    }
    const up = (e: PointerEvent) => {
      if (scroller.end(e.pointerId)) return
      const a = activeRef.current
      if (!a || a.pointerId !== e.pointerId) return
      addPoints(a, e, true)
      if (a.input === 'pen') scroller.penUp(e.timeStamp)
      finish(true)
    }
    const cancel = (e: PointerEvent) => {
      if (scroller.end(e.pointerId)) return
      const a = activeRef.current
      if (!a || a.pointerId !== e.pointerId) return
      if (a.input === 'pen') scroller.penUp(e.timeStamp)
      // The browser took the pointer away: keep what was written, unless it was a touch while a pen is in use.
      finish(!(a.input === 'touch' && penSeenRef.current))
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', cancel)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', cancel)
      if (activeRef.current) finish(true)
    }
  }, [editable])

  // Saving when the page is hidden (an ordinary request), when it closes (a request that outlives the page), and when the pad goes away (the
  // next pad of this consultation reads the notes after that save, and saves what it could not store).
  useEffect(() => {
    aliveRef.current = true
    const unsaved = () => {
      const m = modelRef.current
      return m && !blockedRef.current && m.revision !== savedRevRef.current ? m : null
    }
    const onPageHide = () => {
      const m = unsaved()
      if (m && stillSamePerson()) void sendHandwritingOnExit(encounterId, m.toDocument(), baseRef.current.version)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && unsaved()) void scheduler.flush()
    }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      aliveRef.current = false
      scheduler.cancel()
      void trackHandwritingExit(encounterId, saveOnExit())
    }
  }, [])

  // ---- View ------------------------------------------------------------------------------------------------------------------------------

  function togglePen() {
    penOnRef.current = !penOn
    setPenOn(!penOn)
  }
  function chooseColor(value: string) {
    colorRef.current = value
    setColor(value)
  }
  function chooseWidth(value: number) {
    widthRef.current = value
    setWidth(value)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!editable || !(e.ctrlKey || e.metaKey) || e.altKey) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault()
      redo()
    }
  }

  if (query.isError && !model) {
    return (
      <div role="group" aria-label="Handwriting pad" data-testid="handwriting-pad" className={className}>
        <HeroEmpty action={<Button size="sm" variant="secondary" onClick={() => void query.refetch()}>Try again</Button>}>Handwritten notes could not be loaded.</HeroEmpty>
      </div>
    )
  }
  if (model && data && data.version === 0 && (readOnly || data.readOnly) && model.strokeCount === 0) {
    return (
      <div role="group" aria-label="Handwriting pad" data-testid="handwriting-pad" className={className}>
        <HeroEmpty>No handwritten notes were saved for this consultation.</HeroEmpty>
        {notice && (
          <p className="mt-2 text-sm text-ink-muted" data-testid="handwriting-notice">
            {notice}
          </p>
        )}
      </div>
    )
  }

  const pageCount = model?.pageCount ?? 1
  const shownPage = Math.min(page, pageCount - 1)
  const pageHasInk = !!model?.strokes.some((s) => s.page === shownPage)
  const writing = editable && penOn
  return (
    <div role="group" aria-label="Handwriting pad" aria-busy={!model || undefined} data-testid="handwriting-pad" onKeyDown={onKeyDown} className={`min-w-0 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {editable && (
          <div role="group" aria-label="Pen tools" className="flex flex-wrap items-center gap-0.5">
            <ToolButton icon={PenLine} label="Pen" pressed={penOn} title={penOn ? 'Pen: on (turn off to scroll with a finger)' : 'Pen: off'} onClick={togglePen} />
            <div role="group" aria-label="Ink colour" className="flex items-center">
              {INK_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  aria-label={`${c.name} ink`}
                  aria-pressed={color === c.value}
                  title={`${c.name} ink`}
                  onClick={() => chooseColor(c.value)}
                  className="group inline-flex size-11 items-center justify-center rounded-md transition-colors hover:bg-canvas"
                >
                  <span aria-hidden="true" className="size-4 rounded-full ring-offset-2 ring-offset-surface group-aria-pressed:ring-2 group-aria-pressed:ring-brand" style={{ backgroundColor: c.value }} />
                </button>
              ))}
            </div>
            <div role="group" aria-label="Line width" className="flex items-center">
              {INK_WIDTHS.map((w) => (
                <button
                  key={w.value}
                  type="button"
                  aria-pressed={width === w.value}
                  onClick={() => chooseWidth(w.value)}
                  className="inline-flex min-h-11 items-center rounded-md px-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-ink aria-pressed:bg-brand-soft aria-pressed:text-brand-strong"
                >
                  {w.name}
                </button>
              ))}
            </div>
            <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />
            <ToolButton icon={Undo2} label="Undo" title="Undo (Ctrl+Z)" shortcut="Control+Z Meta+Z" disabled={!model?.canUndo} onClick={undo} />
            <ToolButton icon={Redo2} label="Redo" title="Redo (Ctrl+Shift+Z)" shortcut="Control+Shift+Z Meta+Shift+Z" disabled={!model?.canRedo} onClick={redo} />
            <ToolButton icon={Eraser} label="Clear page" title="Clear this page (Undo brings it back)" disabled={!pageHasInk} onClick={clearPage} />
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1">
          <div role="group" aria-label="Pages" className="flex items-center">
            <ToolButton icon={ChevronLeft} label="Previous page" disabled={shownPage === 0} onClick={() => goToPage(shownPage - 1)} />
            <span className="min-w-[5.5rem] text-center text-sm text-ink-muted tabular-nums" data-testid="handwriting-page">
              Page {shownPage + 1} of {pageCount}
            </span>
            <ToolButton icon={ChevronRight} label="Next page" disabled={shownPage >= pageCount - 1} onClick={() => goToPage(shownPage + 1)} />
          </div>
          {editable && (
            <Button variant="secondary" size="md" icon={<FilePlus2 aria-hidden="true" className="size-4" />} disabled={pageCount >= HANDWRITING_LIMITS.maxPages} onClick={newPage}>
              New page
            </Button>
          )}
        </div>
      </div>
      {/* One status line, its height kept so nothing moves when the save state changes. */}
      <div className="mb-2 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
        <SaveStatus state={editable || save === 'blocked' ? save : 'idle'} onRetry={() => void scheduler.flush()} />
        {notice && (
          <p className="text-sm text-ink-muted" data-testid="handwriting-notice">
            {notice}
          </p>
        )}
        {!editable && !notice && model && data && data.version > 0 && (
          <p className="text-xs text-ink-muted">
            {readOnly || data.readOnly ? 'View only · ' : ''}Saved{data.savedByName ? ` by ${data.savedByName}` : ''} · kept as written, not read or converted to text
          </p>
        )}
      </div>
      <p role="status" className="sr-only">
        {save === 'error' ? 'Handwritten notes not saved. Retrying.' : (notice ?? '')}
      </p>
      <div
        ref={surfaceRef}
        tabIndex={-1}
        role="img"
        aria-label={model ? handwritingSummary(model.pageCount, model.strokeCount) : 'Handwritten notes, loading'}
        data-testid="handwriting-surface"
        className={`relative w-full overflow-hidden rounded-lg border border-line bg-surface outline-none select-none ${!model ? 'motion-safe:animate-pulse' : ''}`}
        style={{ aspectRatio: `${HANDWRITING_PAGE.width} / ${HANDWRITING_PAGE.height}` }}
      >
        <canvas ref={baseCanvasRef} aria-hidden="true" className="absolute inset-0 size-full" />
        <canvas ref={liveCanvasRef} aria-hidden="true" className={`absolute inset-0 size-full ${writing ? 'cursor-crosshair' : ''}`} style={{ touchAction: writing ? 'none' : 'auto' }} />
      </div>
    </div>
  )
}

/**
 * A 44px icon button of the pad's toolbar. Unavailable is `aria-disabled`, not `disabled`: a button that becomes unavailable while it has
 * focus (Undo after the last undo, Previous page on the first page) keeps the focus, so the keyboard shortcuts still reach the pad.
 */
function ToolButton({ icon: Icon, label, title, pressed, shortcut, disabled, onClick }: { icon: LucideIcon; label: string; title?: string; pressed?: boolean; shortcut?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      aria-disabled={disabled || undefined}
      title={title ?? label}
      onClick={disabled ? undefined : onClick}
      icon={<Icon aria-hidden="true" className="size-5" />}
      className="w-11 px-0! aria-pressed:bg-brand-soft aria-pressed:text-brand-strong aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent"
    />
  )
}

function SaveStatus({ state, onRetry }: { state: PadSaveState; onRetry: () => void }) {
  if (state === 'idle') return null
  if (state === 'error') {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-down" data-testid="handwriting-save-state">
        <CircleAlert aria-hidden="true" className="size-4" />
        <span>
          Not saved —{' '}
          <button type="button" onClick={onRetry} aria-label="Retry saving the handwritten notes" className="relative underline underline-offset-2 before:absolute before:-inset-x-2 before:-inset-y-3">
            retry
          </button>
        </span>
      </p>
    )
  }
  const look = state === 'saved' ? { icon: <CircleCheck aria-hidden="true" className="size-4" />, cls: 'text-ok' } : state === 'blocked' ? { icon: <CircleAlert aria-hidden="true" className="size-4" />, cls: 'text-down' } : { icon: <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />, cls: 'text-ink-muted' }
  return (
    <p className={`inline-flex items-center gap-1.5 text-sm font-medium ${look.cls}`} data-testid="handwriting-save-state">
      {look.icon}
      {saveStateText(state)}
    </p>
  )
}

/** The canvas in page units, sharp at the device's pixel ratio, with round ends and joins. */
function prepare(ctx: CanvasRenderingContext2D, cssW: number, dpr: number) {
  const s = (dpr * cssW) / HANDWRITING_PAGE.width
  ctx.setTransform(s, 0, 0, s, 0, 0)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
}

/** Draws smoothed segments, as few paths as the widths allow (a pen's pressure changes the width; a finger's and a mouse's do not). */
function drawSegments(ctx: CanvasRenderingContext2D, segs: InkSegment[], color: string) {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  let open = false
  let w = -1
  for (const s of segs) {
    if (s.x0 === s.x1 && s.y0 === s.y1 && s.cx === s.x0 && s.cy === s.y0) {
      if (open) ctx.stroke()
      open = false
      ctx.beginPath()
      ctx.arc(s.x0, s.y0, s.w / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    const qw = Math.round(s.w * 4) / 4
    if (!open || qw !== w) {
      if (open) ctx.stroke()
      ctx.beginPath()
      ctx.lineWidth = qw
      w = qw
      ctx.moveTo(s.x0, s.y0)
      open = true
    }
    ctx.quadraticCurveTo(s.cx, s.cy, s.x1, s.y1)
  }
  if (open) ctx.stroke()
}

/** The element a finger scrolls when a pen is in use: the nearest scrolling ancestor, else the page. */
function scrollParent(el: Element): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return document.scrollingElement ?? document.documentElement
}

/** Refusals that mean the consultation is closed to this pad (signed, discarded, the visit left the doctor, access ended). */
const isClosed = (err: ApiError) => ['encounter_signed', 'encounter_discarded', 'visit_not_in_consultation'].includes(err.code) || err.status === 401 || err.status === 403 || err.status === 404
