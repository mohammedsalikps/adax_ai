import { DOCUMENT_MAX_BYTES, Encounter, PatientDetail, PatientDocument, PatientHistory, PatientProcedure, type PatientSummary, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { abhaQuery } from '../src/patients/routes.ts'
import { sniffDocument } from '../src/documents/service.ts'
import { facilities, users } from '../src/db/schema.ts'
import { hashPassword } from '../src/auth/password.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

// Patient documents (lab reports, imaging, other papers), surgeries, the history read model's new lines and the ABHA search (Doctor HERO
// final, migration 0033). Runs against the test database as the application.

const ctx = createTestApp()
let fx: Fixture
let doctor = ''
let nurse = ''
let admin = ''
let seq = 0

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% synthetic test document\n1 0 obj << /Type /Catalog >> endobj\n'), Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n')])
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** Text that must never reach the audit log (titles, report text, file names, procedure names, reasons). */
const SECRET = {
  title: 'Zebrafinch MRI brain',
  report: 'Quokka report text: no acute infarct',
  file: 'pangolin-scan.pdf',
  procedure: 'Narwhalectomy',
  reason: 'Uploaded for the wrong axolotl',
}

function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
  const boundary = '----adaxaidocuments'
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`))
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

function upload(patientId: string, fields: Record<string, string>, file: { name: string; type: string; data: Buffer } = { name: 'cbc.pdf', type: 'application/pdf', data: PDF }, cookie = doctor) {
  const m = multipart(fields, file)
  return ctx.app.inject({ method: 'POST', url: `/api/patients/${patientId}/documents`, headers: { ...m.headers, cookie, 'x-adaxai-csrf': '1' }, payload: m.payload })
}

async function newPatient(consents: string[] = ['data_processing'], over: Record<string, unknown> = {}): Promise<PatientDetail> {
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Doc${'abcdefghij'[seq % 10]}${seq}`, phone: `93100${String(seq).padStart(5, '0')}`, ...over }) })).json())
  for (const type of consents) expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type, method: 'verbal' } })).statusCode).toBe(201)
  return p
}

const history = async (id: string, cookie = doctor) => PatientHistory.parse((await call(ctx.app, 'GET', `/api/patients/${id}/history`, { cookie })).json())
const list = async (id: string, cookie = doctor, query?: Record<string, string>) => (await call(ctx.app, 'GET', `/api/patients/${id}/documents`, { cookie, query })).json().documents.map((d: unknown) => PatientDocument.parse(d)) as PatientDocument[]
/** A calendar date n days ago (the facility and the test machine share a clock here; a few days' margin keeps it in the past). */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const LAB = { category: 'lab_report', title: 'CBC', studyDate: daysAgo(2) }

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
  admin = await login(ctx.app, 't.admin')
})
afterAll(() => ctx.close())

describe('what a document is, from its bytes', () => {
  it('recognises PDF, JPEG and PNG by their first bytes only; everything else is not a document', () => {
    expect(sniffDocument(PDF)).toBe('application/pdf')
    expect(sniffDocument(JPEG)).toBe('image/jpeg')
    expect(sniffDocument(PNG)).toBe('image/png')
    for (const other of [GIF, Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('PK\u0003\u0004word'), Buffer.from('DICM'), Buffer.from(' %PDF-1.4'), Buffer.alloc(0), Buffer.from([0xff, 0xd8])]) expect(sniffDocument(other)).toBeNull()
  })
})

describe('uploading a document', () => {
  it('needs the patient’s consent to care records; refusals are audited and nothing is stored', async () => {
    const none = await newPatient([])
    const res = await upload(none.id, LAB)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('consent_required')
    expect((await adminQuery("SELECT details FROM audit_events WHERE action = 'consent.blocked' AND patient_id = $1", [none.id])).rows).toEqual([{ details: { type: 'data_processing', purpose: 'patient document', state: 'not_recorded' } }])
    // Withdrawn is refused too.
    const p = await newPatient()
    const consent = PatientDetail.parse((await call(ctx.app, 'GET', `/api/patients/${p.id}`, { cookie: nurse })).json()).consents.find((c) => c.type === 'data_processing')!
    expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/consents/${consent.id}/withdraw`, { cookie: nurse, body: { reason: 'Patient asked' } })).statusCode).toBe(200)
    expect((await upload(p.id, LAB)).json().error).toBe('consent_withdrawn')
    expect((await adminQuery('SELECT count(*)::int AS n FROM patient_documents')).rows[0].n).toBe(0)
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE kind = 'patient_document'")).rows[0].n).toBe(0)
  })

  it('stores a PDF as the patient’s file, links it to the consultation, records the event, and serves it through the audited file route', async () => {
    const p = await newPatient()
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Headache' } })).json())
    await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'ready' } })
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    // The browser's word for the type is not trusted: the bytes are a PDF, so it is stored as one.
    const res = await upload(p.id, { category: 'imaging_report', modality: 'mri', title: SECRET.title, studyDate: daysAgo(15), reportText: SECRET.report, encounterId: e.id }, { name: SECRET.file, type: 'application/octet-stream', data: PDF })
    expect(res.statusCode).toBe(201)
    const d = PatientDocument.parse(res.json())
    expect(d).toMatchObject({ patientId: p.id, encounterId: e.id, category: 'imaging_report', modality: 'mri', title: SECRET.title, studyDate: daysAgo(15), reportText: SECRET.report, mimeType: 'application/pdf', sizeBytes: PDF.length, originalName: SECRET.file, status: 'recorded', statusReason: null, uploadedByName: 'Test t.doctor' })
    const file = (await adminQuery('SELECT kind, patient_id, facility_id, encounter_id, mime_type, size_bytes FROM files WHERE id = $1', [d.fileId])).rows[0]
    expect(file).toEqual({ kind: 'patient_document', patient_id: p.id, facility_id: fx.facilityId, encounter_id: e.id, mime_type: 'application/pdf', size_bytes: PDF.length })
    const events = (await adminQuery("SELECT entity_type, action, to_status, actor_user_id FROM patient_history_events WHERE entity_id = $1", [d.id])).rows
    expect(events).toEqual([{ entity_type: 'document', action: 'created', to_status: 'recorded', actor_user_id: fx.users.doctor }])
    const served = await call(ctx.app, 'GET', `/api/files/${d.fileId}`, { cookie: nurse })
    expect(served.statusCode).toBe(200)
    expect(served.headers['content-type']).toBe('application/pdf')
    expect(served.rawPayload.equals(PDF)).toBe(true)
    const audit = (await adminQuery("SELECT entity_id, details FROM audit_events WHERE action = 'document.upload'")).rows
    expect(audit).toEqual([{ entity_id: d.id, details: { fileId: d.fileId, category: 'imaging_report', modality: 'mri', mimeType: 'application/pdf', sizeBytes: PDF.length, encounterId: e.id, hasReportText: true, hasStudyDate: true } }])
  })

  it('nurses upload too; JPEG and PNG are stored as images whatever their name says', async () => {
    const p = await newPatient()
    const jpeg = PatientDocument.parse((await upload(p.id, { category: 'imaging_image', modality: 'xray', title: 'Chest X-ray' }, { name: 'xray.pdf', type: 'application/pdf', data: JPEG }, nurse)).json())
    expect(jpeg).toMatchObject({ mimeType: 'image/jpeg', modality: 'xray', studyDate: null, reportText: null, uploadedByName: 'Test t.nurse' })
    const png = PatientDocument.parse((await upload(p.id, { category: 'other', title: 'Referral letter', modality: '', studyDate: '', reportText: '' }, { name: 'letter', type: 'text/plain', data: PNG })).json())
    expect(png).toMatchObject({ mimeType: 'image/png', modality: null, studyDate: null, reportText: null })
  })

  it('refuses anything that is not a PDF, JPEG or PNG, and files over the limit; nothing is stored', async () => {
    const p = await newPatient()
    const gif = await upload(p.id, LAB, { name: 'report.pdf', type: 'application/pdf', data: GIF })
    expect([gif.statusCode, gif.json().error]).toEqual([415, 'unsupported_document'])
    const html = await upload(p.id, LAB, { name: 'report.pdf', type: 'application/pdf', data: Buffer.from('<html><body>not a pdf</body></html>') })
    expect([html.statusCode, html.json().error]).toEqual([415, 'unsupported_document'])
    const big = await upload(p.id, LAB, { name: 'big.pdf', type: 'application/pdf', data: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(DOCUMENT_MAX_BYTES)]) })
    expect([big.statusCode, big.json().error]).toEqual([413, 'too_large'])
    const empty = await upload(p.id, LAB, { name: 'empty.pdf', type: 'application/pdf', data: Buffer.alloc(0) })
    expect(empty.statusCode).toBe(400)
    expect((await adminQuery('SELECT count(*)::int AS n FROM patient_documents')).rows[0].n).toBe(0)
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE kind = 'patient_document'")).rows[0].n).toBe(0)
  })

  it('validates the fields: a title, a known category, a modality only for imaging, no study date in the future, only this patient’s consultation', async () => {
    const p = await newPatient()
    const other = await newPatient()
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: other.id, departmentId: fx.departments.gen, chiefComplaint: 'Other' } })).json())
    await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'ready' } })
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    const paths = async (fields: Record<string, string>) => {
      const res = await upload(p.id, fields)
      expect(res.statusCode).toBe(400)
      return res.json().issues.map((i: { path: string }) => i.path)
    }
    expect(await paths({ category: 'lab_report', title: '' })).toEqual(['title'])
    expect(await paths({ category: 'dicom', title: 'Scan' })).toEqual(['category'])
    expect(await paths({ category: 'lab_report', title: 'CBC', modality: 'mri' })).toEqual(['modality'])
    expect(await paths({ category: 'lab_report', title: 'CBC', studyDate: '2999-01-01' })).toEqual(['studyDate'])
    expect(await paths({ category: 'lab_report', title: 'CBC', encounterId: e.id })).toEqual(['encounterId'])
    expect((await adminQuery('SELECT count(*)::int AS n FROM patient_documents')).rows[0].n).toBe(0)
  })

  it('administrators are refused; another facility’s patient is not found (audited)', async () => {
    const p = await newPatient()
    expect((await upload(p.id, LAB, undefined, admin)).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/documents`, { cookie: admin })).statusCode).toBe(403)
    const [f] = await ctx.db.insert(facilities).values({ code: 'OTHER-DOC', name: 'Other' }).returning()
    await ctx.db.insert(users).values({ facilityId: f!.id, username: 'other.doc', fullName: 'Other doctor', role: 'doctor', passwordHash: await hashPassword('Other-password-1') })
    const outsider = await login(ctx.app, 'other.doc', 'Other-password-1')
    expect((await upload(p.id, LAB, undefined, outsider)).statusCode).toBe(404)
    expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/documents`, { cookie: outsider })).statusCode).toBe(404)
    const d = PatientDocument.parse((await upload(p.id, LAB)).json())
    expect((await call(ctx.app, 'POST', `/api/documents/${d.id}/entered-in-error`, { cookie: outsider, body: { reason: 'Not mine' } })).statusCode).toBe(404)
    expect((await adminQuery("SELECT details->>'reason' AS reason FROM audit_events WHERE outcome = 'denied' AND entity_id = $1", [d.id])).rows).toEqual([{ reason: 'not_found_or_other_facility' }])
  })
})

describe('the documents list and marking one as entered in error', () => {
  it('lists newest first for doctors and nurses; a document marked in error leaves the list (kept, with its reason) and cannot change again', async () => {
    const p = await newPatient()
    const first = PatientDocument.parse((await upload(p.id, LAB)).json())
    const second = PatientDocument.parse((await upload(p.id, { category: 'imaging_image', modality: 'ct', title: 'CT abdomen' }, { name: 'ct.png', type: 'image/png', data: PNG })).json())
    expect((await list(p.id, nurse)).map((d) => d.id)).toEqual([second.id, first.id])

    expect((await call(ctx.app, 'POST', `/api/documents/${first.id}/entered-in-error`, { cookie: nurse, body: { reason: 'x' } })).statusCode).toBe(400)
    const marked = await call(ctx.app, 'POST', `/api/documents/${first.id}/entered-in-error`, { cookie: nurse, body: { reason: SECRET.reason } })
    expect(marked.statusCode).toBe(200)
    expect(PatientDocument.parse(marked.json())).toMatchObject({ id: first.id, status: 'entered_in_error', statusReason: SECRET.reason })
    const again = await call(ctx.app, 'POST', `/api/documents/${first.id}/entered-in-error`, { cookie: doctor, body: { reason: 'Second try' } })
    expect([again.statusCode, again.json().error]).toEqual([409, 'history_entry_locked'])

    expect((await list(p.id)).map((d) => d.id)).toEqual([second.id])
    expect((await list(p.id, doctor, { includeErrors: 'true' })).map((d) => `${d.id}:${d.status}`)).toEqual([`${second.id}:recorded`, `${first.id}:entered_in_error`])
    const events = (await adminQuery('SELECT action, from_status, to_status, reason FROM patient_history_events WHERE entity_id = $1 ORDER BY id', [first.id])).rows
    expect(events).toEqual([
      { action: 'created', from_status: null, to_status: 'recorded', reason: null },
      { action: 'status_changed', from_status: 'recorded', to_status: 'entered_in_error', reason: SECRET.reason },
    ])
    expect((await adminQuery("SELECT details FROM audit_events WHERE action = 'document.list' ORDER BY id")).rows.at(-1).details).toEqual({ count: 2, includeErrors: true, documentIds: [second.id, first.id] })
  })

  it('the database keeps documents: no delete, no edit of the content, and an entry in error stays as it is (as the application role)', async () => {
    const p = await newPatient()
    const d = PatientDocument.parse((await upload(p.id, LAB)).json())
    const code = (e: unknown) => (e as { code?: string }).code
    await expect(ctx.pool.query('DELETE FROM patient_documents WHERE id = $1', [d.id])).rejects.toSatisfy((e) => code(e) === 'AX008')
    await expect(ctx.pool.query("UPDATE patient_documents SET title = 'Changed' WHERE id = $1", [d.id])).rejects.toSatisfy((e) => code(e) === 'AX008')
    await call(ctx.app, 'POST', `/api/documents/${d.id}/entered-in-error`, { cookie: doctor, body: { reason: 'Wrong patient' } })
    await expect(ctx.pool.query("UPDATE patient_documents SET status = 'recorded', status_reason = null WHERE id = $1", [d.id])).rejects.toSatisfy((e) => code(e) === 'AX008')
    expect((await adminQuery('SELECT title, status FROM patient_documents WHERE id = $1', [d.id])).rows[0]).toEqual({ title: 'CBC', status: 'entered_in_error' })
  })
})

describe('surgeries', () => {
  it('doctors add them (nurses read only); the date may be unknown but never in the future; a duplicate is refused', async () => {
    const p = await newPatient()
    const add = (body: Record<string, unknown>, cookie = doctor) => call(ctx.app, 'POST', `/api/patients/${p.id}/procedures`, { cookie, body })
    expect((await add({ name: 'Appendectomy', performedYear: 2022 }, nurse)).statusCode).toBe(403)
    const res = await add({ name: 'Appendectomy', performedYear: 2022, note: 'Laparoscopic' })
    expect(res.statusCode).toBe(201)
    expect(PatientProcedure.parse(res.json())).toMatchObject({ name: 'Appendectomy', performedYear: 2022, performedMonth: null, note: 'Laparoscopic', status: 'recorded', enteredByName: 'Test t.doctor', dataOrigin: p.dataOrigin })
    expect((await add({ name: 'Tonsillectomy' })).statusCode).toBe(201)
    expect((await add({ name: 'appendectomy', performedYear: 2022 })).json().error).toBe('already_recorded')
    expect((await add({ name: 'Cataract surgery', performedYear: 2999 })).json().issues.map((i: { path: string }) => i.path)).toEqual(['performedYear'])
    expect((await add({ name: 'Cataract surgery', performedMonth: 3 })).json().issues.map((i: { path: string }) => i.path)).toEqual(['performedMonth'])
    expect((await add({ name: '' })).statusCode).toBe(400)
    // Newest first; one with no date last; nurses read them in the history.
    expect((await history(p.id, nurse)).procedures?.map((x) => `${x.name}:${x.performedYear ?? 'unknown'}`)).toEqual(['Appendectomy:2022', 'Tonsillectomy:unknown'])
  })

  it('a surgery entered in error leaves the history, is kept with its reason, cannot change again, and the database refuses edits and deletes', async () => {
    const p = await newPatient()
    const s = PatientProcedure.parse((await call(ctx.app, 'POST', `/api/patients/${p.id}/procedures`, { cookie: doctor, body: { name: SECRET.procedure, performedYear: 2020, performedMonth: 5 } })).json())
    expect((await call(ctx.app, 'POST', `/api/procedures/${s.id}/entered-in-error`, { cookie: nurse, body: { reason: 'Wrong patient' } })).statusCode).toBe(403)
    const marked = await call(ctx.app, 'POST', `/api/procedures/${s.id}/entered-in-error`, { cookie: doctor, body: { reason: SECRET.reason } })
    expect(PatientProcedure.parse(marked.json())).toMatchObject({ id: s.id, status: 'entered_in_error', enteredByName: 'Test t.doctor' })
    expect((await call(ctx.app, 'POST', `/api/procedures/${s.id}/entered-in-error`, { cookie: doctor, body: { reason: 'Again' } })).json().error).toBe('history_entry_locked')
    expect((await history(p.id)).procedures).toEqual([])
    // The same surgery can be entered again correctly once the wrong one is marked.
    expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/procedures`, { cookie: doctor, body: { name: SECRET.procedure, performedYear: 2020, performedMonth: 5 } })).statusCode).toBe(201)
    const code = (e: unknown) => (e as { code?: string }).code
    await expect(ctx.pool.query('DELETE FROM patient_procedures WHERE id = $1', [s.id])).rejects.toSatisfy((e) => code(e) === 'AX008')
    await expect(ctx.pool.query("UPDATE patient_procedures SET status = 'recorded' WHERE id = $1", [s.id])).rejects.toSatisfy((e) => code(e) === 'AX008')
    const events = (await adminQuery("SELECT entity_type, action, to_status FROM patient_history_events WHERE entity_id = $1 ORDER BY id", [s.id])).rows
    expect(events).toEqual([
      { entity_type: 'procedure', action: 'created', to_status: 'recorded' },
      { entity_type: 'procedure', action: 'status_changed', to_status: 'entered_in_error' },
    ])
  })
})

describe('the history read model', () => {
  it('has the surgeries and a documents line: counts by category and the latest few, without report text or entries in error', async () => {
    const p = await newPatient()
    const empty = await history(p.id)
    expect(empty.procedures).toEqual([])
    expect(empty.documents).toEqual({ total: 0, byCategory: { lab_report: 0, imaging_report: 0, imaging_image: 0, other: 0 }, latest: [] })
    const cbc = PatientDocument.parse((await upload(p.id, { category: 'lab_report', title: 'CBC', studyDate: daysAgo(2), reportText: SECRET.report })).json())
    const mri = PatientDocument.parse((await upload(p.id, { category: 'imaging_report', modality: 'mri', title: 'MRI brain', studyDate: daysAgo(15) })).json())
    const wrong = PatientDocument.parse((await upload(p.id, { category: 'other', title: 'Wrong letter' })).json())
    await call(ctx.app, 'POST', `/api/documents/${wrong.id}/entered-in-error`, { cookie: doctor, body: { reason: 'Wrong patient' } })
    await call(ctx.app, 'POST', `/api/patients/${p.id}/procedures`, { cookie: doctor, body: { name: 'Appendectomy', performedYear: 2022 } })
    const h = await history(p.id)
    expect(h.procedures?.map((x) => x.name)).toEqual(['Appendectomy'])
    expect(h.documents).toEqual({
      total: 2,
      byCategory: { lab_report: 1, imaging_report: 1, imaging_image: 0, other: 0 },
      latest: [
        { id: cbc.id, title: 'CBC', category: 'lab_report', modality: null, studyDate: daysAgo(2), createdAt: cbc.createdAt, hasReportText: true },
        { id: mri.id, title: 'MRI brain', category: 'imaging_report', modality: 'mri', studyDate: daysAgo(15), createdAt: mri.createdAt, hasReportText: false },
      ],
    })
    expect(JSON.stringify(h)).not.toContain(SECRET.report)
  })
})

describe('patient search by ABHA number', () => {
  it('an ABHA number is 14 digits, together or as ##-####-####-####; nothing else is one', () => {
    expect(abhaQuery('12345678901234')).toBe('12345678901234')
    expect(abhaQuery(' 12-3456-7890-1234 ')).toBe('12345678901234')
    expect(abhaQuery('12 3456 7890 1234')).toBe('12345678901234')
    for (const no of ['1234567890123', '123456789012345', '12-34567890-1234', 'Lakshmi', 'ADX-000001', '1234']) expect(abhaQuery(no)).toBeNull()
  })

  it('finds the patient by the whole ABHA number in either form, never by a part of it; rows carry the active allergies', async () => {
    const p = await newPatient([], { abhaNumber: '91-2345-6789-0123', givenName: 'Abha', familyName: 'Holder', phone: '9555500001' })
    await newPatient([], { givenName: 'Other', familyName: 'Person', phone: '9555500002' })
    await call(ctx.app, 'POST', `/api/patients/${p.id}/allergies`, { cookie: nurse, body: { substance: 'Penicillin', severity: 'severe' } })
    const search = async (q: string) => (await call(ctx.app, 'GET', '/api/patients', { cookie: doctor, query: { q } })).json().patients as PatientSummary[]
    expect((await search('91234567890123')).map((x) => x.fullName)).toEqual(['Abha Holder'])
    expect((await search('91-2345-6789-0123')).map((x) => x.fullName)).toEqual(['Abha Holder'])
    expect(await search('91-2345-6789-0124')).toEqual([])
    expect(await search('2345-6789')).toEqual([])
    expect((await search('Abha'))[0]).toMatchObject({ fullName: 'Abha Holder', activeAllergies: ['Penicillin'] })
    // The audit keeps the length of the term and the patients disclosed, never the number searched for.
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'patient.search' ORDER BY id")
    expect(rows[0].details).toEqual({ queryLength: 14, results: 1, patientIds: [p.id] })
    expect(JSON.stringify(rows)).not.toContain('91234567890123')
    expect(JSON.stringify(rows)).not.toContain('6789')
  })
})

describe('audit hygiene', () => {
  it('audit details of documents and surgeries carry ids, categories, sizes and flags, never titles, text, file names, names or reasons', async () => {
    const p = await newPatient()
    const d = PatientDocument.parse((await upload(p.id, { category: 'imaging_report', modality: 'mri', title: SECRET.title, reportText: SECRET.report }, { name: SECRET.file, type: 'application/pdf', data: PDF })).json())
    await list(p.id)
    await call(ctx.app, 'POST', `/api/documents/${d.id}/entered-in-error`, { cookie: doctor, body: { reason: SECRET.reason } })
    const s = PatientProcedure.parse((await call(ctx.app, 'POST', `/api/patients/${p.id}/procedures`, { cookie: doctor, body: { name: SECRET.procedure, note: SECRET.report } })).json())
    await call(ctx.app, 'POST', `/api/procedures/${s.id}/entered-in-error`, { cookie: doctor, body: { reason: SECRET.reason } })
    await history(p.id)
    const { rows } = await adminQuery("SELECT action, details FROM audit_events WHERE action LIKE 'document.%' OR action LIKE 'history.procedure%' OR action = 'patient.history_read' ORDER BY id")
    expect(rows.map((r) => r.action)).toEqual(['document.upload', 'document.list', 'document.entered_in_error', 'history.procedure_add', 'history.procedure_status', 'patient.history_read'])
    const text = JSON.stringify((await adminQuery('SELECT details FROM audit_events')).rows)
    for (const secret of Object.values(SECRET)) expect(text).not.toContain(secret)
  })
})
