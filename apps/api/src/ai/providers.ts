import fs from 'node:fs'
import path from 'node:path'
import type { AiSection, AiStatus, SpeechStatus, TranscriptSegment, VitalKind } from '@adaxai/contracts'
import { type Config, REPO_ROOT } from '../config.ts'
import type { AppSettings } from '../settings/schema.ts'
import { createAnthropicProviders } from './anthropic.ts'
import { RuleFactExtractor } from './extract/rules.ts'
import { LocalLlmClient, llmUrlProblem } from './llm/local.ts'
import { reasoningStatus } from './llm/status.ts'
import type { ReasoningModel } from './llm/types.ts'
import { LocalSpeechTranscriber, speechUrlProblem } from './stt.ts'

/**
 * Provider-neutral interfaces. The clinical application depends only on
 * these; adapters (anthropic.ts, stt.ts, or an HTTP client to a self-hosted
 * Python model service) implement them. Swapping a provider never touches
 * routes, storage or review logic.
 */

export interface CallMeta {
  /** Model that actually answered (may differ from the requested one after a server-side fallback). */
  model: string
  inputTokens: number | null
  outputTokens: number | null
  requestId: string | null
}

export interface DraftItemOut {
  section: AiSection
  text: string
  sourceSegmentIds: string[]
}
export interface NoteDraftResult extends CallMeta {
  items: DraftItemOut[]
}

/** Turns transcript segments into suggested note passages, each citing segment ids. */
export interface NoteDrafter {
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
  draft(segments: TranscriptSegment[]): Promise<NoteDraftResult>
}

export interface ExtractedFact {
  category: string
  text: string
  attribution: 'patient_reported' | 'clinician_stated' | 'other_speaker'
  certainty: 'stated' | 'uncertain'
  uncertaintyReason: string | null
  negated: boolean
  details: { substance: string | null; medication: string | null; dose: string | null; duration: string | null; vitalKind: VitalKind | null; value: number | null; unit: string | null }
  sourceSegmentIds: string[]
}
export interface FactExtractor {
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
  /** True when it runs in this process (rules) and nothing leaves the machine. */
  readonly local?: boolean
  /** Languages it is built for; text in another language is not attempted. */
  readonly languages?: string[]
  extract(segments: TranscriptSegment[]): Promise<CallMeta & { facts: ExtractedFact[] }>
}

export interface RecommendationOut {
  kind: string
  urgency: 'routine' | 'attention'
  text: string
  rationale: string
  supportingRefs: string[]
  conflicts: { text: string; refs: string[] }[]
  missingInformation: string[]
}
export interface RecommendationInput {
  patientLine: string
  recordText: string
  transcriptText: string
}
export interface Recommender {
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
  recommend(input: RecommendationInput): Promise<CallMeta & { recommendations: RecommendationOut[]; insufficientData: boolean; insufficientDataReason: string | null }>
}

export interface ImageDescription {
  quality: 'adequate' | 'limited' | 'inadequate'
  qualityReason: string
  observations: { text: string; location: string; confidence: 'low' | 'medium' | 'high' }[]
  limitations: string[]
  summary: string
}
export interface ImageDescriber {
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
  describe(image: Buffer, mimeType: string, context: { imageType: string; bodySite: string | null }): Promise<CallMeta & { result: ImageDescription }>
}

/** One cited statement in a Mana AI summary (refs are record item references such as M1). */
export interface CitedText {
  text: string
  refs: string[]
}
export interface RecordQuestionInput {
  /** Age band and sex only. */
  patientLine: string
  /** Record items, one per line: [ref] date · field · status: excerpt */
  recordText: string
  question: string
}
/** Answers a doctor's question from the given record items only (Mana AI). */
export interface RecordQuestionAnswerer {
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
  answer(input: RecordQuestionInput): Promise<CallMeta & { statements: CitedText[]; conflicts: CitedText[]; notFound: string[] }>
}

/** One transcribed line as the speech model gave it, on the timeline of the audio it was given. */
export interface SpeechSegment {
  startMs: number
  endMs: number
  text: string
  /** Mean token probability the model gave its own words; null when the model reported none. A model score, not a calibrated chance of being right. */
  confidence: number | null
  avgLogprob: number | null
  noSpeechProb: number | null
}
export interface SpeechModel {
  id: string
  runtime: string
  computeType: string | null
  /** SHA-256 of the weights file, so a transcript can be tied to the exact model. */
  weightsSha256: string | null
  local: true
}
export interface SpeechResult {
  segments: SpeechSegment[]
  /** The language the model detected (or was told), a code such as "en". */
  language: string | null
  languageProbability: number | null
  languageSource: 'detected' | 'hint'
  /** Length of the audio as the service decoded it. */
  durationMs: number
  model: SpeechModel
  /** The service has no diariser: who spoke is never inferred. */
  speakers: 'not_identified'
}
export interface SpeechHealth {
  state: 'ready' | 'loading' | 'unavailable'
  reason: string | null
  model: { id: string; runtime: string | null; weightsSha256: string | null } | null
}
/** Speech-to-text by a service the operator runs. There is no hosted implementation and none may be added behind this interface by default. */
export interface Transcriber {
  readonly provider: string
  readonly model: string
  /** True when the service is on this machine (a loopback address); false only if the operator pointed it at another host on purpose. */
  readonly local: boolean
  /** host:port of the service (shown only when it is not on this machine). */
  readonly host?: string
  transcribe(audio: Buffer, mimeType: string, filename: string, opts?: { language?: string | null }): Promise<SpeechResult>
  health(): Promise<SpeechHealth>
}

/** A provider failure that is safe to show (no provider internals, no patient data). */
export class AiProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

export type AiFeatures = AppSettings['ai']['features']
export const ALL_FEATURES: AiFeatures = { noteDraft: true, extraction: true, recommendations: true, imageAnalysis: true, liveTranscription: true, patientQa: true, consultationDraft: true }

export interface AiProviders {
  drafter: NoteDrafter | null
  transcriber: Transcriber | null
  extractor?: FactExtractor | null
  recommender?: Recommender | null
  describer?: ImageDescriber | null
  qa?: RecordQuestionAnswerer | null
  /** The model that writes consultation drafts (V3) and answers (V4): local by default, hosted only behind the egress policy, or none. */
  reasoner?: ReasoningModel | null
  /** What the server is set to use for it and, when there is none, why (shown instead of any placeholder output). */
  reasoning?: { mode: 'local' | 'hosted' | 'none'; reason: string | null }
  /** Whether consultation text may go to a hosted provider, and where it would go. A key alone never allows it. */
  egress?: { hosted: boolean; destination: string | null }
  /** Why a provider is unavailable, shown to users instead of any fabricated output. */
  reasons: { llm: string | null; stt: string | null; vision?: string | null; qa?: string | null }
  features?: AiFeatures
  liveChunkSeconds?: number
}

/** Shown wherever a hosted AI step is unavailable because egress is off: the default, and not an error. */
export const EGRESS_OFF = 'Hosted AI processing is switched off on this server, so no consultation text leaves this computer. Turning it on is a server setting (ai.egress.hostedProviders in config/adaxai.yaml, or AI_EGRESS_HOSTED), not something this screen can do.'

const hostOf = (baseUrl: string | undefined): string => {
  try {
    return baseUrl ? new URL(baseUrl).host : 'api.anthropic.com'
  } catch {
    return 'api.anthropic.com'
  }
}

/** The model and runtime this repository pins (services/llm/*.lock.json), so a run can name the exact weights; null if the lock files are not there. */
export function pinnedLocalModel(): { alias: string; weightsSha256: string; runtime: string } | null {
  try {
    const model = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'services', 'llm', 'models.lock.json'), 'utf8')) as { alias: string; file: { sha256: string } }
    const runtime = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'services', 'llm', 'runtime.lock.json'), 'utf8')) as { name: string; release: string }
    return { alias: model.alias, weightsSha256: model.file.sha256, runtime: `${runtime.name} ${runtime.release}` }
  } catch {
    return null
  }
}

export function providersFromConfig(config: Config, settings: AppSettings): AiProviders {
  // `settings` already has the environment overrides applied (effectiveSettings). A hosted provider is built only when egress is allowed
  // on purpose AND a key is set: the key alone enables nothing, and nothing here falls back from a local step to a hosted one.
  const egressAllowed = settings.ai.egress.hostedProviders
  const llm = egressAllowed && config.ai.anthropicApiKey ? createAnthropicProviders(config.ai.anthropicApiKey, settings.ai.llm, settings.ai.vision) : null
  const destination = llm ? hostOf(process.env.ANTHROPIC_BASE_URL) : null
  const stt = settings.ai.stt
  let transcriber: Transcriber | null = null
  let sttReason: string | null = null
  if (stt.provider === 'local') {
    const problem = speechUrlProblem(stt.url, config.ai.speech.allowNonLoopback)
    if (problem) sttReason = `Local transcription is unavailable: ${problem}`
    else transcriber = new LocalSpeechTranscriber({ url: stt.url, allowNonLoopback: config.ai.speech.allowNonLoopback })
  } else {
    sttReason = 'Local transcription is not configured. Set SPEECH_PROVIDER=local, install the speech model (npm run speech:setup, npm run speech:model) and start the service (npm run speech:dev). Audio is never sent to a hosted service.'
  }
  const f = settings.ai.features
  const extractor: FactExtractor | null = !f.extraction ? null : settings.ai.extraction.provider === 'llm' ? (llm?.extractor ?? null) : new RuleFactExtractor()
  const off = (name: string) => `${name} is switched off in config/adaxai.yaml.`
  const noKey = 'ANTHROPIC_API_KEY is not set on this server'
  // The reason shown when no hosted provider is used: egress off (the default) is not an error, and says nothing leaves this computer.
  const noLlm = !egressAllowed ? EGRESS_OFF : `AI drafting, extraction and recommendations are not configured: ${noKey}.`
  // The reasoning model: one choice, made here from the settings, and never changed by what is or is not running (no fallback in either direction).
  const rs = settings.ai.reasoning
  let reasoner: ReasoningModel | null = null
  let reasoningReason: string | null = null
  if (!f.consultationDraft) reasoningReason = off('Consultation intelligence')
  else if (rs.provider === 'local') {
    const problem = llmUrlProblem(rs.url, config.ai.llm.allowNonLoopback)
    if (problem) reasoningReason = `Local AI unavailable: ${problem}`
    else reasoner = new LocalLlmClient({ url: rs.url, apiKey: config.ai.llm.apiKey ?? null, allowNonLoopback: config.ai.llm.allowNonLoopback, timeoutMs: rs.timeoutSeconds * 1000, pinned: pinnedLocalModel() })
  } else if (rs.provider === 'hosted') {
    reasoner = llm?.reasoner ?? null
    if (!reasoner) reasoningReason = !egressAllowed ? EGRESS_OFF : `Hosted consultation intelligence is not configured: ${noKey}.`
  } else reasoningReason = 'Local AI is switched off on this server (ai.reasoning.provider: none).'
  return {
    drafter: f.noteDraft ? (llm?.drafter ?? null) : null,
    extractor,
    recommender: f.recommendations ? (llm?.recommender ?? null) : null,
    describer: f.imageAnalysis ? (llm?.describer ?? null) : null,
    qa: f.patientQa ? (llm?.qa ?? null) : null,
    transcriber,
    reasoner,
    reasoning: { mode: rs.provider, reason: reasoningReason },
    features: f,
    liveChunkSeconds: settings.ai.stt.liveChunkSeconds,
    egress: { hosted: egressAllowed, destination },
    reasons: {
      llm: llm ? null : noLlm,
      stt: sttReason,
      vision: !f.imageAnalysis ? off('AI image analysis') : llm ? null : `${egressAllowed ? `AI image analysis is not configured: ${noKey}.` : EGRESS_OFF} Photographs are still stored for clinician review.`,
      qa: !f.patientQa ? off('Mana AI summaries') : llm ? null : `${egressAllowed ? `Mana AI summaries are not configured: ${noKey}.` : EGRESS_OFF} Answers read directly from the record are still shown.`,
    },
  }
}

const providerStatus = (p: { provider: string; model: string } | null | undefined, reason: string | null | undefined) => ({ available: !!p, provider: p?.provider ?? null, model: p?.model ?? null, reason: p ? null : (reason ?? 'Not configured.') })

/** What the local speech service says about itself just now (a short, cached health check), never a guess from configuration alone. */
async function speechStatus(p: AiProviders): Promise<SpeechStatus> {
  const t = p.transcriber
  if (!t) return { available: false, provider: null, model: null, reason: p.reasons.stt ?? 'Local transcription is not configured.', state: 'not_configured', local: true, host: null, runtime: null, weightsSha256: null }
  const h = await t.health()
  return {
    available: h.state === 'ready',
    provider: t.provider,
    model: h.model?.id ?? t.model,
    reason: h.state === 'ready' ? null : (h.reason ?? 'The local speech service is not ready.'),
    state: h.state,
    local: t.local,
    host: t.local ? null : (t.host ?? null),
    runtime: h.model?.runtime ?? null,
    weightsSha256: h.model?.weightsSha256 ?? null,
  }
}

export async function aiStatus(p: AiProviders): Promise<AiStatus> {
  const x = p.extractor
  return {
    llm: providerStatus(p.drafter ?? p.recommender, p.reasons.llm),
    stt: await speechStatus(p),
    extraction: x
      ? { available: true, provider: x.provider, version: x.promptVersion, local: x.local ?? false, languages: x.languages ?? [], reason: null }
      : { available: false, provider: 'none', version: '', local: true, languages: [], reason: p.reasons.llm ?? 'Extraction is switched off in config/adaxai.yaml.' },
    vision: providerStatus(p.describer, p.reasons.vision ?? p.reasons.llm),
    qa: providerStatus(p.qa, p.reasons.qa ?? p.reasons.llm),
    reasoning: await reasoningStatus({ mode: p.reasoning?.mode ?? 'none', model: p.reasoner ?? null, reason: p.reasoning?.reason ?? null }),
    features: p.features ?? ALL_FEATURES,
    liveChunkSeconds: p.liveChunkSeconds ?? 10,
    egress: { hosted: p.egress?.hosted ?? false, destination: p.egress?.destination ?? null },
  }
}
