import { ApiErrorBody, HANDWRITING_MIME, type HandwritingDocument, type HandwritingLatest, type HandwritingSaved } from '@adaxai/contracts'
import { api } from './api.ts'
import type { LeftUnsaved } from './handwriting.ts'

/**
 * The handwritten notes' API (GET and POST /api/encounters/:id/handwriting): the latest version, and a save as the next version. A save is
 * multipart: the fields first (the server reads the fields sent before the file), then the strokes document as one JSON file.
 *
 * A pad that goes away (the doctor switches to the typed note, opens the prescription, leaves the consultation) makes its last save on the
 * way out. The next pad of the same consultation reads the notes only after that save is done, and writing it could not store is kept here,
 * in memory, for the person who wrote it: the next pad of that consultation takes it and saves it. Nothing written is dropped silently.
 */

export const handwritingQueryKey = (encounterId: string) => ['handwriting', encounterId] as const

/** The latest version, as it is now. */
export const fetchLatestHandwriting = (encounterId: string, signal?: AbortSignal) => api<HandwritingLatest>(`/encounters/${encounterId}/handwriting`, { signal })

/** The last saves of pads that went away, still running, by consultation (only while they run: see `trackHandwritingExit`). */
const exits = new Map<string, Promise<void>>()

/** How long a pad that opens waits for the last save of the pad before it (after this it reads anyway; a later conflict keeps both). */
export const EXIT_WAIT_MS = 15_000

/** The latest version for a pad that opens: read once the last save of a pad of the same consultation that went away is done. */
export async function fetchHandwriting(encounterId: string, signal?: AbortSignal): Promise<HandwritingLatest> {
  await settled(exits.get(encounterId), EXIT_WAIT_MS, signal)
  return fetchLatestHandwriting(encounterId, signal)
}

/** The body of a save. `json` is the document already serialised (its size decides whether it can be sent as the page closes). */
export function handwritingForm(doc: HandwritingDocument, expectedVersion: number, json: string = JSON.stringify(doc)): FormData {
  const form = new FormData()
  form.append('expectedVersion', String(expectedVersion))
  form.append('strokeCount', String(doc.strokes.length))
  form.append('pageCount', String(doc.pageCount))
  form.append('file', new Blob([json], { type: HANDWRITING_MIME }), 'handwriting.json')
  return form
}

export const saveHandwriting = (encounterId: string, doc: HandwritingDocument, expectedVersion: number, json?: string) =>
  api<HandwritingSaved>(`/encounters/${encounterId}/handwriting`, { method: 'POST', body: handwritingForm(doc, expectedVersion, json) })

/** A browser sends at most 64 KiB of `keepalive` request bodies at once; below this a save can outlive the page. */
export const KEEPALIVE_MAX_BYTES = 60 * 1024

/** The answer to a last save: the version stored, or why not (status 0: the server was not reached). */
export type ExitSaveResult = { ok: true; saved: HandwritingSaved } | { ok: false; status: number; code: string }

/**
 * The last save as the pad goes away (the page is hidden or closed, or the pad unmounts): a `keepalive` request when the body is small
 * enough to outlive the page, else an ordinary request (which finishes when only the pad unmounted). Never throws: the answer says whether
 * the version was stored (when the page itself closes, nobody is left to read it).
 */
export async function sendHandwritingOnExit(encounterId: string, doc: HandwritingDocument, expectedVersion: number, json: string = JSON.stringify(doc)): Promise<ExitSaveResult> {
  const keepalive = json.length + 1024 < KEEPALIVE_MAX_BYTES
  try {
    const res = await fetch(`/api/encounters/${encounterId}/handwriting`, {
      method: 'POST',
      body: handwritingForm(doc, expectedVersion, json),
      headers: { accept: 'application/json', 'x-adaxai-csrf': '1' },
      credentials: 'same-origin',
      keepalive,
    })
    const body: unknown = await res.json().catch(() => null)
    if (res.ok) return { ok: true, saved: body as HandwritingSaved }
    const err = ApiErrorBody.safeParse(body)
    return { ok: false, status: res.status, code: err.success ? err.data.error : 'http_error' }
  } catch {
    // The server was not reached (or the browser refused the request outright).
    return { ok: false, status: 0, code: 'network_error' }
  }
}

// ---------------------------------------------------------------------------
// The last save of a pad that went away, and what it could not store.
// ---------------------------------------------------------------------------

/**
 * Records the last work of a pad that went away (a save in flight finishing, then its last save): the next pad of the consultation reads the
 * notes after it. Resolves when it is done (never rejects).
 */
export function trackHandwritingExit(encounterId: string, work: Promise<unknown>): Promise<void> {
  const before = exits.get(encounterId)
  const done: Promise<void> = Promise.all([before, work])
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (exits.get(encounterId) === done) exits.delete(encounterId)
    })
  exits.set(encounterId, done)
  return done
}

/** Writing a pad could not save as it went away, and who wrote it. */
export interface UnsavedHandwriting extends LeftUnsaved {
  userId: string
}

/** By consultation; in memory only (a reload ends it, and only the person who wrote it can take it back). */
const leftUnsaved = new Map<string, UnsavedHandwriting>()

/** Keeps writing a last save could not store, for the next pad of the consultation (it replaces anything kept before for it). */
export function keepUnsavedHandwriting(encounterId: string, entry: UnsavedHandwriting): void {
  leftUnsaved.set(encounterId, entry)
}

/** Takes, once, the writing kept for this consultation if `userId` wrote it; whatever was kept for anyone else is forgotten. */
export function takeUnsavedHandwriting(encounterId: string, userId: string | null | undefined): UnsavedHandwriting | null {
  for (const [id, entry] of leftUnsaved) if (entry.userId !== userId) leftUnsaved.delete(id)
  const entry = leftUnsaved.get(encounterId) ?? null
  leftUnsaved.delete(encounterId)
  return entry
}

/** Forgets every writing kept (for a sign-out: lib/session.ts may call it with the rest of the person's data). */
export function forgetUnsavedHandwriting(): void {
  leftUnsaved.clear()
}

/** Resolves when `p` settles, after `ms` at the latest, or when `signal` aborts (never rejects). */
function settled(p: Promise<unknown> | undefined, ms: number, signal?: AbortSignal): Promise<void> {
  if (!p || signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    p.then(done, done)
  })
}
