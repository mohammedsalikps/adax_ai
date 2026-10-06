import { Encounter, EncounterAi, ManaAnswer, ManaAnswerList, PatientDetail, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AiProviderError, type AiProviders, type CitedText, type RecordQuestionAnswerer, type RecordQuestionInput } from '../src/ai/providers.ts'
import type { SessionUser } from '../src/auth/sessions.ts'
import { auscultationRecordings, files } from '../src/db/schema.ts'
import { classifyQuestion, itemsForGeneration } from '../src/mana/answers.ts'
import { loadPatientRecord } from '../src/mana/record.ts'
import { verifyCitations } from '../src/mana/routes.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, type TestContext } from './helpers.ts'

// --- Test double for the AI provider (tests only; the product never fakes AI output) ---
class FakeQa implements RecordQuestionAnswerer {
  readonly provider = 'fake'
  readonly model = 'fake-qa'
  readonly promptVersion = 'mana-qa-v1'
  seen: RecordQuestionInput[] = []
  failNext: AiProviderError | null = null
  /** Built from the input: cites the first record item, plus one citation that does not exist. */
  async answer(input: RecordQuestionInput) {
    this.seen.push(input)
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
    const first = input.recordText.match(/^\[([A-Z]\d+)\]/m)?.[1] ?? 'A1'
    const statements: CitedText[] = [
      { text: 'Summary statement citing a record item (test).', refs: [first] },
      { text: 'Statement citing nothing that exists (test).', refs: ['Z9'] },
    ]
    return { statements, conflicts: [], notFound: ['HbA1c result'], model: 'fake-qa', inputTokens: 10, outputTokens: 5, requestId: null }
  }
}

const qa = new FakeQa()
const withAi = createTestApp({ ai: { drafter: null, transcriber: null, qa, reasons: { llm: null, stt: null } } satisfies AiProviders })
const noKeys = createTestApp()
let fx: Fixture

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(withAi.db)
  qa.seen = []
  qa.failNext = null
})
afterAll(async () => {
  await withAi.close()
  await noKeys.close()
})

const note = (over: Record<string, string> = {}) => ({ chiefComplaint: 'Diabetes review', history: 'Known diabetes for four years.', pastHistory: '', examination: 'Well.', assessment: 'Type 2 diabetes, fair control.', plan: 'Continue metformin.', followUp: 'Review in 3 months.', ...over })
const rx = (drugName: string) => ({ drugName, strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Twice daily', duration: '90 days', instructions: '' })

/**
 * A patient with a penicillin allergy, one signed consultation 200 days ago
 * (diabetes, metformin; temperature 37.0) and today's visit (temperature 38.4)
 * with an open consultation whose draft prescribes amoxicillin.
 */
async function scenario(ctx: TestContext, { name = 'Lakshmi', phone = '98400 12345', drug = 'Amoxicillin' } = {}) {
  const nurse = await login(ctx.app, 't.nurse')
  const doctor = await login(ctx.app, 't.doctor')
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: name, phone }) })).json())
  await call(ctx.app, 'POST', `/api/patients/${p.id}/allergies`, { cookie: nurse, body: { substance: 'Penicillin', reaction: 'Rash', severity: 'moderate' } })
  const v1 = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Diabetes review' } })).json())
  await call(ctx.app, 'POST', `/api/visits/${v1.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 37.0 }, { kind: 'heart_rate', value: 80 }] } })
  const e1 = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v1.id}/encounter`, { cookie: doctor })).json())
  const s1 = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e1.id}/draft`, { cookie: doctor, body: { version: e1.version, note: note(), diagnoses: [{ description: 'Type 2 diabetes mellitus', code: 'E11.9', kind: 'primary' }], prescription: [rx('Metformin')] } })).json())
  expect((await call(ctx.app, 'POST', `/api/encounters/${e1.id}/sign`, { cookie: doctor, body: { version: s1.version, attestation: true } })).statusCode).toBe(200)
  // HERO final (deliberate change): signing no longer closes the visit; the doctor completes the earlier consultation, as signing used to.
  expect((await call(ctx.app, 'POST', `/api/encounters/${e1.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
  // The earlier consultation happened 200 days ago (bypassing the freeze triggers as the test superuser).
  await adminQuery(`SET session_replication_role = replica;
    UPDATE encounters SET signed_at = now() - interval '200 days', started_at = now() - interval '200 days' WHERE id = '${e1.id}';
    UPDATE observations SET measured_at = now() - interval '200 days' WHERE visit_id = '${v1.id}';
    UPDATE visits SET visit_date = (now() - interval '200 days')::date WHERE id = '${v1.id}';`)

  const v2 = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Fever and cough for 3 days' } })).json())
  await call(ctx.app, 'POST', `/api/visits/${v2.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 38.4 }, { kind: 'heart_rate', value: 98 }] } })
  const e2 = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v2.id}/encounter`, { cookie: doctor })).json())
  const s2 = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e2.id}/draft`, { cookie: doctor, body: { version: e2.version, note: note({ chiefComplaint: 'Fever and cough', assessment: '', plan: '', followUp: '' }), diagnoses: [], prescription: [rx(drug)] } })).json())
  return { p, e1, v1, e2: s2, v2, nurse, doctor }
}

const ask = (ctx: TestContext, cookie: string, patientId: string, body: Record<string, unknown>) => call(ctx.app, 'POST', `/api/patients/${patientId}/mana/questions`, { cookie, body })
const statements = (a: ManaAnswer) => a.record.sections.flatMap((s) => s.statements)
const sourceOf = (a: ManaAnswer, ref: string) => a.sources.find((s) => s.ref === ref)!

describe('Mana record answers (explicit rules, no AI provider)', () => {
  it('classifies questions into intents', () => {
    expect(classifyQuestion('What medication was prescribed last time?')).toBe('last_prescription')
    expect(classifyQuestion('Compare today’s vitals')).toBe('vitals_compare')
    expect(classifyQuestion('Summarize this patient’s history')).toBe('history_summary')
    expect(classifyQuestion('Pre-consultation briefing please')).toBe('briefing')
    expect(classifyQuestion('What changed since the previous visit?')).toBe('changes_since_last')
    expect(classifyQuestion('Is she allergic to anything?')).toBe('allergies')
    expect(classifyQuestion('Any mention of a rash?')).toBe('search')
    expect(classifyQuestion('Any mention of fever?')).toBe('search')
    expect(classifyQuestion('Does the record mention metformin?')).toBe('search')
    expect(classifyQuestion('Has the fever settled? Compare the temperature')).toBe('vitals_compare')
  })

  it('answers the last prescription with source, date, field and status, flags outdated and conflicting records, and never invents an AI answer', async () => {
    const { p, e1, e2, doctor } = await scenario(noKeys)
    const res = await ask(noKeys, doctor, p.id, { question: 'What medication was prescribed last time?', encounterId: e2.id })
    expect(res.statusCode).toBe(201)
    const a = ManaAnswer.parse(res.json())
    expect(a.intent).toBe('last_prescription')
    // v4 (G14): the medicines answer also gives the patient's medicine list as recorded.
    expect(a.record.rulesVersion).toBe('mana-record-v4')

    const metformin = statements(a).find((s) => s.kind === 'documented' && s.text.startsWith('Metformin'))!
    expect(metformin.text).toContain('500 mg')
    const src = sourceOf(a, metformin.refs[0]!)
    expect(src).toMatchObject({ sourceType: 'prescription_item', encounterId: e1.id, field: 'Prescription', status: 'signed', provenance: 'clinician_stated' })
    expect(new Date(src.date!).getTime()).toBeLessThan(Date.now() - 199 * 86_400_000)

    expect(statements(a)).toContainEqual(expect.objectContaining({ kind: 'outdated', text: expect.stringMatching(/200 days old/) }))
    // Today's draft is kept apart from the signed record.
    const draft = a.record.sections.find((s) => s.title.startsWith('Today’s consultation'))!
    expect(sourceOf(a, draft.statements[0]!.refs[0]!)).toMatchObject({ status: 'draft', encounterId: e2.id })
    // Recorded allergy vs. the drafted medicine (configured illustrative group).
    const clash = statements(a).find((s) => s.kind === 'conflict')!
    expect(clash.text).toMatch(/Amoxicillin.*Penicillin.*penicillin/)
    expect(clash.refs.map((r) => sourceOf(a, r).sourceType).sort()).toEqual(['allergy', 'prescription_item'])

    // No provider: an explicit unavailable state, no generated text, no AI job.
    expect(a.generation).toMatchObject({ status: 'unavailable', statements: [], jobId: null })
    expect(a.generation.reason).toMatch(/switched off on this server/)
    expect((await adminQuery('SELECT count(*)::int AS n FROM ai_jobs')).rows[0].n).toBe(0)
    const { rows } = await adminQuery("SELECT patient_id, details FROM audit_events WHERE action = 'mana.ask'")
    expect(rows).toEqual([{ patient_id: p.id, details: expect.objectContaining({ intent: 'last_prescription', generation: 'unavailable', itemsForAi: 0 }) }])
  })

  it('compares today’s vitals with the previous reading and flags disagreeing readings at the same visit', async () => {
    const { p, v2, e2, nurse, doctor } = await scenario(noKeys)
    let a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Compare vitals', intent: 'vitals_compare', encounterId: e2.id })).json())
    const temp = statements(a).find((s) => s.text.startsWith('Temperature'))!
    expect(temp.text).toMatch(/38\.4 °C at this visit \(measured by staff\); previous 37\.0 °C on .*: up 1\.4 °C/)
    expect(temp.refs.map((r) => sourceOf(a, r).field)).toEqual(['Temperature', 'Temperature'])
    expect(statements(a)).toContainEqual(expect.objectContaining({ kind: 'outdated', text: expect.stringMatching(/previous temperature reading is 200 days old/) }))

    await call(noKeys.app, 'POST', `/api/visits/${v2.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 36.9 }] } })
    a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Compare vitals', intent: 'vitals_compare', encounterId: e2.id })).json())
    expect(statements(a)).toContainEqual(expect.objectContaining({ kind: 'conflict', text: expect.stringMatching(/Temperature was recorded more than once/) }))
  })

  it('states what is absent: no signed consultation, nothing to compare, no matching record item', async () => {
    const nurse = await login(noKeys.app, 't.nurse')
    const doctor = await login(noKeys.app, 't.doctor')
    const p = PatientDetail.parse((await call(noKeys.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient() })).json())
    const brief = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Briefing', intent: 'briefing' })).json())
    expect(statements(brief)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'absent', text: 'Allergy status is not recorded.' }), expect.objectContaining({ kind: 'absent', text: 'There is no signed consultation in the record.' })]))
    const changes = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'What changed since the last visit?' })).json())
    expect(statements(changes)).toEqual([expect.objectContaining({ kind: 'absent' })])
    const search = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Does the record mention atorvastatin?' })).json())
    expect(search.intent).toBe('search')
    expect(statements(search)).toEqual([expect.objectContaining({ kind: 'absent', text: expect.stringContaining('“atorvastatin”') })])
  })

  it('summarizes history and changes since the previous visit from this patient’s record only', async () => {
    const { p, e2, doctor } = await scenario(noKeys)
    // Another patient with different data in the same facility.
    const other = await scenario(noKeys, { name: 'Gopal', phone: '98400 55555', drug: 'Atorvastatin' })
    const changes = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'What changed since the previous visit?', encounterId: e2.id })).json())
    const texts = statements(changes).map((s) => s.text)
    expect(texts).toEqual(expect.arrayContaining([expect.stringMatching(/^Comparing today’s consultation \(draft\) with the signed consultation of/), 'New medicines: Amoxicillin.', 'No longer prescribed: Metformin.', expect.stringMatching(/^Temperature: 38\.4 °C now, 37\.0 °C then \(up 1\.4 °C\)/)]))
    const history = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Summarize this patient’s history' })).json())
    expect(statements(history)).toContainEqual(expect.objectContaining({ kind: 'documented', text: expect.stringContaining('Type 2 diabetes mellitus (E11.9)') }))
    const rash = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Any mention of a rash?' })).json())
    expect(statements(rash)[0]!.text).toMatch(/Allergy: “Allergy: Penicillin \(reaction: Rash\)/)
    // Nothing from the other patient appears anywhere in this patient's answers.
    const all = JSON.stringify([changes, history, rash])
    expect(all).not.toContain('Atorvastatin')
    expect(all).not.toContain(other.e1.id)
    expect(all).not.toContain('Gopal')
    // Asking with the other patient's consultation as context is refused.
    expect((await ask(noKeys, doctor, p.id, { question: 'Briefing', encounterId: other.e2.id })).statusCode).toBe(404)
  })

  it('flags an amended consultation as possibly corrected and marks its items as amended', async () => {
    const { p, e1, doctor } = await scenario(noKeys)
    expect((await call(noKeys.app, 'POST', `/api/encounters/${e1.id}/amendments`, { cookie: doctor, body: { reason: 'Dose correction', content: 'Metformin dose should read 1 g twice daily.' } })).statusCode).toBe(201)
    const a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Last prescription?', intent: 'last_prescription' })).json())
    const flag = statements(a).find((s) => s.kind === 'outdated' && s.text.includes('amended'))!
    expect(sourceOf(a, flag.refs[0]!)).toMatchObject({ sourceType: 'amendment', encounterId: e1.id, excerpt: expect.stringContaining('1 g twice daily') })
    const metformin = statements(a).find((s) => s.text.startsWith('Metformin'))!
    expect(sourceOf(a, metformin.refs[0]!).status).toBe('amended')
  })

  it('is for doctors only, within their facility; answers are immutable and reviews are recorded', async () => {
    const { p, doctor, nurse } = await scenario(noKeys)
    expect((await ask(noKeys, nurse, p.id, { question: 'Briefing' })).statusCode).toBe(403)
    expect((await ask(noKeys, doctor, '00000000-0000-4000-8000-000000000000', { question: 'Briefing' })).statusCode).toBe(404)
    expect((await call(noKeys.app, 'GET', `/api/patients/${p.id}/mana/questions`, { cookie: nurse })).statusCode).toBe(403)

    const key = crypto.randomUUID()
    const first = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Allergies?', idempotencyKey: key })).json())
    const again = await ask(noKeys, doctor, p.id, { question: 'Allergies?', idempotencyKey: key })
    expect([again.statusCode, again.json().id]).toEqual([200, first.id])

    await expect(adminQuery(`UPDATE mana_questions SET question = 'changed' WHERE id = '${first.id}'`)).rejects.toThrow(/cannot be changed/)
    await expect(adminQuery(`DELETE FROM mana_questions WHERE id = '${first.id}'`)).rejects.toThrow(/cannot be changed/)

    const reviewed = ManaAnswer.parse((await call(noKeys.app, 'POST', `/api/mana/questions/${first.id}/review`, { cookie: doctor })).json())
    expect(reviewed.review.reviewedByName).toBe('Test t.doctor')
    const list = ManaAnswerList.parse((await call(noKeys.app, 'GET', `/api/patients/${p.id}/mana/questions`, { cookie: doctor })).json())
    expect(list.answers.map((x) => x.id)).toEqual([first.id])
    const { rows } = await adminQuery("SELECT action FROM audit_events WHERE action LIKE 'mana.%' ORDER BY occurred_at")
    expect(rows.map((r) => r.action)).toEqual(['mana.ask', 'mana.review', 'mana.read'])
  })
})

// ML audit G14: "What medicines is this patient on?" left out the medicine list staff recorded (it listed only the last signed prescription and today's draft).
describe('Mana record answers: the medicines the patient takes', () => {
  const medicine = (ctx: TestContext, cookie: string, patientId: string, drugName: string) =>
    call(ctx.app, 'POST', `/api/patients/${patientId}/medications`, { cookie, body: { drugName, strength: '100 mcg', form: 'inhaler', dose: '2 puffs', frequency: 'when wheezy', reason: 'wheeze' } })

  it('gives the medicine list as recorded first, then the last signed prescription and today’s draft, each labelled by where it comes from', async () => {
    const { p, e2, doctor } = await scenario(noKeys)
    const salbutamol = await medicine(noKeys, doctor, p.id, 'Salbutamol')
    expect(salbutamol.statusCode).toBe(201)
    const old = await medicine(noKeys, doctor, p.id, 'Montelukast')
    expect((await call(noKeys.app, 'POST', `/api/patients/${p.id}/medications/${old.json().id}/status`, { cookie: doctor, body: { status: 'stopped', reason: 'No longer needed' } })).statusCode).toBe(200)
    const a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'What medicines is this patient on?', encounterId: e2.id })).json())
    expect(a.intent).toBe('last_prescription')
    expect(a.record.sections.map((s) => s.title)).toEqual([expect.stringMatching(/^Current medicines · medicine list in the record \(entered by staff, not a prescription\)$/), expect.stringMatching(/^Last signed prescription · /), 'Today’s consultation (draft, not signed)', 'Safety'])
    const list = a.record.sections[0]!.statements
    expect(list[0]).toMatchObject({ kind: 'documented', text: expect.stringMatching(/^Salbutamol, 100 mcg, inhaler, dose 2 puffs, when wheezy; entered on the medicine list /) })
    expect(sourceOf(a, list[0]!.refs[0]!)).toMatchObject({ sourceType: 'patient_medication', field: 'Current medicine', status: 'active', provenance: 'record' })
    expect(list).toContainEqual(expect.objectContaining({ kind: 'documented', text: 'Marked stopped on the list: Montelukast.' }))
    // The last signed prescription and today's draft are still there, under their own titles.
    expect(statements(a)).toContainEqual(expect.objectContaining({ kind: 'documented', text: expect.stringMatching(/^Metformin, 500 mg/) }))
    expect(a.record.sections[2]!.statements[0]!.text).toMatch(/^Amoxicillin/)
  })

  it('says "No current medicines are recorded." when the list holds none, never "none"; the prescriptions are said apart', async () => {
    const { p, e2, doctor } = await scenario(noKeys)
    const a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'What medicines is this patient on?', encounterId: e2.id })).json())
    expect(a.record.sections[0]!.statements).toEqual([expect.objectContaining({ kind: 'absent', text: 'No current medicines are recorded.', refs: [] })])
    expect(JSON.stringify(a.record.sections)).not.toMatch(/none/i)
    // A patient with nothing at all: the list, and no signed consultation, are each said.
    const nurse = await login(noKeys.app, 't.nurse')
    const bare = PatientDetail.parse((await call(noKeys.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: 'Meds', phone: '98400 77777' }) })).json())
    const b = ManaAnswer.parse((await ask(noKeys, doctor, bare.id, { question: 'What medicines is she on?' })).json())
    expect(statements(b).map((s) => s.text)).toEqual(['No current medicines are recorded.', 'There is no signed consultation in the record.'])
  })

  it('the briefing includes the medicine list, and the allergy rules now compare it with the recorded allergies', async () => {
    const { p, e2, doctor } = await scenario(noKeys)
    await medicine(noKeys, doctor, p.id, 'Ampicillin')
    const brief = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Briefing', intent: 'briefing', encounterId: e2.id })).json())
    expect(brief.record.sections.map((s) => s.title)).toContain('Current medicines · medicine list in the record (entered by staff, not a prescription)')
    const allergies = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Allergies?', encounterId: e2.id })).json())
    expect(statements(allergies)).toContainEqual(expect.objectContaining({ kind: 'conflict', text: expect.stringMatching(/^Ampicillin \(the medicine list in the record\) and the recorded allergy to Penicillin/) }))
  })
})

describe('Mana record answers: edge cases', () => {
  it('does not report medicines as stopped when the latest signed consultation simply has no prescription', async () => {
    const { p, e2, doctor } = await scenario(noKeys)
    const saved = Encounter.parse((await call(noKeys.app, 'PUT', `/api/encounters/${e2.id}/draft`, { cookie: doctor, body: { version: e2.version, note: note({ chiefComplaint: 'Fever', plan: 'Fluids.' }), diagnoses: [{ description: 'Viral fever', kind: 'provisional' }], prescription: [] } })).json())
    expect((await call(noKeys.app, 'POST', `/api/encounters/${e2.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    const a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'What changed since the previous visit?' })).json())
    const texts = statements(a).map((s) => s.text)
    expect(texts.join('\n')).not.toContain('No longer prescribed')
    expect(statements(a)).toContainEqual(expect.objectContaining({ kind: 'absent', text: expect.stringMatching(/has no prescription, so the record does not show whether Metformin was continued or stopped/) }))
  })

  it('searches whole words and keeps the documented “no known allergies” status', async () => {
    const nurse = await login(noKeys.app, 't.nurse')
    const doctor = await login(noKeys.app, 't.doctor')
    const { p } = await scenario(noKeys)
    expect(statements(ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Any mention of rash?' })).json()))[0]!.kind).toBe('documented')
    // "ash" is inside "Rash" but is not a word there.
    expect(statements(ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Any mention of ash?' })).json()))[0]!.kind).toBe('absent')
    const nka = PatientDetail.parse((await call(noKeys.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: 'Nirmala', phone: '98400 33333' }) })).json())
    await call(noKeys.app, 'PUT', `/api/patients/${nka.id}/no-known-allergies`, { cookie: nurse, body: { noKnownAllergies: true } })
    const found = ManaAnswer.parse((await ask(noKeys, doctor, nka.id, { question: 'Any mention of allergies?' })).json())
    expect(statements(found)[0]).toMatchObject({ kind: 'documented', text: expect.stringContaining('no known allergies') })
  })

  it('finds the previous reading even after a burst of newer readings', async () => {
    const { p, v2, e2, doctor } = await scenario(noKeys)
    // 250 extra heart-rate readings at today's visit (more than the old 200-row cap).
    await adminQuery(`INSERT INTO observations (patient_id, visit_id, kind, value, unit, measured_at, source, validation_status)
      SELECT '${p.id}', '${v2.id}', 'heart_rate', 98, 'bpm', now() - (g || ' seconds')::interval, 'manual', 'manual_entry' FROM generate_series(1, 250) g`)
    const a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Compare vitals', intent: 'vitals_compare', encounterId: e2.id })).json())
    expect(statements(a).find((s) => s.text.startsWith('Heart rate'))!.text).toMatch(/previous 80 bpm/)
  })

  it('a long record keeps the allergy record and the cited items in the AI context budget', async () => {
    const { p, e2 } = await scenario(noKeys)
    const record = await loadPatientRecord(noKeys.db, { facilityId: fx.facilityId } as SessionUser, p.id, { encounterId: e2.id, maxEncounters: 10, observationDays: 365 })
    const kept = itemsForGeneration('briefing', record, new Set(['M1']), 260)
    expect(kept.map((i) => i.ref)).toEqual(expect.arrayContaining(['A1', 'M1']))
  })

  it('D2: does not list a stethoscope recording of the consultation, so neither the consultation draft nor the record rules read, cite or send one', async () => {
    const { p, e2, doctor } = await scenario(noKeys)
    const [f] = await noKeys.db.insert(files).values({ facilityId: fx.facilityId, patientId: p.id, encounterId: e2.id, kind: 'stethoscope_audio', storageKey: `test/${crypto.randomUUID()}`, mimeType: 'audio/wav', sizeBytes: 1000, sha256: 'a'.repeat(64), uploadedBy: fx.users.doctor }).returning({ id: files.id })
    await noKeys.db.insert(auscultationRecordings).values({ facilityId: fx.facilityId, patientId: p.id, encounterId: e2.id, fileId: f!.id, site: 'pulmonic', durationMs: 21_400, captureMethod: 'gateway', note: 'Sentinel-steth-note: stethoscope crackles', dataOrigin: 'synthetic', createdBy: fx.users.doctor })
    const me = { facilityId: fx.facilityId } as SessionUser
    // In the consultation (what the consultation draft is made from) and outside it (the patient's record as such): no item is a recording or says anything of one.
    for (const opts of [{ encounterId: e2.id }, {}]) {
      const record = await loadPatientRecord(noKeys.db, me, p.id, { ...opts, maxEncounters: 10, observationDays: 365 })
      expect(record.items.length).toBeGreaterThan(0)
      expect(JSON.stringify(record.items.map(({ data: _data, ...i }) => i))).not.toMatch(/stethoscope|auscultation|pulmonic|Sentinel-steth|crackles/i)
      expect(record.items.every((i) => (i.data.t as string) !== 'recording')).toBe(true)
    }
    // The rules do not search it, cite it or send it.
    const a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Any mention of a stethoscope?', encounterId: e2.id })).json())
    expect(a.intent).toBe('search')
    expect(JSON.stringify(a)).not.toMatch(/stethoscope recording \(|pulmonic|Sentinel-steth|crackles/i)
    expect(statements(a)).toEqual([expect.objectContaining({ kind: 'absent' })])
  })

  it('keeps AI-reported conflicts even when the model returns many statements', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `Statement ${i}`, refs: ['A1'] }))
    const out = verifyCitations({ statements: many, conflicts: [{ text: 'Conflict', refs: ['A1', 'M1'] }], notFound: [] }, new Set(['A1', 'M1']))
    expect(out.statements.filter((s) => s.kind === 'generated')).toHaveLength(12)
    expect(out.statements.at(-1)).toMatchObject({ kind: 'conflict', refs: ['A1', 'M1'] })
  })
})

describe('Mana AI summary', () => {
  it('needs the patient’s consent, sends only this patient’s pseudonymised items, verifies citations and records provenance', async () => {
    const { p, e2, nurse, doctor } = await scenario(withAi)
    await scenario(withAi, { name: 'Gopal', phone: '98400 55555', drug: 'Atorvastatin' })
    let a = ManaAnswer.parse((await ask(withAi, doctor, p.id, { question: 'Give me a briefing', encounterId: e2.id })).json())
    expect(a.generation.status).toBe('consent_required')
    expect(qa.seen).toHaveLength(0)

    expect((await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'ai_record_assistant', method: 'verbal' } })).statusCode).toBe(201)
    a = ManaAnswer.parse((await ask(withAi, doctor, p.id, { question: `Give Lakshmi a briefing (MRN ${p.mrn})`, encounterId: e2.id })).json())
    expect(a.generation).toMatchObject({ status: 'succeeded', provider: 'fake', model: 'fake-qa', promptVersion: 'mana-qa-v1', notFound: ['HbA1c result'] })
    const [good, bad] = a.generation.statements
    expect(good).toMatchObject({ kind: 'generated', unsupported: false })
    expect(a.sources.map((s) => s.ref)).toContain(good!.refs[0])
    expect(bad).toMatchObject({ kind: 'generated', refs: [], unsupported: true })
    // The record answer is unchanged and kept apart from the generated text.
    expect(statements(a).every((s) => s.kind !== 'generated')).toBe(true)

    const sent = qa.seen[0]!
    expect(sent.patientLine).toMatch(/^\d+-\d+ years, female$/)
    expect(sent.question).toBe('Give [PATIENT] a briefing (MRN [MRN])')
    for (const leak of ['Lakshmi', 'Narayanan', p.mrn, '98400', 'Atorvastatin', 'Gopal']) expect(JSON.stringify(sent)).not.toContain(leak)
    expect(sent.recordText).toMatch(/^\[A1\] \d{4}-\d\d-\d\d · Allergy · active: Allergy: Penicillin/)

    const { rows: jobs } = await adminQuery("SELECT kind, status, summary, input FROM ai_jobs WHERE kind = 'patient_qa'")
    expect(jobs).toEqual([expect.objectContaining({ status: 'succeeded', summary: expect.objectContaining({ statements: 2, unsupported: 1 }) })])
    expect(jobs[0].input.sentRefs.length).toBeGreaterThan(3)
    const { rows: runs } = await adminQuery("SELECT provider, model, prompt_version FROM ai_runs WHERE kind = 'patient_qa'")
    expect(runs).toEqual([{ provider: 'fake', model: 'fake-qa', prompt_version: 'mana-qa-v1' }])
    expect((await adminQuery("SELECT count(*)::int AS n FROM ai_prompt_versions WHERE id = 'mana-qa-v1'")).rows[0].n).toBe(1)
  })

  it('a failed summary keeps the record answer, is marked retryable and can be retried', async () => {
    const { p, nurse, doctor } = await scenario(withAi)
    await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'ai_record_assistant', method: 'verbal' } })
    qa.failNext = new AiProviderError('unreachable', 'The AI service could not be reached.', true)
    const failed = ManaAnswer.parse((await ask(withAi, doctor, p.id, { question: 'Allergies?' })).json())
    expect(failed.generation).toMatchObject({ status: 'failed', retryable: true, statements: [] })
    expect(failed.generation.reason).toMatch(/could not be reached/)
    expect(statements(failed).length).toBeGreaterThan(0)
    const retried = ManaAnswer.parse((await call(withAi.app, 'POST', `/api/mana/questions/${failed.id}/retry`, { cookie: doctor })).json())
    expect(retried.generation.status).toBe('succeeded')
    expect((await call(withAi.app, 'POST', `/api/mana/questions/${failed.id}/retry`, { cookie: doctor })).json().error).toBe('not_failed')
    const { rows } = await adminQuery("SELECT status, attempts FROM ai_jobs WHERE kind = 'patient_qa'")
    expect(rows).toEqual([{ status: 'succeeded', attempts: 2 }])
  })

  it('a retry re-checks consent: after withdrawal nothing is sent, through either retry route', async () => {
    const { p, nurse, doctor } = await scenario(withAi)
    const granted = PatientDetail.parse((await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'ai_record_assistant', method: 'verbal' } })).json())
    qa.failNext = new AiProviderError('unreachable', 'The AI service could not be reached.', true)
    const failed = ManaAnswer.parse((await ask(withAi, doctor, p.id, { question: 'Allergies?' })).json())
    expect(failed.generation).toMatchObject({ status: 'failed', retryable: true })
    const consentId = granted.consents.find((c) => c.type === 'ai_record_assistant')!.id
    expect((await call(withAi.app, 'POST', `/api/patients/${p.id}/consents/${consentId}/withdraw`, { cookie: nurse })).statusCode).toBe(200)
    const sentBefore = qa.seen.length
    const viaMana = await call(withAi.app, 'POST', `/api/mana/questions/${failed.id}/retry`, { cookie: doctor })
    const viaJobs = await call(withAi.app, 'POST', `/api/ai-jobs/${failed.generation.jobId}/retry`, { cookie: doctor })
    expect([viaMana.statusCode, viaMana.json().error, viaJobs.statusCode, viaJobs.json().error]).toEqual([409, 'consent_required', 409, 'consent_required'])
    expect(qa.seen).toHaveLength(sentBefore)
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'mana.ai_blocked' AND outcome = 'denied'")).rows[0].n).toBe(2)
  })

  it('non-retryable failures cannot be retried; a summary left in progress by a stopped server can be', async () => {
    const { p, nurse, doctor } = await scenario(withAi)
    await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'ai_record_assistant', method: 'verbal' } })
    qa.failNext = new AiProviderError('bad_request', 'The AI service rejected the request.', false)
    const failed = ManaAnswer.parse((await ask(withAi, doctor, p.id, { question: 'Allergies?' })).json())
    expect(failed.generation).toMatchObject({ status: 'failed', retryable: false })
    expect((await call(withAi.app, 'POST', `/api/mana/questions/${failed.id}/retry`, { cookie: doctor })).json().error).toBe('not_retryable')
    // Simulate a request that stopped mid-way: still "pending" (bypassing the guard as the test superuser).
    await adminQuery(`SET session_replication_role = replica; UPDATE mana_questions SET generation_status = 'pending', updated_at = now() WHERE id = '${failed.id}';`)
    expect((await call(withAi.app, 'POST', `/api/mana/questions/${failed.id}/retry`, { cookie: doctor })).json().error).toBe('in_progress')
    await adminQuery(`SET session_replication_role = replica; UPDATE mana_questions SET updated_at = now() - interval '1 hour' WHERE id = '${failed.id}';`)
    const retried = ManaAnswer.parse((await call(withAi.app, 'POST', `/api/mana/questions/${failed.id}/retry`, { cookie: doctor })).json())
    expect(retried.generation.status).toBe('succeeded')
  })

  it('sends dates as the facility’s local day', async () => {
    const { p, v2, nurse, doctor } = await scenario(withAi)
    await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'ai_record_assistant', method: 'verbal' } })
    // 20:00 UTC is already the next day in the fixture facility's timezone (Asia/Kolkata).
    await adminQuery(`UPDATE observations SET measured_at = '2026-09-30T20:00:00Z' WHERE visit_id = '${v2.id}' AND kind = 'temperature'`)
    await ask(withAi, doctor, p.id, { question: 'Compare vitals', intent: 'vitals_compare' })
    expect(qa.seen.at(-1)!.recordText).toMatch(/\] 2026-10-01 · Temperature/)
  })

  it('after the patient withdraws Mana consent, answers say so, nothing is sent, and the refusal is audited; a failed retry is audited as a failure', async () => {
    const { p, nurse, doctor } = await scenario(withAi)
    const granted = PatientDetail.parse((await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'ai_record_assistant', method: 'verbal' } })).json())
    qa.failNext = new AiProviderError('unreachable', 'The AI service could not be reached.', true)
    const failed = ManaAnswer.parse((await ask(withAi, doctor, p.id, { question: 'Allergies?' })).json())
    qa.failNext = new AiProviderError('unreachable', 'Still unreachable.', true)
    await call(withAi.app, 'POST', `/api/mana/questions/${failed.id}/retry`, { cookie: doctor })
    expect((await adminQuery("SELECT outcome FROM audit_events WHERE action = 'ai.job_retry'")).rows).toEqual([{ outcome: 'failure' }])

    await call(withAi.app, 'POST', `/api/patients/${p.id}/consents/${granted.consents.find((c) => c.type === 'ai_record_assistant')!.id}/withdraw`, { cookie: nurse })
    const sent = qa.seen.length
    const a = ManaAnswer.parse((await ask(withAi, doctor, p.id, { question: 'Allergies?' })).json())
    expect(a.generation.status).toBe('consent_required')
    expect(a.generation.reason).toMatch(/withdrawn consent/)
    expect(qa.seen).toHaveLength(sent)
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'consent.blocked'")
    expect(rows).toEqual([{ details: expect.objectContaining({ type: 'ai_record_assistant', state: 'withdrawn' }) }])
  })

  it('asking without an AI summary sends nothing to the provider', async () => {
    const { p, nurse, doctor } = await scenario(withAi)
    await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'ai_record_assistant', method: 'verbal' } })
    const a = ManaAnswer.parse((await ask(withAi, doctor, p.id, { question: 'Allergies?', generate: false })).json())
    expect(a.generation.status).toBe('not_requested')
    expect(qa.seen).toHaveLength(0)
  })
})

describe('inserting AI output into the note', () => {
  it('only by explicit insertion of reviewed output, keeping a reference to the AI artifact through signing', async () => {
    const { p, e2, doctor } = await scenario(noKeys)
    const insert = (body: Record<string, unknown>, cookie = doctor) => call(noKeys.app, 'POST', `/api/encounters/${e2.id}/insertions`, { cookie, body })

    // A Mana answer (record rules) inserted into the history.
    const a = ManaAnswer.parse((await ask(noKeys, doctor, p.id, { question: 'Allergies?', encounterId: e2.id })).json())
    const res = await insert({ version: e2.version, section: 'pastHistory', text: 'Allergy to Penicillin (rash), per record.', subjectType: 'mana_answer', subjectId: a.id })
    expect(res.statusCode).toBe(201)
    let enc = Encounter.parse(res.json())
    expect(enc.note.pastHistory).toBe('Allergy to Penicillin (rash), per record.')
    expect(enc.version).toBe(e2.version + 1)
    // The rules' version the answer was made with (v4 since G14).
    expect(enc.aiInsertions).toEqual([expect.objectContaining({ section: 'pastHistory', subjectType: 'mana_answer', subjectId: a.id, producedBy: 'record rules mana-record-v4; text chosen and edited by the doctor', insertedByName: 'Test t.doctor', retained: true })])

    // The same text from the same answer goes into a section once.
    expect((await insert({ version: enc.version, section: 'pastHistory', text: 'Allergy to Penicillin (rash), per record.', subjectType: 'mana_answer', subjectId: a.id })).json().error).toBe('already_inserted')

    // Stale editor version, other doctors, other patients' artifacts: refused.
    expect((await insert({ version: e2.version, section: 'plan', text: 'x', subjectType: 'mana_answer', subjectId: a.id })).json().error).toBe('version_conflict')
    expect((await insert({ version: enc.version, section: 'plan', text: 'x', subjectType: 'mana_answer', subjectId: a.id }, await login(noKeys.app, 't.doctor2'))).statusCode).toBe(403)
    const other = await scenario(noKeys, { name: 'Gopal', phone: '98400 55555' })
    const otherAnswer = ManaAnswer.parse((await ask(noKeys, doctor, other.p.id, { question: 'Allergies?' })).json())
    expect((await insert({ version: enc.version, section: 'plan', text: 'x', subjectType: 'mana_answer', subjectId: otherAnswer.id })).statusCode).toBe(404)

    // A rule-based recommendation must be accepted before it can be inserted.
    await call(noKeys.app, 'POST', `/api/encounters/${e2.id}/ai-consent`, { cookie: doctor, body: { method: 'verbal' } })
    const ai = EncounterAi.parse((await call(noKeys.app, 'POST', `/api/encounters/${e2.id}/recommendations`, { cookie: doctor, body: {} })).json())
    const rec = ai.recommendations.find((r) => r.kind === 'safety_check')!
    expect((await insert({ version: enc.version, section: 'plan', text: rec.text, subjectType: 'recommendation', subjectId: rec.id })).json().error).toBe('not_reviewed')
    await call(noKeys.app, 'POST', `/api/ai-review/recommendation/${rec.id}`, { cookie: doctor, body: { action: 'edited', text: 'Amoxicillin stopped: penicillin allergy.', confirmFlags: true } })
    // Only the reviewed text can carry the AI reference.
    expect((await insert({ version: enc.version, section: 'plan', text: 'Start amoxicillin 500 mg three times daily.', subjectType: 'recommendation', subjectId: rec.id })).json().error).toBe('text_mismatch')
    enc = Encounter.parse((await insert({ version: enc.version, section: 'plan', text: 'Amoxicillin stopped: penicillin allergy.', subjectType: 'recommendation', subjectId: rec.id })).json())
    // A section cannot be pushed past its length limit (which would break every later autosave).
    const tooLong = await insert({ version: enc.version, section: 'chiefComplaint', text: 'x'.repeat(1001), subjectType: 'mana_answer', subjectId: a.id })
    expect([tooLong.statusCode, tooLong.json().message]).toEqual([400, expect.stringContaining('longer than 1000 characters')])
    expect(enc.aiInsertions[1]).toMatchObject({ subjectType: 'recommendation', producedBy: expect.stringContaining('adaxai-rules'), retained: true })

    // The doctor later edits the inserted plan text: the insertion is kept but marked as not retained.
    const saved = Encounter.parse(
      (
        await call(noKeys.app, 'PUT', `/api/encounters/${e2.id}/draft`, {
          cookie: doctor,
          body: { version: enc.version, note: { ...enc.note, assessment: 'Viral upper respiratory infection.', plan: 'Paracetamol; fluids.' }, diagnoses: [{ description: 'Acute upper respiratory infection', code: 'J06.9', kind: 'primary' }], prescription: [rx('Paracetamol')] },
        })
      ).json(),
    )
    expect(saved.aiInsertions.map((i) => i.retained)).toEqual([true, false])
    expect((await call(noKeys.app, 'POST', `/api/encounters/${e2.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    const { rows } = await adminQuery(`SELECT signed_snapshot FROM encounters WHERE id = '${e2.id}'`)
    expect(rows[0].signed_snapshot.aiInsertions).toEqual([
      expect.objectContaining({ subjectType: 'mana_answer', subjectId: a.id, retained: true }),
      expect.objectContaining({ subjectType: 'recommendation', subjectId: rec.id, retained: false }),
    ])
    expect((await insert({ version: saved.version + 1, section: 'plan', text: 'x', subjectType: 'mana_answer', subjectId: a.id })).json().error).toBe('encounter_signed')

    // Append-only trail.
    await expect(adminQuery('DELETE FROM note_insertions')).rejects.toThrow()
    const { rows: actions } = await adminQuery("SELECT subject_type, action FROM ai_review_actions WHERE action = 'inserted' ORDER BY created_at")
    expect(actions).toEqual([
      { subject_type: 'mana_answer', action: 'inserted' },
      { subject_type: 'recommendation', action: 'inserted' },
    ])
  })
})
