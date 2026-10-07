// Unit test (node --test) of the demo consultation's pure helpers (lib/demoConsultation.ts): the manifest it plays and sends (and the committed
// files it names), where each part starts on the recording, the word-by-word showing of a new line (only words that arrived), when the demo is
// offered and can start, and what it says while it runs. No browser, no API.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  DEMO_AUDIO_LABEL,
  DEMO_PLAYING_LINE,
  demoActive,
  demoConversationState,
  demoGate,
  DemoManifestError,
  demoProgressLine,
  demoRefusal,
  demoStatusLine,
  demoSummaryLines,
  isDemoTranscript,
  newLineIds,
  parseDemoManifest,
  partMismatch,
  pointProvenance,
  REVEAL_MAX_MS,
  revealMs,
  revealText,
  toHex,
  transcriptSourceLabel,
} from '../src/lib/demoConsultation.ts'

const DIR = path.resolve(import.meta.dirname, '..', 'public', 'demo', 'consultation')
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'))

test('the committed manifest is read as 8 parts in order, each starting where the earlier ones end, and nothing of the script is kept', () => {
  const plan = parseDemoManifest(manifest)
  assert.equal(plan.parts.length, 8)
  assert.deepEqual(
    plan.parts.map((p) => p.chunkIndex),
    [0, 1, 2, 3, 4, 5, 6, 7],
  )
  assert.deepEqual(
    plan.parts.map((p) => p.offsetMs),
    [0, 4885, 9435, 12115, 17130, 19975, 24960, 27919],
  )
  assert.equal(plan.totalMs, 33044)
  assert.equal(plan.totalMs, manifest.totalDurationMs)
  assert.equal(plan.parts[0]!.url, '/demo/consultation/01-doctor.wav')
  // The script's words and speakers are documentation: the player never has them, so it can never show or send them.
  for (const p of plan.parts) {
    assert.equal('text' in p, false)
    assert.equal('speaker' in p, false)
  }
  // The mark the page shows is the manifest's own words.
  assert.equal(manifest.label, DEMO_AUDIO_LABEL)
})

test('the committed demo files are exactly what the manifest names (size and SHA-256), so the player’s own check passes', () => {
  for (const p of parseDemoManifest(manifest).parts) {
    const bytes = fs.readFileSync(path.join(DIR, p.file))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    assert.equal(partMismatch(p, { bytes: bytes.length, sha256 }), null, p.file)
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF')
    assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WAVE')
  }
})

test('a file that is not the one named is refused, by its size or its SHA-256; without a digest the size is still checked', () => {
  const p = { file: '01-doctor.wav', bytes: 100, sha256: 'a'.repeat(64) }
  assert.match(partMismatch(p, { bytes: 99, sha256: 'a'.repeat(64) }) ?? '', /99 bytes, not the 100/)
  assert.match(partMismatch(p, { bytes: 100, sha256: 'b'.repeat(64) }) ?? '', /SHA-256 differs/)
  assert.equal(partMismatch(p, { bytes: 100, sha256: null }), null)
  assert.match(partMismatch(p, { bytes: 1, sha256: null }) ?? '', /1 bytes/)
  assert.equal(toHex(new Uint8Array([0, 15, 16, 255])), '000f10ff')
  assert.equal(toHex(new Uint8Array([171, 205]).buffer), 'abcd')
})

test('a manifest that is not a synthetic demo manifest, or names a file outside its folder, is refused, never guessed', () => {
  const ok = structuredClone(manifest)
  const bad = (change: (m: typeof manifest) => void) => {
    const m = structuredClone(ok)
    change(m)
    return () => parseDemoManifest(m)
  }
  assert.throws(() => parseDemoManifest(null), DemoManifestError)
  assert.throws(() => parseDemoManifest([]), DemoManifestError)
  assert.throws(bad((m) => (m.kind = 'something-else')), /version 1 demo/)
  assert.throws(bad((m) => (m.version = 2)), /version 1 demo/)
  assert.throws(bad((m) => (m.synthetic = 'yes')), /synthetic/)
  assert.throws(bad((m) => delete m.synthetic), /synthetic/)
  assert.throws(bad((m) => (m.format.container = 'mp3')), /not WAV/)
  assert.throws(bad((m) => (m.utterances = [])), /1 to 50/)
  assert.throws(bad((m) => (m.utterances[0].file = '../secret.wav')), /plain WAV file name/)
  assert.throws(bad((m) => (m.utterances[0].file = 'sub/01.wav')), /plain WAV file name/)
  assert.throws(bad((m) => (m.utterances[0].file = 'https://example.org/a.wav')), /plain WAV file name/)
  assert.throws(bad((m) => (m.utterances[0].file = '01-doctor.webm')), /plain WAV file name/)
  assert.throws(bad((m) => (m.utterances[1].index = 1)), /no index of its own/)
  assert.throws(bad((m) => (m.utterances[1].index = 0)), /no index of its own/)
  assert.throws(bad((m) => (m.utterances[2].durationMs = 0)), /no usable length/)
  assert.throws(bad((m) => (m.utterances[2].durationMs = 120_000)), /no usable length/)
  assert.throws(bad((m) => (m.utterances[3].bytes = 44)), /no usable size/)
  assert.throws(bad((m) => (m.utterances[4].sha256 = 'ABC')), /SHA-256/)
})

test('the parts are played in their index order whatever order the manifest lists them in', () => {
  const m = structuredClone(manifest)
  m.utterances.reverse()
  const plan = parseDemoManifest(m)
  assert.deepEqual(
    plan.parts.map((p) => p.file),
    manifest.utterances.map((u: { file: string }) => u.file),
  )
  assert.equal(plan.parts[7]!.offsetMs, 27919)
})

test('a new line is shown word by word, never with a word it does not have, and whole within 600 ms', () => {
  const text = 'My daughter has had a fever for three days and a mild cough.'
  assert.equal(revealMs(text), REVEAL_MAX_MS)
  assert.equal(revealMs('Yes.'), 80)
  assert.equal(revealMs(''), 0)
  let previous = ''
  for (let t = 0; t <= REVEAL_MAX_MS; t += 20) {
    const shown = revealText(text, t)
    // Always a prefix of the text that arrived, growing, at least its first word.
    assert.ok(text.startsWith(shown), shown)
    assert.ok(shown.length >= previous.length)
    assert.ok(shown.length >= 'My'.length)
    previous = shown
  }
  assert.equal(revealText(text, 0), 'My')
  assert.equal(revealText(text, REVEAL_MAX_MS), text)
  assert.equal(revealText(text, 10_000), text)
  assert.equal(revealText(text, Number.NaN), text)
  assert.equal(revealText('', 10), '')
  assert.equal(revealText('   ', 10), '   ')
  // Halfway through, about half the words.
  assert.equal(revealText(text, 300).split(' ').length, 7)
})

test('only lines not seen before are new; what is there when a transcript is first shown is not', () => {
  assert.deepEqual(newLineIds(null, ['L1', 'L2']), [])
  assert.deepEqual(newLineIds(new Set(['L1']), ['L1', 'L2', 'L3']), ['L2', 'L3'])
  assert.deepEqual(newLineIds(new Set(['L1', 'L2']), ['L1', 'L2']), [])
})

test('the demo is offered only where simulators are allowed, with recording consent, in an open consultation; it starts only when recording could', () => {
  const base = { open: true, simulatorAllowed: true, consentGranted: true, canRecord: true, blockedReason: null, recording: false }
  assert.deepEqual(demoGate(base), { offered: true, canStart: true, reason: null })
  // Not offered: a clinical or production deployment, the gate not read (or not readable), no consent, a closed consultation.
  for (const off of [{ simulatorAllowed: false }, { simulatorAllowed: null }, { simulatorAllowed: undefined }, { consentGranted: false }, { open: false }]) {
    assert.deepEqual(demoGate({ ...base, ...off }), { offered: false, canStart: false, reason: null }, JSON.stringify(off))
  }
  assert.deepEqual(demoGate({ ...base, recording: true }), { offered: true, canStart: false, reason: 'A recording from the microphone is running: stop it first.' })
  assert.deepEqual(demoGate({ ...base, canRecord: false, blockedReason: 'Local transcription is unavailable.' }), { offered: true, canStart: false, reason: 'Local transcription is unavailable.' })
  assert.deepEqual(demoGate({ ...base, canRecord: false, blockedReason: null }), { offered: true, canStart: false, reason: 'Recording cannot start now.' })
  assert.deepEqual(demoGate({ ...base, canRecord: null }), { offered: true, canStart: false, reason: 'Checking the speech service…' })
})

test('a refusal to start says what happened, and that nothing was played or sent', () => {
  assert.match(demoRefusal('demo_audio_not_allowed') ?? '', /not allowed in this deployment.*Nothing was played or sent/)
  assert.match(demoRefusal('recording_in_progress') ?? '', /already running.*Nothing was played or sent/)
  assert.match(demoRefusal('consent_withdrawn') ?? '', /consent/)
  assert.match(demoRefusal('ai_consent_required') ?? '', /consent/)
  assert.equal(demoRefusal('stt_unavailable'), null)
})

test('while it runs it says which part plays and what the server has transcribed; missing is never said as none', () => {
  const c = { total: 8, current: 3, played: 2, transcribed: 1, failed: 0 }
  const o = { extractor: 'extract-rules-v1', extracted: false }
  assert.equal(demoProgressLine(c), '1 part transcribed · 1 waiting for the speech model')
  assert.equal(demoProgressLine({ ...c, played: 8, transcribed: 6, failed: 2 }), '6 parts transcribed · 2 parts could not be transcribed')
  assert.equal(demoStatusLine('idle', c, o), '')
  assert.equal(demoStatusLine('loading', c, o), 'Getting the demo audio ready…')
  assert.equal(demoStatusLine('playing', c, o), 'Playing part 3 of 8 · 1 part transcribed · 1 waiting for the speech model')
  assert.equal(demoStatusLine('paused', c, o), 'Paused at part 3 of 8 · 1 part transcribed · 1 waiting for the speech model')
  assert.equal(demoStatusLine('finishing', { ...c, current: 8, played: 8, transcribed: 6 }, o), 'Every part played · 6 parts transcribed · 2 waiting for the speech model')
  // Stopped: never "every part played"; the parts played are still being transcribed.
  assert.equal(demoStatusLine('finishing', c, o), 'Stopped after 2 of 8 parts · 1 part transcribed · 1 waiting for the speech model')
  assert.equal(demoStatusLine('ending', { ...c, transcribed: 2 }, o), 'Ending the recording · 2 parts transcribed')
  assert.equal(demoStatusLine('extracting', c, o), 'Finding important points with fixed rules (extract-rules-v1)…')
  const done = { ...c, current: 8, played: 8, transcribed: 8 }
  assert.equal(demoStatusLine('done', done, { ...o, extracted: true }), 'Demo finished: 8 of 8 parts transcribed by the speech model. Important points found by fixed rules (extract-rules-v1), to review, are below.')
  // Without the extraction (off, failed, or nothing transcribed), no points are announced.
  assert.equal(demoStatusLine('done', done, o), 'Demo finished: 8 of 8 parts transcribed by the speech model.')
  assert.equal(demoStatusLine('stopped', { ...c, played: 2, transcribed: 2 }, o), 'Demo stopped after 2 of 8 parts · 2 parts transcribed.')
  assert.equal(demoStatusLine('stopped', { ...c, played: 0, transcribed: 0 }, o), 'Demo stopped after 0 of 8 parts · 0 parts transcribed.')
  for (const p of ['loading', 'starting', 'playing', 'paused', 'finishing', 'ending', 'extracting'] as const) assert.equal(demoActive(p), true, p)
  for (const p of ['idle', 'done', 'stopped'] as const) assert.equal(demoActive(p), false, p)
})

test('synthetic demo audio playing is never shown as a recording in the conversation module', () => {
  const recording = { kind: 'recording', word: 'Recording', tone: 'down' as const }
  assert.deepEqual(demoConversationState(recording, true), { kind: 'demo_playing', word: 'Synthetic demo playing', tone: 'neutral' })
  assert.deepEqual(demoConversationState({ ...recording, word: 'Recording · not updated', tone: 'neutral', behind: true }, true), { kind: 'demo_playing', word: 'Synthetic demo playing · not updated', tone: 'neutral', behind: true })
  // A microphone recording, and every other state, is left as it is.
  assert.equal(demoConversationState(recording, false), recording)
  const review = { kind: 'to_review', word: '3 points to review', tone: 'warn' as const }
  assert.equal(demoConversationState(review, true), review)
  assert.equal(DEMO_PLAYING_LINE, 'Playing — open to stop.')
  assert.deepEqual(demoSummaryLines(['Recording — open to stop.', 'Started 10:31'], true), [DEMO_PLAYING_LINE, 'Started 10:31'])
  assert.deepEqual(demoSummaryLines(['Recording — open to stop.', 'Started 10:31'], false), ['Recording — open to stop.', 'Started 10:31'])
  assert.deepEqual(demoSummaryLines([], true), [])
})

test('the panel names a transcript by its recorded audio origin, and a point found by fixed rules says so', () => {
  assert.equal(transcriptSourceLabel({ source: 'browser_recording', audioOrigin: 'demo_synthetic' }), 'Synthetic demo audio')
  assert.equal(transcriptSourceLabel({ source: 'browser_recording', audioOrigin: 'microphone' }), 'Microphone recording')
  // Recorded before the origin was kept: only the microphone could make a browser recording then.
  assert.equal(transcriptSourceLabel({ source: 'browser_recording', audioOrigin: null }), 'Microphone recording')
  assert.equal(transcriptSourceLabel({ source: 'audio_upload', audioOrigin: 'upload' }), 'Uploaded audio')
  assert.equal(transcriptSourceLabel({ source: 'audio_upload' }), 'Uploaded audio')
  assert.equal(transcriptSourceLabel({ source: 'typed', audioOrigin: null }), 'Typed transcript')
  assert.equal(isDemoTranscript({ audioOrigin: 'demo_synthetic' }), true)
  assert.equal(isDemoTranscript({ audioOrigin: 'microphone' }), false)
  assert.equal(isDemoTranscript({}), false)
  assert.equal(isDemoTranscript(null), false)
  assert.equal(isDemoTranscript('demo_synthetic'), false)
  const rules = { provider: 'adaxai-rules', model: 'extract-rules-v1', version: 'extract-rules-v1', local: true }
  assert.equal(pointProvenance(rules, true), 'Found by fixed rules (extract-rules-v1), to review · Rules on this computer')
  assert.equal(pointProvenance(rules, false), 'Found by fixed rules (extract-rules-v1) · Rules on this computer')
  assert.equal(pointProvenance({ provider: 'anthropic', model: 'm', version: null, local: false }, true), 'External model (m)')
})
