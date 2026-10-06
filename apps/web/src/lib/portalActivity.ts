import { useSyncExternalStore } from 'react'

/**
 * Whether the patient is using the portal right now, so that what the portal reads "live" (Home, Records, today's prescription: they change
 * when the doctor completes a consultation) is polled only while somebody is there. A visible tab counts as focused for TanStack Query, so a
 * portal left open on an unattended screen would otherwise poll for ever: every poll is a signed-in request that keeps the session from
 * reaching its idle timeout (SESSION_IDLE_MS, one hour, apps/api/src/auth/sessions.ts) and writes a portal.read audit row. So the live reads
 * poll every 60 s while the patient pressed, moved the pointer, touched, typed, scrolled or came back to the page in the last 15 minutes, and
 * not at all after that until the next input; coming back to the app also reads again at once (refetch on focus). An unattended portal then
 * makes no request after 15 minutes and its session ends an hour later.
 *
 * No React needed for the tracker itself (tested with node --test in test/portalActivity.test.ts); `usePortalActive` is the hook.
 */

/** How often a live portal read is repeated while the patient is there. */
export const PORTAL_POLL_MS = 60_000
/** How long after the patient's last input the portal still counts them as there. */
export const PORTAL_ACTIVE_MS = 15 * 60_000

/** Input events (on window, capture phase) that mean the patient is there. Window focus and the page coming back into view count too. */
export const PORTAL_INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const

/** The polling interval of a live portal read: every 60 s while the patient is there, none otherwise. */
export const portalPollInterval = (active: boolean): number | false => (active ? PORTAL_POLL_MS : false)

export interface ActivityClock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

/** Starts listening for the patient's input, calling `onInput` for each; returns how to stop. */
export type AttachInput = (onInput: () => void) => () => void

export interface ActivityTracker {
  /** The patient did something now. */
  input: () => void
  /** Whether the patient did something in the last `windowMs` (a stable value between changes, for useSyncExternalStore). */
  isActive: () => boolean
  /**
   * Hears every change of `isActive`. The first subscriber starts listening for input and counts as input itself (a live page opening is the
   * patient navigating to it); the last one leaving stops listening and the timer.
   */
  subscribe: (listener: () => void) => () => void
}

const browserClock: ActivityClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}

/** The browser's input: pointer, keys, touch and wheel anywhere on the page, the window getting focus, the page becoming visible again. */
export const attachBrowserInput: AttachInput = (onInput) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  const onVisible = () => {
    if (document.visibilityState === 'visible') onInput()
  }
  for (const e of PORTAL_INPUT_EVENTS) window.addEventListener(e, onInput, opts)
  window.addEventListener('focus', onInput)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    for (const e of PORTAL_INPUT_EVENTS) window.removeEventListener(e, onInput, opts)
    window.removeEventListener('focus', onInput)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

export function createActivityTracker(windowMs: number = PORTAL_ACTIVE_MS, clock: ActivityClock = browserClock, attach: AttachInput = attachBrowserInput): ActivityTracker {
  let lastInputAt = clock.now()
  let active = true
  let timer: unknown = null
  let detach: (() => void) | null = null
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const l of listeners) l()
  }
  const stopTimer = () => {
    if (timer !== null) clock.clearTimeout(timer)
    timer = null
  }
  // One timer at a time, due when the window after the last input ends; input meanwhile only moves lastInputAt (the timer then waits again
  // for what is left), so a moving pointer costs a number write, not a timer.
  const arm = () => {
    if (timer !== null || !active || !listeners.size) return
    timer = clock.setTimeout(
      () => {
        timer = null
        if (clock.now() - lastInputAt >= windowMs) {
          active = false
          emit()
        } else arm()
      },
      Math.max(0, lastInputAt + windowMs - clock.now()),
    )
  }
  const input = () => {
    lastInputAt = clock.now()
    if (!active) {
      active = true
      emit()
    }
    arm()
  }

  return {
    input,
    isActive: () => active,
    subscribe(listener) {
      const first = !listeners.size
      listeners.add(listener)
      if (first) {
        detach = attach(input)
        input()
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size) return
        stopTimer()
        detach?.()
        detach = null
      }
    },
  }
}

const portalActivity = createActivityTracker()
const alwaysActive = () => true
const noSubscription = () => () => {}

/** Whether the patient is using the portal now; `track: false` does not listen at all (and says true: nothing to slow down). */
export function usePortalActive(track: boolean): boolean {
  return useSyncExternalStore(track ? portalActivity.subscribe : noSubscription, track ? portalActivity.isActive : alwaysActive, alwaysActive)
}
