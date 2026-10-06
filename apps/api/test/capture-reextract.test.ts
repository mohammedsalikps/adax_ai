import { EncounterAi, PatientDetail, Visit, Encounter } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { RuleFactExtractor } from '../src/ai/extract/rules.ts'
import { type PointContent, planReextraction, pointSignature, relabelledSince, type StoredPoint } from '../src/ai/extract/reextract.ts'
import type { AiProviders, SpeechSegment } from '../src/ai/providers.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import type { AppSettings } from '../src/settings/schema.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'
import { FakeTranscriber, multipartAudio, webm } from './speech-support.ts'

// Finding the important points again while a recording goes on (Doctor HERO, live transcription): the fixed rules run after each transcribed part.
// A point the doctor has not decided yet that a new run finds again unchanged keeps its row and its id (a doctor confirming it mid-review is never
// told it was replaced); new points appear; points the doctor decided are left exactly as they were; a point that changed is replaced; nothing is
// ever confirmed by the extraction itself; the audit keeps counts only.

const seg = (text: string, startMs: number, endMs: number): SpeechSegment => ({ startMs, endMs, text, confidence: 0.9, avgLogprob: -0.1, noSpeechProb: 0.01 })

const speech = new FakeTranscriber()
const providers = (): AiProviders => ({ drafter: null, transcriber: speech, extractor: new RuleFactExtractor(), reasons: { llm: null, stt: null } })
// The database is reset between tests, so the per-account sign-in limit is lifted here (it is tested with the auth tests).
const manyLogins = (): AppSettings => {
  const f = loadAppSettings()
  return { ...f, security: { ...f.security, rateLimits: { ...f.security.rateLimits, loginPerAccount: { max: 10_000, windowSeconds: 60 }, loginPerIp: { max: 10_000, windowSeconds: 60 } } } }
}
const ctx = createTestApp({ ai: providers(), settings: manyLogins() })
let fx: Fixture

afterAll(async () => {
  await ctx.close()
})

/** A live recording whose first part says `first` and second part says `second`, with the patient's recording consent. */
async function recording(first: SpeechSegment[], second: SpeechSegment[]) {
  const nurse = await login(ctx.app, 't.nurse')
  const doctor = await login(ctx.app, 't.doctor')
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: 'Reextract', phone: '9300011111' }) })).json())
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Fever' } })).json())
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/ai-consent`, { cookie: doctor, body: { method: 'verbal' } })).statusCode).toBe(201)
  speech.script = (n) => (n === 1 ? first : second)
  const tid = (await call(ctx.app, 'POST', `/api/encounters/${e.id}/live-transcripts`, { cookie: doctor })).json().transcriptId as string
  // The recording has been going on for ten minutes, so the second part may start at 20 s.
  await adminQuery("UPDATE transcripts SET created_at = created_at - interval '10 minutes' WHERE id = $1", [tid])
  const part = async (chunkIndex: number, offsetMs: number) => {
    const m = multipartAudio({ chunkIndex: String(chunkIndex), offsetMs: String(offsetMs) }, { name: 'c.webm', type: 'audio/webm', data: webm(`part-${chunkIndex}`) })
    const res = await ctx.app.inject({ method: 'POST', url: `/api/transcripts/${tid}/chunks`, headers: { ...m.headers, cookie: doctor, 'x-adaxai-csrf': '1' }, payload: m.payload })
    expect(res.statusCode).toBe(201)
  }
  const extract = async () => {
    const res = await call(ctx.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: doctor })
    expect(res.statusCode).toBe(201)
    return EncounterAi.parse(res.json())
  }
  const review = (id: string, body: Record<string, unknown>) => call(ctx.app, 'POST', `/api/ai-review/fact/${id}`, { cookie: doctor, body })
  const assign = async (assignments: { segmentId: string; speaker: string }[]) => expect((await call(ctx.app, 'POST', `/api/transcripts/${tid}/speakers`, { cookie: doctor, body: { assignments } })).statusCode).toBe(200)
  await part(0, 0)
  return { e, tid, doctor, part, extract, review, assign }
}

const factRows = async (tid: string) => (await adminQuery('SELECT id, category, text, status, decided_at FROM clinical_facts WHERE transcript_id = $1 ORDER BY created_at, sort_order', [tid])).rows as { id: string; category: string; text: string; status: string; decided_at: Date | null }[]

describe('finding the points again on a growing transcript', () => {
  beforeEach(async () => {
    await resetDatabase()
    fx = await createFixture(ctx.db)
    speech.n = 0
    speech.failNext = false
    speech.ready = true
    speech.reason = null
    speech.language = 'en'
    speech.script = null
    speech.calls = []
  })

  it('keeps the undecided points it finds again unchanged, with their ids and status; adds the new ones; leaves the decided ones as they were', async () => {
    const r = await recording([seg('I have had a fever for three days.', 0, 2400), seg('I am allergic to penicillin.', 2400, 4200), seg('Do you take any medicines? I take metformin every day.', 4200, 7000)], [seg('I also have a sore throat since yesterday.', 0, 2000)])
    await r.assign([
      { segmentId: 'S1', speaker: 'Patient' },
      { segmentId: 'S2', speaker: 'Patient' },
      { segmentId: 'S3', speaker: 'Patient' },
    ])
    const run1 = (await r.extract()).facts
    const complaint = run1.find((f) => f.category === 'chief_complaint')!
    const allergy = run1.find((f) => f.category === 'allergy')!
    const duration = run1.find((f) => f.category === 'duration')!
    expect([complaint, allergy, duration].every(Boolean)).toBe(true)
    // The doctor decides some while the recording goes on: one confirmed, one rejected, one set aside; the rest are still drafts.
    expect((await r.review(complaint.id, { action: 'accepted', confirmFlags: true })).statusCode).toBe(200)
    expect((await r.review(allergy.id, { action: 'rejected' })).statusCode).toBe(200)
    expect((await r.review(duration.id, { action: 'deferred' })).statusCode).toBe(200)
    const before = await factRows(r.tid)
    const undecidedBefore = before.filter((f) => f.status === 'pending' || f.status === 'deferred')
    const decidedBefore = before.filter((f) => ['accepted', 'edited', 'rejected'].includes(f.status))
    expect(undecidedBefore.length).toBeGreaterThan(1)

    // The next part arrives with something new; the points are found again.
    await r.part(1, 20_000)
    const run2 = await r.extract()
    const after = await factRows(r.tid)

    // Every undecided point is still there under the same id, with the same status (a point set aside stays set aside); none was replaced.
    for (const f of undecidedBefore) expect(after.find((x) => x.id === f.id)).toMatchObject({ status: f.status, text: f.text, category: f.category })
    expect(after.filter((f) => f.status === 'superseded')).toEqual([])
    // The decided ones are exactly as the doctor left them, and none is proposed a second time.
    for (const f of decidedBefore) expect(after.find((x) => x.id === f.id)).toEqual(f)
    expect(after.filter((f) => f.category === 'chief_complaint' && f.text === complaint.text)).toHaveLength(1)
    expect(after.filter((f) => f.category === 'allergy')).toHaveLength(1)
    // What the new part said is a new draft, tied to its own line.
    const fresh = run2.facts.filter((f) => !before.some((b) => b.id === f.id))
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh.every((f) => f.status === 'pending' && f.sourceSegmentIds.includes('S4'))).toBe(true)
    expect(fresh.some((f) => /sore throat/i.test(f.text))).toBe(true)
    // A draft the doctor was looking at can still be confirmed by the id they had: it was not "replaced by a newer run".
    const stillPending = undecidedBefore.find((f) => f.status === 'pending')!
    expect((await r.review(stillPending.id, { action: 'accepted', confirmFlags: true })).statusCode).toBe(200)

    // The job and its audit entry hold counts only: what was kept, added and replaced; never the words.
    const job = (await adminQuery("SELECT summary FROM ai_jobs WHERE kind = 'extraction' ORDER BY created_at DESC LIMIT 1")).rows[0].summary as Record<string, unknown>
    expect(job).toMatchObject({ kept: undecidedBefore.length, added: fresh.length, replaced: 0 })
    const audit = (await adminQuery("SELECT details FROM audit_events WHERE action = 'ai.extraction' ORDER BY id DESC LIMIT 1")).rows[0].details as Record<string, unknown>
    expect(audit).toMatchObject({ kept: undecidedBefore.length, added: fresh.length, replaced: 0 })
    expect(JSON.stringify(audit)).not.toMatch(/fever|penicillin|metformin|sore throat/i)
  })

  it('replaces a point whose content changed, or whose source line was given a speaker after it was found; it never confirms anything', async () => {
    const r = await recording([seg('I have had a fever for three days.', 0, 2400), seg('I am allergic to penicillin.', 2400, 4200)], [seg('I also have a sore throat since yesterday.', 0, 2000)])
    // Nobody assigned yet: who said each line is guessed from the wording.
    const run1 = (await r.extract()).facts
    const fromS1 = run1.filter((f) => f.sourceSegmentIds.includes('S1'))
    const fromS2 = run1.filter((f) => f.sourceSegmentIds.includes('S2') && !f.sourceSegmentIds.includes('S1'))
    expect(fromS1.length).toBeGreaterThan(0)
    expect(fromS2.length).toBeGreaterThan(0)

    // The doctor says S1 was the patient's: the points from S1 now read differently (who said it, its source's wording) and are replaced; the ones
    // from S2 are found again unchanged and kept.
    await r.assign([{ segmentId: 'S1', speaker: 'Patient' }])
    await r.part(1, 20_000)
    const run2 = (await r.extract()).facts
    for (const f of fromS1) expect(run2.find((x) => x.id === f.id)).toBeUndefined()
    for (const f of fromS2) expect(run2.find((x) => x.id === f.id)).toMatchObject({ status: 'pending' })
    const s1Now = run2.filter((f) => f.sourceSegmentIds.includes('S1'))
    expect(s1Now.length).toBeGreaterThan(0)
    expect(s1Now.every((f) => f.speakerChanged === false && !fromS1.some((o) => o.id === f.id))).toBe(true)
    const superseded = (await factRows(r.tid)).filter((f) => f.status === 'superseded').map((f) => f.id)
    expect(superseded.sort()).toEqual(fromS1.map((f) => f.id).sort())

    // S2 is then given to the patient too, and its points are found again after that (they now say who said it).
    await r.assign([{ segmentId: 'S2', speaker: 'Patient' }])
    const run3 = (await r.extract()).facts
    const s2Points = run3.filter((f) => f.sourceSegmentIds.includes('S2') && f.status === 'pending')
    expect(s2Points.length).toBeGreaterThan(0)
    for (const f of fromS2) expect(run3.find((x) => x.id === f.id)).toBeUndefined()
    // The same speaker given again to S2: the words and who said it are unchanged, but the screen says "speaker changed" on these points, for
    // good if they were kept; they are replaced by points found after the change, which carry no such mark.
    await r.assign([{ segmentId: 'S2', speaker: 'Patient' }])
    const marked = EncounterAi.parse((await call(ctx.app, 'GET', `/api/encounters/${r.e.id}/ai`, { cookie: r.doctor })).json()).facts.filter((f) => s2Points.some((p) => p.id === f.id))
    expect(marked).toHaveLength(s2Points.length)
    expect(marked.every((f) => f.speakerChanged)).toBe(true)
    const run4 = (await r.extract()).facts
    for (const f of s2Points) expect(run4.find((x) => x.id === f.id)).toBeUndefined()
    const s2Now = run4.filter((f) => f.sourceSegmentIds.includes('S2'))
    expect(s2Now.length).toBe(s2Points.length)
    expect(s2Now.every((f) => f.speakerChanged === false && f.status === 'pending')).toBe(true)
    // Points that did not change on the way (the new part's) kept their ids through all of this.
    const s3 = run2.filter((f) => f.sourceSegmentIds.includes('S3') && f.status === 'pending')
    expect(s3.length).toBeGreaterThan(0)
    for (const f of s3) expect(run4.find((x) => x.id === f.id)).toMatchObject({ status: 'pending' })

    // The extraction itself never decided anything: no review was recorded, and nothing is confirmed or rejected.
    expect((await adminQuery('SELECT count(*)::int AS n FROM ai_review_actions')).rows[0].n).toBe(0)
    expect((await factRows(r.tid)).every((f) => f.status === 'pending' || f.status === 'superseded')).toBe(true)
  })
})

describe('the re-extraction plan (pure)', () => {
  const content = (over: Partial<PointContent> = {}): PointContent => ({
    category: 'symptom',
    text: 'fever',
    attribution: 'patient_reported',
    certainty: 'stated',
    uncertaintyReason: null,
    negated: false,
    attributes: {},
    flags: ['not_in_record'],
    evidence: [{ relation: 'supports', sourceType: 'transcript_segment', sourceId: null, sourceRef: 'S1', provenance: 'patient_reported', excerpt: 'Patient: I have a fever.', note: null }],
    producedBy: { provider: 'adaxai-rules', model: 'extract-rules-v1', promptVersion: 'extract-rules-v1' },
    ...over,
  })
  const stored = (id: string, c: PointContent, createdAt = new Date('2026-10-06T10:00:00Z')): StoredPoint => ({ id, createdAt, content: c })

  it('compares the stored form: empty details, key order, flag order and surrounding spaces do not make a point different', () => {
    expect(pointSignature(content({ attributes: { substance: 'penicillin', dose: null }, flags: ['uncertain', 'not_in_record'] }))).toBe(pointSignature(content({ attributes: { substance: 'penicillin' }, flags: ['not_in_record', 'uncertain'] })))
    expect(pointSignature(content({ attributes: { a: 1, b: 2 } }))).toBe(pointSignature(content({ attributes: { b: 2, a: 1 } })))
    expect(pointSignature(content({ text: '  fever ' }))).toBe(pointSignature(content({ text: 'fever' })))
    // What the doctor sees, or what produced it, makes it a different point.
    for (const over of [{ text: 'fevers' }, { category: 'chief_complaint' }, { attribution: 'clinician_stated' }, { certainty: 'uncertain' }, { negated: true }, { flags: ['conflicts_with_record'] }, { attributes: { substance: 'x' } }, { producedBy: { provider: 'adaxai-rules', model: 'extract-rules-v2', promptVersion: 'extract-rules-v2' } }])
      expect(pointSignature(content(over as Partial<PointContent>))).not.toBe(pointSignature(content()))
    expect(pointSignature(content({ evidence: [{ ...content().evidence[0]!, excerpt: 'Doctor: I have a fever.' }] }))).not.toBe(pointSignature(content()))
  })

  it('keeps each stored point for one finding only, replaces what is not found again, and adds the rest', () => {
    const plan = planReextraction(
      [stored('a', content()), stored('b', content({ text: 'cough' })), stored('c', content({ text: 'old' }))],
      [
        { item: 'fever-1', content: content() },
        { item: 'fever-2', content: content() },
        { item: 'cough', content: content({ text: 'cough' }) },
        { item: 'rash', content: content({ text: 'rash' }) },
      ],
      [],
    )
    expect(plan).toEqual({ keep: ['a', 'b'], add: ['fever-2', 'rash'], replace: ['c'] })
  })

  it('a point whose source line got a speaker after it was found is not kept, even with the same words', () => {
    const p = stored('a', content(), new Date('2026-10-06T10:00:00Z'))
    expect(relabelledSince(p, [{ label: 'S1', at: new Date('2026-10-06T09:59:00Z') }])).toBe(false)
    expect(relabelledSince(p, [{ label: 'S2', at: new Date('2026-10-06T10:05:00Z') }])).toBe(false)
    expect(relabelledSince(p, [{ label: 'S1', at: new Date('2026-10-06T10:05:00Z') }])).toBe(true)
    expect(planReextraction([p], [{ item: 'x', content: content() }], [{ label: 'S1', at: new Date('2026-10-06T10:05:00Z') }])).toEqual({ keep: [], add: ['x'], replace: ['a'] })
  })
})
