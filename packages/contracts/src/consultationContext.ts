import { z } from 'zod'

/*
 * D2: the consultation's context in one place. One read model, built on request from the records that already exist (PostgreSQL stays the
 * only source of truth: nothing here is stored again), for the patient and the encounter of one consultation: what was said, measured,
 * recorded, drafted, asked and decided, each item with where it came from, when, in what state, and how far it can be trusted. It is read
 * by the consultation's Overview, by the multimodal summary and by Mana; it never writes anything and never resolves a conflict.
 */

/** How far an item can be trusted, in the words the screen uses. Never upgraded: a device value stays unverified, a simulated one simulated. */
export const EVIDENCE_TRUST = {
  clinician_entered: 'Entered by staff',
  doctor_reviewed: 'Reviewed by the doctor',
  measured: 'Measured',
  measured_unverified: 'Device reading, unverified',
  simulated: 'SIMULATED, not a measurement',
  observed: 'Said in the consultation',
  /** An important point found in the conversation by fixed rules and not yet decided by the doctor (one a model found is `model_output`). */
  extracted: 'Extracted from the conversation, to review',
  rule_output: 'Fixed rules, not AI',
  model_output: 'AI output, to review',
  recorded: 'Recorded, not analysed',
} as const
export type EvidenceTrust = keyof typeof EVIDENCE_TRUST

/** The kinds of evidence, one per source in the consultation. */
export const EVIDENCE_KINDS = {
  transcript: 'Conversation',
  point: 'Important point',
  vital_staff: 'Vital sign',
  vital_device: 'Device reading',
  stethoscope: 'Stethoscope',
  thermal: 'Thermal image',
  thermal_summary: 'Thermal summary',
  ai_draft: 'AI draft',
  mana: 'Mana',
  note_insertion: 'Added to the note',
} as const
export type EvidenceKind = keyof typeof EVIDENCE_KINDS

/** Where on the screen an item can be looked at more closely (a part of the consultation's tools column, or the note). */
export const EVIDENCE_TARGETS = ['history', 'conversation', 'draft', 'mana', 'devices', 'thermal', 'note'] as const

export const EvidenceItem = z.object({
  /** Stable for the item (kind and the record's id), so the screen can keep its place. */
  id: z.string(),
  kind: z.enum(Object.keys(EVIDENCE_KINDS) as [EvidenceKind, ...EvidenceKind[]]),
  /** What it is, in a few words ("SpO₂ 94 %", "Recording 38 s, mitral area", "Thermal image, Knee"). Never a diagnosis. */
  title: z.string(),
  /** One more line when it helps ("Live capture · 3 regions · model unavailable"). */
  detail: z.string().nullable(),
  /** When it happened (measured, said, recorded, made): the time the record holds, never a guess. */
  at: z.string(),
  /** Its state in a word ("LIVE", "STALE", "Confirmed", "To review", "Approved", "Recorded", "In the note"). */
  status: z.string(),
  trust: z.enum(Object.keys(EVIDENCE_TRUST) as [EvidenceTrust, ...EvidenceTrust[]]),
  /** Where it came from, in words ("Nurse Anil", "Band under test (gateway)", "FLIR ONE (live capture)", "Local model … · consult-draft-v1"). */
  source: z.string(),
  /** Model, prompt, rules or device versions, when there are any. */
  provenance: z.string().nullable(),
  target: z.enum(EVIDENCE_TARGETS),
})
export type EvidenceItem = z.infer<typeof EvidenceItem>

/**
 * A disagreement between two sources, found by fixed rules (`context-conflicts-v2`), for the doctor to look at. Never resolved by the
 * system: both sides are shown as they are.
 */
export const ContextConflict = z.object({
  id: z.string(),
  kind: z.enum(['vital_staff_vs_device', 'point_vs_record', 'draft_conflict', 'allergy_status']),
  text: z.string(),
  /** The evidence items on each side (ids from `evidence`), when they are in it. */
  itemIds: z.array(z.string()),
  rule: z.string(),
})
export type ContextConflict = z.infer<typeof ContextConflict>

export const PENDING_KINDS = ['points', 'draftStatements', 'thermalImages', 'thermalSummaries'] as const

/**
 * What waits for the doctor: counts, each leading to where it is reviewed. A kind whose records could not be read (or are not shown to this
 * viewer) is in `unread` and its count is 0 for that reason, not because nothing waits: nothing may then say that nothing waits.
 */
export const PendingReview = z.object({
  points: z.number().int(),
  draftStatements: z.number().int(),
  thermalImages: z.number().int(),
  thermalSummaries: z.number().int(),
  unread: z.array(z.enum(PENDING_KINDS)),
})
export type PendingReview = z.infer<typeof PendingReview>

/** A section of the multimodal summary: plain statements, each with the evidence it rests on. */
export const SummarySection = z.object({
  key: z.enum(['presentation', 'patient', 'observations', 'ai', 'review']),
  title: z.string(),
  statements: z.array(z.object({ text: z.string(), trust: z.enum(Object.keys(EVIDENCE_TRUST) as [EvidenceTrust, ...EvidenceTrust[]]), itemIds: z.array(z.string()) })),
})
export type SummarySection = z.infer<typeof SummarySection>

/**
 * The multimodal summary (`multimodal-summary-v2`): composed by fixed rules from the context, not by a language model; ADVISORY. Sections:
 * current presentation, patient context, current observations, AI-derived information (only what the doctor accepted, and what waits), items
 * requiring the doctor's review (pending items, conflicts, missing information, limitations).
 */
export const MultimodalSummary = z.object({ composer: z.string(), sections: z.array(SummarySection) })
export type MultimodalSummary = z.infer<typeof MultimodalSummary>

export const ConsultationContext = z.object({
  encounterId: z.uuid(),
  patientId: z.uuid(),
  /** The server's clock when this was built (the screen ages LIVE device items from it, as the device card does). */
  generatedAt: z.string(),
  reasonForVisit: z.string().nullable(),
  /** Chronological, newest first. Simulated items are included only to be shown as SIMULATED; they are never in the summary's observations. */
  evidence: z.array(EvidenceItem),
  conflicts: z.array(ContextConflict),
  pending: PendingReview,
  /** What a consultation usually has and this one does not have yet (vital signs, the allergy status, …), in words. */
  missing: z.array(z.string()),
  summary: MultimodalSummary,
  rules: z.object({ conflicts: z.string(), summary: z.string() }),
})
export type ConsultationContext = z.infer<typeof ConsultationContext>
