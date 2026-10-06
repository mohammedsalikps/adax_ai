// The doctor's handwritten notes (Doctor HERO final, DESIGN §5.4 / §6, spec §11): GET and POST /api/encounters/:id/handwriting. Every save is a
// new version of the strokes document (a JSON file in `files`), written only by the consultation's own doctor while it is an unsigned draft; the
// format, the limits and the counts are checked before anything is stored; a stale version is a 409 conflict; a signed or discarded record keeps
// its last version read-only; the audit trail holds ids and counts only, never strokes.
import { Encounter, HANDWRITING_LIMITS, HANDWRITING_VERSION_CONFLICT, HandwritingLatest, HandwritingSaved, PatientDetail, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/password.ts'
import { departments, facilities, users } from '../src/db/schema.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD } from './helpers.ts'

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

type Doc = { format: number; page: { width: number; height: number }; pageCount: number; strokes: Record<string, unknown>[] } & Record<string, unknown>
/** A distinctive coordinate: it must never appear in the audit trail. */
const SENTINEL_X = 123.4
const stroke = (over: Record<string, unknown> = {}) => ({ page: 0, width: 3, color: '#0f172a', input: 'pen', points: [SENTINEL_X, 100, 0.5, 130.5, 110, 0.62, 140, 130.2, 0.7], ...over })
const doc = (strokes: Record<string, unknown>[] = [stroke()], pageCount = 1): Doc => ({ format: 1, page: { width: 1000, height: 1414 }, pageCount, strokes })

/** A multipart body: the fields first (the API reads fields sent before the file), then at most one file. */
function multipart(fields: Record<string, string | number>, file: { data: Buffer | string; type: string; name?: string } | null) {
  const boundary = '----adaxaihandwriting'
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name ?? 'handwriting.json'}"\r\nContent-Type: ${file.type}\r\n\r\n`), Buffer.from(file.data), Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

interface SaveOptions {
  cookie?: string
  strokeCount?: number | string
  pageCount?: number | string
  /** Replaces the file's bytes (the counts still come from `d`). */
  raw?: Buffer | string
  type?: string
  /** Leave these fields out. */
  omit?: string[]
  noFile?: boolean
}
function save(encounterId: string, d: Doc, expectedVersion: number | string, o: SaveOptions = {}) {
  const fields: Record<string, string | number> = { expectedVersion, strokeCount: o.strokeCount ?? d.strokes.length, pageCount: o.pageCount ?? d.pageCount }
  for (const k of o.omit ?? []) delete fields[k]
  const m = multipart(fields, o.noFile ? null : { data: o.raw ?? JSON.stringify(d), type: o.type ?? 'application/json' })
  return ctx.app.inject({ method: 'POST', url: `/api/encounters/${encounterId}/handwriting`, headers: { ...m.headers, cookie: o.cookie ?? doctor, 'x-adaxai-csrf': '1' }, payload: m.payload })
}
const latest = async (encounterId: string, cookie = doctor) => HandwritingLatest.parse((await call(ctx.app, 'GET', `/api/encounters/${encounterId}/handwriting`, { cookie })).json())
const versions = async (encounterId: string) => (await adminQuery('SELECT version FROM encounter_handwriting WHERE encounter_id = $1 ORDER BY version', [encounterId])).rows.map((r) => r.version as number)
const strokeFiles = async () => (await adminQuery("SELECT count(*)::int AS n FROM files WHERE kind = 'handwriting_strokes'")).rows[0].n as number

let seq = 0
/** A visit with the doctor and its consultation (an unsigned draft of t.doctor). */
async function consultation() {
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Ink${seq}`, phone: `92000${String(seq).padStart(5, '0')}` }) })).json())
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Fever' } })).json())
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  return { p, v, e }
}

describe('handwritten notes: saving and reading', () => {
  it('nothing written yet is version 0 with no document; the first save is version 1 and reads back exactly as written (unknown keys are not kept)', async () => {
    const { p, e } = await consultation()
    expect(await latest(e.id)).toEqual({ encounterId: e.id, version: 0, strokeCount: 0, pageCount: 0, strokesFileId: null, document: null, savedAt: null, savedByName: null, readOnly: false })

    const written = doc([stroke(), stroke({ page: 1, color: '#1d4ed8', width: 6, input: 'touch', points: [500, 700, 0.5] })], 2)
    const res = await save(e.id, { ...written, secret: 'not kept', strokes: written.strokes.map((s, i) => (i ? s : { ...s, label: 'not kept' })) }, 0)
    expect(res.statusCode).toBe(201)
    const saved = HandwritingSaved.parse(res.json())
    expect(saved).toMatchObject({ encounterId: e.id, version: 1, strokeCount: 2, pageCount: 2, savedByName: 'Test t.doctor' })

    const back = await latest(e.id)
    expect(back).toMatchObject({ version: 1, strokeCount: 2, pageCount: 2, savedByName: 'Test t.doctor', readOnly: false, savedAt: saved.savedAt, strokesFileId: saved.strokesFileId })
    expect(back.document).toEqual(written)
    // The strokes file is a file of this patient and consultation, kept as the original writing (readable through the files route).
    const f = (await adminQuery('SELECT kind, mime_type, patient_id, encounter_id, uploaded_by FROM files WHERE id = $1', [back.strokesFileId])).rows[0]
    expect(f).toEqual({ kind: 'handwriting_strokes', mime_type: 'application/json', patient_id: p.id, encounter_id: e.id, uploaded_by: fx.users.doctor })
    const raw = await call(ctx.app, 'GET', `/api/files/${back.strokesFileId}`, { cookie: doctor })
    expect(raw.statusCode).toBe(200)
    expect(JSON.parse(raw.body)).toEqual(written)
  })

  it('every save is a new version; a stale or skipped version is a 409 conflict that stores nothing, and of two saves at once one wins', async () => {
    const { e } = await consultation()
    expect((await save(e.id, doc(), 0)).statusCode).toBe(201)
    expect((await save(e.id, doc([stroke(), stroke()]), 1)).statusCode).toBe(201)
    for (const stale of [1, 0, 5]) {
      const res = await save(e.id, doc([stroke(), stroke(), stroke()]), stale)
      expect([stale, res.statusCode, res.json().error]).toEqual([stale, 409, HANDWRITING_VERSION_CONFLICT])
    }
    expect(await versions(e.id)).toEqual([1, 2])
    expect(await strokeFiles()).toBe(2)
    // The previous version stays: the latest is what the pad shows, every earlier one is kept.
    expect((await latest(e.id)).strokeCount).toBe(2)

    // Two screens saving from the same version: the database takes one, the other is told to reload (never a server error, never a gap).
    const both = await Promise.all([save(e.id, doc([stroke({ color: '#b91c1c' })]), 2), save(e.id, doc([stroke({ color: '#1d4ed8' })]), 2)])
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(both.find((r) => r.statusCode === 409)!.json().error).toBe(HANDWRITING_VERSION_CONFLICT)
    expect(await versions(e.id)).toEqual([1, 2, 3])
    expect(await strokeFiles()).toBe(3)
  })

  it('the file must be the handwriting format: format version, page, limits, points, colours, widths and counts are checked, and nothing is stored when they are wrong', async () => {
    const { e } = await consultation()
    const pointsOf = (n: number) => Array.from({ length: n }, (_, i) => [i % 1000, 10, 0.5]).flat()
    const cases: [string, Promise<{ statusCode: number; body: string }>][] = [
      ['not JSON', save(e.id, doc(), 0, { raw: 'strokes: none' })],
      ['format 2', save(e.id, { ...doc(), format: 2 }, 0)],
      ['another page size', save(e.id, { ...doc(), page: { width: 800, height: 1414 } }, 0)],
      ['points not in triples', save(e.id, doc([stroke({ points: [10, 10] })]), 0)],
      ['no points', save(e.id, doc([stroke({ points: [] })]), 0)],
      ['x outside the page', save(e.id, doc([stroke({ points: [1000.5, 10, 0.5] })]), 0)],
      ['y outside the page', save(e.id, doc([stroke({ points: [10, 1414.5, 0.5] })]), 0)],
      ['a negative coordinate', save(e.id, doc([stroke({ points: [-1, 10, 0.5] })]), 0)],
      ['pressure above 1', save(e.id, doc([stroke({ points: [10, 10, 1.2] })]), 0)],
      ['a point that is not a number', save(e.id, doc([stroke({ points: [10, '10', 0.5] })]), 0)],
      ['a colour name', save(e.id, doc([stroke({ color: 'red' })]), 0)],
      ['an upper-case colour', save(e.id, doc([stroke({ color: '#FFFFFF' })]), 0)],
      ['a short colour', save(e.id, doc([stroke({ color: '#fff' })]), 0)],
      ['a width of 0', save(e.id, doc([stroke({ width: 0 })]), 0)],
      ['a width above 40', save(e.id, doc([stroke({ width: 41 })]), 0)],
      ['an unknown input', save(e.id, doc([stroke({ input: 'eraser' })]), 0)],
      ['a stroke on a page the document does not have', save(e.id, doc([stroke({ page: 1 })], 1), 0)],
      ['more pages than allowed', save(e.id, doc([stroke()], HANDWRITING_LIMITS.maxPages + 1), 0)],
      ['more points in a stroke than allowed', save(e.id, doc([stroke({ points: pointsOf(HANDWRITING_LIMITS.maxPointsPerStroke + 1) })]), 0)],
      ['more strokes than allowed', save(e.id, doc(Array.from({ length: HANDWRITING_LIMITS.maxStrokes + 1 }, () => ({ page: 0, width: 3, color: '#0f172a', points: [1, 1, 0.5] }))), 0)],
      ['a stroke count that is not the file’s', save(e.id, doc(), 0, { strokeCount: 5 })],
      ['a page count that is not the file’s', save(e.id, doc(), 0, { pageCount: 2 })],
      ['no expected version', save(e.id, doc(), 0, { omit: ['expectedVersion'] })],
      ['an empty expected version (never read as 0)', save(e.id, doc(), '')],
      ['a negative expected version', save(e.id, doc(), -1)],
      ['a file that is not JSON by type', save(e.id, doc(), 0, { type: 'text/plain' })],
      ['no file', save(e.id, doc(), 0, { noFile: true })],
    ]
    for (const [name, pending] of cases) {
      const res = await pending
      expect([name, res.statusCode]).toEqual([name, 400])
    }
    // At the size limit or over it: refused before it is read.
    const big = await save(e.id, doc(), 0, { raw: Buffer.alloc(HANDWRITING_LIMITS.maxFileBytes + 1, 0x20) })
    expect(big.statusCode).toBe(413)
    // A refusal names the problem without echoing what was sent.
    const named = await save(e.id, doc([stroke({ color: '#ABCDEF' })]), 0)
    expect(named.json()).toMatchObject({ error: 'validation_error', issues: [expect.objectContaining({ path: 'file.strokes.0.color' })] })
    expect(named.body).not.toContain('ABCDEF')
    const counted = await save(e.id, doc(), 0, { strokeCount: 4 })
    expect(counted.json().issues).toEqual([{ path: 'strokeCount', message: 'The file has 1 strokes' }])

    expect(await versions(e.id)).toEqual([])
    expect(await strokeFiles()).toBe(0)
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'encounter.handwriting_save'")).rows[0].n).toBe(0)
    // The same content, well formed, is accepted (the refusals above were about the format, not the consultation).
    expect((await save(e.id, doc(), 0)).statusCode).toBe(201)
  })
})

describe('handwritten notes: who may write, and when', () => {
  it('once the consultation is signed the notes are read-only: a save is refused with 409 and the last version stays readable', async () => {
    const { e } = await consultation()
    expect((await save(e.id, doc([stroke(), stroke({ page: 1 })], 2), 0)).statusCode).toBe(201)
    const draft = Encounter.parse(
      (await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { version: e.version, note: { ...e.note, chiefComplaint: 'Cough', assessment: 'Viral', plan: 'Fluids' }, diagnoses: [{ description: 'Viral URTI', kind: 'provisional' }], prescription: [] } })).json(),
    )
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: draft.version, attestation: true } })).statusCode).toBe(200)

    const refused = await save(e.id, doc([stroke()]), 1)
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'encounter_signed'])
    expect(await latest(e.id)).toMatchObject({ version: 1, strokeCount: 2, pageCount: 2, readOnly: true })
    expect((await latest(e.id)).document?.strokes).toHaveLength(2)
    expect(await versions(e.id)).toEqual([1])
  })

  it('a discarded draft keeps its notes read-only; a draft whose visit left the doctor is read-only until it is continued', async () => {
    const a = await consultation()
    expect((await save(a.e.id, doc(), 0)).statusCode).toBe(201)
    expect((await call(ctx.app, 'POST', `/api/encounters/${a.e.id}/discard`, { cookie: doctor, body: { version: a.e.version, reason: 'Opened by mistake' } })).statusCode).toBe(200)
    const discarded = await save(a.e.id, doc(), 1)
    expect([discarded.statusCode, discarded.json().error]).toEqual([409, 'encounter_discarded'])
    expect(await latest(a.e.id)).toMatchObject({ version: 1, readOnly: true })

    const b = await consultation()
    // Data from before slice 3: the visit was moved back to the queue while the draft was open (as lifecycle.test does).
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET status = 'ready' WHERE id = '${b.v.id}'`)
    const paused = await save(b.e.id, doc(), 0)
    expect([paused.statusCode, paused.json().error]).toEqual([409, 'visit_not_in_consultation'])
    expect((await latest(b.e.id)).readOnly).toBe(true)
    expect(await versions(b.e.id)).toEqual([])
  })

  it('only the consultation’s doctor writes; nurses and other doctors read it read-only; admins, patients, strangers and other facilities cannot reach it', async () => {
    const { e } = await consultation()
    expect((await save(e.id, doc(), 0)).statusCode).toBe(201)
    const other = await login(ctx.app, 't.doctor2')
    const admin = await login(ctx.app, 't.admin')

    expect(await latest(e.id, nurse)).toMatchObject({ version: 1, readOnly: true })
    expect(await latest(e.id, other)).toMatchObject({ version: 1, readOnly: true })
    expect((await save(e.id, doc(), 1, { cookie: nurse })).statusCode).toBe(403)
    expect((await save(e.id, doc(), 1, { cookie: other })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', `/api/encounters/${e.id}/handwriting`, { cookie: admin })).statusCode).toBe(403)
    expect((await save(e.id, doc(), 1, { cookie: admin })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', `/api/encounters/${e.id}/handwriting`)).statusCode).toBe(401)
    expect((await save(e.id, doc(), 1, { cookie: '' })).statusCode).toBe(401)
    // Without the CSRF header a write is refused before anything else.
    const m = multipart({ expectedVersion: 1, strokeCount: 1, pageCount: 1 }, { data: JSON.stringify(doc()), type: 'application/json' })
    expect((await ctx.app.inject({ method: 'POST', url: `/api/encounters/${e.id}/handwriting`, headers: { ...m.headers, cookie: doctor }, payload: m.payload })).statusCode).toBe(403)

    // Another facility's doctor: the consultation does not exist for them.
    const [f2] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
    const [d2] = await ctx.db.insert(departments).values({ facilityId: f2!.id, code: 'GEN', name: 'General Medicine' }).returning()
    await ctx.db.insert(users).values({ facilityId: f2!.id, username: 'b.doctor', fullName: 'B doctor', role: 'doctor', passwordHash: await hashPassword(TEST_PASSWORD), departmentId: d2!.id })
    const elsewhere = await login(ctx.app, 'b.doctor')
    expect((await call(ctx.app, 'GET', `/api/encounters/${e.id}/handwriting`, { cookie: elsewhere })).statusCode).toBe(404)
    expect((await save(e.id, doc(), 1, { cookie: elsewhere })).statusCode).toBe(404)

    expect(await versions(e.id)).toEqual([1])
  })
})

describe('handwritten notes: audit', () => {
  it('saves and reads are audited with ids and counts only, never strokes, colours or points', async () => {
    const { p, e } = await consultation()
    const res = await save(e.id, doc([stroke(), stroke({ page: 1 }), stroke({ page: 1 })], 2), 0)
    const back = await latest(e.id)
    expect(res.statusCode).toBe(201)

    const saves = (await adminQuery("SELECT entity_type, entity_id, patient_id, actor_user_id, details FROM audit_events WHERE action = 'encounter.handwriting_save'")).rows
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ entity_type: 'encounter', entity_id: e.id, patient_id: p.id, actor_user_id: fx.users.doctor })
    expect(Object.keys(saves[0].details).sort()).toEqual(['pageCount', 'sizeBytes', 'strokeCount', 'strokesFileId', 'version'])
    expect(saves[0].details).toMatchObject({ version: 1, strokeCount: 3, pageCount: 2, strokesFileId: back.strokesFileId })
    const reads = (await adminQuery("SELECT details FROM audit_events WHERE action = 'encounter.handwriting_read' AND entity_id = $1", [e.id])).rows
    expect(reads.map((r) => r.details)).toEqual([{ version: 1 }])

    // Nothing of the writing is anywhere in the patient's audit trail.
    const trail = JSON.stringify((await adminQuery('SELECT details FROM audit_events WHERE patient_id = $1', [p.id])).rows)
    for (const needle of [String(SENTINEL_X), '#0f172a', 'points', '"pen"']) expect(trail).not.toContain(needle)
  })
})
