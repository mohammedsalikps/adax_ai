import { applicationOf, type Me, Role } from '@adaxai/contracts'
import type { QueryClient } from '@tanstack/react-query'
import { ApiError, api } from './api.ts'
import { forgetUnsavedHandwriting } from './handwritingApi.ts'
import { clearSessionExit, markSessionEnded } from './sessionEnd.ts'

/** Who is signed in lives in one cache entry; everything else cached belongs to that person. */
export const ME_KEY = ['auth', 'me'] as const

/**
 * Counts the changes this page has made to who is signed in (a sign-in, a
 * sign-out, an expiry it noticed, a new password). A check of the session that
 * was already on its way when one of them happened answers for the person
 * before it, so its answer is dropped, not stored over the newer one.
 */
let epoch = 0

/**
 * Everything cached for the person who was here: their data, the variables of their mutations (a sign-in's password among them), and the
 * handwriting a pad's last save could not store, which is kept in memory for its writer (lib/handwritingApi.ts).
 */
function dropPersonalData(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] })
  qc.getMutationCache().clear()
  forgetUnsavedHandwriting()
}

/**
 * Drops everything cached for the person who was signed in, and sets who is
 * signed in now (or nobody). The `me` entry itself is kept and updated, not
 * removed: a component already showing it (a sign-in page with a "you are
 * signed in" notice, the routing guard) is subscribed to that entry, and a
 * removed one would leave it showing the old person.
 */
export function replaceSession(qc: QueryClient, me: Me | null) {
  epoch++
  dropPersonalData(qc)
  if (me) clearSessionExit()
  qc.setQueryData(ME_KEY, me)
}

/** The same person's details changed (a new password): update them, drop nothing. */
export function updateMe(qc: QueryClient, me: Me) {
  epoch++
  qc.setQueryData(ME_KEY, me)
}

const current = (qc: QueryClient) => qc.getQueryData<Me | null>(ME_KEY) ?? null

/** What /auth/me answers for a signed-in person; anything else (an empty 204, a web page from a proxy or a static host) is not an answer about the session. */
const isMe = (x: unknown): x is Me => typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string' && Role.safeParse((x as { role?: unknown }).role).success

/**
 * Asks the API who is signed in: the person, or null when there is no session.
 * The session cookie is shared by every tab, so the answer can differ from what
 * this tab shows. If it does (nobody now, or someone else), the old person's
 * cached data is dropped before anything is rendered for the new answer. A
 * failure other than "not signed in" (the service is down) is thrown and
 * changes nothing: the person already shown stays shown.
 */
export async function checkSession(qc: QueryClient): Promise<Me | null> {
  const before = qc.getQueryData<Me | null>(ME_KEY)
  const started = epoch
  let now: Me | null
  try {
    const answer: unknown = await api('/auth/me')
    if (!isMe(answer)) throw new ApiError(502, 'service_unavailable', 'The service answered with something that could not be read. Please try again in a moment.')
    now = answer
  } catch (e) {
    if (epoch !== started) return current(qc)
    if (!(e instanceof ApiError && e.status === 401)) throw e
    now = null
  }
  if (epoch !== started) return current(qc)
  if (before && before.id !== now?.id) {
    if (!now) markSessionEnded(applicationOf(before.role))
    dropPersonalData(qc)
  }
  return now
}
