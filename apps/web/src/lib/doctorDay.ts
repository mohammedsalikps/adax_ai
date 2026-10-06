import { type DoctorDay, type DoctorDayPeriod, type DoctorDayTimelineRow, type DoctorDayTrendPoint, doctorQueuePill, type Encounter, SEX_LABELS, type VisitStatus } from '@adaxai/contracts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from './api.ts'

/**
 * The doctor's day on the client (DESIGN §3, §5.1-5.2): one query (GET /api/doctor/day) behind Home and My consultations, and the pure rules
 * both pages show it by — which rows a filter keeps, which one action a row offers, the small words beside a status, who just became ready,
 * how tall a trend bar is. Every count and status comes from the server; nothing here counts patients or decides a status on its own (the
 * status is contracts' doctorQueueStatus, computed by the server). No React here except the query hook, so the rules are unit-tested in node
 * (test/doctorDay.test.ts).
 */

/** How often Home and My consultations ask again while the page is visible (DESIGN: 30 s, not the old 5 s; each read is audited). */
export const DOCTOR_DAY_POLL_MS = 30_000

export const doctorDayKey = (period: DoctorDayPeriod) => ['doctor-day', period] as const

/**
 * The doctor's day for a period. Polled every 30 s while the tab is visible (not in the background), asked again whenever a page showing it
 * mounts (staleTime 0: the consultation and prescription pages change it without invalidating this query), and on window focus. While another
 * period loads, the previous answer stays as placeholder: its timeline is today's whatever the period, but its counts are not the new
 * period's (tilesFor shows them only for the period they were counted for).
 */
export function useDoctorDay(period: DoctorDayPeriod) {
  return useQuery({
    queryKey: doctorDayKey(period),
    queryFn: () => api<DoctorDay>('/doctor/day', { query: { period } }),
    refetchInterval: DOCTOR_DAY_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
    placeholderData: keepPreviousData,
  })
}

/** A period from the URL (`?period=`); anything else is Today. */
export function periodFrom(value: string | null): DoctorDayPeriod {
  return value === 'week' || value === 'month' ? value : 'today'
}

// --- Home: the tiles ----------------------------------------------------------------------------------------------------------------------

export interface DayTile {
  label: string
  /** Null: not counted for this period (yet) — shown as "—" with "not available", never as 0. */
  value: number | null
  hint?: string
  testId: string
}

/**
 * The tiles of a period (DESIGN §5.1). Today: Patients seen · Waiting · Yet to see · Total ("n in consultation" under Total when n > 0).
 * Week: Patients seen · Consultations · Completed · Remaining today. Month: Patients seen · Consultations · Completed.
 * "Patients seen" is one number on every period (DESIGN §3, counts.seen): my visits completed in the period — never counts.patients (the
 * different patients of any consultation, in-progress ones included), which would put a larger "seen" beside a smaller "Completed".
 * `day` must be the answer for `period`; any other answer (a placeholder of another period, or none) gives null values, never stale numbers.
 */
export function tilesFor(period: DoctorDayPeriod, day: Pick<DoctorDay, 'period' | 'counts'> | undefined): DayTile[] {
  const c = day && day.period === period ? day.counts : null
  const v = (n: number | undefined) => (c && n !== undefined ? n : null)
  if (period === 'today') {
    return [
      { label: 'Patients seen', value: v(c?.seen), hint: 'Completed today', testId: 'day-seen' },
      { label: 'Waiting', value: v(c?.waiting), hint: 'Checked in', testId: 'day-waiting' },
      { label: 'Yet to see', value: v(c?.yetToSee), hint: 'Booked, not arrived', testId: 'day-yet-to-see' },
      { label: 'Total', value: v(c?.total), ...(c && c.inConsultation > 0 && { hint: `${c.inConsultation} in consultation` }), testId: 'day-total' },
    ]
  }
  const tiles: DayTile[] = [
    { label: 'Patients seen', value: v(c?.seen), hint: period === 'week' ? 'Completed this week' : 'Completed this month', testId: 'day-seen' },
    { label: 'Consultations', value: v(c?.consultations), hint: 'Started, not discarded', testId: 'day-consultations' },
    { label: 'Completed', value: v(c?.completed), hint: 'Consultations completed', testId: 'day-completed' },
  ]
  if (period === 'week') tiles.push({ label: 'Remaining today', value: c ? c.waiting + c.inConsultation + c.yetToSee : null, hint: 'Waiting, in consultation or yet to see', testId: 'day-remaining' })
  return tiles
}

// --- My consultations: the filter --------------------------------------------------------------------------------------------------------

export const QUEUE_FILTERS = ['all', 'waiting', 'completed'] as const
export type QueueFilter = (typeof QUEUE_FILTERS)[number]
export const QUEUE_FILTER_LABELS: Record<QueueFilter, string> = { all: 'All', waiting: 'Waiting', completed: 'Completed' }

/** The rows a filter keeps: All, or the rows whose pill says that word (Waiting includes those ready for the doctor; never re-ordered). */
export function filterTimeline<R extends Pick<DoctorDayTimelineRow, 'status'>>(rows: readonly R[], filter: QueueFilter): R[] {
  return filter === 'all' ? [...rows] : rows.filter((r) => r.status === filter)
}

/** What the page says when a filter keeps nothing (one muted sentence; missing is said as such). */
export const QUEUE_FILTER_EMPTY: Record<QueueFilter, string> = {
  all: 'Nobody is booked or checked in for you today.',
  waiting: 'Nobody is waiting for you right now.',
  completed: 'No consultation is completed yet today.',
}

/**
 * The consultation just completed, from the router state the prescription page navigates back with (`{completedEncounterId}`; `{completed}` is
 * read too): its row is drawn highlighted. Anything else is null.
 */
export function completedFrom(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null
  const s = state as Record<string, unknown>
  const id = s.completedEncounterId ?? s.completed
  return typeof id === 'string' && id ? id : null
}

/** How many rows each filter keeps (shown beside its name). */
export function filterCounts(rows: readonly Pick<DoctorDayTimelineRow, 'status'>[]): Record<QueueFilter, number> {
  return { all: rows.length, waiting: filterTimeline(rows, 'waiting').length, completed: filterTimeline(rows, 'completed').length }
}

// --- One row ----------------------------------------------------------------------------------------------------------------------------

/**
 * The one action of a row (DESIGN §5.1-5.2):
 * - start: an open visit with no consultation yet (Start consultation; recording starts on its own in the workspace);
 * - resume: the visit is back in the queue with my own unsigned draft (Continue consultation; the server resumes it);
 * - continue: in consultation, my own draft (Continue consultation; just opens it);
 * - complete: in consultation, my consultation signed and not completed (Complete, on the prescription page's signed state);
 * - open: completed (Open the record), or another doctor's draft on a visit in the queue (read only);
 * - none: yet to see (not arrived), cancelled, or in another doctor's consultation.
 */
export type TodayActionKind = 'start' | 'resume' | 'continue' | 'complete' | 'open'
export const TODAY_ACTION_LABELS: Record<TodayActionKind, string> = {
  start: 'Start consultation',
  resume: 'Continue consultation',
  continue: 'Continue consultation',
  complete: 'Complete',
  open: 'Open',
}

type ActionFacts = Pick<DoctorDayTimelineRow, 'status' | 'signedToComplete' | 'visitId' | 'encounterId' | 'encounterStatus' | 'encounterMine'>

export function todayAction(row: ActionFacts): TodayActionKind | null {
  switch (row.status) {
    case 'completed':
      return row.encounterId ? 'open' : null
    case 'in_consultation':
      if (!row.encounterId || !row.encounterMine) return null
      return row.signedToComplete ? 'complete' : 'continue'
    case 'waiting':
      if (!row.visitId) return null
      if (row.encounterId && row.encounterStatus === 'in_progress') return row.encounterMine ? 'resume' : 'open'
      return row.encounterId ? 'open' : 'start'
    default:
      return null
  }
}

/** Where a link action goes: the record (Open), or the prescription page whose signed state holds Complete consultation (DESIGN §5.6). */
export function todayActionHref(kind: 'open' | 'complete' | 'continue', encounterId: string): string {
  return kind === 'complete' ? `/doctor/encounters/${encounterId}/prescription` : `/doctor/encounters/${encounterId}`
}

/** The StatusPill of a row: its queue status, or "Signed — to complete". */
export const rowPill = (row: Pick<DoctorDayTimelineRow, 'visitStatus' | 'encounterStatus' | 'appointmentStatus'>) =>
  doctorQueuePill({ visitStatus: row.visitStatus, encounterStatus: row.encounterStatus, appointmentStatus: row.appointmentStatus })

/**
 * The few words beside a Waiting or Yet-to-see pill that say where the patient is: handed over by the nurse ("Ready for doctor", the exact
 * words of the visit status), still with the nurse, or booked and past their time. Nothing for the other states (the pill says it all).
 */
export function stageNote(row: Pick<DoctorDayTimelineRow, 'status' | 'visitStatus' | 'overdue'>): string | null {
  if (row.status === 'waiting') return row.visitStatus === 'ready' ? 'Ready for doctor' : row.visitStatus === 'waiting' || row.visitStatus === 'in_triage' ? 'With the nurse' : null
  if (row.status === 'yet_to_see') return row.overdue ? 'Overdue' : null
  return null
}

/** Whole years between a birth date and a facility day (both YYYY-MM-DD). */
export function ageOnDay(dob: string, day: string): number | null {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number]
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  if (![by, bm, bd, y, m, d].every(Number.isFinite)) return null
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0)
}

/** "34 y · Female · 000123" (age · sex · MRN): the small line under the name, the age on the facility's day. */
export function rowDetail(patient: Pick<DoctorDayTimelineRow['patient'], 'dateOfBirth' | 'sex' | 'mrn'>, today: string): string {
  const age = ageOnDay(patient.dateOfBirth, today)
  return [age === null ? null : `${age} y`, SEX_LABELS[patient.sex], patient.mrn].filter(Boolean).join(' · ')
}

// --- The patient-ready cue ----------------------------------------------------------------------------------------------------------------

/** What the last answer said each row's visit was (by row key); null before the first answer. */
export type ReadySnapshot = ReadonlyMap<string, VisitStatus | null> | null

export function readySnapshot(rows: readonly Pick<DoctorDayTimelineRow, 'key' | 'visitStatus'>[]): Map<string, VisitStatus | null> {
  return new Map(rows.map((r) => [r.key, r.visitStatus]))
}

/**
 * The rows that became ready for the doctor since the previous answer (a client diff of the poll; no new backend): ready now, and not ready
 * (or not listed) before. The first answer announces nothing: a page that opens is not news.
 */
export function readyArrivals<R extends Pick<DoctorDayTimelineRow, 'key' | 'visitStatus'>>(previous: ReadySnapshot, rows: readonly R[]): R[] {
  if (!previous) return []
  return rows.filter((r) => r.visitStatus === 'ready' && previous.get(r.key) !== 'ready')
}

/** "Anaya Demo-Synthetic is ready for you"; two or more are named together. */
export function readyMessage(names: readonly string[]): string {
  if (names.length <= 1) return `${names[0] ?? 'A patient'} is ready for you`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are ready for you`
}

// --- The trend (Week and Month) ---------------------------------------------------------------------------------------------------------

export interface TrendBar {
  date: string
  value: number
  /** Height as a percentage of the tallest bar (0-100); 0 for a counted zero. */
  percent: number
}

/** Bars of one series of the trend, scaled to the tallest day. All-zero stays all-zero (never a fake 100 %). */
export function trendBars(points: readonly DoctorDayTrendPoint[], key: 'consultations' | 'seen'): TrendBar[] {
  const max = Math.max(0, ...points.map((p) => p[key]))
  return points.map((p) => ({ date: p.date, value: p[key], percent: max > 0 ? Math.round((p[key] / max) * 100) : 0 }))
}

/**
 * Column widths of the trend (rem). A week keeps a calm width (a Tuesday's two days are not stretched across the panel); a month's columns
 * shrink to two printed digits, so a whole month fits the panel from a 1024px screen up (sidebar open) and only a phone scrolls sideways.
 */
const TREND_COLUMN_REM = { week: { min: 2.5, max: 4.5 }, month: { min: 1.125, max: 2.25 } } as const
/** The gap between two columns of the trend (rem). */
export const TREND_GAP_REM = 0.125

/** The CSS grid columns of a trend of `count` days. */
export function trendGridColumns(period: Exclude<DoctorDayPeriod, 'today'>, count: number): string {
  const { min, max } = TREND_COLUMN_REM[period]
  return `repeat(${count}, minmax(${min}rem, ${max}rem))`
}

/** The narrowest a trend of `count` days can be drawn (rem); a narrower panel scrolls it sideways (a focusable region then). */
export function trendMinWidthRem(period: Exclude<DoctorDayPeriod, 'today'>, count: number): number {
  return count * TREND_COLUMN_REM[period].min + Math.max(0, count - 1) * TREND_GAP_REM
}

/** The day under a bar: the weekday for a week ("Mon"), the day of the month for a month ("5"). The date is a calendar day: no timezone. */
export function trendDayLabel(date: string, period: DoctorDayPeriod): string {
  const d = new Date(`${date}T00:00:00Z`)
  return period === 'month' ? String(d.getUTCDate()) : new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(d)
}

/** "Tuesday 6 October" for the accessible table and titles. */
export function longDay(date: string): string {
  return new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
}

/** "Tue, 6 Oct 2026": the facility's calendar day under the page title. */
export function facilityDateLine(date: string): string {
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
}

// --- Greeting -------------------------------------------------------------------------------------------------------------------------------

/** Good morning / afternoon / evening on the facility's clock when its timezone is known (else the device's). */
export function greetingAt(now: Date, timezone?: string): 'Good morning' | 'Good afternoon' | 'Good evening' {
  let hour = now.getHours()
  if (timezone) {
    try {
      hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(now))
    } catch {
      // An unknown timezone name: keep the device's hour.
    }
  }
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
}

/** "Dr. Meera Iyer (synthetic)" is "Meera". */
export const firstName = (full: string | undefined) =>
  (full ?? '')
    .replace(/\([^)]*\)/g, '')
    .replace(/^dr\.?\s+/i, '')
    .trim()
    .split(/\s+/)[0] ?? ''

// --- Starting a consultation ---------------------------------------------------------------------------------------------------------------

/** What a caller of useStartConsultation knows about the visit: its id, and the consultation its row showed (null: none; undefined: unknown). */
export interface StartConsultationInput {
  visitId: string
  encounterId?: string | null
}

/**
 * Whether a start created a NEW consultation, so the workspace may start recording on its own (router state `autoRecord`): only when the
 * caller's row showed no consultation, and the server answered with a fresh draft the doctor can edit. A resume, a read of someone else's
 * record, or a caller that does not say what it saw (a bare visit id) never auto-records.
 */
export function isNewConsultationStart(input: string | StartConsultationInput, e: Pick<Encounter, 'status' | 'canEdit' | 'version'>): boolean {
  return typeof input !== 'string' && input.encounterId === null && e.status === 'in_progress' && e.canEdit && e.version === 1
}
