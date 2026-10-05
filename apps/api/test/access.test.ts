import { Writable } from 'node:stream'
import { Encounter, PatientDetail, Visit } from '@adaxai/contracts'
import Fastify from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/password.ts'
import { can, type Permission } from '../src/auth/permissions.ts'
import { registerAuth } from '../src/auth/plugin.ts'
import { departments, facilities, users } from '../src/db/schema.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD } from './helpers.ts'

const ctx = createTestApp()
let fx: Fixture
beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
})
afterAll(() => ctx.close())

const PUBLIC = ['GET /api/health', 'GET /api/ready', 'POST /api/auth/login', 'POST /api/auth/activate', 'POST /api/device-ingest/readings', 'POST /api/device-ingest/heartbeat', 'POST /api/device-ingest/auscultations']
const ANY_SESSION = ['POST /api/auth/logout', 'GET /api/auth/me', 'POST /api/auth/change-password']
const ROLES = ['admin', 'doctor', 'nurse', 'patient'] as const
/** A concrete URL for a route pattern (ids that do not exist; a valid value where a param is an enum). */
const concrete = (url: string) => url.replace(':type', 'fact').replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000')

async function patientSession() {
  const nurse = await login(ctx.app, 't.nurse')
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient() })).json())
  await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'portal_access', method: 'verbal' } })
  const code = (await call(ctx.app, 'POST', `/api/patients/${p.id}/portal-activation`, { cookie: nurse })).json().activationCode
  const res = await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: p.mrn, activationCode: code, password: 'Patient-passphrase-1' } })
  return `adaxai_session=${res.cookies.find((c) => c.name === 'adaxai_session')!.value}`
}

describe('default deny', () => {
  it('every API route declares how access is decided; only the listed routes are public or open to any session', async () => {
    await ctx.app.ready()
    const inv = ctx.app.routeInventory
    expect(inv.length).toBeGreaterThan(100)
    const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`
    expect(inv.filter((r) => r.access === 'public').map(key).sort()).toEqual([...PUBLIC].sort())
    expect(inv.filter((r) => r.access === 'anySession').map(key).sort()).toEqual([...ANY_SESSION].sort())
    expect(inv.filter((r) => r.access === 'permission').every((r) => r.permission)).toBe(true)
  })

  it('a route that declares no access rule stops the API from starting', async () => {
    const app = Fastify()
    registerAuth(app, { db: ctx.db, cookieSecure: false })
    expect(() => app.get('/api/forgotten', async () => ({}))).toThrow(/declares no access rule/)
    await app.close()
  })

  it('every non-public route answers 401 without a session', async () => {
    await ctx.app.ready()
    for (const r of ctx.app.routeInventory.filter((x) => x.access !== 'public')) {
      const res = await call(ctx.app, r.method as 'GET', concrete(r.url), { body: r.method === 'GET' ? undefined : {} })
      expect([r.method, r.url, res.statusCode]).toEqual([r.method, r.url, 401])
    }
  })

  it('every role is refused every route its role has no permission for, and each refusal is audited', async () => {
    await ctx.app.ready()
    const sessions = { admin: await login(ctx.app, 't.admin'), doctor: await login(ctx.app, 't.doctor'), nurse: await login(ctx.app, 't.nurse'), patient: await patientSession() }
    await adminQuery("SET session_replication_role = replica; DELETE FROM audit_events WHERE action = 'access.denied';")
    let refused = 0
    for (const r of ctx.app.routeInventory.filter((x) => x.access === 'permission')) {
      for (const role of ROLES) {
        if (can(role, r.permission as Permission)) continue
        const res = await call(ctx.app, r.method as 'GET', concrete(r.url), { cookie: sessions[role], body: r.method === 'GET' ? undefined : {} })
        expect([role, r.method, r.url, res.statusCode]).toEqual([role, r.method, r.url, 403])
        refused++
      }
    }
    expect(refused).toBeGreaterThan(150)
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied' AND outcome = 'denied'")).rows[0].n).toBe(refused)
  })

  it('refusals inside a route are audited too (another doctor’s draft, another doctor’s signed record)', async () => {
    const nurse = await login(ctx.app, 't.nurse')
    const doctor = await login(ctx.app, 't.doctor')
    const other = await login(ctx.app, 't.doctor2')
    const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient() })).json())
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    expect((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: other, body: { version: e.version, note: e.note, diagnoses: [], prescription: [] } })).statusCode).toBe(403)
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { version: e.version, note: { ...e.note, chiefComplaint: 'Cough', assessment: 'Viral', plan: 'Fluids' }, diagnoses: [{ description: 'Viral URTI', kind: 'provisional' }], prescription: [] } })).json())
    await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })
    // Only the signing doctor amends a signed consultation.
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/amendments`, { cookie: other, body: { reason: 'Correction', content: 'Text' } })).statusCode).toBe(403)
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/amendments`, { cookie: doctor, body: { reason: 'Correction', content: 'Text' } })).statusCode).toBe(201)
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'access.denied' ORDER BY id")
    expect(rows.map((r) => r.details.route)).toEqual(['/api/encounters/:id/draft', '/api/encounters/:id/amendments'])
  })
})

describe('facility isolation', () => {
  it('staff of another facility reach none of this facility’s patients, consultations, staff, devices or audit trail', async () => {
    // A second facility with its own staff.
    const [f2] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
    const [d2] = await ctx.db.insert(departments).values({ facilityId: f2!.id, code: 'GEN', name: 'General Medicine' }).returning()
    const passwordHash = await hashPassword(TEST_PASSWORD)
    await ctx.db.insert(users).values([
      { facilityId: f2!.id, username: 'b.admin', fullName: 'B admin', role: 'admin', passwordHash },
      { facilityId: f2!.id, username: 'b.doctor', fullName: 'B doctor', role: 'doctor', passwordHash, departmentId: d2!.id },
      { facilityId: f2!.id, username: 'b.nurse', fullName: 'B nurse', role: 'nurse', passwordHash, departmentId: d2!.id },
    ])
    const nurseA = await login(ctx.app, 't.nurse')
    const doctorA = await login(ctx.app, 't.doctor')
    const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurseA, body: samplePatient() })).json())
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurseA, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctorA })).json())

    const adminB = await login(ctx.app, 'b.admin')
    const doctorB = await login(ctx.app, 'b.doctor')
    const nurseB = await login(ctx.app, 'b.nurse')
    for (const url of [`/api/patients/${p.id}`, `/api/patients/${p.id}/timeline`, `/api/patients/${p.id}/observations`, `/api/encounters/${e.id}`, `/api/visits/${v.id}`]) {
      expect([url, (await call(ctx.app, 'GET', url, { cookie: doctorB })).statusCode]).toEqual([url, 404])
    }
    expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/mana/questions`, { cookie: doctorB, body: { question: 'Briefing' } })).statusCode).toBe(404)
    expect(((await call(ctx.app, 'GET', '/api/patients', { cookie: nurseB })).json().patients as unknown[]).length).toBe(0)
    // Staff management, directory, overview and audit trail are per facility.
    const usersB = (await call(ctx.app, 'GET', '/api/admin/users', { cookie: adminB })).json().users as { username: string }[]
    expect(usersB.map((u) => u.username).sort()).toEqual(['b.admin', 'b.doctor', 'b.nurse'])
    expect(((await call(ctx.app, 'GET', '/api/staff', { cookie: nurseB })).json().staff as { fullName: string }[]).map((s) => s.fullName).sort()).toEqual(['B doctor', 'B nurse'])
    expect((await call(ctx.app, 'PATCH', `/api/admin/users/${fx.users.doctor}`, { cookie: adminB, body: { isActive: false } })).statusCode).toBe(404)
    expect((await call(ctx.app, 'POST', `/api/admin/users/${fx.users.admin}/reset-password`, { cookie: adminB, body: { temporaryPassword: 'Temporary-pass-99' } })).statusCode).toBe(404)
    expect((await call(ctx.app, 'GET', '/api/admin/overview', { cookie: adminB })).json().users).toEqual({ admin: { active: 1, total: 1 }, doctor: { active: 1, total: 1 }, nurse: { active: 1, total: 1 } })
    const trail = (await call(ctx.app, 'GET', '/api/admin/audit-events?limit=200', { cookie: adminB })).json().events as { patientId: string | null; actorUserId: string | null }[]
    expect(trail.some((ev) => ev.patientId === p.id)).toBe(false)
    expect(trail.some((ev) => ev.actorUserId === fx.users.nurse)).toBe(false)
    const ownTrail = (await call(ctx.app, 'GET', `/api/admin/audit-events?patientId=${p.id}`, { cookie: await login(ctx.app, 't.admin') })).json().events as unknown[]
    expect(ownTrail.length).toBeGreaterThan(0)
    // The other facility's probes are audited, with the reason.
    const { rows } = await adminQuery(`SELECT details FROM audit_events WHERE action = 'access.not_found' AND entity_id = '${p.id}'`)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.details.reason === 'other_facility')).toBe(true)
  })
})

describe('sign-in protection', () => {
  it('locks after five wrong passwords even when the guesses arrive at the same time', async () => {
    await Promise.all(Array.from({ length: 10 }, () => call(ctx.app, 'POST', '/api/auth/login', { body: { username: 't.nurse', password: 'Wrong-password-1' } })))
    const res = await call(ctx.app, 'POST', '/api/auth/login', { body: { username: 't.nurse', password: TEST_PASSWORD } })
    expect(res.statusCode).toBe(423)
  })

  it('a burst of concurrent guesses gets at most five password checks, and the correct one is not singled out', async () => {
    const guesses = Array.from({ length: 12 }, (_, i) => (i === 7 ? TEST_PASSWORD : `Wrong-password-${i}`))
    const res = await Promise.all(guesses.map((password) => call(ctx.app, 'POST', '/api/auth/login', { body: { username: 't.nurse', password } })))
    const codes = res.map((r) => r.statusCode)
    // 401 = checked and wrong, 200 = checked and right, 423 = refused before any check.
    expect(codes.filter((c) => c === 401 || c === 200).length).toBeLessThanOrEqual(5)
    expect(codes.filter((c) => c === 423).length).toBeGreaterThanOrEqual(7)
  })

  it('inactive accounts lock like any other, so the answers do not reveal which accounts exist', async () => {
    const admin = await login(ctx.app, 't.admin')
    await call(ctx.app, 'PATCH', `/api/admin/users/${fx.users.doctor2}`, { cookie: admin, body: { isActive: false } })
    for (let i = 0; i < 5; i++) expect((await call(ctx.app, 'POST', '/api/auth/login', { body: { username: 't.doctor2', password: 'Wrong-password-1' } })).statusCode).toBe(401)
    expect((await call(ctx.app, 'POST', '/api/auth/login', { body: { username: 't.doctor2', password: 'Wrong-password-1' } })).statusCode).toBe(423)
  })

  it('answers the same for unknown usernames (no account discovery) and never stores an unknown username', async () => {
    for (let i = 0; i < 5; i++) expect((await call(ctx.app, 'POST', '/api/auth/login', { body: { username: 'ADX-999999', password: 'Wrong-password-1' } })).statusCode).toBe(401)
    expect((await call(ctx.app, 'POST', '/api/auth/login', { body: { username: 'ADX-999999', password: 'Wrong-password-1' } })).statusCode).toBe(423)
    await call(ctx.app, 'POST', '/api/auth/login', { body: { username: 'My-Secret-Pass-7', password: 'x-wrong-password' } })
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'auth.login'")
    expect(JSON.stringify(rows)).not.toContain('My-Secret-Pass-7')
    expect(JSON.stringify(rows)).not.toContain('ADX-999999')
  })

  it('wrong current passwords at a password change count towards the lockout and end every session', async () => {
    const cookie = await login(ctx.app, 't.doctor')
    for (let i = 0; i < 4; i++) expect((await call(ctx.app, 'POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'Wrong-password-1', newPassword: 'Brand-new-pass-12' } })).statusCode).toBe(400)
    expect((await call(ctx.app, 'POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'Wrong-password-1', newPassword: 'Brand-new-pass-12' } })).statusCode).toBe(423)
    expect((await call(ctx.app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401)
  })

  it('rate limits sign-in per address and account (429 with Retry-After, audited once)', async () => {
    const base = loadAppSettings()
    const limited = createTestApp({ settings: { ...base, security: { rateLimits: { ...base.security.rateLimits, loginPerAccount: { max: 3, windowSeconds: 60 } } } } })
    try {
      for (let i = 0; i < 3; i++) await call(limited.app, 'POST', '/api/auth/login', { body: { username: 't.admin', password: 'Wrong-password-1' } })
      const res = await call(limited.app, 'POST', '/api/auth/login', { body: { username: 't.admin', password: TEST_PASSWORD } })
      expect([res.statusCode, res.json().error, Number(res.headers['retry-after']) > 0]).toEqual([429, 'rate_limited', true])
      await call(limited.app, 'POST', '/api/auth/login', { body: { username: 't.admin', password: TEST_PASSWORD } })
      expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.rate_limited'")).rows[0].n).toBe(1)
    } finally {
      await limited.close()
    }
  })
})

describe('audit volume', () => {
  it('requests without the CSRF header are refused every time but audited once per address and window', async () => {
    for (let i = 0; i < 4; i++) expect((await call(ctx.app, 'POST', '/api/auth/login', { csrf: false, body: { username: 'x', password: 'y' } })).statusCode).toBe(403)
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE details->>'code' = 'csrf_header_missing'")).rows[0].n).toBe(1)
  })
})

describe('logs', () => {
  it('request logs never contain search terms (names, phone numbers, MRNs)', async () => {
    const lines: string[] = []
    const stream = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) })
    const logged = createTestApp({ logger: { stream } })
    try {
      const nurse = await login(logged.app, 't.nurse')
      await call(logged.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient() })
      await call(logged.app, 'GET', '/api/patients', { cookie: nurse, query: { q: 'Lakshmi 98400' } })
      const text = lines.join('\n')
      expect(text).toContain('/api/patients')
      expect(text).not.toContain('Lakshmi')
      expect(text).not.toContain('98400')
      expect(text).not.toContain('adaxai_session=')
    } finally {
      await logged.close()
    }
  })
})
