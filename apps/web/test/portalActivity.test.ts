// Unit tests (node --test) of when the patient portal polls its live reads (Home, Records, today's prescription; HERO final §5.9): every 60 s
// while the patient is using the page, and not at all once nobody has touched it for 15 minutes, so an unattended open portal stops making
// signed-in requests (each one refreshed the session's last-seen time and wrote a portal.read audit row) and its session can reach the idle
// timeout again. The tracker on a fake clock, the browser input it listens to, and the real TanStack observer stopping and resuming. No browser.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { environmentManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { type ActivityClock, attachBrowserInput, createActivityTracker, PORTAL_ACTIVE_MS, PORTAL_POLL_MS, portalPollInterval } from '../src/lib/portalActivity.ts'

const MIN = 60_000

/** A clock whose time only moves when the test says so; counts the timers it was asked for. */
function fakeClock() {
  let t = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: ActivityClock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      seq += 1
      timers.set(seq, { at: t + ms, fn })
      return seq
    },
    clearTimeout: (id) => void timers.delete(id as number),
  }
  return {
    clock,
    pending: () => timers.size,
    created: () => seq,
    advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = due[1].at
        due[1].fn()
      }
      t = end
    },
  }
}

/** Input the test fires by hand instead of the browser's. */
function fakeInput() {
  let handler: (() => void) | null = null
  let attached = 0
  let detached = 0
  return {
    attach: (onInput: () => void) => {
      attached += 1
      handler = onInput
      return () => {
        detached += 1
        handler = null
      }
    },
    fire: () => handler?.(),
    counts: () => ({ attached, detached }),
  }
}

test('a live read polls every 60 s while the patient is there and not at all otherwise', () => {
  assert.equal(PORTAL_POLL_MS, MIN)
  assert.equal(PORTAL_ACTIVE_MS, 15 * MIN)
  assert.equal(portalPollInterval(true), MIN)
  assert.equal(portalPollInterval(false), false)
})

test('nobody there for 15 minutes: inactive, said once, and no timer left running', () => {
  const c = fakeClock()
  const inp = fakeInput()
  const tracker = createActivityTracker(PORTAL_ACTIVE_MS, c.clock, inp.attach)
  let changes = 0
  const off = tracker.subscribe(() => (changes += 1))
  assert.equal(tracker.isActive(), true, 'opening a live page is the patient navigating to it')
  assert.deepEqual(inp.counts(), { attached: 1, detached: 0 })
  c.advance(15 * MIN - 1)
  assert.equal(tracker.isActive(), true)
  c.advance(1)
  assert.equal(tracker.isActive(), false)
  assert.equal(changes, 1)
  assert.equal(c.pending(), 0, 'an unattended page keeps no timer either')
  c.advance(8 * 60 * MIN)
  assert.equal(tracker.isActive(), false)
  assert.equal(changes, 1)
  off()
})

test('input keeps the patient there for 15 minutes after the last of it, and brings them back after idling', () => {
  const c = fakeClock()
  const inp = fakeInput()
  const tracker = createActivityTracker(PORTAL_ACTIVE_MS, c.clock, inp.attach)
  const seen: boolean[] = []
  tracker.subscribe(() => seen.push(tracker.isActive()))
  c.advance(10 * MIN)
  inp.fire()
  c.advance(14 * MIN)
  assert.equal(tracker.isActive(), true, '24 minutes after opening, 14 after the last input')
  c.advance(1 * MIN)
  assert.equal(tracker.isActive(), false)
  c.advance(30 * MIN)
  inp.fire()
  assert.equal(tracker.isActive(), true, 'the next tap, key or scroll resumes polling')
  assert.deepEqual(seen, [false, true])
  assert.equal(c.pending(), 1, 'and waits again for the patient to go')
  c.advance(15 * MIN)
  assert.equal(tracker.isActive(), false)
  assert.deepEqual(seen, [false, true, false])
})

test('a moving pointer costs a number write, not a timer per event', () => {
  const c = fakeClock()
  const inp = fakeInput()
  const tracker = createActivityTracker(PORTAL_ACTIVE_MS, c.clock, inp.attach)
  tracker.subscribe(() => {})
  for (let i = 0; i < 1000; i += 1) {
    c.advance(500)
    inp.fire()
  }
  assert.equal(c.created(), 1, 'one timer, still waiting')
  assert.equal(tracker.isActive(), true)
  c.advance(15 * MIN)
  assert.equal(tracker.isActive(), false)
  assert.ok(c.created() <= 3, `the timer waits again only for what is left (${c.created()} timers)`)
})

test('the last live page leaving stops listening; the next one opening counts as the patient being there', () => {
  const c = fakeClock()
  const inp = fakeInput()
  const tracker = createActivityTracker(PORTAL_ACTIVE_MS, c.clock, inp.attach)
  const offA = tracker.subscribe(() => {})
  const offB = tracker.subscribe(() => {})
  assert.deepEqual(inp.counts(), { attached: 1, detached: 0 }, 'one set of listeners for every live read on the page')
  offA()
  assert.deepEqual(inp.counts(), { attached: 1, detached: 0 })
  c.advance(20 * MIN)
  assert.equal(tracker.isActive(), false)
  offB()
  offB()
  assert.deepEqual(inp.counts(), { attached: 1, detached: 1 })
  assert.equal(c.pending(), 0)
  c.advance(60 * MIN)
  tracker.subscribe(() => {})
  assert.equal(tracker.isActive(), true)
  assert.deepEqual(inp.counts(), { attached: 2, detached: 1 })
})

test('the browser input: pointer, keys, touch, wheel, window focus and the page becoming visible; nothing after detaching', () => {
  const g = globalThis as { window?: unknown; document?: unknown }
  const savedWindow = g.window
  const savedDocument = g.document
  const win = new EventTarget()
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  g.window = win
  g.document = doc
  try {
    let n = 0
    const detach = attachBrowserInput(() => (n += 1))
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'focus']) win.dispatchEvent(new Event(type))
    assert.equal(n, 6)
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(n, 7, 'the page coming back into view')
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(n, 7, 'the page going away is not the patient being there')
    win.dispatchEvent(new Event('scroll'))
    assert.equal(n, 7, 'a programmatic scroll is not input')
    detach()
    doc.visibilityState = 'visible'
    for (const type of ['pointerdown', 'keydown', 'focus']) win.dispatchEvent(new Event(type))
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(n, 7)
  } finally {
    if (savedWindow === undefined) delete g.window
    else g.window = savedWindow
    if (savedDocument === undefined) delete g.document
    else g.document = savedDocument
  }
})

test('the real query observer: polls every 60 s while active, stops when the patient is gone, resumes on their return', async () => {
  // Node has no window, so TanStack takes it for a server and schedules no timers at all: say it is the browser for this test.
  const wasServer = environmentManager.isServer()
  environmentManager.setIsServer(() => false)
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const client = new QueryClient()
  try {
    let fetches = 0
    const options = (active: boolean) => ({ queryKey: ['portal', '/home'], queryFn: async () => (fetches += 1), staleTime: 30_000, refetchInterval: portalPollInterval(active), refetchOnWindowFocus: 'always' as const })
    const observer = new QueryObserver(client, options(true))
    const off = observer.subscribe(() => {})
    const settle = async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    }
    await settle()
    assert.equal(fetches, 1, 'the first read')
    for (let i = 0; i < 3; i += 1) {
      mock.timers.tick(PORTAL_POLL_MS)
      await settle()
    }
    assert.equal(fetches, 4, 'one read a minute while the patient is there')
    observer.setOptions(options(false))
    for (let i = 0; i < 120; i += 1) {
      mock.timers.tick(PORTAL_POLL_MS)
      await settle()
    }
    assert.equal(fetches, 4, 'two unattended hours: not one request, so the session idle timeout can expire')
    observer.setOptions(options(true))
    mock.timers.tick(PORTAL_POLL_MS)
    await settle()
    assert.equal(fetches, 5, 'polling resumes with the next input')
    off()
  } finally {
    client.clear()
    mock.timers.reset()
    environmentManager.setIsServer(() => wasServer)
  }
})
