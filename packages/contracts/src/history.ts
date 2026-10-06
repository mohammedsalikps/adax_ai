import { z } from 'zod'
import { IsoDate, NUL_MESSAGE, noNul, OptionalText, RecordOrigin, Text } from './common.ts'
import { DocumentsSummary, PatientProcedure } from './documents.ts'
import { DiagnosisKind, ICD10_PATTERN } from './encounters.ts'
import { Allergy } from './patients.ts'
import { Observation } from './vitals.ts'

/**
 * A patient's longitudinal history, as the doctor sees it while consulting:
 * known conditions, the medicine list, investigation results and earlier
 * signed consultations, with the allergies and latest vital signs beside them.
 *
 * Everything here is typed in by staff (there is no laboratory or pharmacy
 * feed): each entry says who entered it and when, nothing is ever deleted, and
 * a mistake is marked "entered in error" with a reason and kept. Entries carry
 * where the data comes from (`dataOrigin`) so synthetic data is marked as such.
 */

const optionalIcd10 = z
  .string()
  .trim()
  .max(12)
  .transform((v) => (v === '' ? null : v.toUpperCase()))
  .nullable()
  .optional()
  .refine((v) => !v || ICD10_PATTERN.test(v), 'ICD-10 format, e.g. E11.9')

/** A reason for marking an entry as entered in error. */
const errorReason = z.string().trim().min(3, 'Give a short reason (at least 3 characters)').max(200, 'At most 200 characters').refine(noNul, NUL_MESSAGE)

// --- Conditions ------------------------------------------------------------

export const ConditionStatus = z.enum(['active', 'controlled', 'resolved', 'entered_in_error'])
export type ConditionStatus = z.infer<typeof ConditionStatus>
export const CONDITION_STATUS_LABELS: Record<ConditionStatus, string> = { active: 'Active', controlled: 'Controlled', resolved: 'Resolved', entered_in_error: 'Entered in error' }

export const ConditionInput = z.object({
  name: Text(120),
  code: optionalIcd10,
  /** The year it began (a calendar year up to this year; the API checks the upper bound). */
  sinceYear: z.number().int().min(1900).max(2200),
  sinceMonth: z.number().int().min(1).max(12).nullable().optional(),
  status: z.enum(['active', 'controlled', 'resolved']).default('active'),
  note: OptionalText(300),
})
export type ConditionInput = z.input<typeof ConditionInput>

export const ConditionStatusChange = z
  .object({ status: ConditionStatus, reason: z.string().trim().max(200).refine(noNul, NUL_MESSAGE).optional() })
  .superRefine((v, ctx) => {
    if (v.status === 'entered_in_error' && !errorReason.safeParse(v.reason).success) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Give a short reason (at least 3 characters)' })
  })
export type ConditionStatusChange = z.input<typeof ConditionStatusChange>

export const Condition = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string().nullable(),
  sinceYear: z.number().int(),
  sinceMonth: z.number().int().nullable(),
  status: ConditionStatus,
  note: z.string().nullable(),
  enteredByName: z.string().nullable(),
  enteredAt: z.string(),
  dataOrigin: RecordOrigin,
})
export type Condition = z.infer<typeof Condition>

// --- Medicines -------------------------------------------------------------

export const MedicationStatus = z.enum(['current', 'stopped', 'entered_in_error'])
export type MedicationStatus = z.infer<typeof MedicationStatus>
export const MEDICATION_STATUS_LABELS: Record<MedicationStatus, string> = { current: 'Current', stopped: 'Stopped', entered_in_error: 'Entered in error' }

export const MedicationInput = z.object({
  drugName: Text(120),
  strength: OptionalText(60),
  form: OptionalText(40),
  dose: Text(60),
  route: OptionalText(30),
  frequency: Text(60),
  startedOn: IsoDate.nullable().optional(),
  reason: OptionalText(200),
})
export type MedicationInput = z.input<typeof MedicationInput>

export const MedicationStatusChange = z
  .object({ status: z.enum(['stopped', 'entered_in_error']), stoppedOn: IsoDate.nullable().optional(), reason: errorReason })
  .superRefine((v, ctx) => {
    if (v.status === 'entered_in_error' && v.stoppedOn) ctx.addIssue({ code: 'custom', path: ['stoppedOn'], message: 'A stop date belongs to a medicine that was taken' })
  })
export type MedicationStatusChange = z.input<typeof MedicationStatusChange>

export const Medication = z.object({
  id: z.uuid(),
  drugName: z.string(),
  strength: z.string().nullable(),
  form: z.string().nullable(),
  dose: z.string(),
  route: z.string().nullable(),
  frequency: z.string(),
  startedOn: z.string().nullable(),
  stoppedOn: z.string().nullable(),
  status: MedicationStatus,
  reason: z.string().nullable(),
  /** Why it was stopped, or why the entry was marked as an error. */
  statusReason: z.string().nullable(),
  enteredByName: z.string().nullable(),
  enteredAt: z.string(),
  dataOrigin: RecordOrigin,
})
export type Medication = z.infer<typeof Medication>

// --- Investigation results ---------------------------------------------------

export const InvestigationStatus = z.enum(['final', 'entered_in_error'])
export type InvestigationStatus = z.infer<typeof InvestigationStatus>
/** unknown: the API could not compare the value with a range and the clinician gave no reading. */
export const InvestigationFlag = z.enum(['normal', 'low', 'high', 'abnormal', 'unknown'])
export type InvestigationFlag = z.infer<typeof InvestigationFlag>

/** The number in a result that is only a number ("7.2", "-3"); null for anything else ("7.2 %", "Positive", "<5"). */
export function plainNumber(text: string): number | null {
  const t = text.trim()
  return /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : null
}

export const InvestigationInput = z
  .object({
    testName: Text(120),
    /** The result as it should read (for example "7.2" or "Positive"). */
    valueText: Text(60),
    /** The number, when the result is numeric: the API compares it with the range to set the flag. Left out, it is taken from a result that is only a number. */
    valueNumber: z.number().finite().nullable().optional(),
    unit: OptionalText(20),
    refLow: z.number().finite().nullable().optional(),
    refHigh: z.number().finite().nullable().optional(),
    /** The reference range as it should read, when it is not a plain low-high pair (for example "< 5.7"). */
    refText: OptionalText(60),
    /** For a result with no number to compare, the clinician's reading. */
    interpretation: z.enum(['normal', 'abnormal']).nullable().optional(),
    collectedOn: IsoDate,
    resultedOn: IsoDate.nullable().optional(),
    note: OptionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.refLow != null && v.refHigh != null && v.refLow > v.refHigh) ctx.addIssue({ code: 'custom', path: ['refLow'], message: 'The lower limit must not be above the upper limit' })
    if (v.resultedOn && v.resultedOn < v.collectedOn) ctx.addIssue({ code: 'custom', path: ['resultedOn'], message: 'A result cannot be dated before it was collected' })
    // The number is what the flag is computed from, so it cannot disagree with the result as it reads.
    const plain = plainNumber(v.valueText)
    if (v.valueNumber != null && plain !== null && plain !== v.valueNumber) ctx.addIssue({ code: 'custom', path: ['valueNumber'], message: 'The number must match the result as it reads' })
  })
export type InvestigationInput = z.input<typeof InvestigationInput>

export const InvestigationStatusChange = z.object({ status: z.literal('entered_in_error'), reason: errorReason })
export type InvestigationStatusChange = z.input<typeof InvestigationStatusChange>

export const Investigation = z.object({
  id: z.uuid(),
  testName: z.string(),
  valueText: z.string(),
  valueNumber: z.number().nullable(),
  unit: z.string().nullable(),
  refLow: z.number().nullable(),
  refHigh: z.number().nullable(),
  refText: z.string().nullable(),
  flag: InvestigationFlag,
  collectedOn: z.string(),
  resultedOn: z.string().nullable(),
  status: InvestigationStatus,
  note: z.string().nullable(),
  enteredByName: z.string().nullable(),
  enteredAt: z.string(),
  dataOrigin: RecordOrigin,
})
export type Investigation = z.infer<typeof Investigation>

/** The flag for a numeric result against its range; null when there is nothing to compare. */
export function flagResult(value: number | null | undefined, low: number | null | undefined, high: number | null | undefined): 'normal' | 'low' | 'high' | null {
  if (value == null || (low == null && high == null)) return null
  if (low != null && value < low) return 'low'
  if (high != null && value > high) return 'high'
  return 'normal'
}

// --- Earlier consultations ----------------------------------------------------

export const PriorConsultation = z.object({
  encounterId: z.uuid(),
  visitId: z.uuid(),
  /** The visit's calendar date on the facility's clock. */
  date: z.string(),
  signedAt: z.string(),
  doctorName: z.string().nullable(),
  departmentName: z.string().nullable(),
  chiefComplaint: z.string(),
  diagnoses: z.array(z.object({ description: z.string(), code: z.string().nullable(), kind: DiagnosisKind })),
  /** What was prescribed in that consultation: not a record of what the patient takes. */
  prescription: z.array(
    z.object({
      drugName: z.string(),
      strength: z.string(),
      form: z.string(),
      dose: z.string(),
      route: z.string(),
      frequency: z.string(),
      duration: z.string(),
      instructions: z.string(),
      /** HERO final (optional): the structured course, when the medicine has one. */
      durationDays: z.number().int().nullable().optional(),
      startDate: z.string().nullable().optional(),
    }),
  ),
  amendmentCount: z.number().int(),
})
export type PriorConsultation = z.infer<typeof PriorConsultation>

// --- The read model -----------------------------------------------------------

export const PatientHistory = z.object({
  patientId: z.uuid(),
  generatedAt: z.string(),
  noKnownAllergies: z.boolean(),
  /** Active allergies, with severity and reaction. */
  allergies: z.array(Allergy),
  /** Conditions, not including those marked as entered in error. */
  conditions: z.array(Condition),
  /** The medicine list: current first, then stopped; not including entries marked as errors. */
  medications: z.array(Medication),
  /** The most recent results by collection date; not including entries marked as errors. */
  investigations: z.array(Investigation),
  /** Signed consultations, newest first. Drafts and discarded drafts are not part of the history. */
  consultations: z.array(PriorConsultation),
  /** The latest value of each vital sign, with its time and source. */
  latestVitals: z.array(Observation),
  /** How many entries each list holds beyond what is returned. */
  more: z.object({ consultations: z.number().int(), investigations: z.number().int() }),
  // --- HERO final (optional: producers that predate them leave them out, and a reader must say "not available", never "none") ---
  /** Surgeries and other past procedures, not including those marked as entered in error. */
  procedures: z.array(PatientProcedure).optional(),
  /** The patient's documents (lab reports, imaging, others): counts and the latest few. */
  documents: DocumentsSummary.optional(),
})
export type PatientHistory = z.infer<typeof PatientHistory>
