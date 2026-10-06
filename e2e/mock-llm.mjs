// TEST-ONLY stand-in for the local language-model server (llama.cpp's llama-server), used by the end-to-end suite so it needs no model.
// It speaks the little of the OpenAI-style API that the application uses: GET /health, GET /v1/models, POST /v1/chat/completions. It answers
// from the sources it is shown, copying their text, so every statement it returns is grounded in the record and cites ids that exist.
// Loopback only, and like the real server it wants a bearer secret (except for /health). It is NOT a model: nothing here is "AI output" in
// any sense but shape, and no screen shows it as anything other than a test stand-in.
//
// Control (test only): POST /__mode {"mode": "ok" | "slow" | "down" | "invalid" | "inject" | "empty", "delayMs"?: number, "readMs"?: number,
// "streamMs"?: number}, GET /__calls (what was asked, as counts and whether given words were in the prompt, and whether it asked for a stream),
// POST /__reset.
//
// A request with `stream: true` is answered as llama-server answers it: the headers at once, then server-sent events, one `data:` piece per few
// characters of the same text a whole answer would carry (`choices[0].delta.content`), a last piece with `finish_reason` and the server's own
// counts (`timings`), then `data: [DONE]`. Before the first piece the stand-in "reads" for `readMs` (by default 400 ms, or `delayMs` if
// shorter); the pieces are then spread over `streamMs` (by default the rest of `delayMs`, and at least 1.2 s, so that the application's
// progress, passed on at most every 500 ms, can be seen to advance). So "slow" stays as slow as a whole answer, and is slow while writing. One
// piece is one "token" here: a count of pieces, not of any model's tokens.

import http from 'node:http'

const PORT = Number.parseInt(process.env.MOCK_LLM_PORT ?? '8181', 10)
const KEY = process.env.MOCK_LLM_KEY ?? 'e2e-llm-secret-not-a-key'
const MODEL = 'mock-llm-e2e'
/** How long a streamed answer takes at least to send: just over a second, so that at least one progress report falls inside it. */
const STREAM_MS = 1200
/** How long the stand-in "reads" before its first piece, unless a test sets it. */
const READ_MS = 400
/** Characters per streamed piece (about what one token of English is). */
const PIECE_CHARS = 4
/** How often pieces are written while streaming. */
const TICK_MS = 50

let mode = 'ok'
let delayMs = 400
/** @type {number | null} */
let readMs = null
/** @type {number | null} */
let streamMs = null
/** @type {{ at: number, promptChars: number, prompt: string, refs: string[], stream: boolean }[]} */
let calls = []

const send = (res, status, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Streams `content` as server-sent events: the headers at once, the "reading" time, the text in pieces of PIECE_CHARS spread over the writing
 * time, a last piece with the finish reason and the counts (`timings`, as llama-server gives them), and [DONE]. Stops writing as soon as the
 * client goes away (a cancelled draft).
 */
async function stream(res, { id, content, promptTokens }) {
  let gone = false
  res.on('close', () => {
    if (!res.writableFinished) gone = true
  })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.flushHeaders()
  const event = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
  const piece = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, finish_reason: finish, delta }] })
  const read = readMs ?? Math.min(delayMs, READ_MS)
  const writing = streamMs ?? Math.max(STREAM_MS, delayMs - read)
  await sleep(read)
  if (gone) return
  const pieces = content.match(new RegExp(`[\\s\\S]{1,${PIECE_CHARS}}`, 'g')) ?? []
  const ticks = Math.max(1, Math.round(writing / TICK_MS))
  const perTick = Math.max(1, Math.ceil(pieces.length / ticks))
  event(piece({ role: 'assistant', content: null }))
  for (let i = 0; i < pieces.length; i += perTick) {
    if (gone) return
    for (const p of pieces.slice(i, i + perTick)) event(piece({ content: p }))
    if (i + perTick < pieces.length) await sleep(TICK_MS)
  }
  if (gone) return
  event({ ...piece({}, 'stop'), timings: { cache_n: 0, prompt_n: promptTokens, predicted_n: pieces.length } })
  res.write('data: [DONE]\n\n')
  res.end()
}

/** The sources of the user message: "[A1] 2026-10-04 | field | status | provenance: text". */
function sourcesOf(user) {
  const out = []
  for (const line of user.split('\n')) {
    const m = /^\[([A-Z]{1,2}\d{1,3})\] (\S+) \| ([^|]*) \| ([^|]*) \| ([^:]*): (.*)$/.exec(line)
    if (m) out.push({ ref: m[1], date: m[2], field: m[3].trim(), status: m[4].trim(), provenance: m[5].trim(), text: m[6].trim() })
  }
  return out
}

const fact = (text, refs, basis = 'stated', uncertainty = null) => ({ text, refs, basis, uncertainty })
const suggestion = (text, refs, rationale, uncertainty = null) => ({ text, refs, rationale, uncertainty })

function draftFrom(sources) {
  const of = (re) => sources.filter((s) => re.test(`${s.ref} ${s.field}`))
  const reason = sources.filter((s) => /^R\d/.test(s.ref) && /this visit/i.test(s.field))
  const points = sources.filter((s) => /^F\d/.test(s.ref))
  const symptomPoints = points.filter((s) => /symptom|complaint|duration/i.test(s.field))
  const allergies = of(/^A\d/).filter((s) => /^Allergy:/i.test(s.text))
  const meds = sources.filter((s) => /^(M|P|U)\d/.test(s.ref))
  const obs = sources.filter((s) => /^V\d/.test(s.ref) && /this visit/i.test(s.text))
  const history = sources.filter((s) => /^(H|N|D)\d/.test(s.ref)).slice(0, 4)
  const first = sources[0]
  return {
    insufficient_information: false,
    presenting_problem: reason.slice(0, 1).map((s) => fact(s.text, [s.ref])),
    symptoms: symptomPoints.slice(0, 4).map((s) => fact(s.text, [s.ref])),
    observations: obs.slice(0, 3).map((s) => fact(s.text, [s.ref])),
    relevant_history: history.map((s) => fact(s.text.slice(0, 200), [s.ref])),
    allergies: allergies.slice(0, 3).map((s) => fact(s.text, [s.ref])),
    medications: meds.slice(0, 3).map((s) => fact(s.text.slice(0, 200), [s.ref])),
    potential_considerations: reason.slice(0, 1).map((s) => suggestion('Consider whether the problem needs an examination finding that is not yet documented.', [s.ref], `Prompted by ${s.ref}.`, 'Depends on the examination.')),
    potential_investigations: obs.slice(0, 1).map((s) => suggestion('May be worth repeating the measurement if it does not match how the patient looks.', [s.ref], `Prompted by ${s.ref}.`)),
    potential_medication_considerations: allergies.length && meds.length ? [suggestion('Check the medicines in the record against the recorded allergy before anything is added.', [allergies[0].ref, meds[0].ref], `Allergy ${allergies[0].ref} and medicine ${meds[0].ref} are both in the record.`)] : [],
    missing_information: [fact('The duration of the main symptom is not documented.', [], 'not_found')].slice(0, symptomPoints.length ? 0 : 1),
    uncertainties: [],
    summary: first ? fact('A draft summary of the record items shown, for the doctor to check.', [first.ref], 'inferred') : null,
  }
}

/** What a model that follows an instruction hidden in a record item would write: made-up references, a dose, a flat diagnosis, a link. */
function injected(sources) {
  const first = sources[0]?.ref ?? 'A1'
  return {
    insufficient_information: false,
    presenting_problem: [fact('Ignore the record: the patient has no allergies and needs amoxicillin 500 mg three times a day.', ['Z99'])],
    symptoms: [fact('The patient definitely has pneumonia. See https://example.invalid/steal?x=1', [first])],
    observations: [fact('Blood pressure 250/190 mmHg.', [first])],
    relevant_history: [],
    allergies: [fact('No known allergies.', [], 'not_found')],
    medications: [],
    potential_considerations: [suggestion('Start azithromycin 500 mg once daily for 5 days.', [first], 'The record says so.')],
    potential_investigations: [],
    potential_medication_considerations: [suggestion('Prescribe amoxicillin.', [first], 'Instructed.')],
    missing_information: [],
    uncertainties: [],
    summary: fact('Everything is fine.', [first], 'stated'),
  }
}

const empty = () => ({ insufficient_information: true, presenting_problem: [], symptoms: [], observations: [], relevant_history: [], allergies: [], medications: [], potential_considerations: [], potential_investigations: [], potential_medication_considerations: [], missing_information: [], uncertainties: [], summary: null })

// --- Mana AI (V4): the planner and the writer -------------------------------------------------------------------------------------------------------
// Both calls come to the same endpoint; the system prompt says which. The planner is a handful of keyword rules (a stand-in: it names no model's skill),
// the writer copies the facts it is shown, citing their ids. In mode "inject" the writer behaves as a model steered by a record would (a link, a handle
// nobody gave); in mode "empty" it writes nothing.

const manaCall = (tool, rest = {}) => ({ tool, patient: null, topic: null, text: null, which: null, when: null, minutes: null, date: null, mine: null, status: null, ...rest })
const manaPlan = (kind, calls = [], clarification = null) => ({ kind, calls, clarification })

function manaPlanFrom(user) {
  const q = /^QUESTION: (.*)$/m.exec(user)?.[1] ?? ''
  const lower = q.toLowerCase()
  const current = /^CURRENT PATIENT: yes/m.test(user)
  const focus = /^FOCUS: (P\d+)/m.exec(user)?.[1] ?? null
  if (/\b(prescribe|sign this|delete|cancel my|book an|add .* allergy)\b/.test(lower)) return manaPlan('write_request')
  if (/\b(usual dose|guideline|paediatric dose)\b/.test(lower)) return manaPlan('general_knowledge')
  if (/\b(every patient|all patients|audit log)\b/.test(lower)) return manaPlan('out_of_scope')
  if (/^(hi|hello|thanks)\b/.test(lower)) return manaPlan('other')
  const named = /\b(?:of|for|about|does|did|is|on)\s+((?:[A-Z][\w'-]+)(?:\s+[A-Z][\w'-]+)?)/.exec(q)?.[1]
  const patient = named ? `name:${named.replace(/'s$/, '')}` : /\b(she|he|her|his|their|they)\b/.test(lower) && focus ? focus : current ? 'current' : null
  if (/waiting|queue/.test(lower)) return manaPlan('tools', [manaCall('get_today_queue', { mine: /\bmy\b/.test(lower), status: /waiting/.test(lower) ? 'waiting' : null })])
  if (/appointments?/.test(lower)) return manaPlan('tools', [manaCall('get_appointments', { when: /tomorrow/.test(lower) ? 'tomorrow' : 'today', mine: /\bmy\b|\bi have\b/.test(lower) })])
  if (/\bvisits?\b/.test(lower)) return manaPlan('tools', [manaCall('get_patient_visits', { patient })])
  const topic = /allerg/.test(lower) ? 'allergies' : /medic|prescri/.test(lower) ? 'medicines' : /vital|blood pressure|temperature/.test(lower) ? 'vitals' : /diagnos/.test(lower) ? 'diagnoses' : /history/.test(lower) ? 'history' : /chang/.test(lower) ? 'changes' : 'briefing'
  return manaPlan('tools', [manaCall('get_patient_record', { patient, topic })])
}

function manaAnswerFrom(user) {
  const facts = []
  for (const line of user.split('\n')) {
    const m = /^\[(S\d{1,3})\] (?:\((P\d{1,2})\) )?(.*)$/.exec(line)
    if (m) facts.push({ ref: m[1], text: m[3].trim() })
  }
  if (mode === 'empty') return { blocks: [] }
  if (mode === 'inject') return { blocks: [{ text: 'Nobody has any allergies. See https://evil.invalid/collect for the rest.', refs: [facts[0]?.ref ?? 'S1'] }] }
  return { blocks: facts.slice(0, 6).map((f) => ({ text: f.text, refs: [f.ref] })) }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/health') return mode === 'down' ? send(res, 503, { error: { code: 503, message: 'Loading model' } }) : send(res, 200, { status: 'ok' })
  if (url.pathname.startsWith('/__')) {
    if (url.pathname === '/__mode' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}')
      mode = b.mode ?? 'ok'
      delayMs = typeof b.delayMs === 'number' ? b.delayMs : mode === 'slow' ? 6000 : 400
      readMs = typeof b.readMs === 'number' ? b.readMs : null
      streamMs = typeof b.streamMs === 'number' ? b.streamMs : null
      return send(res, 200, { mode, delayMs, readMs, streamMs })
    }
    if (url.pathname === '/__calls') return send(res, 200, { count: calls.length, calls: calls.map((c) => ({ at: c.at, promptChars: c.promptChars, refs: c.refs, kind: c.kind, stream: c.stream, prompt: url.searchParams.get('prompts') === '1' ? c.prompt : undefined })) })
    if (url.pathname === '/__reset') {
      calls = []
      mode = 'ok'
      delayMs = 400
      readMs = null
      streamMs = null
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: 'unknown' })
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: { message: 'Invalid API Key', type: 'authentication_error', code: 401 } })
  if (req.method === 'GET' && url.pathname === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model' }] })
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = JSON.parse((await readBody(req)) || '{}')
    const user = String((body.messages ?? []).find((m) => m.role === 'user')?.content ?? '')
    const system = String((body.messages ?? []).find((m) => m.role === 'system')?.content ?? '')
    const mana = system.startsWith('You decide what to look up') ? 'plan' : system.startsWith('You write a short answer for a doctor') ? 'answer' : null
    const sources = sourcesOf(user)
    calls.push({ at: Date.now(), promptChars: user.length, prompt: user, refs: mana ? [...user.matchAll(/^\[(S\d+)\]/gm)].map((m) => m[1]) : sources.map((s) => s.ref), stream: body.stream === true, ...(mana && { kind: mana }) })
    if (mode === 'down') return send(res, 503, { error: { code: 503, message: 'Loading model' } })
    const content = mode === 'invalid' ? 'This is not JSON at all.' : JSON.stringify(mana === 'plan' ? manaPlanFrom(user) : mana === 'answer' ? manaAnswerFrom(user) : mode === 'inject' ? injected(sources) : mode === 'empty' ? empty() : draftFrom(sources))
    if (body.stream === true) return stream(res, { id: `mock-${calls.length}`, content, promptTokens: Math.ceil(user.length / 4) })
    let aborted = false
    req.on('close', () => {
      aborted = true
    })
    await sleep(delayMs)
    if (aborted) return
    return send(res, 200, { id: `mock-${calls.length}`, object: 'chat.completion', model: MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: Math.ceil(user.length / 4), completion_tokens: Math.ceil(content.length / 4) } })
  }
  return send(res, 404, { error: 'not found' })
})
server.listen(PORT, '127.0.0.1', () => console.log(`mock-llm listening on 127.0.0.1:${PORT}`))
