import { ConsultationContext, type ContextConflict, EVIDENCE_TRUST, type EvidenceItem, type EvidenceKind, type EvidenceTrust, type PatientDeviceReadings, PENDING_KINDS, type PendingReview, type Role } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { ZodError } from 'zod'
import { ApiError, api } from './api.ts'
import { ageText, deviceReadingsKey, fmtClock, fmtWhen, type ReceivedDeviceReadings } from './devices.ts'
import type { PartId } from './workspace.ts'

/*
 * D2: the consultation's context, as the Overview reads it. One read (GET /api/encounters/:id/context), built by the server from the records
 * that already exist; the screen stores nothing of it, decides nothing from it and never makes an item more current or more trusted than the
 * server said. The helpers below are pure, so that what the Overview says can be tested without a browser.
 */

/** Under the encounter's key, so that refreshing the encounter refreshes its context too. */
export const contextKey = (encounterId: string) => ['encounter', encounterId, 'context'] as const
/** How often an open consultation reads its context again (only while the page is visible; also when the window regains focus). */
export const CONTEXT_POLL_MS = 15_000
/** How many evidence items the Overview lists before "Show all". */
export const EVIDENCE_LIMIT = 8

export type EvidenceTarget = EvidenceItem['target']

/**
 * Whether a failed read of the context is tried again (up to twice). Not when the answer did not match the contract (the screen and the server
 * are of different versions: the same answer would come back) and not when the server refused (4xx: asking again changes nothing).
 */
export function retryContextRead(failures: number, error: unknown): boolean {
  if (error instanceof ZodError) return false
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
  return failures < 2
}

/**
 * The consultation's context, re-read every 15 seconds while the page is visible and whenever the window regains focus (an insertion into the
 * note, a reviewed point or a new reading shows within that time). What arrives is checked against the contract: an answer the screen does not
 * understand is an error, never something drawn half right, and it is not asked for again until the next read.
 */
export function useConsultationContext(encounterId: string) {
  return useQuery({
    queryKey: contextKey(encounterId),
    queryFn: async () => ConsultationContext.parse(await api<unknown>(`/encounters/${encounterId}/context`)),
    retry: retryContextRead,
    refetchInterval: CONTEXT_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  })
}

/**
 * The live limit of the device card on the same page (seconds a device reading stays LIVE), from what that card last read. It only OBSERVES the
 * card's query (same key, same answer, never enabled), as the status chips do: no request and no audit entry of its own. Null until the card has
 * read: the Overview then says when a LIVE item was live instead of ageing it.
 */
export function useDeviceLiveSeconds(patientId: string): number | null {
  const q = useQuery({
    queryKey: deviceReadingsKey(patientId),
    queryFn: async (): Promise<ReceivedDeviceReadings> => ({ view: await api<PatientDeviceReadings>(`/patients/${patientId}/device-readings`), receivedAt: Date.now() }),
    enabled: false,
  })
  const s = q.data?.view?.thresholds?.liveSeconds
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : null
}

/** The server's clock now: the time it built the context plus the time since it arrived on this computer, so a wrong local clock does not make an old item look new. */
export function serverNow(generatedAt: string, receivedAt: number, nowLocal: number): number {
  const at = Date.parse(generatedAt)
  return Number.isFinite(at) ? at + Math.max(0, nowLocal - receivedAt) : nowLocal
}

/** How long ago, for a glance ("just now", "under a minute ago", "2 min ago", "1 h 5 min ago", "3 days ago"); null when the time cannot be read. */
export function relativeTime(at: string, now: number): string | null {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return null
  const ms = now - t
  if (ms < 60_000) return ms < 5_000 ? 'just now' : 'under a minute ago'
  return ageText(ms)
}

/** The exact time, with seconds (and the date when it is not today); null when the time cannot be read. */
export function exactTime(at: string, now: number): string | null {
  return Number.isFinite(Date.parse(at)) ? fmtWhen(at, now) : null
}

/** A time of day with seconds; null when the time cannot be read. */
export const clockTime = (at: string): string | null => (Number.isFinite(Date.parse(at)) ? fmtClock(at) : null)

/**
 * How a trust is marked: SIMULATED dashed, UNVERIFIED a solid outline, AI output in the AI colour, a point extracted from the conversation by
 * fixed rules and not yet decided in the to-review colour (marked for review like AI output, but never called AI), every other in plain words.
 */
export type TrustTone = 'simulated' | 'unverified' | 'ai' | 'review' | 'plain'

export function trustTone(trust: EvidenceTrust): TrustTone {
  if (trust === 'simulated') return 'simulated'
  if (trust === 'measured_unverified') return 'unverified'
  if (trust === 'model_output') return 'ai'
  if (trust === 'extracted') return 'review'
  return 'plain'
}

/** The trust in the words the screen uses (the contract's). */
export const trustLabel = (trust: EvidenceTrust): string => EVIDENCE_TRUST[trust] ?? trust

/** The parts of the consultation an item can lead to, as the page names them. The local model's draft is shown as the Mana result. */
export const TARGET_LABEL: Record<EvidenceTarget, string> = {
  history: 'History',
  conversation: 'Conversation',
  draft: 'Mana result',
  mana: 'Mana',
  devices: 'Devices',
  thermal: 'Thermal',
  note: 'Note',
}

/** Where on the page each target is (the server's targets are unchanged; the page they lead to was rearranged). */
const TARGET_PART: Record<EvidenceTarget, PartId> = {
  history: 'tools-history',
  conversation: 'tools-conversation',
  draft: 'mana-result',
  mana: 'mana-chat',
  devices: 'tools-devices',
  thermal: 'tools-thermal',
  note: 'consultation-note',
}

/**
 * The element a target is on the consultation page: an input module of the rail (`tools-<id>`), the Mana result, Ask Mana, or the note. A
 * stethoscope recording leads to its own module, whatever target the server gave it (it was under the devices before the stethoscope had one).
 */
export const targetElementId = (target: EvidenceTarget, kind?: EvidenceKind): PartId => (kind === 'stethoscope' ? 'tools-stethoscope' : TARGET_PART[target])

/** The name of the part an item leads to, as `targetElementId` decides it: a stethoscope recording's is the Stethoscope module. */
export const targetLabel = (target: EvidenceTarget, kind?: EvidenceKind): string => (kind === 'stethoscope' ? 'Stethoscope' : TARGET_LABEL[target])

/** What waits for the doctor, one line per part where it is reviewed. */
export interface PendingGroup {
  target: 'conversation' | 'draft' | 'thermal'
  count: number
  text: string
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The pending reviews as the doctor acts on them: the important points (in the conversation), the AI draft's statements (in the AI draft), and
 * the thermal images and summaries together (both reviewed in Thermal). A part with nothing waiting is left out.
 */
export function groupPending(p: PendingReview): PendingGroup[] {
  const out: PendingGroup[] = []
  if (p.points > 0) out.push({ target: 'conversation', count: p.points, text: `${counted(p.points, 'important point', 'important points')} to review` })
  if (p.draftStatements > 0) out.push({ target: 'draft', count: p.draftStatements, text: `${counted(p.draftStatements, 'AI draft statement', 'AI draft statements')} to review` })
  const thermal = [p.thermalImages > 0 ? counted(p.thermalImages, 'thermal image', 'thermal images') : null, p.thermalSummaries > 0 ? counted(p.thermalSummaries, 'thermal summary', 'thermal summaries') : null].filter((s): s is string => s !== null)
  if (thermal.length) out.push({ target: 'thermal', count: Math.max(0, p.thermalImages) + Math.max(0, p.thermalSummaries), text: `${thermal.join(' and ')} to review` })
  return out
}

export type PendingKind = (typeof PENDING_KINDS)[number]

/** Each pending kind in the words of the line that says it is not counted in this view. */
const PENDING_WORDS: Record<PendingKind, string> = {
  points: 'the conversation’s important points',
  draftStatements: 'the AI draft',
  thermalImages: 'the thermal images',
  thermalSummaries: 'the thermal summaries',
}

/**
 * The pending kinds this viewer is not shown, as the server decides it: the important points to doctors only, the AI draft to the consultation's
 * own doctor only. Used only for the words: the server counts what it shows, and lists every kind it did not count in `unread`. With no viewer
 * known, none: a kind the server did not count is then said to be unread, which never claims that nothing waits.
 */
export function pendingNotShown(viewer: { id: string; role: Role } | null | undefined, consultationDoctorId: string): PendingKind[] {
  if (!viewer) return []
  if (viewer.role !== 'doctor') return ['points', 'draftStatements']
  return viewer.id === consultationDoctorId ? [] : ['draftStatements']
}

/** What is said beside the pending reviews: that nothing waits (only when that is known), that the list may be incomplete, and what is reviewed elsewhere. */
export interface ReviewNotes {
  /** "Nothing is waiting for your review.": only when every kind was read and counted for this viewer, none waits, and no two sources disagree. */
  nothingWaiting: boolean
  /** A kind this viewer is shown could not be read: its count is 0 for that reason, so the list may be incomplete. */
  incomplete: string | null
  /** The kinds this viewer is not shown, and who reviews them. */
  notShown: string | null
}

export const INCOMPLETE_REVIEW = 'Some items could not be read just now, so this list may be incomplete.'

/**
 * The notes beside the pending reviews. A kind in `unread` has a count of 0 because it was not counted, not because nothing waits: then nothing
 * here says that nothing waits. A kind not shown to this viewer (`hidden`, from `pendingNotShown`) is said to be reviewed by the consultation's
 * doctor; any other unread kind could not be read just now.
 */
export function reviewNotes(p: PendingReview, conflicts: number, hidden: readonly PendingKind[]): ReviewNotes {
  const unread = PENDING_KINDS.filter((k) => p.unread.includes(k))
  const notShown = unread.filter((k) => hidden.includes(k))
  const failed = unread.filter((k) => !hidden.includes(k))
  const one = notShown.length === 1
  const words = notShown.map((k) => PENDING_WORDS[k])
  const what = words.length > 2 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words.join(' and ')
  return {
    nothingWaiting: !unread.length && conflicts === 0 && !groupPending(p).length,
    incomplete: failed.length ? INCOMPLETE_REVIEW : null,
    notShown: notShown.length ? `${what.charAt(0).toUpperCase()}${what.slice(1)} ${one ? 'is' : 'are'} reviewed by the consultation’s doctor and ${one ? 'is' : 'are'} not counted in this view.` : null,
  }
}

/** Where to look when a conflict's items are not in the evidence (an allergy entry, a record item): the part that holds that kind of record. */
const CONFLICT_FALLBACK: Record<ContextConflict['kind'], EvidenceTarget[]> = {
  vital_staff_vs_device: ['history', 'devices'],
  point_vs_record: ['conversation', 'history'],
  draft_conflict: ['draft'],
  allergy_status: ['history'],
}

/** The parts that show a conflict's two sides: the targets of its items, in order, each once; by its kind when none of its items is listed. */
export function conflictTargets(conflict: ContextConflict, evidence: EvidenceItem[]): EvidenceTarget[] {
  const byId = new Map(evidence.map((i) => [i.id, i.target]))
  const found = [...new Set(conflict.itemIds.map((id) => byId.get(id)).filter((t): t is EvidenceTarget => t !== undefined))]
  return found.length ? found : CONFLICT_FALLBACK[conflict.kind]
}

/** Newest first, by the time each item holds; an item whose time cannot be read goes last; items with the same time keep the server's order. */
export function newestFirst(items: EvidenceItem[]): EvidenceItem[] {
  const time = (i: EvidenceItem) => {
    const t = Date.parse(i.at)
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY
  }
  return items
    .map((item, index) => ({ item, index, t: time(item) }))
    .sort((a, b) => (a.t === b.t ? a.index - b.index : b.t - a.t))
    .map((x) => x.item)
}

/**
 * The items the Overview lists: the newest `limit`, or all of them. `hidden` says how many are not listed, and `hiddenSimulated` how many of
 * those are SIMULATED, so that a simulator's values are never out of sight without the screen saying they exist.
 */
export function visibleEvidence(evidence: EvidenceItem[], showAll: boolean, limit = EVIDENCE_LIMIT): { shown: EvidenceItem[]; hidden: number; hiddenSimulated: number } {
  const sorted = newestFirst(evidence)
  const shown = showAll ? sorted : sorted.slice(0, limit)
  const rest = sorted.slice(shown.length)
  return { shown, hidden: rest.length, hiddenSimulated: rest.filter((i) => i.trust === 'simulated').length }
}

/** True when an item is a device value the server called LIVE: the Overview then looks again every second, so that it turns STALE when the device card's does. */
export const isLiveDeviceItem = (i: Pick<EvidenceItem, 'kind' | 'status'>) => i.kind === 'vital_device' && i.status.trim().toUpperCase() === 'LIVE'

/** How a state is coloured: a device value's LIVE, STALE and DISCONNECTED as the device card colours them (the word is always there); every other neutral. */
export type StatusTone = 'live' | 'stale' | 'disconnected' | 'plain'

/**
 * The tone of the state an item is shown with. Only a device value is coloured as a device state: another kind's "Live" (a conversation still
 * being captured, or one left so when a recording was abandoned) is not a device sending now, and is never drawn as one.
 */
export function statusTone(kind: EvidenceItem['kind'], status: string): StatusTone {
  if (kind !== 'vital_device') return 'plain'
  const s = status.trim().toUpperCase()
  return s === 'LIVE' ? 'live' : s === 'STALE' ? 'stale' : s === 'DISCONNECTED' ? 'disconnected' : 'plain'
}

/**
 * The state an item is shown with at `now` (the server's clock). A device value the server called LIVE is aged as the device card ages it: once it
 * is older than the card's live limit it is STALE. Without that limit (the card has not read yet) it stays LIVE only as of the time the context was
 * read, and `asOfRead` says so. Every other state is shown as the server said it, and nothing is ever made more current than the server said.
 */
export function shownStatus(item: Pick<EvidenceItem, 'kind' | 'status' | 'at'>, now: number, liveSeconds: number | null): { status: string; asOfRead: boolean } {
  if (!isLiveDeviceItem(item)) return { status: item.status, asOfRead: false }
  const at = Date.parse(item.at)
  if (liveSeconds === null || !Number.isFinite(at)) return { status: item.status, asOfRead: true }
  return now - at <= liveSeconds * 1000 ? { status: item.status, asOfRead: false } : { status: 'STALE', asOfRead: false }
}
