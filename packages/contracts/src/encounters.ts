import { z } from 'zod'
import { Text } from './common.ts'
import { NoteInsertion } from './mana.ts'
import { Sex } from './patients.ts'
import { Priority, VisitStatus } from './visits.ts'
import { Observation } from './vitals.ts'

const NoteText = (max: number) => z.string().max(max, `At most ${max} characters`)

/** Maximum length of each note section (characters). */
export const NOTE_SECTION_MAX = { chiefComplaint: 1000, history: 8000, pastHistory: 4000, examination: 8000, assessment: 4000, plan: 8000, followUp: 1000 } as const

/** Free-text sections of the consultation note (SOAP-style). */
export const NoteFields = z.object({
  chiefComplaint: NoteText(NOTE_SECTION_MAX.chiefComplaint),
  history: NoteText(NOTE_SECTION_MAX.history),
  pastHistory: NoteText(NOTE_SECTION_MAX.pastHistory),
  examination: NoteText(NOTE_SECTION_MAX.examination),
  assessment: NoteText(NOTE_SECTION_MAX.assessment),
  plan: NoteText(NOTE_SECTION_MAX.plan),
  followUp: NoteText(NOTE_SECTION_MAX.followUp),
})
export type NoteFields = z.infer<typeof NoteFields>
export const NOTE_SECTIONS: { key: keyof NoteFields; label: string; rows: number; hint?: string }[] = [
  { key: 'chiefComplaint', label: 'Chief complaint', rows: 2 },
  { key: 'history', label: 'History of present illness', rows: 5 },
  { key: 'pastHistory', label: 'Medical history', rows: 3, hint: 'Past illnesses, surgeries, current medicines, family and social history.' },
  { key: 'examination', label: 'Examination', rows: 5 },
  { key: 'assessment', label: 'Assessment', rows: 3 },
  { key: 'plan', label: 'Plan', rows: 4, hint: 'Investigations, treatment and advice.' },
  { key: 'followUp', label: 'Follow-up', rows: 2 },
]
export const EMPTY_NOTE: NoteFields = { chiefComplaint: '', history: '', pastHistory: '', examination: '', assessment: '', plan: '', followUp: '' }

export const DiagnosisKind = z.enum(['provisional', 'primary', 'secondary'])
const draftText = (max: number) => z.string().trim().max(max, `At most ${max} characters`).default('')

/**
 * Draft rows are saved while the doctor is still typing, so they may be
 * incomplete. Completeness is enforced at signing (see signIssues).
 */
export const DiagnosisInput = z.object({
  description: draftText(300),
  /** ICD-10 code as typed by the doctor; format-checked at signing, not validated against a code set. */
  code: z
    .string()
    .trim()
    .max(12)
    .transform((v) => (v === '' ? null : v.toUpperCase()))
    .nullable()
    .optional(),
  kind: DiagnosisKind.default('primary'),
})
export type DiagnosisInput = z.input<typeof DiagnosisInput>

/** HERO final: the longest structured course, in days (the database checks the same bound, migration 0033). */
export const PRESCRIPTION_DURATION_DAYS_MAX = 3650

export const PrescriptionItemInput = z.object({
  drugName: draftText(160),
  strength: draftText(60),
  form: draftText(40),
  dose: draftText(60),
  route: draftText(40),
  frequency: draftText(60),
  /** The duration as written ("5 days", "Until review", "When needed"); kept for every medicine. */
  duration: draftText(60),
  instructions: draftText(300),
  /**
   * HERO final: the course length in days when it has one (null or absent: no fixed length, e.g. when needed or until review, or a medicine
   * prescribed before this existed). Stored with the medicine; the patient app's "Day 3 of 7" is derived from it and `startDate`.
   */
  durationDays: z.number().int().min(1, 'At least 1 day').max(PRESCRIPTION_DURATION_DAYS_MAX, `At most ${PRESCRIPTION_DURATION_DAYS_MAX} days`).nullable().optional(),
  /**
   * HERO final: the first day of the course (YYYY-MM-DD). Absent with a duration in days: the consultation's date, which the server stores
   * when the draft is saved (the course is part of what is signed, scheme v3, and cannot change afterwards).
   */
  startDate: z.iso.date().nullable().optional(),
})
export type PrescriptionItemInput = z.input<typeof PrescriptionItemInput>
export type PrescriptionItem = z.output<typeof PrescriptionItemInput>
export const FREQUENCY_PRESETS = ['Once daily (OD)', 'Twice daily (BD)', 'Three times daily (TDS)', 'Four times daily (QID)', 'At night (HS)', 'When needed (SOS)', '1-0-1', '1-1-1', '0-0-1']

/** Autosave: the whole working draft is replaced. `version` detects concurrent edits. */
export const SaveDraftRequest = z.object({
  version: z.number().int().positive(),
  note: NoteFields,
  diagnoses: z.array(DiagnosisInput).max(20),
  prescription: z.array(PrescriptionItemInput).max(30),
})
export type SaveDraftRequest = z.input<typeof SaveDraftRequest>

export const ICD10_PATTERN = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/

/** What must be complete before a consultation can be signed. Used by both the API and the UI. */
export function signIssues(d: { note: { chiefComplaint: string }; diagnoses: { description?: string; code?: string | null }[]; prescription: PrescriptionItemInput[] }): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = []
  if (!d.note.chiefComplaint.trim()) issues.push({ path: 'note.chiefComplaint', message: 'Chief complaint is required to sign' })
  if (!d.diagnoses.length) issues.push({ path: 'diagnoses', message: 'Add at least one diagnosis (provisional is fine)' })
  d.diagnoses.forEach((x, i) => {
    if (!(x.description ?? '').trim()) issues.push({ path: `diagnoses.${i}.description`, message: `Diagnosis ${i + 1}: description is required` })
    if (x.code && !ICD10_PATTERN.test(x.code)) issues.push({ path: `diagnoses.${i}.code`, message: `Diagnosis ${i + 1}: ICD-10 format, e.g. J06.9` })
  })
  d.prescription.forEach((p, i) => {
    for (const [k, label] of [['drugName', 'medicine'], ['dose', 'dose'], ['frequency', 'frequency'], ['duration', 'duration']] as const) {
      if (!(p[k] ?? '').trim()) issues.push({ path: `prescription.${i}.${k}`, message: `Medicine ${i + 1}: ${label} is required` })
    }
  })
  return issues
}

/** The statement the doctor confirms when signing; recorded in the signed content. */
export const SIGN_ATTESTATION = 'I have reviewed this record, including any AI-assisted text, and it is accurate.'
export const SignRequest = z.object({ version: z.number().int().positive(), attestation: z.literal(true, 'Confirm that you have reviewed the record') })

/**
 * Closes an unsigned draft without signing it. The draft is kept, read-only,
 * with who, when and why; it is not part of the patient's record, and the
 * visit returns to the queue (ready for a doctor) if it was with the doctor.
 */
export const DiscardDraftRequest = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(3, 'Say why the draft is discarded (at least 3 characters)').max(300, 'At most 300 characters'),
})
export type DiscardDraftRequest = z.input<typeof DiscardDraftRequest>

export const AmendmentRequest = z.object({ reason: Text(300), content: Text(4000) })
export type AmendmentRequest = z.input<typeof AmendmentRequest>

export const Amendment = z.object({
  id: z.uuid(),
  reason: z.string(),
  content: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
  /** Position among the record's amendments, and its SHA-256 link; null for amendments made before linking began. */
  seq: z.number().int().nullable(),
  contentHash: z.string().nullable(),
})
export type Amendment = z.infer<typeof Amendment>

export const EncounterStatus = z.enum(['in_progress', 'signed', 'discarded'])
export type EncounterStatus = z.infer<typeof EncounterStatus>
export const ENCOUNTER_STATUS_LABELS: Record<EncounterStatus, string> = { in_progress: 'Draft, not signed', signed: 'Signed', discarded: 'Discarded draft' }

export const Encounter = z.object({
  id: z.uuid(),
  status: EncounterStatus,
  version: z.number().int(),
  /**
   * The visit as it is now. `priority` is the visit's priority in the queue (set at check-in and changeable while the visit is open), read
   * when the consultation is loaded; it is not part of the signed content.
   */
  visit: z.object({ id: z.uuid(), visitDate: z.string(), tokenNumber: z.number().int(), departmentName: z.string(), reasonForVisit: z.string().nullable(), status: VisitStatus, priority: Priority }),
  patient: z.object({
    id: z.uuid(),
    mrn: z.string(),
    fullName: z.string(),
    sex: Sex,
    dateOfBirth: z.string(),
    dateOfBirthEstimated: z.boolean(),
    phone: z.string(),
    noKnownAllergies: z.boolean(),
    activeAllergies: z.array(z.string()),
  }),
  doctor: z.object({ id: z.uuid(), fullName: z.string(), registrationNumber: z.string().nullable() }),
  facilityName: z.string(),
  note: NoteFields,
  diagnoses: z.array(z.object({ description: z.string(), code: z.string().nullable(), kind: DiagnosisKind })),
  // The structured duration (HERO final) stays optional here until every producer returns it (null for medicines without one).
  prescription: z.array(PrescriptionItemInput.required().extend({ durationDays: z.number().int().nullable().optional(), startDate: z.string().nullable().optional() })),
  vitals: z.array(Observation),
  amendments: z.array(Amendment),
  /** AI-produced text the doctor inserted into the note, with a reference to its source. */
  aiInsertions: z.array(NoteInsertion),
  startedAt: z.string(),
  updatedAt: z.string(),
  signedAt: z.string().nullable(),
  /** SHA-256 of the signed content; shown on printouts so copies can be checked. */
  contentHash: z.string().nullable(),
  /** How contentHash was computed; null for records signed before schemes were recorded (scheme v1). */
  hashScheme: z.string().nullable(),
  /** For a discarded draft: who closed it, when and why. */
  discarded: z.object({ at: z.string(), byName: z.string(), reason: z.string() }).nullable(),
  /** The current user may edit now: their own unsigned draft, while the visit is with the doctor. */
  canEdit: z.boolean(),
  /** Their own unsigned draft whose visit is back in the queue: continuing moves the visit to the doctor again. */
  canResume: z.boolean(),
  /** Their own unsigned draft, which they may discard. */
  canDiscard: z.boolean(),
  // --- HERO final (optional until the encounters routes return them). The visit's status is `visit.status`. ---
  /** When the doctor completed the consultation (the visit became completed); null while it is not completed. */
  completedAt: z.string().nullable().optional(),
  /** The current user may complete it now: they signed it, and its visit is still with the doctor (POST /api/encounters/:id/complete). */
  canComplete: z.boolean().optional(),
})
export type Encounter = z.infer<typeof Encounter>

/**
 * POST /api/encounters/:id/complete: the signing doctor completes the consultation (signing no longer does): the visit becomes completed
 * (with its appointment), the record and its prescription become visible to the patient, and the queue counts the patient as seen. Only for a
 * signed consultation whose visit is still with the doctor; a second call is refused (409 `already_completed`).
 */
export const CompleteEncounterRequest = z.object({ version: z.number().int().positive().optional() })
export type CompleteEncounterRequest = z.input<typeof CompleteEncounterRequest>
export const CompleteEncounterResult = z.object({
  encounterId: z.uuid(),
  visitId: z.uuid(),
  completedAt: z.string(),
  /** The patient can see the record and today's prescription in the patient app (an active portal account with portal consent). */
  patientPortalAccess: z.boolean(),
})
export type CompleteEncounterResult = z.infer<typeof CompleteEncounterResult>

export const TimelineEntry = z.object({
  kind: z.enum(['encounter', 'visit']),
  id: z.uuid(),
  date: z.string(),
  title: z.string(),
  status: z.string(),
  doctorName: z.string().nullable(),
  departmentName: z.string().nullable(),
  diagnoses: z.array(z.string()),
  medications: z.array(z.string()),
  amendmentCount: z.number().int(),
  encounterId: z.uuid().nullable(),
})
export type TimelineEntry = z.infer<typeof TimelineEntry>

// ---------------------------------------------------------------------------
// The doctor's own consultations: unsigned drafts and recently signed records
// ---------------------------------------------------------------------------

export const MyConsultationsQuery = z.object({ status: z.enum(['in_progress', 'signed']).default('in_progress') })
export type MyConsultationsQuery = z.input<typeof MyConsultationsQuery>

export const MyConsultation = z.object({
  encounterId: z.uuid(),
  status: EncounterStatus,
  version: z.number().int(),
  startedAt: z.string(),
  updatedAt: z.string(),
  signedAt: z.string().nullable(),
  patient: z.object({ id: z.uuid(), fullName: z.string(), mrn: z.string() }),
  visit: z.object({ id: z.uuid(), visitDate: z.string(), tokenNumber: z.number().int(), status: VisitStatus, departmentName: z.string() }),
  /** How much of the note is written: sections with text (of 7), diagnoses, medicines. */
  progress: z.object({ sectionsWithText: z.number().int(), diagnoses: z.number().int(), medicines: z.number().int() }),
  amendmentCount: z.number().int(),
})
export type MyConsultation = z.infer<typeof MyConsultation>

export const MyConsultationsResponse = z.object({
  status: z.enum(['in_progress', 'signed']),
  /** The facility's date today, to tell earlier days' drafts apart. */
  today: z.string(),
  /** Signed records are listed for this many days. */
  signedWindowDays: z.number().int(),
  items: z.array(MyConsultation),
})
export type MyConsultationsResponse = z.infer<typeof MyConsultationsResponse>

// ---------------------------------------------------------------------------
// Status history of a consultation and its visit
// ---------------------------------------------------------------------------

export const STATUS_SOURCE_LABELS: Record<string, string> = {
  history_start: 'Status when the history began',
  check_in: 'Checked in',
  appointment_check_in: 'Checked in from an appointment',
  queue: 'Changed in the queue',
  vitals: 'Vitals recorded',
  consultation_start: 'Consultation started',
  consultation_resume: 'Consultation continued',
  consultation_signed: 'Consultation signed',
  consultation_completed: 'Consultation completed',
  consultation_discarded: 'Draft discarded',
  unspecified: 'Changed outside the app',
}

export const StatusEvent = z.object({
  subject: z.enum(['visit', 'consultation']),
  from: z.string().nullable(),
  to: z.string(),
  source: z.string(),
  reason: z.string().nullable(),
  actorName: z.string().nullable(),
  at: z.string(),
})
export type StatusEvent = z.infer<typeof StatusEvent>
export const StatusHistory = z.object({ events: z.array(StatusEvent) })
export type StatusHistory = z.infer<typeof StatusHistory>

// ---------------------------------------------------------------------------
// Signed-record verification
// ---------------------------------------------------------------------------

/**
 * Hash schemes of signed records. v1: SHA-256 of the canonical JSON (sorted
 * keys) of the signed snapshot; records signed before migration 0019 carry no
 * scheme marker and are v1. v2 (current): the snapshot names its scheme and
 * also covers the facility, visit id, reason for visit and the attestation;
 * serialisation is strict (no undefined values, dates or non-finite numbers).
 * v3 (HERO final, current): v2 plus each medicine's structured duration
 * (durationDays, startDate; null when the medicine has none). Records signed
 * under v1 and v2 keep verifying under their own scheme (encounters/verify.ts).
 */
export const ENCOUNTER_HASH_SCHEME_V2 = 'adaxai.encounter.v2'
export const ENCOUNTER_HASH_SCHEME_V3 = 'adaxai.encounter.v3'
export const ENCOUNTER_HASH_SCHEMES = ['adaxai.encounter.v1', ENCOUNTER_HASH_SCHEME_V2, ENCOUNTER_HASH_SCHEME_V3] as const
export const CURRENT_ENCOUNTER_HASH_SCHEME = ENCOUNTER_HASH_SCHEME_V3

export const VerificationStatus = z.enum(['valid', 'invalid', 'unsupported_version', 'unverifiable'])
export type VerificationStatus = z.infer<typeof VerificationStatus>
export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  valid: 'Matches its fingerprint',
  invalid: 'Does not match',
  unsupported_version: 'Unsupported fingerprint version',
  unverifiable: 'Cannot be checked',
}

/** What a verification result does and does not mean (shown with every result). */
export const VERIFICATION_LIMITS =
  'A match means the stored signed content, its amendments and their audit entries agree with the SHA-256 fingerprints recorded at the time, as far as this database can show. It is not a digital signature: it does not prove who signed, that the record is clinically correct, or that nobody with full database access rewrote both the content and its fingerprints.'

export const VerificationCheck = z.object({
  key: z.string(),
  label: z.string(),
  result: z.enum(['pass', 'fail', 'not_checked']),
  detail: z.string(),
})
export type VerificationCheck = z.infer<typeof VerificationCheck>

export const EncounterVerification = z.object({
  encounterId: z.uuid(),
  status: VerificationStatus,
  /** The scheme used (or claimed); `schemeRecorded` is false for records signed before schemes were recorded. */
  scheme: z.string().nullable(),
  schemeRecorded: z.boolean(),
  contentHash: z.string().nullable(),
  recomputedHash: z.string().nullable(),
  amendments: z.object({ total: z.number().int(), linked: z.number().int(), beforeLinking: z.number().int() }),
  checks: z.array(VerificationCheck),
  /** Differences that are not tampering, e.g. a patient's name corrected after signing. */
  notes: z.array(z.string()),
  checkedAt: z.string(),
})
export type EncounterVerification = z.infer<typeof EncounterVerification>
