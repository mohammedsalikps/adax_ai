// Unit tests (node --test) of the Doctor HERO workspace's jumps: the parts a jump can lead to, the five modules of the inputs rail, the request
// that opens a collapsed module, and how a part is brought into view (only its own scrolling column moves, so the page keeps its place; focus
// arrives with it; reduced motion jumps). No browser: the page is a stand-in that records what was asked of it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EVIDENCE_TARGETS } from '@adaxai/contracts'
import { targetElementId } from '../src/lib/consultationContext.ts'
import { expandPart, isModulePart, isPartId, MODULES, onExpandPart, PART_IDS, type PartDocument, revealPart, showPart } from '../src/lib/workspace.ts'

test('the parts a jump can lead to are the rail, its five modules, the Mana area, the note and the prescription, each once', () => {
  assert.deepEqual(
    [...PART_IDS],
    ['consultation-inputs', 'tools-conversation', 'tools-history', 'tools-devices', 'tools-stethoscope', 'tools-thermal', 'mana-result', 'mana-review', 'mana-chat', 'consultation-note', 'rx'],
  )
  assert.equal(new Set(PART_IDS).size, PART_IDS.length)
  assert.equal(isPartId('mana-result'), true)
  assert.equal(isPartId('tools-overview'), false, 'the Overview is no longer a part of the rail')
  assert.equal(isPartId('tools-draft'), false)
  // Every target the Overview can lead to is one of them.
  for (const t of EVIDENCE_TARGETS) assert.ok(isPartId(targetElementId(t)))
})

test('the rail has five modules in the order a consultation uses them; the vitals module keeps the devices part id', () => {
  assert.deepEqual(
    MODULES.map((m) => [m.n, m.key, m.part, m.testId]),
    [
      [1, 'conversation', 'tools-conversation', 'module-conversation'],
      [2, 'history', 'tools-history', 'module-history'],
      [3, 'vitals', 'tools-devices', 'module-vitals'],
      [4, 'stethoscope', 'tools-stethoscope', 'module-stethoscope'],
      [5, 'thermal', 'tools-thermal', 'module-thermal'],
    ],
  )
  for (const m of MODULES) assert.equal(isModulePart(m.part), true)
  for (const id of ['consultation-inputs', 'mana-result', 'mana-review', 'mana-chat', 'consultation-note', 'rx']) assert.equal(isModulePart(id), false)
})

test('a request to open a part reaches every listener once, with its id; a listener that stopped hears nothing; nothing is remembered', () => {
  const heard: string[][] = [[], []]
  const stopA = onExpandPart((id) => heard[0]!.push(id))
  const stopB = onExpandPart((id) => heard[1]!.push(id))
  expandPart('tools-thermal')
  expandPart('mana-result')
  assert.deepEqual(heard, [
    ['tools-thermal', 'mana-result'],
    ['tools-thermal', 'mana-result'],
  ])
  stopA()
  expandPart('tools-history')
  assert.deepEqual(heard[0], ['tools-thermal', 'mana-result'])
  assert.deepEqual(heard[1], ['tools-thermal', 'mana-result', 'tools-history'])
  stopB()
  // A listener that joins later is not opened by a request made before it.
  const late: string[] = []
  const stopLate = onExpandPart((id) => late.push(id))
  assert.deepEqual(late, [])
  // A listener that stops while a request is being delivered does not stop the others from hearing it.
  const order: string[] = []
  const stopSelf = onExpandPart(() => {
    order.push('first')
    stopSelf()
  })
  const stopOther = onExpandPart(() => order.push('second'))
  expandPart('tools-conversation')
  assert.deepEqual(order, ['first', 'second'])
  assert.deepEqual(late, ['tools-conversation'])
  stopLate()
  stopOther()
  // Stopping twice is harmless.
  stopOther()
})

/** A page stand-in: one part, optionally inside a column marked data-scroller, recording every scroll and focus asked of it. */
function page({ inScroller = true, overflowY = 'auto', reduce = false, heading = false }: { inScroller?: boolean; overflowY?: string; reduce?: boolean; heading?: boolean } = {}) {
  const calls: [string, unknown][] = []
  const scroller = {
    scrollTop: 120,
    getBoundingClientRect: () => ({ top: 200 }),
    scrollTo: (o: unknown) => calls.push(['column.scrollTo', o]),
  }
  const h2 = { focus: (o: unknown) => calls.push(['heading.focus', o]) }
  const selectors: string[] = []
  const el = {
    closest: (sel: string) => (sel === '[data-scroller]' && inScroller ? scroller : null),
    getBoundingClientRect: () => ({ top: 650 }),
    scrollIntoView: (o: unknown) => calls.push(['part.scrollIntoView', o]),
    focus: (o: unknown) => calls.push(['part.focus', o]),
    querySelector: (sel: string) => {
      selectors.push(sel)
      return heading && sel === '[data-part-focus="tools-thermal"]' ? h2 : null
    },
  }
  const doc = {
    getElementById: (id: string) => (id === 'tools-thermal' ? el : null),
    defaultView: {
      matchMedia: (q: string) => ({ matches: reduce && q === '(prefers-reduced-motion: reduce)' }),
      getComputedStyle: () => ({ overflowY }),
    },
  } as unknown as PartDocument
  return { doc, calls, selectors }
}

test('from 1024px a part in the rail is scrolled to the top of the rail only (the page keeps its place), and focus arrives without another scroll', () => {
  const p = page()
  assert.equal(showPart('tools-thermal', p.doc), true)
  // 650 - 200 + 120 - 4: the part's top, at the column's top, with the column's own scroll and a small gap.
  assert.deepEqual(p.calls, [
    ['column.scrollTo', { top: 566, behavior: 'smooth' }],
    ['part.focus', { preventScroll: true }],
  ])
  // A column that hides its overflow is still scrolled by the page's code.
  const hidden = page({ overflowY: 'hidden' })
  showPart('tools-thermal', hidden.doc)
  assert.equal(hidden.calls[0]![0], 'column.scrollTo')
})

test('below 1024px (the column does not scroll on its own) or outside any column, the page scrolls to the part', () => {
  for (const p of [page({ overflowY: 'visible' }), page({ overflowY: 'clip' }), page({ inScroller: false })]) {
    showPart('tools-thermal', p.doc)
    assert.deepEqual(p.calls, [
      ['part.scrollIntoView', { block: 'start', behavior: 'smooth' }],
      ['part.focus', { preventScroll: true }],
    ])
  }
})

test('reduced motion jumps instead of gliding', () => {
  const inColumn = page({ reduce: true })
  showPart('tools-thermal', inColumn.doc)
  assert.deepEqual(inColumn.calls[0], ['column.scrollTo', { top: 566, behavior: 'auto' }])
  const onPage = page({ reduce: true, inScroller: false })
  showPart('tools-thermal', onPage.doc)
  assert.deepEqual(onPage.calls[0], ['part.scrollIntoView', { block: 'start', behavior: 'auto' }])
})

test('focus goes to the element the part marks for it (its heading) when there is one, else to the part', () => {
  const p = page({ heading: true })
  showPart('tools-thermal', p.doc)
  assert.deepEqual(p.calls[1], ['heading.focus', { preventScroll: true }])
  assert.equal(p.calls.some(([c]) => c === 'part.focus'), false)
  // Only the mark naming this part is looked for (a module's heading inside the rail is not the rail's).
  assert.deepEqual(p.selectors, ['[data-part-focus="tools-thermal"]'])
})

test('a part that is not on the page is not looked for further, and nothing moves', () => {
  const p = page()
  assert.equal(showPart('mana-chat', p.doc), false)
  assert.deepEqual(p.calls, [])
})

test('revealing a part asks it to open first, then brings it into view', () => {
  const p = page()
  const order: string[] = []
  const stop = onExpandPart((id) => order.push(`open ${id}`))
  const doc = { ...p.doc, getElementById: (id: string) => (order.push(`show ${id}`), p.doc.getElementById(id)) } as PartDocument
  assert.equal(revealPart('tools-thermal', doc), true)
  stop()
  assert.deepEqual(order, ['open tools-thermal', 'show tools-thermal'])
  assert.deepEqual(p.calls[0], ['column.scrollTo', { top: 566, behavior: 'smooth' }])
})
