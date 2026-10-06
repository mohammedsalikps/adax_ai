import { Encounter, EncounterAi, PatientDetail, type TranscriptSegment, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AiProviderError, type AiProviders, type ExtractedFact, type FactExtractor, type RecommendationInput, type RecommendationOut, type Recommender } from '../src/ai/providers.ts'
import { runRetention } from '../src/files/retention.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { testConfig } from './helpers.ts'
import { FakeTranscriber } from './speech-support.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, type TestContext } from './helpers.ts'

// --- Test doubles for the external providers (tests only; the product never fakes AI output) ---
const detail = (d: Partial<ExtractedFact['details']> = {}): ExtractedFact['details'] => ({ substance: null, medication: null, dose: null, duration: null, vitalKind: null, value: null, unit: null, ...d })
const fact = (f: Partial<ExtractedFact> & Pick<ExtractedFact, 'category' | 'text' | 'sourceSegmentIds'>): ExtractedFact => ({ attribution: 'patient_reported', certainty: 'stated', uncertaintyReason: null, negated: false, details: detail(), ...f })

class FakeExtractor implements FactExtractor {
  readonly provider = 'fake'
  readonly model = 'fake-extract'
  readonly promptVersion = 'extract-v1'
  calls = 0
  seen: TranscriptSegment[][] = []
  failNext: AiProviderError | null = null
  facts: ExtractedFact[] = []
  async extract(segments: TranscriptSegment[]) {
    this.calls++
    this.seen.push(segments)
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
    return { facts: this.facts, model: 'fake-extract', inputTokens: 10, outputTokens: 5, requestId: null }
  }
}
class FakeRecommender implements Recommender {
  readonly provider = 'fake'
  readonly model = 'fake-recommend'
  readonly promptVersion = 'recommend-v1'
  seen: RecommendationInput[] = []
  out: RecommendationOut[] = []
  async recommend(input: RecommendationInput) {
    this.seen.push(input)
    return { recommendations: this.out, insufficientData: this.out.length === 0, insufficientDataReason: this.out.length ? null : 'Not enough information.', model: 'fake-recommend', inputTokens: 10, outputTokens: 5, requestId: null }
  }
}
const extractor = new FakeExtractor()
const recommender = new FakeRecommender()
const transcriber = new FakeTranscriber()
const withAi = createTestApp({ ai: { drafter: null, extractor, recommender, transcriber, reasons: { llm: null, stt: null } } satisfies AiProviders })
const noKeys = createTestApp()
let fx: Fixture

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(withAi.db)
  extractor.calls = 0
  extractor.seen = []
  extractor.failNext = null
  recommender.seen = []
  recommender.out = []
  transcriber.n = 0
  transcriber.failNext = false
  extractor.facts = [
    fact({ category: 'chief_complaint', text: 'Fever for three days.', sourceSegmentIds: ['S2'] }),
    fact({ category: 'allergy', text: 'Denies any allergies.', negated: true, sourceSegmentIds: ['S4'] }),
    fact({ category: 'medication_history', text: 'Takes metformin every morning.', details: detail({ medication: 'metformin' }), sourceSegmentIds: ['S5'] }),
    fact({ category: 'vital_sign', text: 'Temperature stated as 37 degrees.', attribution: 'clinician_stated', details: detail({ vitalKind: 'temperature', value: 37, unit: '°C' }), sourceSegmentIds: ['S6'] }),
    fact({ category: 'symptom', text: 'Cough.', sourceSegmentIds: ['S1'] }),
    fact({ category: 'symptom', text: 'Possibly night sweats.', certainty: 'uncertain', uncertaintyReason: 'Inaudible', sourceSegmentIds: ['S99'] }),
    fact({ category: 'red_flag', text: 'Chest pain when coughing.', sourceSegmentIds: ['S2'] }),
  ]
})
afterAll(async () => {
  await withAi.close()
  await noKeys.close()
})

const TRANSCRIPT = [
  'Doctor: What brings you in today?',
  'Patient: I have had a fever for three days and some chest pain when I cough.',
  'Doctor: Any allergies?',
  'Patient: No, no allergies at all.',
  'Patient: I take metformin every morning.',
  'Doctor: Your temperature is 37 degrees today.',
  'Patient: I do not have any shortness of breath.',
].join('\n')

const draft = (version: number, over: Record<string, unknown> = {}) => ({
  version,
  note: { chiefComplaint: 'Fever', history: '', pastHistory: '', examination: '', assessment: 'Assessment text', plan: 'Plan text', followUp: '' },
  diagnoses: [{ description: 'Type 2 diabetes mellitus', code: 'E11.9', kind: 'primary' }],
  prescription: [{ drugName: 'Metformin', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Twice daily', duration: '30 days', instructions: '' }],
  ...over,
})

/** A patient with a recorded allergy, one signed earlier consultation, today's vitals and an open consultation. */
let seq = 0
async function scenario(ctx: TestContext, { consent = true, vitals = true } = {}) {
  const nurse = await login(ctx.app, 't.nurse')
  const doctor = await login(ctx.app, 't.doctor')
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient(seq === 1 ? {} : { givenName: `Lakshmi${'abcdefgh'[seq % 8]}`, phone: `98400 7777${seq % 10}` }) })).json())
  await call(ctx.app, 'POST', `/api/patients/${p.id}/allergies`, { cookie: nurse, body: { substance: 'Penicillin', reaction: 'Rash', severity: 'moderate' } })
  const v1 = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
  const e1 = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v1.id}/encounter`, { cookie: doctor })).json())
  const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e1.id}/draft`, { cookie: doctor, body: draft(e1.version) })).json())
  expect((await call(ctx.app, 'POST', `/api/encounters/${e1.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
  // HERO final (deliberate change): signing no longer closes the visit; the doctor completes it, so the same-day second visit below can open.
  expect((await call(ctx.app, 'POST', `/api/encounters/${e1.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
  const v2 = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
  if (vitals) await call(ctx.app, 'POST', `/api/visits/${v2.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 38.6 }, { kind: 'spo2', value: 97 }] } })
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v2.id}/encounter`, { cookie: doctor })).json())
  if (consent) await call(ctx.app, 'POST', `/api/encounters/${e.id}/ai-consent`, { cookie: doctor, body: { method: 'verbal' } })
  return { p, e, nurse, doctor }
}

async function withTranscript(ctx: TestContext, eid: string, doctor: string) {
  const ai = EncounterAi.parse((await call(ctx.app, 'POST', `/api/encounters/${eid}/transcripts`, { cookie: doctor, body: { text: TRANSCRIPT } })).json())
  return ai.transcripts[0]!
}

describe('clinical fact extraction', () => {
  it('stores facts with transcript evidence and flags uncertainty, missing sources, speaker mismatch and record conflicts', async () => {
    const { p, e, doctor } = await scenario(withAi)
    const t = await withTranscript(withAi, e.id, doctor)
    const res = await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor })
    expect(res.statusCode).toBe(201)
    const ai = EncounterAi.parse(res.json())
    const by = (text: string) => ai.facts.find((f) => f.text === text)!
    expect(ai.facts).toHaveLength(7)
    expect(ai.facts.every((f) => f.status === 'pending')).toBe(true)

    expect(by('Fever for three days.').flags).toEqual([])
    expect(by('Fever for three days.').evidence).toEqual([expect.objectContaining({ relation: 'supports', sourceType: 'transcript_segment', sourceRef: 'S2', provenance: 'patient_reported' })])

    const allergy = by('Denies any allergies.')
    expect(allergy.flags).toContain('conflicts_with_record')
    expect(allergy.evidence).toContainEqual(expect.objectContaining({ relation: 'conflicts', sourceType: 'allergy', provenance: 'record', excerpt: expect.stringContaining('Penicillin') }))

    const metformin = by('Takes metformin every morning.')
    expect(metformin.flags).toEqual([])
    expect(metformin.evidence).toContainEqual(expect.objectContaining({ relation: 'supports', sourceType: 'prescription_item', provenance: 'record' }))

    const temp = by('Temperature stated as 37 degrees.')
    expect(temp.flags).toContain('conflicts_with_record')
    expect(temp.evidence).toContainEqual(expect.objectContaining({ relation: 'conflicts', sourceType: 'observation', provenance: 'staff_measured' }))

    expect(by('Cough.').flags).toContain('speaker_mismatch')
    expect(by('Possibly night sweats.').flags).toEqual(expect.arrayContaining(['uncertain', 'no_source']))
    expect(by('Chest pain when coughing.').flags).toContain('red_flag')

    // Only pseudonymised text left the server.
    expect(JSON.stringify(extractor.seen)).not.toContain(p.givenName)

    // Persistence and provenance of the job.
    const job = ai.jobs.find((j) => j.kind === 'extraction')!
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1, dataOrigin: 'synthetic', summary: { facts: 7 } })
    expect(job.runs[0]).toMatchObject({ provider: 'fake', model: 'fake-extract', promptVersion: 'extract-v1', status: 'succeeded' })
    const { rows: prompts } = await adminQuery('SELECT id FROM ai_prompt_versions ORDER BY id')
    expect(prompts.map((r) => r.id)).toEqual(['consult-draft-v1', 'extract-v1', 'image-describe-v1', 'mana-assistant-answer-v1', 'mana-assistant-plan-v2', 'mana-qa-v1', 'note-draft-v1', 'recommend-v1'])
    expect((await adminQuery("SELECT count(*)::int AS n FROM ai_models WHERE model = 'fake-extract'")).rows[0].n).toBe(1)
    expect((await adminQuery('SELECT count(*)::int AS n FROM ai_settings_snapshots')).rows[0].n).toBe(1)
    expect(ai.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['ai.extraction', 'ai.job_create', 'ai.transcript_create']))
    // Nothing reached the note.
    const enc = Encounter.parse((await call(withAi.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    expect(enc.note.chiefComplaint).toBe('')
  })

  it('requires explicit confirmation to accept flagged facts; decisions are final and the AI content is immutable', async () => {
    const { e, doctor } = await scenario(withAi)
    const t = await withTranscript(withAi, e.id, doctor)
    const ai = EncounterAi.parse((await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor })).json())
    const clean = ai.facts.find((f) => f.text === 'Fever for three days.')!
    const flagged = ai.facts.find((f) => f.text === 'Denies any allergies.')!
    const review = (id: string, body: object) => call(withAi.app, 'POST', `/api/ai-review/fact/${id}`, { cookie: doctor, body })

    const accepted = await review(clean.id, { action: 'accepted' })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().item).toEqual({ id: clean.id, type: 'fact', section: 'chiefComplaint', finalText: 'Fever for three days.', action: 'accepted' })
    expect((await review(clean.id, { action: 'rejected' })).json().error).toBe('already_decided')

    const gated = await review(flagged.id, { action: 'accepted' })
    expect(gated.statusCode).toBe(409)
    expect(gated.json().error).toBe('confirmation_required')
    expect((await review(flagged.id, { action: 'deferred', reason: 'Ask the patient again' })).statusCode).toBe(200)
    const edited = await review(flagged.id, { action: 'edited', text: 'Allergic to penicillin (rash); patient initially denied allergies.', confirmFlags: true })
    expect(edited.json().item.finalText).toMatch(/penicillin/)

    const { rows } = await adminQuery('SELECT action, reason FROM ai_review_actions ORDER BY created_at')
    expect(rows).toEqual([
      { action: 'accepted', reason: null },
      { action: 'deferred', reason: 'Ask the patient again' },
      { action: 'edited', reason: null },
    ])
    // The database refuses changes to AI content and to decided items, and deletion of the review history.
    await expect(withAi.pool.query("UPDATE clinical_facts SET text = 'changed' WHERE id = $1", [clean.id])).rejects.toMatchObject({ code: '42501' })
    await expect(withAi.pool.query("UPDATE clinical_facts SET status = 'rejected' WHERE id = $1", [clean.id])).rejects.toMatchObject({ code: '42501' })
    await expect(withAi.pool.query('DELETE FROM ai_review_actions')).rejects.toMatchObject({ code: '42501' })
    await expect(withAi.pool.query('DELETE FROM ai_evidence')).rejects.toMatchObject({ code: '42501' })
    await expect(withAi.pool.query("UPDATE transcript_segments SET text = 'x'")).rejects.toMatchObject({ code: '42501' })
  })

  it('a failed run is recorded and can be retried without duplicating results; a repeated request key runs once', async () => {
    const { e, doctor } = await scenario(withAi)
    const t = await withTranscript(withAi, e.id, doctor)
    extractor.failNext = new AiProviderError('rate_limited', 'The AI service is busy. Try again in a minute.', true)
    const failed = await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor })
    expect(failed.statusCode).toBe(502)
    expect(failed.json().error).toBe('ai_rate_limited')
    const job = (await adminQuery("SELECT id, status, retryable, last_error_code FROM ai_jobs WHERE kind = 'extraction'")).rows[0]
    expect(job).toMatchObject({ status: 'failed', retryable: true, last_error_code: 'rate_limited' })
    expect((await adminQuery('SELECT count(*)::int AS n FROM clinical_facts')).rows[0].n).toBe(0)

    const retried = await call(withAi.app, 'POST', `/api/ai-jobs/${job.id}/retry`, { cookie: doctor })
    expect(retried.statusCode).toBe(200)
    expect(retried.json().job).toMatchObject({ status: 'succeeded', attempts: 2 })
    expect(retried.json().job.runs.map((r: { status: string }) => r.status)).toEqual(['succeeded', 'failed'])
    expect((await adminQuery('SELECT count(*)::int AS n FROM clinical_facts')).rows[0].n).toBe(7)
    expect((await call(withAi.app, 'POST', `/api/ai-jobs/${job.id}/retry`, { cookie: doctor })).json().error).toBe('job_not_failed')

    // Same idempotency key: the provider is called once and the same job is returned.
    const key = crypto.randomUUID()
    const before = extractor.calls
    const pendingIds = async () => (await adminQuery("SELECT id FROM clinical_facts WHERE status = 'pending' ORDER BY id")).rows.map((r) => r.id as string)
    const pendingBefore = await pendingIds()
    const a = await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor, body: { idempotencyKey: key } })
    const b = await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor, body: { idempotencyKey: key } })
    expect(a.json().jobId).toBe(b.json().jobId)
    expect(extractor.calls).toBe(before + 1)
    // Changed deliberately (Doctor HERO: points are found again after each recorded part): a new extraction that finds the same points keeps the
    // undecided facts as they are, the same rows under the same ids, instead of duplicating them (or, as before, superseding and re-adding them).
    expect(pendingBefore).toHaveLength(7)
    expect(await pendingIds()).toEqual(pendingBefore)
    expect((await adminQuery('SELECT count(*)::int AS n FROM clinical_facts')).rows[0].n).toBe(7)
    expect((await adminQuery("SELECT count(*)::int AS n FROM clinical_facts WHERE status = 'superseded'")).rows[0].n).toBe(0)
  })
})

describe('recommendations', () => {
  it('rule-based safety checks run without any AI provider and cite their sources; the AI step reports itself unavailable', async () => {
    const { e, doctor } = await scenario(noKeys)
    const enc = Encounter.parse((await call(noKeys.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    await call(noKeys.app, 'PUT', `/api/encounters/${e.id}/draft`, {
      cookie: doctor,
      body: draft(enc.version, { prescription: [{ drugName: 'Amoxicillin', strength: '500 mg', form: 'Capsule', dose: '1 capsule', route: 'Oral', frequency: 'TDS', duration: '5 days', instructions: '' }] }),
    })
    await withTranscript(noKeys, e.id, doctor)
    const res = await call(noKeys.app, 'POST', `/api/encounters/${e.id}/recommendations`, { cookie: doctor, body: {} })
    expect(res.statusCode).toBe(201)
    const ai = EncounterAi.parse(res.json())
    expect(res.json().notice).toMatch(/switched off on this server/)
    expect(ai.recommendations.every((r) => r.source === 'rules' && r.producedBy.provider === 'adaxai-rules' && r.producedBy.model === 'safety-rules-v1')).toBe(true)

    const allergy = ai.recommendations.find((r) => r.kind === 'safety_check' && r.text.includes('Amoxicillin'))!
    expect(allergy).toMatchObject({ urgency: 'attention', unsupported: false })
    expect(allergy.rationale).toMatch(/penicillin/)
    expect(allergy.evidence.map((x) => x.sourceType).sort()).toEqual(['allergy', 'prescription_item'])

    const temp = ai.recommendations.find((r) => r.text.startsWith('Review Temperature'))!
    expect(temp.evidence[0]).toMatchObject({ sourceType: 'observation', provenance: 'staff_measured' })

    // "chest pain" is flagged; "do not have any shortness of breath" is negated and is not.
    const redFlags = ai.recommendations.filter((r) => r.kind === 'red_flag')
    expect(redFlags).toHaveLength(1)
    expect(redFlags[0]!.instruction).toMatch(/duty doctor/)
    expect(redFlags[0]!.evidence).toEqual([expect.objectContaining({ sourceRef: 'S2', provenance: 'patient_reported' })])
  })

  it('missing vitals and allergy status are reported as missing information', async () => {
    const { p, e, doctor, nurse } = await scenario(noKeys, { vitals: false })
    const a = PatientDetail.parse((await call(noKeys.app, 'GET', `/api/patients/${p.id}`, { cookie: nurse })).json()).allergies[0]!
    await call(noKeys.app, 'POST', `/api/patients/${p.id}/allergies/${a.id}/deactivate`, { cookie: nurse })
    const ai = EncounterAi.parse((await call(noKeys.app, 'POST', `/api/encounters/${e.id}/recommendations`, { cookie: doctor, body: { includeLlm: false } })).json())
    expect(ai.recommendations.filter((r) => r.kind === 'missing_information').map((r) => r.text)).toEqual(['Record the patient’s allergy status.', 'No vital signs have been recorded at this visit.'])
  })

  it('language-model recommendations keep only verifiable citations; uncited ones are marked unsupported and need confirmation', async () => {
    const { p, e, doctor } = await scenario(withAi)
    await withTranscript(withAi, e.id, doctor)
    recommender.out = [
      { kind: 'clarification', urgency: 'attention', text: 'Clarify the allergy history.', rationale: 'Recorded penicillin allergy; patient denied allergies.', supportingRefs: ['A1', 'S4'], conflicts: [{ text: 'Denied vs recorded', refs: ['A1', 'S4'] }], missingInformation: [] },
      { kind: 'investigation', urgency: 'routine', text: 'Consider a blood glucose check.', rationale: 'Diabetes.', supportingRefs: ['Z9'], conflicts: [], missingInformation: ['Recent HbA1c'] },
    ]
    const ai = EncounterAi.parse((await call(withAi.app, 'POST', `/api/encounters/${e.id}/recommendations`, { cookie: doctor, body: {} })).json())
    const llm = ai.recommendations.filter((r) => r.source === 'llm')
    expect(llm).toHaveLength(2)
    expect(llm[0]).toMatchObject({ unsupported: false, producedBy: { provider: 'fake', model: 'fake-recommend', version: 'recommend-v1' } })
    expect(llm[0]!.evidence.map((x) => `${x.relation}:${x.sourceRef}`)).toEqual(['supports:A1', 'supports:S4', 'conflicts:A1', 'conflicts:S4'])
    expect(llm[1]).toMatchObject({ unsupported: true, missingInformation: [{ text: 'Recent HbA1c' }], evidence: [] })
    // The model saw record references and no identifiers.
    const sent = recommender.seen[0]!
    expect(sent.recordText).toMatch(/\[A1\] Recorded allergy: Penicillin/)
    expect(sent.recordText).toMatch(/\[D1\] Diagnosis .*Type 2 diabetes/)
    expect(sent.recordText).toMatch(/\[V\d\] Temperature 38.6 °C measured at this visit/)
    expect(JSON.stringify(sent)).not.toContain(p.givenName)
    expect(JSON.stringify(sent)).not.toContain(p.mrn)

    const gated = await call(withAi.app, 'POST', `/api/ai-review/recommendation/${llm[1]!.id}`, { cookie: doctor, body: { action: 'accepted' } })
    expect(gated.json().error).toBe('confirmation_required')
    expect((await call(withAi.app, 'POST', `/api/ai-review/recommendation/${llm[1]!.id}`, { cookie: doctor, body: { action: 'rejected', reason: 'Not relevant today' } })).statusCode).toBe(200)
  })

  it('record-aware recommendations need the current consent wording', async () => {
    const { p, e, doctor, nurse } = await scenario(withAi, { consent: false })
    await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'ai_recording', method: 'verbal' } })
    // Simulate a consent given under the earlier wording (bypassing the consent guard as the test superuser).
    await adminQuery("SET session_replication_role = replica; UPDATE consents SET version = '2026-10-v1';")
    recommender.out = [{ kind: 'follow_up', urgency: 'routine', text: 'Consider review in a week.', rationale: 'x', supportingRefs: ['A1'], conflicts: [], missingInformation: [] }]
    const res = await call(withAi.app, 'POST', `/api/encounters/${e.id}/recommendations`, { cookie: doctor, body: {} })
    expect(res.json().notice).toMatch(/earlier wording/)
    expect(recommender.seen).toHaveLength(0)
    expect(res.json().consent).toMatchObject({ granted: true, current: false })
  })
})

describe('live transcription', () => {
  it('transcribes chunks as they arrive, numbers segments across chunks, and retries a failed chunk', async () => {
    const { e, doctor } = await scenario(withAi)
    const start = await call(withAi.app, 'POST', `/api/encounters/${e.id}/live-transcripts`, { cookie: doctor })
    expect(start.statusCode).toBe(201)
    const tid = start.json().transcriptId as string
    const chunk = (i: number) => {
      const boundary = '----chunk'
      const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chunkIndex"\r\n\r\n${i}\r\n--${boundary}\r\nContent-Disposition: form-data; name="offsetMs"\r\n\r\n${i * 1000}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.webm"\r\nContent-Type: audio/webm\r\n\r\n`), Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`audio-${i}`)]), Buffer.from(`\r\n--${boundary}--\r\n`)])
      return withAi.app.inject({ method: 'POST', url: `/api/transcripts/${tid}/chunks`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: doctor, 'x-adaxai-csrf': '1' }, payload })
    }
    expect((await chunk(0)).statusCode).toBe(201)
    transcriber.failNext = true
    const failed = await chunk(1)
    expect(failed.json().notice).toMatch(/Part 2: The local speech service could not be reached/)
    await chunk(2)
    const failedJob = EncounterAi.parse(failed.json()).jobs.find((j) => j.status === 'failed')!
    await call(withAi.app, 'POST', `/api/ai-jobs/${failedJob.id}/retry`, { cookie: doctor })
    const ended = EncounterAi.parse((await call(withAi.app, 'POST', `/api/transcripts/${tid}/end`, { cookie: doctor })).json())
    const t = ended.transcripts.find((x) => x.id === tid)!
    expect(t.status).toBe('final')
    // Reading order follows the chunks; labels follow arrival.
    expect(t.segments.map((s) => `${s.chunkIndex}:${s.id}:${s.text}`)).toEqual(['0:S1:part 1 words', '1:S3:part 3 words', '2:S2:part 2 words'])
    expect((await chunk(3)).json().error).toBe('transcript_not_live')
    // Chunk audio is kept but not listed as separate recordings.
    expect(ended.audio).toEqual([])
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE original_name LIKE 'live-chunk-%'")).rows[0].n).toBe(3)
  })
})

describe('authorisation and isolation', () => {
  it('only the consultation’s doctor uses or reviews the assistant; nurses, admins and patients cannot read AI artifacts', async () => {
    const { p, e, doctor, nurse } = await scenario(withAi)
    const t = await withTranscript(withAi, e.id, doctor)
    const ai = EncounterAi.parse((await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor })).json())
    const other = await login(withAi.app, 't.doctor2')
    const admin = await login(withAi.app, 't.admin')
    expect((await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: other })).statusCode).toBe(403)
    expect((await call(withAi.app, 'POST', `/api/ai-review/fact/${ai.facts[0]!.id}`, { cookie: other, body: { action: 'rejected' } })).statusCode).toBe(403)
    for (const cookie of [nurse, admin]) {
      expect((await call(withAi.app, 'GET', `/api/encounters/${e.id}/ai`, { cookie })).statusCode).toBe(403)
      expect((await call(withAi.app, 'POST', `/api/ai-review/fact/${ai.facts[0]!.id}`, { cookie, body: { action: 'accepted' } })).statusCode).toBe(403)
    }
    // A patient with a portal account cannot reach AI artifacts, even their own.
    await call(withAi.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'portal_access', method: 'verbal' } })
    const code = (await call(withAi.app, 'POST', `/api/patients/${p.id}/portal-activation`, { cookie: nurse })).json().activationCode
    const act = await call(withAi.app, 'POST', '/api/auth/activate', { body: { mrn: p.mrn, activationCode: code, password: 'My-own-passphrase-1' } })
    const patient = `adaxai_session=${act.cookies.find((c) => c.name === 'adaxai_session')!.value}`
    expect((await call(withAi.app, 'GET', `/api/encounters/${e.id}/ai`, { cookie: patient })).statusCode).toBe(403)
    expect((await call(withAi.app, 'GET', '/api/ai/status', { cookie: patient })).statusCode).toBe(403)
    // A job of another facility is not found.
    const job = ai.jobs[0]!
    await adminQuery("INSERT INTO facilities (code, name) VALUES ('OTHER', 'Other facility')")
    await adminQuery("UPDATE users SET facility_id = (SELECT id FROM facilities WHERE code = 'OTHER') WHERE username = 't.doctor2'")
    const otherFacility = await login(withAi.app, 't.doctor2')
    expect((await call(withAi.app, 'POST', `/api/ai-jobs/${job.id}/retry`, { cookie: otherFacility })).statusCode).toBe(404)
    expect((await call(withAi.app, 'GET', `/api/encounters/${e.id}/ai`, { cookie: otherFacility })).statusCode).toBe(404)
  })

  it('the assistant closes when the consultation is signed', async () => {
    const { e, doctor } = await scenario(withAi)
    const t = await withTranscript(withAi, e.id, doctor)
    const ai = EncounterAi.parse((await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor })).json())
    const enc = Encounter.parse((await call(withAi.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    const saved = Encounter.parse((await call(withAi.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(enc.version) })).json())
    await call(withAi.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })
    expect((await call(withAi.app, 'POST', `/api/ai-review/fact/${ai.facts[0]!.id}`, { cookie: doctor, body: { action: 'accepted' } })).json().error).toBe('encounter_signed')
    expect((await call(withAi.app, 'POST', `/api/encounters/${e.id}/recommendations`, { cookie: doctor, body: {} })).json().error).toBe('encounter_signed')
  })
})

describe('oversight', () => {
  it('admins see aggregate counts only; doctors see rejected outputs with their content; snapshots are stored as evaluation runs', async () => {
    const { p, e, doctor, nurse } = await scenario(withAi)
    const t = await withTranscript(withAi, e.id, doctor)
    const ai = EncounterAi.parse((await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor })).json())
    const fever = ai.facts.find((f) => f.text === 'Fever for three days.')!
    const cough = ai.facts.find((f) => f.text === 'Cough.')!
    await call(withAi.app, 'POST', `/api/ai-review/fact/${fever.id}`, { cookie: doctor, body: { action: 'accepted' } })
    await call(withAi.app, 'POST', `/api/ai-review/fact/${cough.id}`, { cookie: doctor, body: { action: 'rejected', reason: 'Doctor asked, patient did not say this' } })

    const admin = await login(withAi.app, 't.admin')
    const res = await call(withAi.app, 'GET', '/api/ai-oversight/overview', { cookie: admin })
    expect(res.statusCode).toBe(200)
    const o = res.json()
    expect(o.jobs).toContainEqual({ kind: 'extraction', status: 'succeeded', data_origin: 'synthetic', n: 1 })
    const facts = o.outcomes.find((x: { subject: string }) => x.subject === 'fact')
    expect(facts).toMatchObject({ provider: 'fake', model: 'fake-extract', version: 'extract-v1', decided: 2, acceptedShare: 0.5, counts: { accepted: 1, rejected: 1, pending: 5 } })
    expect(o.prompts.map((x: { id: string }) => x.id)).toContain('extract-v1')
    // No patient-level content in the administrator's view.
    const text = JSON.stringify(o)
    for (const s of [p.givenName, p.mrn, 'Fever for three days', 'Doctor asked']) expect(text).not.toContain(s)

    const snap = await call(withAi.app, 'POST', '/api/ai-oversight/evaluations', { cookie: admin })
    expect(snap.statusCode).toBe(201)
    expect(snap.json().metrics).toMatchObject({ version: 'ai-review-metrics-v1', validated: false })
    expect(snap.json().metrics.statements[0]).toMatch(/synthetic or demonstration data/)
    expect((await call(withAi.app, 'GET', '/api/ai-oversight/overview', { cookie: admin })).json().evaluations).toHaveLength(1)
    await expect(withAi.pool.query('DELETE FROM evaluation_runs')).rejects.toMatchObject({ code: '42501' })

    const list = (await call(withAi.app, 'GET', '/api/ai/review-outcomes?decision=rejected', { cookie: doctor })).json().items
    expect(list).toEqual([
      expect.objectContaining({ subjectType: 'fact', category: 'symptom', originalText: 'Cough.', reason: 'Doctor asked, patient did not say this', reviewer: 'Test t.doctor', producedBy: { provider: 'fake', model: 'fake-extract', version: 'extract-v1' } }),
    ])
    expect((await call(withAi.app, 'GET', '/api/ai/review-outcomes', { cookie: admin })).statusCode).toBe(403)
    expect((await call(withAi.app, 'GET', '/api/ai-oversight/overview', { cookie: nurse })).statusCode).toBe(403)
  })
})

describe('retention', () => {
  it('deletes consultation audio of signed consultations after the configured period, keeping the record, transcript and audit trail', async () => {
    const { e, doctor } = await scenario(withAi)
    const open = await scenario(withAi, { vitals: false })
    const wav = Buffer.from('RIFF$\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0data\0\0\0\0', 'binary')
    const send = async (eid: string) => {
      const boundary = '----ret'
      const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`), wav, Buffer.from(`\r\n--${boundary}--\r\n`)])
      const r = await withAi.app.inject({ method: 'POST', url: `/api/encounters/${eid}/audio`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: doctor, 'x-adaxai-csrf': '1' }, payload })
      return EncounterAi.parse(r.json())
    }
    const ai = await send(e.id)
    await send(open.e.id)
    const enc = Encounter.parse((await call(withAi.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    const saved = Encounter.parse((await call(withAi.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(enc.version) })).json())
    await call(withAi.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })

    const settings = loadAppSettings()
    const later = new Date(Date.now() + (settings.retention.consultationAudioDays + 1) * 86_400_000)
    expect(await runRetention(withAi.db, testConfig.storageDir, settings, { dryRun: true, now: later })).toMatchObject({ candidates: 1, deleted: 0 })
    expect(await runRetention(withAi.db, testConfig.storageDir, settings, { dryRun: false, now: new Date() })).toMatchObject({ candidates: 0 })
    expect(await runRetention(withAi.db, testConfig.storageDir, settings, { dryRun: false, now: later })).toMatchObject({ candidates: 1, deleted: 1 })

    const fileId = ai.audio[0]!.fileId
    const gone = await call(withAi.app, 'GET', `/api/files/${fileId}`, { cookie: doctor })
    expect(gone.statusCode).toBe(410)
    expect((await adminQuery('SELECT deleted_reason FROM files WHERE id = $1', [fileId])).rows[0].deleted_reason).toMatch(/retention/)
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'file.retention_delete'")).rows[0].n).toBe(1)
    // The transcript made from it is kept.
    expect((await adminQuery('SELECT count(*)::int AS n FROM transcripts WHERE audio_file_id = $1', [fileId])).rows[0].n).toBe(1)
    expect(await runRetention(withAi.db, testConfig.storageDir, { ...settings, retention: { consultationAudioDays: 0 } }, { dryRun: false, now: later })).toMatchObject({ days: 0, deleted: 0 })
  })
})

describe('signed records', () => {
  it('accepting AI output never changes the consultation; only text the doctor saved in the note is signed', async () => {
    const { e, doctor } = await scenario(withAi)
    const t = await withTranscript(withAi, e.id, doctor)
    recommender.out = [{ kind: 'follow_up', urgency: 'routine', text: 'Consider review in two days.', rationale: 'Fever.', supportingRefs: ['S2'], conflicts: [], missingInformation: [] }]
    const before = Encounter.parse((await call(withAi.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    let ai = EncounterAi.parse((await call(withAi.app, 'POST', `/api/transcripts/${t.id}/extract`, { cookie: doctor })).json())
    ai = EncounterAi.parse((await call(withAi.app, 'POST', `/api/encounters/${e.id}/recommendations`, { cookie: doctor, body: {} })).json())
    for (const f of ai.facts) await call(withAi.app, 'POST', `/api/ai-review/fact/${f.id}`, { cookie: doctor, body: { action: 'accepted', confirmFlags: true } })
    for (const r of ai.recommendations) await call(withAi.app, 'POST', `/api/ai-review/recommendation/${r.id}`, { cookie: doctor, body: { action: 'accepted', confirmFlags: true } })
    const after = Encounter.parse((await call(withAi.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    // No AI action wrote to the consultation.
    expect(after.version).toBe(before.version)
    expect(after.note).toEqual(before.note)
    expect(after.prescription).toEqual(before.prescription)

    const saved = Encounter.parse((await call(withAi.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(after.version) })).json())
    expect((await call(withAi.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    const snapshot = JSON.stringify((await adminQuery('SELECT signed_snapshot FROM encounters WHERE id = $1', [e.id])).rows[0].signed_snapshot)
    for (const text of [...ai.facts.map((f) => f.text), ...ai.recommendations.map((r) => r.text)]) expect(snapshot).not.toContain(text)
    expect(snapshot).toContain('Metformin')
    expect(snapshot).not.toContain('Amoxicillin')
    // And the signed record cannot be changed afterwards, by anyone.
    await expect(withAi.pool.query("UPDATE encounters SET plan = 'AI text' WHERE id = $1", [e.id])).rejects.toMatchObject({ code: '42501' })
  })
})
