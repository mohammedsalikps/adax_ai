import { z } from 'zod'
import { OptionalText, Text } from './common.ts'

export const Sex = z.enum(['female', 'male', 'other', 'unknown'])
export type Sex = z.infer<typeof Sex>
export const SEX_LABELS: Record<Sex, string> = { female: 'Female', male: 'Male', other: 'Other', unknown: 'Unknown' }

/**
 * Phone numbers are stored as + and digits. A bare 10-digit number is treated
 * as Indian (+91), the deployment assumption for this MVP.
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s\-().]/g, '')
  if (/^\d{10}$/.test(s)) return `+91${s}`
  if (/^\+\d{10,15}$/.test(s)) return s
  if (/^00\d{10,15}$/.test(s)) return `+${s.slice(2)}`
  return null
}
export const Phone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const p = normalizePhone(v)
    if (!p) {
      ctx.addIssue({ code: 'custom', message: 'Enter a 10-digit mobile number or an international number starting with +' })
      return z.NEVER
    }
    return p
  })
export const OptionalPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === '') return null
    const p = normalizePhone(v)
    if (!p) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' })
      return z.NEVER
    }
    return p
  })
  .nullable()
  .optional()

/** ABHA number: 14 digits (hyphens allowed). Stored as digits; not verified with ABDM. */
export const OptionalAbha = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === '') return null
    const d = v.replace(/[\s-]/g, '')
    if (!/^\d{14}$/.test(d)) {
      ctx.addIssue({ code: 'custom', message: 'ABHA number has 14 digits' })
      return z.NEVER
    }
    return d
  })
  .nullable()
  .optional()

export const BloodGroup = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])

const DateOfBirth = z.iso.date('Use the date picker (YYYY-MM-DD)').refine((d) => {
  const t = new Date(`${d}T00:00:00Z`).getTime()
  return t <= Date.now() && t >= Date.UTC(1900, 0, 1)
}, 'Date of birth must be in the past and after 1900')

export const PatientInput = z.object({
  givenName: Text(80),
  familyName: OptionalText(80),
  dateOfBirth: DateOfBirth,
  dateOfBirthEstimated: z.boolean().default(false),
  sex: Sex,
  phone: Phone,
  email: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .pipe(z.email('Enter a valid email').nullable())
    .nullable()
    .optional(),
  addressLine: OptionalText(200),
  city: OptionalText(80),
  state: OptionalText(80),
  postalCode: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .pipe(z.string().regex(/^\d{6}$/, 'PIN code has 6 digits').nullable())
    .nullable()
    .optional(),
  abhaNumber: OptionalAbha,
  bloodGroup: BloodGroup.nullable().optional(),
  preferredLanguage: OptionalText(40),
  emergencyContactName: OptionalText(120),
  emergencyContactPhone: OptionalPhone,
})
export type PatientInput = z.input<typeof PatientInput>
export type PatientInputParsed = z.output<typeof PatientInput>

export const CreatePatientRequest = PatientInput.extend({
  /** Set after the user has seen and dismissed possible-duplicate warnings. */
  confirmNotDuplicate: z.boolean().optional(),
})
export type CreatePatientRequest = z.input<typeof CreatePatientRequest>
export const UpdatePatientRequest = PatientInput.partial().refine((v) => Object.keys(v).length > 0, 'No changes supplied')

export const PatientSummary = z.object({
  id: z.uuid(),
  mrn: z.string(),
  fullName: z.string(),
  sex: Sex,
  dateOfBirth: z.string(),
  dateOfBirthEstimated: z.boolean(),
  phone: z.string(),
  lastVisitDate: z.string().nullable(),
  /** synthetic, clinical, or unspecified for records made before the origin was kept. */
  dataOrigin: z.enum(['synthetic', 'clinical', 'unspecified']),
  /** HERO final (optional; the patient search returns it): the names of the active allergies, for the list's allergy chip. */
  activeAllergies: z.array(z.string()).optional(),
})
export type PatientSummary = z.infer<typeof PatientSummary>

export const AllergySeverity = z.enum(['mild', 'moderate', 'severe', 'unknown'])
export const Allergy = z.object({
  id: z.uuid(),
  substance: z.string(),
  reaction: z.string().nullable(),
  severity: AllergySeverity,
  status: z.enum(['active', 'inactive']),
  recordedAt: z.string(),
  recordedByName: z.string().nullable(),
})
export type Allergy = z.infer<typeof Allergy>
export const AllergyInput = z.object({ substance: Text(120), reaction: OptionalText(200), severity: AllergySeverity.default('unknown') })
export type AllergyInput = z.input<typeof AllergyInput>

export const ConsentType = z.enum(['data_processing', 'ai_recording', 'thermal_imaging', 'device_monitoring', 'portal_access', 'research_use', 'clinical_photography', 'ai_image_analysis', 'ai_record_assistant'])
export type ConsentType = z.infer<typeof ConsentType>
export const CONSENT_LABELS: Record<ConsentType, { title: string; description: string }> = {
  data_processing: { title: 'Care records', description: 'Store and use health records for this clinic’s care of the patient.' },
  ai_recording: {
    title: 'Consultation recording & AI assistance',
    description: 'Record the consultation audio and process it, with relevant parts of the patient’s record (without name or contact details), using external speech-to-text and AI services to draft notes, extract findings and suggest points for the doctor to review.',
  },
  thermal_imaging: { title: 'Thermal imaging', description: 'Capture and store thermal images for review by the care team.' },
  device_monitoring: { title: 'Device readings', description: 'Store readings from wearable or bedside devices.' },
  portal_access: { title: 'Patient portal', description: 'Online access to the patient’s own approved records.' },
  research_use: { title: 'De-identified research use', description: 'Use de-identified data to develop and evaluate tools. Optional; care is not affected.' },
  clinical_photography: { title: 'Clinical photographs', description: 'Take and store photographs (for example of a wound or skin condition) for the care team.' },
  ai_image_analysis: { title: 'AI description of photographs', description: 'Send clinical photographs (without name or contact details) to an external AI service that describes them for the doctor to review.' },
  ai_record_assistant: {
    title: 'Mana AI record summaries',
    description: 'When the doctor asks a question about the patient’s record, send the relevant parts of the record (without name or contact details) to an external AI service that writes a summary with references, for the doctor to check. Answers read directly from the record do not need this consent.',
  },
}

/**
 * Version of the wording read to the patient. Bump when the wording changes in
 * substance; features that rely on the new wording require that version.
 */
export const CONSENT_VERSIONS: Record<ConsentType, string> = {
  data_processing: '2026-10-v1',
  ai_recording: '2026-10-v2',
  thermal_imaging: '2026-10-v1',
  device_monitoring: '2026-10-v1',
  portal_access: '2026-10-v1',
  research_use: '2026-10-v1',
  clinical_photography: '2026-10-v1',
  ai_image_analysis: '2026-10-v1',
  ai_record_assistant: '2026-10-v1',
}
/** Earlier wordings, so a record shows what the patient actually agreed to (from the git history of this file). */
export const CONSENT_EARLIER_WORDINGS: Partial<Record<ConsentType, Record<string, { title: string; description: string }>>> = {
  ai_recording: {
    '2026-10-v1': { title: 'Consultation recording & AI drafting', description: 'Record the consultation audio and process it with external speech-to-text and AI services to draft notes for the doctor to review.' },
  },
}

/** The wording a patient agreed to for a given version, or null if that version's text is not known. */
export function consentWording(type: ConsentType, version: string): { title: string; description: string } | null {
  if (version === CONSENT_VERSIONS[type]) return CONSENT_LABELS[type]
  return CONSENT_EARLIER_WORDINGS[type]?.[version] ?? null
}

// Granting is recorded by staff after explaining the wording to the patient;
// withdrawal is possible at any time, by staff or by the patient in the portal.

/** What withdrawing a consent does, for staff, shown before the withdrawal is confirmed (every purpose listed). */
export const CONSENT_WITHDRAWAL_EFFECTS: Record<ConsentType, string> = {
  data_processing: 'The withdrawal is recorded and shown on the patient record. ADAXAI does not stop keeping or using care records by itself: what it means for the patient’s care is the clinic’s decision (not yet defined).',
  ai_recording: 'Recording and AI assistance stop at once for every consultation, including ones with a consultation-only consent. Audio and transcripts already captured are NOT deleted or hidden by this: they stay with the consultation (what happens to them is the clinic’s decision, not yet defined).',
  thermal_imaging: 'No new thermal images can be added. Images already taken stay in the record.',
  device_monitoring: 'Device assignments of this patient end at once; readings are no longer accepted.',
  portal_access: 'The patient’s portal account is switched off at once, they are signed out, and unused activation codes stop working.',
  research_use: 'Existing research datasets that include this patient can no longer be downloaded or evaluated.',
  clinical_photography: 'No new photographs can be added. Photographs already taken stay in the record.',
  ai_image_analysis: 'Photographs are no longer sent to the AI service. Descriptions already reviewed stay in the record.',
  ai_record_assistant: 'Mana stops sending record items to the AI service, including retries; answers read from the record still work.',
}

/** The same effects, worded for the patient in the portal. */
export const CONSENT_WITHDRAWAL_EFFECTS_FOR_PATIENT: Record<ConsentType, string> = {
  data_processing: 'Your withdrawal is recorded and the clinic is told. Your care records are still kept and used for your care; ask the clinic what this means for you.',
  ai_recording: 'Your consultations are no longer recorded or drafted with AI, including any you agreed to for one consultation only. What was already recorded is not deleted by this: ask the clinic what happens to it.',
  thermal_imaging: 'No new thermal images are taken. Images already taken stay in your record for the care team.',
  device_monitoring: 'Readings from your devices stop being accepted at once.',
  portal_access: 'Your online access is switched off at once: you are signed out, and any unused activation codes stop working.',
  research_use: 'Research datasets that already include your de-identified data can no longer be downloaded or evaluated.',
  clinical_photography: 'No new photographs are taken. Photographs already taken stay in your record for the care team.',
  ai_image_analysis: 'Your photographs are no longer sent to the AI service. Descriptions already reviewed stay in your record.',
  ai_record_assistant: 'Parts of your record are no longer sent to the AI service for summaries. Your doctor can still read your record directly.',
}

/** granted: with the current wording · outdated: granted with an earlier wording · withdrawn · not_recorded */
export const CONSENT_STATES = { granted: 'Granted', outdated: 'Granted (earlier wording)', withdrawn: 'Withdrawn', not_recorded: 'Not recorded' } as const
export type ConsentState = keyof typeof CONSENT_STATES

export const ConsentMethod = z.enum(['verbal', 'written', 'digital'])
export const Consent = z.object({
  id: z.uuid(),
  type: ConsentType,
  status: z.enum(['granted', 'withdrawn', 'superseded']),
  method: ConsentMethod,
  scope: z.enum(['ongoing', 'encounter']),
  encounterId: z.uuid().nullable(),
  notes: z.string().nullable(),
  recordedAt: z.string(),
  recordedByName: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  withdrawnByName: z.string().nullable(),
  withdrawReason: z.string().nullable(),
  /** staff | patient_portal */
  withdrawnVia: z.string().nullable(),
  supersededBy: z.uuid().nullable(),
  version: z.string(),
  /** Whether this grant used the current wording. */
  currentWording: z.boolean(),
})
export type Consent = z.infer<typeof Consent>
export const RecordConsentRequest = z.object({ type: ConsentType, method: ConsentMethod, notes: OptionalText(300) })
export type RecordConsentRequest = z.input<typeof RecordConsentRequest>
export const WithdrawConsentRequest = z.object({ reason: OptionalText(300) })
export type WithdrawConsentRequest = z.input<typeof WithdrawConsentRequest>
/** The state of each consent purpose for one patient (computed on the server). */
export const ConsentSummary = z.object({ type: ConsentType, state: z.enum(['granted', 'outdated', 'withdrawn', 'not_recorded']), consentId: z.uuid().nullable() })
export type ConsentSummary = z.infer<typeof ConsentSummary>

export const PatientDetail = PatientSummary.extend({
  givenName: z.string(),
  familyName: z.string().nullable(),
  email: z.string().nullable(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  abhaNumber: z.string().nullable(),
  bloodGroup: BloodGroup.nullable(),
  preferredLanguage: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  noKnownAllergies: z.boolean(),
  allergies: z.array(Allergy),
  consents: z.array(Consent),
  consentStates: z.array(ConsentSummary),
  /** none: no account · active · deactivated: switched off (e.g. portal consent withdrawn); a reset code re-enables it. */
  portalAccount: z.object({ state: z.enum(['none', 'active', 'deactivated']), active: z.boolean(), activationPending: z.boolean() }),
  createdAt: z.string(),
})
export type PatientDetail = z.infer<typeof PatientDetail>

export const DuplicateCandidate = z.object({ id: z.uuid(), mrn: z.string(), fullName: z.string(), dateOfBirth: z.string(), phone: z.string() })
export type DuplicateCandidate = z.infer<typeof DuplicateCandidate>

/** `reset`: the code sets a new password for an existing (possibly switched-off) portal account. */
export const ActivationCodeResponse = z.object({ activationCode: z.string(), expiresAt: z.string(), mrn: z.string(), reset: z.boolean() })
export type ActivationCodeResponse = z.infer<typeof ActivationCodeResponse>
