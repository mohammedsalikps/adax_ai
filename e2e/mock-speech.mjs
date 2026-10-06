// TEST-ONLY stand-in for the local speech service (services/speech), used solely by the Playwright
// suite (see playwright.config.ts). It speaks the same loopback protocol (GET /health, POST /v1/transcribe)
// so the end-to-end tests exercise the real browser -> API -> speech-boundary path without loading a model.
// It is never started by `npm run dev`, setup or any demo configuration, and it is not speech recognition:
// it ignores what was said and returns a fixed, clearly synthetic script of five lines, spread over the
// length of the audio it was sent (read from the WebM container or the WAV header, so timestamps follow the real recording).
// It keeps no audio and no text: only how many parts it was sent (GET /__calls).
import http from 'node:http'
// The synthetic consultation this stand-in "hears" (shared with the hosted-provider stand-in, which watches for its words).
import { SCRIPT } from './synthetic-consultation.mjs'

const PORT = Number(process.env.MOCK_SPEECH_PORT || 8199)

const MODEL = { id: 'mock-speech-e2e', runtime: 'mock-speech (TEST-ONLY, no speech recognition)', computeType: 'none', device: 'none', weightsSha256: '0'.repeat(64), multilingual: false, local: true }

let calls = 0

/** An EBML variable-length integer at `pos`: its value (the length marker kept for element ids), its byte length, and whether the size is "unknown". */
function vint(buf, pos, keepMarker) {
  const first = buf[pos]
  if (!first) return null
  let len = 1
  while (!(first & (0x80 >> (len - 1)))) len++
  if (pos + len > buf.length) return null
  const bits = first & (0xff >> len)
  let value = keepMarker ? first : bits
  let unknown = bits === 0xff >> len
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i]
    if (buf[pos + i] !== 0xff) unknown = false
  }
  return { value, len, unknown }
}

const SEGMENT = 0x18538067
const CLUSTER = 0x1f43b675
const BLOCK_GROUP = 0xa0
const TIMECODE = 0xe7
const SIMPLE_BLOCK = 0xa3
const BLOCK = 0xa1

/** Walks a WebM file and notes the latest block time (ms; the default 1 ms timecode scale), which is the recording's length. */
function walk(buf, start, end, state) {
  let pos = start
  while (pos < end) {
    const id = vint(buf, pos, true)
    if (!id) return
    const size = vint(buf, pos + id.len, false)
    if (!size) return
    const body = pos + id.len + size.len
    const bodyEnd = size.unknown ? end : Math.min(end, body + size.value)
    if (id.value === SEGMENT || id.value === CLUSTER || id.value === BLOCK_GROUP) {
      if (id.value === CLUSTER) state.cluster = 0
      walk(buf, body, bodyEnd, state)
    } else if (id.value === TIMECODE) {
      let v = 0
      for (let i = body; i < bodyEnd; i++) v = v * 256 + buf[i]
      state.cluster = v
    } else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      const track = vint(buf, body, false)
      if (track && body + track.len + 2 <= buf.length) state.last = Math.max(state.last, state.cluster + buf.readInt16BE(body + track.len))
    }
    pos = bodyEnd
  }
}

/** A WAV file's length in ms (its data chunk over its byte rate), or null when it is not a WAV file (the demo consultation's parts are). */
function wavDuration(audio) {
  if (audio.length < 12 || audio.toString('latin1', 0, 4) !== 'RIFF' || audio.toString('latin1', 8, 12) !== 'WAVE') return null
  let byteRate = 0
  for (let pos = 12; pos + 8 <= audio.length; ) {
    const id = audio.toString('latin1', pos, pos + 4)
    const size = audio.readUInt32LE(pos + 4)
    if (id === 'fmt ' && pos + 16 <= audio.length) byteRate = audio.readUInt32LE(pos + 16)
    if (id === 'data') return byteRate > 0 ? Math.round((Math.min(size, audio.length - pos - 8) * 1000) / byteRate) : null
    pos += 8 + size + (size % 2)
  }
  return null
}

function durationOf(audio) {
  const wav = wavDuration(audio)
  if (wav !== null && wav > 0) return wav
  const state = { cluster: 0, last: -1 }
  try {
    walk(audio, 0, audio.length, state)
  } catch {
    // Not WebM, or damaged: fall through to the default.
  }
  return state.last >= 0 ? state.last + 20 : 5000
}

/** The bytes of the multipart `file` field, or null. */
function filePart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (!boundary) return null
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  const at = body.indexOf('name="file"')
  if (at < 0) return null
  const from = body.indexOf('\r\n\r\n', at)
  if (from < 0) return null
  const to = body.indexOf(Buffer.concat([Buffer.from('\r\n'), marker]), from + 4)
  return body.subarray(from + 4, to < 0 ? body.length : to)
}

function transcribe(audio) {
  const durationMs = durationOf(audio)
  const slot = durationMs / SCRIPT.length
  return {
    model: MODEL,
    language: 'en',
    languageProbability: 0.99,
    languageSource: 'detected',
    durationMs,
    confidenceKind: 'mean_token_probability',
    speakers: 'not_identified',
    segments: SCRIPT.map((s, i) => ({
      startMs: Math.round(slot * i + slot * 0.05),
      endMs: Math.round(slot * (i + 1) - slot * 0.05),
      text: s.text,
      avgLogprob: s.avgLogprob,
      noSpeechProb: s.noSpeechProb,
      confidence: s.confidence,
    })),
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { service: 'speech', status: 'ready', model: MODEL })
    if (req.method === 'GET' && req.url === '/__calls') return json(res, 200, { calls })
    if (req.method !== 'POST' || req.url !== '/v1/transcribe') return json(res, 404, { error: 'not_found' })
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const audio = filePart(Buffer.concat(chunks), req.headers['content-type'])
      if (!audio || !audio.length) return json(res, 422, { error: 'undecodable_audio' })
      calls++
      json(res, 200, transcribe(audio))
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[mock-speech] TEST-ONLY mock listening on ${PORT}`))
