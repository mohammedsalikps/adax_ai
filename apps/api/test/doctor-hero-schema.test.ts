import crypto from 'node:crypto'
import {
  compareDoctorQueueRows,
  countDoctorQueue,
  CURRENT_ENCOUNTER_HASH_SCHEME,
  DocumentUploadFields,
  doctorDayRange,
  doctorQueuePill,
  doctorQueueStatus,
  Encounter,
  ENCOUNTER_HASH_SCHEMES,
  HandwritingDocument,
  medicineCourse,
  medicineCourseLabel,
  PatientDetail,
  PrescriptionItemInput,
  SERVICE_CODE_PATTERN,
  SIMULATED_LAB_REPORT_TEXT,
  SIMULATED_REPORT_TEXT,
  simulatedOrderSchedule,
  simulatedOrderStatusAt,
  TriageNoteRequest,
  Visit,
  weekStartIso,
} from '@adaxai/contracts'
import type pg from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { files } from '../src/db/schema.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { AppSettings } from '../src/settings/schema.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

/**
 * Doctor HERO final, foundation: the shared contracts' pure rules, the service catalogue setting, and what migration 0033's tables, checks and
 * triggers allow the application role to do (the feature routes are tested by their own units).
 */

describe('the doctor’s day vocabulary (contracts doctorDay.ts)', () => {
  it('one status per row: a visit decides, otherwise the appointment; cancelled rows are not counted', () => {
    const cases: [Parameters<typeof doctorQueueStatus>[0], string][] = [
      [{ appointmentStatus: 'booked' }, 'yet_to_see'],
      [{ appointmentStatus: 'checked_in' }, 'waiting'],
      [{ appointmentStatus: 'completed' }, 'completed'],
      [{ appointmentStatus: 'cancelled' }, 'cancelled'],
      [{ appointmentStatus: 'rescheduled' }, 'cancelled'],
      [{ appointmentStatus: 'no_show' }, 'cancelled'],
      [{ visitStatus: 'waiting', appointmentStatus: 'checked_in' }, 'waiting'],
      [{ visitStatus: 'in_triage' }, 'waiting'],
      [{ visitStatus: 'ready' }, 'waiting'],
      [{ visitStatus: 'in_consultation', encounterStatus: 'in_progress' }, 'in_consultation'],
      [{ visitStatus: 'in_consultation', encounterStatus: 'signed' }, 'in_consultation'],
      [{ visitStatus: 'completed', appointmentStatus: 'checked_in' }, 'completed'],
      [{ visitStatus: 'cancelled' }, 'cancelled'],
      [{ visitStatus: 'no_show' }, 'cancelled'],
      [{}, 'cancelled'],
    ]
    for (const [row, want] of cases) expect([row, doctorQueueStatus(row)]).toEqual([row, want])
    expect(doctorQueuePill({ visitStatus: 'in_consultation', encounterStatus: 'signed' })).toBe('signed_to_complete')
    expect(doctorQueuePill({ visitStatus: 'in_consultation', encounterStatus: 'in_progress' })).toBe('in_consultation')
    expect(doctorQueuePill({ visitStatus: 'completed', encounterStatus: 'signed' })).toBe('completed')
    expect(countDoctorQueue(['completed', 'completed', 'waiting', 'in_consultation', 'yet_to_see', 'yet_to_see', 'cancelled'])).toEqual({ seen: 2, waiting: 1, inConsultation: 1, yetToSee: 2, total: 6 })
    expect(countDoctorQueue([])).toEqual({ seen: 0, waiting: 0, inConsultation: 0, yetToSee: 0, total: 0 })
  })

  it('time order: the appointment time when there is one, else the check-in time; rows without a time last; ties by name', () => {
    const rows = [
      { key: 'c', patient: { fullName: 'C' }, scheduledAt: null, checkedInAt: null },
      { key: 'b', patient: { fullName: 'B' }, scheduledAt: '2026-10-06T04:30:00.000Z', checkedInAt: '2026-10-06T03:00:00.000Z' },
      { key: 'a', patient: { fullName: 'A' }, scheduledAt: null, checkedInAt: '2026-10-06T04:00:00.000Z' },
      { key: 'd', patient: { fullName: 'D' }, scheduledAt: null, checkedInAt: '2026-10-06T09:30:00+05:30' },
    ]
    expect([...rows].sort(compareDoctorQueueRows).map((r) => r.key)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('periods on the facility calendar: Monday-first weeks and the month to date, every day listed', () => {
    // 6 Oct 2026 is a Tuesday.
    expect(weekStartIso('2026-10-06')).toBe('2026-10-05')
    expect(weekStartIso('2026-10-05')).toBe('2026-10-05')
    expect(weekStartIso('2026-10-04')).toBe('2026-09-28')
    expect(doctorDayRange('today', '2026-10-06')).toEqual({ from: '2026-10-06', to: '2026-10-06', days: ['2026-10-06'] })
    expect(doctorDayRange('week', '2026-10-06')).toEqual({ from: '2026-10-05', to: '2026-10-06', days: ['2026-10-05', '2026-10-06'] })
    expect(doctorDayRange('month', '2026-10-06').days).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'])
    expect(doctorDayRange('week', '2026-03-01').from).toBe('2026-02-23')
  })
})

describe('medicine courses and the encounter contract additions', () => {
  it('a 21-day course reads Day 1 of 21 · 20 days left … Day 21 of 21 · Completed, then Completed; no duration is never "completed"', () => {
    const item = { durationDays: 21, startDate: '2026-10-01' }
    expect(medicineCourse(item, '2026-10-01')).toEqual({ state: 'active', day: 1, totalDays: 21, daysLeft: 20, startDate: '2026-10-01', endDate: '2026-10-21' })
    expect(medicineCourseLabel(medicineCourse(item, '2026-10-01'))).toBe('Day 1 of 21 · 20 days left')
    expect(medicineCourseLabel(medicineCourse(item, '2026-10-20'))).toBe('Day 20 of 21 · 1 day left')
    expect(medicineCourseLabel(medicineCourse(item, '2026-10-21'), '2026-10-21')).toBe('Day 21 of 21 · Completed')
    expect(medicineCourse(item, '2026-11-30')).toMatchObject({ state: 'completed', day: 21, daysLeft: 0 })
    expect(medicineCourseLabel(medicineCourse(item, '2026-11-30'), '2026-11-30')).toBe('Completed')
    expect(medicineCourse(item, '2026-09-30')).toMatchObject({ state: 'not_started', day: null, daysLeft: 21 })
    // Across a month end and a leap day.
    expect(medicineCourse({ durationDays: 7, startDate: '2028-02-26' }, '2028-03-01')).toMatchObject({ state: 'active', day: 5, endDate: '2028-03-03' })
    for (const legacy of [{}, { durationDays: null, startDate: '2026-10-01' }, { durationDays: 5, startDate: null }]) {
      const c = medicineCourse(legacy, '2026-10-06')
      expect([c.state, medicineCourseLabel(c)]).toEqual(['duration_not_recorded', 'Duration not recorded'])
    }
  })

  it('medicines may carry a structured duration and start date; earlier drafts without them still parse', () => {
    expect(PrescriptionItemInput.parse({ drugName: 'Amoxicillin', dose: '500 mg', frequency: 'TDS', duration: '5 days', durationDays: 5, startDate: '2026-10-06' })).toMatchObject({ durationDays: 5, startDate: '2026-10-06' })
    expect(PrescriptionItemInput.parse({ drugName: 'Paracetamol' }).durationDays).toBeUndefined()
    expect(PrescriptionItemInput.safeParse({ durationDays: 0 }).success).toBe(false)
    expect(PrescriptionItemInput.safeParse({ durationDays: 3651 }).success).toBe(false)
    expect(PrescriptionItemInput.safeParse({ startDate: '06-10-2026' }).success).toBe(false)
    // Signing switched to v3 together with verify.ts (deliberate change, encounters unit); v1 and v2 stay listed so older records still verify.
    expect(ENCOUNTER_HASH_SCHEMES).toEqual(['adaxai.encounter.v1', 'adaxai.encounter.v2', 'adaxai.encounter.v3'])
    expect(CURRENT_ENCOUNTER_HASH_SCHEME).toBe('adaxai.encounter.v3')
    expect(TriageNoteRequest.parse({ note: '  ' }).note).toBeNull()
    expect(TriageNoteRequest.safeParse({ note: 'x'.repeat(1001) }).success).toBe(false)
  })

  it('documents and handwriting contracts refuse what the database would', () => {
    expect(DocumentUploadFields.parse({ category: 'lab_report', title: 'CBC', modality: '', studyDate: '', encounterId: '' })).toMatchObject({ category: 'lab_report', title: 'CBC', modality: undefined, studyDate: undefined, encounterId: undefined })
    expect(DocumentUploadFields.safeParse({ category: 'lab_report', title: 'CBC', modality: 'mri' }).success).toBe(false)
    expect(DocumentUploadFields.parse({ category: 'imaging_report', title: 'MRI brain', modality: 'mri', studyDate: '2026-09-21' }).modality).toBe('mri')
    const doc = { format: 1, page: { width: 1000, height: 1414 }, pageCount: 1, strokes: [{ page: 0, width: 2, color: '#1f2937', input: 'pen', points: [10, 10, 0.5, 20.5, 30, 0.6] }] }
    expect(HandwritingDocument.safeParse(doc).success).toBe(true)
    expect(HandwritingDocument.safeParse({ ...doc, strokes: [{ ...doc.strokes[0], points: [10, 10] }] }).success).toBe(false)
    expect(HandwritingDocument.safeParse({ ...doc, strokes: [{ ...doc.strokes[0], points: [1001, 10, 0.5] }] }).success).toBe(false)
    expect(HandwritingDocument.safeParse({ ...doc, strokes: [{ ...doc.strokes[0], page: 1 }] }).success).toBe(false)
  })
})

describe('the service catalogue and the simulated provider', () => {
  it('the committed catalogue is valid, uses only simulated orders, and refuses duplicates and unknown keys', () => {
    const s = loadAppSettings()
    expect(s.serviceOrders.provider).toBe('simulated')
    expect(s.serviceOrders.catalogue.length).toBeGreaterThan(0)
    expect(s.serviceOrders.catalogue.map((c) => c.code)).toContain('CBC')
    for (const c of s.serviceOrders.catalogue) expect(SERVICE_CODE_PATTERN.test(c.code), c.code).toBe(true)
    const dup = AppSettings.safeParse({ ...s, serviceOrders: { ...s.serviceOrders, catalogue: [...s.serviceOrders.catalogue, s.serviceOrders.catalogue[0]] } })
    expect([dup.success, dup.error?.issues[0]?.path.join('.')]).toEqual([false, 'serviceOrders.catalogue'])
    expect(AppSettings.safeParse({ ...s, serviceOrders: { ...s.serviceOrders, provider: 'acme-lab' } }).success).toBe(false)
    expect(AppSettings.safeParse({ ...s, serviceOrders: { ...s.serviceOrders, catalogue: [{ ...s.serviceOrders.catalogue[0], price: 1 }] } }).success).toBe(false)
  })

  it('moves an order on a fixed schedule from its request, and its report only says that nothing was performed', () => {
    const o = { requestedAt: '2026-10-06T04:00:00.000Z', turnaroundMinutes: 30 }
    expect(simulatedOrderSchedule(o)).toEqual({ inProgressAt: new Date('2026-10-06T04:01:00.000Z'), completedAt: new Date('2026-10-06T04:30:00.000Z') })
    const at = (iso: string) => simulatedOrderStatusAt({ ...o, status: 'requested' }, new Date(iso))
    expect([at('2026-10-06T04:00:59Z'), at('2026-10-06T04:01:00Z'), at('2026-10-06T04:29:59Z'), at('2026-10-06T04:30:00Z')]).toEqual(['requested', 'in_progress', 'in_progress', 'completed'])
    expect(simulatedOrderStatusAt({ ...o, status: 'cancelled' }, Date.parse('2026-10-07T00:00:00Z'))).toBe('cancelled')
    expect(SIMULATED_LAB_REPORT_TEXT).toBe('Simulated laboratory: no test was performed and no result values exist.')
    for (const t of Object.values(SIMULATED_REPORT_TEXT)) expect(t.startsWith('Simulated ')).toBe(true)
  })
})

describe('migration 0033 in the database', () => {
  const ctx = createTestApp()
  let fx: Fixture
  beforeEach(async () => {
    await resetDatabase()
    fx = await createFixture(ctx.db)
  })
  afterAll(() => ctx.close())

  const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params)
  const code = async (p: Promise<unknown>) => {
    try {
      await p
      return 'ok'
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown'
    }
  }

  async function consultation() {
    const nurse = await login(ctx.app, 't.nurse')
    const doctor = await login(ctx.app, 't.doctor')
    const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ phone: `98${crypto.randomInt(10_000_000, 99_999_999)}`, confirmNotDuplicate: true }) })).json())
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    const sign = async () => {
      const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { version: e.version, note: { ...e.note, chiefComplaint: 'Cough', assessment: 'Viral', plan: 'Fluids' }, diagnoses: [{ description: 'Viral URTI', kind: 'provisional' }], prescription: [] } })).json())
      expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    }
    return { p, v, e, sign }
  }
  const fileOf = async (patientId: string, encounterId: string | null, kind: string, mimeType = 'application/json') =>
    (await ctx.db.insert(files).values({ facilityId: fx.facilityId, patientId, encounterId, kind, storageKey: `test/${crypto.randomUUID()}`, mimeType, sizeBytes: 10, sha256: '0'.repeat(64), uploadedBy: fx.users.doctor }).returning())[0]!

  it('service orders: placed and moved only forward, history written by the database, simulated reports only, never deleted', async () => {
    const { p, v, e } = await consultation()
    const other = await consultation()
    const insert = (over: Record<string, unknown> = {}) => {
      const row = { facility_id: fx.facilityId, patient_id: p.id, visit_id: v.id, encounter_id: e.id, ordered_by: fx.users.doctor, service_code: 'CBC', service_name: 'Complete blood count (CBC)', category: 'lab', simulated: true, turnaround_minutes: 30, data_origin: 'synthetic', ...over }
      const cols = Object.keys(row)
      return q(`INSERT INTO service_orders (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, requested_at`, Object.values(row))
    }
    // Belongs to its consultation's patient and visit; starts as requested; simulated exactly for the simulated provider.
    expect(await code(insert({ patient_id: other.p.id }))).toBe('23514')
    expect(await code(insert({ visit_id: other.v.id }))).toBe('23514')
    expect(await code(insert({ status: 'completed', completed_at: new Date(), report_text: SIMULATED_LAB_REPORT_TEXT }))).toBe('23514')
    expect(await code(insert({ simulated: false }))).toBe('23514')
    expect(await code(insert({ category: 'surgery' }))).toBe('23514')
    const { rows } = await insert()
    const id = rows[0].id as string
    const requestedAt = new Date(rows[0].requested_at as Date)
    const plus = (min: number) => new Date(requestedAt.getTime() + min * 60_000)

    // Forward only, in time order; a step changes only the progress columns; a completed simulated order says it is simulated.
    expect(await code(q("UPDATE service_orders SET status = 'completed', completed_at = $2, status_changed_at = $2, report_text = $3 WHERE id = $1", [id, plus(30), SIMULATED_LAB_REPORT_TEXT]))).toBe('AX009')
    expect(await code(q("UPDATE service_orders SET status = 'in_progress', status_changed_at = $2 WHERE id = $1", [id, plus(-5)]))).toBe('AX009')
    expect(await code(q("UPDATE service_orders SET status = 'in_progress', status_changed_at = $2, service_code = 'CRP' WHERE id = $1", [id, plus(1)]))).toBe('AX009')
    expect(await code(q("UPDATE service_orders SET note = 'changed' WHERE id = $1", [id]))).toBe('AX009')
    expect(await code(q("UPDATE service_orders SET status = 'in_progress', status_changed_at = $2 WHERE id = $1", [id, plus(1)]))).toBe('ok')
    expect(await code(q("UPDATE service_orders SET status = 'requested', status_changed_at = $2 WHERE id = $1", [id, plus(2)]))).toBe('AX009')
    expect(await code(q("UPDATE service_orders SET status = 'completed', completed_at = $2, status_changed_at = $2 WHERE id = $1", [id, plus(30)]))).toBe('23514')
    expect(await code(q("UPDATE service_orders SET status = 'completed', completed_at = $2, status_changed_at = $2, report_text = 'Haemoglobin 13.2 g/dL' WHERE id = $1", [id, plus(30)]))).toBe('23514')
    expect(await code(q("UPDATE service_orders SET status = 'completed', completed_at = $2, status_changed_at = $2, report_text = $3 WHERE id = $1", [id, plus(30), SIMULATED_LAB_REPORT_TEXT]))).toBe('ok')
    // Closed for good.
    expect(await code(q("UPDATE service_orders SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1", [id, fx.users.doctor]))).toBe('AX009')
    expect(await code(q('UPDATE service_orders SET report_text = $2 WHERE id = $1', [id, 'Simulated something else']))).toBe('AX009')
    expect(await code(q('DELETE FROM service_orders WHERE id = $1', [id]))).toBe('AX009')

    // Cancelling an open order needs who; the history says who placed and who cancelled, and which steps the simulator made.
    const second = (await insert({ service_code: 'XRAY-CHEST', service_name: 'Chest X-ray (PA view)', category: 'imaging', turnaround_minutes: 45 })).rows[0].id as string
    expect(await code(q("UPDATE service_orders SET status = 'cancelled', cancelled_at = now(), status_changed_at = now() WHERE id = $1", [second]))).toBe('23514')
    expect(await code(q("UPDATE service_orders SET status = 'cancelled', cancelled_at = now(), status_changed_at = now(), cancelled_by = $2, cancel_reason = 'Not needed' WHERE id = $1", [second, fx.users.doctor]))).toBe('ok')
    const events = (await q('SELECT order_id, from_status, to_status, source, actor_user_id, at FROM service_order_events ORDER BY id')).rows
    expect(events.map((x) => `${x.order_id === id ? 1 : 2}:${x.from_status ?? '-'}>${x.to_status}:${x.source}:${x.actor_user_id === fx.users.doctor ? 'doctor' : '-'}`)).toEqual([
      '1:->requested:doctor:doctor',
      '1:requested>in_progress:simulated_lab:-',
      '1:in_progress>completed:simulated_lab:-',
      '2:->requested:doctor:doctor',
      '2:requested>cancelled:doctor:doctor',
    ])
    // A simulated step carries the time its schedule gives, not the time it was applied.
    expect(new Date(events[2].at as Date).toISOString()).toBe(plus(30).toISOString())
    expect(await code(q("UPDATE service_order_events SET source = 'doctor'"))).toBe('42501')
    expect(await code(q('DELETE FROM service_order_events'))).toBe('42501')
  })

  it('patient documents: the file is the patient’s, content is fixed, entered in error is final, nothing is deleted', async () => {
    const { p, e } = await consultation()
    const other = await consultation()
    const ownFile = await fileOf(p.id, null, 'patient_document', 'application/pdf')
    const insert = (over: Record<string, unknown> = {}) => {
      const row = { facility_id: fx.facilityId, patient_id: p.id, encounter_id: e.id, category: 'imaging_report', modality: 'mri', title: 'MRI brain', study_date: '2026-09-21', file_id: ownFile.id, mime_type: 'application/pdf', uploaded_by: fx.users.nurse, data_origin: 'synthetic', ...over }
      const cols = Object.keys(row)
      return q(`INSERT INTO patient_documents (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(row))
    }
    expect(await code(insert({ file_id: (await fileOf(other.p.id, null, 'patient_document', 'application/pdf')).id }))).toBe('23514')
    expect(await code(insert({ encounter_id: other.e.id }))).toBe('23514')
    expect(await code(insert({ category: 'lab_report' }))).toBe('23514')
    expect(await code(insert({ mime_type: 'application/zip' }))).toBe('23514')
    expect(await code(insert({ status: 'entered_in_error', status_reason: 'Wrong patient' }))).toBe('23514')
    const id = (await insert()).rows[0].id as string
    expect(await code(insert({ title: 'Again' }))).toBe('23505')
    expect(await code(q("UPDATE patient_documents SET title = 'CT head' WHERE id = $1", [id]))).toBe('AX008')
    expect(await code(q("UPDATE patient_documents SET status = 'entered_in_error' WHERE id = $1", [id]))).toBe('23514')
    expect(await code(q("UPDATE patient_documents SET status = 'entered_in_error', status_reason = 'Wrong patient', updated_at = now() WHERE id = $1", [id]))).toBe('ok')
    expect(await code(q("UPDATE patient_documents SET status = 'recorded' WHERE id = $1", [id]))).toBe('AX008')
    expect(await code(q('DELETE FROM patient_documents WHERE id = $1', [id]))).toBe('AX008')
  })

  it('surgeries are history entries: fixed content, final error mark, recorded in the history events', async () => {
    const { p } = await consultation()
    const insert = (over: Record<string, unknown> = {}) => {
      const row = { patient_id: p.id, name: 'Appendectomy', performed_year: 2022, entered_by: fx.users.doctor, data_origin: 'synthetic', ...over }
      const cols = Object.keys(row)
      return q(`INSERT INTO patient_procedures (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(row))
    }
    expect(await code(insert({ performed_year: null, performed_month: 4 }))).toBe('23514')
    expect(await code(insert({ performed_year: 1850 }))).toBe('23514')
    const id = (await insert()).rows[0].id as string
    expect(await code(insert({ name: 'APPENDECTOMY' }))).toBe('23505')
    expect(await code(insert({ performed_year: null }))).toBe('ok')
    expect(await code(q("UPDATE patient_procedures SET name = 'Cholecystectomy' WHERE id = $1", [id]))).toBe('AX008')
    expect(await code(q("UPDATE patient_procedures SET status = 'entered_in_error', status_reason = 'Wrong patient' WHERE id = $1", [id]))).toBe('ok')
    expect(await code(q("UPDATE patient_procedures SET status = 'recorded', status_reason = null WHERE id = $1", [id]))).toBe('AX008')
    expect(await code(q('DELETE FROM patient_procedures WHERE id = $1', [id]))).toBe('AX008')
    for (const [entity, want] of [['procedure', 'ok'], ['document', 'ok'], ['surgery', '23514']] as const) {
      expect([entity, await code(q("INSERT INTO patient_history_events (patient_id, entity_type, entity_id, action, to_status, actor_user_id) VALUES ($1, $2, $3, 'created', 'recorded', $4)", [p.id, entity, id, fx.users.doctor]))]).toEqual([entity, want])
    }
  })

  it('handwriting: consecutive versions of the draft’s own strokes file, append-only, refused once the record is signed', async () => {
    const { p, e, sign } = await consultation()
    const other = await consultation()
    const save = async (version: number, fileId?: string) =>
      code(q('INSERT INTO encounter_handwriting (encounter_id, patient_id, version, strokes_file_id, stroke_count, page_count, created_by) VALUES ($1, $2, $3, $4, 3, 1, $5)', [e.id, p.id, version, fileId ?? (await fileOf(p.id, e.id, 'handwriting_strokes')).id, fx.users.doctor]))
    expect(await save(1, (await fileOf(p.id, other.e.id, 'handwriting_strokes')).id)).toBe('23514')
    expect(await save(1, (await fileOf(p.id, null, 'handwriting_strokes')).id)).toBe('23514')
    expect(await code(q('INSERT INTO encounter_handwriting (encounter_id, patient_id, version, strokes_file_id, stroke_count, page_count, created_by) VALUES ($1, $2, 1, $3, 3, 1, $4)', [e.id, other.p.id, (await fileOf(other.p.id, e.id, 'handwriting_strokes')).id, fx.users.doctor]))).toBe('23514')
    expect(await save(2)).toBe('23505')
    expect(await save(1)).toBe('ok')
    expect(await save(1)).toBe('23505')
    expect(await save(2)).toBe('ok')
    expect(await code(q('UPDATE encounter_handwriting SET stroke_count = 0'))).toBe('42501')
    expect(await code(q('DELETE FROM encounter_handwriting'))).toBe('42501')
    await sign()
    expect(await save(3)).toBe('42501')
    expect((await q('SELECT version FROM encounter_handwriting WHERE encounter_id = $1 ORDER BY version', [e.id])).rows.map((r) => r.version)).toEqual([1, 2])
  })

  it('a visit whose consultation is signed cannot go back to the queue; it can only be completed', async () => {
    const { v, sign } = await consultation()
    await sign()
    // Whatever signing does to the visit, put it back with the doctor (as signing leaves it once Complete is separate).
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET status = 'in_consultation' WHERE id = '${v.id}'`)
    const move = async (to: string) => {
      const c: pg.PoolClient = await ctx.pool.connect()
      try {
        await c.query('BEGIN')
        await c.query("SELECT set_config('adaxai.actor_id', $1, true), set_config('adaxai.source', 'consultation_completed', true)", [fx.users.doctor])
        return await code(c.query('UPDATE visits SET status = $2 WHERE id = $1', [v.id, to]))
      } finally {
        await c.query('ROLLBACK')
        c.release()
      }
    }
    expect(await move('ready')).toBe('AX003')
    expect(await move('cancelled')).toBe('AX003')
    expect(await move('completed')).toBe('ok')
  })

  it('new columns: the triage note says who and when, a medicine’s duration is bounded, and the new append-only tables are registered', async () => {
    const { v, e } = await consultation()
    expect(await code(q("UPDATE visits SET triage_note = 'Fever since Monday' WHERE id = $1", [v.id]))).toBe('23514')
    expect(await code(q("UPDATE visits SET triage_note = $2, triage_note_by = $3, triage_note_at = now() WHERE id = $1", [v.id, 'x'.repeat(1001), fx.users.nurse]))).toBe('23514')
    expect(await code(q("UPDATE visits SET triage_note = 'Fever since Monday', triage_note_by = $2, triage_note_at = now() WHERE id = $1", [v.id, fx.users.nurse]))).toBe('ok')
    const rx = (days: number | null) => code(q("INSERT INTO prescription_items (encounter_id, drug_name, dose, frequency, duration, duration_days, start_date) VALUES ($1, 'Amoxicillin', '500 mg', 'TDS', '5 days', $2, '2026-10-06')", [e.id, days]))
    expect([await rx(0), await rx(3651), await rx(5), await rx(null)]).toEqual(['23514', '23514', 'ok', 'ok'])
    const registered = (await adminQuery('SELECT table_name FROM meta.append_only_tables')).rows.map((r) => r.table_name as string)
    expect(registered).toEqual(expect.arrayContaining(['service_order_events', 'encounter_handwriting', 'mana_action_decisions']))
    expect(await code(q("UPDATE mana_action_decisions SET decision = 'declined'"))).toBe('42501')
  })
})
