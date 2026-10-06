import { z } from 'zod'
import { ConsentType } from './patients.ts'
import { VitalKind } from './vitals.ts'

/**
 * Patient portal: the signed-in patient's OWN records only. The patient is
 * identified from the session, never from a request parameter.
 */

export const PortalProfile = z.object({
  mrn: z.string(),
  fullName: z.string(),
  dateOfBirth: z.string(),
  sex: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  bloodGroup: z.string().nullable(),
  preferredLanguage: z.string().nullable(),
  emergencyContact: z.object({ name: z.string().nullable(), phone: z.string().nullable() }),
  allergies: z.array(z.object({ substance: z.string(), reaction: z.string().nullable(), severity: z.string() })),
  noKnownAllergies: z.boolean(),
  facilityName: z.string(),
})
export type PortalProfile = z.infer<typeof PortalProfile>

export const PortalVisit = z.object({
  id: z.uuid(),
  visitDate: z.string(),
  tokenNumber: z.number(),
  departmentName: z.string(),
  doctorName: z.string().nullable(),
  status: z.string(),
  reasonForVisit: z.string().nullable(),
  /** Set when the visit has a signed consultation record that the doctor has completed (the patient can open it). */
  recordId: z.uuid().nullable(),
})
export type PortalVisit = z.infer<typeof PortalVisit>

export const PortalPrescriptionItem = z.object({ drugName: z.string(), strength: z.string(), form: z.string(), dose: z.string(), route: z.string(), frequency: z.string(), duration: z.string(), instructions: z.string() })

export const PortalRecordSummary = z.object({
  id: z.uuid(),
  signedAt: z.string(),
  doctorName: z.string(),
  departmentName: z.string(),
  chiefComplaint: z.string(),
  diagnoses: z.array(z.object({ description: z.string(), code: z.string().nullable() })),
  prescriptionCount: z.number(),
  followUp: z.string(),
})
export type PortalRecordSummary = z.infer<typeof PortalRecordSummary>

/**
 * A completed consultation's signed record exactly as signed, with any later amendments. The patient sees a record once the doctor has
 * completed the consultation (signing alone is not enough, HERO final).
 */
export const PortalRecord = PortalRecordSummary.extend({
  doctorRegistrationNumber: z.string().nullable(),
  history: z.string(),
  examination: z.string(),
  assessment: z.string(),
  plan: z.string(),
  // HERO final (optional, additive): each medicine's structured duration and where its course is today (see MedicineCourse below).
  prescription: z.array(PortalPrescriptionItem.extend({ durationDays: z.number().int().nullable().optional(), startDate: z.string().nullable().optional(), course: z.lazy(() => MedicineCourse).optional() })),
  amendments: z.array(z.object({ createdAt: z.string(), authorName: z.string(), reason: z.string(), content: z.string() })),
  contentHash: z.string(),
  /** HERO final: the facility's calendar day the courses were computed for. */
  today: z.string().optional(),
})
export type PortalRecord = z.infer<typeof PortalRecord>

export const PortalVital = z.object({ kind: VitalKind, value: z.number(), unit: z.string(), measuredAt: z.string(), source: z.enum(['manual', 'device']) })
export type PortalVital = z.infer<typeof PortalVital>

export const PortalConsent = z.object({
  id: z.uuid(),
  type: ConsentType,
  title: z.string(),
  /** The current wording; `currentWording` says whether the patient agreed to this wording or an earlier one. */
  description: z.string(),
  status: z.enum(['granted', 'withdrawn', 'superseded']),
  scope: z.string(),
  method: z.string(),
  recordedAt: z.string(),
  withdrawnAt: z.string().nullable(),
  withdrawnVia: z.string().nullable(),
  version: z.string(),
  currentWording: z.boolean(),
  /** What withdrawing changes at once (for active consents). */
  withdrawalEffect: z.string().nullable(),
})
export type PortalConsent = z.infer<typeof PortalConsent>

/** Doctor-approved thermal measurements: measurements only, never a diagnosis. */
export const PortalThermalReport = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  bodyRegion: z.string(),
  reviewedAt: z.string().nullable(),
  pairs: z.array(z.object({ a: z.string(), b: z.string(), meanDiff: z.number().nullable() })),
  camera: z.string().nullable(),
  dataOrigin: z.string(),
})
export type PortalThermalReport = z.infer<typeof PortalThermalReport>

export const PortalHome = z.object({
  profile: z.object({ fullName: z.string(), mrn: z.string() }),
  upcoming: z.array(z.object({ recordId: z.uuid(), signedAt: z.string(), followUp: z.string(), doctorName: z.string() })),
  lastVisit: PortalVisit.nullable(),
  counts: z.object({ records: z.number(), visits: z.number() }),
})
export type PortalHome = z.infer<typeof PortalHome>

// ---------------------------------------------------------------------------
// HERO final: the prescription of the patient's latest COMPLETED consultation ("Today's prescription" on Portal Home), from the same signed
// rows as the record (no copy). A course's day is derived from the medicine's stored start date and duration in days, on the facility's
// calendar; a medicine without a structured duration says so ("Duration not recorded"), never "Completed".
// ---------------------------------------------------------------------------

/** Where a medicine's course is: active (day N of M), completed (its last day has come), not started, or no structured duration recorded. */
export const CourseState = z.enum(['active', 'completed', 'not_started', 'duration_not_recorded'])
export type CourseState = z.infer<typeof CourseState>

export const MedicineCourse = z.object({
  state: CourseState,
  /** Day of the course today (1 = the start date), capped at the course length; null when there is no structured duration or it has not started. */
  day: z.number().int().nullable(),
  totalDays: z.number().int().nullable(),
  /** Days after today (0 on the last day); null when there is no structured duration. */
  daysLeft: z.number().int().nullable(),
  startDate: z.string().nullable(),
  /** The last day of the course (start + duration - 1). */
  endDate: z.string().nullable(),
})
export type MedicineCourse = z.infer<typeof MedicineCourse>

const dayNumber = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000)
}
const dateOfDayNumber = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10)

/**
 * A medicine's course on `today` (YYYY-MM-DD, the facility's calendar day). Day 1 is the start date; on the last day (day M of M) and after it
 * the course is completed. Without both a start date and a duration in days the state is duration_not_recorded.
 */
export function medicineCourse(item: { durationDays?: number | null; startDate?: string | null }, today: string): MedicineCourse {
  const total = item.durationDays ?? null
  const start = item.startDate ?? null
  if (!total || total < 1 || !start) return { state: 'duration_not_recorded', day: null, totalDays: total, daysLeft: null, startDate: start, endDate: null }
  const endDate = dateOfDayNumber(dayNumber(start) + total - 1)
  const n = dayNumber(today) - dayNumber(start) + 1
  if (n < 1) return { state: 'not_started', day: null, totalDays: total, daysLeft: total, startDate: start, endDate }
  const day = Math.min(n, total)
  return { state: n >= total ? 'completed' : 'active', day, totalDays: total, daysLeft: Math.max(total - n, 0), startDate: start, endDate }
}

/** The course line the patient reads: "Day 3 of 7 · 4 days left", "Day 7 of 7 · Completed", "Completed", "Starts 12 Oct", "Duration not recorded". */
export function medicineCourseLabel(c: MedicineCourse, today?: string): string {
  switch (c.state) {
    case 'duration_not_recorded':
      return 'Duration not recorded'
    case 'not_started':
      return c.startDate ? `Starts ${c.startDate}` : 'Not started'
    case 'completed':
      return today && c.endDate === today ? `Day ${c.totalDays} of ${c.totalDays} · Completed` : 'Completed'
    case 'active':
      return `Day ${c.day} of ${c.totalDays} · ${c.daysLeft} ${c.daysLeft === 1 ? 'day' : 'days'} left`
  }
}

export const PortalCurrentPrescriptionItem = PortalPrescriptionItem.extend({
  durationDays: z.number().int().nullable(),
  startDate: z.string().nullable(),
  course: MedicineCourse,
})
export type PortalCurrentPrescriptionItem = z.infer<typeof PortalCurrentPrescriptionItem>

export const PortalCurrentPrescription = z.object({
  /** The record (GET /api/portal/records/:id opens it). */
  recordId: z.uuid(),
  /** The consultation's date (the visit's calendar day) and when it was signed and completed. */
  date: z.string(),
  signedAt: z.string(),
  completedAt: z.string(),
  doctorName: z.string(),
  doctorRegistrationNumber: z.string().nullable(),
  departmentName: z.string(),
  diagnoses: z.array(z.object({ description: z.string(), code: z.string().nullable() })),
  items: z.array(PortalCurrentPrescriptionItem),
  /** Advice and diet (the note's plan) and follow-up, as signed. */
  advice: z.string(),
  followUp: z.string(),
})
export type PortalCurrentPrescription = z.infer<typeof PortalCurrentPrescription>

/** GET /api/portal/prescriptions/current: null when no consultation of the patient has been completed yet. */
export const PortalCurrentPrescriptionResponse = z.object({
  /** The facility's calendar day the courses were computed for. */
  today: z.string(),
  prescription: PortalCurrentPrescription.nullable(),
})
export type PortalCurrentPrescriptionResponse = z.infer<typeof PortalCurrentPrescriptionResponse>
