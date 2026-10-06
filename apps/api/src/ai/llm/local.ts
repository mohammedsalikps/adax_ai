import { z } from 'zod'
import { AiProviderError } from '../providers.ts'
import type { GenerationProgress, ReasoningHealth, ReasoningModel, StructuredRequest, StructuredResult } from './types.ts'

/**
 * The local language model: llama.cpp's `llama-server` on this computer (scripts/llm.mjs starts it with a per-install secret, loopback only, no web
 * page, no slot endpoint, no network access of its own). This is the default reasoning provider. The patient context goes to a loopback address
 * and nowhere else; the response is validated, not trusted; nothing falls back to a hosted model.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Whether `url` points at this machine (or the operator said, with LLM_ALLOW_NON_LOOPBACK, that another host is theirs). */
export function llmUrlProblem(url: string, allowNonLoopback: boolean): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'LLM_URL is not a valid URL.'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'LLM_URL must be an http or https address.'
  if (u.username || u.password) return 'LLM_URL must not contain credentials.'
  if (!allowNonLoopback && !LOOPBACK.has(u.hostname)) return 'LLM_URL must point at this machine (127.0.0.1). Patient records are not sent to another host unless LLM_ALLOW_NON_LOOPBACK=true is set on purpose.'
  return null
}

/** Whether `url` is on this computer. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Reads a reply up to `max` bytes; null if it is longer (the rest is not read). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) {
    const whole = await res.text()
    return whole.length > max ? null : whole
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

const HEALTH_TTL_MS = 4000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** Progress is passed on at most this often while the model writes. */
const PROGRESS_EVERY_MS = 500

const ModelsResponse = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200) })).min(1) })
const Usage = z.object({ prompt_tokens: z.number().nullable().optional(), completion_tokens: z.number().nullable().optional() }).nullable().optional()
const Completion = z.object({
  id: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string().nullable().optional() }) })).min(1),
  usage: Usage,
})
/** One piece of a streamed answer (OpenAI-style server-sent events): the text written since the last piece, and at the end why it stopped. */
const StreamChunk = z.object({
  id: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  choices: z
    .array(z.object({ finish_reason: z.string().nullable().optional(), delta: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional() }).partial().nullable().optional() }))
    .optional(),
  usage: Usage,
  /** llama-server's own counts, on the last piece: tokens read from its cache, read now, and written (the whole answer's `usage` holds the same). */
  timings: z.object({ cache_n: z.number(), prompt_n: z.number(), predicted_n: z.number() }).partial().nullable().optional(),
  error: z.unknown().optional(),
})

/** What a reply said, whether it came whole or as a stream. */
interface Reply {
  id: string | null
  model: string | null
  content: string | null
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
}

/** The stream could not be read as one (not server-sent events, a piece that is not JSON, or it stopped before saying it was done). */
class StreamUnreadable extends Error {}

export interface LocalLlmConfig {
  url: string
  /** The per-install secret the server was started with (scripts/llm.mjs); sent as a bearer token. */
  apiKey: string | null
  allowNonLoopback?: boolean
  /** Longest a single answer may take, in milliseconds. */
  timeoutMs: number
  /** The pinned model (services/llm/*.lock.json): the weights hash is reported only when the server says it is running this one. */
  pinned?: { alias: string; weightsSha256: string; runtime: string } | null
  /** For tests: a stand-in for `fetch`. Never used in production. */
  fetch?: typeof fetch
}

export class LocalLlmClient implements ReasoningModel {
  readonly provider = 'llama.cpp'
  /** Measured from the address, not assumed: a server an operator allowed on another computer is not "local". */
  readonly local: boolean
  model: string
  private readonly url: string
  private cached: { at: number; value: ReasoningHealth } | null = null
  private readonly doFetch: typeof fetch

  constructor(private readonly cfg: LocalLlmConfig) {
    const problem = llmUrlProblem(cfg.url, cfg.allowNonLoopback ?? false)
    if (problem) throw new Error(problem)
    this.url = cfg.url.replace(/\/+$/, '')
    this.local = isLoopbackUrl(cfg.url)
    this.doFetch = cfg.fetch ?? fetch
    this.model = cfg.pinned?.alias ?? 'local model'
  }

  private headers(json = false): Record<string, string> {
    return { ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }
  }

  private info(id: string) {
    const pinned = this.cfg.pinned
    const same = !!pinned && pinned.alias === id
    // The weights hash is the pinned one when the server reports the pinned name: it is attributed by that name, the file itself is not measured here.
    return { id, runtime: pinned?.runtime ?? null, weightsSha256: same ? pinned!.weightsSha256 : null, local: this.local }
  }

  /** Asks the server whether it can answer right now. Cached for a few seconds so a polling screen does not hammer it. */
  async health(opts: { fresh?: boolean } = {}): Promise<ReasoningHealth> {
    if (!opts.fresh && this.cached && Date.now() - this.cached.at < HEALTH_TTL_MS) return this.cached.value
    let value: ReasoningHealth
    try {
      const res = await this.doFetch(`${this.url}/health`, { redirect: 'error', signal: AbortSignal.timeout(2500) })
      if (res.status === 503) value = { state: 'loading', reason: 'Local AI is still loading its model. Try again in a moment.', model: null }
      else if (!res.ok) value = { state: 'unavailable', reason: 'Local AI unavailable.', model: null }
      else {
        // The server is up. The secret is checked with a cheap call that needs it, so "up but would refuse us" is told apart from "ready".
        const models = await this.doFetch(`${this.url}/v1/models`, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(2500) })
        if (models.status === 401 || models.status === 403) value = { state: 'unavailable', reason: 'Local AI unavailable: the local server did not accept this application’s secret (LLM_API_KEY). Start the server and the API with the same secret.', model: null }
        else {
          const parsed = models.ok ? ModelsResponse.safeParse(await models.json().catch(() => null)) : null
          if (!parsed?.success) value = { state: 'unavailable', reason: 'Local AI unavailable: the local server answered, but not as expected.', model: null }
          else {
            this.model = parsed.data.data[0]!.id
            value = { state: 'ready', reason: null, model: this.info(this.model) }
          }
        }
      }
    } catch {
      value = { state: 'unavailable', reason: 'Local AI unavailable.', model: null }
    }
    this.cached = { at: Date.now(), value }
    return value
  }

  /**
   * One answer, in the shape asked for. With `onProgress` the answer is asked for as a stream, so that how far the model has got can be passed on while it
   * writes: the request is otherwise the same (temperature 0, the same schema), and the text put together from the stream is the text the server would have
   * sent whole. A stream that cannot be read is not guessed at: the same request is made again without it, and no more progress is reported.
   */
  async generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    const jsonSchema = z.toJSONSchema(req.schema, { target: 'draft-7' })
    const body = (stream: boolean) => ({
      model: this.model,
      messages: [
        { role: 'system', content: req.prompt.text },
        { role: 'user', content: req.user },
      ],
      temperature: 0,
      max_tokens: req.maxOutputTokens,
      stream,
      // The runtime turns the schema into a grammar, so the answer cannot be anything but this shape (it is validated again below).
      response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: jsonSchema } },
    })
    let reply: Reply | null = null
    if (req.onProgress) {
      try {
        reply = await this.ask(req, body(true), req.onProgress)
      } catch (e) {
        if (!(e instanceof StreamUnreadable)) throw e
        req.onProgress(null)
      }
    }
    reply ??= await this.ask(req, body(false), null)
    if (reply.finishReason === 'length') throw new AiProviderError('truncated', 'The local model ran out of room before it finished the draft. Try again, or shorten the record shown to it.', true)
    if (!reply.content) throw new AiProviderError('invalid_output', 'The local model returned no answer.', true)
    let output: z.infer<T>
    try {
      output = req.schema.parse(JSON.parse(reply.content))
    } catch {
      throw new AiProviderError('invalid_output', 'The local model’s answer did not have the required form, so nothing was kept. You can try again.', true)
    }
    const id = reply.model ?? this.model
    this.model = id
    const info = this.info(id)
    return {
      output,
      model: id,
      runtime: info.runtime,
      weightsSha256: info.weightsSha256,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      finishReason: reply.finishReason,
      requestId: reply.id,
    }
  }

  private timeoutError() {
    return new AiProviderError('timeout', `The local model took longer than ${Math.round(this.cfg.timeoutMs / 1000)} seconds and was stopped (it runs on this computer). You can try again.`, true)
  }

  /** Sends one request and reads its reply: whole, or as a stream when one was asked for and the server sends one. */
  private async ask(req: StructuredRequest<z.ZodType>, body: { stream: boolean }, onProgress: ((p: GenerationProgress | null) => void) | null): Promise<Reply> {
    const signals = [AbortSignal.timeout(this.cfg.timeoutMs), ...(req.signal ? [req.signal] : [])]
    let res: Response
    try {
      // `redirect: 'error'`: a reply that tries to send the record on to another address is a failure, not a hop.
      res = await this.doFetch(`${this.url}/v1/chat/completions`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any(signals) })
    } catch (e) {
      this.cached = null
      if (req.signal?.aborted) throw new AiProviderError('cancelled', 'This draft was cancelled.', false)
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw this.timeoutError()
      throw new AiProviderError('unavailable', 'Local AI unavailable.', true)
    }
    if (res.status === 401 || res.status === 403) throw new AiProviderError('unauthorized', 'The local AI server did not accept this application’s secret (LLM_API_KEY). Start the server and the API with the same secret.', false)
    if (res.status === 503) throw new AiProviderError('loading', 'Local AI is still loading its model. Try again in a moment.', true)
    if (res.status === 429) throw new AiProviderError('busy', 'The local model is busy. Try again in a moment.', true)
    if (res.status === 400 || res.status === 422) throw new AiProviderError('bad_request', 'The local AI server could not use the request (it may be too long for the model’s context).', false)
    if (!res.ok) throw new AiProviderError(`api_${res.status}`, 'The local AI server returned an error.', res.status >= 500)
    // A server that answered a stream request with a whole answer is read as a whole answer (nothing is lost but the progress).
    if (onProgress && body.stream && /^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) return this.readStream(req, res, onProgress)
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_RESPONSE_BYTES) throw new AiProviderError('invalid_output', 'The local AI server answered with far more than expected.', true)
    let text: string | null
    try {
      text = await readCapped(res, MAX_RESPONSE_BYTES)
    } catch {
      if (req.signal?.aborted) throw new AiProviderError('cancelled', 'This draft was cancelled.', false)
      throw this.timeoutError()
    }
    if (text === null) throw new AiProviderError('invalid_output', 'The local AI server answered with far more than expected.', true)
    let envelope: z.infer<typeof Completion>
    try {
      envelope = Completion.parse(JSON.parse(text))
    } catch {
      throw new AiProviderError('invalid_output', 'The local AI server answered in a form that could not be read.', true)
    }
    const choice = envelope.choices[0]!
    return { id: envelope.id ?? null, model: envelope.model ?? null, content: choice.message.content ?? null, finishReason: choice.finish_reason ?? null, inputTokens: envelope.usage?.prompt_tokens ?? null, outputTokens: envelope.usage?.completion_tokens ?? null }
  }

  /**
   * Reads a streamed answer (server-sent events, one JSON piece per `data:` line, `[DONE]` at the end), puts its text together in order, and passes on how
   * many pieces the model has written: one per piece that carries text, or the server's own count when a piece gives one. Capped like a whole answer.
   */
  private async readStream(req: StructuredRequest<z.ZodType>, res: Response, onProgress: (p: GenerationProgress) => void): Promise<Reply> {
    if (!res.body) throw new StreamUnreadable('no body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parts: string[] = []
    const out: Reply = { id: null, model: null, content: null, finishReason: null, inputTokens: null, outputTokens: null }
    let size = 0
    let pending = ''
    let tokens = 0
    let reported = Date.now()
    let done = false
    onProgress({ generatedTokens: 0 })
    const line = (raw: string) => {
      const l = raw.replace(/\r$/, '')
      if (!l.startsWith('data:')) return
      const data = l.slice(5).trim()
      if (data === '[DONE]') {
        done = true
        return
      }
      let chunk: z.infer<typeof StreamChunk>
      try {
        chunk = StreamChunk.parse(JSON.parse(data))
      } catch {
        throw new StreamUnreadable('a piece that is not JSON')
      }
      // The server reports an error inside the stream: it failed, as a whole answer with an error status would have.
      if (chunk.error !== undefined) throw new AiProviderError('api_stream', 'The local AI server returned an error.', true)
      out.id ??= chunk.id ?? null
      out.model ??= chunk.model ?? null
      const choice = chunk.choices?.[0]
      const text = choice?.delta?.content
      if (typeof text === 'string' && text.length) parts.push(text)
      if ((typeof text === 'string' && text.length) || choice?.delta?.reasoning_content) tokens++
      if (choice?.finish_reason) out.finishReason = choice.finish_reason
      if (chunk.usage) {
        out.inputTokens = chunk.usage.prompt_tokens ?? out.inputTokens
        out.outputTokens = chunk.usage.completion_tokens ?? out.outputTokens
      } else if (chunk.timings) {
        const t = chunk.timings
        if (typeof t.prompt_n === 'number') out.inputTokens = t.prompt_n + (t.cache_n ?? 0)
        if (typeof t.predicted_n === 'number') out.outputTokens = t.predicted_n
      }
      if (typeof out.outputTokens === 'number') tokens = out.outputTokens
      if (Date.now() - reported >= PROGRESS_EVERY_MS) {
        reported = Date.now()
        onProgress({ generatedTokens: tokens })
      }
    }
    try {
      while (!done) {
        const { done: ended, value } = await reader.read()
        if (ended) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) throw new AiProviderError('invalid_output', 'The local AI server answered with far more than expected.', true)
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const l of lines) {
          line(l)
          if (done) break
        }
      }
      if (!done && pending) line(pending)
    } catch (e) {
      await reader.cancel().catch(() => undefined)
      if (e instanceof AiProviderError || e instanceof StreamUnreadable) throw e
      if (req.signal?.aborted) throw new AiProviderError('cancelled', 'This draft was cancelled.', false)
      throw this.timeoutError()
    }
    if (done) await reader.cancel().catch(() => undefined)
    // A stream that stopped before it said why the model stopped is not a whole answer.
    if (!out.finishReason) throw new StreamUnreadable('the stream ended early')
    out.content = parts.join('')
    onProgress({ generatedTokens: tokens })
    return out
  }
}
