import { MANA_READ_ONLY, MANA_RULES_ANSWER_LABEL, MANA_RULES_QUESTIONS, MANA_UNAVAILABLE, ManaActionDecisionResult, ManaConversationState, ManaVoiceTranscript } from '@adaxai/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RuleFactExtractor } from '../src/ai/extract/rules.ts'
import type { AiProviders } from '../src/ai/providers.ts'
import { buildManaWorld, createManaBase, type ManaWorld } from '../src/eval/mana-fixture.ts'
import { CHECKS_NOT_MADE, CONSULTATION_CLOSED, NOT_IN_CONSULTATION, NOT_THE_AUTHOR } from '../src/mana/assistant/actions.ts'
import { dayLabel } from '../src/mana/assistant/format.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import type { AppSettings } from '../src/settings/schema.ts'
import { adminQuery, call, createTestApp, login, resetDatabase, TEST_PASSWORD, type TestContext } from './helpers.ts'
import { ManaStub } from './mana-support.ts'
import { FakeTranscriber, multipartAudio, webm } from './speech-support.ts'

// HERO final, Mana end to end through the API: the questions fixed rules answer (no model asked, also with the model down or not configured), the
// consent rules they keep, a patient chosen among several, a medicine the doctor asks to add (a proposal, approved or cancelled; the server never writes
// the prescription), and a spoken question (transcribed in memory by the local speech model, never stored). The model and the speech model are labelled
// in-process test doubles; nothing reaches a real or hosted one. All patients are synthetic (eval/mana-fixture.ts).

const stub = new ManaStub()
const speech = new FakeTranscriber()
const providers = (m: ManaStub | null, mode: 'local' | 'none', transcriber: FakeTranscriber | null): AiProviders => ({
  drafter: null,
  transcriber,
  extractor: new RuleFactExtractor(),
  reasoner: m,
  reasoning: { mode, reason: mode === 'none' ? 'Local AI is switched off.' : null },
  egress: { hosted: false, destination: null },
  reasons: { llm: null, stt: null },
})
const relaxed = (audioMax = 10_000): AppSettings => {
  const f = loadAppSettings()
  return { ...f, security: { ...f.security, rateLimits: { ...f.security.rateLimits, loginPerAccount: { max: 10_000, windowSeconds: 60 }, loginPerIp: { max: 10_000, windowSeconds: 60 }, aiStepPerUser: { max: 10_000, windowSeconds: 60 }, aiAudioPerUser: { max: audioMax, windowSeconds: 60 } } } }
}
const ctx = createTestApp({ ai: providers(stub, 'local', speech), settings: relaxed() })
let world: ManaWorld

beforeAll(async () => {
  await resetDatabase()
  const base = await createManaBase(ctx.db, TEST_PASSWORD)
  world = await buildManaWorld({ call: (m, u, o) => call(ctx.app, m, u, o ?? {}), login: (u) => login(ctx.app, u), admin: (s, p) => adminQuery(s, p), db: ctx.db }, base, TEST_PASSWORD)
}, 180_000)
afterAll(() => ctx.close())

beforeEach(() => {
  stub.ready = true
  stub.calls = []
  stub.plan = null
  stub.answer = null
  speech.calls = []
  speech.script = null
  speech.failNext = false
})

type Who = 'doctor' | 'doctor2' | 'nurse'
const URL_ = '/api/mana-assistant'
const cookie = (who: Who) => world.cookies[who]

async function open(who: Who = 'doctor', body: Record<string, unknown> = {}, app: TestContext = ctx, c = cookie(who)) {
  const res = await call(app.app, 'POST', `${URL_}/conversations`, { cookie: c, body: { fresh: true, ...body } })
  expect(res.statusCode, res.body).toBe(200)
  return ManaConversationState.parse(res.json())
}
const askRaw = (who: Who, id: string, text: string, app: TestContext = ctx, c = cookie(who)) => call(app.app, 'POST', `${URL_}/conversations/${id}/messages`, { cookie: c, body: { text, idempotencyKey: crypto.randomUUID() } })
const lastMana = (s: ManaConversationState) => [...s.messages].reverse().find((m) => m.role === 'mana')!
/** A fixed-rule answer is made at once: the reply to the question already holds it (no polling, nothing pending). */
async function ask(who: Who, id: string, text: string, app: TestContext = ctx, c = cookie(who)) {
  const res = await askRaw(who, id, text, app, c)
  expect(res.statusCode, res.body).toBe(202)
  const s = ManaConversationState.parse(res.json())
  expect(lastMana(s).status).not.toBe('pending')
  return lastMana(s)
}
const said = (m: { answer: { blocks: { text: string }[] } | null }) => m.answer!.blocks.map((b) => b.text).join('\n')
/** The handles of a text written back as the names the screen shows. */
const named = (m: { answer: { entities: { alias: string; displayName: string }[] } | null }, text: string) => text.replace(/\bP\d{1,2}\b/g, (a) => m.answer!.entities.find((e) => e.alias === a)?.displayName ?? a)
const auditMark = async (): Promise<number> => Number((await adminQuery(`select coalesce(max(id), 0) as m from audit_events`)).rows[0].m)
const auditRows = async (like: string, after: number) => (await adminQuery(`select action, outcome, patient_id, details from audit_events where action like $1 and id > $2 order by id`, [like, after])).rows as { action: string; outcome: string; patient_id: string | null; details: Record<string, unknown> }[]
/** The audit events about one Mana message (by its id, so it does not depend on the event ids of a shared test database). */
const auditOf = async (like: string, messageId: string) => (await adminQuery(`select action, outcome, patient_id, details from audit_events where action like $1 and entity_id = $2 order by id`, [like, messageId])).rows as { action: string; outcome: string; patient_id: string | null; details: Record<string, unknown> }[]
const tableCounts = async (except: string[] = []) => {
  const sum = (t: string) => `(select count(*)::text || ':' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from ${t} x)`
  const tables = ['prescription_items', 'diagnoses', 'allergies', 'appointments', 'visits', 'encounters', 'patients', 'consents', 'service_orders', 'patient_documents', 'files', 'transcripts', 'observations', 'note_insertions'].filter((t) => !except.includes(t))
  const r = await adminQuery(`select ${tables.map((t) => `${sum(t)} as ${t}`).join(', ')}`)
  return JSON.stringify(r.rows[0])
}

/** Every rules answer: made by the server (engine rules, labelled as such on the screen), with no model named and none asked. */
function byRules(m: ReturnType<typeof lastMana>) {
  expect(m.answer?.engine, JSON.stringify(m.answer)).toBe('rules')
  expect(m.model).toBeNull()
  expect(stub.calls).toEqual([])
  // Every statement cites facts that exist.
  for (const b of m.answer!.blocks) for (const r of b.refs) expect(m.answer!.sources.some((s) => s.ref === r)).toBe(true)
}

describe('questions fixed rules answer, with no model', () => {
  it('names the next patient: ready before waiting, urgent first, never one already with a doctor; with the model down too', async () => {
    const s0 = await open()
    expect(MANA_RULES_ANSWER_LABEL).toBe('From the records (fixed rules)')
    let m = await ask('doctor', s0.conversation.id, MANA_RULES_QUESTIONS.next_patient.text)
    byRules(m)
    expect(m.status).toBe('ready')
    expect(m.answer!.outcome).toBe('answered')
    // Rahul Sharma is the only one of the doctor's queue ready for the doctor; Vikram is with the doctor and is not "next".
    expect(named(m, said(m))).toMatch(/^Your next patient is Rahul Sharma: ready for you since \d{1,2}:\d{2} [ap]m; checked in at \d{1,2}:\d{2} [ap]m \(token \d+\)\./)
    expect(m.answer!.subjects.map((e) => e.displayName)).toEqual(['Rahul Sharma'])
    expect(said(m)).not.toMatch(new RegExp(m.answer!.entities.find((e) => e.displayName === 'Vikram Rao')?.alias ?? 'no-such-handle'))
    const stored = (await adminQuery(`select provider, model, locality, plan_prompt_id, answer_prompt_id, checks_version, tools_version, schema_version from mana_messages where id = $1`, [m.id])).rows[0]
    expect(stored).toEqual({ provider: null, model: null, locality: null, plan_prompt_id: null, answer_prompt_id: null, checks_version: 'mana-rules-v1', tools_version: 'mana-rules-v1', schema_version: 'mana-assistant-v2' })

    // Anita becomes ready and urgent: urgent comes first among those ready.
    expect((await call(ctx.app, 'POST', `/api/visits/${world.p.anita.visitId}/status`, { cookie: cookie('nurse'), body: { status: 'ready' } })).statusCode).toBe(200)
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET priority = 'urgent' WHERE id = '${world.p.anita.visitId}'`)
    stub.ready = false
    m = await ask('doctor', s0.conversation.id, 'Mana, who is my next patient?')
    byRules(m)
    expect(named(m, said(m))).toMatch(/^Your next patient is Anita Das: ready for you since .*, marked urgent;/)
    expect(named(m, said(m))).toMatch(/After that: Rahul Sharma \(ready for the doctor\), then Meena Kumar \(in triage\)\./)
  })

  it('counts the patients seen today as Home counts them (completed visits of the doctor’s own queue), and what is still to come', async () => {
    // Lakshmi's consultation was signed today; her visit is completed here whatever signing does to it.
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET status = 'completed' WHERE id = '${world.p.lakshmi.visitId}'`)
    const mine = `facility_id = '${world.base.facilityId}' and visit_date = (select max(visit_date) from visits where id = '${world.p.lakshmi.visitId}') and (assigned_doctor_id = '${world.base.users.doctor}' or (assigned_doctor_id is null and department_id = '${world.base.departments.gen}'))`
    const { rows } = await adminQuery(`select count(*) filter (where status = 'completed')::int as seen, count(*) filter (where status in ('waiting','in_triage','ready'))::int as waiting, count(*) filter (where status = 'in_consultation')::int as inc from visits where ${mine}`)
    const expected = rows[0] as { seen: number; waiting: number; inc: number }
    expect(expected.seen).toBeGreaterThanOrEqual(1)
    stub.ready = false
    const m = await ask('doctor', (await open()).conversation.id, 'How many patients have I seen today?')
    byRules(m)
    expect(said(m)).toContain(`You have seen ${expected.seen} patient${expected.seen === 1 ? '' : 's'} today.`)
    expect(said(m)).toContain(`Still today: ${expected.waiting} waiting, ${expected.inc} in consultation, 0 yet to see.`)
    // The paediatrician's patient seen today (Priya) is not this doctor's.
    expect(m.answer!.sources[0]!.text).toMatch(/counted as on Home/)
  })

  it('says who has waited longest since checking in, and how long, from the check-in time', async () => {
    const m = await ask('doctor', (await open()).conversation.id, 'Which patient has been waiting longest?')
    byRules(m)
    expect(named(m, said(m))).toMatch(/^Meena Kumar has been waiting longest in the clinic’s queue: checked in at \d{1,2}:\d{2} [ap]m, 2 h( \d+ min)? ago \(now in triage\)\./)
  })

  it('says when a named patient arrived; asks which one when the name fits several, and the choice is answered by the same rules', async () => {
    const s0 = await open()
    let m = await ask('doctor', s0.conversation.id, 'What time did Anita Das arrive?')
    byRules(m)
    expect(named(m, said(m))).toMatch(/^Anita Das arrived \(checked in\) at \d{1,2}:\d{2} [ap]m today\./)
    m = await ask('doctor', s0.conversation.id, 'What time did Geeta Menon arrive?')
    expect(named(m, said(m))).toMatch(/Geeta Menon has not checked in today\.\nThe last check-in on record was on \d{1,2} \w{3,4} \d{4} at \d{1,2}:\d{2} [ap]m\./)

    stub.ready = false
    m = await ask('doctor', s0.conversation.id, 'When did Rahul arrive?')
    expect(m.answer).toMatchObject({ outcome: 'ambiguous', engine: 'rules' })
    // Two of this clinic; the other clinic's Rahul is not offered.
    expect(m.answer!.candidates.map((c) => c.displayName).sort()).toEqual(['Rahul Sharma', 'Rahul Verma'])
    const alias = m.answer!.candidates.find((c) => c.displayName === 'Rahul Sharma')!.alias
    const res = await call(ctx.app, 'POST', `${URL_}/conversations/${s0.conversation.id}/select`, { cookie: cookie('doctor'), body: { alias, idempotencyKey: crypto.randomUUID() } })
    expect(res.statusCode, res.body).toBe(202)
    const after = lastMana(ManaConversationState.parse(res.json()))
    byRules(after)
    expect(named(after, said(after))).toMatch(/^Rahul Sharma arrived \(checked in\) at .* today\./)
  })

  it('reports what the nurse recorded at triage: reason, priority, staff readings with who and when, the triage note or that there is none, and the visit’s steps', async () => {
    const s0 = await open('doctor', { encounterId: world.openEncounterId })
    let m = await ask('doctor', s0.conversation.id, 'What did the nurse record at triage?')
    byRules(m)
    expect(said(m)).toMatch(/^Reason at check-in: “Cough and tiredness” \(checked in at .* by Nurse t\.nurse\)\./)
    expect(said(m)).toContain('Priority: normal.')
    expect(said(m)).toContain('No triage note is recorded.')
    expect(said(m)).toMatch(/How the visit moved: checked in \(waiting\) at \d{1,2}:\d{2} [ap]m.*; ready for the doctor at .*; with a doctor at /)

    const mark = await auditMark()
    const note = 'Synthetic triage: febrile at arrival, settled after fluids.'
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET triage_note = '${note}', triage_note_by = '${world.base.users.nurse}', triage_note_at = now() WHERE id = '${world.p.vikram.visitId}'`)
    m = await ask('doctor', s0.conversation.id, 'What did the nurse note during triage?')
    expect(said(m)).toMatch(/Triage note by Nurse t\.nurse at \d{1,2}:\d{2} [ap]m: “Synthetic triage: febrile at arrival, settled after fluids\.”/)
    // Audit hygiene: ids and counts only, never what the nurse wrote or the reason.
    for (const e of await auditRows('mana.%', mark)) expect(JSON.stringify(e.details), e.action).not.toMatch(/febrile|Cough|tiredness/)

    // By name, from the clinic: Meena's readings were taken by the nurse.
    m = await ask('doctor', (await open()).conversation.id, 'What did the nurse record for Meena Kumar?')
    expect(said(m)).toMatch(/Vital signs measured by staff for this visit: Temperature 37\.2 °C at .* by Nurse t\.nurse; Heart rate 88 bpm at .* by Nurse t\.nurse\./)
  })

  it('keeps the consent rules: a patient who withdrew consent to AI help is not read, and the reason for their visit is not shown in a list', async () => {
    await adminQuery(`INSERT INTO consents (patient_id, type, status, method, scope, version, recorded_by) VALUES ($1, 'ai_record_assistant', 'withdrawn', 'verbal', 'ongoing', '2026-10-v1', $2)`, [world.p.anita.id, world.base.users.nurse])
    try {
      const s0 = await open()
      let m = await ask('doctor', s0.conversation.id, 'What did the nurse record for Anita Das?')
      expect(m.answer).toMatchObject({ outcome: 'refused', engine: 'rules', blocks: [] })
      expect(m.answer!.notice).toMatch(/withdrawn consent to AI help/)
      expect((await auditOf('mana.access_refused', m.id)).map((e) => [e.outcome, e.details.tool])).toEqual([['denied', 'rules:nurse_triage']])
      expect(await auditOf('mana.tool_run', m.id)).toEqual([])
      m = await ask('doctor', s0.conversation.id, 'Who is my next patient?')
      const anita = m.answer!.sources.find((s) => s.patient === m.answer!.entities.find((e) => e.displayName === 'Anita Das')?.alias)!
      expect(anita.text).toMatch(/reason not shown \(the patient’s consent to AI help does not allow it\)/)
      expect(JSON.stringify(m.answer)).not.toMatch(/Headache/)
      expect(await ask('doctor', s0.conversation.id, 'What allergies does Anita Das have?')).toMatchObject({ status: 'refused' })
    } finally {
      await adminQuery(`SET session_replication_role = replica; DELETE FROM consents WHERE patient_id = '${world.p.anita.id}' AND type = 'ai_record_assistant'`)
    }
  })

  it('reads the allergies on record through the record’s own fixed rules', async () => {
    stub.ready = false
    const m = await ask('doctor', (await open('doctor', { encounterId: world.openEncounterId })).conversation.id, 'What allergies does this patient have?')
    byRules(m)
    expect(said(m)).toMatch(/Allergy to Sulfonamides \(reaction: rash\), severity moderate, recorded/)
    expect(m.answer!.findings.some((f) => f.kind === 'conflict' && /no known allergies/i.test(f.text))).toBe(true)
    expect(m.answer!.sources.every((s) => s.patient === 'P1')).toBe(true)
  })

  it('answers when no model is configured at all; the generic questions still say Mana is unavailable', async () => {
    const other = createTestApp({ ai: providers(null, 'none', null), settings: relaxed() })
    try {
      const d = await login(other.app, 't.doctor')
      const s0 = await open('doctor', {}, other, d)
      expect(s0.status.available).toBe(false)
      const m = await ask('doctor', s0.conversation.id, 'Who is my next patient?', other, d)
      expect(m.answer?.engine).toBe('rules')
      expect(m.status).toBe('ready')
      const res = await askRaw('doctor', s0.conversation.id, 'Who is waiting right now?', other, d)
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ message: MANA_UNAVAILABLE })
    } finally {
      await other.close()
    }
  })
})

describe('service orders and documents, by fixed rules', () => {
  const ago = (min: number) => `now() - interval '${min} minutes'`
  async function order(code: string, name: string, category: string, minutesAgo: number, turnaround: number) {
    await adminQuery(
      `INSERT INTO service_orders (facility_id, patient_id, visit_id, encounter_id, ordered_by, service_code, service_name, category, status, provider, simulated, turnaround_minutes, requested_at, status_changed_at, data_origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'requested', 'simulated', true, $9, ${ago(minutesAgo)}, ${ago(minutesAgo)}, 'synthetic')`,
      [world.base.facilityId, world.p.vikram.id, world.p.vikram.visitId, world.openEncounterId, world.base.users.doctor, code, name, category, turnaround],
    )
  }

  it('says where the consultation’s orders stand, moved on by the simulated lab’s schedule (the orders service’s own steps), always as SIMULATED, and changes nothing clinical', async () => {
    await order('CBC', 'Complete blood count (CBC)', 'lab', 180, 30)
    await order('XRAY-CHEST', 'Chest X-ray (PA view)', 'imaging', 10, 45)
    await order('CRP', 'C-reactive protein (CRP)', 'lab', 0, 45)
    const before = await tableCounts(['service_orders'])
    stub.ready = false
    const id = (await open('doctor', { encounterId: world.openEncounterId })).conversation.id
    let m = await ask('doctor', id, 'Is the CBC report ready?')
    byRules(m)
    expect(said(m)).toMatch(/^The Complete blood count \(CBC\) order is completed by the SIMULATED lab \(at .*\)\. Its report says: “Simulated laboratory: no test was performed and no result values exist\.”/)
    m = await ask('doctor', id, 'Did the lab receive the CRP request?')
    expect(said(m)).toMatch(/^Not yet: the C-reactive protein \(CRP\) request was placed at .* and the SIMULATED lab has not received it yet\./)
    m = await ask('doctor', id, 'Did the lab receive the chest x-ray request?')
    expect(said(m)).toMatch(/^Yes: the SIMULATED imaging service received the Chest X-ray \(PA view\) request since .*; it is in progress\./)
    m = await ask('doctor', id, 'Which orders are pending?')
    expect(said(m)).toMatch(/^2 orders pending for P1: C-reactive protein \(CRP\): requested at .*, not yet received by the SIMULATED lab; Chest X-ray \(PA view\): in progress at the SIMULATED imaging service since .*\.\nAlso on record: 1 completed, 0 cancelled\./)
    const orderItems = m.answer!.sources.flatMap((s) => s.items).filter((i) => i.label.startsWith('Service order · '))
    expect(orderItems).toHaveLength(2)
    for (const i of orderItems) expect(i.status).toMatch(/ · SIMULATED$/)
    // Never ordered is not "not ready".
    m = await ask('doctor', id, 'Is the lipid profile report ready?')
    expect(said(m)).toBe('No order for Lipid profile was placed for P1.')
    // Nothing clinical changed. The simulated steps that were due were stored by the orders service's own function (service-orders/service.ts), at the
    // times the schedule gives, exactly as the consultation screen's read stores them: what Mana said is what the orders now say.
    expect(await tableCounts(['service_orders'])).toBe(before)
    const stored = (await adminQuery(`select service_code, status, report_text from service_orders where patient_id = $1 order by requested_at`, [world.p.vikram.id])).rows
    expect(stored).toEqual([
      { service_code: 'CBC', status: 'completed', report_text: 'Simulated laboratory: no test was performed and no result values exist.' },
      { service_code: 'XRAY-CHEST', status: 'in_progress', report_text: null },
      { service_code: 'CRP', status: 'requested', report_text: null },
    ])
    expect((await adminQuery(`select e.source from service_order_events e join service_orders o on o.id = e.order_id where o.service_code = 'CBC' and o.patient_id = $1 order by e.id`, [world.p.vikram.id])).rows.map((r) => r.source)).toEqual(['doctor', 'simulated_lab', 'simulated_lab'])
  })

  it('finds "the patient who arrived an hour ago" from today’s check-ins, and the doctor’s own pending orders when no patient is named', async () => {
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET checked_in_at = now() - interval '60 minutes' WHERE id = '${world.p.vikram.visitId}'`)
    const id = (await open()).conversation.id
    let m = await ask('doctor', id, 'The patient who arrived one hour ago — is the lab report ready?')
    byRules(m)
    expect(m.answer!.subjects.map((e) => e.displayName)).toEqual(['Vikram Rao'])
    expect(said(m)).toMatch(/SIMULATED lab/)
    m = await ask('doctor', id, 'Which orders are pending?')
    expect(named(m, said(m))).toMatch(/^2 orders you placed are pending: Vikram Rao, C-reactive protein \(CRP\): .*; Vikram Rao, Chest X-ray \(PA view\): in progress at the SIMULATED imaging service/)
    m = await ask('doctor', id, 'The patient who arrived five hours ago — is the lab report ready?')
    expect(m.answer).toMatchObject({ outcome: 'not_established' })
    expect(m.answer!.findings[0]!.text).toMatch(/^Nobody in your queue checked in between/)
  })

  it('says a cancelled simulated order was cancelled at the SIMULATED lab, finds an order named with its study word, and leaves other reports to the planner', async () => {
    await order('TSH', 'Thyroid stimulating hormone (TSH)', 'lab', 0, 90)
    const [tsh] = (await adminQuery(`select id from service_orders where patient_id = $1 and service_code = 'TSH'`, [world.p.vikram.id])).rows as { id: string }[]
    const cancelled = await call(ctx.app, 'POST', `/api/service-orders/${tsh!.id}/cancel`, { cookie: cookie('doctor'), body: {} })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    stub.ready = false
    const id = (await open('doctor', { encounterId: world.openEncounterId })).conversation.id
    // The cancelled order is still the SIMULATED lab's, and is said to be: "always say SIMULATED lab".
    for (const q of ['Is the TSH report ready?', 'Did the lab receive the TSH request?']) {
      const m = await ask('doctor', id, q)
      byRules(m)
      expect(said(m), q).toMatch(/^The Thyroid stimulating hormone \(TSH\) order at the SIMULATED lab was cancelled at \d{1,2}:\d{2} [ap]m; there is no report\.$/)
    }
    // "The chest X-ray scan" is the chest X-ray that was ordered (not "no order was placed"); a CT, never ordered, is said to be not placed.
    let m = await ask('doctor', id, 'Is the chest x-ray scan report ready?')
    expect(said(m)).toMatch(/^The Chest X-ray \(PA view\) (?:report is not ready yet|order is completed)/)
    m = await ask('doctor', id, 'Is the CT scan report ready?')
    expect(said(m)).toBe('No order for CT head (plain) was placed for P1.')
    // Not an order: the planner (a labelled stand-in, here down) is asked, so Mana says it is unavailable rather than "no order was placed".
    for (const q of ['Is the thermal report ready?', 'Is the AI draft report ready?']) {
      const res = await askRaw('doctor', id, q)
      expect(res.statusCode, q).toBe(503)
      expect(res.json()).toMatchObject({ message: MANA_UNAVAILABLE })
    }
  })

  it('quotes the latest imaging report as staff typed it, with its date, and says when the text is not recorded', async () => {
    const doc = async (title: string, studyDate: string | null, report: string | null, status = 'recorded') => {
      const f = (await adminQuery(`INSERT INTO files (facility_id, patient_id, kind, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, 'patient_document', $3, 'mri.pdf', 'application/pdf', 10, $4, $5) RETURNING id`, [world.base.facilityId, world.p.rahulS.id, `test/${crypto.randomUUID()}.pdf`, 'c'.repeat(64), world.base.users.nurse])).rows[0].id
      const d = (await adminQuery(`INSERT INTO patient_documents (facility_id, patient_id, category, modality, title, study_date, report_text, file_id, mime_type, data_origin, uploaded_by) VALUES ($1, $2, 'imaging_report', 'mri', $3, $4, $5, $6, 'application/pdf', 'synthetic', $7) RETURNING id`, [world.base.facilityId, world.p.rahulS.id, title, studyDate, report, f, world.base.users.nurse])).rows[0].id
      if (status !== 'recorded') await adminQuery(`UPDATE patient_documents SET status = 'entered_in_error', status_reason = 'wrong patient' WHERE id = $1`, [d])
    }
    await doc('MRI lumbar spine', '2026-03-02', null)
    await doc('MRI brain', '2026-09-21', 'Synthetic report: no acute intracranial abnormality.')
    await doc('MRI knee', '2026-09-30', 'Entered for the wrong patient.', 'entered_in_error')
    stub.ready = false
    const id = (await open()).conversation.id
    let m = await ask('doctor', id, 'Mana, summarize Rahul Sharma’s previous MRI.')
    byRules(m)
    const text = named(m, said(m))
    // Dates as the clinic writes them (the same day label every Mana answer uses).
    expect(text).toMatch(new RegExp(`^The latest MRI on Rahul Sharma’s record is “MRI brain” of ${dayLabel('2026-09-21', 'UTC')}, added by Nurse t\\.nurse on`))
    expect(text).toContain('Its report (as typed by staff) reads: “Synthetic report: no acute intracranial abnormality.”')
    expect(text).toContain(`Earlier MRI documents on record: “MRI lumbar spine” of ${dayLabel('2026-03-02', 'UTC')}.`)
    expect(text).not.toMatch(/knee|wrong patient/)
    m = await ask('doctor', id, 'What did Rahul Sharma’s CT show?')
    expect(named(m, said(m))).toBe('No CT report or image is on Rahul Sharma’s record.')
  })
})

describe('a medicine the doctor asks to add: a proposal, never an action', () => {
  /** A patient of today with a penicillin allergy, in a consultation the doctor has open. */
  let enc: { encounterId: string; patientId: string; version: number }
  beforeAll(async () => {
    const nurse = cookie('nurse')
    const p = (await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: { givenName: 'Ira', familyName: 'Proposal', dateOfBirth: '1990-01-01', sex: 'female', phone: '9400000999', city: 'Chennai' } })).json()
    expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/allergies`, { cookie: nurse, body: { substance: 'Penicillin', reaction: 'rash', severity: 'moderate' } })).statusCode).toBeLessThan(300)
    const v = (await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: world.base.departments.gen, chiefComplaint: 'Sore throat' } })).json()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'ready' } })
    const e = (await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: cookie('doctor') })).json()
    enc = { encounterId: e.id, patientId: p.id, version: e.version }
  })

  it('proposes a fully specified medicine with the fixed checks, writes nothing, and audits ids and counts only', async () => {
    const id = (await open('doctor', { encounterId: enc.encounterId })).conversation.id
    const before = await tableCounts()
    const mark = await auditMark()
    stub.ready = false
    const m = await ask('doctor', id, 'Mana, add amoxicillin 500 mg three times a day for 5 days to the prescription')
    byRules(m)
    expect(m.answer!.action).toEqual({
      kind: 'add_prescription_item',
      encounterId: enc.encounterId,
      item: { drugName: 'Amoxicillin', strength: '500 mg', form: '', dose: '500 mg', route: '', frequency: 'Three times daily (TDS)', duration: '5 days', durationDays: 5, instructions: '' },
      summary: 'Add to the prescription: Amoxicillin 500 mg · three times a day · 5 days',
      warnings: [{ kind: 'allergy_conflict', text: 'Amoxicillin and the recorded allergy to Penicillin belong to the same configured group (“penicillin”). Check before approving.' }],
    })
    expect(m.actionDecision).toBeNull()
    expect(said(m)).toMatch(/^I can add Amoxicillin 500 mg, three times a day for 5 days, to this consultation’s prescription\. Approve to add it to the draft, or cancel: nothing is added until you approve, and nothing is signed\.$/)
    expect(await tableCounts()).toBe(before)
    const proposed = await auditOf('mana.action_proposed', m.id)
    expect(proposed).toHaveLength(1)
    expect(proposed[0]!.details).toEqual({ conversationId: id, encounterId: enc.encounterId, kind: 'add_prescription_item', warnings: 1 })
    for (const e of await auditRows('mana.%', mark)) expect(JSON.stringify(e.details), e.action).not.toMatch(/amoxicillin|three times|500 mg/i)
  })

  it('warns when the same medicine is already on the draft', async () => {
    const draft = (await call(ctx.app, 'GET', `/api/encounters/${enc.encounterId}`, { cookie: cookie('doctor') })).json()
    const saved = await call(ctx.app, 'PUT', `/api/encounters/${enc.encounterId}/draft`, {
      cookie: cookie('doctor'),
      body: { version: draft.version, note: { chiefComplaint: 'Sore throat', history: '', pastHistory: '', examination: '', assessment: '', plan: '', followUp: '' }, diagnoses: [], prescription: [{ drugName: 'Paracetamol', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Three times daily (TDS)', duration: '3 days', instructions: '' }] },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const m = await ask('doctor', (await open('doctor', { encounterId: enc.encounterId })).conversation.id, 'add paracetamol 650 mg tds for 3 days after food')
    expect(m.answer!.action!.item).toMatchObject({ drugName: 'Paracetamol', strength: '650 mg', frequency: 'Three times daily (TDS)', instructions: 'After food' })
    expect(m.answer!.action!.warnings).toEqual([{ kind: 'duplicate_medicine', text: 'Paracetamol is already on this prescription (500 mg, Three times daily (TDS), 3 days).' }])
  })

  it('reads neither the allergies nor the prescription of a patient who withdrew consent to AI help, and says no check was made', async () => {
    // Paracetamol is on the draft (above) and the patient is allergic to penicillin: neither may be read for Mana now.
    await adminQuery(`INSERT INTO consents (patient_id, type, status, method, scope, version, recorded_by) VALUES ($1, 'ai_record_assistant', 'withdrawn', 'verbal', 'ongoing', '2026-10-v1', $2)`, [enc.patientId, world.base.users.nurse])
    try {
      const id = (await open('doctor', { encounterId: enc.encounterId })).conversation.id
      for (const q of ['add paracetamol 650 mg tds for 3 days after food', 'add amoxicillin 500 mg three times a day for 5 days']) {
        const m = await ask('doctor', id, q)
        byRules(m)
        expect(m.answer!.action!.warnings, q).toEqual([{ kind: 'other', text: CHECKS_NOT_MADE }])
        // Nothing of the record is in the answer: not the medicine on the draft with its details, nor the allergy, nor the reason for the visit.
        expect(JSON.stringify(m.answer), q).not.toMatch(/500 mg, Three times daily \(TDS\), 3 days|is already on this prescription|[Pp]enicillin|Sore throat/)
      }
    } finally {
      await adminQuery(`SET session_replication_role = replica; DELETE FROM consents WHERE patient_id = '${enc.patientId}' AND type = 'ai_record_assistant'`)
    }
  })

  it('asks for what is missing instead of guessing, and keeps refusing "Prescribe …" and changes to other lists', async () => {
    const id = (await open('doctor', { encounterId: enc.encounterId })).conversation.id
    const before = await tableCounts()
    let m = await ask('doctor', id, 'add amoxicillin 500 mg three times a day')
    expect(m.answer).toMatchObject({ outcome: 'clarify', engine: 'rules', notice: 'To add Amoxicillin to the prescription, I need for how long. Say the whole instruction again with them. Nothing was added.' })
    expect(m.answer!.action).toBeUndefined()
    m = await ask('doctor', id, 'add this medicine to the prescription')
    expect(m.answer!.notice).toMatch(/^To add a medicine to the prescription, I need the medicine, the dose, how often it is taken and for how long\./)
    m = await ask('doctor', id, 'add amoxicillin 500 mg twice a day or three times a day for 5 days')
    expect(m.answer).toMatchObject({ outcome: 'clarify' })
    expect(m.answer!.action).toBeUndefined()
    // The model path is unchanged for these: the planner (a labelled stand-in) is asked, and the server refuses whatever it planned.
    for (const q of ['Prescribe amoxicillin 500 mg three times a day for 5 days', 'Add penicillin to her allergies']) {
      m = lastMana(ManaConversationState.parse((await askRaw('doctor', id, q)).json()))
      for (let i = 0; i < 100 && m.status === 'pending'; i++) {
        await new Promise((r) => setTimeout(r, 30))
        m = lastMana(ManaConversationState.parse((await call(ctx.app, 'GET', `${URL_}/conversations/${id}`, { cookie: cookie('doctor') })).json()))
      }
      expect(m.answer, q).toMatchObject({ outcome: 'refused', notice: MANA_READ_ONLY })
      expect(m.answer!.engine, q).toBeUndefined()
    }
    expect(await tableCounts()).toBe(before)
  })

  it('proposes only in the doctor’s own consultation that is still a draft', async () => {
    let m = await ask('doctor', (await open()).conversation.id, 'add amoxicillin 500 mg three times a day for 5 days')
    expect(m.answer).toMatchObject({ outcome: 'clarify', notice: NOT_IN_CONSULTATION })
    m = await ask('doctor2', (await open('doctor2', { encounterId: enc.encounterId })).conversation.id, 'add amoxicillin 500 mg three times a day for 5 days')
    expect(m.answer).toMatchObject({ outcome: 'refused', notice: NOT_THE_AUTHOR })
    m = await ask('doctor', (await open('doctor', { encounterId: world.p.lakshmi.encounterId! })).conversation.id, 'add amoxicillin 500 mg three times a day for 5 days')
    expect(m.answer).toMatchObject({ outcome: 'refused', notice: CONSULTATION_CLOSED })
  })

  it('records the doctor’s decision once: a repeat returns it, the other decision is refused, and nothing clinical is written', async () => {
    const id = (await open('doctor', { encounterId: enc.encounterId })).conversation.id
    const m = await ask('doctor', id, 'add cetirizine 10 mg at night for 5 days')
    const before = await tableCounts()
    const decide = (decision: string, who: Who = 'doctor', messageId = m.id) => call(ctx.app, 'POST', `${URL_}/messages/${messageId}/decision`, { cookie: cookie(who), body: { decision } })
    expect((await decide('maybe')).statusCode).toBe(400)
    expect((await decide('approved', 'nurse')).statusCode).toBe(403)
    expect((await decide('approved', 'doctor2')).statusCode).toBe(404)
    const first = await decide('approved')
    expect(first.statusCode, first.body).toBe(201)
    const r = ManaActionDecisionResult.parse(first.json())
    expect(r).toMatchObject({ messageId: m.id, decision: 'approved' })
    const again = await decide('approved')
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
    const other = await decide('declined')
    expect(other.statusCode).toBe(409)
    expect(other.json()).toMatchObject({ error: 'already_decided' })
    expect((await adminQuery(`select count(*)::int as n from mana_action_decisions where message_id = $1`, [m.id])).rows[0].n).toBe(1)
    const state = ManaConversationState.parse((await call(ctx.app, 'GET', `${URL_}/conversations/${id}`, { cookie: cookie('doctor') })).json())
    expect(lastMana(state).actionDecision).toEqual({ decision: 'approved', decidedAt: r.decidedAt })
    const events = await auditOf('mana.action_%', m.id)
    // The proposal itself, then the one decision (a repeat and the refused other decision add nothing).
    expect(events.map((e) => [e.action, e.details])).toEqual([
      ['mana.action_proposed', { conversationId: id, encounterId: enc.encounterId, kind: 'add_prescription_item', warnings: 0 }],
      ['mana.action_approved', { conversationId: id, encounterId: enc.encounterId, kind: 'add_prescription_item' }],
    ])
    // The server never writes the prescription: the doctor's screen adds the medicine to the draft.
    expect(await tableCounts()).toBe(before)

    // An answer with nothing to decide.
    const plain = await ask('doctor', id, 'What allergies does this patient have?')
    expect((await decide('approved', 'doctor', plain.id)).json()).toMatchObject({ error: 'no_action' })
    // A declined proposal.
    const second = await ask('doctor', id, 'add cetirizine 10 mg at night for 5 days')
    expect((await decide('declined', 'doctor', second.id)).statusCode).toBe(201)
    expect((await auditOf('mana.action_declined', second.id)).map((e) => e.details)).toEqual([{ conversationId: id, encounterId: enc.encounterId, kind: 'add_prescription_item' }])

    // A consultation that is no longer a draft: a proposal made before cannot be approved (cancelling it still can).
    const third = await ask('doctor', id, 'add cetirizine 10 mg at night for 5 days')
    const current = (await call(ctx.app, 'GET', `/api/encounters/${enc.encounterId}`, { cookie: cookie('doctor') })).json()
    expect((await call(ctx.app, 'POST', `/api/encounters/${enc.encounterId}/discard`, { cookie: cookie('doctor'), body: { version: current.version, reason: 'Test: closed before approval' } })).statusCode).toBe(200)
    const late = await decide('approved', 'doctor', third.id)
    expect(late.statusCode).toBe(409)
    expect(late.json()).toMatchObject({ error: 'encounter_not_editable', message: CONSULTATION_CLOSED })
    expect((await decide('declined', 'doctor', third.id)).statusCode).toBe(201)
  })
})

describe('a spoken question', () => {
  const voice = (fields: Record<string, string>, file: { name: string; type: string; data: Buffer }, app: TestContext = ctx, c = cookie('doctor')) => {
    const m = multipartAudio(fields, file)
    return app.app.inject({ method: 'POST', url: `${URL_}/voice`, headers: { ...m.headers, cookie: c, 'x-adaxai-csrf': '1' }, payload: m.payload })
  }
  const clip = (data = webm()) => ({ name: 'q.webm', type: 'audio/webm', data })

  it('is transcribed in memory by the local speech model and returned as text; nothing is stored, and the audit log has counts only', async () => {
    const conv = (await open()).conversation.id
    speech.script = () => [{ startMs: 0, endMs: 2000, text: 'Who is my next patient?', confidence: 0.9, avgLogprob: -0.1, noSpeechProb: 0.01 }]
    const before = await tableCounts()
    const mark = await auditMark()
    const res = await voice({ conversationId: conv, durationMs: '2400' }, clip())
    expect(res.statusCode, res.body).toBe(200)
    expect(ManaVoiceTranscript.parse(res.json())).toEqual({ text: 'Who is my next patient?', empty: false, durationMs: 20_000, language: 'en' })
    expect(speech.calls).toHaveLength(1)
    expect(await tableCounts()).toBe(before)
    const events = await auditRows('mana.voice%', mark)
    expect(events).toHaveLength(1)
    expect(events[0]!.details).toMatchObject({ conversationId: conv, encounterId: null, chars: 23, empty: false, segments: 1, durationMs: 20_000 })
    expect(JSON.stringify(events[0]!.details)).not.toMatch(/next patient/i)
    // Nothing heard: said so, not made up.
    speech.script = () => [{ startMs: 0, endMs: 900, text: 'hmm', confidence: 0.1, avgLogprob: -2, noSpeechProb: 0.97 }]
    expect((await voice({ conversationId: conv }, clip())).json()).toMatchObject({ text: '', empty: true })
  })

  it('refuses what is too long, too large or not audio of its kind, before the speech model is asked', async () => {
    expect((await voice({ durationMs: '45000' }, clip())).json()).toMatchObject({ error: 'too_long' })
    expect((await voice({}, clip(Buffer.concat([webm(), Buffer.alloc(5 * 1024 * 1024)])))).statusCode).toBe(413)
    expect((await voice({}, { name: 'q.txt', type: 'text/plain', data: Buffer.from('hello') })).statusCode).toBe(400)
    expect((await voice({}, { name: 'q.webm', type: 'audio/webm', data: Buffer.from('not audio at all') })).statusCode).toBe(415)
    expect(speech.calls).toEqual([])
    // The speech model says the clip was longer than allowed (the browser's own count can be wrong): refused, and the words are not returned.
    class LongClip extends FakeTranscriber {
      override async transcribe(...args: Parameters<FakeTranscriber['transcribe']>) {
        const r = await super.transcribe(...args)
        return { ...r, durationMs: 45_000, segments: [{ startMs: 0, endMs: 40_000, text: 'a very long question', confidence: 0.9, avgLogprob: -0.1, noSpeechProb: 0.01 }] }
      }
    }
    const app = createTestApp({ ai: providers(stub, 'local', new LongClip()), settings: relaxed() })
    try {
      const mark = await auditMark()
      const res = await voice({}, clip(), app, await login(app.app, 't.doctor'))
      expect(res.statusCode).toBe(413)
      expect(res.json()).toMatchObject({ error: 'too_long' })
      expect(res.body).not.toMatch(/a very long question/)
      expect((await auditRows('mana.voice%', mark)).map((e) => [e.outcome, e.details.code])).toEqual([['failure', 'too_long']])
    } finally {
      await app.close()
    }
  })

  it('needs the patient’s recording consent in a consultation, says when the speech service is not there, and is rate limited', async () => {
    const conv = (await open('doctor', { encounterId: world.openEncounterId })).conversation.id
    const res = await voice({ conversationId: conv }, clip())
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/^consent_/)
    expect(speech.calls).toEqual([])
    expect((await call(ctx.app, 'POST', `/api/encounters/${world.openEncounterId}/ai-consent`, { cookie: cookie('doctor'), body: { method: 'verbal' } })).statusCode).toBe(201)
    expect((await voice({ conversationId: conv }, clip())).statusCode).toBe(200)
    // Another doctor's conversation is not found.
    expect((await voice({ conversationId: conv }, clip(), ctx, cookie('doctor2'))).statusCode).toBe(404)
    speech.failNext = true
    expect((await voice({}, clip())).json()).toMatchObject({ error: 'stt_unavailable' })
    expect((await voice({}, clip(), ctx, cookie('nurse'))).statusCode).toBe(403)

    const none = createTestApp({ ai: providers(stub, 'local', null), settings: relaxed(1) })
    try {
      const d = await login(none.app, 't.doctor')
      expect((await voice({}, clip(), none, d)).json()).toMatchObject({ error: 'stt_unavailable' })
      expect((await voice({}, clip(), none, d)).statusCode).toBe(429)
    } finally {
      await none.close()
    }
  })
})
