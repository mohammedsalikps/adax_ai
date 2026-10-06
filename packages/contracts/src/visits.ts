import { z } from 'zod'
import { NUL_MESSAGE, noNul, OptionalText } from './common.ts'
import { Sex } from './patients.ts'
import { Observation } from './vitals.ts'

export const VisitStatus = z.enum(['waiting', 'in_triage', 'ready', 'in_consultation', 'completed', 'cancelled', 'no_show'])
export type VisitStatus = z.infer<typeof VisitStatus>

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  waiting: 'Waiting',
  in_triage: 'Nurse intake',
  ready: 'Ready for doctor',
  in_consultation: 'With doctor',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'Did not attend',
}

export const OPEN_VISIT_STATUSES: VisitStatus[] = ['waiting', 'in_triage', 'ready', 'in_consultation']

/**
 * Allowed manual status changes (queue). The consultation makes the others:
 * starting or continuing it moves an open visit to `in_consultation`,
 * completing it (after signing; HERO final, signing alone no longer does)
 * completes the visit, and discarding an unsigned draft returns the visit to
 * `ready` (never a visit whose consultation is signed, migration 0033). A
 * visit with an unsigned consultation cannot be cancelled or marked as
 * no-show, and cancelling needs a reason. The database enforces the same
 * rules (migrations 0019 and 0033; a test checks they agree).
 */
export const VISIT_TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  waiting: ['in_triage', 'ready', 'cancelled', 'no_show'],
  in_triage: ['ready', 'waiting', 'cancelled'],
  ready: ['in_triage', 'cancelled', 'no_show'],
  in_consultation: [],
  completed: [],
  cancelled: [],
  no_show: [],
}

export const Priority = z.enum(['normal', 'urgent'])

export const CreateVisitRequest = z.object({
  patientId: z.uuid(),
  departmentId: z.uuid('Choose a department'),
  assignedDoctorId: z.uuid().nullable().optional(),
  priority: Priority.default('normal'),
  chiefComplaint: OptionalText(300),
})
export type CreateVisitRequest = z.input<typeof CreateVisitRequest>

export const UpdateVisitRequest = z
  .object({ departmentId: z.uuid(), assignedDoctorId: z.uuid().nullable(), priority: Priority, chiefComplaint: OptionalText(300) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'No changes supplied')
export type UpdateVisitRequest = z.input<typeof UpdateVisitRequest>

/** `from` is the status the user saw; the change is refused if the visit has moved on since. */
export const ChangeVisitStatusRequest = z.object({ status: VisitStatus, from: VisitStatus.optional(), reason: OptionalText(200) })
export type ChangeVisitStatusRequest = z.input<typeof ChangeVisitStatusRequest>

export const Visit = z.object({
  id: z.uuid(),
  visitDate: z.string(),
  tokenNumber: z.number().int(),
  status: VisitStatus,
  priority: Priority,
  chiefComplaint: z.string().nullable(),
  departmentId: z.uuid(),
  departmentName: z.string(),
  assignedDoctorId: z.uuid().nullable(),
  assignedDoctorName: z.string().nullable(),
  checkedInAt: z.string(),
  updatedAt: z.string(),
  encounterId: z.uuid().nullable(),
  /** The appointment this visit came from, when it was checked in from one (time on the facility's clock). */
  appointment: z.object({ id: z.uuid(), scheduledAt: z.string(), localTime: z.string() }).nullable(),
  patient: z.object({ id: z.uuid(), mrn: z.string(), fullName: z.string(), sex: Sex, dateOfBirth: z.string(), noKnownAllergies: z.boolean(), activeAllergies: z.array(z.string()) }),
  latestVitals: z.array(Observation),
  abnormalVitalCount: z.number().int(),
  // --- HERO final (optional until the visits routes return them) ---
  /** The nurse's (or doctor's) triage note; null when none was written. */
  triageNote: z.string().nullable().optional(),
  /** Who last wrote (or cleared) it, and when. */
  triageNoteBy: z.object({ id: z.uuid(), fullName: z.string(), role: z.string().nullable() }).nullable().optional(),
  triageNoteAt: z.string().nullable().optional(),
  /** The status of the visit's consultation, if it has one (not discarded): in_progress, signed. Signed while the visit is in consultation = "Signed — to complete". */
  encounterStatus: z.enum(['in_progress', 'signed', 'discarded']).nullable().optional(),
})
export type Visit = z.infer<typeof Visit>

/** HERO final: the longest triage note (the database checks the same bound, migration 0033). */
export const TRIAGE_NOTE_MAX = 1000
/** PUT /api/visits/:id/triage-note (nurse or doctor). An empty note clears it. */
export const TriageNoteRequest = z.object({
  note: z
    .string()
    .trim()
    .max(TRIAGE_NOTE_MAX, `At most ${TRIAGE_NOTE_MAX} characters`)
    .refine(noNul, NUL_MESSAGE)
    .transform((v) => (v === '' ? null : v)),
})
export type TriageNoteRequest = z.input<typeof TriageNoteRequest>

export const VisitQuery = z.object({
  date: z.iso.date().optional(),
  status: z.string().optional(),
  departmentId: z.uuid().optional(),
  /** Doctor view: visits assigned to me, plus unassigned ones in my department. */
  mine: z.enum(['true', 'false']).optional(),
})
