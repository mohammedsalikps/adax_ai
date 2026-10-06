import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { CaptureStatus, Encounter, EncounterAi, factState, PatientDetail, Visit } from '@adaxai/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RuleFactExtractor } from '../src/ai/extract/rules.ts'
import type { AiProviders, SpeechSegment } from '../src/ai/providers.ts'
import { LocalSpeechTranscriber } from '../src/ai/stt.ts'
import { currentConsent } from '../src/consents/service.ts'
import { departments, facilities, transcripts, users } from '../src/db/schema.ts'
import { hashPassword } from '../src/auth/password.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import type { AppSettings } from '../src/settings/schema.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD, type TestContext, testConfig } from './helpers.ts'
import { FakeTranscriber, multipartAudio, startSpeechStub, type SpeechStub, webm } from './speech-support.ts'

// Live consultation capture (V2): local speech-to-text, the recording's lifecycle and consent, timestamps, speaker assignment by the doctor,
// the important points, and the line between what was heard, what was extracted and what the doctor confirmed.

const seg = (text: string, startMs: number, endMs: number, over: Partial<SpeechSegment> = {}): SpeechSegment => ({ startMs, endMs, text, confidence: 0.9, avgLogprob: -0.1, noSpeechProb: 0.01, ...over })

const speech = new FakeTranscriber()
const providers = (): AiProviders => ({ drafter: null, transcriber: speech, extractor: new RuleFactExtractor(), reasons: { llm: null, stt: null } })
// Each test signs in a nurse and a doctor again (the database is reset between tests), so the per-account sign-in limit is lifted here; the limit itself is
// tested elsewhere (auth tests) and the limits on audio and costly steps are tested below with their own settings.
const manyLogins = (): AppSettings => {
  const f = loadAppSettings()
  return { ...f, security: { ...f.security, rateLimits: { ...f.security.rateLimits, loginPerAccount: { max: 10_000, windowSeconds: 60 }, loginPerIp: { max: 10_000, windowSeconds: 60 } } } }
}
const withSpeech = createTestApp({ ai: providers(), settings: manyLogins() })
const noSpeech = createTestApp({ settings: manyLogins() }) // as configured by default: no speech provider
let fx: Fixture

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(withSpeech.db)
  speech.n = 0
  speech.failNext = false
  speech.ready = true
  speech.reason = null
  speech.language = 'en'
  speech.script = null
  speech.calls = []
})
afterAll(async () => {
  await withSpeech.close()
  await noSpeech.close()
})

let seq = 0
async function open(ctx: TestContext, { consent = true } = {}) {
  const nurse = await login(ctx.app, 't.nurse')
  const doctor = await login(ctx.app, 't.doctor')
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Cap${seq}`, phone: `93000${String(seq).padStart(5, '0')}` }) })).json())
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Fever' } })).json())
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  if (consent) expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/ai-consent`, { cookie: doctor, body: { method: 'verbal' } })).statusCode).toBe(201)
  return { p, v, e, nurse, doctor }
}

const capture = async (ctx: TestContext, eid: string, cookie: string) => CaptureStatus.parse((await call(ctx.app, 'GET', `/api/encounters/${eid}/capture`, { cookie })).json())
const startLive = (ctx: TestContext, eid: string, cookie: string) => call(ctx.app, 'POST', `/api/encounters/${eid}/live-transcripts`, { cookie })
const chunk = (ctx: TestContext, tid: string, cookie: string, fields: Record<string, string>, data = webm()) => {
  const m = multipartAudio(fields, { name: 'c.webm', type: 'audio/webm', data })
  return ctx.app.inject({ method: 'POST', url: `/api/transcripts/${tid}/chunks`, headers: { ...m.headers, cookie, 'x-adaxai-csrf': '1' }, payload: m.payload })
}
const ai = async (ctx: TestContext, eid: string, cookie: string) => EncounterAi.parse((await call(ctx.app, 'GET', `/api/encounters/${eid}/ai`, { cookie })).json())
/** The recording has been going on for ten minutes, so parts may claim offsets up to that. */
const backdate = (tid: string) => adminQuery("UPDATE transcripts SET created_at = created_at - interval '10 minutes' WHERE id = $1", [tid])

const segmentsDigest = async (tid: string) => createHash('sha256').update(JSON.stringify((await adminQuery('SELECT label, text, speaker, speaker_source, start_ms, end_ms, confidence, language FROM transcript_segments WHERE transcript_id = $1 ORDER BY label', [tid])).rows)).digest('hex')

describe('whether recording may start', () => {
  it('has no hosted fallback: without a configured local speech service it says so and refuses', async () => {
    const { e, doctor } = await open(noSpeech)
    const s = await capture(noSpeech, e.id, doctor)
    expect(s.canRecord).toBe(false)
    expect(s.speech).toMatchObject({ available: false, state: 'not_configured', local: true })
    expect(s.blockedReason).toMatch(/Local transcription is not configured/)
    expect(s.blockedReason).toMatch(/never sent to a hosted service/)
    const res = await startLive(noSpeech, e.id, doctor)
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('stt_unavailable')
    expect((await adminQuery('SELECT count(*)::int AS n FROM transcripts')).rows[0].n).toBe(0)
  })

  it('says the service is not ready when it is configured but not answering, and allows recording when it is', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.ready = false
    speech.reason = 'The local speech service is not running. Start it with "npm run speech:dev".'
    const down = await capture(withSpeech, e.id, doctor)
    expect(down).toMatchObject({ canRecord: false, speech: { available: false, state: 'unavailable' } })
    expect(down.blockedReason).toMatch(/not running/)
    expect((await startLive(withSpeech, e.id, doctor)).statusCode).toBe(503)
    speech.ready = true
    expect(await capture(withSpeech, e.id, doctor)).toMatchObject({ canRecord: true, blockedReason: null, speech: { available: true, state: 'ready', model: 'fake-speech-model', runtime: 'fake-runtime 1' } })
  })

  it('needs the patient’s recording consent: without it nothing starts, and the refusal is audited', async () => {
    const { e, doctor } = await open(withSpeech, { consent: false })
    expect(await capture(withSpeech, e.id, doctor)).toMatchObject({ canRecord: false, consent: { granted: false } })
    const res = await startLive(withSpeech, e.id, doctor)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('consent_required')
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'consent.blocked'")).rows[0].n).toBeGreaterThan(0)
    expect((await adminQuery('SELECT count(*)::int AS n FROM transcripts')).rows[0].n).toBe(0)
  })

  it('is closed once the consultation is signed or discarded, and to anyone but its doctor', async () => {
    const { e, doctor, nurse } = await open(withSpeech)
    const other = await login(withSpeech.app, 't.doctor2')
    expect((await capture(withSpeech, e.id, other)).blockedReason).toMatch(/Only the doctor who started/)
    expect((await call(withSpeech.app, 'GET', `/api/encounters/${e.id}/capture`, { cookie: nurse })).statusCode).toBe(403)
    expect((await startLive(withSpeech, e.id, other)).statusCode).toBe(403)
    const saved = Encounter.parse((await call(withSpeech.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { version: e.version, note: { ...e.note, chiefComplaint: 'Fever' }, diagnoses: [{ description: 'Fever', kind: 'provisional' }], prescription: [] } })).json())
    expect((await call(withSpeech.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    expect((await capture(withSpeech, e.id, doctor)).blockedReason).toMatch(/signed/)
    expect((await startLive(withSpeech, e.id, doctor)).statusCode).toBe(409)
  })
})

describe('a live recording', () => {
  it('keeps each part’s transcript on one timeline, with language, scores and the model that heard it, in reading order whatever order the parts arrived', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.script = (n) => (n === 1 ? [seg('I have had a fever for three days.', 0, 3100), seg('And a dry cough.', 3100, 5200)] : [seg('I am allergic to penicillin.', 800, 3000, { confidence: 0.42 })])
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    await backdate(tid)
    // Part 1 (the second 20 seconds) arrives before part 0.
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '1', offsetMs: '20000' })).statusCode).toBe(201)
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })).statusCode).toBe(201)
    const ended = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/end`, { cookie: doctor })).json())
    const t = ended.transcripts[0]!
    expect(t).toMatchObject({ status: 'final', language: 'en', endReason: 'doctor_stopped' })
    // Part 0 was transcribed second, so its script is the second one; reading order is by part, then time.
    expect(t.segments.map((s) => [s.chunkIndex, s.startMs, s.endMs, s.text])).toEqual([
      [0, 800, 3000, 'I am allergic to penicillin.'],
      [1, 20_000 + 0, 20_000 + 3100, 'I have had a fever for three days.'],
      [1, 20_000 + 3100, 20_000 + 5200, 'And a dry cough.'],
    ])
    const times = t.segments.map((s) => s.startMs!)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(t.segments[0]).toMatchObject({ language: 'en', confidence: 0.42, speaker: null, speakerSource: 'none' })
    expect(t.chunks).toEqual([
      { index: 0, offsetMs: 0, durationMs: 20_000, language: 'en', status: 'transcribed' },
      { index: 1, offsetMs: 20_000, durationMs: 20_000, language: 'en', status: 'transcribed' },
    ])
    // The run says where it ran and with what: local, the runtime and the weights.
    expect(ended.runs.find((r) => r.kind === 'stt')).toMatchObject({ status: 'succeeded', provider: 'fake-speech', model: 'fake-speech-model', locality: 'local', runtime: 'fake-runtime 1', weightsSha256: 'a'.repeat(64) })
    expect((await adminQuery('SELECT count(*)::int AS n FROM transcript_segments WHERE run_id IS NOT NULL')).rows[0].n).toBe(3)
  })

  it('refuses a part that is malformed, claims to start later than the recording has existed, or has already arrived', async () => {
    const { e, doctor } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    expect((await chunk(withSpeech, tid, doctor, { offsetMs: '0' })).statusCode).toBe(400)
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0' })).statusCode).toBe(400)
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '-1', offsetMs: '0' })).statusCode).toBe(400)
    // A recording that is a second old cannot have a part that starts after twenty seconds of recorded audio.
    const late = await chunk(withSpeech, tid, doctor, { chunkIndex: '1', offsetMs: '20000' })
    expect(late.statusCode).toBe(400)
    expect(late.json().issues[0].path).toBe('offsetMs')
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })).statusCode).toBe(201)
    const again = await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('chunk_already_received')
    // Nothing was stored for the refused ones: one audio file, one part, one transcription.
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE original_name LIKE 'live-chunk-%'")).rows[0].n).toBe(1)
    expect((await adminQuery('SELECT count(*)::int AS n FROM transcript_chunks')).rows[0].n).toBe(1)
    expect(speech.calls).toHaveLength(1)
    // Not audio at all.
    const m = multipartAudio({ chunkIndex: '5', offsetMs: '0' }, { name: 'x.txt', type: 'text/plain', data: Buffer.from('hi') })
    expect((await withSpeech.app.inject({ method: 'POST', url: `/api/transcripts/${tid}/chunks`, headers: { ...m.headers, cookie: doctor, 'x-adaxai-csrf': '1' }, payload: m.payload })).statusCode).toBe(400)
  })

  it('allows one recording at a time per consultation, and replaces one whose page is gone', async () => {
    const { e, doctor } = await open(withSpeech)
    const first = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    const second = await startLive(withSpeech, e.id, doctor)
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('recording_in_progress')
    expect((await capture(withSpeech, e.id, doctor)).live.transcriptId).toBe(first)
    // Nothing has been heard from the first for longer than any page that is still there would stay silent.
    await adminQuery("UPDATE transcripts SET created_at = created_at - interval '30 minutes' WHERE id = $1", [first])
    const third = await startLive(withSpeech, e.id, doctor)
    expect(third.statusCode).toBe(201)
    const all = EncounterAi.parse(third.json()).transcripts
    expect(all.find((t) => t.id === first)).toMatchObject({ status: 'final', endReason: 'stale_replaced' })
    expect(all.find((t) => t.id === third.json().transcriptId)).toMatchObject({ status: 'live' })
    // The database says the same, whoever asks.
    await expect(adminQuery(`INSERT INTO transcripts (encounter_id, source, status) VALUES ('${e.id}', 'browser_recording', 'live')`)).rejects.toMatchObject({ code: '23505' })
  })

  it('stops for good when consent is withdrawn: the next part is refused, the recording ends with that reason, and nothing more is stored', async () => {
    const { p, e, doctor, nurse } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })).statusCode).toBe(201)
    const detail = PatientDetail.parse((await call(withSpeech.app, 'GET', `/api/patients/${p.id}`, { cookie: nurse })).json())
    const granted = detail.consents.find((c) => c.type === 'ai_recording' && c.status === 'granted')!
    expect((await call(withSpeech.app, 'POST', `/api/patients/${p.id}/consents/${granted.id}/withdraw`, { cookie: nurse, body: { reason: 'Changed their mind' } })).statusCode).toBe(200)
    const s = await capture(withSpeech, e.id, doctor)
    expect(s).toMatchObject({ canRecord: false, consent: { granted: false } })
    const refused = await chunk(withSpeech, tid, doctor, { chunkIndex: '1', offsetMs: '0' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toBe('consent_withdrawn')
    const t = (await ai(withSpeech, e.id, doctor)).transcripts[0]!
    expect(t).toMatchObject({ status: 'final', endReason: 'consent_withdrawn' })
    expect(t.chunks).toHaveLength(1)
    // A later attempt is "not live", and a new recording cannot be started either.
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '2', offsetMs: '0' })).statusCode).toBe(409)
    expect((await startLive(withSpeech, e.id, doctor)).statusCode).toBe(409)
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE original_name LIKE 'live-chunk-%'")).rows[0].n).toBe(1)
    expect(speech.calls).toHaveLength(1)
    expect((await adminQuery("SELECT details->>'reason' AS reason FROM audit_events WHERE action = 'ai.live_end'")).rows).toEqual([{ reason: 'consent_withdrawn' }])
  })

  it('keeps the audio of a part the speech service could not transcribe, marks it failed, and finishes it on retry', async () => {
    const { e, doctor } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    speech.failNext = true
    const failed = await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })
    expect(failed.statusCode).toBe(201)
    expect(failed.json().notice).toMatch(/Part 1: The local speech service could not be reached/)
    const after = EncounterAi.parse(failed.json())
    expect(after.transcripts[0]!.chunks).toEqual([{ index: 0, offsetMs: 0, durationMs: null, language: null, status: 'failed' }])
    expect(after.transcripts[0]!.segments).toEqual([])
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE original_name LIKE 'live-chunk-%'")).rows[0].n).toBe(1)
    const job = after.jobs.find((j) => j.status === 'failed')!
    expect(job.retryable).toBe(true)
    expect((await call(withSpeech.app, 'POST', `/api/ai-jobs/${job.id}/retry`, { cookie: doctor })).statusCode).toBe(200)
    const done = (await ai(withSpeech, e.id, doctor)).transcripts[0]!
    expect(done.chunks[0]).toMatchObject({ status: 'transcribed', durationMs: 20_000 })
    expect(done.segments.map((s) => s.text)).toEqual(['part 1 words'])
  })

  it('does not keep as speech what the model itself says is very probably not speech and scores low', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.script = () => [seg('Thank you.', 0, 800, { noSpeechProb: 0.96, confidence: 0.2 }), seg('I have a cough.', 900, 2500), seg('Hmm.', 2500, 2800, { noSpeechProb: 0.95, confidence: 0.9 })]
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })
    const t = (await ai(withSpeech, e.id, doctor)).transcripts[0]!
    // Only the line that is both "no speech" and low-scoring is dropped; a confident one is kept and left for the doctor to judge.
    expect(t.segments.map((s) => s.text)).toEqual(['I have a cough.', 'Hmm.'])
    expect((await adminQuery("SELECT summary->>'droppedLikelyNonSpeech' AS n FROM ai_jobs WHERE kind = 'transcription'")).rows[0].n).toBe('1')
  })

  it('stores an uploaded recording as one transcript from time zero, and tells a recording from a typed transcript', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.script = () => [seg('Doctor, I have had a headache.', 0, 2600)]
    const m = multipartAudio({ source: 'audio_upload' }, { name: 'visit.wav', type: 'audio/wav', data: Buffer.from('RIFFxxxxWAVE') })
    const res = await withSpeech.app.inject({ method: 'POST', url: `/api/encounters/${e.id}/audio`, headers: { ...m.headers, cookie: doctor, 'x-adaxai-csrf': '1' }, payload: m.payload })
    const t = EncounterAi.parse(res.json()).transcripts[0]!
    expect(t).toMatchObject({ source: 'audio_upload', language: 'en', status: 'final' })
    expect(t.segments[0]).toMatchObject({ startMs: 0, endMs: 2600, speaker: null })
    const typed = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/encounters/${e.id}/transcripts`, { cookie: doctor, body: { text: 'Doctor: Hello.\nPatient: I have a fever.' } })).json())
    expect(typed.transcripts[1]).toMatchObject({ source: 'pasted', language: null, segments: [{ speaker: 'Doctor', speakerSource: 'typed_label', startMs: null, language: null, confidence: null }, { speaker: 'Patient' }] })
  })
})

describe('who spoke, as the doctor says', () => {
  async function recorded(ctx = withSpeech) {
    const o = await open(ctx)
    speech.script = () => [seg('I have had a fever for three days.', 0, 2400), seg('Take paracetamol five hundred milligrams twice a day.', 2400, 5600)]
    const tid = (await startLive(ctx, o.e.id, o.doctor)).json().transcriptId as string
    await chunk(ctx, tid, o.doctor, { chunkIndex: '0', offsetMs: '0' })
    await call(ctx.app, 'POST', `/api/transcripts/${tid}/end`, { cookie: o.doctor })
    return { ...o, tid }
  }
  const assign = (ctx: TestContext, tid: string, cookie: string, assignments: { segmentId: string; speaker: string }[]) => call(ctx.app, 'POST', `/api/transcripts/${tid}/speakers`, { cookie, body: { assignments } })

  it('persists the assignment as reviewed metadata, never touching the words, and the latest one stands', async () => {
    const { e, doctor, tid } = await recorded()
    const before = await segmentsDigest(tid)
    expect((await ai(withSpeech, e.id, doctor)).transcripts[0]!.segments.map((s) => [s.speaker, s.speakerSource])).toEqual([[null, 'none'], [null, 'none']])
    const res = await assign(withSpeech, tid, doctor, [
      { segmentId: 'S1', speaker: 'Patient' },
      { segmentId: 'S2', speaker: 'Doctor' },
    ])
    expect(res.statusCode).toBe(200)
    const t = EncounterAi.parse(res.json()).transcripts[0]!
    expect(t.segments.map((s) => [s.speaker, s.speakerSource])).toEqual([['Patient', 'doctor_assigned'], ['Doctor', 'doctor_assigned']])
    expect(t.segments[0]!.speakerAssignedAt).toMatch(/^\d{4}-/)
    // The segment rows themselves are exactly as they were heard.
    expect(await segmentsDigest(tid)).toBe(before)
    // A correction: the line is somebody else's. "Unknown" clears it. The earlier assignments are still on record.
    await assign(withSpeech, tid, doctor, [{ segmentId: 'S1', speaker: 'Relative' }])
    expect((await ai(withSpeech, e.id, doctor)).transcripts[0]!.segments[0]).toMatchObject({ speaker: 'Relative', speakerSource: 'doctor_assigned' })
    await assign(withSpeech, tid, doctor, [{ segmentId: 'S1', speaker: 'Unknown' }])
    expect((await ai(withSpeech, e.id, doctor)).transcripts[0]!.segments[0]).toMatchObject({ speaker: null, speakerSource: 'none' })
    const history = (await adminQuery('SELECT speaker FROM transcript_segment_speakers ORDER BY assigned_at, id')).rows.map((r) => r.speaker as string)
    // The first two were made in one request (same instant): both are there; the later two follow in order.
    expect([history.slice(0, 2).sort(), history.slice(2)]).toEqual([['Doctor', 'Patient'], ['Relative', 'Unknown']])
    expect((await adminQuery("SELECT details FROM audit_events WHERE action = 'ai.speaker_assign' ORDER BY id")).rows.map((r) => r.details)).toEqual([
      { encounterId: e.id, lines: 2 },
      { encounterId: e.id, lines: 1 },
      { encounterId: e.id, lines: 1 },
    ])
  })

  it('is append-only in the database for everyone, and the words cannot be edited either', async () => {
    const { doctor, tid } = await recorded()
    await assign(withSpeech, tid, doctor, [{ segmentId: 'S1', speaker: 'Patient' }])
    await expect(adminQuery("UPDATE transcript_segment_speakers SET speaker = 'Doctor'")).rejects.toThrow()
    await expect(adminQuery('DELETE FROM transcript_segment_speakers')).rejects.toThrow()
    await expect(adminQuery('TRUNCATE transcript_segment_speakers')).rejects.toThrow()
    await expect(withSpeech.pool.query("UPDATE transcript_segments SET text = 'changed'")).rejects.toThrow()
    await expect(withSpeech.pool.query('DELETE FROM transcript_segment_speakers')).rejects.toThrow()
  })

  it('is refused for anyone but the consultation’s doctor, for another facility, for an unknown line, and once signed', async () => {
    const { e, doctor, nurse, tid } = await recorded()
    const other = await login(withSpeech.app, 't.doctor2')
    const admin = await login(withSpeech.app, 't.admin')
    for (const cookie of [other, nurse, admin]) expect([(await assign(withSpeech, tid, cookie, [{ segmentId: 'S1', speaker: 'Patient' }])).statusCode]).toEqual([403])
    expect((await assign(withSpeech, tid, doctor, [{ segmentId: 'S9', speaker: 'Patient' }])).statusCode).toBe(400)
    expect((await assign(withSpeech, tid, doctor, [{ segmentId: 'S1', speaker: 'Hamster' }])).statusCode).toBe(400)
    expect((await assign(withSpeech, tid, doctor, [])).statusCode).toBe(400)
    expect((await adminQuery('SELECT count(*)::int AS n FROM transcript_segment_speakers')).rows[0].n).toBe(0)
    // Another facility's doctor does not even find it.
    const [f2] = await withSpeech.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
    const [d2] = await withSpeech.db.insert(departments).values({ facilityId: f2!.id, code: 'GEN', name: 'General Medicine' }).returning()
    await withSpeech.db.insert(users).values({ facilityId: f2!.id, username: 'b.doctor', fullName: 'B doctor', role: 'doctor', passwordHash: await hashPassword(TEST_PASSWORD), departmentId: d2!.id })
    const doctorB = await login(withSpeech.app, 'b.doctor')
    expect((await assign(withSpeech, tid, doctorB, [{ segmentId: 'S1', speaker: 'Patient' }])).statusCode).toBe(404)
    expect((await call(withSpeech.app, 'GET', `/api/encounters/${e.id}/capture`, { cookie: doctorB })).statusCode).toBe(404)
    expect((await chunk(withSpeech, tid, doctorB, { chunkIndex: '7', offsetMs: '0' })).statusCode).toBe(404)
    // Signed: nothing more can be said about who spoke.
    const saved = Encounter.parse((await call(withSpeech.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { version: e.version, note: { ...e.note, chiefComplaint: 'Fever' }, diagnoses: [{ description: 'Fever', kind: 'provisional' }], prescription: [] } })).json())
    await call(withSpeech.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })
    expect((await assign(withSpeech, tid, doctor, [{ segmentId: 'S1', speaker: 'Patient' }])).statusCode).toBe(409)
  })

  it('changes who the important points are attributed to, and says when a point was extracted before the change', async () => {
    const { e, doctor, tid } = await recorded()
    const guessed = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: doctor })).json())
    const fever = guessed.facts.find((f) => f.category === 'chief_complaint')!
    // Nobody was labelled, so who said it was guessed from the wording, and the point says so.
    expect(fever).toMatchObject({ certainty: 'uncertain', speakerChanged: false, producedBy: { provider: 'adaxai-rules', version: 'extract-rules-v1', local: true } })
    expect(fever.uncertaintyReason).toMatch(/guessed from the wording/)
    await assign(withSpeech, tid, doctor, [{ segmentId: 'S1', speaker: 'Doctor' }])
    // Wrongly assigned on purpose: the screen must say the earlier attribution may be out of date.
    expect((await ai(withSpeech, e.id, doctor)).facts.find((f) => f.id === fever.id)!.speakerChanged).toBe(true)
    await assign(withSpeech, tid, doctor, [
      { segmentId: 'S1', speaker: 'Patient' },
      { segmentId: 'S2', speaker: 'Doctor' },
    ])
    const again = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: doctor })).json())
    const now = again.facts.filter((f) => f.status === 'pending')
    expect(now.find((f) => f.category === 'chief_complaint')).toMatchObject({ attribution: 'patient_reported', certainty: 'stated', uncertaintyReason: null, speakerChanged: false })
    expect(now.find((f) => f.category === 'medication_mention')).toMatchObject({ attribution: 'clinician_stated', attributes: { medication: 'paracetamol' } })
    // The first run's points are superseded, not deleted.
    expect((await adminQuery("SELECT count(*)::int AS n FROM clinical_facts WHERE status = 'superseded'")).rows[0].n).toBeGreaterThan(0)
  })
})

describe('what was heard, what was extracted, what the doctor confirmed', () => {
  async function extracted() {
    const o = await open(withSpeech)
    speech.script = () => [seg('I have had a fever for three days.', 0, 2400), seg('I am allergic to penicillin.', 2400, 4200), seg('Rest at home and drink plenty of fluids.', 4200, 7000)]
    const tid = (await startLive(withSpeech, o.e.id, o.doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, o.doctor, { chunkIndex: '0', offsetMs: '0' })
    await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/end`, { cookie: o.doctor })
    await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/speakers`, { cookie: o.doctor, body: { assignments: [{ segmentId: 'S1', speaker: 'Patient' }, { segmentId: 'S2', speaker: 'Patient' }, { segmentId: 'S3', speaker: 'Doctor' }] } })
    const out = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: o.doctor })).json())
    return { ...o, tid, out }
  }
  const review = (cookie: string, id: string, body: Record<string, unknown>) => call(withSpeech.app, 'POST', `/api/ai-review/fact/${id}`, { cookie, body })

  it('extraction proposes points with their sources, version and time, as drafts, and changes nothing that was heard', async () => {
    const o = await open(withSpeech)
    speech.script = () => [seg('I have had a fever for three days.', 0, 2400), seg('Rest at home and drink plenty of fluids.', 2400, 5000)]
    const tid = (await startLive(withSpeech, o.e.id, o.doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, o.doctor, { chunkIndex: '0', offsetMs: '0' })
    await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/end`, { cookie: o.doctor })
    const heard = await segmentsDigest(tid)
    const out = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: o.doctor })).json())
    expect(out.facts.length).toBeGreaterThan(2)
    for (const f of out.facts) {
      expect(f.status).toBe('pending')
      expect(factState(f.status)).toBe('extracted')
      expect(f.sourceSegmentIds.length).toBeGreaterThan(0)
      expect(f.evidence.some((x) => x.sourceType === 'transcript_segment')).toBe(true)
      expect(f.producedBy).toMatchObject({ provider: 'adaxai-rules', model: 'extract-rules-v1', local: true })
      expect(Date.parse(f.createdAt)).toBeGreaterThan(0)
    }
    expect(await segmentsDigest(tid)).toBe(heard)
    // The run is local, and it is the rule set that ran, not a model.
    expect(out.runs.find((r) => r.kind === 'extraction')).toMatchObject({ provider: 'adaxai-rules', model: 'extract-rules-v1', locality: 'local' })
  })

  it('confirming and rejecting are the doctor’s decisions; neither writes to the note or the record, and the points stay apart from the words', async () => {
    const { e, doctor, tid, out } = await extracted()
    const before = Encounter.parse((await call(withSpeech.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    const heard = await segmentsDigest(tid)
    const fever = out.facts.find((f) => f.category === 'chief_complaint')!
    const plan = out.facts.find((f) => f.category === 'plan')!
    const confirmed = EncounterAi.parse((await review(doctor, fever.id, { action: 'accepted' })).json())
    expect(confirmed.facts.find((f) => f.id === fever.id)).toMatchObject({ status: 'accepted' })
    expect(factState('accepted')).toBe('confirmed')
    const rejected = EncounterAi.parse((await review(doctor, plan.id, { action: 'rejected' })).json())
    expect(rejected.facts.find((f) => f.id === plan.id)).toMatchObject({ status: 'rejected' })
    expect(factState('rejected')).toBe('rejected')
    // The record is as it was: the note, the diagnoses and the prescription are untouched; the transcript is as heard.
    const after = Encounter.parse((await call(withSpeech.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    expect([after.note, after.diagnoses, after.prescription, after.version]).toEqual([before.note, before.diagnoses, before.prescription, before.version])
    expect(await segmentsDigest(tid)).toBe(heard)
    expect((await adminQuery('SELECT count(*)::int AS n FROM note_insertions')).rows[0].n).toBe(0)
    // Each decision is on record with who and when.
    expect((await adminQuery("SELECT action FROM ai_review_actions WHERE subject_type = 'fact' ORDER BY created_at")).rows.map((r) => r.action)).toEqual(['accepted', 'rejected'])
  })

  it('a point whose speaker was guessed cannot be confirmed without the doctor saying they checked it', async () => {
    const o = await open(withSpeech)
    speech.script = () => [seg('I have had a fever for three days.', 0, 2400)]
    const tid = (await startLive(withSpeech, o.e.id, o.doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, o.doctor, { chunkIndex: '0', offsetMs: '0' })
    const out = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: o.doctor })).json())
    const f = out.facts[0]!
    expect(f.certainty).toBe('uncertain')
    const refused = await review(o.doctor, f.id, { action: 'accepted' })
    expect(refused.statusCode).toBeGreaterThanOrEqual(400)
    expect((await ai(withSpeech, o.e.id, o.doctor)).facts.find((x) => x.id === f.id)!.status).toBe('pending')
    expect((await review(o.doctor, f.id, { action: 'accepted', confirmFlags: true })).statusCode).toBe(200)
  })

  it('only the doctor who has the consultation can confirm or reject; nurses, other doctors and other facilities cannot', async () => {
    const { nurse, out } = await extracted()
    const other = await login(withSpeech.app, 't.doctor2')
    for (const cookie of [nurse, other]) expect((await review(cookie, out.facts[0]!.id, { action: 'rejected' })).statusCode).toBe(403)
  })

  it('what the doctor confirmed is available, with its sources, as the input of a later summary', async () => {
    const { e, doctor, out } = await extracted()
    const { listConfirmedPoints } = await import('../src/ai/confirmed.ts')
    expect(await listConfirmedPoints(withSpeech.db, e.id)).toEqual([])
    const fever = out.facts.find((f) => f.category === 'chief_complaint')!
    await review(doctor, fever.id, { action: 'accepted' })
    const edited = out.facts.find((f) => f.category === 'allergy')!
    await review(doctor, edited.id, { action: 'edited', text: 'Penicillin allergy (rash), as the patient said.', confirmFlags: true })
    const rejected = out.facts.find((f) => f.category === 'plan')!
    await review(doctor, rejected.id, { action: 'rejected' })
    const points = await listConfirmedPoints(withSpeech.db, e.id)
    expect(points.map((p) => [p.category, p.text])).toEqual(
      expect.arrayContaining([
        ['chief_complaint', expect.stringMatching(/fever/i)],
        ['allergy', 'Penicillin allergy (rash), as the patient said.'],
      ]),
    )
    expect(points.every((p) => p.sourceSegmentIds.length > 0 && p.confirmedAt)).toBe(true)
    // Nothing rejected or still a draft is in it.
    expect(points.some((p) => p.category === 'plan')).toBe(false)
    expect(points).toHaveLength(2)
  })
})

describe('privacy, and no external calls', () => {
  let stub: SpeechStub
  const realFetch = globalThis.fetch
  const targets: string[] = []
  beforeAll(async () => {
    stub = await startSpeechStub()
  })
  afterAll(() => stub.close())
  beforeEach(() => {
    targets.length = 0
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      targets.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return realFetch(input, init)
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('a whole recording, review and extraction through the real adapter talks only to the local speech service, and logs and addresses carry no transcript', async () => {
    const lines: string[] = []
    const stream = { write: (s: string) => void lines.push(s) } as unknown as NodeJS.WritableStream
    const secret = 'Zephyrine'
    stub.reply.transcribe = {
      status: 200,
      body: {
        model: { id: 'stub-model', runtime: 'stub-runtime', computeType: 'int8', weightsSha256: 'b'.repeat(64), local: true },
        language: 'en',
        languageProbability: 0.97,
        languageSource: 'detected',
        durationMs: 6000,
        segments: [{ startMs: 0, endMs: 3000, text: `I take ${secret} lisinopril every morning for my pressure.`, avgLogprob: -0.1, noSpeechProb: 0.01, confidence: 0.9 }],
      },
    }
    const ctx = createTestApp({ ai: { drafter: null, transcriber: new LocalSpeechTranscriber({ url: stub.url }), extractor: new RuleFactExtractor(), reasons: { llm: null, stt: null } }, logger: { stream } })
    try {
      await resetDatabase()
      fx = await createFixture(ctx.db)
      const { e, doctor } = await open(ctx)
      expect((await capture(ctx, e.id, doctor)).speech).toMatchObject({ available: true, state: 'ready', model: 'stub-model' })
      const tid = (await startLive(ctx, e.id, doctor)).json().transcriptId as string
      expect((await chunk(ctx, tid, doctor, { chunkIndex: '0', offsetMs: '0' }, webm('RAW-AUDIO-BYTES-123'))).statusCode).toBe(201)
      await call(ctx.app, 'POST', `/api/transcripts/${tid}/speakers`, { cookie: doctor, body: { assignments: [{ segmentId: 'S1', speaker: 'Patient' }] } })
      const out = EncounterAi.parse((await call(ctx.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: doctor })).json())
      expect(out.facts.some((f) => f.attributes.medication === 'lisinopril')).toBe(false) // not in the word list: it is not invented, and not found either
      expect(out.transcripts[0]!.segments[0]!.text).toContain(secret)
      await call(ctx.app, 'POST', `/api/transcripts/${tid}/end`, { cookie: doctor })

      // What was sent went to the stub, and only to it: the audio and nothing else (no provider, no analytics, no model hub).
      const hosts = new Set(targets.map((t) => new URL(t).host))
      expect([...hosts]).toEqual([new URL(stub.url).host])
      expect(stub.requests.some((r) => r.url === '/v1/transcribe' && r.body.includes('RAW-AUDIO-BYTES-123'))).toBe(true)
      // The server's log has the requests (with identifiers) and nothing that was said or recorded.
      const log = lines.join('')
      expect(log.length).toBeGreaterThan(100)
      for (const needle of [secret, 'lisinopril', 'RAW-AUDIO-BYTES', 'fever', 'every morning']) expect(log, needle).not.toContain(needle)
      // Nor does any address carry it: every request path in the log is made of identifiers.
      for (const m of log.matchAll(/"url":"([^"]+)"/g)) expect(m[1]).not.toMatch(/[?&](?:q|text|search|transcript)=/)
    } finally {
      await ctx.close()
    }
  })

  it('the audit trail of a recording names the steps and counts, never the words', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.script = () => [seg('Unmistakable-sentinel-phrase about a headache.', 0, 2000)]
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })
    await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: doctor })
    const rows = (await adminQuery("SELECT action, details FROM audit_events WHERE action LIKE 'ai.%' OR action LIKE 'encounter_ai.%'")).rows
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['ai.live_start', 'ai.audio_chunk', 'ai.transcription', 'ai.extraction']))
    expect(JSON.stringify(rows)).not.toContain('Unmistakable')
    expect(JSON.stringify(rows)).not.toContain('headache')
  })
})

describe('after the security review: races, stale state and long input', () => {
  const withdraw = async (ctx: TestContext, p: { id: string }, nurse: string) => {
    const detail = PatientDetail.parse((await call(ctx.app, 'GET', `/api/patients/${p.id}`, { cookie: nurse })).json())
    const granted = detail.consents.find((c) => c.type === 'ai_recording' && c.status === 'granted')!
    expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/consents/${granted.id}/withdraw`, { cookie: nurse, body: { reason: 'Changed their mind' } })).statusCode).toBe(200)
  }

  it('consent withdrawn while a part is being transcribed: nothing of it is stored, the part is marked failed, and the job is not left running', async () => {
    const { p, e, doctor, nurse } = await open(withSpeech)
    speech.script = () => [seg('Words spoken before the patient changed their mind.', 0, 2000)]
    speech.hook = () => withdraw(withSpeech, p, nurse)
    try {
      const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
      expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })).statusCode).toBe(201)
      const t = (await ai(withSpeech, e.id, doctor)).transcripts[0]!
      expect(t.segments).toHaveLength(0)
      expect(t.chunks[0]).toMatchObject({ status: 'failed' })
      expect((await adminQuery('SELECT count(*)::int AS n FROM transcript_segments')).rows[0].n).toBe(0)
      const job = (await adminQuery("SELECT status, last_error_code FROM ai_jobs WHERE kind = 'transcription'")).rows[0]
      expect(job.status).toBe('failed')
      expect(job.last_error_code).toMatch(/consent/)
    } finally {
      speech.hook = null
    }
  })

  it('withdrawal ends a recording in progress in the same step, whether or not the browser notices, and deletes nothing that was already captured', async () => {
    const { p, e, doctor, nurse } = await open(withSpeech)
    speech.script = () => [seg('Words captured before the patient changed their mind.', 0, 2500)]
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })).statusCode).toBe(201)
    await withdraw(withSpeech, p, nurse)
    // No further request from the browser has happened: the record already says the recording ended because consent was withdrawn.
    const t = (await ai(withSpeech, e.id, doctor)).transcripts[0]!
    expect(t).toMatchObject({ status: 'final', endReason: 'consent_withdrawn' })
    expect((await adminQuery("SELECT details->'effects' AS effects FROM audit_events WHERE action = 'consent.withdraw'")).rows[0].effects).toContain('live_recordings_ended:1')
    // What was captured is still there: nothing is deleted or hidden by a withdrawal.
    expect(t.segments.map((x) => x.text)).toEqual(['Words captured before the patient changed their mind.'])
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE kind = 'consultation_audio' AND deleted_at IS NULL")).rows[0].n).toBe(1)
    expect((await adminQuery('SELECT count(*)::int AS n FROM transcript_chunks')).rows[0].n).toBe(1)
    // And nothing more can be added.
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '1', offsetMs: '0' })).statusCode).toBe(409)
  })

  it('consent withdrawn while an uploaded recording is still arriving: it is not stored, and the refusal is audited', async () => {
    // The upload is sent in two halves over a real connection; the withdrawal happens between them, so the first consent check (before the body is
    // read) passes and only the check after the body has arrived can stop it.
    const slow = createTestApp({ ai: providers(), settings: manyLogins() })
    try {
      const { p, e, doctor, nurse } = await open(slow)
      await slow.app.listen({ port: 0, host: '127.0.0.1' })
      const { port } = slow.app.server.address() as AddressInfo
      const m = multipartAudio({ source: 'audio_upload' }, { name: 'a.webm', type: 'audio/webm', data: webm() })
      const body = Buffer.from(m.payload)
      const half = Math.floor(body.length / 2)
      const reply = await new Promise<{ status: number; json: { error?: string } }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/encounters/${e.id}/audio`, headers: { ...m.headers, cookie: doctor, 'x-adaxai-csrf': '1', 'content-length': String(body.length) } }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { error?: string } }))
        })
        req.on('error', reject)
        req.write(body.subarray(0, half))
        setTimeout(() => {
          withdraw(slow, p, nurse).then(
            () => req.end(body.subarray(half)),
            (err: unknown) => reject(err),
          )
        }, 400)
      })
      expect(reply.status).toBe(409)
      expect(reply.json.error).toBe('consent_withdrawn')
      expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE kind = 'consultation_audio'")).rows[0].n).toBe(0)
      expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'consent.blocked' AND details->>'state' = 'withdrawn'")).rows[0].n).toBeGreaterThan(0)
    } finally {
      await slow.close()
    }
  })

  it('consent withdrawn while the speech service is being asked whether it is ready: no recording is created', async () => {
    const { p, e, doctor, nurse } = await open(withSpeech)
    speech.healthHook = () => withdraw(withSpeech, p, nurse)
    try {
      const res = await startLive(withSpeech, e.id, doctor)
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('consent_withdrawn')
    } finally {
      speech.healthHook = null
    }
    expect((await adminQuery('SELECT count(*)::int AS n FROM transcripts')).rows[0].n).toBe(0)
  })

  it('the steps that store audio read the consent under a lock: a withdrawal waits for them, then ends the recording they created', async () => {
    const { p, e, doctor, nurse } = await open(withSpeech)
    let withdrew = false
    let withdrawal: Promise<void> = Promise.resolve()
    await withSpeech.db.transaction(async (tx) => {
      expect(await currentConsent(tx, p.id, 'ai_recording', e.id, true)).not.toBeNull()
      withdrawal = withdraw(withSpeech, p, nurse).then(() => {
        withdrew = true
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
      // The withdrawal cannot pass the step that has read the consent: it is waiting.
      expect(withdrew).toBe(false)
      await tx.insert(transcripts).values({ encounterId: e.id, source: 'browser_recording', status: 'live', createdBy: e.doctor.id })
    })
    await withdrawal
    expect(withdrew).toBe(true)
    // It then saw the recording the step made, and ended it.
    expect((await adminQuery('SELECT status, end_reason FROM transcripts')).rows).toEqual([{ status: 'final', end_reason: 'consent_withdrawn' }])
    void doctor
  })

  it('a job that was running when the system stopped is failed and retryable at the next start', async () => {
    const { e, doctor } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })
    const job = (await adminQuery("SELECT id FROM ai_jobs WHERE kind = 'transcription' LIMIT 1")).rows[0]
    await adminQuery("UPDATE ai_jobs SET status = 'running', updated_at = now() - interval '30 minutes' WHERE id = $1", [job.id])
    const again = createTestApp({ ai: providers() })
    try {
      await again.app.ready()
      expect((await adminQuery('SELECT status, retryable, last_error_code FROM ai_jobs WHERE id = $1', [job.id])).rows[0]).toEqual({ status: 'failed', retryable: true, last_error_code: 'interrupted' })
    } finally {
      await again.close()
    }
  })

  it('the consultation must still be with the doctor: a paused visit refuses new recordings and parts, and the capture status says it is closed', async () => {
    const { v, e, doctor } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })).statusCode).toBe(201)
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET status = 'ready' WHERE id = '${v.id}'`)
    const s = await capture(withSpeech, e.id, doctor)
    expect(s.canRecord).toBe(false)
    expect(s.closedReason).toMatch(/no longer with the doctor/)
    const late = await chunk(withSpeech, tid, doctor, { chunkIndex: '1', offsetMs: '0' })
    expect(late.statusCode).toBe(409)
    expect(late.json().error).toBe('visit_not_in_consultation')
    expect((await startLive(withSpeech, e.id, doctor)).statusCode).toBe(409)
    expect(speech.calls).toHaveLength(1)
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET status = 'in_consultation' WHERE id = '${v.id}'`)
    expect((await capture(withSpeech, e.id, doctor)).closedReason).toBeNull()
  })

  it('who ended a recording is a fact about consent, not something the browser can claim', async () => {
    const { e, doctor } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    expect((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/end`, { cookie: doctor, body: { reason: 'consent_withdrawn' } })).statusCode).toBe(200)
    expect((await ai(withSpeech, e.id, doctor)).transcripts[0]).toMatchObject({ status: 'final', endReason: 'doctor_stopped' })
  })

  it('a part cannot start before the part that precedes it, and a part number is bounded', async () => {
    const { e, doctor } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    await backdate(tid)
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '5000' })).statusCode).toBe(201)
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '1', offsetMs: '1000' })).statusCode).toBe(400)
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '1', offsetMs: '25000' })).statusCode).toBe(201)
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '5000', offsetMs: '25000' })).statusCode).toBe(400)
  })

  it('a point is stale once the speaker of its source line is changed to the other side: confirming it needs the explicit tick', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.script = () => [seg('I have had a fever for three days.', 0, 3000)]
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })
    const assign = (speaker: string) => call(withSpeech.app, 'POST', `/api/transcripts/${tid}/speakers`, { cookie: doctor, body: { assignments: [{ segmentId: 'S1', speaker }] } })
    expect((await assign('Patient')).statusCode).toBe(200)
    expect((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: doctor })).statusCode).toBe(201)
    const fact = (await ai(withSpeech, e.id, doctor)).facts.find((f) => f.category === 'chief_complaint')!
    expect(fact).toMatchObject({ attribution: 'patient_reported', certainty: 'stated' })
    // The doctor then decides the line was theirs.
    expect((await assign('Doctor')).statusCode).toBe(200)
    const refused = await call(withSpeech.app, 'POST', `/api/ai-review/fact/${fact.id}`, { cookie: doctor, body: { action: 'accepted' } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().message).toMatch(/now marked as Doctor/)
    expect((await call(withSpeech.app, 'POST', `/api/ai-review/fact/${fact.id}`, { cookie: doctor, body: { action: 'accepted', confirmFlags: true } })).statusCode).toBe(200)
  })

  it('finding the points again does not bring back a rejected point, nor duplicate a confirmed one', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.script = () => [seg('I have a fever for three days.', 0, 3000), seg('I am allergic to penicillin.', 3000, 5000)]
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })
    await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/speakers`, { cookie: doctor, body: { assignments: [{ segmentId: 'S1', speaker: 'Patient' }, { segmentId: 'S2', speaker: 'Patient' }] } })
    const extract = () => call(withSpeech.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: doctor })
    expect((await extract()).statusCode).toBe(201)
    const first = (await ai(withSpeech, e.id, doctor)).facts.filter((f) => factState(f.status) === 'extracted')
    const allergy = first.find((f) => f.category === 'allergy')!
    const complaint = first.find((f) => f.category === 'chief_complaint')!
    expect((await call(withSpeech.app, 'POST', `/api/ai-review/fact/${allergy.id}`, { cookie: doctor, body: { action: 'rejected' } })).statusCode).toBe(200)
    expect((await call(withSpeech.app, 'POST', `/api/ai-review/fact/${complaint.id}`, { cookie: doctor, body: { action: 'accepted' } })).statusCode).toBe(200)
    expect((await extract()).statusCode).toBe(201)
    const after = (await ai(withSpeech, e.id, doctor)).facts
    expect(after.filter((f) => f.category === 'allergy' && factState(f.status) === 'extracted')).toHaveLength(0)
    expect(after.filter((f) => f.category === 'allergy' && factState(f.status) === 'rejected')).toHaveLength(1)
    expect(after.filter((f) => f.category === 'chief_complaint' && f.text === complaint.text)).toHaveLength(1)
    expect(after.filter((f) => f.category === 'chief_complaint' && factState(f.status) === 'confirmed')).toHaveLength(1)
  })

  it('consultation audio is for doctors: a nurse is told it is not found (and it is audited), the doctor can play it', async () => {
    const { e, doctor, nurse } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })
    const fileId = (await adminQuery("SELECT id FROM files WHERE original_name LIKE 'live-chunk-%'")).rows[0].id as string
    expect((await call(withSpeech.app, 'GET', `/api/files/${fileId}`, { cookie: doctor })).statusCode).toBe(200)
    expect((await call(withSpeech.app, 'GET', `/api/files/${fileId}`, { cookie: nurse })).statusCode).toBe(404)
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.not_found' AND entity_id = $1", [fileId])).rows[0].n).toBe(1)
  })

  it('typed text with characters that cannot be stored is refused, and an unbroken block is cut into lines of a sensible length that keep their speaker', async () => {
    const { e, doctor } = await open(withSpeech)
    expect((await call(withSpeech.app, 'POST', `/api/encounters/${e.id}/transcripts`, { cookie: doctor, body: { text: 'Patient: fever\u0000 for two days', source: 'typed' } })).statusCode).toBe(400)
    const block = `Patient: ${'I have had a cough '.repeat(500)}`
    expect((await call(withSpeech.app, 'POST', `/api/encounters/${e.id}/transcripts`, { cookie: doctor, body: { text: block, source: 'typed' } })).statusCode).toBe(201)
    const segments = (await ai(withSpeech, e.id, doctor)).transcripts[0]!.segments
    expect(segments.length).toBeGreaterThan(5)
    expect(segments.every((s) => s.text.length <= 1000 && s.speaker === 'Patient')).toBe(true)
  })
})

describe('uploads are judged by their content, and the costly steps are rate-limited (V2.1)', () => {
  const upload = (ctx: TestContext, tid: string, cookie: string, data: Buffer, mime: string, name: string, i = 0) => {
    const m = multipartAudio({ chunkIndex: String(i), offsetMs: '0' }, { name, type: mime, data })
    return ctx.app.inject({ method: 'POST', url: `/api/transcripts/${tid}/chunks`, headers: { ...m.headers, cookie, 'x-adaxai-csrf': '1' }, payload: m.payload })
  }

  it('refuses a file that is not audio of the kind it claims, whatever its name or declared type, and stores nothing', async () => {
    const { e, doctor } = await open(withSpeech)
    const tid = (await startLive(withSpeech, e.id, doctor)).json().transcriptId as string
    const playlist = Buffer.from('#EXTM3U\n#EXTINF:10,\nhttp://169.254.169.254/latest/meta-data/\n')
    const concat = Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n")
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
    const wavDeclaredAsWebm = Buffer.from('RIFF$\0\0\0WAVEfmt \x10\0\0\0', 'binary')
    for (const [data, mime, name] of [
      [playlist, 'audio/webm', 'part.webm'],
      [concat, 'audio/mpeg', 'part.mp3'],
      [png, 'audio/webm', 'photo.webm'],
      [Buffer.from('plain text'), 'audio/wav', 'a.wav'],
      [wavDeclaredAsWebm, 'audio/webm', 'wrong-kind.webm'],
    ] as const) {
      const res = await upload(withSpeech, tid, doctor, data, mime, name)
      expect(res.statusCode, name).toBe(415)
      expect(res.json().error).toBe('unsupported_media')
    }
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE kind = 'consultation_audio'")).rows[0].n).toBe(0)
    expect(speech.calls).toHaveLength(0)
    // A recording of the right kind is accepted.
    expect((await upload(withSpeech, tid, doctor, webm(), 'audio/webm', 'ok.webm')).statusCode).toBe(201)
  })

  it('rate-limits audio and the costly steps per user, with the time to wait, and audits the first refusal', async () => {
    const file = loadAppSettings()
    const tight: AppSettings = { ...file, security: { ...file.security, rateLimits: { ...file.security.rateLimits, loginPerAccount: { max: 10_000, windowSeconds: 60 }, loginPerIp: { max: 10_000, windowSeconds: 60 }, aiAudioPerUser: { max: 3, windowSeconds: 60 }, aiStepPerUser: { max: 2, windowSeconds: 60 } } } }
    const limited = createTestApp({ ai: providers(), settings: tight })
    try {
      const { e, doctor } = await open(limited)
      const tid = (await startLive(limited, e.id, doctor)).json().transcriptId as string
      const codes: number[] = []
      for (let i = 0; i < 5; i++) codes.push((await chunk(limited, tid, doctor, { chunkIndex: String(i), offsetMs: '0' })).statusCode)
      expect(codes).toEqual([201, 201, 201, 429, 429])
      const refused = await chunk(limited, tid, doctor, { chunkIndex: '9', offsetMs: '0' })
      expect(refused.json().error).toBe('rate_limited')
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
      const steps: number[] = []
      for (let i = 0; i < 3; i++) steps.push((await call(limited.app, 'POST', `/api/transcripts/${tid}/extract`, { cookie: doctor })).statusCode)
      expect(steps).toEqual([201, 201, 429])
      expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.rate_limited'")).rows[0].n).toBe(2)
      // Another user is not held up by this one's limit: the same limited route answers them from their own count (here, "not your consultation"),
      // while the first user is still refused for the time left.
      const other = await login(limited.app, 't.doctor2')
      const theirs = await chunk(limited, tid, other, { chunkIndex: '0', offsetMs: '0' })
      expect(theirs.statusCode).toBe(403)
      expect((await chunk(limited, tid, doctor, { chunkIndex: '9', offsetMs: '0' })).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })
})

// HERO §3: a recording of synthetic demo audio (computer voices playing a script, sent as a live recording's parts) says so for good: on the transcript,
// while it runs, and in the audit. It is accepted only where simulators are allowed. What hears it is the speech model (here the test's stand-in).
describe('where the audio came from', () => {
  const startWith = (ctx: TestContext, eid: string, cookie: string, body: unknown) => call(ctx.app, 'POST', `/api/encounters/${eid}/live-transcripts`, { cookie, body })

  it('a demo recording records its origin, and every place that gives the transcript carries it; the microphone is the default', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.script = () => [seg('My daughter has had a fever for three days and a mild cough.', 0, 4000)]
    const res = await startWith(withSpeech, e.id, doctor, { audioOrigin: 'demo_synthetic' })
    expect(res.statusCode).toBe(201)
    const tid = res.json().transcriptId as string
    expect(EncounterAi.parse(res.json()).transcripts.find((t) => t.id === tid)).toMatchObject({ source: 'browser_recording', audioOrigin: 'demo_synthetic', status: 'live' })
    expect((await capture(withSpeech, e.id, doctor)).live).toMatchObject({ transcriptId: tid, audioOrigin: 'demo_synthetic' })
    expect((await chunk(withSpeech, tid, doctor, { chunkIndex: '0', offsetMs: '0' })).statusCode).toBe(201)
    const ended = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/transcripts/${tid}/end`, { cookie: doctor })).json())
    expect(ended.transcripts[0]).toMatchObject({ id: tid, audioOrigin: 'demo_synthetic', status: 'final', segments: [{ text: 'My daughter has had a fever for three days and a mild cough.' }] })
    expect((await capture(withSpeech, e.id, doctor)).live).toMatchObject({ transcriptId: null, audioOrigin: null })
    const audit = (await adminQuery("SELECT action, details FROM audit_events WHERE action IN ('ai.live_start', 'ai.audio_chunk') ORDER BY occurred_at")).rows
    expect(audit).toEqual([
      { action: 'ai.live_start', details: expect.objectContaining({ encounterId: e.id, audioOrigin: 'demo_synthetic' }) },
      { action: 'ai.audio_chunk', details: expect.objectContaining({ transcriptId: tid, audioOrigin: 'demo_synthetic' }) },
    ])
    // Started without saying: the microphone. A typed transcript has no audio, so no origin.
    const other = await open(withSpeech)
    const mic = (await startLive(withSpeech, other.e.id, other.doctor)).json().transcriptId as string
    const typed = EncounterAi.parse((await call(withSpeech.app, 'POST', `/api/encounters/${other.e.id}/transcripts`, { cookie: other.doctor, body: { text: 'Patient: I have a cough.', source: 'typed' } })).json())
    expect(typed.transcripts.map((t) => [t.id === mic ? 'live' : t.source, t.audioOrigin])).toEqual([
      ['live', 'microphone'],
      ['typed', null],
    ])
    // An origin a recording cannot have is refused.
    expect((await startWith(withSpeech, other.e.id, other.doctor, { audioOrigin: 'upload' })).statusCode).toBe(400)
  })

  it('an uploaded file is an upload, and one recorded in the browser and sent whole is the microphone', async () => {
    const { e, doctor } = await open(withSpeech)
    speech.script = () => [seg('Doctor, I have had a headache.', 0, 2600)]
    for (const source of ['audio_upload', 'browser_recording']) {
      const m = multipartAudio({ source }, { name: 'visit.wav', type: 'audio/wav', data: Buffer.from('RIFFxxxxWAVE') })
      expect((await withSpeech.app.inject({ method: 'POST', url: `/api/encounters/${e.id}/audio`, headers: { ...m.headers, cookie: doctor, 'x-adaxai-csrf': '1' }, payload: m.payload })).statusCode).toBe(201)
    }
    expect((await ai(withSpeech, e.id, doctor)).transcripts.map((t) => [t.source, t.audioOrigin])).toEqual([
      ['audio_upload', 'upload'],
      ['browser_recording', 'microphone'],
    ])
  })

  it('is refused where simulators are not allowed (a clinical deployment) before anything is made, and the database refuses an origin that does not fit', async () => {
    const clinical = createTestApp({ config: { ...testConfig, dataOrigin: 'clinical' }, ai: providers(), settings: manyLogins() })
    try {
      const { e, doctor } = await open(clinical)
      const res = await startWith(clinical, e.id, doctor, { audioOrigin: 'demo_synthetic' })
      expect([res.statusCode, res.json().error]).toEqual([409, 'demo_audio_not_allowed'])
      expect((await adminQuery('SELECT count(*)::int AS n FROM transcripts')).rows[0].n).toBe(0)
      // The microphone is recorded there as anywhere.
      expect((await startLive(clinical, e.id, doctor)).statusCode).toBe(201)
      for (const [source, origin] of [['typed', 'demo_synthetic'], ['typed', 'microphone'], ['audio_upload', 'demo_synthetic'], ['browser_recording', 'upload'], ['browser_recording', 'speakers']]) {
        await expect(adminQuery('INSERT INTO transcripts (encounter_id, source, status, audio_origin) VALUES ($1, $2, $3, $4)', [e.id, source, 'final', origin]), `${source}/${origin}`).rejects.toMatchObject({ code: '23514' })
      }
    } finally {
      await clinical.close()
    }
  })
})
