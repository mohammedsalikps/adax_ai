import { z } from 'zod'
import { AiSection } from './ai.ts'

// ---------------------------------------------------------------------------
// Mana AI: the doctor's patient-context companion. Every answer is built from
// this patient's record only; documented facts (read straight from the record
// by explicit rules) are kept apart from AI-generated text, and every
// statement carries the record items it is based on.
// ---------------------------------------------------------------------------

export const MANA_INTENTS = {
  briefing: 'Pre-consultation briefing',
  history_summary: 'History summary',
  last_prescription: 'Last prescription',
  vitals_compare: 'Vital signs compared',
  changes_since_last: 'Changes since the previous visit',
  allergies: 'Allergies',
  diagnoses: 'Diagnoses on record',
  search: 'Record search',
} as const
export type ManaIntent = keyof typeof MANA_INTENTS
export const ManaIntent = z.enum(Object.keys(MANA_INTENTS) as [ManaIntent, ...ManaIntent[]])

/** Suggested questions shown as one-tap prompts. */
export const MANA_SUGGESTIONS: { intent: ManaIntent; label: string; question: string }[] = [
  { intent: 'briefing', label: 'Pre-consultation briefing', question: 'Give me a pre-consultation briefing.' },
  { intent: 'history_summary', label: 'Summarize history', question: 'Summarize this patient’s history.' },
  { intent: 'last_prescription', label: 'Last prescription', question: 'What medication was prescribed last time?' },
  { intent: 'vitals_compare', label: 'Compare vitals', question: 'Compare today’s vitals with the previous readings.' },
  { intent: 'changes_since_last', label: 'What changed', question: 'What changed since the previous visit?' },
]

export const MANA_SOURCE_TYPES = ['patient', 'allergy', 'encounter_note', 'diagnosis', 'prescription_item', 'amendment', 'observation', 'visit', 'thermal_capture', 'patient_condition', 'patient_medication', 'investigation_result'] as const
export const ManaSourceType = z.enum(MANA_SOURCE_TYPES)

/** Record status of a source item, shown next to every citation. */
export const MANA_SOURCE_STATUS = {
  signed: 'Signed',
  draft: 'Draft (not signed)',
  amended: 'Signed, later amended',
  active: 'Active',
  inactive: 'Inactive',
  recorded: 'Recorded',
} as const
export type ManaSourceStatus = keyof typeof MANA_SOURCE_STATUS

/** One record item an answer can cite. `excerpt` is a snapshot taken when the question was asked. */
export const ManaSource = z.object({
  ref: z.string(),
  sourceType: ManaSourceType,
  sourceId: z.uuid().nullable(),
  /** Consultation the item belongs to (for a link to it), if any. */
  encounterId: z.uuid().nullable(),
  /** When the item was documented or measured (ISO date or date-time). */
  date: z.string().nullable(),
  /** Record field, e.g. "Assessment", "Prescription", "Temperature". */
  field: z.string(),
  status: z.enum(Object.keys(MANA_SOURCE_STATUS) as [ManaSourceStatus, ...ManaSourceStatus[]]),
  /** record | clinician_stated | staff_measured | device_measured (a device reading, unverified; a simulator's output is never a source) */
  provenance: z.string(),
  excerpt: z.string(),
})
export type ManaSource = z.infer<typeof ManaSource>

export const MANA_STATEMENT_KINDS = {
  documented: 'From the record',
  absent: 'Not found in the record',
  conflict: 'Conflicting records',
  outdated: 'Possibly outdated',
  generated: 'AI-generated',
} as const
export type ManaStatementKind = keyof typeof MANA_STATEMENT_KINDS

export const ManaStatement = z.object({
  kind: z.enum(Object.keys(MANA_STATEMENT_KINDS) as [ManaStatementKind, ...ManaStatementKind[]]),
  text: z.string(),
  refs: z.array(z.string()),
  /** Generated text whose citations could not be verified against the record items sent. */
  unsupported: z.boolean(),
})
export type ManaStatement = z.infer<typeof ManaStatement>

export const ManaSection = z.object({ title: z.string(), statements: z.array(ManaStatement) })
export type ManaSection = z.infer<typeof ManaSection>

export const MANA_GENERATION_STATUS = {
  pending: 'AI summary in progress',
  succeeded: 'AI summary',
  failed: 'AI summary failed',
  unavailable: 'AI summary unavailable',
  consent_required: 'Consent needed for AI summary',
  not_requested: 'Record answer only',
} as const
export type ManaGenerationStatus = keyof typeof MANA_GENERATION_STATUS

export const ManaAnswer = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid().nullable(),
  question: z.string(),
  intent: ManaIntent,
  createdAt: z.string(),
  askedByName: z.string().nullable(),
  /** Documented facts, read from the record by explicit rules (no language model). */
  record: z.object({ rulesVersion: z.string(), sections: z.array(ManaSection) }),
  generation: z.object({
    status: z.enum(Object.keys(MANA_GENERATION_STATUS) as [ManaGenerationStatus, ...ManaGenerationStatus[]]),
    reason: z.string().nullable(),
    retryable: z.boolean(),
    jobId: z.uuid().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    promptVersion: z.string().nullable(),
    statements: z.array(ManaStatement),
    notFound: z.array(z.string()),
  }),
  sources: z.array(ManaSource),
  review: z.object({ reviewedAt: z.string().nullable(), reviewedByName: z.string().nullable() }),
  /** Times text from this answer was inserted into a consultation note. */
  insertions: z.number(),
})
export type ManaAnswer = z.infer<typeof ManaAnswer>

export const AskManaRequest = z.object({
  question: z.string().trim().min(3, 'Ask a question').max(500, 'At most 500 characters'),
  /** Set when a suggested question was chosen; otherwise the question is classified by rules. */
  intent: ManaIntent.optional(),
  /** The consultation the doctor is in, if any (adds its draft and today's visit to the context). */
  encounterId: z.uuid().optional(),
  /** false: record answer only, nothing is sent to an AI provider. */
  generate: z.boolean().default(true),
  idempotencyKey: z.uuid().optional(),
})
export type AskManaRequest = z.input<typeof AskManaRequest>

export const ManaAnswerList = z.object({ answers: z.array(ManaAnswer) })
export type ManaAnswerList = z.infer<typeof ManaAnswerList>

// ---------------------------------------------------------------------------
// Inserting AI output into a consultation note. Always an explicit doctor
// action; the note keeps a reference to the AI artifact it came from.
// ---------------------------------------------------------------------------

export const INSERTION_SUBJECTS = {
  draft_item: 'Note suggestion',
  fact: 'Extracted fact',
  recommendation: 'Recommendation',
  mana_answer: 'Mana answer',
  image_analysis: 'Photo description',
  consultation_item: 'Consultation draft statement',
  /** V6: a thermal study summary composed by rules (no model) and accepted or edited by the doctor; never a simulated one. */
  thermal_summary: 'Thermal study summary',
} as const
export type InsertionSubject = keyof typeof INSERTION_SUBJECTS
export const InsertionSubject = z.enum(Object.keys(INSERTION_SUBJECTS) as [InsertionSubject, ...InsertionSubject[]])

export const InsertIntoNoteRequest = z.object({
  /** Encounter version the doctor's editor holds (optimistic concurrency). */
  version: z.number().int().min(1),
  section: AiSection,
  text: z.string().trim().min(1).max(8000),
  subjectType: InsertionSubject,
  subjectId: z.uuid(),
})
export type InsertIntoNoteRequest = z.input<typeof InsertIntoNoteRequest>

export const NoteInsertion = z.object({
  id: z.uuid(),
  section: AiSection,
  text: z.string(),
  subjectType: InsertionSubject,
  subjectId: z.uuid(),
  /** Provider / model / prompt or rules version of the AI artifact, when known. */
  producedBy: z.string().nullable(),
  insertedAt: z.string(),
  insertedByName: z.string().nullable(),
  /** Whether the inserted text is still present, unchanged, in that section of the note. */
  retained: z.boolean(),
})
export type NoteInsertion = z.infer<typeof NoteInsertion>
