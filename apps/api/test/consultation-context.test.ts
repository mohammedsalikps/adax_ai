import crypto from 'node:crypto'
import { ConsultationContext, Encounter, EVIDENCE_KINDS, type EvidenceItem, PatientDetail, Visit, VITALS, type VitalKind } from '@adaxai/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/password.ts'
import type { SessionUser } from '../src/auth/sessions.ts'
import { buildConsultationContext } from '../src/consultation-context/build.ts'
import { findConflicts, type VitalPairInput } from '../src/consultation-context/conflicts.ts'
import { NOT_ANALYSED, SUMMARY_ADVISORY, SUMMARY_SIMULATED } from '../src/consultation-context/summary.ts'
import type { Db } from '../src/db/client.ts'
import {
  aiEvidence,
  aiJobs,
  aiRuns,
  auscultationRecordings,
  clinicalFacts,
  consultationDraftItems,
  consultationDrafts,
  departments,
  deviceAssignments,
  devices,
  encounters,
  facilities,
  files,
  manaConversations,
  manaMessages,
  noteInsertions,
  observations,
  thermalCaptures,
  thermalRois,
  thermalSummaries,
  transcriptSegments,
  transcripts,
  users,
} from '../src/db/schema.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD, testConfig } from './helpers.ts'

// D2: the consultation context. Every case is synthetic: records are written straight into the test database (the routes that make them are
// tested in their own files), at fixed times on a fixed clock, so that what the context says, and in what order, is the same on every run.
// 05:00 UTC is 10:30 at the facility (Asia/Kolkata); the server's clock stands at 10:45.

const BASE = Date.parse('2026-10-05T05:00:00.000Z')
const NOW = BASE + 15 * 60_000
const at = (minutes: number, seconds = 0) => new Date(BASE + minutes * 60_000 + seconds * 1000)
const ago = (seconds: number) => new Date(NOW - seconds * 1000)

const settings = loadAppSettings()
// Several people sign in again after every reset: the sign-in limits are not what is under test here.
const generous = { ...settings, security: { rateLimits: { ...settings.security.rateLimits, loginPerIp: { max: 100_000, windowSeconds: 60 }, loginPerAccount: { max: 100_000, windowSeconds: 60 } } } }
const ctx = createTestApp({ clock: () => NOW, settings: generous })
let fx: Fixture
let doctor = ''
let nurse = ''
afterAll(() => ctx.close())
beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  doctor = await login(ctx.app, 't.doctor')
  nurse = await login(ctx.app, 't.nurse')
})

// ---- Building a consultation ------------------------------------------------------------------------------------------------------------

let seq = 0
async function consultation(o: { reason?: string } = {}) {
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Ctx${'abcdefghij'[seq % 10]}`, phone: `98402 ${String(10000 + seq)}` }) })).json())
  await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'device_monitoring', method: 'verbal' } })
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: o.reason ?? 'Cough and fever' } })).json())
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  return { p, v, e }
}
type Consultation = Awaited<ReturnType<typeof consultation>>

async function staffVital(c: Consultation, kind: VitalKind, value: number, when: Date) {
  const [o] = await ctx.db.insert(observations).values({ patientId: c.p.id, visitId: c.v.id, kind, value, unit: VITALS[kind].unit, measuredAt: when, source: 'manual', validationStatus: 'manual_entry', recordedBy: fx.users.nurse, createdAt: when }).returning({ id: observations.id })
  return o!.id
}

async function band(c: Consultation, o: { label: string; simulator?: boolean; lastSeen: Date | null; attach?: boolean }) {
  const [d] = await ctx.db
    .insert(devices)
    .values({ facilityId: fx.facilityId, kind: 'wearable_band', label: o.label, serialNumber: `SN-${crypto.randomUUID().slice(0, 8)}`, integration: o.simulator ? 'simulator' : 'gateway_api', lastSeenAt: o.lastSeen, createdBy: fx.users.admin })
    .returning()
  if (o.attach !== false) await ctx.db.insert(deviceAssignments).values({ deviceId: d!.id, patientId: c.p.id, visitId: c.v.id, encounterId: c.e.id, assignedBy: fx.users.nurse, assignedAt: at(-60) })
  return d!
}

async function deviceReading(c: Consultation, d: { id: string; integration: string }, kind: VitalKind, value: number, when: Date, visitId = c.v.id) {
  const [o] = await ctx.db
    .insert(observations)
    .values({ patientId: c.p.id, visitId, kind, value, unit: VITALS[kind].unit, measuredAt: when, source: 'device', validationStatus: d.integration === 'simulator' ? 'simulated' : 'device_unverified', deviceId: d.id, createdAt: when })
    .returning({ id: observations.id })
  return o!.id
}

async function transcript(c: Consultation, lines: [string, string][], start: number, encounterId = c.e.id) {
  const [t] = await ctx.db.insert(transcripts).values({ encounterId, source: 'typed', status: 'final', createdBy: fx.users.doctor, createdAt: at(start) }).returning({ id: transcripts.id })
  await ctx.db.insert(transcriptSegments).values(lines.map(([speaker, text], i) => ({ transcriptId: t!.id, seq: i + 1, label: `S${i + 1}`, speaker, speakerSource: 'typed_label', text, createdAt: at(start + i + 1) })))
  return t!.id
}

interface PointSpec {
  category: string
  text: string
  status?: string
  finalText?: string
  flags?: string[]
  /** What the extraction found (an allergy's substance), stored as the extractor stores it. */
  substance?: string
  negated?: boolean
  when: Date
}
/** An extraction run: the fixed rules (V2's default extractor) unless a model's provider is named. */
async function extraction(c: Consultation, transcriptId: string, provider = 'adaxai-rules') {
  const [job] = await ctx.db.insert(aiJobs).values({ facilityId: fx.facilityId, patientId: c.p.id, encounterId: c.e.id, kind: 'extraction', status: 'succeeded', input: { transcriptId }, dataOrigin: 'synthetic', createdBy: fx.users.doctor }).returning({ id: aiJobs.id })
  const model = provider === 'adaxai-rules' ? 'extract-rules-v1' : 'qwen2.5-7b-instruct'
  const [run] = await ctx.db.insert(aiRuns).values({ jobId: job!.id, patientId: c.p.id, encounterId: c.e.id, kind: 'extraction', provider, model, promptVersion: provider === 'adaxai-rules' ? 'extract-rules-v1' : 'extract-v1', status: 'succeeded' }).returning({ id: aiRuns.id })
  return { jobId: job!.id, runId: run!.id }
}
const pointValues = (c: Consultation, transcriptId: string, run: { jobId: string; runId: string }, o: PointSpec) => ({
  ...run,
  transcriptId,
  encounterId: c.e.id,
  patientId: c.p.id,
  category: o.category,
  text: o.text,
  attribution: 'patient_reported',
  certainty: 'stated',
  negated: !!o.negated,
  attributes: o.substance ? { substance: o.substance } : {},
  flags: o.flags ?? [],
  status: o.status ?? 'pending',
  finalText: o.finalText ?? null,
  createdAt: o.when,
  ...(o.status && o.status !== 'pending' ? { decidedBy: fx.users.doctor, decidedAt: o.when } : {}),
})
async function point(c: Consultation, transcriptId: string, o: PointSpec & { provider?: string }) {
  const [f] = await ctx.db.insert(clinicalFacts).values(pointValues(c, transcriptId, await extraction(c, transcriptId, o.provider), o)).returning({ id: clinicalFacts.id })
  return f!.id
}

async function fileRow(c: Consultation, kind: string, encounterId: string | null) {
  const [f] = await ctx.db.insert(files).values({ facilityId: fx.facilityId, patientId: c.p.id, encounterId, kind, storageKey: `test/${crypto.randomUUID()}`, mimeType: 'application/octet-stream', sizeBytes: 1000, sha256: 'a'.repeat(64), uploadedBy: fx.users.doctor }).returning({ id: files.id })
  return f!.id
}

async function stethoscope(c: Consultation, when: Date, encounterId = c.e.id) {
  const [r] = await ctx.db
    .insert(auscultationRecordings)
    .values({ facilityId: fx.facilityId, patientId: c.p.id, encounterId, fileId: await fileRow(c, 'stethoscope_audio', encounterId), site: 'mitral', dataOrigin: 'synthetic', captureMethod: 'file_upload', durationMs: 38_000, createdBy: fx.users.doctor, createdAt: when })
    .returning({ id: auscultationRecordings.id })
  return r!.id
}

const roiStats = (min: number, max: number, mean: number) => ({ pixelCount: 400, min, max, mean, std: 0.8 })
interface ThermalSpec {
  when: Date
  approved?: boolean
  simulated?: boolean
  encounterId?: string
  /** How a real image arrived (default: a live capture, dated by the camera at `when`). */
  source?: 'live_capture' | 'gallery_import' | 'file_upload'
  /** When the camera says it took the image (default: `when` for a real image; null: the camera said nothing). */
  capturedAt?: Date | null
  /** What the camera reported as its model (default: "FLIR ONE Pro"). */
  cameraModel?: string
}
async function thermal(c: Consultation, o: ThermalSpec) {
  const encounterId = o.encounterId ?? c.e.id
  const [t] = await ctx.db
    .insert(thermalCaptures)
    .values({
      facilityId: fx.facilityId,
      patientId: c.p.id,
      encounterId,
      rawFileId: await fileRow(c, 'thermal_raw', encounterId),
      matrixFileId: await fileRow(c, 'thermal_matrix', encounterId),
      width: 160,
      height: 120,
      minC: 28.1,
      maxC: 34.6,
      meanC: 31.2,
      stdC: 1.1,
      camera: o.simulated ? { make: null, model: 'ADAXAI thermal simulator (SIMULATED)', dateTime: null } : { make: 'FLIR', model: o.cameraModel ?? 'FLIR ONE Pro', dateTime: null },
      parameters: {},
      extractor: o.simulated ? { name: 'thermal-sim', version: 'thermal-sim-v1' } : { name: 'flir-extract', version: '1.0' },
      protocol: { bodyRegion: 'Knees', bodySite: 'knee', view: 'anterior' },
      dataOrigin: 'synthetic',
      captureSource: o.simulated ? 'simulator' : (o.source ?? 'live_capture'),
      simulated: !!o.simulated,
      capturedAt: o.simulated ? null : o.capturedAt === undefined ? o.when : o.capturedAt,
      createdBy: fx.users.doctor,
      createdAt: o.when,
    })
    .returning()
  await ctx.db.insert(thermalRois).values([
    { captureId: t!.id, label: 'Left knee', shape: 'rect', x: 10, y: 10, width: 20, height: 20, stats: roiStats(30.1, 33.9, 32), sortOrder: 0, createdBy: fx.users.doctor },
    { captureId: t!.id, label: 'Right knee', shape: 'rect', x: 60, y: 10, width: 20, height: 20, stats: roiStats(29.8, 32.5, 31.1), sortOrder: 1, createdBy: fx.users.doctor },
  ])
  if (o.approved) await ctx.db.update(thermalCaptures).set({ status: 'approved', reviewedBy: fx.users.doctor, reviewedAt: o.when }).where(eq(thermalCaptures.id, t!.id))
  return t!
}

async function thermalSummary(c: Consultation, capture: { id: string; simulated: boolean; encounterId: string | null }, when: Date, decision: 'accepted' | 'pending' = 'accepted') {
  const model = { available: false, kind: null, modelId: null, version: null, artifactSha256: null, intendedUse: null, evaluation: null, reason: 'No thermal model is installed.' }
  const [s] = await ctx.db
    .insert(thermalSummaries)
    .values({ facilityId: fx.facilityId, patientId: c.p.id, encounterId: capture.encounterId, captureId: capture.id, composerVersion: 'thermal-summary-v1', rulesVersion: 'rules-v1', model, statements: [{ basis: 'measurement', source: 'whole image', text: 'Whole image min 28.1 °C.' }], text: 'Whole image min 28.1 °C.', simulated: capture.simulated, createdBy: fx.users.doctor, createdAt: when })
    .returning({ id: thermalSummaries.id })
  if (decision !== 'pending') await ctx.db.update(thermalSummaries).set({ status: decision, decidedBy: fx.users.doctor, decidedAt: when }).where(eq(thermalSummaries.id, s!.id))
  return s!.id
}

interface DraftStatement {
  section: string
  text: string
  decision: 'pending' | 'accepted' | 'edited' | 'rejected'
  finalText?: string
  support?: string
}
async function draft(c: Consultation, o: { when: Date; status?: string; statements?: DraftStatement[]; version?: number }) {
  const [d] = await ctx.db
    .insert(consultationDrafts)
    .values({
      facilityId: fx.facilityId,
      encounterId: c.e.id,
      patientId: c.p.id,
      version: o.version ?? 1,
      status: o.status ?? 'ready',
      provider: 'llama.cpp',
      model: 'qwen2.5-7b-instruct',
      locality: 'local',
      promptId: 'consult-draft-v1',
      schemaVersion: 'consult-schema-v1',
      rulesVersion: 'record-check-v1',
      checksVersion: 'consult-checks-v1',
      contextSha256: 'b'.repeat(64),
      contextManifest: [],
      sourceCount: 3,
      recordCheck: { rulesVersion: 'record-check-v1', conflicts: [], outdated: [], missing: [] },
      requestedBy: fx.users.doctor,
      createdAt: o.when,
      completedAt: o.when,
    })
    .returning({ id: consultationDrafts.id })
  const ids: string[] = []
  for (const [i, s] of (o.statements ?? []).entries()) {
    const decided = s.decision !== 'pending' ? { decidedBy: fx.users.doctor, decidedAt: o.when } : {}
    const [row] = await ctx.db
      .insert(consultationDraftItems)
      .values({ draftId: d!.id, section: s.section, position: i, text: s.text, support: s.support ?? 'supported', decision: s.decision, finalText: s.finalText ?? null, createdAt: new Date(o.when.getTime() + i), ...decided })
      .returning({ id: consultationDraftItems.id })
    ids.push(row!.id)
  }
  return { id: d!.id, statementIds: ids }
}

async function manaConversation(c: Consultation, when: Date, doctorId = fx.users.doctor) {
  const [conv] = await ctx.db.insert(manaConversations).values({ facilityId: fx.facilityId, doctorId, encounterId: c.e.id, patientId: c.p.id, dataOrigin: 'synthetic', createdAt: when, updatedAt: when }).returning({ id: manaConversations.id })
  const [q] = await ctx.db.insert(manaMessages).values({ conversationId: conv!.id, seq: 1, role: 'doctor', text: 'What does the record say about MANA-QUESTION-WORDS?', askedBy: doctorId, status: 'ready', createdAt: when }).returning({ id: manaMessages.id })
  await ctx.db.insert(manaMessages).values({ conversationId: conv!.id, seq: 2, role: 'mana', parentId: q!.id, askedBy: doctorId, status: 'ready', createdAt: new Date(when.getTime() + 30_000), completedAt: new Date(when.getTime() + 30_000) })
  return conv!.id
}

async function insertion(c: Consultation, subjectId: string, text: string, when: Date) {
  await ctx.db.update(encounters).set({ history: text }).where(eq(encounters.id, c.e.id))
  const [i] = await ctx.db
    .insert(noteInsertions)
    .values({ encounterId: c.e.id, patientId: c.p.id, section: 'history', text, subjectType: 'consultation_item', subjectId, producedBy: 'llama.cpp · qwen2.5-7b-instruct · consult-draft-v1', insertedBy: fx.users.doctor, insertedAt: when })
    .returning({ id: noteInsertions.id })
  return i!.id
}

// ---- Reading it ---------------------------------------------------------------------------------------------------------------------------

async function context(encounterId: string, cookie = doctor) {
  const res = await call(ctx.app, 'GET', `/api/encounters/${encounterId}/context`, { cookie })
  expect(res.statusCode, res.body).toBe(200)
  return ConsultationContext.parse(res.json())
}
const ofKind = (c: ConsultationContext, kind: EvidenceItem['kind']) => c.evidence.filter((x) => x.kind === kind)
const item = (c: ConsultationContext, id: string) => {
  const x = c.evidence.find((e) => e.id === id)
  expect(x, id).toBeDefined()
  return x!
}
const section = (c: ConsultationContext, key: string) => c.summary.sections.find((s) => s.key === key)!.statements
const allStatements = (c: ConsultationContext) => c.summary.sections.flatMap((s) => s.statements)
const me = (role: 'doctor' | 'nurse' = 'doctor'): SessionUser => ({
  id: role === 'doctor' ? fx.users.doctor : fx.users.nurse,
  sessionId: 'test',
  username: `t.${role}`,
  fullName: `Test t.${role}`,
  role,
  facilityId: fx.facilityId,
  departmentId: fx.departments.gen,
  patientId: null,
  mustChangePassword: false,
})

/** Every summary statement rests on evidence that is in the context, and the evidence runs newest first. */
function wellFormed(c: ConsultationContext) {
  const ids = new Set(c.evidence.map((x) => x.id))
  expect(ids.size).toBe(c.evidence.length)
  for (const s of allStatements(c)) for (const id of s.itemIds) expect(ids.has(id), `${s.text} -> ${id}`).toBe(true)
  for (const k of c.conflicts) for (const id of k.itemIds) expect(ids.has(id)).toBe(true)
  const times = c.evidence.map((x) => x.at)
  expect(times).toEqual([...times].sort().reverse())
  expect(c.rules).toEqual({ conflicts: 'context-conflicts-v2', summary: 'multimodal-summary-v2' })
  expect(c.summary.composer).toBe('multimodal-summary-v2')
  expect(section(c, 'review').at(-1)!.text).toBe(SUMMARY_ADVISORY)
}
/** What a statement that says something is absent says: none of these may be said about a source that could not be read. */
const ABSENT = /No observation is recorded|no confirmed point is recorded|No statement of an AI draft has been accepted/

// ---- The cases ------------------------------------------------------------------------------------------------------------------------------

describe('CASE A: a consultation with every modality', () => {
  it('lists every kind, newest first, each with its trust, state and provenance; the summary states only what the rules allow', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Doctor', 'What brings you in today?'], ['Patient', 'A dry cough for three days. ZEBRA-TRANSCRIPT-ONLY']], 0)
    const confirmed = await point(c, tid, { category: 'symptom', text: 'Dry cough for three days', status: 'accepted', when: at(4) })
    const extracted = await point(c, tid, { category: 'symptom', text: 'Fever at night', when: at(4, 30) })
    const spo2 = await staffVital(c, 'spo2', 98, at(10))
    const temp = await staffVital(c, 'temperature', 37.8, at(10))
    const b = await band(c, { label: 'Band A', lastSeen: ago(5) })
    await deviceReading(c, b, 'heart_rate', 82, ago(10))
    const rec = await stethoscope(c, at(6))
    const cap = await thermal(c, { when: at(7), approved: true })
    const summaryId = await thermalSummary(c, cap, at(8))
    const d = await draft(c, {
      when: at(9),
      statements: [
        { section: 'symptoms', text: 'Dry cough for three days.', decision: 'accepted' },
        { section: 'symptoms', text: 'Fever reported at night.', decision: 'edited', finalText: 'Fever at night, reported by the patient.' },
        { section: 'potential_considerations', text: 'PENDING-AI-WORDS consider an examination finding.', decision: 'pending' },
      ],
    })
    const conv = await manaConversation(c, at(11))
    const ins = await insertion(c, d.statementIds[0]!, 'Dry cough for three days.', at(12))

    const out = await context(c.e.id)
    wellFormed(out)
    expect(out.encounterId).toBe(c.e.id)
    expect(out.generatedAt).toBe(new Date(NOW).toISOString())
    expect(out.reasonForVisit).toBe('Cough and fever')
    expect(new Set(out.evidence.map((x) => x.kind))).toEqual(new Set(Object.keys(EVIDENCE_KINDS)))
    // The newest reading of a device and kind is named by the device and the kind (it keeps its id as newer readings arrive).
    expect(out.evidence.map((x) => x.id)).toEqual([
      `vital_device:${b.id}:heart_rate`,
      `note_insertion:${ins}`,
      `mana:${conv}`,
      // Taken at the same minute: in a fixed order (by id).
      ...[`vital_staff:${spo2}`, `vital_staff:${temp}`].sort(),
      `ai_draft:${d.id}`,
      `thermal_summary:${summaryId}`,
      `thermal:${cap.id}`,
      `stethoscope:${rec}`,
      `point:${extracted}`,
      `point:${confirmed}`,
      `transcript:${tid}`,
    ])

    // The conversation: counts and times, never its words.
    expect(item(out, `transcript:${tid}`)).toMatchObject({ title: 'Conversation: 2 lines', status: 'Ended', trust: 'observed', target: 'conversation', detail: 'Typed · last line at 10:32' })
    expect(JSON.stringify(out)).not.toContain('ZEBRA-TRANSCRIPT-ONLY')
    expect(item(out, `point:${confirmed}`)).toMatchObject({ title: 'Symptom: “Dry cough for three days”', status: 'Doctor confirmed', trust: 'doctor_reviewed', source: 'Patient said', provenance: 'adaxai-rules · extract-rules-v1 · extract-rules-v1' })
    // Found by the fixed rules and not yet decided: "extracted, to review" (a model's would be AI output); the doctor's once confirmed.
    expect(item(out, `point:${extracted}`)).toMatchObject({ status: 'Extracted draft', trust: 'extracted' })
    expect(item(out, `vital_staff:${spo2}`)).toMatchObject({ title: 'SpO₂ 98 %', status: 'Recorded', trust: 'clinician_entered', source: 'Test t.nurse', target: 'history' })
    expect(item(out, `vital_device:${b.id}:heart_rate`)).toMatchObject({ title: 'Heart rate 82 bpm', status: 'LIVE', trust: 'measured_unverified', source: 'Band A (gateway)', provenance: 'Wearable band · Gateway posts readings (API boundary)', target: 'devices' })
    expect(item(out, `stethoscope:${rec}`)).toMatchObject({ title: 'Recording 38 s, mitral area (apex)', status: 'Recorded', trust: 'recorded', target: 'devices' })
    expect(item(out, `stethoscope:${rec}`).detail).toContain(NOT_ANALYSED)
    expect(item(out, `thermal:${cap.id}`)).toMatchObject({ title: 'Thermal image, Knee', status: 'Approved', trust: 'measured', source: 'FLIR ONE Pro (live capture)', provenance: 'flir-extract 1.0', target: 'thermal', detail: 'Live capture · radiometric · 2 regions · model unavailable' })
    expect(item(out, `thermal_summary:${summaryId}`)).toMatchObject({ title: 'Thermal summary, Knee', status: 'Accepted', trust: 'rule_output', provenance: 'thermal-summary-v1 · rules-v1' })
    expect(item(out, `ai_draft:${d.id}`)).toMatchObject({ title: 'AI draft: 3 statements', status: 'To review', trust: 'model_output', source: 'Local model qwen2.5-7b-instruct', provenance: 'llama.cpp · qwen2.5-7b-instruct · consult-draft-v1', detail: '1 accepted · 1 edited · 1 to review', target: 'draft' })
    expect(item(out, `mana:${conv}`)).toMatchObject({ title: 'Mana: 1 answered question', status: 'Answered', trust: 'model_output', target: 'mana' })
    expect(JSON.stringify(out)).not.toContain('MANA-QUESTION-WORDS')
    expect(item(out, `note_insertion:${ins}`)).toMatchObject({ title: 'Consultation draft statement added to History of present illness', status: 'In the note', trust: 'doctor_reviewed', target: 'note' })
    expect(out.pending).toEqual({ points: 1, draftStatements: 1, thermalImages: 0, thermalSummaries: 0, unread: [] })
    expect(out.conflicts).toEqual([])

    // The summary: fixed wording, only reviewed AI text, a recording that is not analysed, the measurements of the approved image.
    expect(section(out, 'presentation')).toEqual([
      { text: 'Reason for visit (as entered at check-in): “Cough and fever”.', trust: 'clinician_entered', itemIds: [] },
      { text: 'Symptom: “Dry cough for three days” (an important point confirmed by the doctor).', trust: 'doctor_reviewed', itemIds: [`point:${confirmed}`] },
    ])
    const obs = section(out, 'observations')
    expect(obs.map((s) => s.text)).toEqual([
      'Temperature 37.8 °C at 10:40 (entered by staff).',
      'SpO₂ 98 % at 10:40 (entered by staff).',
      // The state word (LIVE, STALE ...) changes as time passes; the time it was measured is stated.
      'Heart rate 82 bpm at 10:44: device reading, unverified (Band A).',
      'Thermal image of “Knee” (approved): whole image min 28.1 °C, max 34.6 °C, mean 31.2 °C; region “Left knee” min 30.1 °C, max 33.9 °C, mean 32 °C; region “Right knee” min 29.8 °C, max 32.5 °C, mean 31.1 °C. Skin-surface temperature only.',
      `Stethoscope recording (mitral area (apex), 38 s): ${NOT_ANALYSED}.`,
    ])
    expect(obs.map((s) => s.trust)).toEqual(['clinician_entered', 'clinician_entered', 'measured_unverified', 'measured', 'recorded'])
    const ai = section(out, 'ai')
    expect(ai.slice(0, 2)).toEqual([
      { text: '“Dry cough for three days.” (Symptoms; accepted by the doctor).', trust: 'doctor_reviewed', itemIds: [`ai_draft:${d.id}`] },
      { text: '“Fever at night, reported by the patient.” (Symptoms; edited and accepted by the doctor).', trust: 'doctor_reviewed', itemIds: [`ai_draft:${d.id}`] },
    ])
    expect(ai.map((s) => s.text)).toContain('1 AI draft statement waits for the doctor’s review; it is not part of this summary.')
    expect(ai.find((s) => s.text.startsWith('1 extracted important point waits'))).toEqual({ text: '1 extracted important point waits for the doctor’s review; it is not part of this summary.', trust: 'extracted', itemIds: [`point:${extracted}`] })
    expect(ai.map((s) => s.text)).toContain('Mana answered 1 question in this consultation; its answers are not part of this summary.')
    // Nothing the doctor has not reviewed is quoted anywhere in the summary.
    expect(JSON.stringify(out.summary)).not.toContain('PENDING-AI-WORDS')
    expect(JSON.stringify(out.summary)).not.toContain('Fever reported at night')
    expect(JSON.stringify(out.summary)).not.toMatch(/murmur|wheez|crackle|normal heart|diagnos|prescri|recommend/i)
    // What is not there yet, as information.
    expect(out.missing).toEqual(['Allergy status not recorded: no allergy, and “no known allergies” is not marked.'])
  })
})

describe('CASE B: no thermal image', () => {
  it('has no thermal item and invents no thermal statement; it says there is none, as information', async () => {
    const c = await consultation()
    await staffVital(c, 'temperature', 37.2, at(10))
    const out = await context(c.e.id)
    wellFormed(out)
    expect(ofKind(out, 'thermal')).toEqual([])
    expect(ofKind(out, 'thermal_summary')).toEqual([])
    expect(allStatements(out).filter((s) => /thermal image of|skin-surface/i.test(s.text))).toEqual([])
    expect(out.pending.thermalImages).toBe(0)
    expect(out.missing).toContain('No thermal image in this consultation (for information; not required).')
    expect(section(out, 'observations').map((s) => s.text)).toEqual(['Temperature 37.2 °C at 10:40 (entered by staff).'])
  })
})

describe('CASE C: a device that has gone quiet', () => {
  it('says DISCONNECTED (or STALE) and never LIVE; an attached band with no reading says so and fills nothing in', async () => {
    const c = await consultation()
    const quiet = await band(c, { label: 'Quiet band', lastSeen: ago(600) })
    await deviceReading(c, quiet, 'spo2', 96, ago(660))
    const slow = await band(c, { label: 'Slow band', lastSeen: ago(5) })
    await deviceReading(c, slow, 'heart_rate', 76, ago(300))
    await band(c, { label: 'Silent band', lastSeen: null })
    const out = await context(c.e.id)
    wellFormed(out)
    expect(item(out, `vital_device:${quiet.id}:spo2`)).toMatchObject({ status: 'DISCONNECTED', trust: 'measured_unverified' })
    expect(item(out, `vital_device:${quiet.id}:spo2`).detail).toContain('last value received')
    expect(item(out, `vital_device:${slow.id}:heart_rate`)).toMatchObject({ status: 'STALE', trust: 'measured_unverified' })
    const silent = ofKind(out, 'vital_device').find((x) => x.source.startsWith('Silent band'))!
    expect(silent).toMatchObject({ title: 'Silent band: no reading at this visit', status: 'DISCONNECTED' })
    expect(ofKind(out, 'vital_device').some((x) => x.status.includes('LIVE'))).toBe(false)
    // The summary states when each was measured, and never a state word that changes with time (the list above says STALE, DISCONNECTED).
    expect(section(out, 'observations').map((x) => x.text)).toEqual([
      'Heart rate 76 bpm at 10:40: device reading, unverified (Slow band).',
      'SpO₂ 96 % at 10:34: device reading, unverified (Quiet band).',
    ])
    // The device card says the same about the same devices.
    const card = (await call(ctx.app, 'GET', `/api/patients/${c.p.id}/device-readings`, { cookie: doctor })).json() as { devices: { label: string; state: string }[] }
    expect(Object.fromEntries(card.devices.map((d) => [d.label, d.state]))).toEqual({ 'Quiet band': 'disconnected', 'Slow band': 'stale', 'Silent band': 'disconnected' })
  })
})

describe('CASE D: no stethoscope recording', () => {
  it('has no stethoscope item, and the summary mentions no recording and no finding', async () => {
    const c = await consultation()
    await staffVital(c, 'heart_rate', 72, at(10))
    const out = await context(c.e.id)
    wellFormed(out)
    expect(ofKind(out, 'stethoscope')).toEqual([])
    for (const key of ['presentation', 'patient', 'observations', 'ai']) {
      expect(section(out, key).filter((s) => /stethoscope|auscultat|murmur|wheez|crackle|heart sound|breath sound/i.test(s.text))).toEqual([])
    }
    expect(out.missing).toContain('No stethoscope recording in this consultation (for information; not required).')
  })
})

describe('CASE E: no AI draft', () => {
  it('has no draft item; the summary says no draft was made, and why when that is known', async () => {
    const c = await consultation()
    const out = await context(c.e.id)
    wellFormed(out)
    expect(ofKind(out, 'ai_draft')).toEqual([])
    // The test server has no model: the reason the local model gives now is said.
    const line = out.missing.find((m) => m.startsWith('No AI draft made in this consultation'))!
    expect(line).toMatch(/^No AI draft made in this consultation; the local model is unavailable now/)
    expect(section(out, 'review').map((s) => s.text)).toContain(line)
    expect(section(out, 'ai').map((s) => s.text)).toContain('No statement of an AI draft has been accepted by the doctor in this consultation.')

    // An attempt that ended because the model was unavailable leaves no draft, and is what the line says.
    await draft(c, { when: at(9), status: 'unavailable' })
    const after = await context(c.e.id)
    expect(ofKind(after, 'ai_draft')).toEqual([])
    expect(after.missing).toContain('No AI draft made in this consultation: the local model was unavailable when one was asked for (at 10:39).')
    expect(after.pending.draftStatements).toBe(0)
  })
})

describe('CASE F: staff and device disagree', () => {
  it('shows one conflict with both values and both sources, and resolves nothing', async () => {
    const c = await consultation()
    const staff = await staffVital(c, 'spo2', 98, at(10))
    await staffVital(c, 'heart_rate', 80, at(10))
    const b = await band(c, { label: 'Band F', lastSeen: ago(5) })
    const low = await deviceReading(c, b, 'spo2', 94, at(12))
    // Within the threshold: not a conflict.
    const agrees = await deviceReading(c, b, 'heart_rate', 88, at(12))
    // The band went on sending: its newest values are listed, the one that disagrees stays visible, and the one that agrees is not listed again.
    await deviceReading(c, b, 'spo2', 97, ago(10))
    await deviceReading(c, b, 'heart_rate', 86, ago(10))
    const out = await context(c.e.id)
    wellFormed(out)
    expect(out.conflicts).toEqual([
      { id: `vital_staff_vs_device:${staff}:${low}`, kind: 'vital_staff_vs_device', text: 'Staff measured SpO₂ 98 % at 10:40; a device (unverified) sent 94 % at 10:42.', itemIds: [`vital_staff:${staff}`, `vital_device:obs:${low}`], rule: 'context-conflicts-v2' },
    ])
    // Both sides stay what they are.
    expect(item(out, `vital_staff:${staff}`)).toMatchObject({ title: 'SpO₂ 98 %', trust: 'clinician_entered' })
    expect(item(out, `vital_device:obs:${low}`)).toMatchObject({ title: 'SpO₂ 94 %', trust: 'measured_unverified', status: 'STALE' })
    expect(item(out, `vital_device:${b.id}:spo2`)).toMatchObject({ title: 'SpO₂ 97 %', status: 'LIVE' })
    expect(ofKind(out, 'vital_device').map((x) => x.id).sort()).toEqual([`vital_device:${b.id}:heart_rate`, `vital_device:${b.id}:spo2`, `vital_device:obs:${low}`].sort())
    expect(out.evidence.some((x) => x.id.endsWith(agrees))).toBe(false)
    expect(ofKind(out, 'vital_device').filter((x) => x.title === 'Heart rate 88 bpm')).toEqual([])
    const review = section(out, 'review')
    expect(review).toContainEqual({ text: 'Conflict: Staff measured SpO₂ 98 % at 10:40; a device (unverified) sent 94 % at 10:42.', trust: 'rule_output', itemIds: [`vital_staff:${staff}`, `vital_device:obs:${low}`] })
    // No side is chosen: the staff value is stated as entered, the device value as unverified, and neither is called right or wrong.
    const obs = section(out, 'observations').map((s) => s.text)
    expect(obs).toContain('SpO₂ 98 % at 10:40 (entered by staff).')
    expect(obs).toContain('SpO₂ 97 % at 10:44: device reading, unverified (Band F).')
    expect(JSON.stringify([out.conflicts, review])).not.toMatch(/correct|wrong|accurate|reliable|likely|should|use the/i)
  })

  it('a reading that disagrees and is also the device’s newest is one item, with the id it has in the list', async () => {
    const c = await consultation()
    const staff = await staffVital(c, 'spo2', 98, at(10))
    const b = await band(c, { label: 'Band F2', lastSeen: ago(5) })
    const low = await deviceReading(c, b, 'spo2', 93, at(12))
    const out = await context(c.e.id)
    wellFormed(out)
    expect(out.conflicts.map((k) => k.itemIds)).toEqual([[`vital_staff:${staff}`, `vital_device:${b.id}:spo2`]])
    expect(ofKind(out, 'vital_device').map((x) => x.id)).toEqual([`vital_device:${b.id}:spo2`])
    expect(out.evidence.some((x) => x.id.endsWith(low))).toBe(false)
  })

  it('the rules: thresholds as stated, the window, and never a simulated reading', () => {
    const pair = (kind: VitalKind, staff: number, device: number, minutesApart = 2, simulated = false): VitalPairInput => ({
      staff: { itemId: 's', observationId: `s-${kind}-${staff}-${device}`, kind, value: staff, measuredAt: at(10) },
      device: { itemId: 'd', observationId: `d-${kind}-${staff}-${device}-${minutesApart}`, value: device, measuredAt: at(10 + minutesApart), simulated },
    })
    const found = (p: VitalPairInput) => findConflicts({ pairs: [p], points: null, statements: null, record: null, time: (d) => d.toISOString().slice(11, 16) }).length
    expect([found(pair('spo2', 98, 95)), found(pair('spo2', 98, 96))]).toEqual([1, 0])
    expect([found(pair('heart_rate', 80, 95)), found(pair('heart_rate', 80, 94))]).toEqual([1, 0])
    expect([found(pair('temperature', 37, 37.5)), found(pair('temperature', 37, 37.4))]).toEqual([1, 0])
    expect([found(pair('respiratory_rate', 16, 21)), found(pair('respiratory_rate', 16, 20))]).toEqual([1, 0])
    expect(found(pair('spo2', 98, 90, 16))).toBe(0)
    expect(found(pair('spo2', 98, 90, 15))).toBe(1)
    expect(found(pair('spo2', 98, 80, 2, true))).toBe(0)
    expect(found(pair('systolic_bp', 120, 160))).toBe(0)
  })
})

describe('CASE G: an unverified device reading', () => {
  it('stays "device reading, unverified" in the list and in the summary, and is never stated as a measurement', async () => {
    const c = await consultation()
    const b = await band(c, { label: 'Band G', lastSeen: ago(5) })
    await deviceReading(c, b, 'temperature', 38.4, ago(20))
    const id = `vital_device:${b.id}:temperature`
    const out = await context(c.e.id)
    wellFormed(out)
    expect(item(out, id)).toMatchObject({ trust: 'measured_unverified', status: 'LIVE' })
    const about = allStatements(out).filter((s) => s.itemIds.includes(id))
    expect(about).toEqual([{ text: 'Temperature 38.4 °C at 10:44: device reading, unverified (Band G).', trust: 'measured_unverified', itemIds: [id] }])
    // Vital signs entered by staff are still missing: a device reading does not stand in for them.
    expect(out.missing).toContain('Vital signs not recorded by staff at this visit.')

    // A newer reading is the same item (the screen keeps its place), with the newer value.
    await deviceReading(c, b, 'temperature', 38.6, ago(5))
    const again = await context(c.e.id)
    expect(ofKind(again, 'vital_device').map((x) => [x.id, x.title])).toEqual([[id, 'Temperature 38.6 °C']])
  })
})

describe('CASE H: a simulator', () => {
  it('shows simulated readings and images as SIMULATED, never LIVE, never in the summary’s observations, never a conflict', async () => {
    const c = await consultation()
    await staffVital(c, 'spo2', 98, at(10))
    const sim = await band(c, { label: 'Sim band', simulator: true, lastSeen: ago(5) })
    await deviceReading(c, sim, 'spo2', 90, at(12))
    await deviceReading(c, sim, 'heart_rate', 140, ago(5))
    const far = `vital_device:${sim.id}:spo2`
    const fresh = `vital_device:${sim.id}:heart_rate`
    const cap = await thermal(c, { when: at(7), approved: true, simulated: true })
    const sum = await thermalSummary(c, cap, at(8))
    const out = await context(c.e.id)
    wellFormed(out)
    expect(out.conflicts).toEqual([])
    expect(item(out, fresh)).toMatchObject({ status: 'SIMULATED', trust: 'simulated', source: 'Sim band (simulator)' })
    expect(item(out, far)).toMatchObject({ status: 'SIMULATED · STALE', trust: 'simulated' })
    expect(item(out, fresh).detail).toMatch(/^SIMULATED/)
    expect(item(out, `thermal:${cap.id}`)).toMatchObject({ status: 'SIMULATED · Approved', trust: 'simulated', source: 'Thermal simulator (SIMULATED)' })
    expect(item(out, `thermal:${cap.id}`).detail).toContain('generated numbers, not radiometric')
    expect(item(out, `thermal_summary:${sum}`)).toMatchObject({ status: 'SIMULATED · Accepted', trust: 'simulated' })
    expect(out.evidence.filter((x) => x.trust === 'simulated').every((x) => x.status.startsWith('SIMULATED') && !x.status.includes('LIVE'))).toBe(true)
    const simulatedIds = new Set(out.evidence.filter((x) => x.trust === 'simulated').map((x) => x.id))
    expect(allStatements(out).filter((s) => s.itemIds.some((id) => simulatedIds.has(id)))).toEqual([])
    expect(section(out, 'observations').map((s) => s.text)).toEqual(['SpO₂ 98 % at 10:40 (entered by staff).'])
    expect(section(out, 'review').map((s) => s.text)).toContain(SUMMARY_SIMULATED)
  })
})

// HERO §3: a conversation of synthetic demo audio (computer voices playing a script, transcribed by the real speech model) is never "said in the
// consultation": it says what it is, and so do the points found in it.
describe('CASE H2: a conversation of synthetic demo audio', () => {
  it('says so on the conversation and on the points found in it; a typed conversation beside it is what it is', async () => {
    const c = await consultation()
    const [t] = await ctx.db.insert(transcripts).values({ encounterId: c.e.id, source: 'browser_recording', audioOrigin: 'demo_synthetic', status: 'final', createdBy: fx.users.doctor, createdAt: at(5) }).returning({ id: transcripts.id })
    await ctx.db.insert(transcriptSegments).values([{ transcriptId: t!.id, seq: 1, label: 'S1', speaker: null, speakerSource: 'none', text: 'My daughter has had a fever for three days.', createdAt: at(6) }])
    const pid = await point(c, t!.id, { category: 'symptom', text: 'fever for three days', when: at(7) })
    const typed = await transcript(c, [['Doctor', 'Any cough?']], 8)
    const out = await context(c.e.id)
    wellFormed(out)
    expect(item(out, `transcript:${t!.id}`)).toMatchObject({ trust: 'synthetic_audio', status: 'SYNTHETIC · Ended', detail: expect.stringMatching(/^Synthetic demo audio: computer voices, not a real consultation; transcribed by the speech model · last line at /) })
    expect(item(out, `point:${pid}`)).toMatchObject({ trust: 'extracted', detail: 'From synthetic demo audio' })
    expect(item(out, `transcript:${typed}`)).toMatchObject({ trust: 'observed', status: 'Ended', detail: expect.stringMatching(/^Typed · /) })
  })
})

describe('CASE I: who may read it', () => {
  it('another facility gets "not found", and the probe is audited; a patient-portal session is refused', async () => {
    const c = await consultation()
    const [f2] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
    const [d2] = await ctx.db.insert(departments).values({ facilityId: f2!.id, code: 'GEN', name: 'General Medicine' }).returning()
    await ctx.db.insert(users).values({ facilityId: f2!.id, username: 'b.doctor', fullName: 'B doctor', role: 'doctor', passwordHash: await hashPassword(TEST_PASSWORD), departmentId: d2!.id })
    const other = await login(ctx.app, 'b.doctor')
    const res = await call(ctx.app, 'GET', `/api/encounters/${c.e.id}/context`, { cookie: other })
    expect(res.statusCode).toBe(404)
    expect(JSON.stringify(res.json())).not.toContain(c.p.id)
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'access.not_found' AND entity_id = $1", [c.e.id])
    expect(rows.map((r) => r.details.reason)).toEqual(['other_facility'])
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'encounter.context_viewed'")).rows[0].n).toBe(0)

    // A patient's own portal session reads nothing of a consultation here.
    await call(ctx.app, 'POST', `/api/patients/${c.p.id}/consents`, { cookie: nurse, body: { type: 'portal_access', method: 'verbal' } })
    const code = (await call(ctx.app, 'POST', `/api/patients/${c.p.id}/portal-activation`, { cookie: nurse })).json().activationCode
    const activated = await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: c.p.mrn, activationCode: code, password: 'Patient-passphrase-1' } })
    const portal = `adaxai_session=${activated.cookies.find((x) => x.name === 'adaxai_session')!.value}`
    expect((await call(ctx.app, 'GET', `/api/encounters/${c.e.id}/context`, { cookie: portal })).statusCode).toBe(403)
  })

  it('a nurse sees the encounter’s records, not the conversation, the points, the AI draft or Mana; another doctor not the AI draft', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'Cough.']], 0)
    await point(c, tid, { category: 'symptom', text: 'Cough', when: at(4) })
    await staffVital(c, 'spo2', 97, at(10))
    await draft(c, { when: at(9), statements: [{ section: 'symptoms', text: 'Cough.', decision: 'pending' }] })
    await manaConversation(c, at(11))
    const asNurse = await context(c.e.id, nurse)
    wellFormed(asNurse)
    expect(new Set(asNurse.evidence.map((x) => x.kind))).toEqual(new Set(['vital_staff']))
    // What is not shown to a nurse is not counted for her, and is said to be so: its 0 is not "nothing waits".
    expect(asNurse.pending).toEqual({ points: 0, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: ['points', 'draftStatements'] })
    expect(allStatements(asNurse).filter((s) => ABSENT.test(s.text))).toEqual([])
    expect(section(asNurse, 'review').map((s) => s.text)).toContain('The conversation and the important points of this consultation are shown to doctors, and its AI draft to its doctor only; they are not part of this view.')
    expect(section(asNurse, 'ai').map((s) => s.text)).toEqual(['The AI draft of this consultation is shown to its doctor only; nothing of it is stated here.'])
    expect(asNurse.missing.some((m) => /conversation|AI draft/.test(m))).toBe(false)

    const asOther = await context(c.e.id, await login(ctx.app, 't.doctor2'))
    expect(new Set(asOther.evidence.map((x) => x.kind))).toEqual(new Set(['transcript', 'point', 'vital_staff']))
    expect(asOther.pending).toMatchObject({ points: 1, draftStatements: 0, unread: ['draftStatements'] })
  })
})

describe('CASE J: another consultation of the same patient', () => {
  it('none of its images, readings, recordings or conversation appear in this one', async () => {
    const first = await consultation({ reason: 'Knee pain' })
    const b = await band(first, { label: 'Band J', lastSeen: ago(5) })
    await deviceReading(first, b, 'spo2', 90, at(5))
    await thermal(first, { when: at(3), approved: true })
    await stethoscope(first, at(4))
    await transcript(first, [['Patient', 'OLD-CONSULTATION-WORDS']], 0)
    // The first consultation is signed, which closes its visit; the patient comes back the same day.
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${first.e.id}/draft`, { cookie: doctor, body: { version: first.e.version, note: { ...first.e.note, chiefComplaint: 'Knee pain', assessment: 'Strain', plan: 'Rest' }, diagnoses: [{ description: 'Knee strain', kind: 'provisional' }], prescription: [] } })).json())
    expect((await call(ctx.app, 'POST', `/api/encounters/${first.e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    const v2 = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: first.p.id, departmentId: fx.departments.gen, chiefComplaint: 'Follow-up' } })).json())
    const e2 = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v2.id}/encounter`, { cookie: doctor })).json())
    const second = { p: first.p, v: v2, e: e2 }
    const mine = await staffVital(second, 'spo2', 99, at(10))

    const out = await context(e2.id)
    wellFormed(out)
    // Only what belongs to this consultation: the band is attached for the first visit, and its readings are of that visit.
    expect(out.evidence.map((x) => x.id)).toEqual([`vital_staff:${mine}`])
    expect(ofKind(out, 'vital_device')).toEqual([])
    expect(ofKind(out, 'thermal')).toEqual([])
    expect(ofKind(out, 'stethoscope')).toEqual([])
    expect(ofKind(out, 'transcript')).toEqual([])
    expect(out.conflicts).toEqual([])
    expect(JSON.stringify(out)).not.toMatch(/OLD-CONSULTATION-WORDS|Knee pain|90 %/)
  })
})

describe('important points against the record', () => {
  it('flags an allergy said while the record holds no allergy status, and one the record lists differently; a rejected point is set aside', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'I am allergic to penicillin.']], 0)
    const said = await point(c, tid, { category: 'allergy', text: 'Allergic to penicillin', substance: 'penicillin', flags: ['not_in_record'], when: at(4) })
    const rejected = await point(c, tid, { category: 'allergy', text: 'Allergic to sulfa', substance: 'sulfa', status: 'rejected', flags: ['not_in_record'], when: at(4, 10) })
    const out = await context(c.e.id)
    wellFormed(out)
    expect(out.conflicts).toEqual([
      {
        id: `allergy_status:${said}`,
        kind: 'allergy_status',
        text: 'Allergies were mentioned in the consultation (“Allergic to penicillin”), but the record has no allergy status: no allergy is recorded and “no known allergies” is not marked.',
        itemIds: [`point:${said}`],
        rule: 'context-conflicts-v2',
      },
    ])
    // A point the doctor rejected is set aside everywhere: not listed, not counted, not compared.
    expect(ofKind(out, 'point').map((x) => x.id)).toEqual([`point:${said}`])
    expect(JSON.stringify(out)).not.toContain(rejected)
    expect(JSON.stringify(out)).not.toContain('sulfa')
    expect(out.pending.points).toBe(1)

    // Once an allergy is on the record, the same point is compared with what the record says now.
    await call(ctx.app, 'POST', `/api/patients/${c.p.id}/allergies`, { cookie: nurse, body: { substance: 'Aspirin', severity: 'moderate' } })
    const later = await context(c.e.id)
    expect(later.conflicts.map((k) => k.kind)).toEqual(['point_vs_record'])
    expect(later.conflicts[0]!.text).toBe('Important point “Allergy: Allergic to penicillin” (Extracted draft) names an allergy that is not on the record; allergies on the record: Aspirin.')
    expect(section(later, 'patient')[0]).toEqual({ text: 'Allergies on the record: Aspirin (moderate).', trust: 'clinician_entered', itemIds: [] })
  })

  it('compares an allergy with the record as it is now: once the allergy said is recorded, nothing disagrees, whatever was flagged when it was extracted', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'I am allergic to penicillin.']], 0)
    await point(c, tid, { category: 'allergy', text: 'Allergic to penicillin', substance: 'penicillin', flags: ['not_in_record'], when: at(4) })
    expect((await context(c.e.id)).conflicts.map((k) => k.kind)).toEqual(['allergy_status'])
    await call(ctx.app, 'POST', `/api/patients/${c.p.id}/allergies`, { cookie: nurse, body: { substance: 'Penicillin', severity: 'severe' } })
    const out = await context(c.e.id)
    wellFormed(out)
    expect(out.conflicts).toEqual([])
  })

  it('does not judge an allergy point the doctor edited by what the extraction read in it; an unedited one is compared', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'I react to amoxicillin. No other allergies.']], 0)
    // Extracted as one substance, edited by the doctor to name the one on the record: not compared (the doctor wrote it against the record).
    await point(c, tid, { category: 'allergy', text: 'Allergic to amoxicillin', substance: 'amoxicillin', status: 'edited', finalText: 'Allergic to penicillin (rash)', flags: ['not_in_record'], when: at(4) })
    // Extracted as "no allergy", then edited to a sentence that names the recorded allergy: the extraction's "no allergy" is not held against it
    // (it would read as a disagreement with the record that the doctor's own words do not make).
    await point(c, tid, { category: 'allergy', text: 'No other allergies', negated: true, status: 'edited', finalText: 'No allergy other than penicillin', when: at(4, 10) })
    // Unedited and said to be no allergy while the record lists one: that disagreement is shown.
    const unedited = await point(c, tid, { category: 'allergy', text: 'No allergies', negated: true, status: 'pending', when: at(4, 20) })
    await call(ctx.app, 'POST', `/api/patients/${c.p.id}/allergies`, { cookie: nurse, body: { substance: 'Penicillin', severity: 'severe' } })
    const out = await context(c.e.id)
    wellFormed(out)
    expect(out.conflicts).toEqual([
      {
        id: `point_vs_record:${unedited}`,
        kind: 'point_vs_record',
        text: 'Important point “Allergy: No allergies” (Extracted draft) says there is no allergy; allergies on the record: Penicillin.',
        itemIds: [`point:${unedited}`],
        rule: 'context-conflicts-v2',
      },
    ])
  })

  it('names where the vital sign a point differs from came from, and never calls a device’s value measured', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'My oxygen was 95 at home.']], 0)
    const b = await band(c, { label: 'Band V', lastSeen: ago(5) })
    const reading = await deviceReading(c, b, 'spo2', 92, at(2))
    const fromDevice = await point(c, tid, { category: 'vital_sign', text: 'SpO2 95 %', flags: ['conflicts_with_record'], when: at(4) })
    const fromStaff = await point(c, tid, { category: 'vital_sign', text: 'Pulse 70', flags: ['conflicts_with_record'], when: at(4, 10) })
    const staff = await staffVital(c, 'heart_rate', 96, at(1))
    // As the record comparison stores it: its note says "Measured" whatever the value came from.
    await ctx.db.insert(aiEvidence).values([
      { subjectType: 'fact', subjectId: fromDevice, relation: 'conflicts', sourceType: 'observation', sourceId: reading, sourceRef: 'V1', provenance: 'device_measured', excerpt: 'SpO₂ 92 % measured at this visit by a device (unverified)', note: 'Measured 92 %; said 95 (difference above the configured 2).' },
      { subjectType: 'fact', subjectId: fromStaff, relation: 'conflicts', sourceType: 'observation', sourceId: staff, sourceRef: 'V2', provenance: 'staff_measured', excerpt: 'Heart rate 96 bpm measured at this visit', note: 'Measured 96 bpm; said 70 (difference above the configured 10).' },
    ])
    const out = await context(c.e.id)
    wellFormed(out)
    const text = (factId: string) => out.conflicts.find((k) => k.id === `point_vs_record:${factId}`)!.text
    expect(text(fromDevice)).toBe('Important point “Vital sign (mentioned): SpO2 95 %” (Extracted draft) was flagged by the record comparison when it was extracted: conflicts with the existing record. It differs from a vital sign a device (unverified) sent at this visit (see Devices).')
    expect(text(fromStaff)).toBe('Important point “Vital sign (mentioned): Pulse 70” (Extracted draft) was flagged by the record comparison when it was extracted: conflicts with the existing record. It differs from a vital sign entered by staff at this visit (see History).')
    expect(JSON.stringify([out.conflicts, out.summary])).not.toMatch(/Measured 9/)
  })

  it('shows a statement of the AI draft that its own checks marked conflicting', async () => {
    const c = await consultation()
    const d = await draft(c, { when: at(9), statements: [{ section: 'medications', text: 'Takes metformin 500 mg.', decision: 'pending', support: 'conflicting' }] })
    const out = await context(c.e.id)
    expect(out.conflicts).toEqual([{ id: `draft_conflict:${d.statementIds[0]}`, kind: 'draft_conflict', text: 'AI draft statement “Takes metformin 500 mg.” is marked “Conflicting”: the record items it rests on disagree.', itemIds: [`ai_draft:${d.id}`], rule: 'context-conflicts-v2' }])
  })
})

describe('audit', () => {
  it('records a look at most once per user and consultation in five minutes, with counts and never content', async () => {
    const c = await consultation({ reason: 'REASON-WORDS' })
    const tid = await transcript(c, [['Patient', 'AUDIT-TRANSCRIPT-WORDS']], 0)
    await point(c, tid, { category: 'symptom', text: 'AUDIT-POINT-WORDS', when: at(4) })
    await context(c.e.id)
    await context(c.e.id)
    await context(c.e.id, nurse)
    const { rows } = await adminQuery("SELECT actor_user_id, entity_id, patient_id, details FROM audit_events WHERE action = 'encounter.context_viewed' ORDER BY id")
    expect(rows.map((r) => r.actor_user_id)).toEqual([fx.users.doctor, fx.users.nurse])
    expect(rows.every((r) => r.entity_id === c.e.id && r.patient_id === c.p.id)).toBe(true)
    expect(rows[0].details).toMatchObject({ kinds: { transcript: 1, point: 1 }, repeatsNotLoggedForSeconds: 300 })
    expect(JSON.stringify(rows)).not.toMatch(/REASON-WORDS|AUDIT-TRANSCRIPT-WORDS|AUDIT-POINT-WORDS/)
  })

  it('spends the five minutes only on a look that was recorded: when the audit row cannot be written, the read fails and the next one is audited', async () => {
    const c = await consultation()
    // The audit log refuses this one action for a moment (a stand-in for a failed write).
    await adminQuery(`CREATE FUNCTION test_refuse_context_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stubbed: the audit log cannot be written'; END $$;
      CREATE TRIGGER test_refuse_context_audit BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = 'encounter.context_viewed') EXECUTE FUNCTION test_refuse_context_audit()`)
    try {
      expect((await call(ctx.app, 'GET', `/api/encounters/${c.e.id}/context`, { cookie: doctor })).statusCode).toBe(500)
    } finally {
      await adminQuery('DROP TRIGGER IF EXISTS test_refuse_context_audit ON audit_events; DROP FUNCTION IF EXISTS test_refuse_context_audit()')
    }
    await context(c.e.id)
    await context(c.e.id)
    const { rows } = await adminQuery("SELECT actor_user_id FROM audit_events WHERE action = 'encounter.context_viewed' AND entity_id = $1", [c.e.id])
    expect(rows.map((r) => r.actor_user_id)).toEqual([fx.users.doctor])
  })
})

describe('what waits for the doctor', () => {
  it('is counted in full, beyond the newest few that are listed', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'Many things.']], 0)
    const run = await extraction(c, tid)
    await ctx.db.insert(clinicalFacts).values(Array.from({ length: 42 }, (_, n) => pointValues(c, tid, run, { category: 'symptom', text: `Point ${n}`, when: at(1, n) })))
    for (let n = 0; n < 11; n++) await thermal(c, { when: at(2, n) })
    const out = await context(c.e.id)
    wellFormed(out)
    expect(ofKind(out, 'point')).toHaveLength(40)
    expect(ofKind(out, 'thermal')).toHaveLength(10)
    expect(out.pending).toEqual({ points: 42, draftStatements: 0, thermalImages: 11, thermalSummaries: 0, unread: [] })
    expect(section(out, 'review').map((s) => s.text)).toEqual(expect.arrayContaining(['To review: 42 important points.', 'To review: 11 thermal images.']))
  })

  it('states a point the doctor confirmed even when more than the listed number of newer points wait', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'Many things.']], 0)
    const run = await extraction(c, tid)
    await ctx.db.insert(clinicalFacts).values(pointValues(c, tid, run, { category: 'symptom', text: 'Cough for three days', status: 'accepted', when: at(0, 30) }))
    await ctx.db.insert(clinicalFacts).values(Array.from({ length: 41 }, (_, n) => pointValues(c, tid, run, { category: 'symptom', text: `Point ${n}`, when: at(1, n) })))
    const out = await context(c.e.id)
    wellFormed(out)
    // The 40 newest are listed (all waiting), and the confirmed one too, read on its own, since the summary states it.
    expect(ofKind(out, 'point')).toHaveLength(41)
    expect(ofKind(out, 'point').filter((p) => p.status === 'Doctor confirmed').map((p) => p.title)).toEqual(['Symptom: “Cough for three days”'])
    expect(section(out, 'presentation').map((s) => s.text)).toContain('Symptom: “Cough for three days” (an important point confirmed by the doctor).')
  })

  it('says a point a model found is AI output, to review', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'Cough.']], 0)
    const byModel = await point(c, tid, { category: 'symptom', text: 'Cough', provider: 'llama.cpp', when: at(4) })
    const out = await context(c.e.id)
    expect(item(out, `point:${byModel}`)).toMatchObject({ status: 'Extracted draft', trust: 'model_output' })
    expect(section(out, 'ai').find((s) => s.text.startsWith('1 extracted important point waits'))!.trust).toBe('model_output')
  })

  it('shows the draft the doctor reviews however many attempts came after it, and says why none is shown from the newest attempt', async () => {
    const c = await consultation()
    const d = await draft(c, { when: at(5), version: 1, statements: [{ section: 'symptoms', text: 'Cough.', decision: 'pending' }] })
    for (let v = 2; v <= 12; v++) await draft(c, { when: at(5, v), version: v, status: 'failed' })
    const out = await context(c.e.id)
    wellFormed(out)
    expect(item(out, `ai_draft:${d.id}`)).toMatchObject({ title: 'AI draft: 1 statement', status: 'To review' })
    expect(out.pending.draftStatements).toBe(1)
    expect(out.missing.some((m) => m.startsWith('No AI draft'))).toBe(false)
  })
})

describe('a thermal image that is not a live capture', () => {
  it('says how it arrived before its numbers, and that its date is not known when the camera gave none', async () => {
    const c = await consultation()
    // A camera that reports no model name ("*") is not named.
    const imported = await thermal(c, { when: at(7), approved: true, source: 'gallery_import', capturedAt: null, cameraModel: '*' })
    const uploaded = await thermal(c, { when: at(8), approved: true, source: 'file_upload', capturedAt: at(-10) })
    const out = await context(c.e.id)
    wellFormed(out)
    expect(item(out, `thermal:${imported.id}`)).toMatchObject({ source: 'Thermal camera (imported)', detail: 'Imported · imported at 10:37; date taken not known · radiometric · 2 regions · model unavailable', at: at(7).toISOString() })
    expect(item(out, `thermal:${uploaded.id}`)).toMatchObject({ source: 'FLIR ONE Pro (uploaded file)', detail: 'Uploaded file · radiometric · 2 regions · model unavailable', at: at(-10).toISOString() })
    const thermalStatements = section(out, 'observations').filter((s) => s.itemIds.some((id) => id.startsWith('thermal:')))
    // Newest first, as the images are read.
    expect(thermalStatements.map((s) => [s.itemIds[0], s.text.split(' Thermal image of ')[0]])).toEqual([
      [`thermal:${uploaded.id}`, 'UPLOADED: an image file chosen on the thermal pages, dated 5 Oct 2026, 10:20 by the camera.'],
      [`thermal:${imported.id}`, 'IMPORTED: an earlier image chosen from the device, date taken not known.'],
    ])
    expect(thermalStatements.every((s) => s.trust === 'measured' && s.text.endsWith('Skin-surface temperature only.'))).toBe(true)
  })
})

describe('a source that cannot be read', () => {
  it('is left out with a line that says so, and everything else is still there', async () => {
    const c = await consultation()
    await thermal(c, { when: at(7), approved: true })
    const vital = await staffVital(c, 'spo2', 98, at(10))
    const rec = await stethoscope(c, at(6))
    const failed: string[] = []
    const out = await buildConsultationContext({ db: failingOn(ctx.db, thermalCaptures), settings: generous, config: testConfig, onSourceError: (s) => failed.push(s) }, me(), c.e.id, { now: NOW })
    expect(failed).toEqual(['thermal'])
    expect(ofKind(out, 'thermal')).toEqual([])
    expect(out.missing).toContain('The thermal images could not be read just now; they are left out.')
    expect(out.missing).not.toContain('No thermal image in this consultation (for information; not required).')
    expect(out.evidence.map((x) => x.id)).toEqual([`vital_staff:${vital}`, `stethoscope:${rec}`])
    expect(section(out, 'review').map((s) => s.text)).toContain('The thermal images could not be read just now; they are left out.')
    // Its count of images to review is not "none": it is said not to be known.
    expect(out.pending).toEqual({ points: 0, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: ['thermalImages'] })
    expect(section(out, 'observations').map((s) => s.text).at(-1)).toBe('The thermal images could not be read just now; they are not stated here.')
    expect(ConsultationContext.safeParse(out).success).toBe(true)
  })

  it('never says that nothing is confirmed, recorded or accepted when the points, the vital signs or the AI draft could not be read', async () => {
    const c = await consultation()
    const tid = await transcript(c, [['Patient', 'Cough.']], 0)
    await point(c, tid, { category: 'symptom', text: 'Cough', status: 'accepted', when: at(4) })
    await point(c, tid, { category: 'symptom', text: 'Fever', when: at(4, 10) })
    await staffVital(c, 'spo2', 98, at(10))
    await deviceReading(c, await band(c, { label: 'Band U', lastSeen: ago(5) }), 'heart_rate', 80, ago(10))
    await draft(c, {
      when: at(9),
      statements: [
        { section: 'symptoms', text: 'Cough.', decision: 'accepted' },
        { section: 'symptoms', text: 'Fever.', decision: 'pending' },
      ],
    })
    const unreadable = async (table: unknown) => {
      const failed: string[] = []
      const out = await buildConsultationContext({ db: failingOn(ctx.db, table), settings: generous, config: testConfig, onSourceError: (s) => failed.push(s) }, me(), c.e.id, { now: NOW })
      expect(ConsultationContext.safeParse(out).success).toBe(true)
      expect(allStatements(out).filter((s) => ABSENT.test(s.text))).toEqual([])
      return { out, failed }
    }

    const points = await unreadable(clinicalFacts)
    expect(points.failed).toEqual(['points'])
    expect(points.out.pending).toEqual({ points: 0, draftStatements: 1, thermalImages: 0, thermalSummaries: 0, unread: ['points'] })
    expect(section(points.out, 'presentation').map((s) => s.text)).toEqual(['Reason for visit (as entered at check-in): “Cough and fever”.', 'The important points could not be read just now; no confirmed point is stated here.'])

    const drafts = await unreadable(consultationDrafts)
    expect(drafts.failed).toEqual(['drafts'])
    expect(drafts.out.pending).toEqual({ points: 1, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: ['draftStatements'] })
    expect(section(drafts.out, 'ai').map((s) => s.text)).toContain('The AI draft could not be read just now; nothing of it is stated here.')
    expect(drafts.out.missing.some((m) => m.startsWith('No AI draft'))).toBe(false)

    const vitals = await unreadable(observations)
    expect(vitals.failed).toEqual(expect.arrayContaining(['staffVitals', 'devices']))
    expect(section(vitals.out, 'observations').map((s) => s.text)).toEqual(['The vital signs entered by staff and the device readings could not be read just now; they are not stated here.'])
    expect(vitals.out.missing).not.toContain('Vital signs not recorded by staff at this visit.')
  })
})

/** The database, except that any read from `table` fails (a source that is down), as a stand-in for a failure of one query. */
function failingOn(db: Db, table: unknown): Db {
  const wrap = <T extends object>(builder: T): T =>
    new Proxy(builder, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown
        if (prop === 'from') {
          return (source: unknown, ...rest: unknown[]) => {
            if (source === table) throw new Error('stubbed: this source cannot be read')
            return (value as (...args: unknown[]) => unknown).apply(target, [source, ...rest])
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (prop === 'select' || prop === 'selectDistinct' || prop === 'selectDistinctOn') return (...args: unknown[]) => wrap((value as (...a: unknown[]) => object).apply(target, args))
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
