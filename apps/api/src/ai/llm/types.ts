import type { z } from 'zod'
import type { PromptDef } from '../prompts.ts'

/**
 * Provider-neutral interface of the language model that writes drafts and answers (slices V3 and V4). The clinical code depends only on this:
 * a local open-weight model (llama.cpp, `local.ts`) is the default; a hosted one (`anthropic.ts`) exists only behind the egress policy; `none`
 * means there is no model and every feature says so. Nothing here falls back from one to another.
 */

export interface ReasoningModelInfo {
  id: string
  runtime: string | null
  /** SHA-256 of the weights file, known only when the running model is the pinned one (services/llm/models.lock.json). */
  weightsSha256: string | null
  local: boolean
}

export interface ReasoningHealth {
  state: 'ready' | 'loading' | 'unavailable'
  reason: string | null
  model: ReasoningModelInfo | null
}

export interface StructuredRequest<T extends z.ZodType> {
  /** The system text, its id and its schema version (registered, hashed and stored with every run). */
  prompt: PromptDef
  /** The user message: the sources and the task, rendered by the caller. */
  user: string
  /** The shape the answer must have. The local runtime is constrained to its JSON Schema, and the answer is validated against it again here. */
  schema: T
  schemaName: string
  maxOutputTokens: number
  /** Aborts the call (a doctor cancelled, or the server is closing). */
  signal?: AbortSignal | undefined
  /**
   * Told how far the model has got while it writes, at most every half second (a client that can stream asks for the answer as a stream for this; the
   * answer is the same either way). Null means no more can be said: the stream could not be read and the answer is being asked for again without one.
   */
  onProgress?: ((p: GenerationProgress | null) => void) | undefined
}

export interface GenerationProgress {
  /** What the model has written so far, counted as the server sends it: one per streamed piece, or the server's own count when it gives one. 0 while it reads the input. */
  generatedTokens: number
}

export interface StructuredResult<T> {
  output: T
  /** The model that answered (the id the server reports), which may differ from the configured name. */
  model: string
  runtime: string | null
  weightsSha256: string | null
  inputTokens: number | null
  outputTokens: number | null
  finishReason: string | null
  requestId: string | null
}

export interface ReasoningModel {
  /** 'llama.cpp' for the local runtime, 'anthropic' for the hosted one. */
  readonly provider: string
  /** The configured model name (what the server reports once it has answered). */
  readonly model: string
  readonly local: boolean
  /** Asks the model server whether it can answer right now. Cached for a few seconds unless `fresh` says to ask again. Never a guess from configuration alone. */
  health(opts?: { fresh?: boolean }): Promise<ReasoningHealth>
  generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>>
}
