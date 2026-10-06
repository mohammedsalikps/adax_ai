// Unit tests (node --test) of the digital pen's model (lib/handwriting.ts, lib/handwritingApi.ts): adding, undoing and redoing strokes,
// clearing a page as one undoable change, pages, the saved document and its round trip through the contract, how a version conflict keeps
// every stroke, writing a closed pad could not save (restored or merged by the next pad), palm rejection, the quadratic smoothing the pad
// draws with, page coordinates and pressure, the pad's words, the autosave scheduler (debounced, never two saves at once), and the last save
// as a pad goes away (its answer, the next pad waiting for it, what it could not store kept for the writer). No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import { HANDWRITING_LIMITS, HANDWRITING_PAGE, HandwritingDocument, type HandwritingStroke } from '@adaxai/contracts'
import {
  appendPoint,
  createSaveScheduler,
  handwritingSummary,
  INK_COLORS,
  InkModel,
  MIN_POINT_DISTANCE,
  mergeAfterConflict,
  PALM_GRACE_MS,
  pointPressure,
  pressureWidth,
  resumeUnsaved,
  retryDelayMs,
  sameInk,
  type SaveTimers,
  saveStateText,
  segmentCount,
  strokeSegments,
  TouchScroller,
  toPagePoint,
} from '../src/lib/handwriting.ts'
import {
  fetchHandwriting,
  forgetUnsavedHandwriting,
  handwritingForm,
  KEEPALIVE_MAX_BYTES,
  keepUnsavedHandwriting,
  sendHandwritingOnExit,
  takeUnsavedHandwriting,
  trackHandwritingExit,
} from '../src/lib/handwritingApi.ts'

let seq = 0
/** A distinct stroke (its points differ from every other one made here). */
const stroke = (page = 0, over: Partial<HandwritingStroke> = {}): HandwritingStroke => {
  seq++
  return { page, width: 3, color: '#0f172a', input: 'pen', points: [10 + seq, 20, 0.5, 30 + seq, 40, 0.7, 50 + seq, 45.5, 0.6], ...over }
}

test('strokes: add, undo and redo take back and do again exactly the same strokes; a new stroke after an undo drops the redo history', () => {
  const m = new InkModel()
  assert.deepEqual([m.pageCount, m.strokeCount, m.canUndo, m.canRedo], [1, 0, false, false])
  const [a, b] = [stroke(), stroke()]
  const r0 = m.revision
  assert.equal(m.add(a), true)
  assert.equal(m.add(b), true)
  assert.ok(m.revision > r0)
  assert.deepEqual(m.strokes, [a, b])

  assert.equal(m.undo(), 0)
  assert.deepEqual(m.strokes, [a])
  assert.equal(m.canRedo, true)
  assert.equal(m.redo(), 0)
  assert.equal(m.strokes[1], b, 'redo puts back the same stroke object')
  assert.equal(m.redo(), null, 'nothing left to redo')

  m.undo()
  const c = stroke()
  m.add(c)
  assert.equal(m.canRedo, false)
  assert.deepEqual(m.strokes, [a, c])
  assert.equal(m.undo(), 0)
  assert.equal(m.undo(), 0)
  assert.equal(m.undo(), null)
  assert.deepEqual(m.strokes, [])
})

test('clear page: removes only that page’s strokes as one change, asks nothing, and undo puts every stroke back in its place', () => {
  const m = new InkModel()
  m.addPage()
  const s = [stroke(0), stroke(1), stroke(0), stroke(1), stroke(0)]
  for (const x of s) m.add(x)
  assert.equal(m.clearPage(0), true)
  assert.deepEqual(m.strokes, [s[1], s[3]])
  assert.deepEqual(m.pageStrokes(0), [])
  assert.equal(m.undo(), 0, 'undo names the page that was cleared')
  assert.deepEqual(m.strokes, s, 'the same strokes, in the same order')
  assert.equal(m.redo(), 0)
  assert.deepEqual(m.strokes, [s[1], s[3]])
  // Clearing an empty page is not a change (no history entry).
  const before = m.revision
  assert.equal(m.clearPage(0), false)
  assert.equal(m.revision, before)
  assert.equal(m.undo(), 0)
  assert.deepEqual(m.strokes, s)
})

test('pages: a new page is added at the end and undone like a stroke; strokes only go on pages that exist; at most 50 pages', () => {
  const m = new InkModel()
  assert.equal(m.add(stroke(1)), false, 'there is no page 2 yet')
  assert.equal(m.addPage(), 1)
  assert.equal(m.add(stroke(1)), true)
  assert.equal(m.undo(), 1)
  assert.equal(m.undo(), 0, 'undoing the new page shows the last page that remains')
  assert.equal(m.pageCount, 1)
  assert.equal(m.redo(), 1)
  assert.equal(m.pageCount, 2)
  while (m.pageCount < HANDWRITING_LIMITS.maxPages) m.addPage()
  assert.equal(m.addPage(), null)
  assert.equal(m.pageCount, HANDWRITING_LIMITS.maxPages)
})

test('a full pad refuses more strokes (20,000), and a stroke without a point is never added', () => {
  const s = stroke()
  const m = new InkModel({ pageCount: 1, strokes: Array.from({ length: HANDWRITING_LIMITS.maxStrokes - 1 }, () => s) })
  assert.equal(m.full, false)
  assert.equal(m.add(stroke()), true)
  assert.equal(m.full, true)
  assert.equal(m.add(stroke()), false)
  assert.equal(new InkModel().add({ ...stroke(), points: [] }), false)
})

test('serialisation: the saved document is the contract’s format and reads back into the same strokes and pages', () => {
  const m = new InkModel()
  m.add(stroke(0))
  m.addPage()
  m.add(stroke(1, { color: INK_COLORS[2].value, width: 6, input: 'touch' }))
  m.addPage()
  const doc = m.toDocument()
  assert.deepEqual(doc.page, HANDWRITING_PAGE)
  assert.equal(doc.pageCount, 3)
  assert.equal(HandwritingDocument.safeParse(doc).success, true)
  const back = new InkModel(HandwritingDocument.parse(JSON.parse(JSON.stringify(doc))))
  assert.deepEqual(back.toDocument(), doc)
  assert.equal(back.canUndo, false, 'a loaded document starts with no history')
  // The saved document is a copy: later changes do not alter it.
  m.add(stroke(2))
  assert.equal(doc.strokes.length, 2)
  // A document whose stroke is on a page beyond its count still shows that page.
  assert.equal(new InkModel({ pageCount: 1, strokes: [stroke(3)] }).pageCount, 4)
  assert.equal(new InkModel(null).pageCount, 1)
})

test('version conflict: the result keeps the other screen’s version and every stroke written here since this screen’s version, once', () => {
  const [b1, b2] = [stroke(0), stroke(0)]
  // This screen loaded version 1 (b1, b2), then wrote l1 on page 0 and l2 on a new page 1, and cleared nothing.
  const local = new InkModel({ pageCount: 1, strokes: [b1, b2] })
  const base = new Set(local.strokes)
  const l1 = stroke(0)
  local.add(l1)
  local.addPage()
  const l2 = stroke(1)
  local.add(l2)
  // Meanwhile another screen saved version 2: b1, b2 and its own o1 — and a copy of l1 (a save from here that arrived although its answer
  // was lost).
  const o1 = stroke(0, { color: '#1d4ed8' })
  const server = { pageCount: 1, strokes: [{ ...b1 }, { ...b2 }, o1, { ...l1, points: [...l1.points] }] }
  const { document, added } = mergeAfterConflict(server, local, base)
  assert.equal(added, 1)
  assert.deepEqual(document.strokes, [...server.strokes, l2])
  assert.equal(document.pageCount, 2)
  assert.equal(HandwritingDocument.safeParse(document).success, true)

  // A stroke cleared here that the other screen still has is kept (a merge never loses writing).
  const local2 = new InkModel({ pageCount: 1, strokes: [b1] })
  const base2 = new Set(local2.strokes)
  local2.clearPage(0)
  assert.deepEqual(mergeAfterConflict({ pageCount: 1, strokes: [b1] }, local2, base2), { document: { format: 1, page: { ...HANDWRITING_PAGE }, pageCount: 1, strokes: [b1] }, added: 0 })
  // Nothing on the server (no version yet): everything written here is kept.
  const fresh = new InkModel()
  const f1 = stroke(0)
  fresh.add(f1)
  assert.deepEqual(mergeAfterConflict(null, fresh, new Set()).document.strokes, [f1])
})

test('writing a closed pad could not save: restored exactly when nothing was saved since, merged when another screen saved, dropped when it was stored after all', () => {
  const [b1, b2] = [stroke(0), stroke(0)]
  const v3 = { pageCount: 1, strokes: [b1, b2] }
  // The pad had version 3; it wrote l1, cleared page 0, wrote l2, added a page; its last save as it closed failed.
  const pad = new InkModel(v3)
  const base = new Set(pad.strokes)
  const l1 = stroke(0)
  pad.add(l1)
  pad.clearPage(0)
  const l2 = stroke(0)
  pad.add(l2)
  pad.addPage()
  const left = { document: pad.toDocument(), baseVersion: 3, base }
  const parsed = (d: { pageCount: number; strokes: HandwritingStroke[] }) => HandwritingDocument.parse(JSON.parse(JSON.stringify({ format: 1, page: HANDWRITING_PAGE, ...d })))

  // Nothing saved since version 3 (a network failure): the writing exactly as it was — the cleared page stays cleared — and it is saved now.
  const same = resumeUnsaved({ version: 3, document: parsed(v3) }, left)
  assert.deepEqual([same.document, same.unsaved, same.conflict], [left.document, true, false])
  assert.deepEqual(same.document.strokes, [l2])
  assert.equal(same.document.pageCount, 2)
  assert.equal(same.base, base, 'a later conflict is resolved against the strokes this writing started from')

  // Another screen saved version 4 (the last save met a conflict): its version plus what was written here, both kept, the doctor told.
  const o1 = stroke(0, { color: '#1d4ed8' })
  const v4 = parsed({ pageCount: 1, strokes: [b1, b2, o1] })
  const merged = resumeUnsaved({ version: 4, document: v4 }, left)
  assert.deepEqual([merged.unsaved, merged.conflict], [true, true])
  assert.deepEqual(merged.document.strokes, [...v4.strokes, l2])
  assert.equal(merged.document.pageCount, 2)
  assert.deepEqual([...merged.base], v4.strokes, 'the new version is the base from now on (by identity, as the pad holds it)')
  assert.equal(HandwritingDocument.safeParse(merged.document).success, true)

  // The last save was stored although its answer was lost (version 4 is that writing): nothing to save, nothing to tell.
  const stored = resumeUnsaved({ version: 4, document: parsed(left.document) }, left)
  assert.deepEqual([stored.unsaved, stored.conflict, stored.document.strokes.length], [false, false, 1])
  // Written and taken back before the pad closed: the same as version 3, nothing to save.
  const back = new InkModel(v3)
  back.add(stroke(0))
  back.undo()
  assert.equal(resumeUnsaved({ version: 3, document: parsed(v3) }, { document: back.toDocument(), baseVersion: 3, base: new Set(back.strokes) }).unsaved, false)
  // Before any version (0, no document): everything written is new.
  const first = new InkModel()
  first.add(stroke(0))
  assert.deepEqual(resumeUnsaved({ version: 0, document: null }, { document: first.toDocument(), baseVersion: 0, base: new Set() }).unsaved, true)
  assert.equal(sameInk(null, { pageCount: 1, strokes: [] }), true, 'no document is one empty page')
  assert.equal(sameInk({ pageCount: 2, strokes: [] }, { pageCount: 1, strokes: [] }), false)
})

test('palm rejection: the hand resting while the pen writes never scrolls, so the stroke is stored where it was written', () => {
  // Regression (review): pen down at y=300 moving across; the palm comes down and slides up 80 px during the stroke. The page scrolls by
  // whatever the scroller answers; the pen's points are read against the pad's rect at that moment (it moves when the page scrolls).
  const s = new TouchScroller()
  let scrollY = 0
  const rect = () => ({ left: 0, top: 100 - scrollY, width: 500 })
  const PALM = 2
  const ys: number[] = []
  const pen = (x: number) => ys.push(toPagePoint(x, 300, rect()).y)
  let t = 1_000
  s.penDown()
  pen(50)
  assert.equal(s.down(PALM, 600, (t += 8), true), false, 'a touch while the pen writes is ignored')
  for (let i = 1; i <= 8; i++) {
    const dy = s.move(PALM, 600 - i * 10)
    if (dy !== null) scrollY += dy
    pen(50 + i * 40)
  }
  s.penUp((t += 8))
  // Still the same contact after the pen lifted: it never scrolls.
  for (let i = 9; i <= 12; i++) assert.equal(s.move(PALM, 600 - i * 10), null)
  assert.equal(s.end(PALM), false, 'an ignored touch was never the scrolling one')
  assert.equal(scrollY, 0)
  assert.deepEqual(new Set(ys), new Set([400]), 'every point of the straight line keeps its height')

  // A touch just after the pen lifted is the hand too; after PALM_GRACE_MS a finger scrolls the page (dragging up scrolls down).
  assert.equal(s.down(3, 500, t + PALM_GRACE_MS - 1, false), false)
  assert.equal(s.move(3, 450), null)
  assert.equal(s.down(4, 500, t + PALM_GRACE_MS, false), true)
  assert.equal(s.move(4, 470), 30)
  assert.equal(s.move(4, 480), -10)
  assert.equal(s.move(PALM, 400), null, 'only the scrolling touch scrolls')
  // The pen comes down while that finger scrolls: it is the hand coming to rest and scrolls no more, even after the pen lifts.
  s.penDown()
  assert.equal(s.move(4, 300), null)
  s.penUp(t + 10_000)
  assert.equal(s.move(4, 200), null)
  assert.equal(s.end(4), false)
  // A finger long after: scrolls again; its end is reported once.
  assert.equal(s.down(5, 100, t + 20_000, false), true)
  assert.equal(s.end(5), true)
  assert.equal(s.end(5), false)
})

test('smoothing: a line to the first midpoint, quadratic curves through each point to the next midpoint, and a line to the last point when finished', () => {
  const pts = [0, 0, 0.5, 10, 0, 0.5, 10, 10, 1]
  const w = pressureWidth(4, 0.5)
  assert.equal(w, 4)
  assert.deepEqual(strokeSegments(pts, 4, false), [
    { x0: 0, y0: 0, cx: 2.5, cy: 0, x1: 5, y1: 0, w: 4 },
    { x0: 5, y0: 0, cx: 10, cy: 0, x1: 10, y1: 5, w: 4 },
  ])
  assert.deepEqual(strokeSegments(pts, 4, true).at(-1), { x0: 10, y0: 5, cx: 10, cy: 7.5, x1: 10, y1: 10, w: 6 })
  assert.deepEqual([segmentCount(3, false), segmentCount(3, true), segmentCount(1, false), segmentCount(1, true), segmentCount(0, true)], [2, 3, 0, 1, 0])
  // One point is a dot; two points are a straight line.
  assert.deepEqual(strokeSegments([5, 6, 0.5], 3, true), [{ x0: 5, y0: 6, cx: 5, cy: 6, x1: 5, y1: 6, w: 3 }])
  assert.deepEqual(strokeSegments([5, 6, 0.5], 3, false), [])
  assert.deepEqual(
    strokeSegments([0, 0, 0.5, 8, 0, 0.5], 2, true).map((s) => [s.x0, s.x1]),
    [
      [0, 4],
      [4, 8],
    ],
  )
  // Pressure: half the width at none, one and a half at full, kept within 0..1.
  assert.deepEqual([pressureWidth(4, 0), pressureWidth(4, 1), pressureWidth(4, 7), pressureWidth(4, -1)], [2, 6, 6, 2])
})

test('smoothing while writing: segments already drawn never change, so drawing only the new ones gives the finished stroke', () => {
  const pts: number[] = []
  const drawn: ReturnType<typeof strokeSegments> = []
  for (let i = 0; i < 40; i++) {
    pts.push(Math.round(100 + 40 * Math.sin(i / 3)) / 1, 200 + i * 3, i % 2 ? 0.4 : 0.8)
    drawn.push(...strokeSegments(pts, 3, false, drawn.length))
  }
  const finished = strokeSegments(pts, 3, true)
  assert.deepEqual(drawn, finished.slice(0, -1))
  assert.deepEqual(strokeSegments(pts, 3, true, drawn.length), finished.slice(-1))
  // Every curve starts where the previous one ended (no gaps in the line).
  for (let i = 1; i < finished.length; i++) assert.deepEqual([finished[i]!.x0, finished[i]!.y0], [finished[i - 1]!.x1, finished[i - 1]!.y1])
})

test('points: screen positions become page units at any pad width, kept on the page, rounded; pressure is the pen’s, 0.5 for touch and mouse', () => {
  const rect = { left: 100, top: 50, width: 500 }
  assert.deepEqual(toPagePoint(100, 50, rect), { x: 0, y: 0 })
  assert.deepEqual(toPagePoint(350, 300, rect), { x: 500, y: 500 })
  assert.deepEqual(toPagePoint(100.123, 50.37, rect), { x: 0.2, y: 0.7 })
  assert.deepEqual(toPagePoint(0, 0, rect), { x: 0, y: 0 }, 'outside the pad (captured pointer): kept on the page')
  assert.deepEqual(toPagePoint(9999, 9999, rect), { x: HANDWRITING_PAGE.width, y: HANDWRITING_PAGE.height })
  assert.deepEqual(toPagePoint(200, 50, { left: 0, top: 0, width: 2000 }), { x: 100, y: 25 })

  assert.equal(pointPressure('pen', 0.734), 0.73)
  assert.equal(pointPressure('pen', 0), 0.05, 'a pen at first contact can report 0')
  assert.equal(pointPressure('pen', 3), 1)
  assert.equal(pointPressure('touch', 1), 0.5)
  assert.equal(pointPressure('mouse', 0.5), 0.5)

  const pts: number[] = []
  assert.equal(appendPoint(pts, 10, 10, 0.5), true)
  assert.equal(appendPoint(pts, 10 + MIN_POINT_DISTANCE / 2, 10, 0.5), false, 'too close to add anything visible')
  assert.equal(appendPoint(pts, 10 + MIN_POINT_DISTANCE / 2, 10, 0.5, true), true, 'kept where the pen lifts')
  assert.equal(appendPoint(pts, 10 + MIN_POINT_DISTANCE / 2, 10, 0.5, true), false, 'never the same point twice')
  assert.equal(appendPoint(pts, 20, 10, 0.5), true)
  assert.deepEqual(pts, [10, 10, 0.5, 10.3, 10, 0.5, 20, 10, 0.5])
})

test('words: the pad’s text alternative counts pages and strokes; the save state says Saved, Saving… or Not saved — retry', () => {
  assert.equal(handwritingSummary(2, 34), 'Handwritten notes, 2 pages, 34 strokes')
  assert.equal(handwritingSummary(1, 1), 'Handwritten notes, 1 page, 1 stroke')
  assert.equal(handwritingSummary(1, 0), 'Handwritten notes, 1 page, 0 strokes')
  assert.equal(handwritingSummary(0, 0), 'Handwritten notes, 1 page, 0 strokes', 'a pad always has a page')
  assert.deepEqual(
    (['idle', 'pending', 'saving', 'saved', 'error', 'blocked'] as const).map(saveStateText),
    ['', 'Saving…', 'Saving…', 'Saved', 'Not saved — retry', 'Not saved'],
  )
  assert.deepEqual([0, 1, 2, 3, 9].map(retryDelayMs), [2_000, 5_000, 15_000, 30_000, 30_000])
})

test('the save request: fields first (the server reads the fields sent before the file), then the document as one JSON file', async () => {
  const m = new InkModel()
  m.add(stroke())
  m.addPage()
  const doc = m.toDocument()
  const form = handwritingForm(doc, 7)
  assert.deepEqual(
    [...form.keys()],
    ['expectedVersion', 'strokeCount', 'pageCount', 'file'],
  )
  assert.deepEqual([form.get('expectedVersion'), form.get('strokeCount'), form.get('pageCount')], ['7', '1', '2'])
  const file = form.get('file') as File
  assert.equal(file.type, 'application/json')
  assert.deepEqual(JSON.parse(await file.text()), doc)
  assert.ok(KEEPALIVE_MAX_BYTES <= 64 * 1024, 'below what a browser lets a closing page send')
})

/** Timers under the test's control: `advance` runs what is due, letting each save's promise settle. */
function fakeClock() {
  let now = 0
  let id = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  const settle = () => new Promise((r) => setImmediate(r))
  const timers: SaveTimers = {
    set: (fn, ms) => {
      due.set(++id, { at: now + ms, fn })
      return id
    },
    clear: (h) => void due.delete(h as number),
    now: () => now,
  }
  return {
    timers,
    get now() {
      return now
    },
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        due.delete(next[0])
        now = next[1].at
        next[1].fn()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

/** A save that takes `ms` of the fake clock (resolved by the test), recording when each one started and how many ran at once. */
function recorder() {
  const starts: number[] = []
  let running = 0
  let most = 0
  const finishers: (() => void)[] = []
  return {
    starts,
    get most() {
      return most
    },
    finishAll() {
      for (const f of finishers.splice(0)) f()
    },
    run(clock: { now: number }, hold = false) {
      return () => {
        starts.push(clock.now)
        running++
        most = Math.max(most, running)
        return new Promise<void>((resolve) => {
          const done = () => {
            running--
            resolve()
          }
          if (hold) finishers.push(done)
          else done()
        })
      }
    },
  }
}

test('autosave: one save 1.5 s after the last stroke, however many strokes came before', async () => {
  const clock = fakeClock()
  const rec = recorder()
  const s = createSaveScheduler({ delayMs: 1_500, maxWaitMs: 10_000, run: rec.run(clock), timers: clock.timers })
  s.touch()
  await clock.advance(1_000)
  s.touch()
  await clock.advance(1_000)
  s.touch()
  assert.deepEqual(rec.starts, [])
  assert.equal(s.waiting, true)
  await clock.advance(1_499)
  assert.deepEqual(rec.starts, [])
  await clock.advance(1)
  assert.deepEqual(rec.starts, [3_500])
  assert.equal(s.waiting, false)
  await clock.advance(10_000)
  assert.deepEqual(rec.starts, [3_500], 'nothing more without a change')
})

test('autosave: continuous writing still saves at the latest 10 s after the first unsaved stroke', async () => {
  const clock = fakeClock()
  const rec = recorder()
  const s = createSaveScheduler({ delayMs: 1_500, maxWaitMs: 10_000, run: rec.run(clock), timers: clock.timers })
  for (let i = 0; i < 15; i++) {
    s.touch()
    await clock.advance(1_000)
  }
  assert.deepEqual(rec.starts, [10_000])
})

test('autosave: never two saves at once — a change during a save makes exactly one more save after it; flush saves now; cancel stops a waiting one', async () => {
  const clock = fakeClock()
  const rec = recorder()
  const s = createSaveScheduler({ delayMs: 1_500, run: rec.run(clock, true), timers: clock.timers })
  s.touch()
  await clock.advance(1_500)
  assert.equal(s.running, true)
  // Two more changes and a flush while the first save runs.
  s.touch()
  await clock.advance(1_500)
  s.touch(0)
  await clock.advance(0)
  void s.flush()
  assert.deepEqual(rec.starts, [1_500])
  rec.finishAll()
  await clock.advance(0)
  assert.deepEqual(rec.starts, [1_500, 3_000], 'one more save, after the first finished')
  assert.equal(rec.most, 1)
  rec.finishAll()
  await clock.advance(0)
  await s.idle()
  assert.equal(s.running, false)

  // flush: at once, and the waiting timer is gone.
  s.touch()
  const flushed = s.flush()
  assert.equal(rec.starts.length, 3)
  rec.finishAll()
  await flushed
  await clock.advance(5_000)
  assert.equal(rec.starts.length, 3)

  // touch(ms): a retry after a given wait; cancel stops it.
  s.touch(5_000)
  await clock.advance(4_999)
  s.cancel()
  await clock.advance(10_000)
  assert.equal(rec.starts.length, 3)
  assert.equal(s.waiting, false)
})

test('autosave: a save that fails does not stop later ones', async () => {
  const clock = fakeClock()
  let calls = 0
  const s = createSaveScheduler({
    delayMs: 100,
    run: async () => {
      calls++
      if (calls === 1) throw new Error('network')
    },
    timers: clock.timers,
  })
  s.touch()
  await clock.advance(100)
  s.touch()
  await clock.advance(100)
  assert.equal(calls, 2)
  await s.flush()
  assert.equal(calls, 3)
})

/** Replaces fetch for one test: records each request (method, url, keepalive) and answers with `answer`. */
function stubFetch(answer: (method: string, url: string) => Response | Promise<Response>) {
  const real = globalThis.fetch
  const calls: { method: string; url: string; keepalive?: boolean }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    calls.push({ method, url, keepalive: init?.keepalive })
    return answer(method, url)
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = real) }
}
const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const settle = () => new Promise((r) => setImmediate(r))

test('the last save as a pad goes away answers whether it was stored: the version, a refusal with its code, or no server', async () => {
  const m = new InkModel()
  m.add(stroke())
  const doc = m.toDocument()
  const enc = '11111111-1111-4111-8111-111111111111'
  const saved = { encounterId: enc, version: 4, strokeCount: 1, pageCount: 1, savedAt: '2026-10-06T10:00:00.000Z' }
  let next: () => Response | Promise<Response> = () => reply(saved, 201)
  const f = stubFetch(() => next())
  try {
    assert.deepEqual(await sendHandwritingOnExit(enc, doc, 3), { ok: true, saved })
    assert.deepEqual(f.calls, [{ method: 'POST', url: `/api/encounters/${enc}/handwriting`, keepalive: true }], 'a small save outlives the page')
    next = () => reply({ error: 'handwriting_version_conflict', message: 'changed elsewhere' }, 409)
    assert.deepEqual(await sendHandwritingOnExit(enc, doc, 3), { ok: false, status: 409, code: 'handwriting_version_conflict' })
    next = () => new Response('<html>bad gateway</html>', { status: 502 })
    assert.deepEqual(await sendHandwritingOnExit(enc, doc, 3), { ok: false, status: 502, code: 'http_error' })
    next = () => Promise.reject(new TypeError('Failed to fetch'))
    assert.deepEqual(await sendHandwritingOnExit(enc, doc, 3), { ok: false, status: 0, code: 'network_error' })
  } finally {
    f.restore()
  }
})

test('a pad that opens reads the notes only after the last save of the pad of that consultation that went away (or when it is no longer wanted)', async () => {
  const enc = '22222222-2222-4222-8222-222222222222'
  const other = '33333333-3333-4333-8333-333333333333'
  const latest = (id: string) => ({ encounterId: id, version: 1, strokeCount: 0, pageCount: 1, strokesFileId: null, document: null, savedAt: null, savedByName: null, readOnly: false })
  const f = stubFetch((_method, url) => reply(latest(url.split('/')[3]!), 200))
  try {
    let finishSave!: () => void
    const exit = trackHandwritingExit(enc, new Promise<void>((r) => (finishSave = r)))
    let read = false
    const reading = fetchHandwriting(enc).then((v) => {
      read = true
      return v
    })
    // Another consultation's pad is not held up.
    assert.equal((await fetchHandwriting(other)).encounterId, other)
    await settle()
    assert.equal(read, false, 'no read while the last save runs')
    assert.deepEqual(f.calls.map((c) => c.url), [`/api/encounters/${other}/handwriting`])
    finishSave()
    await exit
    assert.equal((await reading).encounterId, enc)
    assert.deepEqual(f.calls.map((c) => c.url), [`/api/encounters/${other}/handwriting`, `/api/encounters/${enc}/handwriting`])

    // A failed last save still lets the pad open; two pads going away one after the other are both waited for.
    let second!: () => void
    void trackHandwritingExit(enc, Promise.reject(new Error('lost')))
    void trackHandwritingExit(enc, new Promise<void>((r) => (second = r)))
    let opened = false
    const again = fetchHandwriting(enc).then(() => (opened = true))
    await settle()
    assert.equal(opened, false)
    second()
    await again
    assert.equal(opened, true)

    // A pad closed before its read (the read is cancelled): it stops waiting at once.
    void trackHandwritingExit(enc, new Promise(() => undefined))
    const ctl = new AbortController()
    const cancelled = fetchHandwriting(enc, ctl.signal)
    ctl.abort()
    await assert.rejects(cancelled, { name: 'AbortError' })
  } finally {
    f.restore()
  }
})

test('writing a last save could not store is kept for the person who wrote it, taken once by the next pad of that consultation', () => {
  const m = new InkModel()
  m.add(stroke())
  const entry = (userId: string) => ({ userId, document: m.toDocument(), baseVersion: 2, base: new Set<HandwritingStroke>() })
  const [e1, e2] = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']
  const kept = entry('doctor-a')
  keepUnsavedHandwriting(e1, kept)
  assert.equal(takeUnsavedHandwriting(e2, 'doctor-a'), null, 'only for its consultation')
  assert.equal(takeUnsavedHandwriting(e1, 'doctor-a'), kept)
  assert.equal(takeUnsavedHandwriting(e1, 'doctor-a'), null, 'taken once')
  // Another person signed in: they never get it, and it is forgotten.
  keepUnsavedHandwriting(e1, entry('doctor-a'))
  keepUnsavedHandwriting(e2, entry('doctor-a'))
  assert.equal(takeUnsavedHandwriting(e1, 'doctor-b'), null)
  assert.equal(takeUnsavedHandwriting(e2, 'doctor-a'), null, 'forgotten when another person opened a pad')
  assert.equal(takeUnsavedHandwriting(e1, null), null)
  // A sign-out can forget everything kept.
  keepUnsavedHandwriting(e1, entry('doctor-a'))
  forgetUnsavedHandwriting()
  assert.equal(takeUnsavedHandwriting(e1, 'doctor-a'), null)
})
