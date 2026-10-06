import { useCallback, useSyncExternalStore } from 'react'
import { fmtOffset } from './transcriptTime.ts'

/**
 * Whether a consultation is being recorded right now, as its live transcription panel knows it, so that the consultation's header can say
 * "● Recording 03:12", "Paused", "Not recording — <reason>" or nothing (the draft) without knowing about the recorder. One tiny store per page,
 * keyed by consultation; the panel writes it, anything may read it. Nothing here is guessed: "recording" only while the microphone recorder
 * runs (the synthetic demo is never a recording), "not recording" only with the honest reason the panel shows.
 *
 * No React needed to use the store itself (tested with node --test in test/liveTranscription.test.ts); `useRecordingState` is the hook.
 */

export type RecordingStateKind = 'recording' | 'paused' | 'not_recording' | 'idle'

export interface RecordingState {
  state: RecordingStateKind
  /**
   * recording: when the recording would have started had it never been paused (Date.now() milliseconds), so that `Date.now() - since` is the
   * time recorded; paused: when it was paused; not_recording: since when that is so; idle: null.
   */
  since: number | null
  /** not_recording: why, in the words after "Not recording — " ("the speech service is not running"). */
  reason?: string
  /** paused: the time recorded before the pause (ms). */
  elapsedMs?: number
}

export const IDLE_RECORDING: RecordingState = Object.freeze({ state: 'idle', since: null }) as RecordingState

const states = new Map<string, RecordingState>()
const listeners = new Map<string, Set<() => void>>()

const same = (a: RecordingState, b: RecordingState) => a.state === b.state && a.since === b.since && a.reason === b.reason && a.elapsedMs === b.elapsedMs

/** The consultation's recording state (idle when nothing was said). */
export const getRecordingState = (encounterId: string): RecordingState => states.get(encounterId) ?? IDLE_RECORDING

/** Says what the recording is doing now; listeners hear only real changes. */
export function setRecordingState(encounterId: string, next: RecordingState): void {
  if (same(getRecordingState(encounterId), next)) return
  if (next.state === 'idle') states.delete(encounterId)
  else states.set(encounterId, Object.freeze({ ...next }))
  for (const l of listeners.get(encounterId) ?? []) l()
}

/** Back to idle (the panel left the page). */
export const clearRecordingState = (encounterId: string): void => setRecordingState(encounterId, IDLE_RECORDING)

export function subscribeRecordingState(encounterId: string, listener: () => void): () => void {
  const set = listeners.get(encounterId) ?? new Set()
  set.add(listener)
  listeners.set(encounterId, set)
  return () => {
    set.delete(listener)
    if (!set.size) listeners.delete(encounterId)
  }
}

/** The recording state of a consultation, kept up to date. */
export function useRecordingState(encounterId: string): RecordingState {
  const subscribe = useCallback((cb: () => void) => subscribeRecordingState(encounterId, cb), [encounterId])
  const get = useCallback(() => getRecordingState(encounterId), [encounterId])
  return useSyncExternalStore(subscribe, get, get)
}

/** The time recorded so far (ms): live while recording, held while paused; null when nothing is being recorded. */
export function recordedMs(s: RecordingState, now = Date.now()): number | null {
  if (s.state === 'recording' && s.since !== null) return Math.max(0, now - s.since)
  if (s.state === 'paused') return Math.max(0, s.elapsedMs ?? 0)
  return null
}

/** The header's words: "Recording 03:12", "Paused 03:12", "Not recording — <reason>", "Not recording", or null for idle (the header says Draft). */
export function recordingLabel(s: RecordingState, now = Date.now()): string | null {
  if (s.state === 'recording') return `Recording ${fmtOffset(recordedMs(s, now))}`
  if (s.state === 'paused') return `Paused ${fmtOffset(recordedMs(s, now))}`
  if (s.state === 'not_recording') return s.reason ? `Not recording — ${s.reason}` : 'Not recording'
  return null
}
