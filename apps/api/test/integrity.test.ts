import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { AuditChainReport, Encounter, EncounterVerification, ManaAnswer, PatientDetail, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { auditCanonical, verifyAuditChain } from '../src/audit/chain.ts'
import { canonicalJson, sha256 } from '../src/encounters/service.ts'
import { amendmentCanonical, canonicalJsonStrict, signedContentHash, verifyEncounter } from '../src/encounters/verify.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, testConfig } from './helpers.ts'

/**
 * Slice 3: signed-record verification, the amendment chain, the audit log's
 * hash chain, and the application role's privileges on append-only tables.
 * Tampering is simulated as the test superuser with triggers bypassed
 * (session_replication_role = replica), which is exactly what the database
 * rules cannot prevent and what the fingerprints must reveal.
 */
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

const tamper = (sql: string, params: unknown[] = []) => adminQuery(`SET session_replication_role = replica; ${sql}`.replace(/\$(\d)/g, (_m, i) => `'${String(params[Number(i) - 1]).replace(/'/g, "''")}'`))

let n = 0
async function signedRecord(opts: { insertAi?: boolean; course?: boolean } = {}) {
  n++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Integ${n}`, phone: `93000${String(n).padStart(5, '0')}` }) })).json())
  await call(ctx.app, 'POST', `/api/patients/${p.id}/allergies`, { cookie: nurse, body: { substance: 'Penicillin', reaction: 'Rash', severity: 'moderate' } })
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Sore throat' } })).json())
  let e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  if (opts.insertAi) {
    // Reviewed AI-assisted text, inserted by the doctor, with its reference to the source.
    const a = ManaAnswer.parse((await call(ctx.app, 'POST', `/api/patients/${p.id}/mana/questions`, { cookie: doctor, body: { question: 'Allergies?', encounterId: e.id } })).json())
    e = Encounter.parse((await call(ctx.app, 'POST', `/api/encounters/${e.id}/insertions`, { cookie: doctor, body: { version: e.version, section: 'pastHistory', text: 'Allergy to Penicillin (rash), per record.', subjectType: 'mana_answer', subjectId: a.id } })).json())
  }
  const saved = Encounter.parse(
    (
      await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, {
        cookie: doctor,
        body: {
          version: e.version,
          note: { ...e.note, chiefComplaint: 'Sore throat for 2 days', examination: 'Tonsils inflamed.', assessment: 'Acute pharyngitis.', plan: 'Warm saline gargles.' },
          diagnoses: [{ description: 'Acute pharyngitis', code: 'J02.9', kind: 'primary' }],
          prescription: [{ drugName: 'Paracetamol', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'TDS', duration: '3 days', instructions: '', ...(opts.course && { durationDays: 3 }) }],
        },
      })
    ).json(),
  )
  const signed = await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })
  expect(signed.statusCode).toBe(200)
  // HERO final (deliberate change): signing no longer closes the visit, so the doctor completes it, as before signing did; some tests open a
  // second visit for the same patient the same day. Completing changes the visit, not the signed record.
  expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
  return Encounter.parse(signed.json())
}
const verify = async (id: string, cookie = doctor) => EncounterVerification.parse((await call(ctx.app, 'GET', `/api/encounters/${id}/verification`, { cookie })).json())
const amend = (id: string, reason: string, content: string) => call(ctx.app, 'POST', `/api/encounters/${id}/amendments`, { cookie: doctor, body: { reason, content } })
/** A v3 snapshot's medicines as v1 and v2 signed them: without the structured course (durationDays, startDate), which v3 added. */
const writtenOnly = (rx: unknown) => (rx as Record<string, unknown>[]).map(({ durationDays: _d, startDate: _s, ...rest }) => rest)
/** Turns a record signed now into one as signed before migration 0019 (scheme v1, no scheme anywhere). */
async function makeLegacy(e: Encounter) {
  const snap = { ...((await row(e.id)).signedSnapshot as Record<string, unknown>) }
  for (const k of ['scheme', 'facilityId', 'attestation']) delete snap[k]
  snap.visit = { visitDate: e.visit.visitDate, tokenNumber: e.visit.tokenNumber }
  // HERO final: records are now signed under v3, whose medicines also carry their course; a v1 record never had it.
  snap.prescription = writtenOnly(snap.prescription)
  const hash = sha256(canonicalJson(snap))
  await tamper('UPDATE encounters SET hash_scheme = NULL, signed_snapshot = $2::jsonb, content_hash = $3 WHERE id = $1', [e.id, JSON.stringify(snap), hash])
  await tamper(`UPDATE audit_events SET details = jsonb_build_object('contentHash', $2::text) WHERE action = 'encounter.sign' AND entity_id = $1`, [e.id, hash])
}
/** Turns a record signed now into one as signed under scheme v2 (before HERO final): the same content without the medicines' course. */
async function makeV2(e: Encounter) {
  const signed = (await row(e.id)).signedSnapshot as Record<string, unknown>
  const snap = { ...signed, scheme: 'adaxai.encounter.v2', prescription: writtenOnly(signed.prescription) }
  const hash = sha256(canonicalJsonStrict(snap))
  await tamper(`UPDATE encounters SET hash_scheme = 'adaxai.encounter.v2', signed_snapshot = $2::jsonb, content_hash = $3 WHERE id = $1`, [e.id, JSON.stringify(snap), hash])
  await tamper(`UPDATE audit_events SET details = details || jsonb_build_object('contentHash', $2::text, 'hashScheme', 'adaxai.encounter.v2') WHERE action = 'encounter.sign' AND entity_id = $1`, [e.id, hash])
}
const failed = (r: EncounterVerification) => r.checks.filter((c) => c.result === 'fail').map((c) => c.key)
const row = async (id: string) => (await ctx.db.query.encounters.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!

describe('canonical serialisation', () => {
  it('sorts keys, is stable, and the strict form refuses what JSON storage would not reproduce', () => {
    expect(canonicalJsonStrict({ b: 1, a: [true, null, 'x'], c: { z: 'é', y: 'line\nbreak' } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":"line\\nbreak","z":"é"}}')
    expect(canonicalJsonStrict({ b: 2, a: 1 })).toBe(canonicalJsonStrict({ a: 1, b: 2 }))
    expect(() => canonicalJsonStrict({ a: undefined })).toThrow(/undefined/)
    expect(() => canonicalJsonStrict({ a: Number.NaN })).toThrow(/finite/)
    expect(() => canonicalJsonStrict({ a: new Date() })).toThrow(/plain object/)
    // Version 1 (legacy) is the earlier, lenient form: same output for JSON-safe content.
    expect(canonicalJson({ b: 1, a: 'x' })).toBe(canonicalJsonStrict({ b: 1, a: 'x' }))
    expect(signedContentHash({ a: 1 }, 'adaxai.encounter.v9')).toBeNull()
  })
})

describe('signed-record verification', () => {
  it('a newly signed record verifies: current scheme, content, record rows, audit copy; nurses can check it too, and checks are audited', async () => {
    const e = await signedRecord()
    // HERO final (deliberate change): the current scheme is v3 (v2 plus each medicine's course); v2 records are checked in the next tests.
    expect(e.hashScheme).toBe('adaxai.encounter.v3')
    const r = await verify(e.id)
    expect(r).toMatchObject({ status: 'valid', scheme: 'adaxai.encounter.v3', schemeRecorded: true, contentHash: e.contentHash, recomputedHash: e.contentHash, amendments: { total: 0 } })
    expect(r.checks.map((c) => `${c.key}:${c.result}`)).toEqual(['scheme:pass', 'content_hash:pass', 'record_matches:pass', 'sign_audit:pass', 'amendments:pass'])
    expect(r.notes).toEqual([])
    expect((await verify(e.id, nurse)).status).toBe('valid')
    // What is signed names its scheme and the attestation, and covers the visit and facility, and each medicine's course (none given here: null).
    const snap = (await row(e.id)).signedSnapshot as Record<string, unknown>
    expect(snap).toMatchObject({ scheme: 'adaxai.encounter.v3', facilityId: fx.facilityId, visit: { id: e.visit.id }, attestation: expect.stringMatching(/^I have reviewed this record/) })
    expect(snap.prescription).toEqual([expect.objectContaining({ drugName: 'Paracetamol', duration: '3 days', durationDays: null, startDate: null })])
    expect(sha256(canonicalJsonStrict(snap))).toBe(e.contentHash)
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'encounter.verify' ORDER BY id")
    expect(rows.map((x) => x.details)).toEqual([
      { status: 'valid', scheme: 'adaxai.encounter.v3', failed: [] },
      { status: 'valid', scheme: 'adaxai.encounter.v3', failed: [] },
    ])
    // Patients and other facilities cannot check records this way.
    expect((await call(ctx.app, 'GET', `/api/encounters/${e.id}/verification`, { cookie: await login(ctx.app, 't.admin') })).statusCode).toBe(403)
  })

  it('a change to the signed content, the record rows, or the stored fingerprint is reported as invalid', async () => {
    const e = await signedRecord()
    await tamper(`UPDATE encounters SET signed_snapshot = jsonb_set(signed_snapshot, '{note,plan}', '"Amoxicillin 500 mg"') WHERE id = $1`, [e.id])
    let r = await verify(e.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['content_hash', 'record_matches']])

    const e2 = await signedRecord()
    await tamper(`UPDATE prescription_items SET dose = '2 tablets' WHERE encounter_id = $1`, [e2.id])
    r = await verify(e2.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['record_matches']])
    expect(r.checks.find((c) => c.key === 'record_matches')!.detail).toMatch(/prescription/)

    const e3 = await signedRecord()
    await tamper(`UPDATE encounters SET content_hash = repeat('a', 64) WHERE id = $1`, [e3.id])
    r = await verify(e3.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['content_hash', 'sign_audit']])
  })

  it('reports an unsupported fingerprint version, a missing fingerprint, and drafts as not checkable', async () => {
    const e = await signedRecord()
    // A record from a later version: the column, the signed content and the audit entry all name it.
    await tamper(`UPDATE encounters SET hash_scheme = 'adaxai.encounter.v9', signed_snapshot = jsonb_set(signed_snapshot, '{scheme}', '"adaxai.encounter.v9"') WHERE id = $1;
      UPDATE audit_events SET details = jsonb_set(details, '{hashScheme}', '"adaxai.encounter.v9"') WHERE action = 'encounter.sign' AND entity_id = $1`, [e.id])
    const r = await verify(e.id)
    expect([r.status, r.recomputedHash, r.checks.map((c) => c.result)]).toEqual(['unsupported_version', null, ['not_checked']])
    // Even then, a fingerprint that disagrees with the audit log is not hidden behind "unsupported".
    await tamper(`UPDATE encounters SET content_hash = repeat('b', 64) WHERE id = $1`, [e.id])
    expect(failed(await verify(e.id))).toEqual(['sign_audit'])
    // A signed row without its fingerprint cannot exist (database check), so this is checked on the row in memory.
    const missing = await verifyEncounter(ctx.db, { ...(await row(e.id)), contentHash: null, hashScheme: null })
    expect([missing.status, missing.checks[0]!.key]).toEqual(['unverifiable', 'fingerprint'])
    await expect(adminQuery('UPDATE encounters SET content_hash = NULL WHERE id = $1', [e.id])).rejects.toMatchObject({ code: '42501' })
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: e.patient.id, departmentId: fx.departments.gen } })).json())
    const draft = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    expect((await verify(draft.id)).status).toBe('unverifiable')
  })

  it('a record signed before schemes were recorded is checked as version 1', async () => {
    const e = await signedRecord()
    await makeLegacy(e)
    const r = await verify(e.id)
    expect(r).toMatchObject({ status: 'valid', scheme: 'adaxai.encounter.v1', schemeRecorded: false })
    expect(r.checks[0]!.detail).toMatch(/checked as version 1/)
  })

  it('v3 signs each medicine’s course (days and start date); a change to it afterwards, in the rows or in the signed content, is detected', async () => {
    const e = await signedRecord({ course: true })
    // The draft gave 3 days without a start date: the course starts on the consultation's date, stored before signing.
    expect(e.prescription[0]).toMatchObject({ duration: '3 days', durationDays: 3, startDate: e.visit.visitDate })
    const snap = (await row(e.id)).signedSnapshot as { prescription: Record<string, unknown>[] }
    expect(snap.prescription[0]).toMatchObject({ durationDays: 3, startDate: e.visit.visitDate })
    expect((await verify(e.id)).status).toBe('valid')
    // The database refuses the change for the application role ...
    await expect(ctx.pool.query('UPDATE prescription_items SET duration_days = 30 WHERE encounter_id = $1', [e.id])).rejects.toMatchObject({ code: '42501' })
    // ... and a change made behind its back is found: the course length,
    await tamper('UPDATE prescription_items SET duration_days = 30 WHERE encounter_id = $1', [e.id])
    let r = await verify(e.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['record_matches']])
    expect(r.checks.find((c) => c.key === 'record_matches')!.detail).toMatch(/prescription/)
    // the start date,
    const e2 = await signedRecord({ course: true })
    await tamper("UPDATE prescription_items SET start_date = start_date + 1 WHERE encounter_id = $1", [e2.id])
    expect(failed(await verify(e2.id))).toEqual(['record_matches'])
    // or the signed content itself.
    const e3 = await signedRecord({ course: true })
    await tamper(`UPDATE encounters SET signed_snapshot = jsonb_set(signed_snapshot, '{prescription,0,durationDays}', '30') WHERE id = $1`, [e3.id])
    r = await verify(e3.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['content_hash', 'record_matches']])
  })

  it('a record signed under v2 (before courses were signed) still verifies; a course appearing on it later is said, and the rest is still checked', async () => {
    const e = await signedRecord()
    await makeV2(e)
    let r = await verify(e.id)
    expect(r).toMatchObject({ status: 'valid', scheme: 'adaxai.encounter.v2', schemeRecorded: true, recomputedHash: (await row(e.id)).contentHash })
    expect(r.checks.map((c) => `${c.key}:${c.result}`)).toEqual(['scheme:pass', 'content_hash:pass', 'record_matches:pass', 'sign_audit:pass', 'amendments:pass'])
    expect(r.notes).toEqual([])
    // v2 did not sign a course, so one on its rows is not a mismatch with what was signed; the reader is told, never left to assume it was signed.
    await tamper("UPDATE prescription_items SET duration_days = 3, start_date = '2026-01-01' WHERE encounter_id = $1", [e.id])
    r = await verify(e.id)
    expect(r.status).toBe('valid')
    expect(r.notes).toEqual([expect.stringMatching(/course length or start date, which fingerprint version v2 does not cover/)])
    // What v2 did sign is still checked.
    await tamper(`UPDATE prescription_items SET dose = '2 tablets' WHERE encounter_id = $1`, [e.id])
    r = await verify(e.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['record_matches']])
    // Relabelling a v3 record as v2 (to escape the course check) is a changed fingerprint version.
    const e2 = await signedRecord({ course: true })
    await tamper(`UPDATE encounters SET hash_scheme = 'adaxai.encounter.v2' WHERE id = $1`, [e2.id])
    expect(failed(await verify(e2.id))).toEqual(['scheme'])
  })

  it('changing the fingerprint version, the visit, the facility or the signing time afterwards is detected', async () => {
    // Downgrade to "signed before versions" while moving the record to another visit of the same patient.
    const e = await signedRecord()
    const other = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: e.patient.id, departmentId: fx.departments.gen } })).json())
    await tamper('UPDATE encounters SET hash_scheme = NULL, visit_id = $2 WHERE id = $1', [e.id, other.id])
    let r = await verify(e.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['scheme', 'record_matches']])
    expect(r.checks.find((c) => c.key === 'record_matches')!.detail).toMatch(/visit or facility/)
    // An unknown version written over a current one does not hide anything either.
    const e2 = await signedRecord()
    await tamper(`UPDATE encounters SET hash_scheme = 'adaxai.encounter.v9', signed_snapshot = jsonb_set(signed_snapshot, '{note,plan}', '"changed"') WHERE id = $1`, [e2.id])
    r = await verify(e2.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['scheme', 'content_hash', 'record_matches']])
    // On a record signed before versions were recorded, writing a version number does not skip the checks either.
    const e4 = await signedRecord()
    await makeLegacy(e4)
    await tamper(`UPDATE encounters SET hash_scheme = 'adaxai.encounter.v9', signed_snapshot = jsonb_set(signed_snapshot, '{note,plan}', '"changed"') WHERE id = $1`, [e4.id])
    r = await verify(e4.id)
    expect([r.status, r.scheme, failed(r)]).toEqual(['invalid', 'adaxai.encounter.v1', ['scheme', 'content_hash', 'record_matches']])
    // The signing time shown on the record must be the one that was fingerprinted.
    const e3 = await signedRecord()
    await tamper(`UPDATE encounters SET signed_at = signed_at - interval '1 day' WHERE id = $1`, [e3.id])
    r = await verify(e3.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['record_matches']])
    expect(r.checks.find((c) => c.key === 'record_matches')!.detail).toMatch(/signing time/)
  })

  it('notes, without failing, when the patient’s name changed after signing', async () => {
    const e = await signedRecord()
    await call(ctx.app, 'PATCH', `/api/patients/${e.patient.id}`, { cookie: nurse, body: { givenName: 'Renamed' } })
    const r = await verify(e.id)
    expect(r.status).toBe('valid')
    expect(r.notes).toEqual([expect.stringMatching(/patient's name has changed since signing/)])
  })
})

describe('amendments', () => {
  it('are numbered and linked by the database, starting at the signed record, and never change it', async () => {
    const e = await signedRecord()
    expect((await amend(e.id, 'Dose clarified', 'Paracetamol 500 mg, maximum 4 tablets a day.')).statusCode).toBe(201)
    const after = Encounter.parse((await amend(e.id, 'Follow-up', 'Review in 1 week; sent for throat swab.')).json())
    expect(after.contentHash).toBe(e.contentHash)
    expect(after.amendments.map((a) => [a.seq, a.authorName])).toEqual([
      [1, 'Test t.doctor'],
      [2, 'Test t.doctor'],
    ])
    const { rows } = await adminQuery(`SELECT seq, prev_hash, content_hash, author_id, reason, content, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM encounter_amendments WHERE encounter_id = $1 ORDER BY seq`, [e.id])
    expect(rows[0].prev_hash).toBe(e.contentHash)
    expect(rows[1].prev_hash).toBe(rows[0].content_hash)
    // The verifier's rebuild of the database's canonical text gives the same fingerprints.
    for (const a of rows) expect(sha256(amendmentCanonical({ scheme: 'adaxai.amendment.v1', encounterId: e.id, seq: a.seq, prevHash: a.prev_hash, authorId: a.author_id, createdAt: a.created_at, reason: a.reason, content: a.content }))).toBe(a.content_hash)
    expect((await adminQuery("SELECT details FROM audit_events WHERE action = 'encounter.amend' ORDER BY id")).rows.map((r) => r.details.seq)).toEqual([1, 2])
    const r = await verify(e.id)
    expect([r.status, r.amendments]).toEqual(['valid', { total: 2, linked: 2, beforeLinking: 0 }])
  })

  it('the database numbers, times and links them itself, and only for signed records', async () => {
    const e = await signedRecord()
    // Values supplied by the caller are replaced.
    await ctx.pool.query("INSERT INTO encounter_amendments (encounter_id, author_id, reason, content, created_at, seq, prev_hash, content_hash) VALUES ($1, $2, 'r', 'c', now() - interval '1 year', 99, 'x', 'y')", [e.id, fx.users.doctor])
    const { rows } = await adminQuery('SELECT seq, prev_hash, content_hash, created_at > now() - interval \'1 minute\' AS recent FROM encounter_amendments WHERE encounter_id = $1', [e.id])
    expect(rows[0]).toMatchObject({ seq: 1, prev_hash: e.contentHash, recent: true })
    expect(rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/)
    // But it was not added through the application: it has no audit entry.
    const r = await verify(e.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['amendment_audit']])
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: e.patient.id, departmentId: fx.departments.gen } })).json())
    const draft = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    await expect(ctx.pool.query("INSERT INTO encounter_amendments (encounter_id, author_id, reason, content) VALUES ($1, $2, 'r', 'c')", [draft.id, fx.users.doctor])).rejects.toMatchObject({ code: '42501' })
  })

  it('a changed, removed or reordered amendment breaks the chain', async () => {
    const e = await signedRecord()
    for (const i of [1, 2, 3]) await amend(e.id, `Reason ${i}`, `Correction ${i}`)
    await tamper(`UPDATE encounter_amendments SET content = 'Correction 2 (edited)' WHERE encounter_id = $1 AND seq = 2`, [e.id])
    let r = await verify(e.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['amendments']])
    expect(r.checks.find((c) => c.key === 'amendments')!.detail).toMatch(/amendment 2 was changed/)

    const e2 = await signedRecord()
    for (const i of [1, 2, 3]) await amend(e2.id, `Reason ${i}`, `Correction ${i}`)
    await tamper(`DELETE FROM encounter_amendments WHERE encounter_id = $1 AND seq = 2`, [e2.id])
    r = await verify(e2.id)
    expect(r.checks.find((c) => c.key === 'amendments')!.detail).toMatch(/amendment 2 is missing/)

    const e3 = await signedRecord()
    for (const i of [1, 2]) await amend(e3.id, `Reason ${i}`, `Correction ${i}`)
    // Swap their positions (in two steps: the numbering is unique).
    await tamper(`UPDATE encounter_amendments SET seq = -seq WHERE encounter_id = $1; UPDATE encounter_amendments SET seq = 3 + seq WHERE encounter_id = $1`, [e3.id])
    r = await verify(e3.id)
    expect(r.status).toBe('invalid')
    expect(r.checks.find((c) => c.key === 'amendments')!.detail).toMatch(/does not follow/)
  })

  it('amendments from before linking are reported as not covered, and the linked ones after them still verify', async () => {
    const e = await signedRecord()
    // Only records signed before migration 0019 can have amendments without links.
    await makeLegacy(e)
    await tamper(`INSERT INTO encounter_amendments (id, encounter_id, author_id, reason, content) VALUES ('00000000-0000-4000-8000-000000000001', $1, $2, 'Old', 'Before linking');
      INSERT INTO audit_events (action, entity_type, entity_id, details) VALUES ('encounter.amend', 'encounter', $1, '{"amendmentId": "00000000-0000-4000-8000-000000000001"}')`, [e.id, fx.users.doctor])
    expect((await verify(e.id)).checks.find((c) => c.key === 'amendments')).toMatchObject({ result: 'not_checked', detail: expect.stringMatching(/before amendments were fingerprinted/) })
    await amend(e.id, 'New', 'After linking')
    const { rows } = await adminQuery('SELECT seq FROM encounter_amendments WHERE encounter_id = $1 AND seq IS NOT NULL', [e.id])
    expect(rows).toEqual([{ seq: 2 }])
    const r = await verify(e.id)
    // The audit row inserted above bypassed the chain (it is legacy-style): the record itself still verifies.
    expect(r.amendments).toEqual({ total: 2, linked: 1, beforeLinking: 1 })
    expect(r.checks.find((c) => c.key === 'amendments')).toMatchObject({ result: 'pass', detail: expect.stringMatching(/1 earlier one/) })
    expect(r.status).toBe('valid')
  })

  it('an amendment without a link on a record signed after linking began, or removing the newest amendment, is detected', async () => {
    const e = await signedRecord()
    await tamper(`INSERT INTO encounter_amendments (id, encounter_id, author_id, reason, content) VALUES ('00000000-0000-4000-8000-000000000002', $1, $2, 'Slipped in', 'No link');
      INSERT INTO audit_events (action, entity_type, entity_id, details) VALUES ('encounter.amend', 'encounter', $1, '{"amendmentId": "00000000-0000-4000-8000-000000000002"}')`, [e.id, fx.users.doctor])
    let r = await verify(e.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['amendments']])
    expect(r.checks.find((c) => c.key === 'amendments')!.detail).toMatch(/no link although the record was signed after linking began/)

    // The newest amendment removed: the remaining chain is intact, but the audit log remembers it.
    const e2 = await signedRecord()
    for (const i of [1, 2]) await amend(e2.id, `Reason ${i}`, `Correction ${i}`)
    await tamper('DELETE FROM encounter_amendments WHERE encounter_id = $1 AND seq = 2', [e2.id])
    r = await verify(e2.id)
    expect([r.status, failed(r)]).toEqual(['invalid', ['amendment_audit']])
    expect(r.checks.find((c) => c.key === 'amendment_audit')!.detail).toMatch(/1 amendment\(s\) recorded in the audit log are missing/)
    // All amendments removed: still detected.
    await tamper('DELETE FROM encounter_amendments WHERE encounter_id = $1', [e2.id])
    expect(failed(await verify(e2.id))).toEqual(['amendment_audit'])
  })

  it('checks running while amendments are added never report a false alarm (one consistent snapshot)', async () => {
    const e = await signedRecord()
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_x, i) => amend(e.id, `Reason ${i}`, `Correction ${i}`).then(() => null)),
      ...Array.from({ length: 16 }, () => verify(e.id)),
    ])
    const checks = results.filter((x): x is EncounterVerification => x !== null)
    expect(checks.map((c) => c.status)).toEqual(Array(16).fill('valid'))
    expect((await verify(e.id)).amendments).toEqual({ total: 8, linked: 8, beforeLinking: 0 })
  })

  it('AI-assisted text keeps its reference to the source through signing and amendment, and the reference is covered', async () => {
    const e = await signedRecord({ insertAi: true })
    expect(e.aiInsertions).toEqual([expect.objectContaining({ section: 'pastHistory', subjectType: 'mana_answer', retained: true })])
    const snap = (await row(e.id)).signedSnapshot as { aiInsertions: { id: string; subjectType: string; retained: boolean }[] }
    expect(snap.aiInsertions).toEqual([expect.objectContaining({ id: e.aiInsertions[0]!.id, subjectType: 'mana_answer', retained: true })])
    const amended = Encounter.parse((await amend(e.id, 'Allergy detail', 'Rash was urticarial.')).json())
    expect(amended.aiInsertions).toEqual(e.aiInsertions)
    expect((await verify(e.id)).status).toBe('valid')
    // No AI text can be recorded into a signed note, even by the application role directly.
    await expect(ctx.pool.query("INSERT INTO note_insertions (encounter_id, patient_id, section, text, subject_type, subject_id, produced_by, inserted_by) SELECT encounter_id, patient_id, 'plan', 'x', subject_type, subject_id, produced_by, inserted_by FROM note_insertions WHERE encounter_id = $1", [e.id])).rejects.toMatchObject({ code: '42501' })
    // Removing the reference after signing is detected.
    await tamper('DELETE FROM note_insertions WHERE encounter_id = $1', [e.id])
    const r = await verify(e.id)
    expect(r.checks.find((c) => c.key === 'record_matches')!.detail).toMatch(/AI-assisted text references/)
  })
})

describe('audit log hash chain', () => {
  const report = async (anchor?: { seq: number; hash: string }) => verifyAuditChain(ctx.db, anchor)

  it('links every event in commit order; the verifier rebuilds each hash independently of the database', async () => {
    await signedRecord()
    const r = await report()
    expect(r.status).toBe('valid')
    expect(r.events.chained).toBe(r.events.total)
    const { rows } = await adminQuery('SELECT chain_seq, prev_hash, row_hash FROM audit_events ORDER BY chain_seq')
    expect(rows.map((x) => Number(x.chain_seq))).toEqual(rows.map((_x, i) => i + 1))
    expect(rows[0].prev_hash).toBe('0'.repeat(64))
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].row_hash)
    expect(r.head).toMatchObject({ seq: rows.length, hash: rows.at(-1).row_hash })
    // Same canonical text as the database function, for an event with unusual characters.
    await call(ctx.app, 'POST', '/api/auth/login', { body: { username: 'nobody', password: 'x' } })
    const [ev] = (await ctx.db.execute(
      (await import('drizzle-orm')).sql`select chain_seq::text as seq, chain_version as ver, prev_hash as prev, row_hash as hash, id::text as id, to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, actor_user_id::text as actor, actor_role as role, action, outcome, entity_type as etype, entity_id as eid, patient_id::text as patient, request_id as request, ip, user_agent as ua, details::text as details, facility_id::text as facility, audit_event_canonical(audit_events) as canonical from audit_events order by chain_seq desc limit 1`,
    )).rows as unknown as (Parameters<typeof auditCanonical>[0] & { canonical: string })[]
    expect(auditCanonical(ev!)).toBe(ev!.canonical)
    await ctx.pool.query("INSERT INTO audit_events (action, user_agent, details) VALUES ('test.chars', $1, $2)", ['Tab\there "quoted" \\ back\u0001 ✓ é 中文  ', JSON.stringify({ note: 'line\nbreak', n: 1.5, big: 12345678901234, nested: { z: 1, a: [true, null] } })])
    expect((await report()).status).toBe('valid')
  })

  it('stays intact under concurrent writes, and rolled-back writes leave no gap', async () => {
    const writes = Array.from({ length: 40 }, (_x, i) =>
      i % 5 === 0
        ? (async () => {
            const c = await ctx.pool.connect()
            try {
              await c.query('BEGIN')
              await c.query("INSERT INTO audit_events (action) VALUES ('test.rolled_back')")
              await c.query('ROLLBACK')
            } finally {
              c.release()
            }
          })()
        : ctx.pool.query("INSERT INTO audit_events (action, details) VALUES ('test.concurrent', $1)", [JSON.stringify({ i })]),
    )
    await Promise.all(writes)
    const r = await report()
    expect([r.status, r.problemCount]).toEqual(['valid', 0])
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'test.rolled_back'")).rows[0].n).toBe(0)
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'test.concurrent'")).rows[0].n).toBe(32)
    const { rows } = await adminQuery('SELECT max(chain_seq)::int AS max, count(*)::int AS n FROM audit_events')
    expect(rows[0].max).toBe(rows[0].n)
  })

  it('detects an altered, a deleted, a reordered and an unlinked event', async () => {
    for (let i = 0; i < 6; i++) await ctx.pool.query("INSERT INTO audit_events (action, details) VALUES ('test.event', $1)", [JSON.stringify({ i })])
    const base = await report()
    expect(base.status).toBe('valid')
    const seqs = (await adminQuery("SELECT chain_seq::int AS s FROM audit_events WHERE action = 'test.event' ORDER BY chain_seq")).rows.map((r) => r.s as number)

    await tamper(`UPDATE audit_events SET details = '{"i": 99}' WHERE chain_seq = ${seqs[2]}`)
    let r = await report()
    expect([r.status, r.problems.map((p) => `${p.kind}@${p.seq}`)]).toEqual(['invalid', [`altered@${seqs[2]}`]])
    await tamper(`UPDATE audit_events SET details = '{"i": 2}' WHERE chain_seq = ${seqs[2]}`)
    expect((await report()).status).toBe('valid')

    await tamper(`DELETE FROM audit_events WHERE chain_seq = ${seqs[3]}`)
    r = await report()
    expect(r.problems.map((p) => `${p.kind}@${p.seq}`)).toEqual([`gap@${seqs[3]}`])

    await resetDatabase()
    for (let i = 0; i < 4; i++) await ctx.pool.query("INSERT INTO audit_events (action, details) VALUES ('test.event', $1)", [JSON.stringify({ i })])
    await tamper('UPDATE audit_events SET chain_seq = -chain_seq WHERE chain_seq IN (2, 3); UPDATE audit_events SET chain_seq = 5 + chain_seq WHERE chain_seq IN (-2, -3)')
    r = await report()
    expect(r.status).toBe('invalid')
    expect(r.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(['broken_link', 'altered']))

    await resetDatabase()
    await ctx.pool.query("INSERT INTO audit_events (action) VALUES ('test.event')")
    await tamper("INSERT INTO audit_events (action) VALUES ('written without the chain')")
    r = await report()
    expect(r.problems.map((p) => p.kind)).toEqual(['unchained_event'])
  })

  it('removing the newest events is found only against an anchor recorded earlier', async () => {
    for (let i = 0; i < 5; i++) await ctx.pool.query("INSERT INTO audit_events (action) VALUES ('test.event')")
    const { head } = await report()
    await tamper(`DELETE FROM audit_events WHERE chain_seq >= ${head!.seq - 1}`)
    expect((await report()).status).toBe('valid')
    const r = await report({ seq: head!.seq, hash: head!.hash })
    expect([r.status, r.anchor?.result, r.problems[0]?.kind]).toEqual(['invalid', 'missing', 'anchor_missing'])
    const earlier = await report({ seq: 2, hash: 'f'.repeat(64) })
    expect(earlier.anchor?.result).toBe('mismatch')
  })

  it('checks the events from before the chain against the digest recorded when it began', async () => {
    await resetDatabase()
    // Events from before the chain (as in a database that existed before migration 0019); more than
    // ten, so that ids ordered as text ('1', '10', '11', '2') would differ from their numeric order ...
    await tamper("INSERT INTO audit_events (action, details) SELECT 'legacy.event', jsonb_build_object('i', i) FROM generate_series(1, 23) i; INSERT INTO audit_events (action, details) VALUES ('legacy.two', '{\"k\": \"v\"}')")
    // ... summarised by the chain-start event, exactly as the migration does it.
    await adminQuery(`INSERT INTO audit_events (action, outcome, entity_type, details)
      SELECT 'audit.chain_start', 'success', 'audit_log', jsonb_build_object('chainVersion', 1, 'legacyEvents', count(*), 'legacyLastId', max(e.id),
        'legacyDigest', encode(sha256(convert_to(coalesce(string_agg(audit_event_canonical(e), E'\\n' ORDER BY e.id), ''), 'UTF8')), 'hex'))
      FROM audit_events e`)
    await ctx.pool.query("INSERT INTO audit_events (action) VALUES ('test.after')")
    let r = await report()
    expect(r).toMatchObject({ status: 'valid', events: { total: 26, chained: 2, beforeChain: 24 }, chainStart: { seq: 1, legacyEvents: 24, legacyDigestMatches: true } })
    await tamper("UPDATE audit_events SET details = '{\"k\": \"changed\"}' WHERE action = 'legacy.two'")
    r = await report()
    expect([r.status, r.problems.map((p) => p.kind), r.chainStart?.legacyDigestMatches]).toEqual(['invalid', ['legacy_changed'], false])
  })

  it('events of an unknown chain version still count for gaps and links; an older version after a newer one is reported', async () => {
    for (let i = 0; i < 30; i++) await ctx.pool.query("INSERT INTO audit_events (action) VALUES ('test.event')")
    const { rows } = await adminQuery('SELECT max(chain_seq)::int AS max FROM audit_events')
    const max = rows[0].max as number
    // A newer version at the end only (more than the 20 problems listed): unsupported, not broken.
    await tamper(`UPDATE audit_events SET chain_version = 2 WHERE chain_seq > ${max - 25}`)
    let r = await report()
    expect([r.status, r.problemCount, r.problems.length]).toEqual(['unsupported_version', 25, 20])
    // A removed event among them is still a gap. Here it is beyond the 20 problems listed, and it still makes the result invalid.
    await tamper(`DELETE FROM audit_events WHERE chain_seq = ${max - 3}`)
    r = await report()
    expect([r.status, r.problemCount, r.problems.length, r.problems.some((p) => p.kind === 'gap')]).toEqual(['invalid', 25, 20, false])
    // An older version after a newer one means the chain was altered.
    await resetDatabase()
    for (let i = 0; i < 4; i++) await ctx.pool.query("INSERT INTO audit_events (action) VALUES ('test.event')")
    await tamper('UPDATE audit_events SET chain_version = 2 WHERE chain_seq = 2')
    r = await report()
    expect(r.status).toBe('invalid')
    expect(r.problems.map((p) => `${p.kind}@${p.seq}`)).toEqual(['unsupported_version@2', 'broken_link@3'])
  })

  it('reports an unknown chain version as unsupported, and refuses audit writes outside READ COMMITTED', async () => {
    await ctx.pool.query("INSERT INTO audit_events (action) VALUES ('test.event')")
    await tamper('UPDATE audit_events SET chain_version = 2')
    expect((await report()).status).toBe('unsupported_version')
    const c = await ctx.pool.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await expect(c.query("INSERT INTO audit_events (action) VALUES ('test.rr')")).rejects.toMatchObject({ code: 'AX001' })
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })

  it('admins check it from the API (counts and hashes only); others cannot; the check is audited', async () => {
    const admin = await login(ctx.app, 't.admin')
    const res = await call(ctx.app, 'GET', '/api/admin/audit-integrity', { cookie: admin })
    const r = AuditChainReport.parse(res.json())
    expect(r.status).toBe('valid')
    expect(JSON.stringify(r)).not.toMatch(/t\.admin|Test t/)
    const anchored = AuditChainReport.parse((await call(ctx.app, 'GET', '/api/admin/audit-integrity', { cookie: admin, query: { anchorSeq: String(r.head!.seq), anchorHash: r.head!.hash } })).json())
    expect(anchored.anchor).toEqual({ seq: r.head!.seq, hash: r.head!.hash, result: 'match' })
    expect((await call(ctx.app, 'GET', '/api/admin/audit-integrity', { cookie: admin, query: { anchorSeq: '1' } })).statusCode).toBe(400)
    expect((await call(ctx.app, 'GET', '/api/admin/audit-integrity', { cookie: doctor })).statusCode).toBe(403)
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'audit.verify' ORDER BY id")
    expect(rows[0].details).toMatchObject({ status: 'valid', anchor: null })
    expect(rows[1].details).toMatchObject({ anchor: 'match' })
  })

  it('the command-line check reports the head to record, and fails on a broken chain', async () => {
    await ctx.pool.query("INSERT INTO audit_events (action) VALUES ('test.event')")
    const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'src/audit/verify-cli.ts', ...args], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8' })
    const cli = () => run(['--target', 'test'])
    // Options are strict: a dangling, misspelt or npm-swallowed option is refused, never silently ignored.
    for (const [args, env] of [[['--target', 'test', '--anchor'], {}], [['--target', 'test', '--anchr', '1:x'], {}], [['--target', 'test', 'stray'], {}], [['--target', 'test'], { npm_config_anchor: '' }]] as const) {
      const r = run([...args], env)
      expect([r.status, r.stderr], args.join(' ')).toEqual([2, expect.stringContaining('usage: npm run audit:verify --')])
    }
    const ok = cli()
    expect([ok.status, ok.stdout]).toEqual([0, expect.stringMatching(/VALID[\s\S]*head: --anchor \d+:[0-9a-f]{64}/)])
    expect(ok.stdout + ok.stderr).not.toContain(testConfig.db.appPassword)
    await tamper("UPDATE audit_events SET action = 'changed'")
    const bad = cli()
    expect([bad.status, bad.stdout]).toEqual([1, expect.stringMatching(/INVALID[\s\S]*altered at 1\b/)])
  })
})

describe('privileges of the application role', () => {
  it('holds no UPDATE, DELETE or TRUNCATE on append-only tables, and re-applying the policy restores that', async () => {
    const tables = (await adminQuery('SELECT table_name FROM meta.append_only_tables ORDER BY 1')).rows.map((r) => r.table_name as string)
    expect(tables).toEqual(expect.arrayContaining(['audit_events', 'encounter_amendments', 'note_insertions', 'visit_status_events', 'encounter_status_events']))
    const app = testConfig.db.appUser
    const privs = async () => (await adminQuery(`SELECT t, has_table_privilege($1, t, 'UPDATE') AS u, has_table_privilege($1, t, 'DELETE') AS d, has_table_privilege($1, t, 'TRUNCATE') AS tr, has_table_privilege($1, t, 'INSERT') AS i FROM unnest($2::text[]) t`, [app, tables])).rows
    expect((await privs()).every((p) => !p.u && !p.d && !p.tr && p.i)).toBe(true)
    // Re-provisioning grants DML on all tables again; the policy takes the extra privileges back.
    await adminQuery(`GRANT UPDATE, DELETE ON audit_events TO ${app}`)
    expect((await privs()).find((p) => p.t === 'audit_events')).toMatchObject({ u: true, d: true })
    await adminQuery('SELECT meta.enforce_append_only($1)', [app])
    expect((await privs()).every((p) => !p.u && !p.d && !p.tr)).toBe(true)
    // Every table protected by an append-only row trigger is in the list.
    const { rows: guarded } = await adminQuery(`SELECT DISTINCT c.relname AS t FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND (t.tgtype & 1) = 1 AND p.proname IN ('reject_change_append_only', 'amendments_reject_change', 'audit_events_reject_change') ORDER BY 1`)
    expect(guarded.map((g) => g.t).filter((t) => !tables.includes(t))).toEqual([])
    expect(tables).toContain('auscultation_recordings')
    // So even before any trigger runs, and even taking a table lock, the role is refused.
    const c = await ctx.pool.connect()
    try {
      await c.query('BEGIN')
      await expect(c.query('LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE')).rejects.toMatchObject({ code: '42501' })
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
})
