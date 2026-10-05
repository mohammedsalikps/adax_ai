import {
  AUSCULTATION_CAPTURE,
  AUSCULTATION_SITES,
  type AuscultationCapture,
  type AuscultationSite,
  BODY_SITES,
  type BodySite,
  type ConsultationContext,
  DEVICE_INTEGRATIONS,
  DEVICE_KINDS,
  DEVICE_READING_KINDS,
  type DeviceIntegration,
  type DeviceKind,
  type EvidenceItem,
  type EvidenceTrust,
  FACT_CATEGORIES,
  FACT_FLAGS,
  type FactCategory,
  INSERTION_SUBJECTS,
  type InsertionSubject,
  LIVE_DRAFT_STATUSES,
  NOTE_SECTIONS,
  PENDING_KINDS,
  type PendingReview,
  PROVENANCE_LABELS,
  type Provenance,
  type ReadingState,
  readingState,
  type RoiStats,
  THERMAL_CAPTURE_SOURCES,
  type ThermalCaptureSource,
  type ThermalModelStatus,
  type VitalKind,
} from '@adaxai/contracts'
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { can } from '../auth/permissions.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Config } from '../config.ts'
import type { DbOrTx } from '../db/client.ts'
import {
  aiEvidence,
  aiRuns,
  allergies,
  auscultationRecordings,
  clinicalFacts,
  consultationDraftItems,
  consultationDrafts,
  deviceAssignments,
  devices,
  facilities,
  manaConversations,
  manaMessages,
  observations,
  patientConditions,
  patientMedications,
  patients,
  thermalCaptures,
  thermalRois,
  thermalSummaries,
  transcriptSegments,
  transcripts,
  users,
  visits,
} from '../db/schema.ts'
import { SIMULATED } from '../devices/provenance.ts'
import { patientDeviceReadings } from '../devices/readings.ts'
import { loadInsertions } from '../encounters/insertions.ts'
import { type EncounterRow, getEncounterOr404 } from '../encounters/service.ts'
import { notFound } from '../http/errors.ts'
import type { PatientRow } from '../patients/service.ts'
import type { AppSettings } from '../settings/schema.ts'
import { COMPARED_VITAL_KINDS, type ComparedSource, CONFLICT_RULES_VERSION, findConflicts, quote, VITAL_PAIR_WINDOW_SECONDS, vitalText } from './conflicts.ts'
import { composeSummary, NOT_ANALYSED, SUMMARY_COMPOSER_VERSION } from './summary.ts'

/**
 * D2: the consultation context, one read model of everything a consultation holds, built on request from the records that already exist.
 * PostgreSQL stays the only source of truth: nothing here is stored, and nothing here writes. It composes the existing read paths (the device
 * card's states, the note insertions, the V3 draft, Mana's conversations, the V6 thermal records) instead of keeping copies of them.
 *
 * Who sees what is decided as it is today, by the record each item comes from:
 *   - the encounter: whoever may read it (doctors and nurses of its facility; another facility's is "not found", and audited as such);
 *   - vital signs, device readings, stethoscope recordings, thermal images and summaries, what was added to the note: the same readers;
 *   - the conversation and the important points: doctors (as the consultation's AI view);
 *   - the AI draft (V3): the doctor of the consultation only; Mana conversations: only the doctor who asked in them.
 * Only THIS encounter's records are read (never another consultation of the same patient), and at most the newest few of each kind; what waits
 * for the doctor is counted in full.
 *
 * Trust is never upgraded: a device value stays "unverified", a simulator's output stays SIMULATED and is never LIVE, never a conflict and never
 * part of the summary's observations; a stethoscope recording is "recorded, not analysed"; an important point is "extracted, to review" (fixed
 * rules) or "AI output, to review" (a model) until the doctor accepted or edited it; a point the doctor rejected is left out.
 *
 * A source that cannot be read is left out and said to be missing, and nothing is said to be absent from it; the rest is still returned. The read
 * is not audited here: the route audits it (and Mana audits its own tool reads), so that each caller audits once, in its own words.
 */

export interface ContextDeps {
  db: DbOrTx
  settings: AppSettings
  config: Config
  /**
   * What the local model says about itself now (the V3 status), used only to say why there is no AI draft. Optional; asked only when the doctor of
   * the consultation has none, and a failure of it is ignored.
   */
  reasoningStatus?: () => Promise<{ available: boolean; reason: string | null }>
  /** Told which source could not be read, and why (for the server log); the context itself only says that it is missing. */
  onSourceError?: (source: SourceKey, err: unknown) => void
}

/** The most of each kind read for one consultation (newest first); a consultation that holds more shows the newest. */
const LIMIT = {
  transcripts: 10,
  points: 40,
  staffVitals: 40,
  /** The patient's device assignments looked in for this visit's readings, newest first. */
  deviceAssignments: 10,
  /** Look-ups of a device's newest reading of one kind (one per assignment and kind it may send). */
  deviceReadings: 40,
  pairs: 100,
  stethoscope: 20,
  thermal: 10,
  thermalSummaries: 10,
  draftItems: 60,
  mana: 5,
  insertions: 30,
  record: 20,
  /** Active allergies compared with what was said (a bound against abuse, far above any real record). */
  allergiesCompared: 500,
  /** Confirmed points stated in the summary (beyond: counted). */
  confirmedPoints: 10,
} as const

/** What is said when a source could not be read. */
const UNREAD = {
  transcripts: 'The conversation could not be read just now; it is left out.',
  points: 'The important points could not be read just now; they are left out.',
  staffVitals: 'The vital signs entered by staff could not be read just now; they are left out.',
  devices: 'The device readings could not be read just now; they are left out.',
  pairs: 'Staff and device vital signs could not be compared just now.',
  stethoscope: 'The stethoscope recordings could not be read just now; they are left out.',
  thermal: 'The thermal images could not be read just now; they are left out.',
  thermalSummaries: 'The thermal summaries could not be read just now; they are left out.',
  drafts: 'The AI draft could not be read just now; it is left out.',
  mana: 'The Mana conversations could not be read just now; they are left out.',
  insertions: 'What was added to the note could not be read just now; it is left out.',
  record: 'The patient’s record (allergies, conditions, medicines) could not be read just now; it is left out.',
} as const
export type SourceKey = keyof typeof UNREAD

/** The important points found by V2's fixed rules carry this provider on their run; any other provider is a model. */
const RULES_EXTRACTOR = 'adaxai-rules'

const STATE_WORD: Record<ReadingState, string> = { live: 'LIVE', stale: 'STALE', disconnected: 'DISCONNECTED', no_data: 'NO DATA', unavailable: 'UNAVAILABLE' }
const TRANSCRIPT_SOURCES: Record<string, string> = { typed: 'Typed', pasted: 'Pasted', audio_upload: 'Uploaded audio', browser_recording: 'Recorded in the browser' }
const THERMAL_STATUS: Record<string, string> = { draft: 'Draft', approved: 'Approved', rejected: 'Rejected' }
const SUMMARY_STATUS: Record<string, string> = { pending: 'To review', accepted: 'Accepted', edited: 'Edited', rejected: 'Rejected' }
const SECTION_LABEL = new Map<string, string>(NOTE_SECTIONS.map((s) => [s.key, s.label]))

type ObservationRow = typeof observations.$inferSelect
type DeviceRow = typeof devices.$inferSelect

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const iso = (d: Date) => d.toISOString()
/** The newest time of a column in a group, as milliseconds (null for none). */
const newestMs = (col: AnyPgColumn) => sql<number | null>`(extract(epoch from max(${col})) * 1000)::float8`.mapWith(Number)
const counted = () => sql<number>`count(*)::int`
/** "SIMULATED" first, so that a simulated item can never be read as anything else; a simulated reading is never LIVE. */
const deviceStatus = (state: ReadingState, simulated: boolean) => (simulated ? (state === 'live' ? 'SIMULATED' : `SIMULATED · ${STATE_WORD[state]}`) : STATE_WORD[state])
const siteLabel = (site: string) => {
  const label = AUSCULTATION_SITES[site as AuscultationSite] ?? site
  return label.charAt(0).toLowerCase() + label.slice(1)
}
const regionOf = (protocol: unknown) => {
  const p = (protocol ?? {}) as { bodyRegion?: string; bodySite?: BodySite | null }
  return (p.bodySite && BODY_SITES[p.bodySite]) || (p.bodyRegion ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'unnamed region'
}
/** A name as a camera reported it, when it is one (it has a letter or a digit: a camera can report "*"). */
const named = (s: unknown) => (typeof s === 'string' && /[\p{L}\p{N}]/u.test(s) ? s.trim() : null)
/** The substance the extraction found in an allergy point, when it found one. */
const substanceOf = (attributes: unknown) => {
  const s = ((attributes ?? {}) as { substance?: unknown }).substance
  return typeof s === 'string' && s.trim() ? s.trim() : null
}

const CLOCK = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const
const DATE_CLOCK = { day: 'numeric', month: 'short', year: 'numeric', ...CLOCK } as const

/** An instant in the facility's time zone, as `opts` say ("10:40", or "5 Oct 2026, 10:40"). */
function formatIn(timeZone: string, opts: Intl.DateTimeFormatOptions): (d: Date) => string {
  let f: Intl.DateTimeFormat
  try {
    f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone })
  } catch {
    f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' })
  }
  return (d) => f.format(d)
}

// ---- Sources: each reads one kind of record of THIS encounter, bounded --------------------------------------------------------------------

async function loadTranscripts(db: DbOrTx, e: EncounterRow) {
  const rows = await db
    .select({ t: transcripts, by: users.fullName, provider: aiRuns.provider, model: aiRuns.model })
    .from(transcripts)
    .leftJoin(users, eq(users.id, transcripts.createdBy))
    .leftJoin(aiRuns, eq(aiRuns.id, transcripts.sttRunId))
    .where(eq(transcripts.encounterId, e.id))
    .orderBy(desc(transcripts.createdAt))
    .limit(LIMIT.transcripts)
  const ids = rows.map((r) => r.t.id)
  // Counts and times only: the words of the conversation are not part of the context.
  const lines = ids.length
    ? await db
        .select({ id: transcriptSegments.transcriptId, n: sql<number>`count(*)::int`, last: newestMs(transcriptSegments.createdAt) })
        .from(transcriptSegments)
        .where(inArray(transcriptSegments.transcriptId, ids))
        .groupBy(transcriptSegments.transcriptId)
    : []
  return rows.map((r) => ({ ...r, lines: lines.find((l) => l.id === r.t.id)?.n ?? 0, lastLineAt: lines.find((l) => l.id === r.t.id)?.last ?? null }))
}

/**
 * The important points of this consultation that the doctor has not rejected (a rejected point is set aside, as the summary, the conflicts and V3
 * set it aside), the newest first; and how many wait for the doctor, counted in full (the list is capped), with how many of those a model found.
 */
async function loadPoints(db: DbOrTx, e: EncounterRow) {
  const mine = and(eq(clinicalFacts.encounterId, e.id), eq(clinicalFacts.patientId, e.patientId))
  const decidedStatus = inArray(clinicalFacts.status, ['accepted', 'edited'])
  const pointsOf = () => db.select({ f: clinicalFacts, provider: aiRuns.provider, model: aiRuns.model, prompt: aiRuns.promptVersion }).from(clinicalFacts).innerJoin(aiRuns, eq(aiRuns.id, clinicalFacts.runId))
  const [newest, [waiting], confirmed, [confirmedCount]] = await Promise.all([
    pointsOf()
      .where(and(mine, notInArray(clinicalFacts.status, ['superseded', 'rejected'])))
      .orderBy(desc(clinicalFacts.createdAt), asc(clinicalFacts.sortOrder))
      .limit(LIMIT.points),
    db
      .select({ n: counted(), byModel: sql<number>`(count(*) filter (where ${aiRuns.provider} <> ${RULES_EXTRACTOR}))::int` })
      .from(clinicalFacts)
      .innerJoin(aiRuns, eq(aiRuns.id, clinicalFacts.runId))
      .where(and(mine, inArray(clinicalFacts.status, ['pending', 'deferred']))),
    pointsOf().where(and(mine, decidedStatus)).orderBy(desc(clinicalFacts.createdAt), asc(clinicalFacts.sortOrder)).limit(LIMIT.confirmedPoints),
    db.select({ n: counted() }).from(clinicalFacts).where(and(mine, decidedStatus)),
  ])
  // The newest points, and the newest confirmed ones even when newer points pushed them out of that list (the summary states them, so they are listed).
  const rows = [...newest, ...confirmed.filter((c) => !newest.some((r) => r.f.id === c.f.id))]
  const ids = rows.map((r) => r.f.id)
  // Where each record value a point was found to conflict with came from, as the record comparison stored it beside the point (a vital sign's:
  // entered by staff, or from a device). Its note is not read: it calls any value "measured", a device's too.
  const compared = ids.length
    ? await db
        .select({ id: aiEvidence.subjectId, sourceType: aiEvidence.sourceType, provenance: aiEvidence.provenance })
        .from(aiEvidence)
        .where(and(eq(aiEvidence.subjectType, 'fact'), eq(aiEvidence.relation, 'conflicts'), inArray(aiEvidence.subjectId, ids)))
    : []
  const sourceOf = (provenance: string): ComparedSource => (provenance === 'staff_measured' ? 'staff' : provenance === 'device_measured' ? 'device' : 'unknown')
  return {
    rows: rows.map((r) => ({ ...r, comparedWith: compared.filter((c) => c.id === r.f.id && c.sourceType === 'observation').map((c) => sourceOf(c.provenance)) })),
    waiting: waiting?.n ?? 0,
    waitingByModel: waiting?.byModel ?? 0,
    confirmed: confirmed.map(({ f }) => f),
    confirmedCount: confirmedCount?.n ?? 0,
  }
}

async function loadStaffVitals(db: DbOrTx, e: EncounterRow) {
  return db
    .select({ o: observations, by: users.fullName })
    .from(observations)
    .leftJoin(users, eq(users.id, observations.recordedBy))
    .where(and(eq(observations.visitId, e.visitId), eq(observations.patientId, e.patientId), eq(observations.source, 'manual'), eq(observations.enteredInError, false)))
    .orderBy(desc(observations.measuredAt), desc(observations.createdAt))
    .limit(LIMIT.staffVitals)
}

/**
 * The devices attached to the patient now (the device card's own read model and states), and the newest reading of each kind from each device at
 * THIS visit. A device reading is stored only inside an assignment of that device to the patient (the gateway's rule), so each is looked for in
 * the patient's assignments that can hold a reading of this visit (not ended before its check-in): one index look-up (`observations_device_kind_idx`)
 * per assignment and kind the device may send, within the assignment's time. The visit's readings are never scanned, however often a band sends.
 */
async function loadDevices(db: DbOrTx, e: EncounterRow, v: typeof visits.$inferSelect, patient: PatientRow, deps: ContextDeps, now: number) {
  const [attached, windows] = await Promise.all([
    patientDeviceReadings(db, patient, deps.settings, deps.config, now),
    db
      .select({ assignedAt: deviceAssignments.assignedAt, endedAt: deviceAssignments.endedAt, d: devices })
      .from(deviceAssignments)
      .innerJoin(devices, eq(devices.id, deviceAssignments.deviceId))
      .where(and(eq(deviceAssignments.patientId, e.patientId), eq(devices.facilityId, e.facilityId), or(isNull(deviceAssignments.endedAt), gt(deviceAssignments.endedAt, v.checkedInAt))))
      .orderBy(desc(deviceAssignments.assignedAt))
      .limit(LIMIT.deviceAssignments),
  ])
  const lookups = windows.flatMap((w) => (DEVICE_READING_KINDS[w.d.kind as DeviceKind] ?? []).map((kind) => ({ ...w, kind }))).slice(0, LIMIT.deviceReadings)
  const found = await Promise.all(
    lookups.map(async ({ assignedAt, endedAt, d, kind }) => {
      const [o] = await db
        .select()
        .from(observations)
        .where(
          and(
            eq(observations.deviceId, d.id),
            eq(observations.kind, kind),
            gte(observations.measuredAt, assignedAt),
            endedAt ? lte(observations.measuredAt, endedAt) : undefined,
            eq(observations.visitId, e.visitId),
            eq(observations.patientId, e.patientId),
            eq(observations.source, 'device'),
            eq(observations.enteredInError, false),
          ),
        )
        .orderBy(desc(observations.measuredAt), desc(observations.createdAt))
        .limit(1)
      return o ? { o, d } : null
    }),
  )
  // A device attached to the patient twice at this visit is looked up once per assignment: the newer reading of each kind is kept.
  const newest = new Map<string, { o: ObservationRow; d: DeviceRow }>()
  for (const r of found) {
    if (!r) continue
    const key = `${r.d.id}:${r.o.kind}`
    const had = newest.get(key)
    if (!had || r.o.measuredAt.getTime() > had.o.measuredAt.getTime() || (r.o.measuredAt.getTime() === had.o.measuredAt.getTime() && r.o.createdAt.getTime() > had.o.createdAt.getTime())) newest.set(key, r)
  }
  return { attached: attached.devices, rows: [...newest.values()] }
}

/**
 * For each staff measurement of a compared kind among those shown (the newest few at this visit), the closest reading in time from each real device
 * (never a simulator) within the comparison window: the device side is looked up by patient, kind and time (`observations_patient_kind_idx`), so
 * each staff value reads only that window. Whether the two disagree is decided by the rules (conflicts.ts), not here.
 */
async function loadVitalPairs(db: DbOrTx, e: EncounterRow) {
  const s = alias(observations, 'staff_obs')
  const d = alias(observations, 'device_obs')
  const shown = db
    .select({ id: observations.id })
    .from(observations)
    .where(and(eq(observations.visitId, e.visitId), eq(observations.patientId, e.patientId), eq(observations.source, 'manual'), eq(observations.enteredInError, false)))
    .orderBy(desc(observations.measuredAt), desc(observations.createdAt))
    .limit(LIMIT.staffVitals)
  return db
    .selectDistinctOn([s.id, d.deviceId], { staff: { id: s.id, kind: s.kind, value: s.value, measuredAt: s.measuredAt }, device: d, dev: devices })
    .from(s)
    .innerJoin(
      d,
      and(
        eq(d.visitId, s.visitId),
        eq(d.patientId, s.patientId),
        eq(d.kind, s.kind),
        eq(d.source, 'device'),
        ne(d.validationStatus, SIMULATED),
        eq(d.enteredInError, false),
        sql`${d.measuredAt} between ${s.measuredAt} - make_interval(secs => ${VITAL_PAIR_WINDOW_SECONDS}) and ${s.measuredAt} + make_interval(secs => ${VITAL_PAIR_WINDOW_SECONDS})`,
      ),
    )
    .innerJoin(devices, and(eq(devices.id, d.deviceId), ne(devices.integration, 'simulator'), eq(devices.facilityId, e.facilityId)))
    .where(and(inArray(s.id, shown), eq(s.visitId, e.visitId), eq(s.patientId, e.patientId), eq(s.source, 'manual'), eq(s.enteredInError, false), inArray(s.kind, COMPARED_VITAL_KINDS)))
    .orderBy(s.id, d.deviceId, sql`abs(extract(epoch from ${d.measuredAt} - ${s.measuredAt}))`, asc(d.measuredAt), asc(d.id))
    .limit(LIMIT.pairs)
}

async function loadStethoscope(db: DbOrTx, e: EncounterRow) {
  return db
    .select({ r: auscultationRecordings, by: users.fullName, dev: devices.label })
    .from(auscultationRecordings)
    .leftJoin(users, eq(users.id, auscultationRecordings.createdBy))
    .leftJoin(devices, eq(devices.id, auscultationRecordings.deviceId))
    .where(and(eq(auscultationRecordings.encounterId, e.id), eq(auscultationRecordings.patientId, e.patientId), eq(auscultationRecordings.facilityId, e.facilityId)))
    .orderBy(desc(auscultationRecordings.createdAt))
    .limit(LIMIT.stethoscope)
}

/** The newest thermal images of this consultation, with their regions and model status; and how many wait for review (drafts), counted in full. */
async function loadThermal(db: DbOrTx, e: EncounterRow) {
  const mine = and(eq(thermalCaptures.encounterId, e.id), eq(thermalCaptures.patientId, e.patientId), eq(thermalCaptures.facilityId, e.facilityId))
  const [rows, [drafts]] = await Promise.all([
    db.select({ c: thermalCaptures, dev: devices.label }).from(thermalCaptures).leftJoin(devices, eq(devices.id, thermalCaptures.deviceId)).where(mine).orderBy(desc(thermalCaptures.createdAt)).limit(LIMIT.thermal),
    db.select({ n: counted() }).from(thermalCaptures).where(and(mine, eq(thermalCaptures.status, 'draft'))),
  ])
  const ids = rows.map((r) => r.c.id)
  const [rois, models] = ids.length
    ? await Promise.all([
        db.select({ captureId: thermalRois.captureId, label: thermalRois.label, stats: thermalRois.stats }).from(thermalRois).where(inArray(thermalRois.captureId, ids)).orderBy(asc(thermalRois.captureId), asc(thermalRois.sortOrder)),
        // The thermal model status as the newest summary of each image recorded it (no model is installed in V6).
        db.selectDistinctOn([thermalSummaries.captureId], { captureId: thermalSummaries.captureId, model: thermalSummaries.model }).from(thermalSummaries).where(inArray(thermalSummaries.captureId, ids)).orderBy(thermalSummaries.captureId, desc(thermalSummaries.createdAt)),
      ])
    : [[], []]
  return {
    rows: rows.map((r) => ({
      ...r,
      rois: rois.filter((x) => x.captureId === r.c.id).map((x) => ({ label: x.label, stats: x.stats as RoiStats })),
      model: (models.find((m) => m.captureId === r.c.id)?.model ?? null) as ThermalModelStatus | null,
    })),
    drafts: drafts?.n ?? 0,
  }
}

/** The newest thermal summaries of this consultation; and how many wait for the doctor's decision, counted in full. */
async function loadThermalSummaries(db: DbOrTx, e: EncounterRow) {
  const mine = and(eq(thermalSummaries.encounterId, e.id), eq(thermalSummaries.patientId, e.patientId), eq(thermalSummaries.facilityId, e.facilityId))
  const [rows, [pending]] = await Promise.all([
    db
      .select({ s: thermalSummaries, by: users.fullName, protocol: thermalCaptures.protocol })
      .from(thermalSummaries)
      .innerJoin(thermalCaptures, eq(thermalCaptures.id, thermalSummaries.captureId))
      .leftJoin(users, eq(users.id, thermalSummaries.decidedBy))
      .where(mine)
      .orderBy(desc(thermalSummaries.createdAt))
      .limit(LIMIT.thermalSummaries),
    db.select({ n: counted() }).from(thermalSummaries).where(and(mine, eq(thermalSummaries.status, 'pending'))),
  ])
  return { rows, pending: pending?.n ?? 0 }
}

/**
 * The draft the doctor sees (the newest one being made or with statements, as the V3 view chooses it, however many attempts came after it), its
 * statements, and the newest attempt of any outcome (which says why there is no draft, when there is none).
 */
async function loadDrafts(db: DbOrTx, e: EncounterRow) {
  const mine = and(eq(consultationDrafts.encounterId, e.id), eq(consultationDrafts.facilityId, e.facilityId))
  const [[shown], [newest]] = await Promise.all([
    db
      .select()
      .from(consultationDrafts)
      .where(and(mine, inArray(consultationDrafts.status, [...LIVE_DRAFT_STATUSES])))
      .orderBy(desc(consultationDrafts.version))
      .limit(1),
    db.select().from(consultationDrafts).where(mine).orderBy(desc(consultationDrafts.version)).limit(1),
  ])
  const items = shown
    ? await db
        .select({ id: consultationDraftItems.id, section: consultationDraftItems.section, text: consultationDraftItems.text, support: consultationDraftItems.support, decision: consultationDraftItems.decision, finalText: consultationDraftItems.finalText })
        .from(consultationDraftItems)
        .where(eq(consultationDraftItems.draftId, shown.id))
        .orderBy(asc(consultationDraftItems.createdAt), asc(consultationDraftItems.position))
        .limit(LIMIT.draftItems)
    : []
  return { shown: shown ?? null, items, newest: newest ?? null }
}

/** The viewer's own Mana conversations of this consultation that hold a question: counts and times only, never what was asked or answered. */
async function loadMana(db: DbOrTx, e: EncounterRow, me: SessionUser) {
  return db
    .select({
      id: manaConversations.id,
      asked: sql<number>`(count(*) filter (where ${manaMessages.role} = 'doctor'))::int`,
      answered: sql<number>`(count(*) filter (where ${manaMessages.role} = 'mana' and ${manaMessages.status} in ('ready', 'unverified')))::int`,
      pending: sql<number>`(count(*) filter (where ${manaMessages.role} = 'mana' and ${manaMessages.status} = 'pending'))::int`,
      last: newestMs(manaMessages.createdAt),
    })
    .from(manaConversations)
    .innerJoin(manaMessages, eq(manaMessages.conversationId, manaConversations.id))
    .where(and(eq(manaConversations.encounterId, e.id), eq(manaConversations.facilityId, e.facilityId), eq(manaConversations.doctorId, me.id)))
    .groupBy(manaConversations.id)
    .orderBy(sql`max(${manaMessages.createdAt}) desc`)
    .limit(LIMIT.mana)
}

async function loadRecord(db: DbOrTx, patientId: string) {
  const [al, every, conditions, medications] = await Promise.all([
    db.select({ substance: allergies.substance, severity: allergies.severity }).from(allergies).where(and(eq(allergies.patientId, patientId), eq(allergies.status, 'active'))).orderBy(asc(allergies.substance)).limit(LIMIT.record),
    // Every active allergy's name, for the comparison with what was said (the list above is what is shown, and is capped).
    db.select({ substance: allergies.substance }).from(allergies).where(and(eq(allergies.patientId, patientId), eq(allergies.status, 'active'))).limit(LIMIT.allergiesCompared),
    db
      .select({ name: patientConditions.name, status: patientConditions.status })
      .from(patientConditions)
      .where(and(eq(patientConditions.patientId, patientId), inArray(patientConditions.status, ['active', 'controlled'])))
      .orderBy(asc(patientConditions.name))
      .limit(LIMIT.record),
    db
      .select({ drugName: patientMedications.drugName, strength: patientMedications.strength, dose: patientMedications.dose, frequency: patientMedications.frequency })
      .from(patientMedications)
      .where(and(eq(patientMedications.patientId, patientId), eq(patientMedications.status, 'current')))
      .orderBy(asc(patientMedications.drugName))
      .limit(LIMIT.record),
  ])
  return { allergies: al.map((a) => ({ substance: a.substance, severity: String(a.severity) })), allergiesCompared: every.map((a) => a.substance), conditions: conditions.map((c) => ({ name: c.name, status: String(c.status) })), medications }
}

// ---- The builder ------------------------------------------------------------------------------------------------------------------------------

/**
 * The context of one consultation for one viewer. `opts.now` is the server's clock in milliseconds (default: the system clock): the device states
 * are decided on it, and `generatedAt` is it. Throws only what the encounter lookup throws (404 for another facility's or a missing
 * consultation, recorded in the audit log as every such refusal is); a source that cannot be read is reported in `missing` instead.
 */
export async function buildConsultationContext(deps: ContextDeps, me: SessionUser, encounterId: string, opts: { now?: number } = {}): Promise<ConsultationContext> {
  const { db } = deps
  const now = opts.now ?? Date.now()
  const e = await getEncounterOr404(db, me, encounterId)
  const [base] = await db
    .select({ v: visits, p: patients, tz: facilities.timezone })
    .from(visits)
    .innerJoin(patients, eq(patients.id, visits.patientId))
    .innerJoin(facilities, eq(facilities.id, visits.facilityId))
    .where(and(eq(visits.id, e.visitId), eq(visits.facilityId, e.facilityId), eq(visits.patientId, e.patientId)))
  if (!base) throw notFound('Consultation')
  const { v, p } = base
  const time = formatIn(base.tz, CLOCK)
  const dateTime = formatIn(base.tz, DATE_CLOCK)
  const seesConversation = can(me.role, 'ai:use')
  const isAuthor = e.doctorId === me.id && seesConversation

  const unread = new Set<SourceKey>()
  const safely = async <T>(key: SourceKey, load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load()
    } catch (err) {
      unread.add(key)
      deps.onSourceError?.(key, err)
      return null
    }
  }
  const none = async () => null
  const [transcriptRows, pointData, staffRows, deviceData, pairRows, stethRows, thermalData, summaryData, drafts, manaRows, insertionRows, record] = await Promise.all([
    seesConversation ? safely('transcripts', () => loadTranscripts(db, e)) : none(),
    seesConversation ? safely('points', () => loadPoints(db, e)) : none(),
    safely('staffVitals', () => loadStaffVitals(db, e)),
    safely('devices', () => loadDevices(db, e, v, p, deps, now)),
    safely('pairs', () => loadVitalPairs(db, e)),
    safely('stethoscope', () => loadStethoscope(db, e)),
    safely('thermal', () => loadThermal(db, e)),
    safely('thermalSummaries', () => loadThermalSummaries(db, e)),
    isAuthor ? safely('drafts', () => loadDrafts(db, e)) : none(),
    seesConversation ? safely('mana', () => loadMana(db, e, me)) : none(),
    safely('insertions', async () => {
      const note = { chiefComplaint: e.chiefComplaint, history: e.history, pastHistory: e.pastHistory, examination: e.examination, assessment: e.assessment, plan: e.plan, followUp: e.followUp }
      return (await loadInsertions(db, e.id, note)).slice(-LIMIT.insertions)
    }),
    safely('record', () => loadRecord(db, e.patientId)),
  ])
  const pointRows = pointData?.rows ?? null
  const thermalRows = thermalData?.rows ?? null
  const summaryRows = summaryData?.rows ?? null

  const evidence: EvidenceItem[] = []
  const add = (item: EvidenceItem) => evidence.push(item)

  // -- Conversation and important points (doctors) --
  for (const r of transcriptRows ?? []) {
    const last = r.lastLineAt ? new Date(r.lastLineAt) : null
    add({
      id: `transcript:${r.t.id}`,
      kind: 'transcript',
      title: `Conversation: ${plural(r.lines, 'line', 'lines')}`,
      detail: [TRANSCRIPT_SOURCES[r.t.source] ?? r.t.source, last ? `last line at ${time(last)}` : 'no line yet'].join(' · '),
      at: iso(last ?? r.t.createdAt),
      status: r.t.status === 'live' ? 'Live' : 'Ended',
      trust: 'observed',
      source: r.by ?? 'Consultation',
      provenance: r.provider ? `${r.provider} · ${r.model}` : null,
      target: 'conversation',
    })
  }
  // A point is the doctor's once accepted or edited; until then it is what found it says it is: fixed rules ("extracted, to review") or a model.
  const decided = (status: string) => status === 'accepted' || status === 'edited'
  const pointState = (status: string) => (decided(status) ? 'Doctor confirmed' : 'Extracted draft')
  for (const r of pointRows ?? []) {
    const f = r.f
    const trust: EvidenceTrust = decided(f.status) ? 'doctor_reviewed' : r.provider === RULES_EXTRACTOR ? 'extracted' : 'model_output'
    const flags = (f.flags as string[]).map((x) => FACT_FLAGS[x as keyof typeof FACT_FLAGS] ?? x)
    add({
      id: `point:${f.id}`,
      kind: 'point',
      title: `${FACT_CATEGORIES[f.category as FactCategory] ?? f.category}: ${quote(f.finalText ?? f.text, 60)}`,
      detail: flags.length ? flags.join(' · ') : null,
      at: iso(f.createdAt),
      status: pointState(f.status),
      trust,
      source: PROVENANCE_LABELS[f.attribution as Provenance] ?? f.attribution,
      provenance: [r.provider, r.model, r.prompt].filter(Boolean).join(' · ') || null,
      target: 'conversation',
    })
  }

  // -- Vital signs entered by staff --
  for (const { o, by } of staffRows ?? []) {
    add({ id: `vital_staff:${o.id}`, kind: 'vital_staff', title: vitalText(o.kind, o.value), detail: null, at: iso(o.measuredAt), status: 'Recorded', trust: 'clinician_entered', source: by ?? 'Staff', provenance: null, target: 'history' })
  }

  // -- Device readings: their state now, on the server's clock, by the function the device card uses --
  const attached = deviceData?.attached ?? []
  const t = deps.settings.devices
  const deviceReadings: { itemId: string; kind: VitalKind; value: number; measuredAt: Date; label: string; simulated: boolean }[] = []
  const deviceItem = (o: ObservationRow, d: DeviceRow, id: string) => {
    const simulated = o.validationStatus === SIMULATED || d.integration === 'simulator'
    const attachedNow = attached.find((a) => a.deviceId === d.id)
    // Something can arrive from it only while it is attached to the patient and the device card does not call it unavailable.
    const state = readingState({ now, measuredAt: o.measuredAt.getTime(), lastSeenAt: d.lastSeenAt?.getTime() ?? null, available: !!attachedNow && attachedNow.state !== 'unavailable' }, t)
    const why =
      state === 'stale'
        ? `More than ${t.liveSeconds} seconds old.`
        : state === 'disconnected'
          ? `The device’s gateway has not been heard from for more than ${t.disconnectedSeconds} seconds; this is the last value received.`
          : state === 'unavailable'
            ? (attachedNow?.reason ?? 'The device is no longer attached to the patient: nothing more can arrive from it.')
            : null
    const item: EvidenceItem = {
      id,
      kind: 'vital_device',
      title: vitalText(o.kind, o.value),
      detail: [simulated ? 'SIMULATED: generated by a simulator, not a measurement.' : null, why].filter(Boolean).join(' ') || null,
      at: iso(o.measuredAt),
      status: deviceStatus(state, simulated),
      trust: simulated ? 'simulated' : 'measured_unverified',
      source: `${d.label} (${d.integration === 'simulator' ? 'simulator' : 'gateway'})`,
      provenance: `${DEVICE_KINDS[d.kind as DeviceKind] ?? d.kind} · ${DEVICE_INTEGRATIONS[d.integration as DeviceIntegration] ?? d.integration}`,
      target: 'devices',
    }
    return { item, reading: { itemId: id, kind: o.kind, value: o.value, measuredAt: o.measuredAt, label: d.label, simulated } }
  }
  // The newest reading of each device and kind keeps one id while newer ones arrive (`vital_device:<device>:<kind>`), so the screen keeps its place.
  const newestId = new Map<string, string>()
  for (const { o, d } of deviceData?.rows ?? []) {
    const id = `vital_device:${d.id}:${o.kind}`
    newestId.set(o.id, id)
    const { item, reading } = deviceItem(o, d, id)
    add(item)
    deviceReadings.push(reading)
  }
  // A reading compared with a staff measurement is the newest one's item when it is the newest, and has its own id otherwise.
  const pairedId = (observationId: string) => newestId.get(observationId) ?? `vital_device:obs:${observationId}`
  // A device attached in this consultation (or for its visit) that has sent nothing at this visit: said, with its state, and nothing filled in.
  for (const a of attached) {
    if (a.encounterId !== e.id && a.visitId !== e.visitId) continue
    if (deviceData?.rows.some((r) => r.d.id === a.deviceId)) continue
    const state: ReadingState = a.state === 'live' || a.state === 'stale' ? 'no_data' : a.state
    add({
      id: `vital_device:assignment:${a.assignmentId}`,
      kind: 'vital_device',
      title: `${a.label}: no reading at this visit`,
      detail: [a.simulated ? 'SIMULATED: a simulator, not a device.' : null, a.reason].filter(Boolean).join(' ') || null,
      at: a.assignedAt,
      status: deviceStatus(state, a.simulated),
      trust: a.simulated ? 'simulated' : 'measured_unverified',
      source: `${a.label} (${a.simulated ? 'simulator' : 'gateway'})`,
      provenance: `${DEVICE_KINDS[a.kind]} · ${DEVICE_INTEGRATIONS[a.integration]}`,
      target: 'devices',
    })
  }

  // -- Stethoscope recordings: recorded, never analysed --
  for (const { r, by, dev } of stethRows ?? []) {
    const seconds = r.durationMs ? `${Math.round(r.durationMs / 1000)} s` : null
    add({
      id: `stethoscope:${r.id}`,
      kind: 'stethoscope',
      title: `Recording${seconds ? ` ${seconds}` : ''}, ${siteLabel(r.site)}`,
      detail: [AUSCULTATION_CAPTURE[r.captureMethod as AuscultationCapture] ?? r.captureMethod, dev, r.simulated ? 'SIMULATED: generated tones, not a body sound' : NOT_ANALYSED].filter(Boolean).join(' · '),
      at: iso(r.createdAt),
      status: r.simulated ? 'SIMULATED' : 'Recorded',
      trust: r.simulated ? 'simulated' : 'recorded',
      source: by ?? (dev ? `${dev} (${r.simulated ? 'simulator' : 'gateway'})` : 'Device gateway'),
      provenance: null,
      target: 'devices',
    })
  }

  // -- Thermal images and their summaries --
  for (const { c, dev, rois, model } of thermalRows ?? []) {
    const src = c.captureSource as ThermalCaptureSource
    const camera = (c.camera ?? {}) as { model?: unknown }
    const extractor = (c.extractor ?? {}) as { name?: string; version?: string }
    // Without the camera's date the item is dated when the image was stored here: said, so that it is not read as when the image was taken.
    const storedAt = !c.simulated && !c.capturedAt ? `${src === 'gallery_import' ? 'imported' : src === 'file_upload' ? 'uploaded' : 'stored'} at ${time(c.createdAt)}; date taken not known` : null
    add({
      id: `thermal:${c.id}`,
      kind: 'thermal',
      title: `Thermal image, ${regionOf(c.protocol)}`,
      detail: [
        THERMAL_CAPTURE_SOURCES[src] ?? src,
        storedAt,
        c.simulated ? 'generated numbers, not radiometric' : 'radiometric',
        plural(rois.length, 'region', 'regions'),
        model?.available ? `model ${[model.modelId, model.version].filter(Boolean).join(' ') || 'installed'} (no output used)` : 'model unavailable',
      ]
        .filter(Boolean)
        .join(' · '),
      at: iso(c.capturedAt ?? c.createdAt),
      status: `${c.simulated ? 'SIMULATED · ' : ''}${THERMAL_STATUS[c.status] ?? c.status}`,
      trust: c.simulated ? 'simulated' : 'measured',
      source: c.simulated ? 'Thermal simulator (SIMULATED)' : `${dev ?? named(camera.model) ?? 'Thermal camera'} (${(THERMAL_CAPTURE_SOURCES[src] ?? src).toLowerCase()})`,
      provenance: [extractor.name, extractor.version].filter(Boolean).join(' ') || null,
      target: 'thermal',
    })
  }
  for (const { s, by, protocol } of summaryRows ?? []) {
    const decidedSummary = s.status !== 'pending'
    add({
      id: `thermal_summary:${s.id}`,
      kind: 'thermal_summary',
      title: `Thermal summary, ${regionOf(protocol)}`,
      detail: `${plural((s.statements as unknown[]).length, 'statement', 'statements')}, composed by fixed rules (no model)${decidedSummary ? `; decided by ${by ?? 'the doctor'}` : ''}`,
      at: iso(s.createdAt),
      status: `${s.simulated ? 'SIMULATED · ' : ''}${SUMMARY_STATUS[s.status] ?? s.status}`,
      trust: s.simulated ? 'simulated' : 'rule_output',
      source: 'Thermal summary rules',
      provenance: `${s.composerVersion}${s.rulesVersion ? ` · ${s.rulesVersion}` : ''}`,
      target: 'thermal',
    })
  }

  // -- The AI draft (the doctor of the consultation) --
  const shown = drafts?.shown ?? null
  const items = drafts?.items ?? []
  if (shown) {
    const n = (d: string) => items.filter((i) => i.decision === d).length
    const counts = (
      [
        ['accepted', 'accepted'],
        ['edited', 'edited'],
        ['pending', 'to review'],
        ['rejected', 'rejected'],
      ] as const
    )
      .filter(([d]) => n(d) > 0)
      .map(([d, words]) => `${n(d)} ${words}`)
    add({
      id: `ai_draft:${shown.id}`,
      kind: 'ai_draft',
      title: `AI draft: ${plural(items.length, 'statement', 'statements')}`,
      detail: shown.status === 'generating' ? 'Being made by the local model' : shown.insufficient ? 'The record held too little to draft from; the model was not asked' : counts.join(' · ') || null,
      at: iso(shown.createdAt),
      status: shown.status === 'generating' ? 'Generating' : !items.length ? 'No statements' : n('pending') ? 'To review' : 'Reviewed',
      trust: 'model_output',
      source: shown.model ? `${shown.locality === 'external' ? 'Hosted model' : 'Local model'} ${shown.model}` : 'Local model',
      provenance: [shown.provider, shown.model, shown.promptId].filter(Boolean).join(' · ') || null,
      target: 'draft',
    })
  }

  // -- Mana (only the viewer's own conversations) --
  for (const m of manaRows ?? []) {
    add({
      id: `mana:${m.id}`,
      kind: 'mana',
      title: `Mana: ${plural(m.answered, 'answered question', 'answered questions')}`,
      detail: `${plural(m.asked, 'question', 'questions')} asked${m.pending ? ' · an answer is being made' : ''}`,
      at: iso(new Date(m.last ?? now)),
      status: m.pending ? 'Answering' : m.answered ? 'Answered' : 'No answer',
      trust: 'model_output',
      source: 'Mana (your conversation)',
      provenance: null,
      target: 'mana',
    })
  }

  // -- What the doctor added to the note, after review --
  for (const i of insertionRows ?? []) {
    add({
      id: `note_insertion:${i.id}`,
      kind: 'note_insertion',
      title: `${INSERTION_SUBJECTS[i.subjectType as InsertionSubject] ?? i.subjectType} added to ${SECTION_LABEL.get(i.section) ?? i.section}`,
      detail: i.retained ? null : 'Changed or removed in the note since it was added.',
      at: i.insertedAt,
      status: i.retained ? 'In the note' : 'Changed since',
      trust: 'doctor_reviewed',
      source: i.insertedByName ?? 'The doctor',
      provenance: i.producedBy,
      target: 'note',
    })
  }

  // -- Conflicts (fixed rules; shown, never resolved) --
  const found = findConflicts({
    pairs: (pairRows ?? []).map((r) => ({
      staff: { itemId: `vital_staff:${r.staff.id}`, observationId: r.staff.id, kind: r.staff.kind, value: r.staff.value, measuredAt: r.staff.measuredAt },
      device: { itemId: pairedId(r.device.id), observationId: r.device.id, value: r.device.value, measuredAt: r.device.measuredAt, simulated: r.device.validationStatus === SIMULATED || r.dev.integration === 'simulator' },
    })),
    points: pointRows
      ? pointRows.map((r) => ({
          itemId: `point:${r.f.id}`,
          factId: r.f.id,
          category: r.f.category,
          text: r.f.finalText ?? r.f.text,
          stateLabel: pointState(r.f.status),
          edited: r.f.finalText !== null && r.f.finalText !== r.f.text,
          flags: r.f.flags as string[],
          substance: substanceOf(r.f.attributes),
          negated: r.f.negated,
          comparedWith: r.comparedWith,
        }))
      : null,
    statements: isAuthor && drafts ? items.filter((i) => i.decision !== 'rejected').map((i) => ({ itemId: `ai_draft:${shown!.id}`, statementId: i.id, text: i.finalText ?? i.text, support: i.support })) : null,
    record: record ? { allergies: record.allergiesCompared, noKnownAllergies: p.noKnownAllergies } : null,
    time,
  })
  // A reading a staff measurement disagrees with is shown too, even when the device has sent newer ones, so that both sides can be looked at. One
  // that agrees is not: a band sends every few seconds, and the same value would be listed again beside the newest.
  if (deviceData) {
    const sides = new Set(found.filter((c) => c.kind === 'vital_staff_vs_device').flatMap((c) => c.itemIds))
    for (const r of pairRows ?? []) {
      const id = pairedId(r.device.id)
      if (sides.has(id) && !evidence.some((x) => x.id === id)) add(deviceItem(r.device, r.dev, id).item)
    }
  }

  // Newest first; items of the same instant in a fixed order (by id, compared as plain text so that the order never depends on a locale).
  evidence.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const inEvidence = new Set(evidence.map((x) => x.id))
  const conflicts = found.map((c) => ({ ...c, itemIds: c.itemIds.filter((id) => inEvidence.has(id)) }))

  // -- What waits for the doctor: counted in full (the lists above are capped). A kind not read, or not shown to this viewer, is `unread`: its 0
  // is then not "nothing waits". The draft's statements are those of the draft shown (at most LIMIT.draftItems). --
  const waitingPoints = (pointRows ?? []).filter((r) => r.f.status === 'pending' || r.f.status === 'deferred')
  const waitingStatements = shown && shown.status !== 'generating' ? items.filter((i) => i.decision === 'pending') : []
  const waitingThermal = (thermalRows ?? []).filter((r) => r.c.status === 'draft')
  const waitingSummaries = (summaryRows ?? []).filter((r) => r.s.status === 'pending')
  const notRead: Record<(typeof PENDING_KINDS)[number], boolean> = { points: !pointData, draftStatements: !drafts, thermalImages: !thermalData, thermalSummaries: !summaryData }
  const pending: PendingReview = {
    points: pointData?.waiting ?? 0,
    draftStatements: waitingStatements.length,
    thermalImages: thermalData?.drafts ?? 0,
    thermalSummaries: summaryData?.pending ?? 0,
    unread: PENDING_KINDS.filter((k) => notRead[k]),
  }

  // -- What a consultation usually has and this one does not (yet), and what could not be read --
  const missing: string[] = []
  if (staffRows && !staffRows.length) missing.push('Vital signs not recorded by staff at this visit.')
  if (record && !record.allergies.length && !p.noKnownAllergies) missing.push('Allergy status not recorded: no allergy, and “no known allergies” is not marked.')
  if (transcriptRows && !transcriptRows.length) missing.push('No conversation captured in this consultation.')
  if (isAuthor && drafts && !shown) missing.push(await noDraftLine(drafts.newest, deps, time))
  if (thermalRows && !thermalRows.length) missing.push('No thermal image in this consultation (for information; not required).')
  if (stethRows && !stethRows.length) missing.push('No stethoscope recording in this consultation (for information; not required).')
  for (const key of Object.keys(UNREAD) as SourceKey[]) if (unread.has(key)) missing.push(UNREAD[key])

  const hidden = !seesConversation
    ? 'The conversation and the important points of this consultation are shown to doctors, and its AI draft to its doctor only; they are not part of this view.'
    : !isAuthor
      ? 'The AI draft of this consultation is shown to its doctor only; it is not part of this view.'
      : null

  const summary = composeSummary({
    reasonForVisit: v.chiefComplaint,
    confirmedPoints: pointData ? pointData.confirmed.map((f) => ({ itemId: `point:${f.id}`, category: f.category, text: f.finalText ?? f.text })) : null,
    confirmedCount: pointData?.confirmedCount ?? 0,
    record: record ? { ...record, noKnownAllergies: p.noKnownAllergies } : null,
    staffVitals: staffRows ? staffRows.map(({ o }) => ({ itemId: `vital_staff:${o.id}`, kind: o.kind, value: o.value, measuredAt: o.measuredAt })) : null,
    deviceReadings: deviceData ? deviceReadings : null,
    thermal: thermalRows
      ? thermalRows.map(({ c, rois }) => ({ itemId: `thermal:${c.id}`, region: regionOf(c.protocol), status: c.status, simulated: c.simulated, captureSource: c.captureSource, capturedAt: c.capturedAt, minC: c.minC, maxC: c.maxC, meanC: c.meanC, rois }))
      : null,
    stethoscope: stethRows ? stethRows.map(({ r }) => ({ itemId: `stethoscope:${r.id}`, site: siteLabel(r.site), durationMs: r.durationMs, simulated: r.simulated })) : null,
    draftStatements: isAuthor && drafts ? items.map((i) => ({ itemId: `ai_draft:${shown!.id}`, section: i.section, text: i.text, finalText: i.finalText, decision: i.decision })) : null,
    mana: { itemIds: (manaRows ?? []).map((m) => `mana:${m.id}`), answered: (manaRows ?? []).reduce((n, m) => n + m.answered, 0) },
    pending,
    pendingItemIds: {
      points: waitingPoints.map((r) => `point:${r.f.id}`),
      draftStatements: waitingStatements.length ? [`ai_draft:${shown!.id}`] : [],
      thermalImages: waitingThermal.map((r) => `thermal:${r.c.id}`),
      thermalSummaries: waitingSummaries.map((r) => `thermal_summary:${r.s.id}`),
    },
    waitingPointsTrust: pointData?.waitingByModel ? 'model_output' : 'extracted',
    unread,
    conflicts,
    missing,
    simulatedShown: evidence.some((x) => x.trust === 'simulated'),
    hidden,
    time,
    dateTime,
  })

  return {
    encounterId: e.id,
    patientId: e.patientId,
    generatedAt: new Date(now).toISOString(),
    reasonForVisit: v.chiefComplaint ?? null,
    evidence,
    conflicts,
    pending,
    missing,
    summary,
    rules: { conflicts: CONFLICT_RULES_VERSION, summary: SUMMARY_COMPOSER_VERSION },
  }
}

/** Why there is no AI draft, when it is known: the last attempt says so, or the local model says it is unavailable now. */
async function noDraftLine(newest: typeof consultationDrafts.$inferSelect | null, deps: ContextDeps, time: (d: Date) => string): Promise<string> {
  if (newest?.status === 'unavailable') return `No AI draft made in this consultation: the local model was unavailable when one was asked for (at ${time(newest.createdAt)}).`
  if (newest?.status === 'failed') return `No AI draft made in this consultation: the last attempt failed (at ${time(newest.createdAt)}).`
  if (newest?.status === 'cancelled') return `No AI draft made in this consultation: the last attempt was cancelled (at ${time(newest.createdAt)}).`
  try {
    const s = await deps.reasoningStatus?.()
    if (s && !s.available) return `No AI draft made in this consultation; the local model is unavailable now${s.reason ? ` (${s.reason.replace(/\.$/, '')})` : ''}.`
  } catch {
    // Not knowing why is said as not knowing: the line below.
  }
  return 'No AI draft made in this consultation.'
}
