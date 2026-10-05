import { CONSENT_VERSIONS, type ConsultationContext, type EvidenceItem, type PlannedCall, VITALS, type VitalKind } from '@adaxai/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildManaWorld, createManaBase, type ManaWorld } from '../src/eval/mana-fixture.ts'
import type { SessionUser } from '../src/auth/sessions.ts'
import type { Config } from '../src/config.ts'
import { CONFLICT_RULES_VERSION } from '../src/consultation-context/conflicts.ts'
import { SUMMARY_COMPOSER_VERSION } from '../src/consultation-context/summary.ts'
import { aiJobs, aiRuns, auscultationRecordings, clinicalFacts, deviceAssignments, devices, files, observations, thermalCaptures, thermalRois, transcripts, transcriptSegments } from '../src/db/schema.ts'
import { type ContextView, contextFacts } from '../src/mana/assistant/consultation.ts'
import { EntityBook } from '../src/mana/assistant/entities.ts'
import { runTool } from '../src/mana/assistant/tools.ts'
import { type ManaCtx } from '../src/mana/assistant/types.ts'
import { facilityToday } from '../src/patients/service.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { adminQuery, call, createTestApp, login, resetDatabase, TEST_PASSWORD, testConfig } from './helpers.ts'

// The tools are the only way Mana reaches a record, and none of them writes. These tests run them as a doctor of one clinic against a synthetic clinic
// (a second clinic, a few patients with histories, today's queue and appointments) and check what they return, to whom, and what they refuse.

const ctx = createTestApp()
let world: ManaWorld
let today = ''
const settings = loadAppSettings()

beforeAll(async () => {
  await resetDatabase()
  const base = await createManaBase(ctx.db, TEST_PASSWORD)
  world = await buildManaWorld({ call: (m, u, o) => call(ctx.app, m, u, o ?? {}), login: (u) => login(ctx.app, u), admin: (s, p) => adminQuery(s, p), db: ctx.db }, base, TEST_PASSWORD)
  today = await facilityToday(ctx.db, base.facilityId)
}, 120_000)
afterAll(() => ctx.close())

const WHO = { doctor: 'doctor', doctor2: 'doctor2' } as const
function me(who: 'doctor' | 'doctor2' | 'doctorB' | 'admin' | 'nurse'): SessionUser {
  const b = world.base
  const m = {
    doctor: { id: b.users.doctor, username: 't.doctor', facilityId: b.facilityId, departmentId: b.departments.gen, role: 'doctor' as const },
    doctor2: { id: b.users.doctor2, username: 't.doctor2', facilityId: b.facilityId, departmentId: b.departments.ped, role: 'doctor' as const },
    doctorB: { id: world.users.doctorB, username: 't.doctorB', facilityId: world.otherFacilityId, departmentId: world.otherDepartmentId, role: 'doctor' as const },
    admin: { id: b.users.admin, username: 't.admin', facilityId: b.facilityId, departmentId: null, role: 'admin' as const },
    nurse: { id: b.users.nurse, username: 't.nurse', facilityId: b.facilityId, departmentId: b.departments.gen, role: 'nurse' as const },
  }[who]
  return { ...m, sessionId: 'test', fullName: `Dr. ${m.username}`, patientId: null, mustChangePassword: false }
}

function mk(who: Parameters<typeof me>[0] = 'doctor', scope: ManaCtx['scope'] = { encounterId: null, patientId: null }, o: { book?: EntityBook; local?: boolean; config?: Config } = {}): ManaCtx {
  return { db: ctx.db, me: me(who), settings, scope, book: o.book ?? new EntityBook(), today, timeZone: 'Asia/Kolkata', now: new Date(), modelIsLocal: o.local ?? true, disclosed: new Set(), textShown: new Set(), denials: [], config: o.config }
}

const blank: PlannedCall = { tool: 'get_current_context', patient: null, topic: null, text: null, which: null, when: null, minutes: null, date: null, mine: null, status: null }
const plan = (c: Partial<PlannedCall> & Pick<PlannedCall, 'tool'>): PlannedCall => ({ ...blank, ...c })
const texts = (o: { facts: { text: string }[]; findings: { text: string }[] }) => [...o.facts.map((f) => f.text), ...o.findings.map((f) => f.text)].join('\n')

describe('what a tool returns', () => {
  it('reads one patient’s record by topic: the sentences, the records they rest on, and what the explicit rules found', async () => {
    const c = mk('doctor', { encounterId: null, patientId: world.p.meena.id })
    const r = await runTool(c, plan({ tool: 'get_patient_record', patient: 'current', topic: 'allergies' }))
    expect(r.status).toBe('ok')
    expect(r.patientId).toBe(world.p.meena.id)
    expect(texts(r)).toMatch(/Penicillin/)
    // The recorded allergy and the amoxicillin of the earlier prescription are the same group: a finding made by rules, not by a model.
    expect(r.findings.some((f) => f.kind === 'conflict' && /Amoxicillin/i.test(f.text))).toBe(true)
    const withSources = r.facts.find((f) => f.items.length)!
    expect(withSources.items[0]).toMatchObject({ kind: 'allergy' })
    expect(withSources.items[0]!.label).toMatch(/Allergy/)
  })

  it('names patients by a handle and never by a name, an MRN or a telephone number', async () => {
    const c = mk()
    const tools: PlannedCall[] = [
      plan({ tool: 'get_today_queue', status: 'any' }),
      plan({ tool: 'get_recent_visits', when: 'today' }),
      plan({ tool: 'get_my_consultations', when: 'today' }),
      plan({ tool: 'get_appointments', when: 'tomorrow' }),
      plan({ tool: 'get_patient_visits', patient: `mrn:${world.p.meena.mrn}` }),
      plan({ tool: 'get_patient_record', patient: `mrn:${world.p.rahulS.mrn}`, topic: 'briefing' }),
      plan({ tool: 'get_consultation', patient: `mrn:${world.p.meena.mrn}`, which: 'last' }),
      plan({ tool: 'find_patient', text: 'Anita Das' }),
    ]
    const seen: string[] = []
    for (const t of tools) {
      const r = await runTool(c, t)
      seen.push(texts(r), ...r.facts.flatMap((f) => f.items.map((i) => `${i.label} ${i.excerpt}`)))
      expect(['ok', 'empty'], `${t.tool}: ${r.detail}`).toContain(r.status)
    }
    const all = seen.join('\n')
    for (const p of Object.values(world.p)) {
      expect(all, p.name).not.toContain(p.name)
      expect(all, p.name).not.toContain(p.mrn)
      expect(all).not.toContain(p.name.split(' ')[0] + ' ' + p.name.split(' ')[1])
    }
    expect(all).not.toMatch(/\b94000\d{5}\b/)
    expect(all).toMatch(/\bP\d\b/)
  })

  it('keeps the older record, the patient’s own words and amendments apart from today’s visit, with dates in the clinic’s own words', async () => {
    const r = await runTool(mk(), plan({ tool: 'get_consultation', patient: `mrn:${world.p.meena.mrn}`, which: 'last' }))
    expect(r.status).toBe('ok')
    const t = texts(r)
    expect(t).toMatch(/Signed consultation of \d{1,2} \w{3,4} \d{4}/)
    expect(t).toMatch(/Acute pharyngitis/)
    expect(t).toMatch(/Amoxicillin/)
    // "the previous one" does not exist for a patient with one signed consultation.
    const previous = await runTool(mk(), plan({ tool: 'get_consultation', patient: `mrn:${world.p.meena.mrn}`, which: 'previous' }))
    expect(previous.status).toBe('not_found')
    expect(previous.findings[0]!.kind).toBe('absent')
  })

  it('says a patient has no visits, or no investigation results, as a statement about the record and not as a fact about the patient', async () => {
    const r = await runTool(mk(), plan({ tool: 'get_patient_visits', patient: `mrn:${world.p.zara.mrn}` }))
    // (Zara is a patient of the other clinic: for this doctor she does not exist.)
    expect(r.status).toBe('not_found')
    const none = await runTool(mk(), plan({ tool: 'get_patient_record', patient: `mrn:${world.p.anita.mrn}`, topic: 'investigations' }))
    expect(none.facts).toHaveLength(0)
    expect(none.findings[0]).toMatchObject({ kind: 'absent' })
    expect(none.findings[0]!.text).toMatch(/No investigation results are recorded/)
  })
})

describe('the clinic’s day', () => {
  it('counts today’s queue by status and lists the people still to be seen, as handles', async () => {
    const r = await runTool(mk(), plan({ tool: 'get_today_queue' }))
    expect(r.status).toBe('ok')
    expect(r.facts[0]!.text).toMatch(/1 waiting, 1 in triage, 1 ready for the doctor, 1 with a doctor, 2 completed/)
    const lines = r.facts.slice(1).map((f) => f.text)
    // Anita (waiting), Meena (in triage), Rahul Sharma (ready) and Vikram (with the doctor) are still open; the two completed visits are not listed.
    expect(lines).toHaveLength(4)
    expect(lines.join('\n')).toMatch(/waiting/)
    expect(lines.join('\n')).toMatch(/in triage/)
    expect(lines.join('\n')).toMatch(/with a doctor/)
    const done = await runTool(mk(), plan({ tool: 'get_today_queue', status: 'completed' }))
    expect(done.facts.slice(1)).toHaveLength(2)
  })

  it('finds the patient who checked in about two hours ago, and says which window it looked at', async () => {
    const c = mk()
    const r = await runTool(c, plan({ tool: 'get_recent_visits', when: 'minutes_ago', minutes: 120 }))
    expect(r.status).toBe('ok')
    expect(r.facts[0]!.text).toMatch(/Checked in between \d{1,2}:\d{2} [ap]m and \d{1,2}:\d{2} [ap]m/)
    const people = r.facts.slice(1)
    expect(people).toHaveLength(1)
    expect(people[0]!.text).toMatch(/Sore throat and fever returned/)
    expect(c.book.patientIdOf(people[0]!.patient!)).toBe(world.p.meena.id)
    // "In the last half hour" is a different question, with a different answer: the others checked in just now, she did not.
    const recent = await runTool(mk(), plan({ tool: 'get_recent_visits', when: 'last_minutes', minutes: 30 }))
    expect(recent.facts.slice(1).length).toBeGreaterThanOrEqual(3)
    expect(texts(recent)).not.toMatch(/Sore throat and fever returned/)
  })

  it('lists appointments in a window, and only the doctor’s own when asked', async () => {
    const all = await runTool(mk(), plan({ tool: 'get_appointments', when: 'tomorrow' }))
    expect(all.facts.slice(1)).toHaveLength(2)
    const mineOnly = await runTool(mk('doctor2'), plan({ tool: 'get_appointments', when: 'tomorrow', mine: true }))
    expect(mineOnly.status).toBe('empty')
    const mine = await runTool(mk('doctor'), plan({ tool: 'get_appointments', when: 'tomorrow', mine: true }))
    expect(mine.facts.slice(1)).toHaveLength(2)
    expect(texts(mine)).toMatch(/10:30 am/)
  })

  it('counts a doctor’s own consultations and nobody else’s', async () => {
    const one = await runTool(mk('doctor'), plan({ tool: 'get_my_consultations', when: 'today' }))
    expect(one.facts[0]!.text).toMatch(/1 signed that day, 1 open/)
    const two = await runTool(mk('doctor2'), plan({ tool: 'get_my_consultations', when: 'today' }))
    expect(two.facts[0]!.text).toMatch(/1 signed that day, 0 open/)
  })

  it('reports the clinic and its departments', async () => {
    const r = await runTool(mk(), plan({ tool: 'get_facility_information' }))
    expect(texts(r)).toMatch(/Test facility/)
    expect(texts(r)).toMatch(/General Medicine \(GEN\)/)
    expect(texts(r)).not.toMatch(/Other clinic/)
  })

  it('knows the open consultation and its patient, and says when none is open', async () => {
    const withOne = mk('doctor', { encounterId: world.openEncounterId, patientId: world.p.vikram.id })
    const r = await runTool(withOne, plan({ tool: 'get_current_context' }))
    expect(texts(r)).toMatch(/The open consultation is for P1/)
    expect(texts(r)).toMatch(/Cough and tiredness/)
    const without = await runTool(mk(), plan({ tool: 'get_current_context' }))
    expect(texts(without)).toMatch(/not about a particular patient/)
  })
})

describe('finding a patient never guesses', () => {
  it('a first name that fits two patients of the clinic is ambiguous, and the patient of another clinic with the same name is not among them', async () => {
    const c = mk()
    const r = await runTool(c, plan({ tool: 'find_patient', text: 'Rahul' }))
    expect(r.status).toBe('ambiguous')
    expect(r.candidates).toHaveLength(2)
    const ids = r.candidates.map((a) => c.book.patientIdOf(a))
    expect(ids).toEqual(expect.arrayContaining([world.p.rahulS.id, world.p.rahulV.id]))
    expect(ids).not.toContain(world.p.rahulM.id)
    // The same through a record question: nothing is read, the doctor is asked to choose.
    const q = await runTool(mk(), plan({ tool: 'get_patient_record', patient: 'name:Rahul', topic: 'allergies' }))
    expect(q.status).toBe('ambiguous')
    expect(q.facts).toHaveLength(0)
  })

  it('a full name that fits one patient is that patient; an MRN is exact; a stranger is not found', async () => {
    const c = mk()
    const one = await runTool(c, plan({ tool: 'find_patient', text: 'Rahul Sharma' }))
    expect(one.status).toBe('ok')
    expect(one.patientId).toBe(world.p.rahulS.id)
    const byMrn = await runTool(mk(), plan({ tool: 'get_patient_visits', patient: `mrn:${world.p.rahulV.mrn}` }))
    expect(byMrn.status).toBe('ok')
    expect((await runTool(mk(), plan({ tool: 'find_patient', text: 'Nobody Atall' }))).status).toBe('not_found')
  })

  it('a handle that the conversation never showed is not a patient', async () => {
    const c = mk()
    expect((await runTool(c, plan({ tool: 'get_patient_record', patient: 'P7', topic: 'allergies' }))).status).toBe('not_found')
    expect((await runTool(c, plan({ tool: 'get_patient_record', patient: world.p.meena.id, topic: 'allergies' }))).status).toBe('not_found')
    expect((await runTool(c, plan({ tool: 'get_patient_record', patient: 'current', topic: 'allergies' }))).status).toBe('not_found')
  })
})

describe('what a tool will not do', () => {
  it('another clinic’s patients, and everything about them, are out of reach: by name, by MRN, by handle or by identifier', async () => {
    const c = mk()
    for (const handle of ['name:Rahul Mehta', 'name:Mehta', `mrn:${world.p.rahulM.mrn}`, 'name:Zara Khan', `mrn:${world.p.zara.mrn}`]) {
      const r = await runTool(c, plan({ tool: 'get_patient_record', patient: handle, topic: 'briefing' }))
      expect(r.status, handle).toBe('not_found')
      expect(r.facts, handle).toHaveLength(0)
    }
    // Even a scope that points at the other clinic's patient (a forged conversation) reads nothing.
    const forged = mk('doctor', { encounterId: null, patientId: world.p.rahulM.id })
    expect((await runTool(forged, plan({ tool: 'get_patient_record', patient: 'current', topic: 'briefing' }))).status).toBe('not_found')
    // The queue and the schedule are this clinic's: the other clinic's visit of today is not in it.
    const queue = await runTool(mk(), plan({ tool: 'get_today_queue', status: 'any' }))
    expect(texts(queue)).not.toMatch(/Wheeze/)
    // And from the other clinic the first clinic's patients do not exist.
    const b = mk('doctorB')
    expect((await runTool(b, plan({ tool: 'find_patient', text: 'Meena' }))).status).toBe('not_found')
    const bq = await runTool(b, plan({ tool: 'get_today_queue', status: 'any' }))
    expect(texts(bq)).toMatch(/Wheeze/)
    expect(texts(bq)).not.toMatch(/Sore throat/)
  })

  it('a role without the permission reads nothing, before anything is looked up', async () => {
    const admin = mk('admin')
    for (const t of [plan({ tool: 'find_patient', text: 'Meena' }), plan({ tool: 'get_patient_record', patient: `mrn:${world.p.meena.mrn}`, topic: 'allergies' }), plan({ tool: 'get_today_queue' }), plan({ tool: 'get_my_consultations' })]) {
      const r = await runTool(admin, t)
      expect(r.status, t.tool).toBe('refused')
      expect(r.facts).toHaveLength(0)
    }
    expect((await runTool(admin, plan({ tool: 'get_facility_information' }))).status).toBe('ok')
  })

  it('refuses a role that lacks the permission BEFORE it touches the database at all: the check comes first, not after a read', async () => {
    // A database that throws on any use: if a tool looked anything up before checking the role, the call would not come back as a plain refusal.
    const untouched = new Proxy({}, { get: () => { throw new Error('the database was touched') } }) as never
    const admin: ManaCtx = { ...mk('admin'), db: untouched }
    for (const t of [plan({ tool: 'find_patient', text: 'Meena' }), plan({ tool: 'get_patient_record', patient: 'name:Meena', topic: 'allergies' }), plan({ tool: 'get_patient_visits', patient: 'name:Meena' }), plan({ tool: 'get_consultation', patient: 'name:Meena', which: 'last' }), plan({ tool: 'get_today_queue' }), plan({ tool: 'get_recent_visits', when: 'today' }), plan({ tool: 'get_appointments', when: 'today' }), plan({ tool: 'get_my_consultations' })]) {
      const r = await runTool(admin, t)
      expect(r, t.tool).toMatchObject({ status: 'refused', detail: 'Your role is not allowed to read that.', facts: [], findings: [] })
    }
    // (A nurse holds the platform's own read permissions for patients, the queue and consultations, so the tools would not refuse a nurse: it is the route,
    // which is for doctors only, that keeps a nurse out of Mana: see "is for doctors" in mana-assistant.test.ts.)
  })

  it('a malformed call is refused with a reason and reads nothing', async () => {
    const c = mk()
    expect((await runTool(c, plan({ tool: 'get_consultation', patient: `mrn:${world.p.meena.mrn}`, which: 'date' }))).status).toBe('invalid')
    expect((await runTool(c, plan({ tool: 'get_recent_visits', when: 'last_minutes' }))).status).toBe('invalid')
    expect((await runTool(c, plan({ tool: 'get_recent_visits', when: 'next_minutes', minutes: 30 }))).status).toBe('invalid')
    expect((await runTool(c, plan({ tool: 'get_appointments', when: 'date' }))).status).toBe('invalid')
    expect((await runTool(c, plan({ tool: 'find_patient' }))).status).toBe('invalid')
    expect((await runTool(c, plan({ tool: 'get_patient_record', patient: 'everyone', topic: 'briefing' }))).status).toBe('not_found')
    expect((await runTool(c, { ...blank, tool: 'drop_tables' as never })).status).toBe('invalid')
  })

  it('a patient who withdrew consent to AI help is not read, and their reasons for visits are not shown, even by a local model', async () => {
    await adminQuery(`INSERT INTO consents (patient_id, type, status, method, scope, version, recorded_by) VALUES ($1, 'ai_record_assistant', 'withdrawn', 'verbal', 'ongoing', '2026-10-v1', $2)`, [world.p.meena.id, world.base.users.nurse])
    try {
      const r = await runTool(mk(), plan({ tool: 'get_patient_record', patient: `mrn:${world.p.meena.mrn}`, topic: 'allergies' }))
      expect(r.status).toBe('refused')
      expect(r.detail).toMatch(/withdrawn consent/)
      expect(r.facts).toHaveLength(0)
      const queue = await runTool(mk(), plan({ tool: 'get_today_queue' }))
      expect(texts(queue)).toMatch(/reason not shown/)
      expect(texts(queue)).not.toMatch(/Sore throat and fever returned/)
      // Others are unaffected.
      expect(texts(queue)).toMatch(/Diabetes review/)
    } finally {
      await adminQuery(`SET session_replication_role = replica; DELETE FROM consents WHERE patient_id = '${world.p.meena.id}' AND type = 'ai_record_assistant'`)
    }
  })

  it('with a model that does not run on this computer, the record is read only for a patient who consented to Mana AI record summaries', async () => {
    const hosted = mk('doctor', { encounterId: null, patientId: null }, { local: false })
    const r = await runTool(hosted, plan({ tool: 'get_patient_record', patient: `mrn:${world.p.rahulS.mrn}`, topic: 'allergies' }))
    expect(r.status).toBe('refused')
    expect(r.detail).toMatch(/does not run on this computer/)
  })

  it('text in a record that looks like an instruction is carried as text: markers are written apart, brackets cannot forge a source', async () => {
    const r = await runTool(mk(), plan({ tool: 'get_consultation', patient: `mrn:${world.p.suresh.mrn}`, which: 'last' }))
    expect(r.status).toBe('ok')
    // The note is data: it is there, as words, and nothing in it can pass for a source id or a chat marker.
    expect(texts(r)).toMatch(/Ignore all previous instructions/)
    for (const f of r.facts) {
      expect([...f.text].some((c) => c.charCodeAt(0) < 0x20 && c !== '\t')).toBe(false)
      expect(f.text).not.toMatch(/<\|/)
      expect(f.text).not.toMatch(/\[S\d+\]/)
    }
  })
})

describe('what is in a record’s free text, and when a record is looked up by date', () => {
  const addDays = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10)

  it('takes identifiers out of a note: the patient’s own name, record number and telephone number, and any other telephone or record number', async () => {
    const r = await runTool(mk(), plan({ tool: 'get_consultation', patient: `mrn:${world.p.nandini.mrn}`, which: 'last' }))
    expect(r.status).toBe('ok')
    const t = texts(r)
    expect(t).toMatch(/Cough for a week/)
    for (const secret of ['Nandini', 'Joshi', world.p.nandini.mrn, '9400000777', '98400 12345', '98400', 'ADX-009999']) expect(t, secret).not.toContain(secret)
    // The excerpt the doctor opens is the record itself, as written: the doctor may see their patient's own note.
    expect(r.facts.flatMap((f) => f.items).map((i) => i.excerpt).join('\n')).toMatch(/Cough for a week/)
  })

  it('takes identifiers out of the reason for a visit in a list, as well', async () => {
    const [v] = (await adminQuery(`select id, chief_complaint from visits where patient_id = $1 and visit_date = $2`, [world.p.anita.id, today])).rows
    try {
      await adminQuery(`update visits set chief_complaint = $2 where id = $1`, [v.id, `Headache; Anita Das (${world.p.anita.mrn}) rang from 9400000888 or 94000 00001; quote ADX-007777`])
      const queue = await runTool(mk(), plan({ tool: 'get_today_queue' }))
      const t = texts(queue)
      expect(t).toMatch(/Headache/)
      for (const secret of ['Anita', 'Das', world.p.anita.mrn, '9400000888', '94000 00001', 'ADX-007777']) expect(t, secret).not.toContain(secret)
      const recent = await runTool(mk(), plan({ tool: 'get_recent_visits', when: 'today' }))
      expect(texts(recent)).not.toMatch(/9400000888|ADX-007777/)
    } finally {
      await adminQuery(`update visits set chief_complaint = $2 where id = $1`, [v.id, v.chief_complaint])
    }
  })

  it('finds a signed consultation by its date in the clinic’s own days, and says how far it looked when there is none', async () => {
    const day = addDays(today, -14)
    const found = await runTool(mk(), plan({ tool: 'get_consultation', patient: `mrn:${world.p.rahulS.mrn}`, which: 'date', date: day }))
    expect(found.status).toBe('ok')
    expect(texts(found)).toMatch(/Diabetes|diabetes/)
    const other = await runTool(mk(), plan({ tool: 'get_consultation', patient: `mrn:${world.p.rahulS.mrn}`, which: 'date', date: addDays(today, -13) }))
    expect(other.status).toBe('not_found')
    expect(other.findings[0]!.text).toMatch(/^No signed consultation of this patient is recorded on /)
    // Nothing was left out of the search for a patient with so few consultations, so the answer does not say that anything was.
    expect(other.findings[0]!.text).not.toMatch(/most recent/)
  })

  it('counts a doctor’s consultations of a day in the database, not in the rows it lists: 25 signed are 25, and the listing says it is cut', async () => {
    const day = addDays(today, -3)
    const f = world.base.facilityId
    const ids = `'${f}', '${world.p.priya.id}', '${world.base.departments.gen}', '${world.base.users.doctor}'`
    await adminQuery(`
      SET session_replication_role = replica;
      WITH v AS (
        INSERT INTO visits (facility_id, patient_id, department_id, assigned_doctor_id, visit_date, token_number, status, checked_in_at, status_changed_at)
        SELECT ${ids}, '${day}'::date, g, 'completed', now() - interval '3 days', now() - interval '3 days' FROM generate_series(1, 25) g RETURNING id)
      INSERT INTO encounters (facility_id, patient_id, visit_id, doctor_id, status, started_at, signed_at, signed_snapshot, content_hash)
      SELECT '${f}', '${world.p.priya.id}', v.id, '${world.base.users.doctor}', 'signed', (('${day}'::date + time '10:00') at time zone 'Asia/Kolkata'), (('${day}'::date + time '10:30') at time zone 'Asia/Kolkata'), '{}'::jsonb, 'x' FROM v`)
    try {
      const r = await runTool(mk(), plan({ tool: 'get_my_consultations', when: 'date', date: day }))
      expect(r.facts[0]!.text).toMatch(/: 25 signed that day, 0 open \(started that day, not signed\), 0 discarded\./)
      expect(r.facts.slice(1)).toHaveLength(20)
      expect(r.findings[0]!.text).toMatch(/Only the first 20 consultations are listed; the counts above are of all of them\./)
    } finally {
      await adminQuery(`SET session_replication_role = replica; DELETE FROM encounters WHERE visit_id IN (SELECT id FROM visits WHERE facility_id = '${f}' AND visit_date = '${day}'::date); DELETE FROM visits WHERE facility_id = '${f}' AND visit_date = '${day}'::date`)
    }
  })

  it('says what its summary of visits says: the newest visit with its state, and whether any was completed', async () => {
    const r = await runTool(mk(), plan({ tool: 'get_patient_visits', patient: `mrn:${world.p.anita.mrn}` }))
    expect(r.facts[0]!.text).toMatch(/^The most recent visit on record was on .* \(waiting\); no completed visit is recorded among the visits read\.$/)
    const meena = await runTool(mk(), plan({ tool: 'get_patient_visits', patient: `mrn:${world.p.meena.mrn}` }))
    expect(meena.facts[0]!.text).toMatch(/the last completed visit was on /)
  })
})

describe('naming a patient', () => {
  it('needs every word the doctor wrote as a whole word of the name: a start of a name, or a longer name, is not that patient', async () => {
    const c = mk()
    for (const handle of ['name:Ani', 'name:Anit', 'name:Meena Kum', 'name:Das An']) expect((await runTool(c, plan({ tool: 'get_patient_record', patient: handle, topic: 'briefing' }))).status, handle).toBe('not_found')
    expect((await runTool(mk(), plan({ tool: 'get_patient_record', patient: 'name:Anita', topic: 'allergies' }))).status).toBe('ok')
    expect((await runTool(mk(), plan({ tool: 'get_patient_record', patient: 'name:Meena Kumar', topic: 'allergies' }))).status).toBe('ok')
  })

  it('a conversation can show sixty different patients; the sixty-first is refused in words, and nothing else is shown from that call', async () => {
    const book = new EntityBook(Array.from({ length: 60 }, (_, i) => ({ alias: `P${i + 1}`, patientId: crypto.randomUUID() })))
    const c = mk('doctor', { encounterId: null, patientId: null }, { book })
    const r = await runTool(c, plan({ tool: 'get_today_queue' }))
    expect(r.status).toBe('refused')
    expect(r.detail).toMatch(/at most 60 different patients/)
  })
})

describe('with a model that does not run on this computer', () => {
  it('shows no reason for a visit, in any list, of a patient who has not consented to Mana AI record summaries', async () => {
    const hosted = () => mk('doctor', { encounterId: null, patientId: null }, { local: false })
    const queue = await runTool(hosted(), plan({ tool: 'get_today_queue' }))
    expect(texts(queue)).toMatch(/reason not shown/)
    expect(texts(queue)).not.toMatch(/Headache for two days|Diabetes review|Sore throat and fever returned|Cough and tiredness/)
    const recent = await runTool(hosted(), plan({ tool: 'get_recent_visits', when: 'today' }))
    expect(texts(recent)).not.toMatch(/Headache for two days|Diabetes review|Sore throat and fever returned|Cough and tiredness/)
    const appts = await runTool(hosted(), plan({ tool: 'get_appointments', when: 'tomorrow' }))
    expect(texts(appts)).toMatch(/reason not shown/)
    expect(texts(appts)).not.toMatch(/Blood pressure follow-up|Review of headache/)
    const visits = await runTool(hosted(), plan({ tool: 'get_patient_visits', patient: `mrn:${world.p.anita.mrn}` }))
    expect(visits.status).toBe('refused')
    // The consultation open now: its reason is not shown either.
    const context = await runTool(mk('doctor', { encounterId: world.openEncounterId, patientId: world.p.vikram.id }, { local: false }), plan({ tool: 'get_current_context' }))
    expect(texts(context)).not.toMatch(/Cough and tiredness/)
  })
})

// ---- D2: the consultation the conversation was opened in --------------------------------------------------------------------------------------
// What Vikram's open consultation holds is written straight into the test database (the routes that make these records are tested in their own files):
// staff vital signs, a band's reading that disagrees with one of them, a simulator's reading, a stethoscope recording (with a note typed beside it) and a
// simulator's tones, an approved thermal image and a simulated one. Everything is removed again afterwards.

interface Held {
  observations: string[]
  devices: string[]
  recordings: string[]
  captures: string[]
  files: string[]
}

async function holdConsultationRecords(): Promise<Held> {
  const b = world.base
  const p = world.p.vikram
  const encounterId = world.openEncounterId
  const visitId = p.visitId!
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)
  const held: Held = { observations: [], devices: [], recordings: [], captures: [], files: [] }
  const file = async (kind: string) => {
    const [f] = await ctx.db.insert(files).values({ facilityId: b.facilityId, patientId: p.id, encounterId, kind, storageKey: `test/${crypto.randomUUID()}`, mimeType: 'application/octet-stream', sizeBytes: 1000, sha256: 'a'.repeat(64), uploadedBy: b.users.doctor }).returning({ id: files.id })
    held.files.push(f!.id)
    return f!.id
  }
  const reading = async (kind: VitalKind, value: number, minutesAgo: number, from: { deviceId: string; simulated: boolean } | null) => {
    const by = from ? { source: 'device' as const, validationStatus: from.simulated ? 'simulated' : 'device_unverified', deviceId: from.deviceId } : { source: 'manual' as const, validationStatus: 'manual_entry', recordedBy: b.users.nurse }
    const [o] = await ctx.db.insert(observations).values({ patientId: p.id, visitId, kind, value, unit: VITALS[kind].unit, measuredAt: ago(minutesAgo), createdAt: ago(minutesAgo), ...by }).returning({ id: observations.id })
    held.observations.push(o!.id)
  }
  const band = async (label: string, integration: string) => {
    const [d] = await ctx.db.insert(devices).values({ facilityId: b.facilityId, kind: 'wearable_band', label, serialNumber: `SN-${crypto.randomUUID().slice(0, 8)}`, integration, lastSeenAt: new Date(), createdBy: b.users.admin }).returning({ id: devices.id })
    held.devices.push(d!.id)
    return d!.id
  }
  await reading('spo2', 97, 3, null)
  await reading('heart_rate', 88, 3, null)
  const ward = await band('Ward band', 'gateway_api')
  await ctx.db.insert(deviceAssignments).values({ deviceId: ward, patientId: p.id, visitId, encounterId, assignedBy: b.users.nurse, assignedAt: ago(60) })
  await reading('spo2', 94, 2, { deviceId: ward, simulated: false })
  const sim = await band('Sim band', 'simulator')
  // (A device's reading is the consultation's only while the device is attached to the patient: the simulator is attached too.)
  await ctx.db.insert(deviceAssignments).values({ deviceId: sim, patientId: p.id, visitId, encounterId, assignedBy: b.users.nurse, assignedAt: ago(60) })
  await reading('spo2', 81, 1, { deviceId: sim, simulated: true })
  for (const r of [
    { site: 'mitral', durationMs: 38_000, captureMethod: 'file_upload', simulated: false, note: 'Sentinel-steth-note: soft murmur', deviceId: null },
    { site: 'aortic', durationMs: 12_000, captureMethod: 'gateway', simulated: true, note: null, deviceId: sim },
  ]) {
    const [row] = await ctx.db.insert(auscultationRecordings).values({ facilityId: b.facilityId, patientId: p.id, encounterId, fileId: await file('stethoscope_audio'), dataOrigin: 'synthetic', createdBy: b.users.doctor, createdAt: ago(5), ...r }).returning({ id: auscultationRecordings.id })
    held.recordings.push(row!.id)
  }
  for (const simulated of [false, true]) {
    const [t] = await ctx.db
      .insert(thermalCaptures)
      .values({
        facilityId: b.facilityId,
        patientId: p.id,
        encounterId,
        rawFileId: await file('thermal_raw'),
        matrixFileId: await file('thermal_matrix'),
        width: 160,
        height: 120,
        minC: simulated ? 20.5 : 28.1,
        maxC: simulated ? 25.5 : 34.6,
        meanC: simulated ? 22.2 : 31.2,
        stdC: 1.1,
        camera: simulated ? { make: null, model: 'ADAXAI thermal simulator (SIMULATED)', dateTime: null } : { make: 'FLIR', model: 'FLIR ONE Pro', dateTime: null },
        parameters: {},
        extractor: simulated ? { name: 'thermal-sim', version: 'thermal-sim-v1' } : { name: 'flir-extract', version: '1.0' },
        protocol: { bodyRegion: 'Knees', bodySite: 'knee', view: 'anterior' },
        dataOrigin: 'synthetic',
        captureSource: simulated ? 'simulator' : 'live_capture',
        simulated,
        capturedAt: simulated ? null : ago(10),
        createdBy: b.users.doctor,
        createdAt: ago(10),
      })
      .returning({ id: thermalCaptures.id })
    held.captures.push(t!.id)
    const stats = (min: number, max: number, mean: number) => ({ pixelCount: 400, min, max, mean, std: 0.8 })
    await ctx.db.insert(thermalRois).values([
      { captureId: t!.id, label: 'Left knee', shape: 'rect', x: 10, y: 10, width: 20, height: 20, stats: simulated ? stats(21, 24, 22.5) : stats(30.1, 33.9, 32), sortOrder: 0, createdBy: b.users.doctor },
      { captureId: t!.id, label: 'Right knee', shape: 'rect', x: 60, y: 10, width: 20, height: 20, stats: simulated ? stats(20.6, 23.4, 21.9) : stats(29.8, 32.5, 31.1), sortOrder: 1, createdBy: b.users.doctor },
    ])
    if (!simulated) await ctx.db.update(thermalCaptures).set({ status: 'approved', reviewedBy: b.users.doctor, reviewedAt: ago(8) }).where(eq(thermalCaptures.id, t!.id))
  }
  return held
}

async function releaseConsultationRecords(h: Held) {
  const ids = (list: string[]) => list.map((id) => `'${id}'`).join(', ') || 'NULL'
  await adminQuery(`SET session_replication_role = replica;
    DELETE FROM thermal_rois WHERE capture_id IN (${ids(h.captures)});
    DELETE FROM thermal_captures WHERE id IN (${ids(h.captures)});
    DELETE FROM auscultation_recordings WHERE id IN (${ids(h.recordings)});
    DELETE FROM observations WHERE id IN (${ids(h.observations)});
    DELETE FROM device_assignments WHERE device_id IN (${ids(h.devices)});
    DELETE FROM devices WHERE id IN (${ids(h.devices)});
    DELETE FROM files WHERE id IN (${ids(h.files)})`)
}

describe('the consultation the conversation was opened in (D2)', () => {
  let held: Held
  beforeAll(async () => {
    held = await holdConsultationRecords()
  })
  afterAll(async () => {
    if (held) await releaseConsultationRecords(held)
  })

  const inConsultation = (who: Parameters<typeof me>[0] = 'doctor', o: { book?: EntityBook; local?: boolean; config?: Config } = {}) => mk(who, { encounterId: world.openEncounterId, patientId: world.p.vikram.id }, { config: testConfig, ...o })
  const consultation = (topic: string | null = 'consultation_recorded', patient: string | null = 'current') => plan({ tool: 'consultation_context', patient, topic: topic as PlannedCall['topic'] })
  const factTexts = (o: { facts: { text: string }[] }) => o.facts.map((f) => f.text).join('\n')
  /** Everything a SIMULATED item of this consultation could leak: the simulator's reading, its tones, its generated temperatures, its devices. */
  const SIMULATED_VALUES = /\b81 %|\b20\.5\b|\b25\.5\b|\b22\.2\b|\b21\.9\b|\b22\.5\b|aortic|Sim band|thermal simulator|thermal-sim/i

  it('reads what the consultation holds, each fact with how far it can be trusted in the screen’s words, and links each to the consultation', async () => {
    const r = await runTool(inConsultation(), consultation())
    expect(r.status).toBe('ok')
    expect(r.patientId).toBe(world.p.vikram.id)
    const t = factTexts(r)
    expect(t).toMatch(/Device reading: SpO₂ 94 %\. Device reading, unverified\. [A-Z ·]+, at .*Ward band \(gateway\)\./)
    expect(t).toMatch(/Vital sign: SpO₂ 97 %\. Entered by staff\. Recorded, at /)
    expect(t).toMatch(/Vital sign: Heart rate 88 bpm\. Entered by staff\./)
    expect(t).toMatch(/Stethoscope: Recording 38 s, mitral area \(apex\)\. Recorded, not analysed\. Recorded, at .* Uploaded file · recording available for clinician review; not analysed\./)
    expect(t).toMatch(/Thermal image, Knee\. Measured\. Approved, at .*FLIR ONE Pro \(live capture\)\./)
    // Every fact carries its trust for the answer checks, rests on an item of this consultation, and names the patient only by a handle.
    expect(r.facts.every((f) => !!f.trust && f.patient === 'P1' && f.items.length > 0 && f.items.every((i) => i.link?.to === 'encounter' && i.link.id === world.openEncounterId))).toBe(true)
    expect(r.facts.find((f) => /Ward band/.test(f.text))).toMatchObject({ trust: 'measured_unverified', items: [expect.objectContaining({ kind: 'vital', status: expect.stringMatching(/^(LIVE|STALE|DISCONNECTED|NO DATA|UNAVAILABLE)$/) })] })
    expect(r.facts.find((f) => f.text.startsWith('Stethoscope:'))).toMatchObject({ trust: 'recorded', items: [expect.objectContaining({ kind: 'consultation' })] })
    expect(`${t}\n${texts(r)}`).not.toMatch(/Vikram|Rao|\bADX-/)
    // The records that disagree are a finding the server shows (both sides, nothing resolved), with the items on each side.
    const conflict = r.findings.find((f) => f.kind === 'conflict')!
    expect(conflict.text).toMatch(new RegExp(String.raw`^Found by fixed rules \(${CONFLICT_RULES_VERSION}\), not resolved: Staff measured SpO₂ 97 % at .*; a device \(unverified\) sent 94 % at `))
    expect(conflict.items).toHaveLength(2)
    expect(r.detail).toMatch(new RegExp(String.raw`^recorded: \d+ fact\(s\), \d+ finding\(s\); \d+ item\(s\), 3 SIMULATED left out; 1 conflict\(s\), \d+ missing; ${CONFLICT_RULES_VERSION}, ${SUMMARY_COMPOSER_VERSION}$`))
  })

  it('gives the model nothing SIMULATED, not even labelled, and tells the doctor how many were left out', async () => {
    for (const topic of ['consultation_recorded', 'consultation_review', 'consultation_missing', 'consultation_thermal']) {
      const r = await runTool(inConsultation(), consultation(topic))
      expect(r.status, topic).toBe('ok')
      expect(factTexts(r), topic).not.toMatch(SIMULATED_VALUES)
      expect(texts(r), topic).not.toMatch(SIMULATED_VALUES)
      // The only fact that says SIMULATED is a count of what waits for review, never a value.
      expect(r.facts.filter((f) => /SIMULATED/.test(f.text)).every((f) => f.text.startsWith('To review: 1 thermal image, not yet approved or rejected (1 of them SIMULATED).')), topic).toBe(true)
      // The note typed beside the recording is not read.
      expect(texts(r), topic).not.toMatch(/Sentinel-steth|murmur/)
    }
    const recorded = await runTool(inConsultation(), consultation('consultation_recorded'))
    expect(recorded.findings).toContainEqual(expect.objectContaining({ kind: 'absent', text: '3 SIMULATED items are in this consultation (made by a simulator, not measurements). Mana does not use them; the consultation screen shows them, marked SIMULATED.' }))
  })

  it('says what waits for review, what is missing and what the approved thermal image measured, in the context’s own counts, lines and statements', async () => {
    const review = await runTool(inConsultation(), consultation('consultation_review'))
    expect(review.facts.map((f) => f.text)).toEqual([
      'To review: 1 thermal image, not yet approved or rejected (1 of them SIMULATED). Fixed rules, not AI.',
      'Records of this consultation that disagree, found by fixed rules and not resolved: 1. Fixed rules, not AI.',
    ])
    expect(review.findings.map((f) => f.kind)).toEqual(['conflict'])
    const missing = await runTool(inConsultation(), consultation('consultation_missing'))
    expect(missing.facts.map((f) => f.text)).toEqual(['No conversation captured in this consultation. Fixed rules, not AI.', 'No AI draft made in this consultation. Fixed rules, not AI.'])
    expect(missing.facts.every((f) => f.trust === 'rule_output' && f.items[0]!.link?.id === world.openEncounterId)).toBe(true)
    const thermal = await runTool(inConsultation(), consultation('consultation_thermal'))
    expect(thermal.facts[0]).toMatchObject({
      trust: 'measured',
      text: 'Thermal image of “Knee” (approved): whole image min 28.1 °C, max 34.6 °C, mean 31.2 °C; region “Left knee” min 30.1 °C, max 33.9 °C, mean 32 °C; region “Right knee” min 29.8 °C, max 32.5 °C, mean 31.1 °C. Skin-surface temperature only. Measured.',
    })
    expect(thermal.facts.slice(1).map((f) => f.text)).toEqual([expect.stringMatching(/^Thermal image, Knee\. Measured\. Approved, at /)])
    expect(thermal.findings).toEqual([expect.objectContaining({ kind: 'absent', text: expect.stringMatching(/^1 SIMULATED thermal item is in this consultation/) })])
    // Another doctor of the clinic reads the same consultation without its AI draft (shown to its doctor only), and is told so.
    const other = await runTool(inConsultation('doctor2'), consultation('consultation_missing'))
    expect(other.facts.map((f) => f.text)).toEqual(['No conversation captured in this consultation. Fixed rules, not AI.'])
    expect(other.findings).toEqual([expect.objectContaining({ kind: 'absent', text: 'The AI draft of this consultation is shown to its doctor only, so it is not part of what Mana read.' })])
  })

  it('is read-only: it reads through a database handle that refuses every write', async () => {
    const real = ctx.db
    const writes = new Set(['insert', 'update', 'delete', 'transaction'])
    const readOnly = new Proxy(real, {
      get(target, key) {
        if (typeof key === 'string' && writes.has(key)) throw new Error(`the consultation tool tried to ${key}`)
        const v = Reflect.get(target, key) as unknown
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    for (const topic of ['consultation_recorded', 'consultation_review', 'consultation_missing', 'consultation_thermal']) {
      const r = await runTool({ ...inConsultation(), db: readOnly }, consultation(topic))
      expect(r.status, `${topic}: ${r.detail}`).toBe('ok')
    }
  })

  it('reads only the consultation the conversation was opened in, for its own patient, and nothing of another clinic’s', async () => {
    // A conversation about the clinic, or about the patient's record, has no consultation: refused, nothing read.
    for (const scope of [{ encounterId: null, patientId: null }, { encounterId: null, patientId: world.p.vikram.id }]) {
      const r = await runTool(mk('doctor', scope), consultation())
      expect(r).toMatchObject({ status: 'refused', facts: [], findings: [], patientId: null })
      expect(r.detail).toMatch(/not opened in a consultation/)
    }
    // Another patient of the same clinic, by handle or by name: refused, before anything of the consultation is read.
    const book = new EntityBook([
      { alias: 'P1', patientId: world.p.vikram.id },
      { alias: 'P2', patientId: world.p.meena.id },
    ])
    for (const patient of ['P2', 'name:Meena Kumar', `mrn:${world.p.meena.mrn}`]) {
      const r = await runTool(inConsultation('doctor', { book }), consultation('consultation_recorded', patient))
      expect(r, patient).toMatchObject({ status: 'refused', facts: [], findings: [] })
    }
    // A forged conversation that pairs this consultation with another patient reads nothing.
    const forged = await runTool(mk('doctor', { encounterId: world.openEncounterId, patientId: world.p.meena.id }), consultation())
    expect(forged).toMatchObject({ status: 'not_found', facts: [], findings: [] })
    // A doctor of the other clinic: the patient, and then the consultation, are "not found", and the audit log can tell why.
    const b = mk('doctorB', { encounterId: world.openEncounterId, patientId: world.p.vikram.id })
    expect(await runTool(b, consultation())).toMatchObject({ status: 'not_found', facts: [] })
    expect(b.denials).toEqual([expect.objectContaining({ entityType: 'patient', entityId: world.p.vikram.id, reason: 'other_facility' })])
    const own = mk('doctorB', { encounterId: world.openEncounterId, patientId: world.p.rahulM.id })
    expect(await runTool(own, consultation())).toMatchObject({ status: 'not_found', facts: [] })
    expect(own.denials).toEqual([expect.objectContaining({ entityType: 'encounter', entityId: world.openEncounterId, reason: 'other_facility' })])
  })

  it('asks the same of the caller as the other record tools: the role’s permissions before anything is read, and the patient’s consent to AI help', async () => {
    const untouched = new Proxy({}, { get: () => { throw new Error('the database was touched') } }) as never
    expect(await runTool({ ...inConsultation('admin'), db: untouched }, consultation())).toMatchObject({ status: 'refused', detail: 'Your role is not allowed to read that.', facts: [] })
    await adminQuery(`INSERT INTO consents (patient_id, type, status, method, scope, version, recorded_by) VALUES ($1, 'ai_record_assistant', 'withdrawn', 'verbal', 'ongoing', '2026-10-v1', $2)`, [world.p.vikram.id, world.base.users.nurse])
    try {
      const r = await runTool(inConsultation(), consultation())
      expect(r).toMatchObject({ status: 'refused', facts: [], findings: [] })
      expect(r.detail).toMatch(/withdrawn consent/)
    } finally {
      await adminQuery(`SET session_replication_role = replica; DELETE FROM consents WHERE patient_id = '${world.p.vikram.id}' AND type = 'ai_record_assistant'`)
    }
    // A model that does not run on this computer reads it only with the patient's consent to Mana AI record summaries.
    expect((await runTool(inConsultation('doctor', { local: false }), consultation())).detail).toMatch(/does not run on this computer/)
    // Without the server's configuration it still reads the consultation (as for a deployment where no simulator may post), and still leaves SIMULATED items out.
    const bare = await runTool(mk('doctor', { encounterId: world.openEncounterId, patientId: world.p.vikram.id }), consultation())
    expect(bare.status).toBe('ok')
    expect(factTexts(bare)).not.toMatch(SIMULATED_VALUES)
  })

  it('leaves the patient’s record to the record tool, and the consultation to its own: a topic of the one is not read by the other', async () => {
    const r = await runTool(inConsultation(), plan({ tool: 'get_patient_record', patient: 'current', topic: 'consultation_thermal' }))
    expect(r).toMatchObject({ status: 'invalid', facts: [] })
  })

  // Last in this file: it adds a conversation with its points to the consultation, and consents, and takes them away again at the end.
  it('reads the conversation and its points only with consent to recording for this consultation, and no thermal image once consent to thermal imaging is withdrawn', async () => {
    const b = world.base
    const p = world.p.vikram
    const encounterId = world.openEncounterId
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    const [t] = await ctx.db.insert(transcripts).values({ encounterId, source: 'typed', status: 'final', createdBy: b.users.doctor, createdAt: ago(20) }).returning({ id: transcripts.id })
    await ctx.db.insert(transcriptSegments).values([{ transcriptId: t!.id, seq: 1, label: 'S1', speaker: 'patient', speakerSource: 'typed_label', text: 'Sentinel-said: I wheeze at night and have coughed for a week.', createdAt: ago(19) }])
    const [job] = await ctx.db.insert(aiJobs).values({ facilityId: b.facilityId, patientId: p.id, encounterId, kind: 'extraction', status: 'succeeded', input: { transcriptId: t!.id }, dataOrigin: 'synthetic', createdBy: b.users.doctor }).returning({ id: aiJobs.id })
    const [run] = await ctx.db.insert(aiRuns).values({ jobId: job!.id, patientId: p.id, encounterId, kind: 'extraction', provider: 'adaxai-rules', model: 'extract-rules-v1', promptVersion: 'extract-rules-v1', status: 'succeeded' }).returning({ id: aiRuns.id })
    // One point the doctor confirmed (the record comparison flagged it), one still to review, one the doctor rejected.
    for (const [text, status, flags] of [
      ['Sentinel-pointA wheeze at night', 'accepted', ['conflicts_with_record']],
      ['Sentinel-pointB cough for a week', 'pending', []],
      ['Sentinel-pointC rejected by the doctor', 'rejected', []],
    ] as const) {
      const decided = status === 'pending' ? {} : { decidedBy: b.users.doctor, decidedAt: ago(15) }
      await ctx.db.insert(clinicalFacts).values({ jobId: job!.id, runId: run!.id, transcriptId: t!.id, encounterId, patientId: p.id, category: 'symptom', text, attribution: 'patient_reported', certainty: 'stated', flags: [...flags], status, createdAt: ago(18), ...decided })
    }
    const consent = (type: string, status: string, scope: 'ongoing' | 'encounter', version: string) =>
      adminQuery(`INSERT INTO consents (patient_id, type, status, method, scope, encounter_id, version, recorded_by) VALUES ($1, $2, $3, 'verbal', $4, $5, $6, $7)`, [p.id, type, status, scope, scope === 'encounter' ? encounterId : null, version, b.users.nurse])
    const dropConsents = (type: string) => adminQuery(`SET session_replication_role = replica; DELETE FROM consents WHERE patient_id = '${p.id}' AND type = '${type}'`)
    const all = async () => Promise.all(['consultation_recorded', 'consultation_review', 'consultation_missing', 'consultation_thermal'].map((topic) => runTool(inConsultation(), consultation(topic))))
    const NOT_IN_PLACE = 'The conversation and its important points, and the words of the AI draft that may rest on them, are not read by Mana: the patient’s consent to consultation recording and AI assistance is not in place for this consultation. The consultation screen shows them.'
    try {
      // No consent to recording (none recorded), then one in an earlier wording: nothing of the conversation, its points or what rests on them is read.
      for (const step of ['none', 'outdated'] as const) {
        if (step === 'outdated') await consent('ai_recording', 'granted', 'encounter', '2026-10-v1')
        const results = await all()
        const [recorded, review] = results
        for (const r of results) {
          expect(texts(r), step).not.toMatch(/Sentinel-|wheeze|cough for a week/)
          expect(r.facts.some((f) => /^(?:Conversation|Important point)\b/.test(f.text)), step).toBe(false)
        }
        expect(recorded!.findings).toContainEqual({ kind: 'absent', text: NOT_IN_PLACE, items: [] })
        expect(review!.facts.map((f) => f.text).join('\n'), step).not.toMatch(/important point/)
        expect(review!.findings).toContainEqual({ kind: 'absent', text: NOT_IN_PLACE, items: [] })
        // The disagreement between staff and the device is not the conversation's: it is still there.
        expect(review!.findings.filter((f) => f.kind === 'conflict').map((f) => f.text)).toEqual([expect.stringMatching(/Staff measured SpO₂ 97 %/)])
      }
      // Consent to recording, in its current wording, for this consultation: the conversation and the points the doctor did not reject are read.
      await dropConsents('ai_recording')
      await consent('ai_recording', 'granted', 'encounter', CONSENT_VERSIONS.ai_recording)
      const [recorded, review] = await all()
      expect(factTexts(recorded!)).toMatch(/^Conversation: 1 line\./m)
      expect(factTexts(recorded!)).toMatch(/Sentinel-pointA wheeze at night/)
      expect(factTexts(recorded!)).toMatch(/Sentinel-pointB cough for a week/)
      expect(texts(recorded!)).not.toMatch(/Sentinel-pointC|Sentinel-said/)
      expect(recorded!.facts.find((f) => /Sentinel-pointB/.test(f.text))!.trust).not.toBe('doctor_reviewed')
      expect(texts(recorded!)).not.toContain(NOT_IN_PLACE)
      expect(review!.facts.map((f) => f.text)).toContain('To review: 1 important point extracted from the conversation, not yet decided by the doctor. Fixed rules, not AI.')

      // Consent to thermal imaging withdrawn: no thermal image, summary, measurement or SIMULATED thermal item is read, in any topic, and the doctor is told why.
      await consent('thermal_imaging', 'withdrawn', 'ongoing', CONSENT_VERSIONS.thermal_imaging)
      const WITHDRAWN = 'The thermal images of this consultation are not read by Mana: the patient has withdrawn consent to thermal imaging. The consultation screen shows them.'
      const THERMAL_VALUES = /28\.1|34\.6|31\.2|33\.9|30\.1|32\.5|29\.8|31\.1|Knee|FLIR|Thermal image|Thermal summary|thermal-sim|thermal simulator/
      const after = await all()
      for (const r of after) expect(texts(r)).not.toMatch(THERMAL_VALUES)
      const [r2, review2, , thermal2] = after
      expect(thermal2).toMatchObject({ status: 'ok', facts: [], findings: [{ kind: 'absent', text: WITHDRAWN, items: [] }] })
      expect(r2!.findings).toContainEqual({ kind: 'absent', text: WITHDRAWN, items: [] })
      // The SIMULATED thermal image is not counted among what was left out as SIMULATED either: it is not read at all.
      const simulatedCount = (r: typeof r2) => Number(/^(\d+) SIMULATED items? (?:is|are) in this consultation/.exec(r!.findings.map((f) => f.text).find((x) => /SIMULATED items? (?:is|are) in/.test(x)) ?? '')?.[1] ?? 0)
      expect(simulatedCount(recorded)).toBe(3)
      expect(simulatedCount(r2)).toBe(2)
      expect(review2!.facts.map((f) => f.text).join('\n')).not.toMatch(/thermal/)
      expect(review2!.findings).toContainEqual({ kind: 'absent', text: WITHDRAWN, items: [] })
      // Everything else is still read: the staff's and the device's SpO₂, and the points.
      expect(factTexts(r2!)).toMatch(/Vital sign: SpO₂ 97 %/)
      expect(factTexts(r2!)).toMatch(/Sentinel-pointA/)
    } finally {
      await dropConsents('ai_recording')
      await dropConsents('thermal_imaging')
      await adminQuery(`SET session_replication_role = replica;
        DELETE FROM clinical_facts WHERE transcript_id = '${t!.id}';
        DELETE FROM ai_runs WHERE id = '${run!.id}';
        DELETE FROM ai_jobs WHERE id = '${job!.id}';
        DELETE FROM transcript_segments WHERE transcript_id = '${t!.id}';
        DELETE FROM transcripts WHERE id = '${t!.id}'`)
    }
  })
})

// The facts the consultation tool makes of a context, for contexts made by hand: a rejected point, a kind of what waits that could not be read, and what a
// consent keeps out.
describe('the consultation context as Mana’s facts (a context made by hand)', () => {
  const E = '00000000-0000-4000-8000-0000000000e1'
  const at = '2026-10-05T05:10:00.000Z'
  const ev = (id: string, kind: EvidenceItem['kind'], o: Partial<EvidenceItem> = {}): EvidenceItem => ({ id, kind, title: id, detail: null, at, status: 'Recorded', trust: 'clinician_entered', source: 'Nurse t.nurse', provenance: null, target: 'history', ...o })
  const context = (o: Partial<ConsultationContext> = {}): ConsultationContext => ({
    encounterId: E,
    patientId: '00000000-0000-4000-8000-0000000000a1',
    generatedAt: at,
    reasonForVisit: null,
    evidence: [],
    conflicts: [],
    pending: { points: 0, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: [] },
    missing: [],
    summary: { composer: 'multimodal-summary-v1', sections: [] },
    rules: { conflicts: 'context-conflicts-v1', summary: 'multimodal-summary-v1' },
    ...o,
  })
  const view = (o: Partial<ContextView> = {}): ContextView => ({ encounterId: E, alias: 'P1', scrub: (s) => s, timeZone: 'Asia/Kolkata', today: '2026-10-05', signed: false, isAuthor: true, withheld: { thermal: false, conversation: false }, ...o })
  const all = (o: { facts: { text: string }[]; findings: { text: string }[] }) => [...o.facts.map((f) => f.text), ...o.findings.map((f) => f.text)].join('\n')

  it('never gives a fact for a point the doctor rejected, nor anything that rests on it', () => {
    const c = context({
      evidence: [
        ev('point:a', 'point', { title: 'Symptom: “Sentinel-kept wheeze”', status: 'Doctor confirmed', trust: 'doctor_reviewed', target: 'conversation' }),
        ev('point:r', 'point', { title: 'Symptom: “Sentinel-rejected chest pain”', status: 'Rejected', trust: 'doctor_reviewed', target: 'conversation' }),
      ],
      conflicts: [{ id: 'point_vs_record:r', kind: 'point_vs_record', text: 'Important point “Symptom: Sentinel-rejected chest pain” (Rejected) is flagged by the record comparison: conflicts with the existing record.', itemIds: ['point:r'], rule: 'context-conflicts-v1' }],
    })
    for (const topic of ['consultation_recorded', 'consultation_review', 'consultation_missing', 'consultation_thermal'] as const) {
      const out = contextFacts(c, topic, view())
      expect(all(out), topic).not.toMatch(/Sentinel-rejected/)
    }
    expect(contextFacts(c, 'consultation_recorded', view()).facts.map((f) => f.text)).toEqual([expect.stringMatching(/^Important point: Symptom: “Sentinel-kept wheeze”\. Reviewed by the doctor\./)])
  })

  it('says that nothing waits for review only when every kind was counted, and says which could not be read', () => {
    const facts = (c: ConsultationContext, v = view()) => contextFacts(c, 'consultation_review', v)
    expect(facts(context()).facts.map((f) => f.text)).toEqual(['No important point, AI draft statement, thermal image or thermal summary of this consultation waits for review. Fixed rules, not AI.'])
    const unread = facts(context({ pending: { points: 0, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: ['thermalImages', 'thermalSummaries'] } }))
    expect(unread.facts).toEqual([])
    expect(unread.findings).toEqual([{ kind: 'absent', text: 'What waits for review is not known for the thermal images and thermal summaries of this consultation: they could not be read just now.', items: [] }])
    // What could be counted is still counted.
    const some = facts(context({ pending: { points: 2, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: ['draftStatements'] } }))
    expect(some.facts.map((f) => f.text)).toEqual(['To review: 2 important points extracted from the conversation, not yet decided by the doctor. Fixed rules, not AI.'])
    expect(some.findings.map((f) => f.text)).toEqual(['What waits for review is not known for the AI draft statements of this consultation: they could not be read just now.'])
    // Another doctor is not shown the AI draft: what waits is said of the rest, and the doctor is told the draft is not part of it.
    const other = facts(context({ pending: { points: 0, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: ['draftStatements'] } }), view({ isAuthor: false }))
    expect(other.facts.map((f) => f.text)).toEqual(['No important point, thermal image or thermal summary of this consultation waits for review. Fixed rules, not AI.'])
    expect(other.findings.map((f) => f.text)).toEqual(['The AI draft of this consultation is shown to its doctor only, so it is not part of what Mana read.'])
  })

  it('leaves out what a consent keeps out: the items, the conflicts and statements that rest on them, and their counts', () => {
    const c = context({
      evidence: [
        ev('transcript:t', 'transcript', { title: 'Conversation: 4 lines', trust: 'observed', target: 'conversation' }),
        ev('point:p', 'point', { title: 'Allergy: “Sentinel-point penicillin”', status: 'Extracted draft', trust: 'extracted', target: 'conversation' }),
        ev('point:c', 'point', { title: 'Symptom: “Sentinel-confirmed cough”', status: 'Doctor confirmed', trust: 'doctor_reviewed', target: 'conversation' }),
        ev('thermal:i', 'thermal', { title: 'Thermal image, Knee', status: 'Approved', trust: 'measured', target: 'thermal' }),
        ev('thermal:d', 'thermal', { title: 'Thermal image, Ankle', status: 'Draft', trust: 'measured', target: 'thermal' }),
        ev('thermal_summary:s', 'thermal_summary', { title: 'Thermal summary, Knee', status: 'To review', trust: 'rule_output', target: 'thermal' }),
        ev('vital_staff:v', 'vital_staff', { title: 'SpO₂ 97 %' }),
      ],
      conflicts: [
        { id: 'point_vs_record:p', kind: 'point_vs_record', text: 'Important point “Allergy: Sentinel-point penicillin” (Extracted draft) is flagged by the record comparison: not in the existing record.', itemIds: ['point:p'], rule: 'context-conflicts-v1' },
        { id: 'allergy_status:p', kind: 'allergy_status', text: 'Allergies were mentioned in the consultation (“Sentinel-point penicillin”), but the record has no allergy status.', itemIds: [], rule: 'context-conflicts-v1' },
        { id: 'draft_conflict:s', kind: 'draft_conflict', text: 'AI draft statement “Sentinel-draft conflicting allergy” is marked “Conflicting”: the record items it rests on disagree.', itemIds: [], rule: 'context-conflicts-v1' },
      ],
      pending: { points: 1, draftStatements: 0, thermalImages: 1, thermalSummaries: 1, unread: [] },
      summary: {
        composer: 'multimodal-summary-v1',
        sections: [
          { key: 'presentation', title: 'Current presentation', statements: [{ text: 'Symptom: “Sentinel-confirmed cough” (an important point confirmed by the doctor).', trust: 'doctor_reviewed', itemIds: ['point:c'] }] },
          { key: 'observations', title: 'Current observations', statements: [{ text: 'Thermal image of “Knee” (approved): whole image min 28.1 °C, max 34.6 °C, mean 31.2 °C. Skin-surface temperature only.', trust: 'measured', itemIds: ['thermal:i'] }] },
          // A statement of the AI draft the doctor accepted: its words may rest on a confirmed point of the conversation.
          { key: 'ai', title: 'AI-derived information (reviewed by the doctor)', statements: [{ text: '“Sentinel-draft sore throat for three days” (History; accepted by the doctor).', trust: 'doctor_reviewed', itemIds: ['ai_draft:d'] }] },
        ],
      },
    })
    // Both read: everything is there (so the test below shows what the consents take away).
    const open = contextFacts(c, 'consultation_recorded', view())
    expect(all(open)).toMatch(/Sentinel-point penicillin/)
    expect(all(open)).toMatch(/Sentinel-draft conflicting allergy/)
    expect(contextFacts(c, 'consultation_thermal', view()).facts[0]!.text).toMatch(/^Thermal image of “Knee” \(approved\): whole image min 28\.1 °C/)

    const withheld = view({ withheld: { thermal: true, conversation: true } })
    for (const topic of ['consultation_recorded', 'consultation_review', 'consultation_missing', 'consultation_thermal'] as const) {
      const out = contextFacts(c, topic, withheld)
      expect(all(out), topic).not.toMatch(/Sentinel-|Conversation: 4 lines|28\.1|Knee|Ankle/)
      expect(out.facts.every((f) => !/^(?:Conversation|Important point|Thermal)/.test(f.text)), topic).toBe(true)
    }
    const recorded = contextFacts(c, 'consultation_recorded', withheld)
    expect(recorded.facts.map((f) => f.text)).toEqual([expect.stringMatching(/^Vital sign: SpO₂ 97 %\. Entered by staff\./)])
    expect(recorded.findings.map((f) => f.text)).toEqual([
      'The conversation and its important points, and the words of the AI draft that may rest on them, are not read by Mana: the patient’s consent to consultation recording and AI assistance is not in place for this consultation. The consultation screen shows them.',
      'The thermal images of this consultation are not read by Mana: the patient has withdrawn consent to thermal imaging. The consultation screen shows them.',
    ])
    // What waits is counted of the rest only, and said to be nothing of the kinds that were counted.
    expect(contextFacts(c, 'consultation_review', withheld).facts.map((f) => f.text)).toEqual(['No AI draft statement of this consultation waits for review. Fixed rules, not AI.'])
    expect(contextFacts(c, 'consultation_thermal', withheld)).toMatchObject({ facts: [], findings: [{ kind: 'absent', text: 'The thermal images of this consultation are not read by Mana: the patient has withdrawn consent to thermal imaging. The consultation screen shows them.' }] })
    // With nothing of the conversation in the consultation, nothing is left out and nothing is said about it.
    const quiet = contextFacts(context({ evidence: [ev('vital_staff:v', 'vital_staff', { title: 'SpO₂ 97 %' })] }), 'consultation_review', withheld)
    expect(quiet.findings).toEqual([])
    expect(quiet.facts.map((f) => f.text)).toEqual(['No important point, AI draft statement, thermal image or thermal summary of this consultation waits for review. Fixed rules, not AI.'])
  })
})
void WHO
