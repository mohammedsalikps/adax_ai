import { Encounter, PatientDetail, type TimelineEntry, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { canonicalJson, sha256 } from '../src/encounters/service.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

const ctx = createTestApp()
let fx: Fixture
let nurse = ''
let doctor = ''

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
})
afterAll(() => ctx.close())

let seq = 0
/** A checked-in visit with vitals, ready for the doctor; without a priority it is checked in as the API defaults it (normal). */
async function readyVisit(opts: { priority?: Visit['priority'] } = {}): Promise<Visit> {
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Enc${seq}`, phone: `91000${String(seq).padStart(5, '0')}` }) })).json())
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, priority: opts.priority, chiefComplaint: 'Fever and cough' } })).json())
  await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 38.4 }] } })
  return Visit.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'ready' } })).json())
}
const start = async (visitId: string, cookie = doctor) => call(ctx.app, 'POST', `/api/visits/${visitId}/encounter`, { cookie })

const fullDraft = (version: number) => ({
  version,
  note: {
    chiefComplaint: 'Fever and cough for 3 days',
    history: 'Intermittent fever, dry cough. No breathlessness.',
    pastHistory: 'No chronic illness.',
    examination: 'Throat congested. Chest clear.',
    assessment: 'Likely viral upper respiratory infection.',
    plan: 'Symptomatic care, fluids, review if worse.',
    followUp: 'Review in 5 days if not better.',
  },
  diagnoses: [{ description: 'Acute upper respiratory infection', code: 'j06.9', kind: 'primary' }],
  prescription: [{ drugName: 'Paracetamol', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Three times daily (TDS)', duration: '3 days', instructions: 'After food' }],
})

describe('starting a consultation', () => {
  it('moves the visit to the doctor, prefills the complaint, and is idempotent', async () => {
    const v = await readyVisit()
    const res = await start(v.id)
    expect(res.statusCode).toBe(201)
    const e = Encounter.parse(res.json())
    expect(e).toMatchObject({ status: 'in_progress', version: 1, canEdit: true, note: { chiefComplaint: 'Fever and cough' }, doctor: { id: fx.users.doctor } })
    expect(e.vitals.map((o) => o.kind)).toEqual(['temperature'])
    const again = await start(v.id)
    expect(again.statusCode).toBe(200)
    expect(again.json().id).toBe(e.id)
    const visit = Visit.parse((await call(ctx.app, 'GET', `/api/visits/${v.id}`, { cookie: nurse })).json())
    expect(visit).toMatchObject({ status: 'in_consultation', assignedDoctorId: fx.users.doctor, encounterId: e.id })
  })

  it('nurses cannot start or edit consultations, but can read them', async () => {
    const v = await readyVisit()
    expect((await start(v.id, nurse)).statusCode).toBe(403)
    const e = Encounter.parse((await start(v.id)).json())
    expect((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: nurse, body: fullDraft(1) })).statusCode).toBe(403)
    const read = Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${e.id}`, { cookie: nurse })).json())
    expect(read.canEdit).toBe(false)
  })

  it("carries the visit's priority as the record has it now", async () => {
    const urgent = Encounter.parse((await start((await readyVisit({ priority: 'urgent' })).id)).json())
    expect(urgent.visit.priority).toBe('urgent')
    expect(Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${urgent.id}`, { cookie: doctor })).json()).visit.priority).toBe('urgent')

    // Checked in without a priority: normal. Raised in the queue while the patient is with the doctor: the next read says urgent.
    const v = await readyVisit()
    const normal = Encounter.parse((await start(v.id)).json())
    expect(normal.visit.priority).toBe('normal')
    expect((await call(ctx.app, 'PATCH', `/api/visits/${v.id}`, { cookie: nurse, body: { priority: 'urgent' } })).statusCode).toBe(200)
    expect(Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${normal.id}`, { cookie: doctor })).json()).visit.priority).toBe('urgent')
  })
})

describe('autosave', () => {
  it('saves the whole draft and bumps the version; stale versions are rejected', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })).json())
    expect(saved.version).toBe(2)
    expect(saved.diagnoses).toEqual([{ description: 'Acute upper respiratory infection', code: 'J06.9', kind: 'primary' }])
    expect(saved.prescription[0]).toMatchObject({ drugName: 'Paracetamol', frequency: 'Three times daily (TDS)' })
    const stale = await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toBe('version_conflict')
    // Replacing the list removes items.
    const fewer = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { ...fullDraft(2), prescription: [] } })).json())
    expect(fewer.prescription).toEqual([])
  })

  it('only the authoring doctor can edit; oversized input is rejected', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    const other = await login(ctx.app, 't.doctor2')
    expect((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: other, body: fullDraft(1) })).statusCode).toBe(403)
    const huge = await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { ...fullDraft(1), note: { ...fullDraft(1).note, plan: 'x'.repeat(8001) } } })
    expect(huge.statusCode).toBe(400)
    expect(huge.json().issues[0].path).toBe('note.plan')
  })

  it('saves incomplete rows as a draft, but signing lists every missing field', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    const partial = await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { ...fullDraft(1), diagnoses: [{ description: 'Fever', code: 'not-icd' }], prescription: [{ drugName: 'Amoxi' }] } })
    expect(partial.statusCode).toBe(200)
    const sign = await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: partial.json().version, attestation: true } })
    expect(sign.statusCode).toBe(400)
    expect(sign.json().issues.map((i: { path: string }) => i.path)).toEqual(['diagnoses.0.code', 'prescription.0.dose', 'prescription.0.frequency', 'prescription.0.duration'])
  })
})

describe('signing', () => {
  it('requires a complete record and an explicit attestation', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    const empty = await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { version: 1, note: { ...fullDraft(1).note, chiefComplaint: '' }, diagnoses: [], prescription: [] } })
    const v = empty.json().version
    const res = await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: v, attestation: true } })
    expect(res.statusCode).toBe(400)
    expect(res.json().issues.map((i: { path: string }) => i.path).sort()).toEqual(['diagnoses', 'note.chiefComplaint'])
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: v } })).statusCode).toBe(400)
  })

  it('freezes the record, stores a verifiable hash and leaves the visit with the doctor until the consultation is completed', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await start(v.id)).json())
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })).json())
    const res = await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })
    expect(res.statusCode).toBe(200)
    const signed = Encounter.parse(res.json())
    expect(signed).toMatchObject({ status: 'signed', canEdit: false })
    expect(signed.signedAt).not.toBeNull()
    const { rows } = await adminQuery('SELECT signed_snapshot, content_hash FROM encounters WHERE id = $1', [e.id])
    expect(rows[0].content_hash).toBe(sha256(canonicalJson(rows[0].signed_snapshot)))
    expect(signed.contentHash).toBe(rows[0].content_hash)
    expect(rows[0].signed_snapshot.prescription[0].drugName).toBe('Paracetamol')
    // HERO final (deliberate change): signing no longer completes the visit; it stays with the doctor until the doctor completes it.
    expect(Visit.parse((await call(ctx.app, 'GET', `/api/visits/${v.id}`, { cookie: nurse })).json()).status).toBe('in_consultation')
    expect(signed).toMatchObject({ visit: { status: 'in_consultation' }, canComplete: true, completedAt: null })
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
    expect(Visit.parse((await call(ctx.app, 'GET', `/api/visits/${v.id}`, { cookie: nurse })).json()).status).toBe('completed')

    // The API refuses edits ...
    expect((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(signed.version) })).statusCode).toBe(409)
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: signed.version, attestation: true } })).statusCode).toBe(409)
    // ... and so does the database, even for the application role.
    const app = ctx.pool
    await expect(app.query("UPDATE encounters SET plan = 'tampered' WHERE id = $1", [e.id])).rejects.toMatchObject({ code: '42501' })
    await expect(app.query('DELETE FROM encounters WHERE id = $1', [e.id])).rejects.toMatchObject({ code: '42501' })
    await expect(app.query("INSERT INTO diagnoses (encounter_id, description) VALUES ($1, 'sneaky')", [e.id])).rejects.toMatchObject({ code: '42501' })
    await expect(app.query("UPDATE prescription_items SET dose = '10 tablets' WHERE encounter_id = $1", [e.id])).rejects.toMatchObject({ code: '42501' })
    await expect(app.query('DELETE FROM prescription_items WHERE encounter_id = $1', [e.id])).rejects.toMatchObject({ code: '42501' })
  })

  it('shows the visit priority with the record but does not sign it', async () => {
    const e = Encounter.parse((await start((await readyVisit({ priority: 'urgent' })).id)).json())
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })).json())
    const res = await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })
    expect(res.statusCode).toBe(200)
    // HERO final (deliberate change): the signed record's visit is still with the doctor (signing no longer completes it).
    expect(Encounter.parse(res.json()).visit).toMatchObject({ status: 'in_consultation', priority: 'urgent' })
    // The signed snapshot covers the same visit fields as before (scheme v2, and v3 adds only the medicines' courses), so the priority is not part of what is hashed.
    const { rows } = await adminQuery('SELECT signed_snapshot, content_hash FROM encounters WHERE id = $1', [e.id])
    expect(Object.keys(rows[0].signed_snapshot.visit).sort()).toEqual(['id', 'reasonForVisit', 'tokenNumber', 'visitDate'])
    expect(rows[0].content_hash).toBe(sha256(canonicalJson(rows[0].signed_snapshot)))
  })

  it('another doctor cannot sign', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })).json())
    const other = await login(ctx.app, 't.doctor2')
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: other, body: { version: saved.version, attestation: true } })).statusCode).toBe(403)
  })
})

describe('amendments', () => {
  it('appends attributed corrections without changing the signed record', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/amendments`, { cookie: doctor, body: { reason: 'x', content: 'y' } })).statusCode).toBe(409)
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })).json())
    const signed = Encounter.parse((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).json())
    const res = await call(ctx.app, 'POST', `/api/encounters/${e.id}/amendments`, { cookie: doctor, body: { reason: 'Dose clarification', content: 'Paracetamol: maximum 4 tablets in 24 hours.' } })
    expect(res.statusCode).toBe(201)
    const amended = Encounter.parse(res.json())
    expect(amended.amendments).toEqual([expect.objectContaining({ reason: 'Dose clarification', authorName: 'Test t.doctor' })])
    expect(amended.contentHash).toBe(signed.contentHash)
    expect(amended.note).toEqual(signed.note)
    await expect(ctx.pool.query("UPDATE encounter_amendments SET content = 'changed'")).rejects.toMatchObject({ code: '42501' })
    await expect(ctx.pool.query('DELETE FROM encounter_amendments')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('the prescription PDF', () => {
  /** The PDF's bytes as text (WinAnsi is one byte per character), checked for a valid cross-reference table. */
  const pdfText = (raw: Buffer) => {
    const s = raw.toString('latin1')
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
    const xref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1])
    expect(s.slice(xref, xref + 4)).toBe('xref')
    const offsets = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
    offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`))
    return s
  }

  it('is made from the record: a draft is marked not signed, a signed one says who signed it; each is audited as a read', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })).json())
    const draft = await call(ctx.app, 'GET', `/api/encounters/${e.id}/prescription.pdf`, { cookie: doctor })
    expect(draft.statusCode).toBe(200)
    expect(draft.headers['content-type']).toBe('application/pdf')
    expect(draft.headers['content-disposition']).toMatch(/^inline; filename="prescription-[\w.-]+\.pdf"$/)
    expect(draft.headers['cache-control']).toBe('private, no-store')
    const d = pdfText(draft.rawPayload)
    expect(d).toContain('NOT SIGNED')
    expect(d).toContain('(Paracetamol 500 mg Tablet)')
    expect(d).toContain('Acute upper respiratory infection')
    expect(d).toContain('Not signed')
    expect(d).not.toContain('Signed electronically')
    expect(d).toContain('not a valid prescription')

    // A nurse may read the consultation, so may read its prescription; signed, it carries the signature and no draft mark.
    expect((await call(ctx.app, 'GET', `/api/encounters/${e.id}/prescription.pdf`, { cookie: nurse })).statusCode).toBe(200)
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    const s = pdfText((await call(ctx.app, 'GET', `/api/encounters/${e.id}/prescription.pdf`, { cookie: doctor })).rawPayload)
    expect(s).toContain('Signed electronically on')
    expect(s).not.toContain('NOT SIGNED')
    expect(s).toContain('(Paracetamol 500 mg Tablet)')

    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'encounter.read' AND entity_id = $1 AND details->>'via' = 'prescription_pdf' ORDER BY id", [e.id])
    expect(rows.map((r: { details: { signed: boolean } }) => r.details.signed)).toEqual([false, false, true])
  })

  it('is refused without a session and for an unknown consultation', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    expect((await call(ctx.app, 'GET', `/api/encounters/${e.id}/prescription.pdf`)).statusCode).toBe(401)
    expect((await call(ctx.app, 'GET', '/api/encounters/00000000-0000-4000-8000-000000000000/prescription.pdf', { cookie: doctor })).statusCode).toBe(404)
  })
})

describe('timeline and persistence', () => {
  it('shows consultations with diagnoses and medicines, plus other visits', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await start(v.id)).json())
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })).json())
    await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })
    const entries = (await call(ctx.app, 'GET', `/api/patients/${v.patient.id}/timeline`, { cookie: nurse })).json().entries as TimelineEntry[]
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'encounter', title: 'Consultation', status: 'signed', doctorName: 'Test t.doctor', diagnoses: ['Acute upper respiratory infection (J06.9)'], medications: ['Paracetamol 500 mg'] }),
    ])
  })

  it('a signed consultation reads back identically from a fresh app instance', async () => {
    const e = Encounter.parse((await start((await readyVisit()).id)).json())
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(1) })).json())
    const signed = Encounter.parse((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).json())
    await ctx.app.close()
    const fresh = createTestApp()
    try {
      const cookie = await login(fresh.app, 't.doctor')
      const reread = Encounter.parse((await call(fresh.app, 'GET', `/api/encounters/${e.id}`, { cookie })).json())
      expect({ ...reread, canEdit: undefined }).toEqual({ ...signed, canEdit: undefined })
    } finally {
      await fresh.close()
    }
  })
})
