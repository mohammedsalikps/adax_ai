#!/usr/bin/env node
// The SYNTHETIC demo consultation audio (computer voices, not a real consultation): makes it with scripts/demo-audio.ps1 and checks it.
//
//   node scripts/demo-audio.mjs                 runs scripts/demo-audio.ps1 (Windows only), then checks every file against manifest.json
//   node scripts/demo-audio.mjs --check         checks the files already there (any platform), without making them again
//   node scripts/demo-audio.mjs --transcribe    also sends each file to the RUNNING local speech service and prints what the model heard beside
//                                               the script, with the word errors (needs the speech service, e.g. `npm run dev:speech`)
//
// The check: a plain PCM WAV header (16 kHz, mono, 16-bit), the data length, and the duration, size and SHA-256 that the manifest records.
// Word errors are counted the plain way: lower case, punctuation removed, then insertions, deletions and substitutions of words (so "3" for
// "three" counts as one). The speech service is reached on this computer only.

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, loadEnv } from './lib/env.mjs'

loadEnv()
const DIR = path.join(ROOT, 'apps', 'web', 'public', 'demo', 'consultation')
const args = process.argv.slice(2)
const say = (m) => console.log(`[demo-audio] ${m}`)
const fail = (m) => {
  console.error(`[demo-audio] ${m}`)
  process.exit(1)
}

if (!args.includes('--check')) {
  if (process.platform !== 'win32') fail('Making the audio needs Windows text-to-speech (System.Speech). Use --check to check the committed files.')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'demo-audio.ps1'), '-OutDir', DIR], { stdio: 'inherit' })
  if (r.status !== 0) fail(`scripts/demo-audio.ps1 failed (exit ${r.status ?? r.signal}).`)
}

/** The format and the PCM data of a WAV file with the plain 44-byte header the generator writes, or the reason it is not one. */
function readWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 16) !== 'WAVEfmt ' || buf.toString('ascii', 36, 40) !== 'data') return { error: 'not a plain WAV file' }
  if (buf.readUInt32LE(4) !== buf.length - 8) return { error: 'the RIFF length does not match the file' }
  const fmt = { tag: buf.readUInt16LE(20), channels: buf.readUInt16LE(22), rate: buf.readUInt32LE(24), bits: buf.readUInt16LE(34) }
  if (buf.readUInt32LE(16) !== 16 || fmt.tag !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) return { error: `not 16 kHz mono 16-bit PCM (${JSON.stringify(fmt)})` }
  if (buf.readUInt32LE(40) !== buf.length - 44) return { error: 'the data length does not match the file' }
  return { samples: (buf.length - 44) / 2 }
}

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'))
if (manifest.synthetic !== true) fail('manifest.json does not say the audio is synthetic.')
let problems = 0
for (const u of manifest.utterances) {
  const buf = fs.readFileSync(path.join(DIR, u.file))
  const wav = readWav(buf)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const why = wav.error ?? (sha256 !== u.sha256 ? 'SHA-256 differs from the manifest' : buf.length !== u.bytes ? 'size differs from the manifest' : Math.round((wav.samples * 1000) / 16000) !== u.durationMs ? 'duration differs from the manifest' : null)
  if (why) {
    problems++
    console.error(`[demo-audio] ${u.file}: ${why}`)
  }
}
if (problems) fail(`${problems} file(s) do not match manifest.json.`)
say(`${manifest.utterances.length} files checked against manifest.json: 16 kHz mono 16-bit PCM, sizes, durations and SHA-256 agree.`)

if (args.includes('--transcribe')) {
  const url = (process.env.SPEECH_URL || 'http://127.0.0.1:8002').replace(/\/+$/, '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) fail(`${url} is not this computer; the demo audio is only sent to the local speech service.`)
  const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean)
  /** Word-level edit distance (insertions, deletions, substitutions). */
  const edits = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
    return prev[b.length]
  }
  let errors = 0
  let total = 0
  let model = ''
  for (const u of manifest.utterances) {
    const form = new FormData()
    form.append('file', new Blob([fs.readFileSync(path.join(DIR, u.file))], { type: 'audio/wav' }), u.file)
    const started = Date.now()
    const res = await fetch(`${url}/v1/transcribe`, { method: 'POST', body: form, headers: { 'x-adaxai-local': '1' } }).catch((e) => fail(`cannot reach the speech service at ${url} (${e.message}).`))
    const body = await res.json().catch(() => ({}))
    if (res.status !== 200) fail(`${u.file}: the speech service answered ${res.status} (${body.error ?? ''} ${body.message ?? ''}).`)
    const heard = body.segments.map((s) => s.text.trim()).join(' ')
    const e = edits(words(u.text), words(heard))
    errors += e
    total += words(u.text).length
    model = `${body.model?.id ?? 'unknown model'} (${body.model?.runtime ?? 'runtime not reported'})`
    say(`${u.file} (${u.speaker}, ${u.durationMs} ms, ${Date.now() - started} ms to transcribe, language ${body.language}): ${e} word error(s) of ${words(u.text).length}`)
    say(`  script: ${u.text}`)
    say(`  heard:  ${heard}`)
  }
  say(`${model}: ${errors} word error(s) in ${total} words (${((100 * errors) / total).toFixed(1)} %).`)
}
