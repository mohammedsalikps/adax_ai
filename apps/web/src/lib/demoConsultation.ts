/*
 * The demo consultation (Doctor HERO §3): a written consultation with a fictional adult patient (fever and cough), read by two of Windows' built-in computer voices
 * (scripts/demo-audio.ps1, files in apps/web/public/demo/consultation), played through this computer's speakers and sent, part by part as each
 * ends, to the REAL local speech model as the parts of a live recording whose audio is recorded as synthetic demo audio. Offered only where
 * simulators are allowed (the gate of the device and thermal simulators) and the patient's recording consent is present. What appears is what the
 * speech model heard: the script's words and speakers in the manifest are never shown, nor used to fill or label a line.
 *
 * Pure helpers, without React or a browser, so that every rule here is tested (test/demoConsultation.test.ts).
 */

/** Where the demo's files are served (by the web app itself, never by the API). */
export const DEMO_DIR = '/demo/consultation/'
export const DEMO_MANIFEST_URL = `${DEMO_DIR}manifest.json`

/** The mark beside the demo wherever it is offered or played. */
export const DEMO_AUDIO_LABEL = 'SYNTHETIC AUDIO — computer voices, not a real consultation'

/** How often the consultation's AI state is read while the demo plays (it shows a part as received, then as transcribed). */
export const DEMO_POLL_MS = 1000

/** One part of the demo: one utterance's file, where it starts on the recording's own timeline, and what its bytes must be. */
export interface DemoPart {
  /** 0-based, the live recording's part number. */
  chunkIndex: number
  file: string
  url: string
  /** The sum of the earlier parts' lengths: the parts follow each other on the recording's timeline. */
  offsetMs: number
  durationMs: number
  bytes: number
  sha256: string
}

export interface DemoPlan {
  parts: DemoPart[]
  totalMs: number
}

export class DemoManifestError extends Error {
  constructor(message: string) {
    super(`The demo audio's manifest is not usable: ${message}`)
    this.name = 'DemoManifestError'
  }
}

const MAX_PARTS = 50
const MAX_PART_MS = 60_000
const MAX_PART_BYTES = 25 * 1024 * 1024
/** A plain file name next to the manifest: no folder, no way out of the demo's folder. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.wav$/
const SHA256 = /^[0-9a-f]{64}$/

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

/**
 * The parts to play and send, from the manifest the generator wrote (kind adaxai-demo-consultation-audio, version 1, synthetic). Every part
 * must be a plain WAV file name beside the manifest with a length, a size and a SHA-256; the parts are put in their index order, and each starts
 * where the earlier ones end. Anything else is refused, never guessed. The utterances' speaker and text are not read.
 */
export function parseDemoManifest(x: unknown): DemoPlan {
  if (!isObject(x)) throw new DemoManifestError('it is not an object.')
  if (x.kind !== 'adaxai-demo-consultation-audio' || x.version !== 1) throw new DemoManifestError('it is not a version 1 demo consultation manifest.')
  if (x.synthetic !== true) throw new DemoManifestError('it does not say the audio is synthetic.')
  if (!isObject(x.format) || x.format.container !== 'wav') throw new DemoManifestError('its audio is not WAV.')
  const list = x.utterances
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PARTS) throw new DemoManifestError(`it must list 1 to ${MAX_PARTS} utterances.`)
  const seen = new Set<number>()
  const items = list.map((u, i) => {
    if (!isObject(u)) throw new DemoManifestError(`utterance ${i + 1} is not an object.`)
    const { index, file, durationMs, bytes, sha256 } = u
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || seen.has(index)) throw new DemoManifestError(`utterance ${i + 1} has no index of its own.`)
    seen.add(index)
    if (typeof file !== 'string' || !FILE_NAME.test(file)) throw new DemoManifestError(`utterance ${index} is not a plain WAV file name.`)
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_PART_MS) throw new DemoManifestError(`utterance ${index} has no usable length.`)
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 44 || bytes > MAX_PART_BYTES) throw new DemoManifestError(`utterance ${index} has no usable size.`)
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new DemoManifestError(`utterance ${index} has no SHA-256.`)
    return { index, file, durationMs: Math.round(durationMs), bytes, sha256 }
  })
  items.sort((a, b) => a.index - b.index)
  let offsetMs = 0
  const parts = items.map((u, chunkIndex): DemoPart => {
    const p = { chunkIndex, file: u.file, url: `${DEMO_DIR}${u.file}`, offsetMs, durationMs: u.durationMs, bytes: u.bytes, sha256: u.sha256 }
    offsetMs += u.durationMs
    return p
  })
  return { parts, totalMs: offsetMs }
}

/** Bytes as lower-case hex (a SHA-256 digest, to compare with the manifest's). */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of a) s += b.toString(16).padStart(2, '0')
  return s
}

/** Why a file of the demo is not the one the manifest names (its size or its SHA-256), or null when it is. */
export function partMismatch(part: Pick<DemoPart, 'file' | 'bytes' | 'sha256'>, got: { bytes: number; sha256: string | null }): string | null {
  if (got.bytes !== part.bytes) return `${part.file} is ${got.bytes} bytes, not the ${part.bytes} its manifest says.`
  if (got.sha256 !== null && got.sha256 !== part.sha256) return `${part.file} is not the file its manifest names (its SHA-256 differs).`
  return null
}

// --- How the transcription panel names where things came from ------------------------------------------------------------------------------

/** Whether a transcript's audio was the synthetic demo consultation, as the transcript records it (read loosely: one without the field is not). */
export const isDemoTranscript = (t: unknown): boolean => !!t && typeof t === 'object' && (t as { audioOrigin?: unknown }).audioOrigin === 'demo_synthetic'

/**
 * Where a transcript came from, as the panel names it: by the audio origin the transcript records, else by its source. A browser recording made
 * before the origin was recorded is a microphone recording (nothing else could make one then); typed or pasted text has no audio.
 */
export function transcriptSourceLabel(t: { source: string; audioOrigin?: string | null }): string {
  if (t.audioOrigin === 'demo_synthetic') return 'Synthetic demo audio'
  if (t.audioOrigin === 'upload' || t.source === 'audio_upload') return 'Uploaded audio'
  if (t.audioOrigin === 'microphone' || t.source === 'browser_recording') return 'Microphone recording'
  return 'Typed transcript'
}

/**
 * What made an important point, on the point's own line: the fixed rules by name and version, and "to review" while the doctor has not decided
 * ("Found by fixed rules (extract-rules-v1), to review · Rules on this computer"); another extractor in the panel's earlier words.
 */
export function pointProvenance(p: { provider: string; model: string; version: string | null; local: boolean | null }, undecided: boolean): string {
  const v = p.version ?? p.model
  if (p.provider === 'adaxai-rules') return `Found by fixed rules (${v})${undecided ? ', to review' : ''} · Rules on this computer`
  return `${p.local ? 'Rules on this computer' : 'External model'} (${v})`
}

// --- Words of a new line, shown one after another -------------------------------------------------------------------------------------------

/** A newly arrived line is shown word by word in at most this long (then whole); with reduced motion, at once. */
export const REVEAL_MAX_MS = 600
const REVEAL_WORD_MS = 80

const wordsOf = (text: string) => text.match(/\S+\s*/g) ?? []

/** How long a line's words take to appear: 80 ms a word, never more than 600 ms. */
export const revealMs = (text: string) => Math.min(REVEAL_MAX_MS, wordsOf(text).length * REVEAL_WORD_MS)

/**
 * The words of a line shown `elapsedMs` after it began to appear: a growing prefix of the text that arrived (at least its first word), then the
 * whole text. Presentation only: never a word that is not in the text.
 */
export function revealText(text: string, elapsedMs: number): string {
  const words = wordsOf(text)
  const total = revealMs(text)
  if (!words.length || !(elapsedMs < total)) return text
  const shown = Math.min(words.length, Math.max(1, Math.ceil((Math.max(0, elapsedMs) / total) * words.length)))
  return words.slice(0, shown).join('').trimEnd()
}

/** The lines not seen before, in their order; none the first time a transcript is seen (what is there already is not new). */
export const newLineIds = (known: ReadonlySet<string> | null, ids: string[]): string[] => (known ? ids.filter((id) => !known.has(id)) : [])

// --- Whether it is offered and can start ---------------------------------------------------------------------------------------------------

export interface DemoGateInput {
  /** The consultation is open and this doctor may record it. */
  open: boolean
  /** GET /devices' simulatorAllowed; null while not read (and when it could not be read): not offered. */
  simulatorAllowed: boolean | null | undefined
  consentGranted: boolean
  /** The recorder's status: whether recording may start now (consent, the local speech service, the consultation), with its reason. */
  canRecord: boolean | null | undefined
  blockedReason?: string | null | undefined
  /** A microphone recording is running in this consultation. */
  recording: boolean
}

/** Offered only where simulators are allowed, with the patient's recording consent, in an open consultation; it starts only when recording could. */
export function demoGate(i: DemoGateInput): { offered: boolean; canStart: boolean; reason: string | null } {
  const offered = i.open && i.simulatorAllowed === true && i.consentGranted
  if (!offered) return { offered, canStart: false, reason: null }
  if (i.recording) return { offered, canStart: false, reason: 'A recording from the microphone is running: stop it first.' }
  if (i.canRecord !== true) return { offered, canStart: false, reason: i.canRecord === false ? (i.blockedReason ?? 'Recording cannot start now.') : 'Checking the speech service…' }
  return { offered, canStart: true, reason: null }
}

/** What the doctor is told when the API refuses to start the demo's recording (by the refusal's code), or null to use the API's own words. */
export function demoRefusal(code: string): string | null {
  if (code === 'demo_audio_not_allowed') return 'Synthetic demo audio is not allowed in this deployment (its data is clinical, or it runs in production). Nothing was played or sent.'
  if (code === 'recording_in_progress') return 'A recording is already running for this consultation (another tab or window). Nothing was played or sent.'
  if (/^(ai_)?consent_/.test(code)) return 'The patient’s consent to recording is not recorded for this consultation. Nothing was played or sent.'
  return null
}

// --- What it says while it runs -------------------------------------------------------------------------------------------------------------

export type DemoPhase = 'idle' | 'loading' | 'starting' | 'playing' | 'paused' | 'finishing' | 'ending' | 'extracting' | 'done' | 'stopped'

/** The phases during which the demo holds the recording: the microphone recorder waits, and the panel reads the AI state often. */
export const demoActive = (p: DemoPhase) => p !== 'idle' && p !== 'done' && p !== 'stopped'

export interface DemoCounts {
  total: number
  /** The part being played (1-based), 0 before the first. */
  current: number
  /** Parts played to their end (and so sent). */
  played: number
  /** Parts of the demo's recording the server has transcribed, and those it could not, as its last answer has them. */
  transcribed: number
  failed: number
}

const parts = (n: number) => `${n} part${n === 1 ? '' : 's'}`

/** "2 parts transcribed · 1 waiting for the speech model": the server's count, and the played parts it has not answered for yet. */
export function demoProgressLine(c: DemoCounts): string {
  const waiting = Math.max(0, c.played - c.transcribed - c.failed)
  return [`${parts(c.transcribed)} transcribed`, waiting ? `${waiting} waiting for the speech model` : null, c.failed ? `${parts(c.failed)} could not be transcribed` : null].filter(Boolean).join(' · ')
}

/**
 * The demo's state in one line, as its status (read out politely as it changes). `extractor` is the fixed rules' version; `extracted` whether
 * they ran at the end (they do not when nothing was transcribed, or the extraction is off or failed).
 */
export function demoStatusLine(phase: DemoPhase, c: DemoCounts, o: { extractor: string | null; extracted: boolean }): string {
  const progress = demoProgressLine(c)
  const extractor = o.extractor
  switch (phase) {
    case 'idle':
      return ''
    case 'loading':
      return 'Getting the demo audio ready…'
    case 'starting':
      return 'Starting the recording of the demo…'
    case 'playing':
      return `Playing part ${c.current} of ${c.total} · ${progress}`
    case 'paused':
      return `Paused at part ${c.current} of ${c.total} · ${progress}`
    // Stopped (or a part could not be played): the parts played are still transcribed before the recording is ended.
    case 'finishing':
      return `${c.played < c.total ? `Stopped after ${c.played} of ${c.total} parts` : 'Every part played'} · ${progress}`
    case 'ending':
      return `Ending the recording · ${progress}`
    case 'extracting':
      return `Finding important points with fixed rules${extractor ? ` (${extractor})` : ''}…`
    case 'done':
      return `Demo finished: ${c.transcribed} of ${c.total} parts transcribed by the speech model.${o.extracted ? ` Important points found by fixed rules${extractor ? ` (${extractor})` : ''}, to review, are below.` : ''}`
    case 'stopped':
      return `Demo stopped after ${c.played} of ${c.total} parts · ${progress}.${o.extracted ? ` Important points found by fixed rules${extractor ? ` (${extractor})` : ''}, to review, are below.` : ''}`
  }
}

// --- The conversation module while the demo plays ------------------------------------------------------------------------------------------

/**
 * The conversation module's first line while the demo's recording is live (instead of "Recording — open to stop."): the chip says "Synthetic
 * demo playing" and the "Synthetic demo audio" mark follows on the same line.
 */
export const DEMO_PLAYING_LINE = 'Playing — open to stop.'

/** A module chip's state (the shape of the summaries' SummaryState). */
export interface ChipState {
  kind: string
  word: string
  tone: 'ok' | 'warn' | 'down' | 'notice' | 'neutral'
  behind?: boolean
}

/** The conversation module's chip, given whether the live recording is the demo's: synthetic demo audio is never shown as a recording (red). */
export function demoConversationState(state: ChipState, liveDemo: boolean): ChipState {
  if (!liveDemo || state.kind !== 'recording') return state
  return { ...state, kind: 'demo_playing', word: state.behind ? 'Synthetic demo playing · not updated' : 'Synthetic demo playing', tone: 'neutral' }
}

/** The closed module's lines while the demo's recording is live: its first line says what is playing, never "Recording". */
export const demoSummaryLines = (lines: string[], liveDemo: boolean): string[] => (liveDemo && lines.length ? [DEMO_PLAYING_LINE, ...lines.slice(1)] : lines)
