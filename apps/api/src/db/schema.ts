// Drizzle schema. Source of truth for generated migrations in ../../drizzle.
// Tables are added milestone by milestone; never edit an applied migration.
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

/** Case-insensitive text (extension `citext`, created in 0000_extensions). */
export const citext = customType<{ data: string }>({ dataType: () => 'citext' })

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

/** A clinic / OPD site. The MVP runs a single facility; the table keeps room for more. */
export const facilities = pgTable('facilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
})

// ---------------------------------------------------------------------------
// Identity and access
// ---------------------------------------------------------------------------

export const userRole = pgEnum('user_role', ['admin', 'doctor', 'nurse', 'patient'])

export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id').notNull().references(() => facilities.id),
    code: citext('code').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('departments_facility_code_uq').on(t.facilityId, t.code)],
)

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id').notNull().references(() => facilities.id),
    username: citext('username').notNull().unique(),
    fullName: text('full_name').notNull(),
    role: userRole('role').notNull(),
    passwordHash: text('password_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    departmentId: uuid('department_id').references(() => departments.id),
    /** Medical council registration number (doctors). Free text, not verified. */
    registrationNumber: text('registration_number'),
    /** Set for role = patient; FK added with the patients table. */
    patientId: uuid('patient_id'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
    ...timestamps,
  },
  (t) => [index('users_role_idx').on(t.role)],
)

/** Server-side sessions. Only a SHA-256 hash of the cookie token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

/**
 * Append-only audit trail. UPDATE, DELETE and TRUNCATE are blocked by
 * triggers (migration 0003), and the application role holds no UPDATE or
 * DELETE privilege on it (migration 0019). Since migration 0019 every new
 * event is linked into a SHA-256 hash chain by a database trigger
 * (chain_seq, prev_hash, row_hash); events from before that are summarised by
 * the `audit.chain_start` event. See docs/adr/0008.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    outcome: text('outcome').notNull().default('success'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    patientId: uuid('patient_id'),
    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    /** Facility the event belongs to (actor's or patient's); null for anonymous events and rows before migration 0017. */
    facilityId: uuid('facility_id'),
    /** Hash chain, set by the database (never by the application); null for events before migration 0019. */
    chainSeq: bigint('chain_seq', { mode: 'number' }),
    prevHash: text('prev_hash'),
    rowHash: text('row_hash'),
    chainVersion: smallint('chain_version'),
  },
  (t) => [
    uniqueIndex('audit_events_chain_seq_uq').on(t.chainSeq),
    index('audit_events_occurred_idx').on(t.occurredAt),
    index('audit_events_facility_idx').on(t.facilityId, t.occurredAt),
    index('audit_events_actor_idx').on(t.actorUserId),
    index('audit_events_patient_idx').on(t.patientId),
    index('audit_events_action_idx').on(t.action),
  ],
)

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export const sex = pgEnum('sex', ['female', 'male', 'other', 'unknown'])

/** MRNs come from this sequence: ADX-001001, ADX-001002, ... */
export const patientMrnSeq = pgSequence('patient_mrn_seq', { startWith: 1001, minValue: 1 })

export const patients = pgTable(
  'patients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    mrn: citext('mrn')
      .notNull()
      .unique()
      .default(sql`'ADX-' || lpad(nextval('patient_mrn_seq')::text, 6, '0')`),
    givenName: text('given_name').notNull(),
    familyName: text('family_name'),
    /** Lower-cased full name for search (trigram index). */
    searchName: text('search_name').generatedAlwaysAs(sql`lower(given_name || ' ' || coalesce(family_name, ''))`),
    dateOfBirth: date('date_of_birth').notNull(),
    dateOfBirthEstimated: boolean('date_of_birth_estimated').notNull().default(false),
    sex: sex('sex').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    addressLine: text('address_line'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    /** ABHA number as entered (digits). Not verified with ABDM. */
    abhaNumber: text('abha_number'),
    bloodGroup: text('blood_group'),
    preferredLanguage: text('preferred_language'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    noKnownAllergies: boolean('no_known_allergies').notNull().default(false),
    /** synthetic or clinical, from DATA_ORIGIN when the patient was registered; 'unspecified' for records that predate it. */
    dataOrigin: text('data_origin').notNull().default('unspecified'),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [
    check('patients_data_origin_check', sql`data_origin in ('unspecified', 'synthetic', 'clinical')`),
    index('patients_search_name_trgm').using('gin', sql`${t.searchName} gin_trgm_ops`),
    index('patients_phone_idx').on(t.phone),
    index('patients_dob_idx').on(t.dateOfBirth),
  ],
)

export const allergySeverity = pgEnum('allergy_severity', ['mild', 'moderate', 'severe', 'unknown'])

export const allergies = pgTable(
  'allergies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    substance: text('substance').notNull(),
    reaction: text('reaction'),
    severity: allergySeverity('severity').notNull().default('unknown'),
    status: text('status').notNull().default('active'),
    recordedBy: uuid('recorded_by').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('allergies_patient_idx').on(t.patientId)],
)

export const consentType = pgEnum('consent_type', ['data_processing', 'ai_recording', 'thermal_imaging', 'device_monitoring', 'portal_access', 'research_use', 'clinical_photography', 'ai_image_analysis', 'ai_record_assistant'])
export const consentMethod = pgEnum('consent_method', ['verbal', 'written', 'digital'])

/**
 * Consent records are never deleted or rewritten. A granted consent ends once:
 * withdrawn (with who, when, why and how) or superseded by a renewal under
 * newer wording (trigger, migration 0017). At most one ongoing grant per
 * patient and purpose is active.
 */
export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    type: consentType('type').notNull(),
    status: text('status').notNull().default('granted'),
    method: consentMethod('method').notNull(),
    scope: text('scope').notNull().default('ongoing'),
    /** Set for encounter-scoped consent (FK added with encounters). */
    encounterId: uuid('encounter_id'),
    /** Version of the consent wording shown or read to the patient. */
    version: text('version').notNull().default('2026-10-v1'),
    notes: text('notes'),
    recordedBy: uuid('recorded_by').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnBy: uuid('withdrawn_by').references(() => users.id),
    /** Optional reason given at withdrawal (shown on the record; never copied into the audit log). */
    withdrawReason: text('withdraw_reason'),
    /** staff | patient_portal */
    withdrawnVia: text('withdrawn_via'),
    /** The renewal that replaced this grant (status superseded). */
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => consents.id),
  },
  (t) => [
    index('consents_patient_idx').on(t.patientId, t.type),
    uniqueIndex('consents_one_active_ongoing_uq').on(t.patientId, t.type).where(sql`status = 'granted' and scope = 'ongoing'`),
    check('consents_status_check', sql`${t.status} in ('granted', 'withdrawn', 'superseded')`),
  ],
)

/** One-time codes a patient uses to activate their portal account. Only a hash is stored. */
export const patientActivationCodes = pgTable(
  'patient_activation_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activation_codes_patient_idx').on(t.patientId)],
)

// ---------------------------------------------------------------------------
// OPD visits (queue) and observations
// ---------------------------------------------------------------------------

export const visitStatus = pgEnum('visit_status', ['waiting', 'in_triage', 'ready', 'in_consultation', 'completed', 'cancelled', 'no_show'])
export const visitPriority = pgEnum('visit_priority', ['normal', 'urgent'])

export const visits = pgTable(
  'visits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    assignedDoctorId: uuid('assigned_doctor_id').references(() => users.id),
    /** Calendar day in the facility's timezone. */
    visitDate: date('visit_date').notNull(),
    tokenNumber: integer('token_number').notNull(),
    status: visitStatus('status').notNull().default('waiting'),
    priority: visitPriority('priority').notNull().default('normal'),
    chiefComplaint: text('chief_complaint'),
    statusReason: text('status_reason'),
    createdBy: uuid('created_by').references(() => users.id),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }).notNull().defaultNow(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('visits_token_uq').on(t.facilityId, t.visitDate, t.tokenNumber),
    // At most one open visit per patient per day.
    uniqueIndex('visits_one_open_per_day_uq')
      .on(t.patientId, t.visitDate)
      .where(sql`status in ('waiting', 'in_triage', 'ready', 'in_consultation')`),
    index('visits_date_status_idx').on(t.facilityId, t.visitDate, t.status),
    index('visits_patient_idx').on(t.patientId),
  ],
)

/** Atomic per-day token numbers (INSERT ... ON CONFLICT DO UPDATE ... RETURNING). */
export const dailyTokenCounters = pgTable(
  'daily_token_counters',
  {
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    visitDate: date('visit_date').notNull(),
    lastToken: integer('last_token').notNull(),
  },
  (t) => [primaryKey({ columns: [t.facilityId, t.visitDate] })],
)

export const vitalKind = pgEnum('vital_kind', ['heart_rate', 'respiratory_rate', 'systolic_bp', 'diastolic_bp', 'temperature', 'spo2', 'weight', 'height', 'blood_glucose', 'pain_score'])
export const observationSource = pgEnum('observation_source', ['manual', 'device'])

/**
 * Measurements. Never deleted or edited: a wrong value is marked
 * entered-in-error (with a reason) and the corrected value is recorded anew.
 */
export const observations = pgTable(
  'observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    visitId: uuid('visit_id').references(() => visits.id),
    kind: vitalKind('kind').notNull(),
    value: numeric('value', { precision: 8, scale: 2, mode: 'number' }).notNull(),
    unit: text('unit').notNull(),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
    source: observationSource('source').notNull().default('manual'),
    /** manual_entry | device_unverified | simulated (a device simulator generated it: not a measurement). Checked by the database (migration 0029). */
    validationStatus: text('validation_status').notNull().default('manual_entry'),
    /** Device that produced the value (source = device). */
    deviceId: uuid('device_id').references((): AnyPgColumn => devices.id),
    /** The gateway batch a device reading arrived in (V5; older device readings have none). */
    deviceBatchId: uuid('device_batch_id').references((): AnyPgColumn => deviceBatches.id),
    recordedBy: uuid('recorded_by').references(() => users.id),
    enteredInError: boolean('entered_in_error').notNull().default(false),
    enteredInErrorReason: text('entered_in_error_reason'),
    enteredInErrorBy: uuid('entered_in_error_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('observations_patient_kind_idx').on(t.patientId, t.kind, t.measuredAt), index('observations_visit_idx').on(t.visitId), index('observations_device_idx').on(t.deviceId, t.measuredAt).where(sql`${t.deviceId} is not null`), index('observations_device_kind_idx').on(t.deviceId, t.kind, t.measuredAt).where(sql`${t.deviceId} is not null`)],
)

// ---------------------------------------------------------------------------
// Consultations (encounters), diagnoses, prescriptions, amendments
// ---------------------------------------------------------------------------

export const encounterStatus = pgEnum('encounter_status', ['in_progress', 'signed', 'discarded'])

/**
 * A consultation for a visit: in_progress (an unsigned draft), then signed or
 * discarded, never both and never back. A visit has at most one consultation
 * that is not discarded. Signed and discarded rows, and their diagnoses and
 * prescription items, are immutable (database triggers, migrations 0006 and
 * 0019); signed records are corrected only by appending amendments. Every
 * status change is recorded in encounter_status_events by the database.
 */
export const encounters = pgTable(
  'encounters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    visitId: uuid('visit_id')
      .notNull()
      .references(() => visits.id),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id),
    status: encounterStatus('status').notNull().default('in_progress'),
    version: integer('version').notNull().default(1),
    chiefComplaint: text('chief_complaint').notNull().default(''),
    history: text('history').notNull().default(''),
    pastHistory: text('past_history').notNull().default(''),
    examination: text('examination').notNull().default(''),
    assessment: text('assessment').notNull().default(''),
    plan: text('plan').notNull().default(''),
    followUp: text('follow_up').notNull().default(''),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /** Canonical JSON of what was signed, and its SHA-256. */
    signedSnapshot: jsonb('signed_snapshot'),
    contentHash: text('content_hash'),
    /** How content_hash was computed (e.g. adaxai.encounter.v2); null for records signed before migration 0019 (scheme v1). */
    hashScheme: text('hash_scheme'),
    /** A draft closed without signing: kept read-only with who, when and why. */
    discardedAt: timestamp('discarded_at', { withTimezone: true }),
    discardedBy: uuid('discarded_by').references(() => users.id),
    discardReason: text('discard_reason'),
  },
  (t) => [
    index('encounters_patient_idx').on(t.patientId),
    index('encounters_doctor_status_idx').on(t.doctorId, t.status),
    uniqueIndex('encounters_one_active_per_visit_uq').on(t.visitId).where(sql`status <> 'discarded'`),
    index('encounters_visit_idx').on(t.visitId),
    check('encounters_signed_complete', sql`status <> 'signed' or (signed_at is not null and signed_snapshot is not null and content_hash is not null)`),
    check('encounters_discarded_complete', sql`status <> 'discarded' or (discarded_at is not null and discarded_by is not null and length(btrim(coalesce(discard_reason, ''))) > 0)`),
    check('encounters_hash_scheme_format', sql`hash_scheme is null or hash_scheme ~ '^adaxai[.]encounter[.]v[0-9]+$'`),
  ],
)

/**
 * Status history of consultations, written by a database trigger on every
 * insert and status change (append-only). Consultations from before
 * migration 0019 have a single baseline event.
 */
export const encounterStatusEvents = pgTable(
  'encounter_status_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    visitId: uuid('visit_id')
      .notNull()
      .references(() => visits.id),
    fromStatus: encounterStatus('from_status'),
    toStatus: encounterStatus('to_status').notNull(),
    source: text('source').notNull(),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('encounter_status_events_encounter_idx').on(t.encounterId, t.id)],
)

/**
 * Status history of visits, written by a database trigger on check-in and on
 * every status change (append-only), with the acting user, the source of the
 * change and the reason. The same trigger refuses transitions that are not
 * allowed (migration 0019). Visits from before 0019 have a baseline event.
 */
export const visitStatusEvents = pgTable(
  'visit_status_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    visitId: uuid('visit_id')
      .notNull()
      .references(() => visits.id),
    fromStatus: visitStatus('from_status'),
    toStatus: visitStatus('to_status').notNull(),
    source: text('source').notNull(),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('visit_status_events_visit_idx').on(t.visitId, t.id)],
)

export const diagnosisKind = pgEnum('diagnosis_kind', ['provisional', 'primary', 'secondary'])

export const diagnoses = pgTable(
  'diagnoses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    description: text('description').notNull(),
    /** ICD-10 code as typed; format-checked only, not validated against a code set. */
    code: text('code'),
    kind: diagnosisKind('kind').notNull().default('primary'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('diagnoses_encounter_idx').on(t.encounterId)],
)

export const prescriptionItems = pgTable(
  'prescription_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    drugName: text('drug_name').notNull(),
    strength: text('strength').notNull().default(''),
    form: text('form').notNull().default(''),
    dose: text('dose').notNull(),
    route: text('route').notNull().default('Oral'),
    frequency: text('frequency').notNull(),
    duration: text('duration').notNull(),
    instructions: text('instructions').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('prescription_items_encounter_idx').on(t.encounterId)],
)

// ---------------------------------------------------------------------------
// Uploaded files and the AI consultation assistant
// ---------------------------------------------------------------------------

/** Uploaded binaries live on disk (STORAGE_DIR); this row is their metadata and access anchor. */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id').references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    /** consultation_audio | stethoscope_audio | thermal_raw | thermal_matrix | thermal_visual | dataset_export */
    kind: text('kind').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    originalName: text('original_name'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the stored bytes were removed (retention); the row is kept. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedReason: text('deleted_reason'),
  },
  (t) => [index('files_encounter_idx').on(t.encounterId), index('files_patient_idx').on(t.patientId)],
)

/** Every call to an external AI provider: what ran, with which model and prompt version, and how it ended. Content is not duplicated here. */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null only for runs recorded before jobs existed (migration 0011). */
    jobId: uuid('job_id').references((): AnyPgColumn => aiJobs.id),
    patientId: uuid('patient_id').references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version'),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    inputSha256: text('input_sha256'),
    outputSha256: text('output_sha256'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    providerRequestId: text('provider_request_id'),
    /** local: ran on this machine (a rule set, the local speech model); external: the text left it. Null on runs recorded before V2. */
    locality: text('locality'),
    /** The runtime that ran it, e.g. "faster-whisper 1.2.1 / ctranslate2 4.8.2". */
    runtime: text('runtime'),
    /** SHA-256 of the model weights file, so a transcript can be tied to the exact model that made it. */
    weightsSha256: text('weights_sha256'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_runs_encounter_idx').on(t.encounterId), index('ai_runs_job_idx').on(t.jobId), check('ai_runs_locality_check', sql`${t.locality} is null or ${t.locality} in ('local', 'external')`)],
)

export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    source: text('source').notNull(),
    /**
     * Where the audio came from (HERO): microphone | upload | demo_synthetic (computer voices playing a script, accepted only where simulators are allowed).
     * Null for typed or pasted text, and for transcripts of audio made before it was recorded (migration 0032 claims nothing about those).
     */
    audioOrigin: text('audio_origin'),
    audioFileId: uuid('audio_file_id').references(() => files.id),
    sttRunId: uuid('stt_run_id').references(() => aiRuns.id),
    /** final | live (recording in progress; segments still being added) */
    status: text('status').notNull().default('final'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** doctor_stopped | consent_withdrawn | stale_replaced | error: why a live recording ended. */
    endReason: text('end_reason'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transcripts_encounter_idx').on(t.encounterId),
    // Two recordings cannot run at once on one consultation (two tabs, a retry): the second is refused.
    uniqueIndex('transcripts_one_live_uq').on(t.encounterId).where(sql`status = 'live'`),
    check('transcripts_end_reason_check', sql`${t.endReason} is null or ${t.endReason} in ('doctor_stopped', 'consent_withdrawn', 'stale_replaced', 'error')`),
    // Audio from a microphone or a demo is a recording's (its parts come from the browser); an uploaded file is an upload; typed text has no audio.
    check('transcripts_audio_origin_check', sql`${t.audioOrigin} is null or (${t.audioOrigin} = 'upload' and ${t.source} = 'audio_upload') or (${t.audioOrigin} in ('microphone', 'demo_synthetic') and ${t.source} = 'browser_recording')`),
  ],
)

/**
 * One recorded part of a live transcript. `offsetMs` is where it starts on the recording's own timeline (recorded audio only, pauses
 * excluded) and `durationMs` is what the speech service decoded; segment times are offset + the part's own times. The unique index
 * makes a re-sent part a refusal, not a duplicate.
 */
export const transcriptChunks = pgTable(
  'transcript_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transcriptId: uuid('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    chunkIndex: integer('chunk_index').notNull(),
    fileId: uuid('file_id').references(() => files.id),
    offsetMs: integer('offset_ms').notNull(),
    durationMs: integer('duration_ms'),
    language: text('language'),
    runId: uuid('run_id').references(() => aiRuns.id),
    /** received | transcribed | failed */
    status: text('status').notNull().default('received'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('transcript_chunks_part_uq').on(t.transcriptId, t.chunkIndex),
    check('transcript_chunks_status_check', sql`${t.status} in ('received', 'transcribed', 'failed')`),
    check('transcript_chunks_offset_check', sql`${t.offsetMs} >= 0 and (${t.durationMs} is null or ${t.durationMs} >= 0)`),
  ],
)

export const aiDrafts = pgTable(
  'ai_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    transcriptId: uuid('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_drafts_encounter_idx').on(t.encounterId)],
)

/** One suggested passage. Nothing reaches the note until a doctor accepts or edits it. */
export const aiDraftItems = pgTable(
  'ai_draft_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => aiDrafts.id),
    section: text('section').notNull(),
    text: text('text').notNull(),
    sourceSegmentIds: jsonb('source_segment_ids').notNull(),
    unsupported: boolean('unsupported').notNull().default(false),
    decision: text('decision').notNull().default('pending'),
    finalText: text('final_text'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('ai_draft_items_draft_idx').on(t.draftId)],
)

/**
 * One numbered part of a transcript (S1, S2, ...). AI output cites these
 * labels. Append-only (trigger, migration 0011): the transcript is evidence.
 */
export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transcriptId: uuid('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    seq: integer('seq').notNull(),
    label: text('label').notNull(),
    speaker: text('speaker'),
    /** typed_label (a "Doctor:" prefix) | provider (speech-to-text diarisation) | none */
    speakerSource: text('speaker_source').notNull().default('none'),
    text: text('text').notNull(),
    /** Live recording: which chunk produced it (display order is chunk, then seq). */
    chunkIndex: integer('chunk_index'),
    startMs: integer('start_ms'),
    endMs: integer('end_ms'),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }),
    /** Language the speech model detected for this line (a code such as "en"); null for typed text. */
    language: text('language'),
    /** What the model reported for the decoded window: kept as reported, never edited. */
    avgLogprob: numeric('avg_logprob', { precision: 8, scale: 4, mode: 'number' }),
    noSpeechProb: numeric('no_speech_prob', { precision: 6, scale: 4, mode: 'number' }),
    /** The speech run (model, runtime, weights) that produced it; null for typed text and for lines made before V2. */
    runId: uuid('run_id').references((): AnyPgColumn => aiRuns.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('transcript_segments_label_uq').on(t.transcriptId, t.label), index('transcript_segments_order_idx').on(t.transcriptId, t.chunkIndex, t.seq)],
)

/**
 * Who the doctor says spoke a line. Append-only: the segment (the words) never changes; the latest assignment is the reviewed speaker,
 * and every earlier one stays. "Unknown" clears an assignment.
 */
export const transcriptSegmentSpeakers = pgTable(
  'transcript_segment_speakers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => transcriptSegments.id),
    speaker: text('speaker').notNull(),
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transcript_segment_speakers_segment_idx').on(t.segmentId, t.assignedAt),
    check('transcript_segment_speakers_check', sql`${t.speaker} in ('Doctor', 'Patient', 'Nurse', 'Relative', 'Attendant', 'Other', 'Unknown')`),
  ],
)

/** Prompt text versions, registered at start-up; an id can never change its text (checksum). */
export const aiPromptVersions = pgTable('ai_prompt_versions', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Non-secret AI settings in effect for a job (config/adaxai.yaml + env model overrides). */
export const aiSettingsSnapshots = pgTable('ai_settings_snapshots', {
  sha256: text('sha256').primaryKey(),
  settings: jsonb('settings').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Providers and models that have actually been called (or rule sets that ran). */
export const aiModels = pgTable(
  'ai_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** llm | stt | vision | rules */
    capability: text('capability').notNull(),
    firstUsedAt: timestamp('first_used_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ai_models_uq').on(t.provider, t.model, t.capability)],
)

/**
 * A requested piece of AI or rules processing (transcription, extraction,
 * note draft, recommendations, image analysis). Each attempt is an ai_run.
 * A failed job can be retried; an idempotency key stops double submission.
 */
export const aiJobs = pgTable(
  'ai_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    kind: text('kind').notNull(),
    /** running | succeeded | failed */
    status: text('status').notNull().default('running'),
    /** What the job worked on, e.g. { transcriptId } or { imageId } or { fileId, chunkIndex }. */
    input: jsonb('input').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    retryable: boolean('retryable').notNull().default(false),
    /** Short outcome summary, e.g. { facts: 7 } or { recommendations: 0, insufficientData: "..." }. No patient text. */
    summary: jsonb('summary'),
    idempotencyKey: text('idempotency_key'),
    dataOrigin: text('data_origin').notNull(),
    settingsSha256: text('settings_sha256').references(() => aiSettingsSnapshots.sha256),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('ai_jobs_encounter_idx').on(t.encounterId),
    index('ai_jobs_patient_idx').on(t.patientId),
    index('ai_jobs_created_idx').on(t.facilityId, t.createdAt),
    uniqueIndex('ai_jobs_idempotency_uq').on(t.createdBy, t.idempotencyKey),
    check('ai_jobs_status_check', sql`${t.status} in ('running', 'succeeded', 'failed')`),
    check('ai_jobs_origin_check', sql`${t.dataOrigin} in ('clinical', 'synthetic')`),
  ],
)

/**
 * A clinical fact extracted from a transcript. Never part of the record by
 * itself: the doctor accepts, edits, rejects or defers it.
 */
export const clinicalFacts = pgTable(
  'clinical_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => aiJobs.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id),
    transcriptId: uuid('transcript_id')
      .notNull()
      .references(() => transcripts.id),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    category: text('category').notNull(),
    text: text('text').notNull(),
    /** Who the transcript attributes it to: patient_reported | clinician_stated | other_speaker */
    attribution: text('attribution').notNull(),
    /** stated | uncertain (unclear speech, hedged or ambiguous) */
    certainty: text('certainty').notNull(),
    uncertaintyReason: text('uncertainty_reason'),
    negated: boolean('negated').notNull().default(false),
    /** Normalised details used for record comparison, e.g. { substance } or { vitalKind, value, unit }. */
    attributes: jsonb('attributes').notNull().default(sql`'{}'::jsonb`),
    /** Review flags: uncertain, no_source, conflicts_with_record, not_in_record, speaker_mismatch, red_flag */
    flags: jsonb('flags').notNull().default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('pending'),
    finalText: text('final_text'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('clinical_facts_encounter_idx').on(t.encounterId), index('clinical_facts_job_idx').on(t.jobId)],
)

/** Decision-support suggestions (rules or language model). Drafts only, until a doctor acts. */
export const aiRecommendations = pgTable(
  'ai_recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => aiJobs.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    /** rules | llm */
    source: text('source').notNull(),
    kind: text('kind').notNull(),
    /** routine | attention */
    urgency: text('urgency').notNull().default('routine'),
    text: text('text').notNull(),
    rationale: text('rationale').notNull(),
    /** [{ text }] what the system could not find. */
    missingInformation: jsonb('missing_information').notNull().default(sql`'[]'::jsonb`),
    /** True when none of the cited support could be verified. */
    unsupported: boolean('unsupported').notNull().default(false),
    instruction: text('instruction'),
    status: text('status').notNull().default('pending'),
    finalText: text('final_text'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_recommendations_encounter_idx').on(t.encounterId)],
)

/**
 * Provenance: links an AI output (fact, recommendation, image analysis) to the
 * transcript segment or record item that supports or conflicts with it, with
 * a snapshot of that source as it was. Append-only.
 */
export const aiEvidence = pgTable(
  'ai_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** supports | conflicts */
    relation: text('relation').notNull(),
    /** transcript_segment | allergy | observation | diagnosis | prescription_item | encounter_note | prior_encounter | thermal_capture | clinical_image | patient */
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    /** Reference as shown to the model and the doctor, e.g. S3, A1, V2. */
    sourceRef: text('source_ref').notNull(),
    /** patient_reported | clinician_stated | record | device_measured | staff_measured | ai_generated */
    provenance: text('provenance').notNull(),
    excerpt: text('excerpt').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_evidence_subject_idx').on(t.subjectType, t.subjectId)],
)

/** Every doctor review action on an AI output. Append-only. */
export const aiReviewActions = pgTable(
  'ai_review_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** fact | recommendation | draft_item | image_analysis | routing_suggestion */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    action: text('action').notNull(),
    text: text('text'),
    reason: text('reason'),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_review_actions_subject_idx').on(t.subjectType, t.subjectId), index('ai_review_actions_encounter_idx').on(t.encounterId)],
)

/** A clinical photograph. The original file is kept unchanged; a metadata-free preview is shown. */
export const clinicalImages = pgTable(
  'clinical_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    previewFileId: uuid('preview_file_id')
      .notNull()
      .references(() => files.id),
    imageType: text('image_type').notNull(),
    /** upload | camera */
    source: text('source').notNull(),
    bodySite: text('body_site'),
    description: text('description'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** { format, hadExif, hadGps, ... } from the image service. */
    metadata: jsonb('metadata').notNull(),
    dataOrigin: text('data_origin').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('clinical_images_patient_idx').on(t.patientId), index('clinical_images_encounter_idx').on(t.encounterId)],
)

/** AI description of an image: unverified until a doctor reviews it. */
export const imageAnalyses = pgTable(
  'image_analyses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    imageId: uuid('image_id')
      .notNull()
      .references(() => clinicalImages.id),
    jobId: uuid('job_id')
      .notNull()
      .references(() => aiJobs.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id),
    /** { quality, observations[], limitations[], summary } */
    result: jsonb('result').notNull(),
    status: text('status').notNull().default('pending'),
    finalText: text('final_text'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('image_analyses_image_idx').on(t.imageId)],
)

/** Deterministic routing suggestion for a visit, and what staff did with it. */
export const routingSuggestions = pgTable(
  'routing_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    visitId: uuid('visit_id')
      .notNull()
      .references(() => visits.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    rulesVersion: text('rules_version').notNull(),
    /** { departmentId, departmentCode, priority, doctorId, missingIntake[], redFlags[], reasons[] } */
    suggestion: jsonb('suggestion').notNull(),
    /** pending | applied | overridden | dismissed | superseded */
    status: text('status').notNull().default('pending'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewReason: text('review_reason'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('routing_suggestions_visit_idx').on(t.visitId)],
)

/** Stored evaluation results (thermal dataset evaluation, AI review metrics). Append-only. */
export const evaluationRuns = pgTable(
  'evaluation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    /** thermal_dataset | ai_review */
    kind: text('kind').notNull(),
    subjectId: uuid('subject_id'),
    pipelineVersion: text('pipeline_version').notNull(),
    nonClinical: boolean('non_clinical').notNull(),
    metrics: jsonb('metrics').notNull(),
    reportMarkdown: text('report_markdown'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('evaluation_runs_kind_idx').on(t.facilityId, t.kind, t.createdAt)],
)

/** Which records went into which dataset export (internal ids stay here, never in the export). */
export const datasetMemberships = pgTable(
  'dataset_memberships',
  {
    exportId: uuid('export_id')
      .notNull()
      .references(() => thermalDatasetExports.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    exportLocalId: text('export_local_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.exportId, t.entityType, t.entityId] })],
)

// ---------------------------------------------------------------------------
// Thermal imaging
// ---------------------------------------------------------------------------

/**
 * A radiometric thermal image and its extracted temperature matrix. Draft
 * until a doctor approves or rejects it; then it and its ROIs are frozen
 * (trigger, migration 0009).
 */
export const thermalCaptures = pgTable(
  'thermal_captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    rawFileId: uuid('raw_file_id')
      .notNull()
      .references(() => files.id),
    matrixFileId: uuid('matrix_file_id')
      .notNull()
      .references(() => files.id),
    visibleFileId: uuid('visible_file_id').references(() => files.id),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    minC: numeric('min_c', { precision: 6, scale: 2, mode: 'number' }).notNull(),
    maxC: numeric('max_c', { precision: 6, scale: 2, mode: 'number' }).notNull(),
    meanC: numeric('mean_c', { precision: 6, scale: 2, mode: 'number' }).notNull(),
    camera: jsonb('camera').notNull(),
    parameters: jsonb('parameters').notNull(),
    extractor: jsonb('extractor').notNull(),
    protocol: jsonb('protocol').notNull(),
    pairStats: jsonb('pair_stats').notNull().default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('draft'),
    reviewNote: text('review_note'),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** clinical | synthetic | public_sample - set at upload from deployment config or a known sample checksum. */
    dataOrigin: text('data_origin').notNull().default('synthetic'),
    /** V6: how the image arrived (live_capture | gallery_import | file_upload | simulator). Captures before V6 are file_upload. */
    captureSource: text('capture_source').notNull().default('file_upload'),
    /** V6: true exactly for the simulator's captures (CHECK); never shown to a patient, a model, Mana or a dataset. */
    simulated: boolean('simulated').notNull().default(false),
    /** V6: the registered device it was matched to by serial number, if any. */
    deviceId: uuid('device_id').references(() => devices.id),
    /** V6: when the camera says it took the image (device bridge), if it said. */
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    /** V6: what the device bridge reported (model, serial, firmware, SDK, bridge), as reported: not verified. */
    deviceReported: jsonb('device_reported'),
    /** V6: whole-image standard deviation, °C (null for captures stored before V6). */
    stdC: numeric('std_c', { precision: 6, scale: 2, mode: 'number' }),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [
    check('thermal_captures_data_origin_check', sql`${t.dataOrigin} in ('clinical', 'synthetic', 'public_sample')`),
    check('thermal_captures_source_check', sql`${t.captureSource} in ('live_capture', 'gallery_import', 'file_upload', 'simulator')`),
    check('thermal_captures_simulated_check', sql`${t.simulated} = (${t.captureSource} = 'simulator') and (not ${t.simulated} or ${t.dataOrigin} = 'synthetic')`),
    index('thermal_captures_patient_idx').on(t.patientId),
    index('thermal_captures_encounter_idx').on(t.encounterId),
  ],
)

export const thermalRois = pgTable(
  'thermal_rois',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => thermalCaptures.id),
    label: text('label').notNull(),
    shape: text('shape').notNull(),
    x: numeric('x', { precision: 10, scale: 2, mode: 'number' }).notNull(),
    y: numeric('y', { precision: 10, scale: 2, mode: 'number' }).notNull(),
    width: numeric('width', { precision: 10, scale: 2, mode: 'number' }).notNull(),
    height: numeric('height', { precision: 10, scale: 2, mode: 'number' }).notNull(),
    pairWith: text('pair_with'),
    /** V6: a polygon's corners [[x, y], ...] in image pixels (null for rect and ellipse). */
    points: jsonb('points'),
    /** V6: the doctor's note on this region. */
    note: text('note'),
    stats: jsonb('stats').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('thermal_rois_shape_check', sql`${t.shape} in ('rect', 'ellipse', 'polygon') and ((${t.shape} = 'polygon') = (${t.points} is not null))`),
    index('thermal_rois_capture_idx').on(t.captureId),
  ],
)

/**
 * V6: a clinician-facing summary of one thermal study, composed by fixed rules from the measurements (no language model), then decided once by
 * a doctor: accepted, edited (the edit is `final_text`) or rejected. Only an accepted or edited summary can be added to a consultation note,
 * through the note insertion route. Trigger in migration 0031: a decided summary, and what any summary says, never changes; none is deleted.
 */
export const thermalSummaries = pgTable(
  'thermal_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => thermalCaptures.id),
    composerVersion: text('composer_version').notNull(),
    rulesVersion: text('rules_version'),
    /** The thermal model status when it was composed (V6: none installed). */
    model: jsonb('model').notNull(),
    statements: jsonb('statements').notNull(),
    text: text('text').notNull(),
    /** pending | accepted | edited | rejected */
    status: text('status').notNull().default('pending'),
    finalText: text('final_text'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    simulated: boolean('simulated').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('thermal_summaries_status_check', sql`${t.status} in ('pending', 'accepted', 'edited', 'rejected')`),
    check('thermal_summaries_decision_check', sql`(${t.status} = 'pending') = (${t.decidedAt} is null) and ((${t.status} = 'edited') = (${t.finalText} is not null))`),
    index('thermal_summaries_capture_idx').on(t.captureId),
    index('thermal_summaries_encounter_idx').on(t.encounterId),
  ],
)

/**
 * Clinician labels on reviewed thermal captures, for building evaluation
 * datasets. Never deleted: a label is withdrawn (once, with a reason) and a
 * new one added. Trigger in migration 0010 enforces this.
 */
export const thermalLabels = pgTable(
  'thermal_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => thermalCaptures.id),
    /** capture | roi */
    scope: text('scope').notNull(),
    roiLabel: text('roi_label'),
    code: text('code').notNull(),
    referenceStandard: text('reference_standard').notNull(),
    certainty: text('certainty').notNull(),
    note: text('note'),
    taxonomyVersion: text('taxonomy_version').notNull(),
    labelledBy: uuid('labelled_by')
      .notNull()
      .references(() => users.id),
    labelledAt: timestamp('labelled_at', { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnBy: uuid('withdrawn_by').references(() => users.id),
    withdrawReason: text('withdraw_reason'),
  },
  (t) => [
    check('thermal_labels_scope_check', sql`(${t.scope} = 'capture' and ${t.roiLabel} is null) or (${t.scope} = 'roi' and ${t.roiLabel} is not null)`),
    index('thermal_labels_capture_idx').on(t.captureId),
    // One active label per rater per image (or per region).
    uniqueIndex('thermal_labels_one_active_per_rater').on(t.captureId, t.labelledBy, sql`coalesce(lower(${t.roiLabel}), '')`).where(sql`${t.withdrawnAt} is null`),
  ],
)

/** De-identified dataset exports (the ZIP is a stored file). Never changed or deleted; evaluations are evaluation_runs. */
export const thermalDatasetExports = pgTable('thermal_dataset_exports', {
  id: uuid('id').primaryKey().defaultRandom(),
  facilityId: uuid('facility_id')
    .notNull()
    .references(() => facilities.id),
  fileId: uuid('file_id')
    .notNull()
    .references(() => files.id),
  summary: jsonb('summary').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Devices: registry, assignment, gateway ingestion boundary, auscultation audio
// ---------------------------------------------------------------------------

/**
 * A registered device. `integration` states honestly how data gets in:
 * manual_upload (files uploaded by staff), gateway_api (a separate gateway
 * posts readings with the device token), not_integrated, or simulator: not a
 * device at all but a program that generates values. A record is a simulator
 * from the start or never (database trigger, migration 0029), and what arrives
 * through one is stored as simulated.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    /** wearable_band | smart_stethoscope | thermal_camera | other */
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    manufacturer: text('manufacturer'),
    model: text('model'),
    serialNumber: text('serial_number').notNull(),
    /** active | retired */
    status: text('status').notNull().default('active'),
    integration: text('integration').notNull().default('not_integrated'),
    notes: text('notes'),
    /** SHA-256 of the gateway token; the token itself is shown once and never stored. */
    ingestTokenHash: text('ingest_token_hash'),
    tokenCreatedAt: timestamp('token_created_at', { withTimezone: true }),
    /** When the gateway last presented this device's token (any request): what "disconnected" is decided from. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [uniqueIndex('devices_serial_uq').on(t.facilityId, t.serialNumber), uniqueIndex('devices_token_uq').on(t.ingestTokenHash)],
)

/** Which patient a device is attached to. At most one open assignment per device. */
export const deviceAssignments = pgTable(
  'device_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    visitId: uuid('visit_id').references(() => visits.id),
    /** The consultation the device was attached in, when it was attached from one (V5). */
    encounterId: uuid('encounter_id').references(() => encounters.id),
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    /** Readings measured at or after this time are refused (null: until the assignment is ended). Set when assigned, never changed. */
    validUntil: timestamp('valid_until', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: uuid('ended_by').references(() => users.id),
    endReason: text('end_reason'),
  },
  (t) => [uniqueIndex('device_assignments_one_open_uq').on(t.deviceId).where(sql`${t.endedAt} is null`), index('device_assignments_patient_idx').on(t.patientId)],
)

/**
 * One accepted request of a device gateway: a batch of readings, or one stethoscope recording. Append-only. The key makes ingestion idempotent:
 * a gateway that sends a batch again (a retry after a lost answer) gets the first answer and nothing is stored twice; the same key with other
 * content is refused. `simulated` is copied from the device record at the time: it never comes from what the sender says.
 */
export const deviceBatches = pgTable(
  'device_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => deviceAssignments.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    /** readings | auscultation */
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** SHA-256 of what was sent, in a fixed form: tells a repeat from a different batch under the same key. */
    payloadSha256: text('payload_sha256').notNull(),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    itemCount: integer('item_count').notNull(),
    simulated: boolean('simulated').notNull(),
  },
  (t) => [uniqueIndex('device_batches_key_uq').on(t.deviceId, t.idempotencyKey), index('device_batches_patient_idx').on(t.patientId, t.measuredAt), index('device_batches_assignment_idx').on(t.assignmentId)],
)

/** A stethoscope (auscultation) recording: a file chosen by staff, a recording made in the browser, or one sent by a gateway. Append-only. */
export const auscultationRecordings = pgTable(
  'auscultation_recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    deviceId: uuid('device_id').references(() => devices.id),
    /** e.g. aortic, pulmonic, tricuspid, mitral, lung_left_upper ... */
    site: text('site').notNull(),
    note: text('note'),
    dataOrigin: text('data_origin').notNull(),
    /** file_upload | browser_recording | gateway (V5). None is a verified stethoscope connection. */
    captureMethod: text('capture_method').notNull().default('file_upload'),
    /** Generated by a simulator: tones, not a body sound. Copied from the device record, never from what the sender says. */
    simulated: boolean('simulated').notNull().default(false),
    durationMs: integer('duration_ms'),
    /** The name the browser gave the audio input (browser recordings); as reported, not verified. */
    inputLabel: text('input_label'),
    deviceBatchId: uuid('device_batch_id').references(() => deviceBatches.id),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auscultation_patient_idx').on(t.patientId)],
)

/**
 * Post-signing corrections. Append-only (triggers block UPDATE/DELETE); they
 * never change the signed record. Since migration 0019 the database numbers
 * each amendment (seq) and links it into a hash chain that starts at the
 * signed record's content_hash; older amendments have no hash.
 */
export const encounterAmendments = pgTable(
  'encounter_amendments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    seq: integer('seq'),
    prevHash: text('prev_hash'),
    contentHash: text('content_hash'),
    hashScheme: text('hash_scheme'),
  },
  (t) => [index('amendments_encounter_idx').on(t.encounterId), uniqueIndex('amendments_encounter_seq_uq').on(t.encounterId, t.seq)],
)

// ---------------------------------------------------------------------------
// Mana AI (patient-context questions) and AI text inserted into notes
// ---------------------------------------------------------------------------

/**
 * A doctor's question about one patient and Mana's answer. The record answer
 * (documented facts, explicit rules) and the cited source excerpts are
 * written once and never change; only the AI-generated part may be filled in
 * or retried while it is pending or failed (trigger, migration 0015).
 */
export const manaQuestions = pgTable(
  'mana_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    encounterId: uuid('encounter_id').references(() => encounters.id),
    askedBy: uuid('asked_by')
      .notNull()
      .references(() => users.id),
    question: text('question').notNull(),
    intent: text('intent').notNull(),
    rulesVersion: text('rules_version').notNull(),
    /** Sections of documented statements, each citing source refs. */
    recordAnswer: jsonb('record_answer').notNull(),
    /** Snapshot of every record item the answer may cite (ManaSource[]). */
    sources: jsonb('sources').notNull(),
    /** pending | succeeded | failed | unavailable | consent_required | not_requested */
    generationStatus: text('generation_status').notNull(),
    generationReason: text('generation_reason'),
    generationRetryable: boolean('generation_retryable').notNull().default(false),
    /** { statements, notFound } from the language model, citations verified. */
    generated: jsonb('generated'),
    jobId: uuid('job_id').references(() => aiJobs.id),
    runId: uuid('run_id').references(() => aiRuns.id),
    idempotencyKey: text('idempotency_key'),
    dataOrigin: text('data_origin').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mana_questions_patient_idx').on(t.patientId, t.createdAt),
    uniqueIndex('mana_questions_idempotency_uq').on(t.askedBy, t.idempotencyKey),
    check('mana_questions_generation_check', sql`${t.generationStatus} in ('pending', 'succeeded', 'failed', 'unavailable', 'consent_required', 'not_requested')`),
  ],
)

/**
 * AI-produced text a doctor inserted into a consultation note, with a
 * reference to the AI artifact it came from. Append-only; the signed snapshot
 * lists these references.
 */
export const noteInsertions = pgTable(
  'note_insertions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    section: text('section').notNull(),
    text: text('text').notNull(),
    /** draft_item | fact | recommendation | mana_answer | image_analysis */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** Provider / model / prompt or rules version of the artifact, as known when inserted. */
    producedBy: text('produced_by'),
    insertedBy: uuid('inserted_by')
      .notNull()
      .references(() => users.id),
    insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('note_insertions_encounter_idx').on(t.encounterId),
    index('note_insertions_subject_idx').on(t.subjectType, t.subjectId),
    // The same text from the same artifact goes into a section once.
    uniqueIndex('note_insertions_once_uq').on(t.encounterId, t.subjectType, t.subjectId, t.section, sql`md5(${t.text})`),
  ],
)

// ---------------------------------------------------------------------------
// Appointments, their status history, and notifications (slice 4)
// ---------------------------------------------------------------------------

export const appointmentStatus = pgEnum('appointment_status', ['booked', 'checked_in', 'completed', 'cancelled', 'rescheduled', 'no_show'])

/**
 * A booked slot for a patient. It is a promise, not a visit: checking in
 * creates or links exactly one visit (visit_id). The time is an instant;
 * the facility's timezone gives its local day and clock time. While booked
 * or checked in, a doctor and a patient each hold their slot (exclusion
 * constraints, migration 0022). Rescheduling replaces the row with a new
 * one (rescheduled_from / rescheduled_to), so no earlier state is erased.
 * Closed appointments are frozen, rows are never deleted, and every status
 * change is recorded in appointment_status_events by a trigger.
 */
export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    doctorId: uuid('doctor_id').references(() => users.id),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    /** What the patient says the visit is for (free text, as typed by staff). */
    reason: text('reason'),
    status: appointmentStatus('status').notNull().default('booked'),
    statusReason: text('status_reason'),
    version: integer('version').notNull().default(1),
    /** Set at check-in: the one visit this appointment became or joined. */
    visitId: uuid('visit_id').references(() => visits.id),
    rescheduledFrom: uuid('rescheduled_from').references((): AnyPgColumn => appointments.id),
    rescheduledTo: uuid('rescheduled_to').references((): AnyPgColumn => appointments.id),
    /** Client-chosen key that makes a retried booking or reschedule return the same appointment. */
    idempotencyKey: uuid('idempotency_key'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('appointments_facility_time_idx').on(t.facilityId, t.scheduledAt),
    index('appointments_patient_time_idx').on(t.patientId, t.scheduledAt),
    index('appointments_doctor_time_idx').on(t.doctorId, t.scheduledAt),
    uniqueIndex('appointments_idempotency_uq')
      .on(t.facilityId, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    uniqueIndex('appointments_visit_uq')
      .on(t.visitId)
      .where(sql`visit_id is not null`),
    uniqueIndex('appointments_rescheduled_from_uq')
      .on(t.rescheduledFrom)
      .where(sql`rescheduled_from is not null`),
    check('appointments_duration_check', sql`duration_minutes between 5 and 240`),
    check('appointments_slot_check', sql`(extract(epoch from scheduled_at)::bigint % 300) = 0`),
    check('appointments_reason_length', sql`length(coalesce(reason, '')) <= 300 and length(coalesce(status_reason, '')) <= 300`),
    check('appointments_visit_link_check', sql`(status in ('checked_in', 'completed') and visit_id is not null) or (status in ('booked', 'rescheduled') and visit_id is null) or status in ('cancelled', 'no_show')`),
    check('appointments_rescheduled_check', sql`(status = 'rescheduled') = (rescheduled_to is not null)`),
    check('appointments_cancel_reason_check', sql`status <> 'cancelled' or length(btrim(coalesce(status_reason, ''))) > 0`),
    check('appointments_not_self_check', sql`rescheduled_from is distinct from id and rescheduled_to is distinct from id`),
  ],
)

/** Who changed an appointment's status, when, how and why. Written by a trigger; append-only. */
export const appointmentStatusEvents = pgTable(
  'appointment_status_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    fromStatus: appointmentStatus('from_status'),
    toStatus: appointmentStatus('to_status').notNull(),
    source: text('source').notNull(),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('appointment_status_events_appointment_idx').on(t.appointmentId, t.id)],
)

/**
 * Outbox of messages to patients. The only channel is `in_app` (the patient
 * portal): "delivered" means it is available there. No SMS, email or push
 * provider exists, so none is claimed. One row per (appointment, event):
 * dedup_key is unique, so a retried request never queues a message twice.
 * The payload holds no clinical content (times, department, clinician name).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid('appointment_id').references(() => appointments.id),
    /** appointment.booked | appointment.rescheduled | appointment.cancelled */
    kind: text('kind').notNull(),
    channel: text('channel').notNull().default('in_app'),
    dedupKey: text('dedup_key').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    /** queued | delivered | undeliverable | failed */
    status: text('status').notNull().default('queued'),
    failureCode: text('failure_code'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notifications_dedup_uq').on(t.dedupKey),
    index('notifications_patient_idx').on(t.patientId, t.createdAt),
    index('notifications_appointment_idx').on(t.appointmentId),
    check('notifications_status_check', sql`status in ('queued', 'delivered', 'undeliverable', 'failed')`),
    check('notifications_channel_check', sql`channel in ('in_app')`),
    check('notifications_delivered_check', sql`(status = 'delivered') = (delivered_at is not null)`),
  ],
)

/** One row per delivery attempt, with its outcome. Append-only. */
export const notificationAttempts = pgTable(
  'notification_attempts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id),
    attemptNo: integer('attempt_no').notNull(),
    outcome: text('outcome').notNull(),
    code: text('code'),
    /** The staff member who asked for the retry; null for the first, automatic attempt. */
    actorUserId: uuid('actor_user_id').references(() => users.id),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_attempts_uq').on(t.notificationId, t.attemptNo), check('notification_attempts_outcome_check', sql`outcome in ('delivered', 'undeliverable', 'failed')`)],
)

// ---------------------------------------------------------------------------
// Longitudinal patient history (slice V1): conditions, medicines, results.
// Typed in by staff (no laboratory or pharmacy feed). Never deleted; a mistake
// is marked "entered in error" with a reason. Content cannot change after it is
// entered (a trigger enforces it, migration 0023); only status can. Every
// change is written to patient_history_events (append-only) and audited.
// ---------------------------------------------------------------------------

export const conditionStatus = pgEnum('condition_status', ['active', 'controlled', 'resolved', 'entered_in_error'])

export const patientConditions = pgTable(
  'patient_conditions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    name: text('name').notNull(),
    /** ICD-10 as typed; format-checked only. */
    code: text('code'),
    sinceYear: integer('since_year').notNull(),
    sinceMonth: integer('since_month'),
    status: conditionStatus('status').notNull().default('active'),
    note: text('note'),
    /** Why the entry was marked as an error. */
    statusReason: text('status_reason'),
    source: text('source').notNull().default('clinician_entered'),
    dataOrigin: text('data_origin').notNull(),
    enteredBy: uuid('entered_by')
      .notNull()
      .references(() => users.id),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('patient_conditions_patient_idx').on(t.patientId, t.status),
    // The same condition is not on the list twice at once (a double click, or two people entering it).
    uniqueIndex('patient_conditions_open_name_uq')
      .on(t.patientId, sql`lower(${t.name})`)
      .where(sql`status in ('active', 'controlled')`),
    check('patient_conditions_since_check', sql`since_year between 1900 and 2200 and (since_month is null or since_month between 1 and 12)`),
    check('patient_conditions_text_check', sql`length(btrim(name)) between 1 and 120 and length(coalesce(note, '')) <= 300 and length(coalesce(status_reason, '')) <= 200`),
    check('patient_conditions_code_check', sql`code is null or code ~ '^[A-Z][0-9][0-9A-Z]([.][0-9A-Z]{1,4})?$'`),
    check('patient_conditions_error_reason_check', sql`status <> 'entered_in_error' or length(btrim(coalesce(status_reason, ''))) >= 3`),
    check('patient_conditions_source_check', sql`source in ('clinician_entered') and data_origin in ('synthetic', 'clinical')`),
  ],
)

export const medicationStatus = pgEnum('medication_status', ['current', 'stopped', 'entered_in_error'])

export const patientMedications = pgTable(
  'patient_medications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    drugName: text('drug_name').notNull(),
    strength: text('strength'),
    form: text('form'),
    dose: text('dose').notNull(),
    route: text('route'),
    frequency: text('frequency').notNull(),
    startedOn: date('started_on'),
    stoppedOn: date('stopped_on'),
    status: medicationStatus('status').notNull().default('current'),
    /** What it is for. */
    reason: text('reason'),
    /** Why it was stopped, or why the entry was marked as an error. */
    statusReason: text('status_reason'),
    source: text('source').notNull().default('clinician_entered'),
    dataOrigin: text('data_origin').notNull(),
    enteredBy: uuid('entered_by')
      .notNull()
      .references(() => users.id),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('patient_medications_patient_idx').on(t.patientId, t.status),
    uniqueIndex('patient_medications_current_uq')
      .on(t.patientId, sql`lower(${t.drugName})`, sql`lower(coalesce(${t.strength}, ''))`, sql`lower(${t.dose})`, sql`lower(${t.frequency})`)
      .where(sql`status = 'current'`),
    check('patient_medications_text_check', sql`length(btrim(drug_name)) between 1 and 120 and length(btrim(dose)) between 1 and 60 and length(btrim(frequency)) between 1 and 60 and length(coalesce(reason, '')) <= 200 and length(coalesce(status_reason, '')) <= 200`),
    check('patient_medications_dates_check', sql`stopped_on is null or started_on is null or stopped_on >= started_on`),
    check('patient_medications_stop_check', sql`status <> 'stopped' or length(btrim(coalesce(status_reason, ''))) >= 3`),
    // A stop date belongs to a medicine that was stopped (it stays if that entry is later marked as an error).
    check('patient_medications_stopped_on_check', sql`stopped_on is null or status in ('stopped', 'entered_in_error')`),
    check('patient_medications_error_reason_check', sql`status <> 'entered_in_error' or length(btrim(coalesce(status_reason, ''))) >= 3`),
    check('patient_medications_source_check', sql`source in ('clinician_entered') and data_origin in ('synthetic', 'clinical')`),
  ],
)

export const investigationStatus = pgEnum('investigation_status', ['final', 'entered_in_error'])

export const investigationResults = pgTable(
  'investigation_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    testName: text('test_name').notNull(),
    valueText: text('value_text').notNull(),
    valueNumber: numeric('value_number', { mode: 'number' }),
    unit: text('unit'),
    refLow: numeric('ref_low', { mode: 'number' }),
    refHigh: numeric('ref_high', { mode: 'number' }),
    refText: text('ref_text'),
    /** normal, low, high, abnormal or unknown: set by the API from the numbers, or from the clinician's reading. */
    flag: text('flag').notNull().default('unknown'),
    collectedOn: date('collected_on').notNull(),
    resultedOn: date('resulted_on'),
    status: investigationStatus('status').notNull().default('final'),
    note: text('note'),
    statusReason: text('status_reason'),
    source: text('source').notNull().default('clinician_entered'),
    dataOrigin: text('data_origin').notNull(),
    enteredBy: uuid('entered_by')
      .notNull()
      .references(() => users.id),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('investigation_results_patient_idx').on(t.patientId, t.collectedOn),
    uniqueIndex('investigation_results_dedup_uq')
      .on(t.patientId, sql`lower(${t.testName})`, t.collectedOn, sql`lower(${t.valueText})`)
      .where(sql`status = 'final'`),
    check('investigation_results_text_check', sql`length(btrim(test_name)) between 1 and 120 and length(btrim(value_text)) between 1 and 60 and length(coalesce(unit, '')) <= 20 and length(coalesce(ref_text, '')) <= 60 and length(coalesce(note, '')) <= 300 and length(coalesce(status_reason, '')) <= 200`),
    check('investigation_results_flag_check', sql`flag in ('normal', 'low', 'high', 'abnormal', 'unknown')`),
    check('investigation_results_range_check', sql`ref_low is null or ref_high is null or ref_low <= ref_high`),
    check('investigation_results_dates_check', sql`resulted_on is null or resulted_on >= collected_on`),
    check('investigation_results_error_reason_check', sql`status <> 'entered_in_error' or length(btrim(coalesce(status_reason, ''))) >= 3`),
    check('investigation_results_source_check', sql`source in ('clinician_entered') and data_origin in ('synthetic', 'clinical')`),
  ],
)

/** One row per creation or status change of a history entry: who, when, why. Append-only. */
export const patientHistoryEvents = pgTable(
  'patient_history_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('patient_history_events_patient_idx').on(t.patientId, t.id),
    index('patient_history_events_entity_idx').on(t.entityType, t.entityId),
    check('patient_history_events_entity_check', sql`entity_type in ('condition', 'medication', 'investigation') and action in ('created', 'status_changed')`),
  ],
)
/**
 * A draft made by the local language model for one consultation (slice V3). Many per consultation (a new one supersedes the last); at most one is
 * being made at a time (partial unique index). The sources it was made from are kept as a manifest (keys and hashes, not text) so a later change
 * to the record, the doctor's notes or the confirmed points can be told from the draft; the statements and the evidence they rest on are rows below.
 * While `status` is "generating" the row changes; once it ends, nothing in it changes (trigger).
 */
export const consultationDrafts = pgTable(
  'consultation_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    encounterId: uuid('encounter_id')
      .notNull()
      .references(() => encounters.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    version: integer('version').notNull(),
    /** generating | ready | partial | failed | unavailable | cancelled */
    status: text('status').notNull().default('generating'),
    /** While generating: queued (waiting for the one local model) or running. */
    phase: text('phase'),
    /** The record held too little to draft from; the model was not asked. */
    insufficient: boolean('insufficient').notNull().default(false),
    jobId: uuid('job_id').references(() => aiJobs.id),
    runId: uuid('run_id').references(() => aiRuns.id),
    idempotencyKey: text('idempotency_key'),
    promptId: text('prompt_id').notNull(),
    schemaVersion: text('schema_version').notNull(),
    /** Version of the explicit record rules (conflicts, old items, missing items) and of the checks run after the model. */
    rulesVersion: text('rules_version').notNull(),
    checksVersion: text('checks_version').notNull(),
    provider: text('provider'),
    model: text('model'),
    runtime: text('runtime'),
    weightsSha256: text('weights_sha256'),
    /** local | external: where the model ran. */
    locality: text('locality'),
    contextSha256: text('context_sha256').notNull(),
    /** [{key, ref, sourceType, field, date, status, hash}] of what the model was shown. No clinical text. */
    contextManifest: jsonb('context_manifest').notNull(),
    sourceCount: integer('source_count').notNull(),
    omittedCount: integer('omitted_count').notNull().default(0),
    recordCheck: jsonb('record_check').notNull(),
    /** Counts of what the checks removed or flagged, by reason. No text. */
    validation: jsonb('validation'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryable: boolean('retryable').notNull().default(false),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('consultation_drafts_version_uq').on(t.encounterId, t.version),
    uniqueIndex('consultation_drafts_one_generating_uq')
      .on(t.encounterId)
      .where(sql`status = 'generating'`),
    uniqueIndex('consultation_drafts_idempotency_uq')
      .on(t.requestedBy, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    index('consultation_drafts_encounter_idx').on(t.encounterId, t.createdAt),
    check('consultation_drafts_status_check', sql`${t.status} in ('generating', 'ready', 'partial', 'failed', 'unavailable', 'cancelled')`),
    check('consultation_drafts_phase_check', sql`${t.phase} is null or ${t.phase} in ('queued', 'running')`),
    check('consultation_drafts_locality_check', sql`${t.locality} is null or ${t.locality} in ('local', 'external')`),
    check('consultation_drafts_version_check', sql`${t.version} >= 1`),
  ],
)

/**
 * One statement of a draft. What the model wrote (text, support, flags, sources) never changes; only the doctor's decision does (the shared
 * review guard, `ai_review_guard('decision')`). Rejected and unreviewed statements are never part of the record.
 */
export const consultationDraftItems = pgTable(
  'consultation_draft_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => consultationDrafts.id),
    section: text('section').notNull(),
    position: integer('position').notNull().default(0),
    text: text('text').notNull(),
    /** supported | inferred | not_found | conflicting | outdated: decided by the server from the cited items. */
    support: text('support').notNull(),
    rationale: text('rationale'),
    uncertainty: text('uncertainty'),
    flags: jsonb('flags').notNull().default(sql`'[]'::jsonb`),
    /** Stable keys of the record items it rests on (their excerpts are copied to ai_evidence). */
    sourceKeys: jsonb('source_keys').notNull().default(sql`'[]'::jsonb`),
    /** The doctor must tick "I have checked this" before accepting it. */
    needsConfirmation: boolean('needs_confirmation').notNull().default(false),
    decision: text('decision').notNull().default('pending'),
    finalText: text('final_text'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('consultation_draft_items_draft_idx').on(t.draftId),
    check('consultation_draft_items_section_check', sql`${t.section} in ('summary', 'presenting_problem', 'symptoms', 'observations', 'relevant_history', 'allergies', 'medications', 'potential_considerations', 'potential_investigations', 'potential_medication_considerations', 'missing_information', 'uncertainties')`),
    check('consultation_draft_items_support_check', sql`${t.support} in ('supported', 'inferred', 'not_found', 'conflicting', 'outdated')`),
    check('consultation_draft_items_decision_check', sql`${t.decision} in ('pending', 'accepted', 'edited', 'rejected', 'deferred')`),
    check('consultation_draft_items_text_check', sql`length(btrim(${t.text})) between 1 and 400`),
  ],
)

// ---------------------------------------------------------------------------
// Mana AI conversations (slice V4). A conversation belongs to one doctor of one clinic. Each question and each answer is a message; the answer
// is made in the background (planning, reading, writing, checking), and once it has ended nothing in it changes. Nothing here is ever deleted.
// ---------------------------------------------------------------------------

export const manaConversations = pgTable(
  'mana_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => users.id),
    /** The consultation (and its patient) the conversation was opened in: "this patient" means that patient. */
    encounterId: uuid('encounter_id').references(() => encounters.id),
    patientId: uuid('patient_id').references(() => patients.id),
    /** [{ alias, patientId }]: the patients shown in this conversation, by the handle the model uses (P1, P2 ...). The model never sees their names. */
    entities: jsonb('entities').notNull().default(sql`'[]'::jsonb`),
    /** The handle of the patient most recently discussed (what "their" means). */
    focus: text('focus'),
    dataOrigin: text('data_origin').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mana_conversations_doctor_idx').on(t.doctorId, t.encounterId, t.updatedAt), index('mana_conversations_facility_idx').on(t.facilityId)],
)

export const manaMessages = pgTable(
  'mana_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => manaConversations.id),
    seq: integer('seq').notNull(),
    /** doctor (a question, or the choice of one patient) | mana (the answer to it) */
    role: text('role').notNull(),
    /** What the doctor asked. */
    text: text('text'),
    /** The doctor's message this answers. */
    parentId: uuid('parent_id').references((): AnyPgColumn => manaMessages.id),
    askedBy: uuid('asked_by')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key'),
    /** pending | ready | refused | unverified | failed | unavailable | cancelled. A doctor's message is always ready. */
    status: text('status').notNull().default('ready'),
    /** While pending: queued | planning | retrieving | writing | verifying. */
    phase: text('phase'),
    /** The validated plan (tool calls the model chose), and, for a question that needs the doctor to choose a patient, what remains to be run. */
    plan: jsonb('plan'),
    /** The validated answer as the screen shows it (ManaAnswerBody). */
    answer: jsonb('answer'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryable: boolean('retryable').notNull().default(false),
    provider: text('provider'),
    model: text('model'),
    runtime: text('runtime'),
    weightsSha256: text('weights_sha256'),
    locality: text('locality'),
    planPromptId: text('plan_prompt_id'),
    answerPromptId: text('answer_prompt_id'),
    schemaVersion: text('schema_version'),
    checksVersion: text('checks_version'),
    toolsVersion: text('tools_version'),
    /** Counts of what the checks removed, by reason. No text. */
    validation: jsonb('validation'),
    jobId: uuid('job_id').references(() => aiJobs.id),
    planRunId: uuid('plan_run_id').references(() => aiRuns.id),
    answerRunId: uuid('answer_run_id').references(() => aiRuns.id),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('mana_messages_seq_uq').on(t.conversationId, t.seq),
    uniqueIndex('mana_messages_one_pending_uq')
      .on(t.conversationId)
      .where(sql`role = 'mana' and status = 'pending'`),
    uniqueIndex('mana_messages_idempotency_uq')
      .on(t.askedBy, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    index('mana_messages_conversation_idx').on(t.conversationId, t.seq),
    check('mana_messages_role_check', sql`${t.role} in ('doctor', 'mana')`),
    check('mana_messages_status_check', sql`${t.status} in ('pending', 'ready', 'refused', 'unverified', 'failed', 'unavailable', 'cancelled')`),
    check('mana_messages_text_check', sql`${t.text} is null or length(btrim(${t.text})) between 1 and 500`),
  ],
)

/** The tools a question ran, in order: what was asked of each, and how it ended (no clinical text). */
export const manaToolCalls = pgTable(
  'mana_tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => manaMessages.id),
    position: integer('position').notNull(),
    tool: text('tool').notNull(),
    /**
     * The validated call: handles, topics, windows and short search words. A patient the doctor named is `name:<what the doctor wrote>` or `mrn:<what the doctor
     * wrote>` (the call as it was run), so this column can hold a name or an MRN the doctor typed: it is patient data, kept as long as the database (see the
     * retention note in ADR 0017 §2.8).
     */
    args: jsonb('args').notNull(),
    /** ok | empty | not_found | ambiguous | refused | invalid | error */
    status: text('status').notNull(),
    detail: text('detail').notNull().default(''),
    patientId: uuid('patient_id').references(() => patients.id),
    sourceCount: integer('source_count').notNull().default(0),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mana_tool_calls_message_idx').on(t.messageId, t.position)],
)

/** The records an answer rests on, as they read when the answer was made (an excerpt copied from the record, like every other AI evidence row). */
export const manaMessageSources = pgTable(
  'mana_message_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => manaMessages.id),
    ref: text('ref').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    /** The statement the tools made, as the model was shown it. */
    text: text('text').notNull(),
    patientId: uuid('patient_id').references(() => patients.id),
    /** [{ kind, label, date, status, excerpt, link }]: the records it rests on, copied as they read. */
    items: jsonb('items').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mana_message_sources_uq').on(t.messageId, t.ref)],
)
