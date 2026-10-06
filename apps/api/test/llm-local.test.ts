import http from 'node:http'
import type net from 'node:net'
import { z } from 'zod'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LocalLlmClient, llmUrlProblem } from '../src/ai/llm/local.ts'
import { AiProviderError } from '../src/ai/providers.ts'
import type { PromptDef } from '../src/ai/prompts.ts'
import { closedPort } from './helpers.ts'

// The local language model client: what it sends to llama-server (the secret, the schema the answer must have, nothing else), what it makes of
// every kind of reply, and the failures it turns into words a doctor can act on. A loopback stand-in for the server records what it was sent.
// The secret here is a placeholder for the test, not a credential.

const SECRET = 'test-local-llm-secret-placeholder'
const PINNED = { alias: 'qwen3.5-4b-q4_k_m', weightsSha256: 'c'.repeat(64), runtime: 'llama.cpp b11379' }
const PROMPT: PromptDef = { id: 'test-prompt-v1', kind: 'consultation_draft', schemaVersion: 'test-schema-v1', text: 'You are a test.' }
const Out = z.object({ items: z.array(z.object({ text: z.string(), refs: z.array(z.string()) })).max(3) })

interface Seen {
  method: string
  url: string
  auth: string | undefined
  body: Record<string, unknown> | null
}
let server: http.Server
let url: string
let seen: Seen[] = []
/** The next replies, by path. */
let reply: { status: number; body: unknown; headers?: Record<string, string>; delayMs?: number; raw?: string; stream?: { chunks: number; size: number }; sse?: Sse }
/**
 * A streamed answer, as llama-server sends one when asked for a stream: a first piece with the role, one piece per token, a last piece that says why it
 * stopped (with its own counts), then [DONE]. `broken` sends a piece that is not JSON; `cut` stops before the last piece; `error` sends an error piece.
 * Asked without a stream, the same server answers whole with the same text.
 */
interface Sse {
  pieces: string[]
  finish?: string
  everyMs?: number
  broken?: boolean
  cut?: boolean
  error?: boolean
  /** Answers a stream request with a whole answer (a server that does not stream). */
  ignoreStream?: boolean
}
let healthReply: { status: number; body: unknown }
let modelsReply: { status: number; body: unknown }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: text ? (JSON.parse(text) as Record<string, unknown>) : null })
      const send = (status: number, body: unknown, headers: Record<string, string> = {}, raw?: string) => {
        const payload = raw ?? JSON.stringify(body)
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(payload)
      }
      if (req.url === '/health') return send(healthReply.status, healthReply.body)
      if (req.url === '/v1/models') return send(modelsReply.status, modelsReply.body)
      if (req.url === '/v1/chat/completions') {
        const r = reply
        if (r.sse) {
          const s = r.sse
          const whole = s.pieces.join('')
          const usage = { prompt_tokens: 120, completion_tokens: s.pieces.length }
          if (!seen.at(-1)!.body!.stream || s.ignoreStream) return send(200, { id: 'cmpl-2', model: PINNED.alias, choices: [{ index: 0, finish_reason: s.finish ?? 'stop', message: { role: 'assistant', content: whole } }], usage })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const piece = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
          const base = { id: 'cmpl-2', model: PINNED.alias, object: 'chat.completion.chunk' }
          const out: string[] = [piece({ ...base, choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: null } }] })]
          s.pieces.forEach((p, n) => out.push(n === 1 && s.broken ? 'data: {not json\n\n' : n === 1 && s.error ? piece({ error: { code: 500, message: 'server detail' } }) : piece({ ...base, choices: [{ index: 0, finish_reason: null, delta: { content: p } }] })))
          if (!s.cut) out.push(piece({ ...base, choices: [{ index: 0, finish_reason: s.finish ?? 'stop', delta: {} }], timings: { cache_n: 20, prompt_n: 100, predicted_n: s.pieces.length } }), 'data: [DONE]\n\n')
          let i = 0
          const next = () => {
            if (i >= out.length || res.destroyed) return res.end()
            // Split one piece across two writes, as a network may: the client must put lines back together.
            const p = out[i++]!
            res.write(p.slice(0, 7))
            res.write(p.slice(7), () => setTimeout(next, s.everyMs ?? 0))
          }
          return next()
        }
        // A reply of unknown length, sent in pieces: the client must stop reading it at its cap.
        if (r.stream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          const piece = Buffer.alloc(r.stream.size, 'x')
          let sent = 0
          const next = () => {
            if (sent >= r.stream!.chunks || res.destroyed) return res.end()
            sent++
            res.write(piece, () => setImmediate(next))
          }
          return next()
        }
        if (r.delayMs) return void setTimeout(() => send(r.status, r.body, r.headers, r.raw), r.delayMs)
        return send(r.status, r.body, r.headers, r.raw)
      }
      send(404, { error: 'not found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})
beforeEach(() => {
  seen = []
  healthReply = { status: 200, body: { status: 'ok' } }
  modelsReply = { status: 200, body: { object: 'list', data: [{ id: PINNED.alias }] } }
  reply = completion({ items: [{ text: 'Fever.', refs: ['R1'] }] })
})

const completion = (content: unknown, over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { id: 'cmpl-1', model: PINNED.alias, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 120, completion_tokens: 40 }, ...over },
})
const client = (over: Partial<ConstructorParameters<typeof LocalLlmClient>[0]> = {}) => new LocalLlmClient({ url, apiKey: SECRET, timeoutMs: 5000, pinned: PINNED, ...over })
const ask = (c: LocalLlmClient, signal?: AbortSignal) => c.generate({ prompt: PROMPT, user: 'SOURCES\n[R1] 2026-10-04 | Reason | recorded | record: Fever', schema: Out, schemaName: 'test_draft', maxOutputTokens: 500, signal })
const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as AiProviderError
  }
  throw new Error('expected a failure')
}

describe('where it may talk to', () => {
  it('is a loopback address, unless the operator says otherwise on purpose, and never carries credentials in the address', () => {
    expect(llmUrlProblem('http://127.0.0.1:8081', false)).toBeNull()
    expect(llmUrlProblem('http://localhost:8081', false)).toBeNull()
    expect(llmUrlProblem('http://[::1]:8081', false)).toBeNull()
    expect(llmUrlProblem('http://192.168.1.20:8081', false)).toMatch(/must point at this machine/)
    expect(llmUrlProblem('https://api.example.com', false)).toMatch(/must point at this machine/)
    expect(llmUrlProblem('http://192.168.1.20:8081', true)).toBeNull()
    expect(llmUrlProblem('http://user:pw@127.0.0.1:8081', false)).toMatch(/credentials/)
    expect(llmUrlProblem('not a url', false)).toMatch(/not a valid URL/)
    expect(llmUrlProblem('ftp://127.0.0.1', false)).toMatch(/http or https/)
    expect(() => new LocalLlmClient({ url: 'http://203.0.113.9:8081', apiKey: SECRET, timeoutMs: 1000 })).toThrow(/must point at this machine/)
  })
})

describe('health, as the server says it just now', () => {
  it('ready only when the server is up AND accepts this application’s secret; the weights hash is reported only for the pinned model', async () => {
    const h = await client().health()
    expect(h).toEqual({ state: 'ready', reason: null, model: { id: PINNED.alias, runtime: PINNED.runtime, weightsSha256: PINNED.weightsSha256, local: true } })
    expect(seen.find((s) => s.url === '/v1/models')!.auth).toBe(`Bearer ${SECRET}`)
    // A different model under another name: no hash is claimed for it.
    modelsReply = { status: 200, body: { object: 'list', data: [{ id: 'some-other-model' }] } }
    expect((await client().health()).model).toMatchObject({ id: 'some-other-model', weightsSha256: null })
  })

  it('loading, refused, wrong secret, or an answer that is not a model list are each said in words, and none is "ready"', async () => {
    healthReply = { status: 503, body: { error: { code: 503, message: 'Loading model' } } }
    expect(await client().health()).toMatchObject({ state: 'loading', reason: expect.stringMatching(/still loading/) })
    healthReply = { status: 200, body: { status: 'ok' } }
    modelsReply = { status: 401, body: { error: { message: 'Invalid API Key' } } }
    const wrong = await client().health()
    expect(wrong.state).toBe('unavailable')
    expect(wrong.reason).toMatch(/did not accept this application’s secret/)
    expect(wrong.reason).not.toContain(SECRET)
    modelsReply = { status: 200, body: { nonsense: true } }
    expect((await client().health()).reason).toMatch(/not as expected/)
    const down = await new LocalLlmClient({ url: `http://127.0.0.1:${await closedPort()}`, apiKey: SECRET, timeoutMs: 1000 }).health()
    expect(down).toEqual({ state: 'unavailable', reason: 'Local AI unavailable.', model: null })
  })

  it('is cached for a few seconds so a polling screen does not hammer the server', async () => {
    const c = client()
    await c.health()
    const n = seen.length
    await c.health()
    expect(seen.length).toBe(n)
  })
})

describe('a request', () => {
  it('carries the secret, the system and user text, the schema the answer must have, temperature 0 and no thinking, and nothing else', async () => {
    const r = await ask(client())
    expect(r.output).toEqual({ items: [{ text: 'Fever.', refs: ['R1'] }] })
    expect(r).toMatchObject({ model: PINNED.alias, runtime: PINNED.runtime, weightsSha256: PINNED.weightsSha256, inputTokens: 120, outputTokens: 40, finishReason: 'stop', requestId: 'cmpl-1' })
    const s = seen.find((x) => x.url === '/v1/chat/completions')!
    expect(s.method).toBe('POST')
    expect(s.auth).toBe(`Bearer ${SECRET}`)
    expect(s.body).toMatchObject({ temperature: 0, max_tokens: 500, stream: false })
    expect((s.body!.messages as { role: string; content: string }[]).map((m) => m.role)).toEqual(['system', 'user'])
    expect((s.body!.messages as { content: string }[])[0]!.content).toBe('You are a test.')
    const rf = s.body!.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: { type: string; properties: { items: { maxItems: number } } } } }
    expect(rf.type).toBe('json_schema')
    expect(rf.json_schema).toMatchObject({ name: 'test_draft', strict: true, schema: { type: 'object', properties: { items: { maxItems: 3 } } } })
    // No field that would let a request widen what the server does.
    expect(Object.keys(s.body!).sort()).toEqual(['max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature'])
  })

  it('does not trust the shape of the answer: an answer that does not fit the schema is refused (retryable) without echoing it', async () => {
    reply = completion({ items: [{ text: 'Too many', refs: [] }, { text: 'a', refs: [] }, { text: 'b', refs: [] }, { text: 'c', refs: [] }] })
    const e1 = await failure(ask(client()))
    expect(e1).toMatchObject({ code: 'invalid_output', retryable: true })
    expect(e1.message).not.toMatch(/Too many/)
    reply = completion('this is not json at all')
    expect(await failure(ask(client()))).toMatchObject({ code: 'invalid_output' })
    reply = completion('')
    expect(await failure(ask(client()))).toMatchObject({ code: 'invalid_output' })
    reply = { status: 200, body: { choices: [] } }
    expect(await failure(ask(client()))).toMatchObject({ code: 'invalid_output' })
    reply = { status: 200, body: null, raw: 'not json' }
    expect(await failure(ask(client()))).toMatchObject({ code: 'invalid_output' })
  })

  it('an answer cut off for length is refused as truncated, never used', async () => {
    reply = completion({ items: [] }, { choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{"items":[' } }] })
    expect(await failure(ask(client()))).toMatchObject({ code: 'truncated', retryable: true })
  })

  it('every kind of server answer is a failure in words: the wrong secret, loading, busy, a request it cannot use, an error', async () => {
    for (const [status, code, retryable] of [
      [401, 'unauthorized', false],
      [403, 'unauthorized', false],
      [503, 'loading', true],
      [429, 'busy', true],
      [400, 'bad_request', false],
      [422, 'bad_request', false],
      [500, 'api_500', true],
      [404, 'api_404', false],
    ] as const) {
      reply = { status, body: { error: { message: `server detail ${SECRET} with the patient’s words` } } }
      const e = await failure(ask(client()))
      expect(e, String(status)).toMatchObject({ code, retryable })
      // What the server said is never passed on, and the secret never appears in an error.
      expect(e.message).not.toMatch(/server detail|patient’s words/)
      expect(e.message).not.toContain(SECRET)
    }
  })

  it('refuses a reply that tries to send it somewhere else, and an enormous one', async () => {
    const other = http.createServer((_req, res) => {
      hits++
      res.end('{}')
    })
    let hits = 0
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    try {
      reply = { status: 302, body: {}, headers: { location: `http://127.0.0.1:${(other.address() as net.AddressInfo).port}/steal` } }
      expect(await failure(ask(client()))).toMatchObject({ code: 'unavailable' })
      expect(hits).toBe(0)
    } finally {
      await new Promise<void>((r) => other.close(() => r()))
    }
    // One that says how long it is, and that is too long: refused before it is read.
    reply = { status: 200, body: {}, headers: { 'content-length': String(9 * 1024 * 1024) }, raw: 'x'.repeat(9 * 1024 * 1024) }
    expect(await failure(ask(client()))).toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/far more than expected/) })
    // One that does not say, and just goes on: read only up to the cap, then refused.
    reply = { status: 200, body: {}, stream: { chunks: 12, size: 1024 * 1024 } }
    expect(await failure(ask(client()))).toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/far more than expected/) })
  })

  it('is "local" only when its address is on this computer: a server an operator allowed elsewhere is not called local', () => {
    expect(client().local).toBe(true)
    expect(new LocalLlmClient({ url: 'http://10.1.2.3:8081', apiKey: SECRET, timeoutMs: 1000, allowNonLoopback: true }).local).toBe(false)
    expect(new LocalLlmClient({ url: 'http://[::1]:8081', apiKey: SECRET, timeoutMs: 1000 }).local).toBe(true)
  })

  it('stops after the time it was given, and when asked to; each is said in words', async () => {
    reply = { ...completion({ items: [] }), delayMs: 1500 }
    const slow = await failure(ask(client({ timeoutMs: 200 })))
    expect(slow).toMatchObject({ code: 'timeout', retryable: true })
    expect(slow.message).toMatch(/took longer than/)
    const ac = new AbortController()
    const p = failure(ask(client({ timeoutMs: 5000 }), ac.signal))
    setTimeout(() => ac.abort(), 150)
    expect(await p).toMatchObject({ code: 'cancelled', retryable: false })
  })

  it('a server that is not running is "Local AI unavailable.", retryable', async () => {
    const c = new LocalLlmClient({ url: `http://127.0.0.1:${await closedPort()}`, apiKey: SECRET, timeoutMs: 1000 })
    const e = await failure(ask(c))
    expect(e).toMatchObject({ code: 'unavailable', message: 'Local AI unavailable.', retryable: true })
  })
})

// Streaming (HERO §1): asked with `onProgress`, the client asks for a stream to say how far the model has got. The answer must be the one the server would
// have sent whole (verified against the real llama-server too; see the integrator notes), and anything about the stream that cannot be read is not guessed at.
describe('a request that reports progress', () => {
  const answer = { items: [{ text: 'Fever for three days.', refs: ['R1'] }] }
  const piecesOf = (s: string, size = 3) => Array.from({ length: Math.ceil(s.length / size) }, (_, n) => s.slice(n * size, n * size + size))
  /** A request with `onProgress`: each value it is told (null when progress is withdrawn), and when, in milliseconds since the request, if `at` is given. */
  const streamed = (c: LocalLlmClient, got: (number | null)[], signal?: AbortSignal, at?: number[]) => {
    const t0 = Date.now()
    return c.generate({
      prompt: PROMPT,
      user: 'SOURCES\n[R1] 2026-10-04 | Reason | recorded | record: Fever',
      schema: Out,
      schemaName: 'test_draft',
      maxOutputTokens: 500,
      signal,
      onProgress: (p) => {
        at?.push(Date.now() - t0)
        got.push(p ? p.generatedTokens : null)
      },
    })
  }

  it('asks for a stream with the request otherwise unchanged, puts the text together in order, and counts what the model wrote', async () => {
    const text = JSON.stringify(answer)
    reply = { status: 200, body: null, sse: { pieces: piecesOf(text) } }
    const got: (number | null)[] = []
    const r = await streamed(client(), got)
    expect(r.output).toEqual(answer)
    // The server's own counts, from its last piece: what it read (cached and new) and what it wrote.
    expect(r).toMatchObject({ inputTokens: 120, outputTokens: piecesOf(text).length, finishReason: 'stop', requestId: 'cmpl-2', model: PINNED.alias })
    expect(got[0]).toBe(0)
    expect(got.at(-1)).toBe(piecesOf(text).length)
    const s = seenRequests()
    expect(s).toHaveLength(1)
    expect(s[0]!.body).toMatchObject({ temperature: 0, max_tokens: 500, stream: true })
    expect(Object.keys(s[0]!.body!).sort()).toEqual(['max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature'])
  })

  it('passes progress on at most every half second while the model writes, each value at least the one before', async () => {
    reply = { status: 200, body: null, sse: { pieces: piecesOf(JSON.stringify(answer), 1), everyMs: 30 } }
    const got: (number | null)[] = []
    const at: number[] = []
    await streamed(client(), got, undefined, at)
    // The first (0, the stream is open) and the last (the final count) are always said; between them, no two closer than 500 ms.
    const between = at.slice(1, -1)
    for (let n = 1; n < between.length; n++) expect(between[n]! - between[n - 1]!).toBeGreaterThanOrEqual(495)
    expect(got.length).toBeGreaterThanOrEqual(3)
    expect([...got].sort((a, b) => a! - b!)).toEqual(got)
  })

  it('a server that answers a stream request whole is read as a whole answer, once', async () => {
    reply = { status: 200, body: null, sse: { pieces: piecesOf(JSON.stringify(answer)), ignoreStream: true } }
    const got: (number | null)[] = []
    expect((await streamed(client(), got)).output).toEqual(answer)
    expect(seenRequests()).toHaveLength(1)
    expect(got).toEqual([])
  })

  it('a stream that cannot be read is not guessed at: the same request is made again without a stream, and progress is withdrawn', async () => {
    for (const broken of [{ broken: true }, { cut: true }]) {
      seen = []
      reply = { status: 200, body: null, sse: { pieces: piecesOf(JSON.stringify(answer)), ...broken } }
      const got: (number | null)[] = []
      expect((await streamed(client(), got)).output).toEqual(answer)
      const s = seenRequests()
      expect(s.map((x) => x.body!.stream)).toEqual([true, false])
      // Apart from asking for a stream, the second request is the first.
      expect({ ...s[1]!.body, stream: true }).toEqual(s[0]!.body)
      expect(got.at(-1)).toBeNull()
    }
  })

  it('an error the server sends inside the stream is a failure in words, never its own words; a draft cut off for length is refused', async () => {
    reply = { status: 200, body: null, sse: { pieces: piecesOf(JSON.stringify(answer)), error: true } }
    const e = await failure(streamed(client(), []))
    expect(e).toMatchObject({ code: 'api_stream', retryable: true })
    expect(e.message).not.toMatch(/server detail/)
    reply = { status: 200, body: null, sse: { pieces: piecesOf('{"items":['), finish: 'length' } }
    expect(await failure(streamed(client(), []))).toMatchObject({ code: 'truncated' })
  })

  it('stops when asked to, and after the time it was given, in the middle of a stream', async () => {
    reply = { status: 200, body: null, sse: { pieces: piecesOf(JSON.stringify(answer), 1), everyMs: 50 } }
    const ac = new AbortController()
    const p = failure(streamed(client({ timeoutMs: 10_000 }), [], ac.signal))
    setTimeout(() => ac.abort(), 200)
    expect(await p).toMatchObject({ code: 'cancelled', retryable: false })
    expect(await failure(streamed(client({ timeoutMs: 300 }), []))).toMatchObject({ code: 'timeout', retryable: true })
  })
})

const seenRequests = () => seen.filter((s) => s.url === '/v1/chat/completions')
