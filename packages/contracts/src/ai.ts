import { z } from 'zod'

/** Note sections the assistant may draft into (never diagnoses or prescriptions). */
export const AI_SECTIONS = ['chiefComplaint', 'history', 'pastHistory', 'examination', 'assessment', 'plan', 'followUp'] as const
export const AiSection = z.enum(AI_SECTIONS)
export type AiSection = z.infer<typeof AiSection>

export const ProviderStatus = z.object({ available: z.boolean(), provider: z.string().nullable(), model: z.string().nullable(), reason: z.string().nullable() })
/**
 * The local speech service. `available` is true only when it answered a health check as ready just now; `state` says why not
 * otherwise. It is always local: there is no hosted speech-to-text, and nothing falls back to one.
 */
export const SpeechStatus = ProviderStatus.extend({
  state: z.enum(['ready', 'loading', 'unavailable', 'not_configured']),
  /** True when the service is on this computer (a loopback address). False only if the operator pointed it at another host on purpose; there is never a hosted one. */
  local: z.boolean(),
  /** Where it is (host:port) when it is not on this computer; null when it is. */
  host: z.string().nullable(),
  runtime: z.string().nullable(),
  weightsSha256: z.string().nullable(),
})
export type SpeechStatus = z.infer<typeof SpeechStatus>
/** The "important points" extractor: fixed, versioned rules that run in this process. */
export const ExtractionStatus = z.object({ available: z.boolean(), provider: z.string(), version: z.string(), local: z.boolean(), languages: z.array(z.string()), reason: z.string().nullable() })
export type ExtractionStatus = z.infer<typeof ExtractionStatus>
export const AiFeatures = z.object({ noteDraft: z.boolean(), extraction: z.boolean(), recommendations: z.boolean(), imageAnalysis: z.boolean(), liveTranscription: z.boolean(), patientQa: z.boolean(), consultationDraft: z.boolean() })
/**
 * Whether consultation text may go to a hosted AI provider (a server setting; a provider key alone never allows it) and, if so, to which host. It
 * carries no key and no way to change it: the screen can only show it.
 */
export const AiEgress = z.object({ hosted: z.boolean(), destination: z.string().nullable() })
export type AiEgress = z.infer<typeof AiEgress>
/** `qa`: Mana AI summaries of the patient record. */
/**
 * The language model that writes consultation drafts and answers (V3, V4), as its server said just now: a local open-weight model by default, a hosted
 * one only behind the egress policy, or none. Never a guess from configuration alone, and never a fallback from one to another.
 */
export const ReasoningStatus = z.object({
  available: z.boolean(),
  mode: z.enum(['local', 'hosted', 'none']),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  state: z.enum(['ready', 'loading', 'unavailable', 'not_configured']),
  /** True when the model runs on this computer. */
  local: z.boolean(),
  runtime: z.string().nullable(),
  /** SHA-256 of the weights, known only when the running model is the pinned one. */
  weightsSha256: z.string().nullable(),
  reason: z.string().nullable(),
})
export type ReasoningStatus = z.infer<typeof ReasoningStatus>

export const AiStatus = z.object({ llm: ProviderStatus, stt: SpeechStatus, extraction: ExtractionStatus, vision: ProviderStatus, qa: ProviderStatus, reasoning: ReasoningStatus, features: AiFeatures, liveChunkSeconds: z.number(), egress: AiEgress })
export type AiStatus = z.infer<typeof AiStatus>

export const TranscriptSource = z.enum(['typed', 'pasted', 'audio_upload', 'browser_recording'])
/** Who the doctor may assign a line to. "Unknown" clears an assignment (the line is then shown as not assigned). */
export const SPEAKER_LABELS = ['Doctor', 'Patient', 'Nurse', 'Relative', 'Attendant', 'Other'] as const
export const SpeakerLabel = z.enum([...SPEAKER_LABELS, 'Unknown'])
export type SpeakerLabel = z.infer<typeof SpeakerLabel>
/** typed_label: a "Doctor:" prefix someone typed. provider: a diariser said so (none is installed). doctor_assigned: the doctor set it, reviewed metadata. */
export const SpeakerSource = z.enum(['typed_label', 'provider', 'doctor_assigned', 'none'])
export type SpeakerSource = z.infer<typeof SpeakerSource>

/**
 * `id` is the citation label (S1, S2, ...). A line spoken into the microphone has a start and end on the recording's own timeline
 * (milliseconds of recorded audio, pauses excluded), a detected language and the model's own score; a typed line has none of those.
 * `confidence` is the mean token probability the model gave its words: a model score, not a calibrated chance that the text is right.
 */
export const TranscriptSegment = z.object({
  id: z.string(),
  speaker: z.string().nullable(),
  text: z.string(),
  chunkIndex: z.number().nullable().optional(),
  startMs: z.number().nullable().optional(),
  endMs: z.number().nullable().optional(),
  language: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  speakerSource: SpeakerSource.optional(),
  speakerAssignedAt: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
})
export type TranscriptSegment = z.infer<typeof TranscriptSegment>

/** One recorded part of a live transcript (sent as its own audio file). */
export const TranscriptChunk = z.object({ index: z.number(), offsetMs: z.number(), durationMs: z.number().nullable(), language: z.string().nullable(), status: z.enum(['received', 'transcribed', 'failed']) })
export type TranscriptChunk = z.infer<typeof TranscriptChunk>
export const TRANSCRIPT_END_REASONS = { doctor_stopped: 'Stopped by the doctor', consent_withdrawn: 'Stopped: consent was withdrawn', stale_replaced: 'Ended: a newer recording was started', error: 'Ended after an error' } as const
export const TranscriptEndReason = z.enum(Object.keys(TRANSCRIPT_END_REASONS) as [keyof typeof TRANSCRIPT_END_REASONS, ...(keyof typeof TRANSCRIPT_END_REASONS)[]])

export const Transcript = z.object({
  id: z.uuid(),
  source: TranscriptSource,
  /** live: a recording in progress, segments still arriving chunk by chunk. */
  status: z.enum(['final', 'live']),
  audioFileId: z.uuid().nullable(),
  segments: z.array(TranscriptSegment),
  /** The language most lines were detected in (null when none was: typed text, or nothing heard yet). */
  language: z.string().nullable(),
  chunks: z.array(TranscriptChunk),
  endedAt: z.string().nullable(),
  endReason: TranscriptEndReason.nullable(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
})
export type Transcript = z.infer<typeof Transcript>

/** Fields of one recorded part (multipart, before the file). `offsetMs` is where the part starts on the recording's timeline. */
export const ChunkFields = z.object({
  chunkIndex: z.coerce.number().int().min(0).max(1_000),
  offsetMs: z.coerce.number().int().min(0).max(12 * 3600 * 1000),
})
export type ChunkFields = z.infer<typeof ChunkFields>

/** The doctor assigns who spoke a line. Persisted as reviewed metadata; the words are never changed. */
export const SpeakerAssignmentRequest = z.object({
  assignments: z.array(z.object({ segmentId: z.string().regex(/^S\d{1,5}$/, 'Use a segment label such as S3'), speaker: SpeakerLabel })).min(1, 'Choose at least one line').max(200, 'At most 200 lines at once'),
})
export type SpeakerAssignmentRequest = z.infer<typeof SpeakerAssignmentRequest>

export const EndTranscriptRequest = z.object({ reason: z.enum(['doctor_stopped', 'consent_withdrawn']).default('doctor_stopped') })
export type EndTranscriptRequest = z.input<typeof EndTranscriptRequest>

export const CreateTranscriptRequest = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Enter the transcript')
    .max(50_000, 'At most 50,000 characters')
    .refine((t) => !t.includes('\u0000'), 'The text contains characters that cannot be stored'),
  source: z.enum(['typed', 'pasted']).default('pasted'),
})
export type CreateTranscriptRequest = z.input<typeof CreateTranscriptRequest>

export const DraftDecision = z.enum(['pending', 'accepted', 'edited', 'rejected', 'deferred', 'superseded'])
export const AiDraftItem = z.object({
  id: z.uuid(),
  section: AiSection,
  text: z.string(),
  sourceSegmentIds: z.array(z.string()),
  /** True when the model cited no segment that exists in the transcript. */
  unsupported: z.boolean(),
  decision: DraftDecision,
  finalText: z.string().nullable(),
  decidedAt: z.string().nullable(),
})
export type AiDraftItem = z.infer<typeof AiDraftItem>

export const AiRun = z.object({
  id: z.uuid(),
  jobId: z.uuid().nullable(),
  kind: z.string(),
  status: z.enum(['succeeded', 'failed']),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string().nullable(),
  /** local: ran on this machine; external: the text left it. Null for runs recorded before this was kept. */
  locality: z.enum(['local', 'external']).nullable(),
  runtime: z.string().nullable(),
  weightsSha256: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  latencyMs: z.number().nullable(),
  createdAt: z.string(),
})
export type AiRun = z.infer<typeof AiRun>

export const AiDraft = z.object({
  id: z.uuid(),
  transcriptId: z.uuid(),
  createdAt: z.string(),
  run: AiRun,
  items: z.array(AiDraftItem),
})
export type AiDraft = z.infer<typeof AiDraft>

export const AudioRecording = z.object({ fileId: z.uuid(), source: z.enum(['audio_upload', 'browser_recording']), mimeType: z.string(), sizeBytes: z.number(), createdAt: z.string(), transcriptId: z.uuid().nullable() })
export type AudioRecording = z.infer<typeof AudioRecording>

export const EncounterAi = z.object({
  consent: z.object({
    granted: z.boolean(),
    scope: z.enum(['ongoing', 'encounter']).nullable(),
    recordedAt: z.string().nullable(),
    /** Wording version agreed to; only the current wording covers record-aware assistance. */
    version: z.string().nullable(),
    current: z.boolean(),
  }),
  status: AiStatus,
  audio: z.array(AudioRecording),
  transcripts: z.array(Transcript),
  drafts: z.array(AiDraft),
  runs: z.array(AiRun),
  jobs: z.array(z.lazy(() => AiJob)),
  facts: z.array(z.lazy(() => ClinicalFact)),
  recommendations: z.array(z.lazy(() => Recommendation)),
  reviewActions: z.array(z.lazy(() => ReviewAction)),
  audit: z.array(z.lazy(() => AiAuditEntry)),
})
export type EncounterAi = z.infer<typeof EncounterAi>

export const DraftDecisionRequest = z.object({
  decision: z.enum(['accepted', 'edited', 'rejected']),
  /** Required for "edited": the doctor's corrected text. */
  text: z.string().trim().max(8000).optional(),
  /** Required to accept an item the model could not tie to the transcript. */
  confirmUnsupported: z.boolean().optional(),
})
export type DraftDecisionRequest = z.input<typeof DraftDecisionRequest>

export const AiConsentRequest = z.object({ method: z.enum(['verbal', 'written']) })

// ---------------------------------------------------------------------------
// Expanded clinical AI: jobs, extracted facts, evidence, recommendations,
// review actions. Everything here is a draft until a doctor acts on it.
// ---------------------------------------------------------------------------

export const AI_JOB_KINDS = ['transcription', 'note_draft', 'extraction', 'safety_check', 'recommendations', 'image_analysis', 'patient_qa', 'consultation_draft'] as const
export const AiJobKind = z.enum(AI_JOB_KINDS)
export type AiJobKind = z.infer<typeof AiJobKind>

export const FACT_CATEGORIES = {
  chief_complaint: 'Chief complaint',
  symptom: 'Symptom',
  duration: 'Duration',
  patient_concern: 'Patient concern',
  past_medical_history: 'Past medical history',
  medication_history: 'Medication history',
  allergy: 'Allergy',
  family_history: 'Family history',
  social_history: 'Social history',
  examination_finding: 'Examination finding',
  vital_sign: 'Vital sign (mentioned)',
  clinician_assessment: 'Clinician’s assessment',
  plan: 'Plan',
  medication_mention: 'Medicine mentioned in plan',
  investigation_mention: 'Investigation mentioned',
  follow_up: 'Follow-up',
  red_flag: 'Red-flag statement',
} as const
export type FactCategory = keyof typeof FACT_CATEGORIES
export const FactCategory = z.enum(Object.keys(FACT_CATEGORIES) as [FactCategory, ...FactCategory[]])

/** Note section an accepted fact may be inserted into (null: review only). */
export const FACT_SECTION: Record<FactCategory, AiSection | null> = {
  chief_complaint: 'chiefComplaint',
  symptom: 'history',
  duration: 'history',
  patient_concern: 'history',
  past_medical_history: 'pastHistory',
  medication_history: 'pastHistory',
  allergy: 'pastHistory',
  family_history: 'pastHistory',
  social_history: 'pastHistory',
  examination_finding: 'examination',
  vital_sign: 'examination',
  clinician_assessment: 'assessment',
  plan: 'plan',
  medication_mention: 'plan',
  investigation_mention: 'plan',
  follow_up: 'followUp',
  red_flag: null,
}

/** Where a statement comes from. Kept distinct everywhere it is shown. */
export const PROVENANCE_LABELS = {
  patient_reported: 'Patient said',
  clinician_stated: 'Clinician said',
  transcript_unlabelled: 'Transcript (speaker not identified)',
  record: 'Existing record',
  device_measured: 'Device reading (unverified)',
  staff_measured: 'Measured by staff',
  ai_generated: 'AI suggestion',
} as const
export type Provenance = keyof typeof PROVENANCE_LABELS

export const FACT_FLAGS = {
  uncertain: 'Uncertain or unclear in the conversation',
  no_source: 'Not linked to any transcript line',
  conflicts_with_record: 'Conflicts with the existing record',
  not_in_record: 'Not in the existing record',
  speaker_mismatch: 'Attributed speaker does not match the transcript',
  red_flag: 'Red-flag statement',
} as const
export type FactFlag = keyof typeof FACT_FLAGS
/** Flags that must be explicitly confirmed before a fact can be accepted. */
export const CONFIRM_FLAGS: FactFlag[] = ['uncertain', 'no_source', 'conflicts_with_record', 'speaker_mismatch']

export const ReviewStatus = z.enum(['pending', 'accepted', 'edited', 'rejected', 'deferred', 'superseded'])
export type ReviewStatus = z.infer<typeof ReviewStatus>

/**
 * The three things a consultation screen must never blur: the RAW transcript (what the system heard), an EXTRACTED draft (what the system
 * thinks may matter) and what the doctor CONFIRMED. A point is a draft until the doctor accepts or edits it; rejecting it keeps the record that it was seen.
 */
export const FACT_STATE_LABELS = { extracted: 'Extracted draft', confirmed: 'Doctor confirmed', rejected: 'Doctor rejected', superseded: 'Replaced by a newer run' } as const
export type FactState = keyof typeof FACT_STATE_LABELS
export function factState(status: ReviewStatus): FactState {
  if (status === 'accepted' || status === 'edited') return 'confirmed'
  if (status === 'rejected') return 'rejected'
  if (status === 'superseded') return 'superseded'
  return 'extracted'
}

export const Evidence = z.object({
  id: z.uuid(),
  relation: z.enum(['supports', 'conflicts']),
  sourceType: z.string(),
  sourceId: z.string().nullable(),
  sourceRef: z.string(),
  provenance: z.string(),
  excerpt: z.string(),
  note: z.string().nullable(),
})
export type Evidence = z.infer<typeof Evidence>

export const ClinicalFact = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  transcriptId: z.uuid(),
  category: FactCategory,
  text: z.string(),
  attribution: z.enum(['patient_reported', 'clinician_stated', 'other_speaker']),
  certainty: z.enum(['stated', 'uncertain']),
  uncertaintyReason: z.string().nullable(),
  negated: z.boolean(),
  attributes: z.record(z.string(), z.unknown()),
  flags: z.array(z.string()),
  status: ReviewStatus,
  finalText: z.string().nullable(),
  decidedAt: z.string().nullable(),
  evidence: z.array(Evidence),
  createdAt: z.string(),
  /** The transcript lines (S1, S2, ...) this point rests on. */
  sourceSegmentIds: z.array(z.string()),
  /** What produced it: for an extraction by rules, `provider` is "adaxai-rules" and `version` the rule set. */
  producedBy: z.object({ provider: z.string(), model: z.string(), version: z.string().nullable(), local: z.boolean().nullable() }),
  /** True when a speaker label of one of its source lines was changed after it was extracted: its attribution may be out of date. */
  speakerChanged: z.boolean(),
})
export type ClinicalFact = z.infer<typeof ClinicalFact>

/** What the capture panel needs to decide whether recording may start, and to notice when it must stop. Polled; contains no patient content. */
export const CaptureStatus = z.object({
  consent: z.object({ granted: z.boolean(), scope: z.enum(['ongoing', 'encounter']).nullable(), recordedAt: z.string().nullable(), current: z.boolean() }),
  speech: SpeechStatus,
  live: z.object({ transcriptId: z.uuid().nullable(), startedAt: z.string().nullable(), lastChunkAt: z.string().nullable() }),
  /** False when recording must not start (no consent, no local speech service, consultation closed), with the reason in words. */
  canRecord: z.boolean(),
  blockedReason: z.string().nullable(),
  /** Set when this consultation can no longer take a recording at all (signed, discarded, not the author's, or the visit is no longer with the doctor): a recording in progress must stop. */
  closedReason: z.string().nullable(),
})
export type CaptureStatus = z.infer<typeof CaptureStatus>

export const RECOMMENDATION_KINDS = {
  red_flag: 'Red flag',
  safety_check: 'Safety check',
  clarification: 'Clarify',
  missing_information: 'Missing information',
  investigation: 'Consider investigation',
  follow_up: 'Follow-up',
  referral_consideration: 'Consider referral',
  documentation: 'Documentation',
} as const
export type RecommendationKind = keyof typeof RECOMMENDATION_KINDS

export const Recommendation = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  source: z.enum(['rules', 'llm']),
  kind: z.string(),
  urgency: z.enum(['routine', 'attention']),
  text: z.string(),
  rationale: z.string(),
  instruction: z.string().nullable(),
  missingInformation: z.array(z.object({ text: z.string() })),
  unsupported: z.boolean(),
  status: ReviewStatus,
  finalText: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /** Provider, model and prompt or rules version of the run that produced it. */
  producedBy: z.object({ provider: z.string(), model: z.string(), version: z.string().nullable() }),
  evidence: z.array(Evidence),
})
export type Recommendation = z.infer<typeof Recommendation>

export const AiJob = z.object({
  id: z.uuid(),
  kind: AiJobKind,
  status: z.enum(['running', 'succeeded', 'failed']),
  attempts: z.number(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  retryable: z.boolean(),
  dataOrigin: z.string(),
  settingsSha256: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  createdByName: z.string().nullable(),
  runs: z.array(AiRun),
})
export type AiJob = z.infer<typeof AiJob>

export const ReviewAction = z.object({
  id: z.uuid(),
  subjectType: z.string(),
  subjectId: z.uuid(),
  action: z.string(),
  text: z.string().nullable(),
  reason: z.string().nullable(),
  actorName: z.string().nullable(),
  createdAt: z.string(),
})
export type ReviewAction = z.infer<typeof ReviewAction>

export const AiAuditEntry = z.object({ id: z.string(), action: z.string(), outcome: z.string(), actorName: z.string().nullable(), occurredAt: z.string() })
export type AiAuditEntry = z.infer<typeof AiAuditEntry>

export const ReviewRequest = z.object({
  action: z.enum(['accepted', 'edited', 'rejected', 'deferred']),
  /** Required for "edited". */
  text: z.string().trim().max(8000).optional(),
  reason: z.string().trim().max(500).optional(),
  /** Required to accept an item with review flags or without verified support. */
  confirmFlags: z.boolean().optional(),
})
export type ReviewRequest = z.input<typeof ReviewRequest>

/** Optional client-generated key that makes a job-starting request safe to resend. */
export const JobRequest = z.object({ idempotencyKey: z.uuid().optional() })
export type JobRequest = z.input<typeof JobRequest>
