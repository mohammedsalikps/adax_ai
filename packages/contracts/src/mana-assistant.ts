import { z } from 'zod'
import { ReasoningStatus } from './ai.ts'

// ---------------------------------------------------------------------------
// Mana AI (slice V4): the doctor's conversational assistant over the clinic's own records.
//
// The model never touches the database. A question is turned into a PLAN of registered tools (the model chooses among them, nothing else), each
// tool authorises the caller and reads only what it is allowed to (before anything reaches the model), and the model then writes the answer from
// what the tools returned. Code checks that answer; what cannot be checked is not shown. Mana is read-only: no tool writes anything.
// ---------------------------------------------------------------------------

export const MANA_UNAVAILABLE = 'Mana is currently unavailable.'
export const MANA_UNVERIFIED = 'Mana could not safely verify that response.'
export const MANA_NOT_ESTABLISHED = 'That information is not established in the available records.'
/** The records were read and the model wrote nothing that the checks could tie to them (it may have judged that they do not answer the question): not the same as "not recorded". */
export const MANA_NO_ANSWER = 'Mana did not write an answer from the records it read. They are listed below, with what the rules found.'
/** Part of what was read was not given to the model because it reads like an instruction to an AI system: the answer is not complete, and the record itself should be read. */
export const MANA_WITHHELD = 'Part of what was read was not used, because it contains text that reads like an instruction to an AI system. Read the record itself for that part.'
export const MANA_READ_ONLY = 'Mana is read-only: it cannot prescribe, sign, change or delete anything in a record, an appointment or a permission. Use the consultation screen for that.'
export const MANA_NO_KNOWLEDGE_SOURCE = 'Mana searches this clinic’s own records. It has no governed source of general medical knowledge configured, so it does not answer general medical questions.'
export const MANA_OUT_OF_SCOPE = 'Mana can only read what you are already allowed to see in this clinic’s records: your patients, today’s queue and appointments, and your consultations.'

/** The registered tools. The planner may choose only these names; there is no tool that writes. */
export const MANA_TOOLS = {
  get_current_context: 'Who is asking, which consultation and patient are open now, and what the date and time are',
  find_patient: 'Find patients of this clinic by name, MRN or telephone digits',
  get_patient_record: 'Read one patient’s record on a topic (briefing, history, allergies, medicines, vital signs, diagnoses, investigations, changes since the last visit, or a search of the record)',
  get_patient_visits: 'List one patient’s visits: dates, reasons and outcomes, and the date of the last visit',
  get_consultation: 'Read one signed consultation of one patient (the last, the previous one, or one on a date)',
  get_today_queue: 'Today’s queue of this clinic: who is waiting, in triage, ready, with a doctor or done',
  get_recent_visits: 'Patients who checked in within a time window (for example the last two hours, or yesterday)',
  get_appointments: 'Appointments in a time window (today, the next hour, a date), this doctor’s or the clinic’s',
  get_my_consultations: 'The consultations this doctor has done or has open (today, yesterday, a date), with counts',
  get_facility_information: 'This clinic and its departments',
  consultation_context:
    'The consultation this conversation was opened in (D2): what was recorded, said, measured and drafted in it, each with how far it can be trusted; what waits for review; what the rules found to disagree; what is missing',
} as const
export type ManaToolName = keyof typeof MANA_TOOLS
export const MANA_TOOL_NAMES = Object.keys(MANA_TOOLS) as [ManaToolName, ...ManaToolName[]]
export const ManaToolName = z.enum(MANA_TOOL_NAMES)

export const MANA_TOPICS = {
  briefing: 'A short briefing before the consultation',
  history: 'The history on record',
  allergies: 'Allergies on record',
  medicines: 'Medicines: the last prescription and the medicine list',
  vitals: 'Vital signs, compared with the earlier readings',
  diagnoses: 'Diagnoses and conditions on record',
  investigations: 'Investigation results on record',
  changes: 'What changed since the previous visit',
  search: 'Where the record mentions something',
  // The topics of `consultation_context` (one consultation, not the patient's record): see MANA_CONSULTATION_TOPICS.
  consultation_recorded: 'In the open consultation: what was recorded, said, measured and drafted, with how far each can be trusted',
  consultation_review: 'In the open consultation: what waits for the doctor’s review, and what the rules found to disagree',
  consultation_missing: 'In the open consultation: what a consultation usually has and this one does not have yet',
  consultation_thermal: 'In the open consultation: its thermal images, and the measurements of the approved ones',
} as const
export type ManaTopic = keyof typeof MANA_TOPICS
export const MANA_TOPIC_NAMES = Object.keys(MANA_TOPICS) as [ManaTopic, ...ManaTopic[]]
export const ManaTopic = z.enum(MANA_TOPIC_NAMES)
/** The topics that are about the consultation the conversation was opened in (tool `consultation_context`); the others are about a patient's record. */
export const MANA_CONSULTATION_TOPICS = ['consultation_recorded', 'consultation_review', 'consultation_missing', 'consultation_thermal'] as const satisfies readonly ManaTopic[]
export type ManaConsultationTopic = (typeof MANA_CONSULTATION_TOPICS)[number]
export const isConsultationTopic = (t: string | null | undefined): t is ManaConsultationTopic => (MANA_CONSULTATION_TOPICS as readonly string[]).includes(t ?? '')

export const MANA_WHEN = ['last_minutes', 'minutes_ago', 'next_minutes', 'today', 'yesterday', 'tomorrow', 'date'] as const
export const MANA_VISIT_STATUS_FILTER = ['waiting', 'in_triage', 'ready', 'in_consultation', 'completed', 'any'] as const

/**
 * One planned call, in one flat shape so that a small model fills it reliably. Each tool uses the fields it needs and ignores the rest; the server
 * checks the ones it uses. `patient` is a HANDLE, never an identifier: "current" (the open consultation's patient), "P3" (a patient already shown in
 * this conversation), "mrn:ADX-000123" or "name:Rahul".
 */
export const PlannedCall = z.object({
  tool: ManaToolName,
  patient: z.string().max(80).nullable(),
  topic: ManaTopic.nullable(),
  text: z.string().max(120).nullable(),
  which: z.enum(['last', 'previous', 'date']).nullable(),
  when: z.enum(MANA_WHEN).nullable(),
  minutes: z.number().int().min(1).max(1440).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  mine: z.boolean().nullable(),
  status: z.enum(MANA_VISIT_STATUS_FILTER).nullable(),
})
export type PlannedCall = z.infer<typeof PlannedCall>

export const MANA_PLAN_KINDS = ['tools', 'clarify', 'write_request', 'general_knowledge', 'out_of_scope', 'other'] as const
export const ManaPlan = z.object({
  kind: z.enum(MANA_PLAN_KINDS),
  calls: z.array(PlannedCall).max(3),
  /** One question back to the doctor when the request cannot be planned without it. */
  clarification: z.string().max(240).nullable(),
})
export type ManaPlan = z.infer<typeof ManaPlan>

/**
 * What the model writes after the tools have answered: statements that each cite the facts they restate (S1, S2 ...). Nothing else: whether the records
 * disagree, are old or lack something is found by explicit rules and shown by the server (findings), and whether the question was answered is decided by
 * what is left after the checks, not by the model's say-so.
 */
export const ManaModelBlock = z.object({
  text: z.string().max(600),
  refs: z.array(z.string().max(8)).max(8),
})
export type ManaModelBlock = z.infer<typeof ManaModelBlock>
export const ManaModelAnswer = z.object({ blocks: z.array(ManaModelBlock).max(8) })
export type ManaModelAnswer = z.infer<typeof ManaModelAnswer>

/**
 * What the checks found about a statement that kept it but that the doctor should know: it rests on records that disagree, or only on old ones, its
 * wording goes a little beyond the words of the facts it cites (so the doctor should read those facts), or a figure in it was found in another record about the
 * same patient that the model did not cite, which the checks then added to what the statement rests on (so the doctor should check that the record is the right one).
 */
export const MANA_BLOCK_FLAGS = ['involves_conflict', 'record_outdated', 'wording_differs', 'sources_added'] as const
export const ManaAnswerBlock = z.object({
  text: z.string(),
  /** The facts it rests on (S1 ...), all of which exist. */
  refs: z.array(z.string()),
  flags: z.array(z.enum(MANA_BLOCK_FLAGS)),
})
export type ManaAnswerBlock = z.infer<typeof ManaAnswerBlock>

// --- what the doctor's screen receives -------------------------------------------------------------------------------------------------

/** The kinds of record an answer can rest on, in the doctor's words. */
export const MANA_SOURCE_KINDS = {
  patient_record: 'Patient record',
  consultation: 'Consultation (not signed)',
  signed_record: 'Signed record',
  appointment: 'Appointment',
  prescription: 'Prescription',
  investigation: 'Investigation',
  allergy: 'Allergy',
  vital: 'Vital sign',
  operational: 'Operational record',
  facility: 'Clinic information',
} as const
export type ManaSourceKind = keyof typeof MANA_SOURCE_KINDS
export const ManaSourceKind = z.enum(Object.keys(MANA_SOURCE_KINDS) as [ManaSourceKind, ...ManaSourceKind[]])

/**
 * A patient shown in this conversation, by the handle the model uses (P1, P2 ...). The model is not given the name, the MRN or the telephone number of a
 * patient out of the records (the identifiers inside a record's free text are replaced); what the doctor types in a question reaches it as typed.
 */
export const ManaEntity = z.object({
  alias: z.string(),
  displayName: z.string(),
  mrn: z.string(),
  ageSex: z.string(),
  lastVisit: z.string().nullable(),
})
export type ManaEntity = z.infer<typeof ManaEntity>

/** One record the doctor can open: a label in words ("Signed consultation · 28 Sep 2026 · Dr. Meera Iyer"), never a database id, and where to open it. */
export const ManaSourceItem = z.object({
  kind: ManaSourceKind,
  label: z.string(),
  date: z.string().nullable(),
  status: z.string().nullable(),
  excerpt: z.string(),
  /** A page the doctor is already allowed to open. */
  link: z.object({ to: z.enum(['encounter', 'patient']), id: z.uuid() }).nullable(),
})
export type ManaSourceItem = z.infer<typeof ManaSourceItem>

/** What the answer may cite (S1, S2 ...): a statement the tools made from records, and the records it rests on. */
export const ManaAnswerSource = z.object({
  ref: z.string(),
  kind: ManaSourceKind,
  label: z.string(),
  text: z.string(),
  /** The patient it is about, as a handle (the screen shows the name from `entities`). */
  patient: z.string().nullable(),
  items: z.array(ManaSourceItem),
  /** Whether a statement of the answer rests on it (the others were read, and were shown to the model, but nothing in the answer rests on them). */
  cited: z.boolean(),
})
export type ManaAnswerSource = z.infer<typeof ManaAnswerSource>

/** What the tools found by explicit rules, not by the model: shown whatever the model wrote. */
export const ManaFinding = z.object({
  ref: z.string(),
  /** untrusted: a record holds text that reads like an instruction to an AI system; it was not shown to the model (the doctor can read it in the record). */
  kind: z.enum(['conflict', 'outdated', 'absent', 'untrusted']),
  text: z.string(),
  /** The records the rule looked at. */
  items: z.array(ManaSourceItem),
})
export type ManaFinding = z.infer<typeof ManaFinding>

export const ManaToolSummary = z.object({
  position: z.number().int(),
  tool: ManaToolName,
  /** ok: it answered; empty: nothing matched; not_found; ambiguous; refused: not allowed; invalid: the request was not a valid call; error. */
  status: z.enum(['ok', 'empty', 'not_found', 'ambiguous', 'refused', 'invalid', 'error']),
  detail: z.string(),
})
export type ManaToolSummary = z.infer<typeof ManaToolSummary>

// --- HERO final: answers from fixed rules, voice input, and actions the doctor approves ---------------------------------------------------

/**
 * What wrote an answer: `rules` (a deterministic answer composed by the server from structured queries, no model: "From the records (fixed
 * rules)") or `model` (the local language model, checked as before). Absent on answers made before it was recorded: those are the model's.
 */
export const ManaAnswerEngine = z.enum(['rules', 'model'])
export type ManaAnswerEngine = z.infer<typeof ManaAnswerEngine>
export const MANA_RULES_ANSWER_LABEL = 'From the records (fixed rules)'

/** A medicine Mana proposes to add, built only from the doctor's own fully specified words (drug, dose, frequency and duration). */
export const ManaProposedPrescriptionItem = z.object({
  drugName: z.string().min(1).max(160),
  strength: z.string().max(60),
  form: z.string().max(40),
  dose: z.string().min(1).max(60),
  route: z.string().max(40),
  frequency: z.string().min(1).max(60),
  duration: z.string().min(1).max(60),
  durationDays: z.number().int().min(1).max(3650).nullable(),
  instructions: z.string().max(300),
})
export type ManaProposedPrescriptionItem = z.infer<typeof ManaProposedPrescriptionItem>

/** What the fixed checks found about a proposal (an allergy on record in the same group, the same medicine already on the prescription). */
export const ManaActionWarning = z.object({ kind: z.enum(['allergy_conflict', 'duplicate_medicine', 'other']), text: z.string() })
export type ManaActionWarning = z.infer<typeof ManaActionWarning>

/**
 * A consequential action Mana proposes and never carries out: the doctor approves or declines it. Approving records the decision; the medicine
 * is then added to the consultation's unsigned prescription by the doctor's screen (the server never writes the prescription). Ambiguous words
 * never make a proposal: Mana asks for what is missing instead.
 */
export const ManaActionProposal = z.object({
  kind: z.literal('add_prescription_item'),
  encounterId: z.uuid(),
  item: ManaProposedPrescriptionItem,
  /** One line for the card: "Add to the prescription: Amoxicillin 500 mg · three times a day · 5 days". */
  summary: z.string(),
  warnings: z.array(ManaActionWarning),
})
export type ManaActionProposal = z.infer<typeof ManaActionProposal>

export const ManaActionDecision = z.enum(['approved', 'declined'])
export type ManaActionDecision = z.infer<typeof ManaActionDecision>
/** POST /api/mana-assistant/messages/:messageId/decision */
export const ManaActionDecisionRequest = z.object({ decision: ManaActionDecision })
export type ManaActionDecisionRequest = z.infer<typeof ManaActionDecisionRequest>
export const ManaActionDecisionResult = z.object({ messageId: z.uuid(), decision: ManaActionDecision, decidedAt: z.string() })
export type ManaActionDecisionResult = z.infer<typeof ManaActionDecisionResult>

/** POST /api/mana-assistant/voice: one short clip (multipart, one audio file), transcribed in memory by the local speech model and never stored. */
export const MANA_VOICE_MAX_SECONDS = 30
export const MANA_VOICE_MAX_BYTES = 5 * 1024 * 1024
/** The answer: the words heard (the screen puts them in the question box and sends them as a question). */
export const ManaVoiceTranscript = z.object({
  text: z.string(),
  /** Nothing was heard (silence, or no speech the model could read). */
  empty: z.boolean(),
  durationMs: z.number().int().nullable(),
  language: z.string().nullable(),
})
export type ManaVoiceTranscript = z.infer<typeof ManaVoiceTranscript>
/**
 * The text fields of the voice upload (sent before the file). `conversationId`: the conversation the question is for (a consultation's needs the
 * patient's recording consent, as any recording in a consultation does); `durationMs`: how long the browser recorded, refused above the limit.
 */
export const ManaVoiceFields = z.object({
  conversationId: z.uuid().optional(),
  durationMs: z.coerce.number().int().min(0).max(3_600_000).optional(),
})
export type ManaVoiceFields = z.infer<typeof ManaVoiceFields>

/**
 * The questions Mana answers from the records by fixed rules (no model): the words the screen's buttons ask, which the server recognises as it
 * recognises a doctor who types or says them. `needsPatient`: offered only in a conversation about one patient (a consultation or a patient's page).
 */
export const MANA_RULES_QUESTIONS = {
  next_patient: { chip: 'Next patient', text: 'Who is my next patient?', needsPatient: false },
  seen_today: { chip: 'Seen today', text: 'How many patients have I seen today?', needsPatient: false },
  waiting_longest: { chip: 'Waiting longest', text: 'Which of my patients has been waiting longest?', needsPatient: false },
  nurse_triage: { chip: 'Nurse triage', text: 'What did the nurse record at triage?', needsPatient: true },
  orders_status: { chip: 'Lab / orders status', text: 'Which orders are pending?', needsPatient: false },
  allergies: { chip: 'Allergies', text: 'What allergies does this patient have?', needsPatient: true },
} as const
export type ManaRulesQuestion = keyof typeof MANA_RULES_QUESTIONS

export const MANA_OUTCOMES = ['answered', 'not_established', 'ambiguous', 'clarify', 'refused'] as const
export const ManaAnswerBody = z.object({
  outcome: z.enum(MANA_OUTCOMES),
  /**
   * Why Mana did not answer (the read-only message, no knowledge source, out of scope, nothing established): fixed words. The one exception is the question
   * Mana asks back when a request cannot be planned (outcome `clarify`): the planning model writes it, and it is cut to one clean line with no link or markup.
   */
  notice: z.string().nullable(),
  /** Whom the answer is about: the patients whose records were read for it, written out by the server (name, MRN, age and sex), whatever the model wrote. */
  subjects: z.array(ManaEntity),
  blocks: z.array(ManaAnswerBlock),
  findings: z.array(ManaFinding),
  sources: z.array(ManaAnswerSource),
  /** Several patients matched: the doctor chooses one (nothing is guessed). */
  candidates: z.array(ManaEntity),
  entities: z.array(ManaEntity),
  /** Statements of the model's answer that the checks could not verify and removed. */
  removed: z.number().int(),
  /** HERO final: what wrote the answer (absent: the model, as before). */
  engine: ManaAnswerEngine.optional(),
  /** Jury polish: where a fixed-rule answer comes from, in plain words ("From the patient record", "From today's queue", "From service orders"). */
  basis: z.string().max(80).optional(),
  /** HERO final: an action the doctor may approve or decline (absent or null: none). */
  action: ManaActionProposal.nullable().optional(),
})
export type ManaAnswerBody = z.infer<typeof ManaAnswerBody>

export const MANA_MESSAGE_STATUS = ['pending', 'ready', 'refused', 'unverified', 'failed', 'unavailable', 'cancelled'] as const
export type ManaMessageStatus = (typeof MANA_MESSAGE_STATUS)[number]
export const MANA_PHASES = ['queued', 'planning', 'retrieving', 'writing', 'verifying'] as const
export const MANA_PHASE_LABEL: Record<(typeof MANA_PHASES)[number], string> = {
  queued: 'Waiting for the local model',
  planning: 'Working out what to look up',
  retrieving: 'Reading the records you may see',
  writing: 'Writing the answer',
  verifying: 'Checking the answer against the records',
}

export const ManaMessage = z.object({
  id: z.uuid(),
  seq: z.number().int(),
  role: z.enum(['doctor', 'mana']),
  /** What the doctor asked (role doctor). */
  text: z.string().nullable(),
  status: z.enum(MANA_MESSAGE_STATUS),
  phase: z.enum(MANA_PHASES).nullable(),
  answer: ManaAnswerBody.nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  tools: z.array(ManaToolSummary),
  /** Which model and prompts wrote this answer: shown under "details", never in the answer. */
  model: z
    .object({ provider: z.string(), model: z.string(), runtime: z.string().nullable(), weightsSha256: z.string().nullable(), local: z.boolean(), planPrompt: z.string(), answerPrompt: z.string(), checks: z.string(), tools: z.string() })
    .nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  /** HERO final: the doctor's decision on this answer's proposed action, once made (absent or null: not decided). */
  actionDecision: z.object({ decision: ManaActionDecision, decidedAt: z.string() }).nullable().optional(),
})
export type ManaMessage = z.infer<typeof ManaMessage>

export const ManaConversation = z.object({
  id: z.uuid(),
  /** The consultation (and its patient) the conversation was opened in, if any: "this patient" means that patient. */
  scope: z.object({ encounterId: z.uuid().nullable(), patient: z.string().nullable() }),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ManaConversation = z.infer<typeof ManaConversation>

export const ManaConversationState = z.object({
  conversation: ManaConversation,
  messages: z.array(ManaMessage),
  status: ReasoningStatus,
  /** The patient the conversation is about, if any (name and MRN for the header). */
  scopePatient: ManaEntity.nullable(),
})
export type ManaConversationState = z.infer<typeof ManaConversationState>

/**
 * Questions the screen offers as buttons. Each is a plan the server holds (no model is asked what to look up), so the answer starts at once;
 * the words shown on the button are the doctor's question as it is recorded. `needsConsultation`: offered only in a conversation opened in a
 * consultation (the server refuses it elsewhere too).
 */
export const MANA_QUESTIONS = {
  brief_current: { label: 'Brief me on this patient', needsPatient: true, needsConsultation: false },
  allergies_current: { label: 'Allergies on record', needsPatient: true, needsConsultation: false },
  medicines_current: { label: 'Last prescription and medicines', needsPatient: true, needsConsultation: false },
  vitals_current: { label: 'Vital signs compared with earlier', needsPatient: true, needsConsultation: false },
  changes_current: { label: 'What changed since the last visit', needsPatient: true, needsConsultation: false },
  visits_current: { label: 'Visits of this patient', needsPatient: true, needsConsultation: false },
  consultation_recorded: { label: 'What was recorded in this consultation?', needsPatient: true, needsConsultation: true },
  consultation_review: { label: 'What still needs my review?', needsPatient: true, needsConsultation: true },
  consultation_missing: { label: 'What information is missing?', needsPatient: true, needsConsultation: true },
  consultation_thermal: { label: 'Show the thermal measurements from this consultation.', needsPatient: true, needsConsultation: true },
  queue_mine: { label: 'My queue today', needsPatient: false, needsConsultation: false },
  appointments_mine: { label: 'My appointments today', needsPatient: false, needsConsultation: false },
  my_day: { label: 'My consultations today', needsPatient: false, needsConsultation: false },
} as const
export type ManaQuestion = keyof typeof MANA_QUESTIONS
export const ManaQuestion = z.enum(Object.keys(MANA_QUESTIONS) as [ManaQuestion, ...ManaQuestion[]])

export const OpenManaConversationRequest = z.object({
  /** Open (or continue) the conversation for this consultation. */
  encounterId: z.uuid().optional(),
  /** Or for this patient's record (the patient page). Without either, the doctor's general conversation about the clinic. */
  patientId: z.uuid().optional(),
  /** Start a fresh conversation instead of continuing the latest one. */
  fresh: z.boolean().optional(),
})
export type OpenManaConversationRequest = z.infer<typeof OpenManaConversationRequest>

/** A control character (the null character, bell, escape ...) other than a tab or a line break: nothing a question needs, and the database cannot store the null one. */
const hasControlCharacter = (s: string): boolean =>
  [...s].some((ch) => {
    const c = ch.codePointAt(0) ?? 0
    return (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127
  })

export const AskManaAssistantRequest = z.object({
  text: z
    .string()
    .trim()
    .min(2, 'Ask a question')
    .max(500, 'At most 500 characters')
    .refine((s) => !hasControlCharacter(s), 'The question has a character that cannot be used'),
  idempotencyKey: z.uuid(),
  /** Set when the question is one of the suggested ones: the plan is then the server's own and `text` must be its label. */
  suggestion: ManaQuestion.optional(),
})
export type AskManaAssistantRequest = z.infer<typeof AskManaAssistantRequest>

/** The doctor chose one of the patients Mana found (by the handle it showed). */
export const SelectManaCandidateRequest = z.object({
  alias: z.string().regex(/^P\d{1,2}$/),
  idempotencyKey: z.uuid(),
})
export type SelectManaCandidateRequest = z.infer<typeof SelectManaCandidateRequest>

export const ManaAssistantStatus = z.object({ reasoning: ReasoningStatus, unavailableMessage: z.string() })
export type ManaAssistantStatus = z.infer<typeof ManaAssistantStatus>
