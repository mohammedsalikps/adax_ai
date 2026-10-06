import { z } from 'zod'
import { AppointmentStatus } from './appointments.ts'
import { Sex } from './patients.ts'
import { Priority, VisitStatus } from './visits.ts'

// ---------------------------------------------------------------------------
// The doctor's day (Doctor HERO final): Home's counts and trend, and today's patients in time order. One vocabulary for Home, My consultations
// and Mana's deterministic answers: a row is Completed, In consultation, Waiting or Yet to see (or Cancelled, which is not counted).
//
// "Mine" is what the visits and appointments routes mean by mine=true: assigned to the doctor, or unassigned in the doctor's department.
// Every day boundary is the facility's calendar day (its timezone), never the browser's clock: the server says what `today` is.
// ---------------------------------------------------------------------------

export const DoctorDayPeriod = z.enum(['today', 'week', 'month'])
export type DoctorDayPeriod = z.infer<typeof DoctorDayPeriod>
export const DOCTOR_DAY_PERIOD_LABELS: Record<DoctorDayPeriod, string> = { today: 'Today', week: 'Week', month: 'Month' }

/** GET /api/doctor/day?period=today|week|month */
export const DoctorDayQuery = z.object({ period: DoctorDayPeriod.default('today') })
export type DoctorDayQuery = z.input<typeof DoctorDayQuery>

export const DoctorQueueStatus = z.enum(['completed', 'in_consultation', 'waiting', 'yet_to_see', 'cancelled'])
export type DoctorQueueStatus = z.infer<typeof DoctorQueueStatus>
export const DOCTOR_QUEUE_STATUS_LABELS: Record<DoctorQueueStatus, string> = {
  completed: 'Completed',
  in_consultation: 'In consultation',
  waiting: 'Waiting',
  yet_to_see: 'Yet to see',
  cancelled: 'Cancelled',
}

/** What the shared StatusPill shows for a row: the queue status, with a signed consultation that still has to be completed told apart. */
export type DoctorQueuePill = DoctorQueueStatus | 'signed_to_complete'
export const DOCTOR_QUEUE_PILL_LABELS: Record<DoctorQueuePill, string> = { ...DOCTOR_QUEUE_STATUS_LABELS, signed_to_complete: 'Signed — to complete' }

/** The facts a row's status is decided from. A visit decides when there is one; otherwise the appointment does. */
export interface DoctorQueueInput {
  visitStatus?: VisitStatus | null
  /** The visit's consultation, if any (not discarded). */
  encounterStatus?: 'in_progress' | 'signed' | 'discarded' | null
  appointmentStatus?: AppointmentStatus | null
}

/**
 * The one status vocabulary of the doctor's day:
 * - a visit: waiting, in_triage, ready -> waiting; in_consultation -> in_consultation; completed -> completed; cancelled, no_show -> cancelled;
 * - no visit, an appointment: booked (overdue included) -> yet_to_see; checked_in -> waiting; completed -> completed; cancelled, rescheduled,
 *   no_show -> cancelled;
 * - neither: cancelled (never counted).
 */
export function doctorQueueStatus(row: DoctorQueueInput): DoctorQueueStatus {
  switch (row.visitStatus) {
    case 'waiting':
    case 'in_triage':
    case 'ready':
      return 'waiting'
    case 'in_consultation':
      return 'in_consultation'
    case 'completed':
      return 'completed'
    case 'cancelled':
    case 'no_show':
      return 'cancelled'
    default:
      break
  }
  switch (row.appointmentStatus) {
    case 'booked':
      return 'yet_to_see'
    case 'checked_in':
      return 'waiting'
    case 'completed':
      return 'completed'
    default:
      return 'cancelled'
  }
}

/** In consultation, and its consultation is signed: the doctor still has to complete it (signing no longer completes the visit). */
export function isSignedToComplete(row: DoctorQueueInput): boolean {
  return doctorQueueStatus(row) === 'in_consultation' && row.encounterStatus === 'signed'
}

/** The pill a row shows (StatusPill `status`). */
export function doctorQueuePill(row: DoctorQueueInput): DoctorQueuePill {
  return isSignedToComplete(row) ? 'signed_to_complete' : doctorQueueStatus(row)
}

export interface DoctorQueueCounts {
  /** Completed today (Patients seen). */
  seen: number
  waiting: number
  inConsultation: number
  yetToSee: number
  /** Everything except cancelled. */
  total: number
}

/** Counts of a day's rows, in the shared vocabulary. */
export function countDoctorQueue(statuses: readonly DoctorQueueStatus[]): DoctorQueueCounts {
  const c: DoctorQueueCounts = { seen: 0, waiting: 0, inConsultation: 0, yetToSee: 0, total: 0 }
  for (const s of statuses) {
    if (s === 'cancelled') continue
    c.total++
    if (s === 'completed') c.seen++
    else if (s === 'waiting') c.waiting++
    else if (s === 'in_consultation') c.inConsultation++
    else c.yetToSee++
  }
  return c
}

/**
 * Time order of the queue and the timeline: the appointment time when the row has one, otherwise the check-in time. Urgent rows are not moved
 * (they show a pill). Returns epoch milliseconds; a row with neither time sorts last.
 */
export function doctorQueueSortKey(row: { scheduledAt?: string | null; checkedInAt?: string | null }): number {
  const at = row.scheduledAt ?? row.checkedInAt
  const ms = at ? Date.parse(at) : Number.NaN
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/** Comparator for Array.prototype.sort: time order, then the patient's name, then the row key (stable across polls). */
export function compareDoctorQueueRows(
  a: { scheduledAt?: string | null; checkedInAt?: string | null; patient?: { fullName: string }; key?: string },
  b: { scheduledAt?: string | null; checkedInAt?: string | null; patient?: { fullName: string }; key?: string },
): number {
  const ka = doctorQueueSortKey(a)
  const kb = doctorQueueSortKey(b)
  if (ka !== kb) return ka < kb ? -1 : 1
  const n = (a.patient?.fullName ?? '').localeCompare(b.patient?.fullName ?? '')
  return n !== 0 ? n : (a.key ?? '').localeCompare(b.key ?? '')
}

// --- Facility calendar days (YYYY-MM-DD; pure arithmetic, no timezone: the server supplies `today` on the facility's clock) ---------------

const ymd = (date: string): [number, number, number] => date.split('-').map(Number) as [number, number, number]
const iso = (d: Date) => d.toISOString().slice(0, 10)

/** A calendar day plus n days. */
export function addDaysIso(date: string, n: number): string {
  const [y, m, d] = ymd(date)
  return iso(new Date(Date.UTC(y, m - 1, d + n)))
}

/** Monday of the calendar week of `date` (weeks start on Monday). */
export function weekStartIso(date: string): string {
  const [y, m, d] = ymd(date)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  return addDaysIso(date, -((dow + 6) % 7))
}

/** The first day of the calendar month of `date`. */
export function monthStartIso(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** The days of a period up to and including today: Today = today; Week = Monday to today; Month = the 1st to today. */
export function doctorDayRange(period: DoctorDayPeriod, today: string): { from: string; to: string; days: string[] } {
  const from = period === 'today' ? today : period === 'week' ? weekStartIso(today) : monthStartIso(today)
  const days: string[] = []
  for (let d = from; d <= today; d = addDaysIso(d, 1)) days.push(d)
  return { from, to: today, days }
}

// --- The response -----------------------------------------------------------------------------------------------------------------------

/**
 * Counts for the period. For Today: seen, waiting, inConsultation, yetToSee and total are today's rows in the shared vocabulary. For Week and
 * Month (facility calendar week Monday -> today, calendar month to date): seen = my completed visits in the period, consultations = my
 * consultations started (not discarded), completed = my consultations completed, patients = distinct patients of those consultations; waiting,
 * inConsultation and yetToSee are always today's (Week shows "Remaining today" = waiting + inConsultation + yetToSee). A count is a number only
 * when it was counted: the server never pads.
 */
export const DoctorDayCounts = z.object({
  seen: z.number().int().min(0),
  waiting: z.number().int().min(0),
  inConsultation: z.number().int().min(0),
  yetToSee: z.number().int().min(0),
  total: z.number().int().min(0),
  consultations: z.number().int().min(0),
  completed: z.number().int().min(0),
  patients: z.number().int().min(0),
})
export type DoctorDayCounts = z.infer<typeof DoctorDayCounts>

/** One facility day of the period (every day from `from` to `to`, zero included when it was counted). */
export const DoctorDayTrendPoint = z.object({ date: z.string(), seen: z.number().int().min(0), consultations: z.number().int().min(0) })
export type DoctorDayTrendPoint = z.infer<typeof DoctorDayTrendPoint>

/** One of today's patients: a visit (checked in), or a booked appointment that has no visit yet. */
export const DoctorDayTimelineRow = z.object({
  /** Stable key: "visit:<id>" or "appointment:<id>". */
  key: z.string(),
  status: DoctorQueueStatus,
  /** In consultation with a signed consultation that is not completed yet. */
  signedToComplete: z.boolean(),
  /** Clock time on the facility's clock (HH:MM): the appointment's, else the check-in's. */
  time: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  checkedInAt: z.string().nullable(),
  /** A booked appointment whose time has passed (still "yet to see"). */
  overdue: z.boolean(),
  priority: Priority,
  /** The reason for the visit (or the appointment), as typed by staff. */
  reason: z.string().nullable(),
  patient: z.object({
    id: z.uuid(),
    mrn: z.string(),
    fullName: z.string(),
    sex: Sex,
    dateOfBirth: z.string(),
    noKnownAllergies: z.boolean(),
    activeAllergies: z.array(z.string()),
  }),
  visitId: z.uuid().nullable(),
  visitStatus: VisitStatus.nullable(),
  encounterId: z.uuid().nullable(),
  encounterStatus: z.enum(['in_progress', 'signed', 'discarded']).nullable(),
  /** The consultation is the signed-in doctor's own (Continue / Complete are offered only then). */
  encounterMine: z.boolean(),
  appointmentId: z.uuid().nullable(),
  appointmentStatus: AppointmentStatus.nullable(),
})
export type DoctorDayTimelineRow = z.infer<typeof DoctorDayTimelineRow>

export const DoctorDay = z.object({
  period: DoctorDayPeriod,
  /** The facility's timezone and calendar day (all boundaries are on this clock). */
  timezone: z.string(),
  today: z.string(),
  /** First and last day of the period (inclusive). */
  from: z.string(),
  to: z.string(),
  counts: DoctorDayCounts,
  /** One point per day of the period (Today: one point). */
  trend: z.array(DoctorDayTrendPoint),
  /** Today's patients, always today's whatever the period, in time order (doctorQueueSortKey). */
  timeline: z.array(DoctorDayTimelineRow),
  generatedAt: z.string(),
})
export type DoctorDay = z.infer<typeof DoctorDay>
