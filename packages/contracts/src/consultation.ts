import { z } from 'zod'
import { AiSection, ReasoningStatus } from './ai.ts'

// ---------------------------------------------------------------------------
// Local AI consultation intelligence (slice V3): a DRAFT, made by a language model that runs on this computer from the authorised record, the
// doctor's own notes and the points the doctor CONFIRMED during capture, for the doctor to review. Every statement carries the record items it
// rests on and a support state that the server (not the model) decides. Nothing here is a diagnosis, an order or a prescription, and nothing is
// written to the note, the diagnoses or the prescription without a separate act by the doctor.
// ---------------------------------------------------------------------------

/** The parts of a draft, in the order a doctor reads them. `summary` holds one statement. */
export const CONSULT_SECTIONS = {
  summary: 'Clinical summary',
  presenting_problem: 'Current problem',
  symptoms: 'Symptoms',
  observations: 'Observations',
  relevant_history: 'Relevant history',
  allergies: 'Allergies',
  medications: 'Medicines',
  potential_considerations: 'Potential considerations',
  potential_investigations: 'Potential investigations',
  potential_medication_considerations: 'Medication considerations',
  missing_information: 'Missing information',
  uncertainties: 'Uncertainties',
} as const
export type ConsultSection = keyof typeof CONSULT_SECTIONS
export const CONSULT_SECTION_KEYS = Object.keys(CONSULT_SECTIONS) as [ConsultSection, ...ConsultSection[]]
export const ConsultSection = z.enum(CONSULT_SECTION_KEYS)

/** Sections that state what the record says: each statement must rest on record items or it is removed. */
export const FACT_SECTIONS: readonly ConsultSection[] = ['summary', 'presenting_problem', 'symptoms', 'observations', 'relevant_history', 'allergies', 'medications']
/** Sections that are the model's own suggestions to weigh: never orders, never doses. */
export const SUGGESTION_SECTIONS: readonly ConsultSection[] = ['potential_considerations', 'potential_investigations', 'potential_medication_considerations']

/** Where a statement may be added to the note when the doctor decides to (a separate act, after accepting it). */
export const CONSULT_NOTE_SECTION: Record<ConsultSection, AiSection | null> = {
  summary: 'history',
  presenting_problem: 'history',
  symptoms: 'history',
  observations: 'examination',
  relevant_history: 'pastHistory',
  allergies: 'pastHistory',
  medications: 'pastHistory',
  potential_considerations: 'assessment',
  potential_investigations: 'plan',
  potential_medication_considerations: 'plan',
  missing_information: 'history',
  uncertainties: null,
}

/**
 * What the draft says about each statement, decided by the server from the cited record items (never taken from the model's word):
 * supported = the cited record says it; inferred = drawn from the record, not stated in it; not_found = nothing in the record shown to the AI says it;
 * conflicting = the cited items disagree (found by explicit rules); outdated = the cited items are older than the configured age.
 */
export const SUPPORT_STATES = {
  supported: 'Supported by record',
  inferred: 'Inferred',
  not_found: 'Not found',
  conflicting: 'Conflicting',
  outdated: 'Outdated',
} as const
export type SupportState = keyof typeof SUPPORT_STATES
export const SupportState = z.enum(Object.keys(SUPPORT_STATES) as [SupportState, ...SupportState[]])

/** Why a statement is marked or was changed by the checks that run after the model. */
export const ITEM_FLAGS = {
  no_valid_source: 'Cites no record item that exists',
  figure_not_in_source: 'Contains a figure that is not in the cited record items',
  negation_unverified: 'Wording may reverse a "no" or an affirmation in the record',
  absence_contradicted: 'A record item shown to the AI seems to say what this says is missing',
  wording_not_in_source: 'Uses wording that is not in the record items it cites',
  assertive_wording: 'Worded as a conclusion; AI considerations are not diagnoses',
  medicine_not_in_record: 'Names a medicine that is not in the record shown',
  conflict_unverified: 'The AI reported a conflict that the rules did not find',
  record_conflict: 'The record items it rests on disagree',
  record_outdated: 'The record items it rests on are old',
  record_status_differs: 'A record item it rests on is stopped, inactive or resolved, and this does not say so',
  record_subject_differs: 'A record item it rests on is about a relative, and this does not say so',
} as const
export type ItemFlag = keyof typeof ITEM_FLAGS
export const ItemFlag = z.enum(Object.keys(ITEM_FLAGS) as [ItemFlag, ...ItemFlag[]])

export const DRAFT_STATUSES = {
  generating: 'Generating',
  ready: 'Ready for review',
  partial: 'Partially available',
  failed: 'Failed',
  unavailable: 'Unavailable',
  cancelled: 'Cancelled',
} as const
export type DraftStatus = keyof typeof DRAFT_STATUSES
export const DraftStatus = z.enum(Object.keys(DRAFT_STATUSES) as [DraftStatus, ...DraftStatus[]])

/** Statuses of a draft that is the one to show and to decide on: being made, or finished with statements. A failed or cancelled attempt is not: it never replaces one. */
export const LIVE_DRAFT_STATUSES: readonly DraftStatus[] = ['generating', 'ready', 'partial']

/** A record item a statement rests on, as it was when the draft was made. `change` says whether it has changed since. */
export const ConsultSource = z.object({
  key: z.string(),
  ref: z.string(),
  sourceType: z.string(),
  sourceId: z.uuid().nullable(),
  encounterId: z.uuid().nullable(),
  date: z.string().nullable(),
  field: z.string(),
  status: z.string(),
  provenance: z.string(),
  excerpt: z.string(),
  change: z.enum(['changed', 'removed']).nullable(),
})
export type ConsultSource = z.infer<typeof ConsultSource>

export const ConsultItemDecision = z.enum(['pending', 'accepted', 'edited', 'rejected'])
export type ConsultItemDecision = z.infer<typeof ConsultItemDecision>

export const ConsultItem = z.object({
  id: z.uuid(),
  section: ConsultSection,
  position: z.number().int(),
  text: z.string(),
  support: SupportState,
  /** Why the AI listed it, in its own words (a short sentence). */
  rationale: z.string().nullable(),
  /** What is uncertain or unknown about it, in the AI's own words. Not a measured probability. */
  uncertainty: z.string().nullable(),
  flags: z.array(ItemFlag),
  sources: z.array(ConsultSource),
  /** True when a record item this statement rests on has changed or gone since the draft was made. */
  sourceChanged: z.boolean(),
  decision: ConsultItemDecision,
  finalText: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /** True when the doctor has added this statement (or their edit of it) to the note. */
  inNote: z.boolean(),
  /** The doctor must tick "I have checked this" before accepting it (the server decides: flags, or no source for a suggestion). */
  needsConfirmation: z.boolean(),
})
export type ConsultItem = z.infer<typeof ConsultItem>

/** One thing the explicit rules found in the record (no AI): refs are record items. */
export const RecordFinding = z.object({ text: z.string(), refs: z.array(z.string()), keys: z.array(z.string()) })
export type RecordFinding = z.infer<typeof RecordFinding>
export const RecordCheck = z.object({
  rulesVersion: z.string(),
  conflicts: z.array(RecordFinding),
  outdated: z.array(RecordFinding),
  missing: z.array(RecordFinding),
})
export type RecordCheck = z.infer<typeof RecordCheck>

export const DraftModel = z.object({ provider: z.string(), model: z.string(), runtime: z.string().nullable(), weightsSha256: z.string().nullable(), local: z.boolean() })
export type DraftModel = z.infer<typeof DraftModel>

/** What the checks after the model changed, as counts (the removed text is not kept). */
export const DraftValidation = z.object({ produced: z.number().int(), kept: z.number().int(), removed: z.number().int(), flagged: z.number().int(), reasons: z.record(z.string(), z.number().int()) })
export type DraftValidation = z.infer<typeof DraftValidation>

export const ConsultDraft = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  version: z.number().int(),
  status: DraftStatus,
  /** While generating: waiting for the local model, or running. */
  phase: z.enum(['queued', 'running']).nullable(),
  /** True when the record, the doctor's notes or the confirmed points changed after this draft was made. */
  stale: z.boolean(),
  staleSummary: z.string().nullable(),
  /** The record held too little to draft from: nothing was asked of the model. */
  insufficient: z.boolean(),
  model: DraftModel.nullable(),
  promptVersion: z.string(),
  schemaVersion: z.string(),
  rulesVersion: z.string(),
  contextSha256: z.string(),
  /** Record items the AI was shown, and how many of the available items did not fit. */
  sourceCount: z.number().int(),
  omittedCount: z.number().int(),
  requestedByName: z.string().nullable(),
  /** When the doctor asked for the draft. */
  createdAt: z.string(),
  /**
   * When the local model's turn came and the record was sent to it. Null while the draft waits for the model, and for a draft that never
   * reached it (too little to draft from, or cancelled or refused while waiting). createdAt to startedAt is the wait; startedAt to
   * completedAt is the model writing and the checks after it.
   */
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** From the request to the stored draft (the wait included), measured by the server when the draft was stored. */
  latencyMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  validation: DraftValidation.nullable(),
  recordCheck: RecordCheck,
  items: z.array(ConsultItem),
})
export type ConsultDraft = z.infer<typeof ConsultDraft>

/** The newest attempt, when it did not finish and an earlier, finished draft is the one shown. */
export const ConsultAttempt = z.object({
  version: z.number().int(),
  status: z.enum(['failed', 'cancelled', 'unavailable']),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryable: z.boolean(),
  createdAt: z.string(),
})
export type ConsultAttempt = z.infer<typeof ConsultAttempt>

export const ConsultationAi = z.object({
  status: ReasoningStatus,
  /** Why a draft cannot be requested now (consent, visit state, model unavailable), if so. */
  blockedReason: z.string().nullable(),
  canGenerate: z.boolean(),
  consent: z.object({ state: z.enum(['granted', 'outdated', 'withdrawn', 'not_recorded']), type: z.literal('ai_recording') }),
  /** Where text goes: hosted egress state, so the screen can say "nothing leaves this computer". */
  egress: z.object({ hosted: z.boolean(), destination: z.string().nullable() }),
  /** The draft shown: the newest one that is being made or has statements, else the newest attempt; null when none was ever requested. */
  draft: ConsultDraft.nullable(),
  /** A newer attempt that did not finish (the draft above is an earlier one), so a failed retry does not hide a good draft. */
  lastAttempt: ConsultAttempt.nullable(),
  /** What the explicit rules find in the record right now (no AI): shown when there is no draft to carry it, and whether or not a model is available. */
  recordCheck: RecordCheck.nullable(),
  /** Older drafts of this consultation, newest first (their statements are kept; only the newest is shown). */
  earlier: z.array(z.object({ id: z.uuid(), version: z.number().int(), status: DraftStatus, createdAt: z.string() })),
})
export type ConsultationAi = z.infer<typeof ConsultationAi>

export const GenerateConsultDraftRequest = z.object({ idempotencyKey: z.uuid() })
export type GenerateConsultDraftRequest = z.infer<typeof GenerateConsultDraftRequest>

export const ReviewConsultItemRequest = z.object({
  action: z.enum(['accepted', 'edited', 'rejected']),
  text: z.string().trim().min(1).max(2000).optional(),
  /** Needed to accept a statement that carries a flag or has no verified source (the server decides when). */
  confirmFlags: z.boolean().optional(),
  reason: z.string().trim().max(300).optional(),
})
export type ReviewConsultItemRequest = z.infer<typeof ReviewConsultItemRequest>
