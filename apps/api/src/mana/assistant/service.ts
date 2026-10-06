import crypto from 'node:crypto'
import {
  type AskManaAssistantRequest,
  MANA_NO_KNOWLEDGE_SOURCE,
  MANA_OUT_OF_SCOPE,
  MANA_PHASES,
  MANA_READ_ONLY,
  MANA_UNAVAILABLE,
  MANA_VOICE_MAX_BYTES,
  MANA_VOICE_MAX_SECONDS,
  type ManaActionDecisionRequest,
  type ManaActionDecisionResult,
  type ManaActionProposal,
  type ManaAnswerBlock,
  type ManaAnswerBody,
  type ManaAnswerSource,
  type ManaConversationState,
  type ManaEntity,
  type ManaFinding,
  type ManaMessage,
  type ManaMessageStatus,
  ManaModelAnswer,
  ManaPlan,
  type ManaSourceKind,
  type ManaToolName,
  ManaVoiceFields,
  type ManaVoiceTranscript,
  type OpenManaConversationRequest,
  type PlannedCall,
  type SelectManaCandidateRequest,
} from '@adaxai/contracts'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { CONTAINER_OF_MIME, sniffAudio } from '../../ai/audio-sniff.ts'
import { sha256 } from '../../ai/jobs.ts'
import type { JobService } from '../../ai/jobs.ts'
import type { Gate } from '../../ai/llm/gate.ts'
import { reasoningStatus } from '../../ai/llm/status.ts'
import type { ReasoningModel, StructuredRequest, StructuredResult } from '../../ai/llm/types.ts'
import type { PromptDef } from '../../ai/prompts.ts'
import { AiProviderError, type Transcriber } from '../../ai/providers.ts'
import { isLikelyNonSpeech } from '../../ai/stt.ts'
import { audit } from '../../audit/audit.ts'
import { can } from '../../auth/permissions.ts'
import { SESSION_IDLE_MS, type SessionUser } from '../../auth/sessions.ts'
import type { Config } from '../../config.ts'
import { requireConsent } from '../../consents/service.ts'
import { type Db, type DbOrTx, pgCode } from '../../db/client.ts'
import { aiModels, aiRuns, encounters, manaActionDecisions, manaConversations, manaMessages, manaMessageSources, manaToolCalls, sessions, users } from '../../db/schema.ts'
import { readUpload } from '../../files/upload.ts'
import { parse } from '../../http/validate.ts'
import { getEncounterOr404 } from '../../encounters/service.ts'
import { conflict, HttpError } from '../../http/errors.ts'
import { facilityToday, fullName, getPatientOr404 } from '../../patients/service.ts'
import type { AppSettings } from '../../settings/schema.ts'
import type { ReasoningConfig } from '../../consult/service.ts'
import { ANSWER_CHECKS_VERSION, ANSWER_PROMPT, type AnswerFact, type AnswerFinding, checkAnswer, looksLikeInstruction, noticeFor, renderAnswerMessage } from './answer.ts'
import { describePatients, type EntityRef, EntityBook, modelDescriptions, resolveHandle, TooManyPatients } from './entities.ts'
import { blank, coversRun, MAX_PATIENTS_PER_QUESTION, nameRunsIn, nameTokens, NUDGES, PATIENT_TOOLS, PLAN_CHECKS_VERSION, PLAN_PROMPT, type PlanCheck, patientsNamedIn, renderPlanMessage, suggestionLabel, suggestionPlan, suspectPlan, validatePlan } from './plan.ts'
import { consentRefusal, runTool, TOOLS_VERSION } from './tools.ts'
import { timeLabel } from './format.ts'
import { matchRulesIntent, orderWordsOf, RULES_VERSION, type RulesIntent, withChosenPatient } from './intents.ts'
import { answerByRules, type RulesAnswer } from './rules.ts'
import { CONSULTATION_CLOSED, NOT_THE_AUTHOR } from './actions.ts'
import type { ManaCtx, ToolOutcome } from './types.ts'

type ConvRow = typeof manaConversations.$inferSelect
type MsgRow = typeof manaMessages.$inferSelect

/** A conversation goes on for this long after its last message; after that, asking again opens a fresh one (what was said an afternoon ago is not "earlier"). */
const CONTINUE_HOURS = 12
/** A conversation holds at most this many questions: a longer one is a different piece of work and starts again, which also bounds what the screen loads. */
const MAX_QUESTIONS = 60
const PLAN_MAX_TOKENS = 700
const ANSWER_MAX_TOKENS = 1400
/** The most of the model's context the facts and the question may take: the rest is the instructions and the answer. */
const ANSWER_MAX_CHARS = 9000
/** How many earlier questions the planner is shown (so "and her blood pressure?" means something). */
const EARLIER_QUESTIONS = 3

// v2 (HERO final): answers made by fixed rules (engine "rules", no model), and an action the doctor may approve or decline (a medicine to add).
export const MANA_CONTRACT_VERSION = 'mana-assistant-v2'

/** The audio the voice route accepts (the encounter audio routes' own list: the browser records WebM or Ogg, Safari MP4). */
const VOICE_EXT: Record<string, string> = { 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav' }
/** What the speech model may report beyond what the browser recorded (the container's own rounding): a clip longer than this is refused. */
const VOICE_SLACK_MS = 1500

export interface ManaServiceDeps {
  db: Db
  /** Only to register the prompts' checksums (a prompt whose text changed under an old id is refused). */
  jobs: JobService
  reasoning: ReasoningConfig
  gate: Gate
  settings: AppSettings
  dataOrigin: 'clinical' | 'synthetic'
  /** Longest one model call may take. Defaults to the AI timeout setting, and at most six minutes (a question is two calls and the doctor is waiting). */
  callTimeoutMs?: number
  /**
   * The server's configuration, for the consultation tool (the consultation context reads whether a simulator may post here). Without it the context is built
   * as for a deployment where none may (see ManaCtx.config).
   */
  config?: Config
}

/** What a stored answer holds. The sources are rows of their own; the names of patients are put back from the conversation when it is read. */
interface StoredAnswer {
  outcome: ManaAnswerBody['outcome']
  notice: string | null
  blocks: ManaAnswerBlock[]
  findings: ManaFinding[]
  /** Handles of the patients the doctor is asked to choose between. */
  candidates: string[]
  /** Handles of the patients the tools looked up for this answer (so the screen says whom it is about, also when there is nothing to show). */
  patients?: string[]
  removed: number
  /** HERO final: `rules` when the server composed it by fixed rules (no model). Absent: the model's. */
  engine?: 'rules'
  /** HERO final: an action the doctor may approve or decline (never carried out by the server). */
  action?: ManaActionProposal | null
}

/** What a stored plan holds: the plan, the question it answers, and (when a patient must be chosen) which calls the choice settles. */
interface ModelPlan {
  type: 'plan'
  plan: ManaPlan
  question: string
  resolution: { callIndexes: number[] } | null
}
/** A fixed-rule question: what it was, and (when a patient must be chosen) that the choice runs it again for that patient. */
interface RulesPlan {
  type: 'rules'
  intent: RulesIntent
  question: string
  resolution: { callIndexes: number[] } | null
}
type StoredPlan = ModelPlan | RulesPlan

interface ToolRun {
  call: PlannedCall
  o: ToolOutcome
  ms: number
}

/** Something that ends a question without an answer, with the words the doctor reads. */
class Ended extends Error {
  constructor(
    readonly status: Exclude<ManaMessageStatus, 'pending' | 'ready' | 'refused' | 'unverified'>,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

const sentence = (s: string): boolean => /^[A-Z].*[.?!]$/.test(s)

export class ManaAssistantService {
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly d: ManaServiceDeps) {}

  // --- status -----------------------------------------------------------------------------------------------------------------------------

  async status(opts: { fresh?: boolean } = {}) {
    const { model, mode, reason } = this.d.reasoning
    return { reasoning: await reasoningStatus({ mode, model, reason }, opts), unavailableMessage: MANA_UNAVAILABLE }
  }

  private async clock(facilityId: string): Promise<{ today: string; timeZone: string }> {
    const { rows } = await this.d.db.execute<{ tz: string } & Record<string, unknown>>(sql`select timezone as tz from facilities where id = ${facilityId}`)
    return { today: await facilityToday(this.d.db, facilityId), timeZone: rows[0]?.tz ?? 'UTC' }
  }

  // --- conversations ----------------------------------------------------------------------------------------------------------------------

  private async convOr404(me: SessionUser, id: string): Promise<ConvRow> {
    const [row] = await this.d.db.select().from(manaConversations).where(and(eq(manaConversations.id, id), eq(manaConversations.facilityId, me.facilityId), eq(manaConversations.doctorId, me.id)))
    // Another doctor's conversation is not found, whoever asks: what a doctor asked is theirs.
    if (!row) throw new HttpError(404, 'not_found', 'Conversation not found')
    return row
  }

  /**
   * Opens the doctor's conversation for a consultation (or a patient, or in general): the latest one if it is recent, a new one otherwise or when asked. The
   * consultation or patient must be one of this clinic; "this patient" in a question means that patient and nobody else.
   */
  async open(req: FastifyRequest, me: SessionUser, body: OpenManaConversationRequest): Promise<ManaConversationState> {
    const { db } = this.d
    let scope: { encounterId: string | null; patientId: string | null } = { encounterId: null, patientId: null }
    if (body.encounterId) {
      const e = await getEncounterOr404(db, me, body.encounterId)
      scope = { encounterId: e.id, patientId: e.patientId }
    } else if (body.patientId) {
      const p = await getPatientOr404(db, me.facilityId, body.patientId)
      scope = { encounterId: null, patientId: p.id }
    }
    const [latest] = await db
      .select()
      .from(manaConversations)
      .where(
        and(
          eq(manaConversations.doctorId, me.id),
          eq(manaConversations.facilityId, me.facilityId),
          scope.encounterId ? eq(manaConversations.encounterId, scope.encounterId) : isNull(manaConversations.encounterId),
          scope.patientId ? eq(manaConversations.patientId, scope.patientId) : isNull(manaConversations.patientId),
        ),
      )
      .orderBy(desc(manaConversations.updatedAt))
      .limit(1)
    const recent = !!latest && Date.now() - latest.updatedAt.getTime() < CONTINUE_HOURS * 3_600_000
    let conv = latest
    if (!conv || !recent || body.fresh) {
      const [row] = await db
        .insert(manaConversations)
        .values({
          facilityId: me.facilityId,
          doctorId: me.id,
          encounterId: scope.encounterId,
          patientId: scope.patientId,
          // The patient of the consultation is P1 from the start.
          entities: scope.patientId ? [{ alias: 'P1', patientId: scope.patientId }] : [],
          focus: scope.patientId ? 'P1' : null,
          dataOrigin: this.d.dataOrigin,
        })
        .returning()
      conv = row!
      await audit(db, req, { action: 'mana.conversation_opened', entityType: 'mana_conversation', entityId: conv.id, patientId: scope.patientId, details: { encounterId: scope.encounterId, scope: scope.encounterId ? 'consultation' : scope.patientId ? 'patient' : 'clinic', fresh: !!body.fresh } })
    }
    return this.state(me, conv!, { fresh: true })
  }

  /** The conversation as the screen shows it: its messages, the patients shown (with names, for the doctor), and what the model server says about itself. */
  async stateOf(me: SessionUser, conversationId: string, opts: { fresh?: boolean } = {}): Promise<ManaConversationState> {
    return this.state(me, await this.convOr404(me, conversationId), opts)
  }

  private async state(me: SessionUser, conv0: ConvRow, opts: { fresh?: boolean } = {}): Promise<ManaConversationState> {
    const { db } = this.d
    const [status, clock] = await Promise.all([this.status(opts), this.clock(me.facilityId)])
    const rows = await db.select().from(manaMessages).where(eq(manaMessages.conversationId, conv0.id)).orderBy(asc(manaMessages.seq)).limit(400)
    // The patients of the conversation are read AFTER its messages: an answer and the handles it uses are stored in one transaction, so a conversation read after
    // an answer was seen has the handles of that answer (one read before it might not, and the answer would show handles it cannot put names to).
    const conv = (await db.select().from(manaConversations).where(eq(manaConversations.id, conv0.id)))[0] ?? conv0
    const answerIds = rows.filter((r) => r.role === 'mana').map((r) => r.id)
    const tools = answerIds.length ? await db.select().from(manaToolCalls).where(inArray(manaToolCalls.messageId, answerIds)).orderBy(asc(manaToolCalls.position)) : []
    const sources = answerIds.length ? await db.select().from(manaMessageSources).where(inArray(manaMessageSources.messageId, answerIds)).orderBy(asc(manaMessageSources.createdAt), asc(manaMessageSources.ref)) : []
    const proposing = rows.filter((r) => r.role === 'mana' && (r.answer as StoredAnswer | null)?.action).map((r) => r.id)
    const decisions = proposing.length ? await db.select().from(manaActionDecisions).where(inArray(manaActionDecisions.messageId, proposing)) : []
    const book = new EntityBook(conv.entities as EntityRef[])
    const entities = await describePatients(db, me.facilityId, clock.today, book, book.all().map((r) => r.patientId))
    const messages = rows.map((r) => this.toMessage(r, tools, sources, entities, book, decisions))
    return {
      conversation: { id: conv.id, scope: { encounterId: conv.encounterId, patient: conv.patientId ? book.aliasOf(conv.patientId) : null }, createdAt: conv.createdAt.toISOString(), updatedAt: conv.updatedAt.toISOString() },
      messages,
      status: status.reasoning,
      scopePatient: conv.patientId ? (entities.find((e) => e.alias === book.aliasOf(conv.patientId!)) ?? null) : null,
    }
  }

  private toMessage(r: MsgRow, tools: (typeof manaToolCalls.$inferSelect)[], sources: (typeof manaMessageSources.$inferSelect)[], entities: ManaEntity[], book: EntityBook, decisions: (typeof manaActionDecisions.$inferSelect)[] = []): ManaMessage {
    const stored = r.answer as StoredAnswer | null
    let answer: ManaMessage['answer'] = null
    if (r.role === 'mana' && stored) {
      const mine = sources
        .filter((s) => s.messageId === r.id)
        .sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)))
      const cited = new Set(stored.blocks.flatMap((b) => b.refs))
      const aliasOfPatient = new Map(entities.map((e) => [e.alias, e]))
      const outSources: ManaAnswerSource[] = mine.map((s) => ({ ref: s.ref, kind: s.kind as ManaSourceKind, label: s.label, text: s.text, patient: s.patientId ? book.aliasOf(s.patientId) : null, items: s.items as ManaAnswerSource['items'], cited: cited.has(s.ref) }))
      const mentioned = new Set<string>([...stored.candidates, ...(stored.patients ?? []), ...outSources.flatMap((s) => (s.patient ? [s.patient] : [])), ...stored.blocks.flatMap((b) => b.text.match(/\bP\d{1,2}\b/g) ?? [])])
      answer = {
        outcome: stored.outcome,
        notice: stored.notice,
        // Whom the answer is about is the server's statement (the patients whose records were read), not what the model happened to write.
        subjects: entities.filter((e) => (stored.patients ?? []).includes(e.alias)),
        blocks: stored.blocks,
        findings: stored.findings,
        sources: outSources,
        candidates: stored.candidates.flatMap((a) => (aliasOfPatient.get(a) ? [aliasOfPatient.get(a)!] : [])),
        entities: entities.filter((e) => mentioned.has(e.alias)),
        removed: stored.removed,
        ...(stored.engine ? { engine: stored.engine } : {}),
        ...(stored.action ? { action: stored.action } : {}),
      }
    }
    const decided = stored?.action ? decisions.find((d) => d.messageId === r.id) : undefined
    return {
      ...(stored?.action ? { actionDecision: decided ? { decision: decided.decision as 'approved' | 'declined', decidedAt: decided.decidedAt.toISOString() } : null } : {}),
      id: r.id,
      seq: r.seq,
      role: r.role as 'doctor' | 'mana',
      text: r.text,
      status: r.status as ManaMessageStatus,
      phase: (r.phase as ManaMessage['phase']) ?? null,
      answer,
      error: r.errorCode ? { code: r.errorCode, message: r.errorMessage ?? '', retryable: r.retryable } : null,
      tools: tools.filter((t) => t.messageId === r.id).map((t) => ({ position: t.position, tool: t.tool as ManaToolName, status: t.status as ManaMessage['tools'][number]['status'], detail: t.detail })),
      model: r.provider ? { provider: r.provider, model: r.model ?? '', runtime: r.runtime, weightsSha256: r.weightsSha256, local: r.locality === 'local', planPrompt: r.planPromptId ?? '', answerPrompt: r.answerPromptId ?? '', checks: r.checksVersion ?? '', tools: r.toolsVersion ?? '' } : null,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    }
  }

  // --- asking -----------------------------------------------------------------------------------------------------------------------------

  /**
   * Takes a question. Everything that can be refused is refused before anything is stored or read: the caller's right to this conversation, the
   * model's availability. A question stores two rows (what was asked, and the answer still to come); the answer is made in the background and
   * polled. The same idempotency key returns the same question; a second question while one is being answered is refused (the database enforces it).
   */
  async ask(req: FastifyRequest, me: SessionUser, conversationId: string, body: AskManaAssistantRequest): Promise<{ state: ManaConversationState; created: boolean }> {
    const { db } = this.d
    const conv = await this.convOr404(me, conversationId)
    const existing = await db.query.manaMessages.findFirst({ where: and(eq(manaMessages.askedBy, me.id), eq(manaMessages.idempotencyKey, body.idempotencyKey)) })
    if (existing) {
      if (existing.conversationId !== conv.id) throw conflict('That request key was already used for a different conversation', 'idempotency_key_reused')
      return { state: await this.state(me, conv), created: false }
    }
    if (body.suggestion && body.text !== suggestionLabel(body.suggestion)) throw new HttpError(422, 'suggestion_mismatch', 'That is not the question this button asks.')
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(manaMessages).where(and(eq(manaMessages.conversationId, conv.id), eq(manaMessages.role, 'doctor')))) as [{ n: number }]
    if (n >= MAX_QUESTIONS) throw new HttpError(409, 'conversation_full', 'This conversation is long enough: start a new one.')
    // HERO final: a question that fixed rules answer exactly (who is next, how many seen, an order's status ...) is answered from the records by the server
    // itself: no model is asked or needed, so it is answered also while the model is down or busy (and nothing about the model is looked at).
    const rules = body.suggestion ? null : matchRulesIntent(body.text, orderWordsOf(this.d.settings.serviceOrders.catalogue))
    if (rules) return this.askByRules(req, me, conv, body, rules)
    await this.requireModel(req, conv)
    const preplan = body.suggestion ? suggestionPlan(body.suggestion) : undefined
    const { q, a } = await this.insertTurn(me, conv, body.text, { idempotencyKey: body.idempotencyKey, parentId: null, plan: null })
    await this.auditTurn(req, conv, a, () => audit(db, req, { action: 'mana.question_asked', entityType: 'mana_message', entityId: q.id, patientId: conv.patientId, details: { conversationId: conv.id, answerId: a.id, encounterId: conv.encounterId, length: body.text.length, suggestion: body.suggestion ?? null, mode: this.d.reasoning.mode } }))
    const ac = new AbortController()
    this.running.set(a.id, ac)
    // Detached on purpose: the request returns now; `run` records every outcome itself and never throws.
    void this.run(req, me, conv, q, a, { question: body.text, ...(preplan ? { preplan } : {}), resolution: null }, ac)
    return { state: await this.state(me, conv), created: true }
  }

  /**
   * The doctor chose one of the patients Mana found. What remains of the question is run again with that patient (the plan was already made: the model is not
   * asked again what to look up), and the choice is recorded as the doctor's message.
   */
  async select(req: FastifyRequest, me: SessionUser, conversationId: string, body: SelectManaCandidateRequest): Promise<{ state: ManaConversationState; created: boolean }> {
    const { db } = this.d
    const conv = await this.convOr404(me, conversationId)
    const existing = await db.query.manaMessages.findFirst({ where: and(eq(manaMessages.askedBy, me.id), eq(manaMessages.idempotencyKey, body.idempotencyKey)) })
    if (existing) {
      if (existing.conversationId !== conv.id) throw conflict('That request key was already used for a different conversation', 'idempotency_key_reused')
      return { state: await this.state(me, conv), created: false }
    }
    const [last] = await db.select().from(manaMessages).where(eq(manaMessages.conversationId, conv.id)).orderBy(desc(manaMessages.seq)).limit(1)
    const stored = last?.answer as StoredAnswer | null
    const sp = last?.plan as StoredPlan | null
    if (!last || last.role !== 'mana' || last.status !== 'ready' || !stored?.candidates.length || !sp?.resolution) throw new HttpError(409, 'nothing_to_select', 'There is no choice to make just now.')
    if (!stored.candidates.includes(body.alias)) throw new HttpError(422, 'not_a_candidate', 'That patient is not one of the patients Mana asked you to choose between.')
    // A choice is a question like any other: a long conversation is not continued by choosing.
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(manaMessages).where(and(eq(manaMessages.conversationId, conv.id), eq(manaMessages.role, 'doctor')))) as [{ n: number }]
    if (n >= MAX_QUESTIONS) throw new HttpError(409, 'conversation_full', 'This conversation is long enough: start a new one.')
    // A fixed-rule question that asked the doctor to choose a patient is run again, by the same rules, for the patient chosen: still no model.
    if (sp.type === 'rules') return this.selectByRules(req, me, conv, last, sp, body)
    await this.requireModel(req, conv)
    const book = new EntityBook(conv.entities as EntityRef[])
    const chosenId = book.patientIdOf(body.alias)
    const clock = await this.clock(me.facilityId)
    const [chosen] = chosenId ? await describePatients(db, me.facilityId, clock.today, book, [chosenId]) : []
    if (!chosen || !chosenId) throw new HttpError(422, 'not_a_candidate', 'That patient is not available.')
    // The calls the choice settles are given the chosen patient. A search for a patient ("find Rahul") is settled by finding that patient again, by record number.
    const settles = new Set(sp.resolution.callIndexes)
    const plan: ManaPlan = { ...sp.plan, calls: sp.plan.calls.map((c, i) => (!settles.has(i) ? c : c.tool === 'find_patient' ? blank('find_patient', { text: chosen.mrn }) : { ...c, patient: body.alias })) }
    const { q, a } = await this.insertTurn(me, conv, `Selected ${chosen.displayName} (${chosen.mrn})`, { idempotencyKey: body.idempotencyKey, parentId: last.id, plan: { type: 'selection', alias: body.alias } })
    await this.auditTurn(req, conv, a, () => audit(db, req, { action: 'mana.candidate_selected', entityType: 'mana_message', entityId: q.id, patientId: chosenId, details: { conversationId: conv.id, answerId: a.id, alias: body.alias } }))
    const ac = new AbortController()
    this.running.set(a.id, ac)
    // The doctor chose this patient: the check that the plan is about the patient the question names does not overrule the choice.
    void this.run(req, me, conv, q, a, { question: sp.question, preplan: plan, resolution: null, confirmed: new Set([chosenId]) }, ac)
    return { state: await this.state(me, conv), created: true }
  }

  // --- answers by fixed rules (HERO final) ---------------------------------------------------------------------------------------------------

  /**
   * A question the fixed rules answer (intents.ts): stored and audited like any question, answered at once by the server from the records (rules.ts), with
   * no model asked, no model gate and no model health check. The consent checks, the audit of what was read and shown, and the immutability of the
   * finished answer are those of every answer.
   */
  private async askByRules(req: FastifyRequest, me: SessionUser, conv: ConvRow, body: AskManaAssistantRequest, intent: RulesIntent): Promise<{ state: ManaConversationState; created: boolean }> {
    const { db } = this.d
    const { q, a } = await this.insertTurn(me, conv, body.text, { idempotencyKey: body.idempotencyKey, parentId: null, plan: null, rules: true })
    await this.auditTurn(req, conv, a, () => audit(db, req, { action: 'mana.question_asked', entityType: 'mana_message', entityId: q.id, patientId: conv.patientId, details: { conversationId: conv.id, answerId: a.id, encounterId: conv.encounterId, length: body.text.length, suggestion: null, mode: 'rules', intent: intent.kind } }))
    await this.runRules(req, me, conv, a, { question: body.text, intent })
    return { state: await this.state(me, conv), created: true }
  }

  /** The doctor chose one of the patients a fixed-rule answer offered: the same question, by the same rules, for that patient. */
  private async selectByRules(req: FastifyRequest, me: SessionUser, conv: ConvRow, last: MsgRow, sp: RulesPlan, body: SelectManaCandidateRequest): Promise<{ state: ManaConversationState; created: boolean }> {
    const { db } = this.d
    const book = new EntityBook(conv.entities as EntityRef[])
    const chosenId = book.patientIdOf(body.alias)
    const clock = await this.clock(me.facilityId)
    const [chosen] = chosenId ? await describePatients(db, me.facilityId, clock.today, book, [chosenId]) : []
    if (!chosen || !chosenId) throw new HttpError(422, 'not_a_candidate', 'That patient is not available.')
    const intent = withChosenPatient(sp.intent, body.alias)
    if (!intent) throw new HttpError(409, 'nothing_to_select', 'There is no choice to make just now.')
    const { q, a } = await this.insertTurn(me, conv, `Selected ${chosen.displayName} (${chosen.mrn})`, { idempotencyKey: body.idempotencyKey, parentId: last.id, plan: { type: 'selection', alias: body.alias }, rules: true })
    await this.auditTurn(req, conv, a, () => audit(db, req, { action: 'mana.candidate_selected', entityType: 'mana_message', entityId: q.id, patientId: chosenId, details: { conversationId: conv.id, answerId: a.id, alias: body.alias } }))
    await this.runRules(req, me, conv, a, { question: sp.question, intent })
    return { state: await this.state(me, conv), created: true }
  }

  /** Composes, records and keeps a fixed-rule answer. Every outcome is recorded here; it never throws. */
  private async runRules(req: FastifyRequest, me: SessionUser, conv: ConvRow, a: MsgRow, o: { question: string; intent: RulesIntent }): Promise<void> {
    const { db, settings } = this.d
    const t0 = Date.now()
    try {
      await this.requireStillAllowed(me)
      const clock = await this.clock(me.facilityId)
      const book = new EntityBook(conv.entities as EntityRef[])
      // No model is involved: the consent rule is the one every answer follows (a patient who withdrew consent to AI help is not read, nor their free text shown).
      const ctx: ManaCtx = { db, me, settings, scope: { encounterId: conv.encounterId, patientId: conv.patientId }, book, today: clock.today, timeZone: clock.timeZone, now: new Date(), modelIsLocal: true, disclosed: new Set(), textShown: new Set(), denials: [], config: this.d.config }
      const r = await answerByRules(ctx, o.intent)
      await this.recordRulesRead(req, conv, a, o.intent, r, ctx)
      const facts: AnswerFact[] = r.facts.map((x, i) => ({ ref: `S${i + 1}`, text: x.text, patient: x.patient, items: x.items }))
      const blocks: ManaAnswerBlock[] = r.blocks.map((b) => ({ text: b.text, refs: [...new Set(b.facts.map((i) => `S${i + 1}`))], flags: [] }))
      const findings: ManaFinding[] = r.findings.map((x, i) => ({ ref: `F${i + 1}`, kind: x.kind, text: x.text, items: x.items }))
      const action = r.action
      await this.finish(req, conv, a, {
        stored: { outcome: r.outcome, notice: r.notice, blocks, findings, candidates: r.candidates, removed: 0, engine: 'rules', ...(action ? { action } : {}) },
        plan: { type: 'rules', intent: o.intent, question: o.question, resolution: r.candidates.length ? { callIndexes: [] } : null },
        facts,
        toolRuns: [],
        meta: { model: '', runtime: null, weights: null, planRunId: null, answerRunId: null },
        ctx,
        readPatients: r.read,
        startedAt: t0,
        planned: false,
        validation: {},
        rules: {
          intent: o.intent.kind,
          subjects: r.subjects,
          ...(action && {
            // What Mana proposed is on the audit log as ids and counts: never the medicine, the dose or the doctor's words.
            extra: (tx: DbOrTx) => audit(tx, req, { action: 'mana.action_proposed', entityType: 'mana_message', entityId: a.id, patientId: conv.patientId, details: { conversationId: conv.id, encounterId: action.encounterId, kind: action.kind, warnings: action.warnings.length } }),
          }),
        },
      })
    } catch (err) {
      await this.markFailed(req, conv, a, err)
      const expected = err instanceof Ended || err instanceof TooManyPatients || (err instanceof HttpError && err.statusCode < 500)
      if (!expected) req.log.error({ err, messageId: a.id }, 'Mana fixed-rule answer failed unexpectedly')
    }
  }

  /** What a fixed-rule answer read, and for whom, and which patients it showed, on the audit log in one transaction (counts and ids, no clinical text). */
  private async recordRulesRead(req: FastifyRequest, conv: ConvRow, a: MsgRow, intent: RulesIntent, r: RulesAnswer, ctx: ManaCtx): Promise<void> {
    const status = { answered: 'ok', not_established: 'empty', refused: 'refused', ambiguous: 'ambiguous', clarify: 'clarify' }[r.outcome]
    await this.d.db.transaction(async (tx) => {
      const read = [...r.read]
      for (const patientId of read.length ? read : [null]) {
        await audit(tx, req, {
          action: r.outcome === 'refused' ? 'mana.access_refused' : 'mana.tool_run',
          outcome: r.outcome === 'refused' ? 'denied' : 'success',
          entityType: 'mana_message',
          entityId: a.id,
          patientId,
          details: { conversationId: conv.id, tool: `rules:${intent.kind}`, engine: 'rules', status, facts: r.facts.length, findings: r.findings.length },
        })
      }
      await this.auditShown(tx, req, conv, a, ctx, r.read)
    })
  }

  // --- the doctor's decision on a proposed action (HERO final) --------------------------------------------------------------------------------

  /**
   * Records the doctor's Approve or Cancel on an answer's proposed action, once (a repeat of the same decision returns it; the other decision is refused).
   * Nothing clinical is written: an approved medicine is added to the unsigned draft by the doctor's screen, and saved by its own autosave as the doctor's
   * act. Approving needs the consultation to be the doctor's own and still a draft.
   */
  async decide(req: FastifyRequest, me: SessionUser, messageId: string, body: ManaActionDecisionRequest): Promise<{ result: ManaActionDecisionResult; created: boolean }> {
    const { db } = this.d
    const [row] = await db.select().from(manaMessages).where(eq(manaMessages.id, messageId))
    if (!row) throw new HttpError(404, 'not_found', 'Message not found')
    const conv = await this.convOr404(me, row.conversationId)
    const action = (row.answer as StoredAnswer | null)?.action
    if (row.role !== 'mana' || row.status !== 'ready' || !action) throw conflict('That answer has nothing to approve or cancel.', 'no_action')
    const decided = async () => (await db.select().from(manaActionDecisions).where(eq(manaActionDecisions.messageId, row.id)))[0]
    const result = (d: typeof manaActionDecisions.$inferSelect): ManaActionDecisionResult => ({ messageId: d.messageId, decision: d.decision as ManaActionDecisionResult['decision'], decidedAt: d.decidedAt.toISOString() })
    const prior = await decided()
    if (prior) {
      if (prior.decision !== body.decision) throw conflict(`That proposal was already ${prior.decision === 'approved' ? 'approved' : 'cancelled'}.`, 'already_decided')
      return { result: result(prior), created: false }
    }
    if (body.decision === 'approved') {
      const [e] = await db.select({ status: encounters.status, doctorId: encounters.doctorId }).from(encounters).where(and(eq(encounters.id, action.encounterId), eq(encounters.facilityId, me.facilityId)))
      if (!e || e.status !== 'in_progress') throw conflict(CONSULTATION_CLOSED, 'encounter_not_editable')
      if (e.doctorId !== me.id) throw new HttpError(403, 'forbidden', NOT_THE_AUTHOR)
    }
    try {
      const d = await db.transaction(async (tx) => {
        const [ins] = await tx.insert(manaActionDecisions).values({ messageId: row.id, encounterId: action.encounterId, kind: action.kind, decision: body.decision, decidedBy: me.id }).returning()
        await audit(tx, req, { action: body.decision === 'approved' ? 'mana.action_approved' : 'mana.action_declined', entityType: 'mana_message', entityId: row.id, patientId: conv.patientId, details: { conversationId: conv.id, encounterId: action.encounterId, kind: action.kind } })
        return ins!
      })
      return { result: result(d), created: true }
    } catch (e) {
      if (pgCode(e) !== '23505') throw e
      // Two decisions at once: the first stands.
      const won = await decided()
      if (won && won.decision === body.decision) return { result: result(won), created: false }
      throw conflict('That proposal was already decided.', 'already_decided')
    }
  }

  // --- a spoken question (HERO final) -------------------------------------------------------------------------------------------------------

  /**
   * One short spoken question, transcribed IN MEMORY by the local speech model and returned as text: the audio is never stored (no file, no transcript, no
   * row), and the audit log has counts only (bytes, duration, how many characters were heard), never the words. In a conversation opened in a consultation
   * the patient's recording consent is required, as for any recording made in a consultation (the patient may be heard).
   */
  async voice(req: FastifyRequest, me: SessionUser, transcriber: Transcriber | null): Promise<ManaVoiceTranscript> {
    const { db, settings } = this.d
    if (!transcriber) {
      await audit(db, req, { action: 'mana.voice_transcribed', outcome: 'failure', details: { code: 'no_speech_service' } })
      throw new HttpError(503, 'stt_unavailable', 'The local speech service is not set up on this computer, so Mana cannot hear a question. Type it instead.')
    }
    const up = await readUpload(req, 'a voice recording')
    const fields = parse(ManaVoiceFields, up.fields)
    const mime = up.mimetype
    const ext = VOICE_EXT[mime]
    const tooLong = `A spoken question is at most ${MANA_VOICE_MAX_SECONDS} seconds. Nothing was kept.`
    if (!ext || !settings.uploads.audio.types.includes(mime)) throw new HttpError(400, 'bad_request', 'Unsupported audio format', [{ path: 'file', message: 'Use WebM, OGG, MP3, M4A or WAV audio' }])
    if (up.data.length > MANA_VOICE_MAX_BYTES) throw new HttpError(413, 'too_large', tooLong)
    if (fields.durationMs !== undefined && fields.durationMs > MANA_VOICE_MAX_SECONDS * 1000 + VOICE_SLACK_MS) throw new HttpError(413, 'too_long', tooLong)
    // What the bytes are, not what the browser said they are (the encounter audio routes' own rule).
    if (sniffAudio(up.data) !== CONTAINER_OF_MIME[mime]) throw new HttpError(415, 'unsupported_media', 'The file is not audio of the kind it says it is. Use a WebM, OGG, MP3, M4A or WAV recording.')
    const conv = fields.conversationId ? await this.convOr404(me, fields.conversationId) : null
    if (conv?.encounterId && conv.patientId) await requireConsent(db, req, { patientId: conv.patientId, type: 'ai_recording', encounterId: conv.encounterId, purpose: 'a spoken question to Mana in a consultation', acceptOlderWording: true })
    const base = { conversationId: conv?.id ?? null, encounterId: conv?.encounterId ?? null, bytes: up.data.length }
    const fail = (code: string, extra: Record<string, unknown> = {}) => audit(db, req, { action: 'mana.voice_transcribed', outcome: 'failure', entityType: conv ? 'mana_conversation' : undefined, entityId: conv?.id ?? null, patientId: conv?.patientId ?? null, details: { ...base, code, ...extra } })
    let out: Awaited<ReturnType<Transcriber['transcribe']>>
    try {
      out = await transcriber.transcribe(up.data, mime, `mana-question${ext}`, { language: settings.ai.stt.languageHint })
    } catch (err) {
      await fail(err instanceof AiProviderError ? err.code : 'internal_error')
      if (!(err instanceof AiProviderError)) throw err
      const down = ['unreachable', 'stt_unavailable', 'busy', 'timeout'].includes(err.code)
      throw new HttpError(down ? 503 : 422, down ? 'stt_unavailable' : err.code, err.message)
    }
    if (out.durationMs > MANA_VOICE_MAX_SECONDS * 1000 + VOICE_SLACK_MS) {
      await fail('too_long', { durationMs: out.durationMs })
      throw new HttpError(413, 'too_long', tooLong)
    }
    const heard = out.segments
      .filter((s) => !isLikelyNonSpeech(s))
      .map((s) => s.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500)
    await audit(db, req, { action: 'mana.voice_transcribed', entityType: conv ? 'mana_conversation' : undefined, entityId: conv?.id ?? null, patientId: conv?.patientId ?? null, details: { ...base, durationMs: out.durationMs, segments: out.segments.length, chars: heard.length, empty: !heard, local: transcriber.local } })
    return { text: heard, empty: !heard, durationMs: out.durationMs, language: out.language }
  }

  /** The model must be there before a question is stored: a question with no model to answer it is not kept, and is said so ("Mana is currently unavailable."). */
  private async requireModel(req: FastifyRequest, conv: ConvRow): Promise<void> {
    const { db, reasoning, gate } = this.d
    const model = reasoning.model
    if (!model) {
      await audit(db, req, { action: 'mana.question_asked', outcome: 'denied', entityType: 'mana_conversation', entityId: conv.id, patientId: conv.patientId, details: { reason: 'no_model', mode: reasoning.mode } })
      throw new HttpError(503, 'ai_unavailable', MANA_UNAVAILABLE)
    }
    const health = await model.health()
    if (health.state !== 'ready') {
      await audit(db, req, { action: 'mana.question_asked', outcome: 'failure', entityType: 'mana_conversation', entityId: conv.id, patientId: conv.patientId, details: { reason: health.state, mode: reasoning.mode } })
      throw new HttpError(503, 'ai_unavailable', MANA_UNAVAILABLE)
    }
    if (gate.full) throw new HttpError(429, 'ai_busy', 'The local model is busy. Try again in a moment.')
  }

  /**
   * Writes the audit event of a question that was just stored. If the audit log cannot be written, the answer that was stored to go with it is failed at once
   * (a question nobody is working on is not left "pending", which would block the conversation), and the doctor is told.
   */
  private async auditTurn(req: FastifyRequest, conv: ConvRow, a: MsgRow, write: () => Promise<unknown>): Promise<void> {
    try {
      await write()
    } catch (err) {
      await this.markFailed(req, conv, a, err)
      throw err
    }
  }

  /**
   * The doctor must still be who the request said when the work begins: waiting for the model's turn can take minutes, and a session that ended, an account that
   * was switched off or a role that changed in the meantime ends the question before anything is read.
   */
  private async requireStillAllowed(me: SessionUser): Promise<void> {
    const [row] = await this.d.db
      .select({ role: users.role, facilityId: users.facilityId, isActive: users.isActive, mustChangePassword: users.mustChangePassword, expiresAt: sessions.expiresAt, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, me.sessionId))
      .limit(1)
    // The same conditions the session lookup applies to a request: the session exists, has not expired or sat idle too long, the account is on and is not waiting for a
    // new password, and the role still holds the permission.
    const now = Date.now()
    if (!row || !row.isActive || row.mustChangePassword || row.expiresAt.getTime() <= now || now - row.lastSeenAt.getTime() > SESSION_IDLE_MS || row.facilityId !== me.facilityId || row.role !== me.role || !can(row.role, 'ai:use')) {
      throw new Ended('failed', 'session_ended', 'Your session ended, or your access changed, while Mana was working, so nothing was read. Sign in and ask again.', false)
    }
  }

  private async insertTurn(me: SessionUser, conv: ConvRow, text: string, o: { idempotencyKey: string; parentId: string | null; plan: unknown; rules?: boolean }): Promise<{ q: MsgRow; a: MsgRow }> {
    const { db, reasoning } = this.d
    // An answer by fixed rules names no model: none is asked.
    const model = o.rules ? null : reasoning.model
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const [{ n }] = (await tx.select({ n: sql<number>`coalesce(max(${manaMessages.seq}), 0)::int` }).from(manaMessages).where(eq(manaMessages.conversationId, conv.id))) as [{ n: number }]
          const [q] = await tx.insert(manaMessages).values({ conversationId: conv.id, seq: n + 1, role: 'doctor', text, parentId: o.parentId, askedBy: me.id, idempotencyKey: o.idempotencyKey, status: 'ready', plan: o.plan ?? null, completedAt: new Date() }).returning()
          const [a] = await tx
            .insert(manaMessages)
            .values({ conversationId: conv.id, seq: n + 2, role: 'mana', parentId: q!.id, askedBy: me.id, status: 'pending', phase: 'queued', provider: model?.provider ?? null, model: model?.model ?? null, locality: model ? (model.local ? 'local' : 'external') : null, startedAt: new Date() })
            .returning()
          await tx.update(manaConversations).set({ updatedAt: new Date() }).where(eq(manaConversations.id, conv.id))
          return { q: q!, a: a! }
        })
      } catch (e) {
        if (pgCode(e) !== '23505') throw e
        const x = e as { constraint?: string; cause?: { constraint?: string } }
        const name = x.constraint ?? x.cause?.constraint ?? ''
        if (name.includes('one_pending')) throw conflict('Mana is still answering your last question. Wait for it, or stop it first.', 'answer_in_progress')
        if (name.includes('idempotency')) throw conflict('That question was already asked.', 'idempotency_key_reused')
        // A concurrent question took the same sequence number: take the next one.
      }
    }
    throw new HttpError(409, 'conflict', 'The question could not be stored; try again.')
  }

  // --- answering --------------------------------------------------------------------------------------------------------------------------

  /**
   * One model call, with its own time limit (the doctor is waiting) that is shorter than a consultation draft's: when it runs out the call is stopped and the
   * answer fails as "timeout" (retryable), which is not the same as the doctor stopping it.
   */
  private async callModel<T extends z.ZodType>(model: ReasoningModel, req: Omit<StructuredRequest<T>, 'signal'>, ac: AbortController): Promise<StructuredResult<z.infer<T>>> {
    // Stopped before the call began (while the records were being read or the plan stored): an abort that already happened does not fire again, so it is looked at first.
    if (ac.signal.aborted) throw new AiProviderError('cancelled', 'This question was stopped.', true)
    const limit = this.d.callTimeoutMs ?? Math.min(this.d.settings.ai.reasoning.timeoutSeconds, 360) * 1000
    const inner = new AbortController()
    const relay = () => inner.abort()
    ac.signal.addEventListener('abort', relay, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      inner.abort()
    }, limit)
    try {
      return await model.generate({ ...req, signal: inner.signal })
    } catch (err) {
      if (timedOut && !ac.signal.aborted) throw new AiProviderError('timeout', `Mana took longer than ${limit >= 60_000 ? `${Math.round(limit / 60_000)} minutes` : `${Math.round(limit / 1000)} seconds`} and was stopped (the model runs on this computer). You can ask again.`, true)
      throw err
    } finally {
      clearTimeout(timer)
      ac.signal.removeEventListener('abort', relay)
    }
  }

  private async setPhase(id: string, phase: (typeof MANA_PHASES)[number]): Promise<void> {
    await this.d.db
      .update(manaMessages)
      .set({ phase, updatedAt: new Date() })
      .where(and(eq(manaMessages.id, id), eq(manaMessages.status, 'pending')))
      .catch(() => undefined)
  }

  private async recordRun<T>(me: SessionUser, conv: ConvRow, kind: 'mana_plan' | 'mana_answer', prompt: PromptDef, user: string, model: ReasoningModel, started: number, result: StructuredResult<T> | AiProviderError): Promise<string | null> {
    const { db } = this.d
    const ok = !(result instanceof AiProviderError)
    try {
      const [run] = await db
        .insert(aiRuns)
        .values({
          jobId: null,
          patientId: conv.patientId,
          encounterId: conv.encounterId,
          kind,
          provider: model.provider,
          model: ok ? result.model : model.model,
          promptVersion: prompt.id,
          status: ok ? 'succeeded' : 'failed',
          errorCode: ok ? null : result.code,
          errorMessage: ok ? null : result.message.slice(0, 400),
          inputSha256: sha256(user),
          outputSha256: ok ? sha256(JSON.stringify(result.output)) : null,
          inputTokens: ok ? result.inputTokens : null,
          outputTokens: ok ? result.outputTokens : null,
          latencyMs: Date.now() - started,
          providerRequestId: ok ? result.requestId : null,
          locality: model.local ? 'local' : 'external',
          runtime: ok ? result.runtime : null,
          weightsSha256: ok ? result.weightsSha256 : null,
          createdBy: me.id,
        })
        .returning({ id: aiRuns.id })
      await db.insert(aiModels).values({ provider: model.provider, model: ok ? result.model : model.model, capability: 'llm' }).onConflictDoUpdate({ target: [aiModels.provider, aiModels.model, aiModels.capability], set: { lastUsedAt: new Date() } })
      return run!.id
    } catch {
      // A failure to record the run must not turn an answer into an error: the message itself carries the model and the prompts.
      return null
    }
  }

  private async run(
    req: FastifyRequest,
    me: SessionUser,
    conv: ConvRow,
    q: MsgRow,
    a: MsgRow,
    o: { question: string; preplan?: ManaPlan; resolution: null; confirmed?: ReadonlySet<string> },
    ac: AbortController,
  ): Promise<void> {
    const { db, gate, reasoning, settings, jobs } = this.d
    const model = reasoning.model!
    let held = false
    const t0 = Date.now()
    const meta: { model: string; runtime: string | null; weights: string | null; planRunId: string | null; answerRunId: string | null } = { model: model.model, runtime: null, weights: null, planRunId: null, answerRunId: null }
    const readPatients = new Set<string>()
    try {
      await jobs.ensurePrompts(db)
      await gate.acquire(ac.signal)
      held = true
      // Waiting for the model's turn can take minutes: the model is asked again whether it is there before anything is sent to it, and the doctor is checked
      // to be still who they were.
      const health = await model.health({ fresh: true })
      if (health.state !== 'ready') throw new Ended('unavailable', 'unavailable', MANA_UNAVAILABLE, true)
      await this.requireStillAllowed(me)
      const clock = await this.clock(me.facilityId)
      const book = new EntityBook(conv.entities as EntityRef[])
      const ctx: ManaCtx = { db, me, settings, scope: { encounterId: conv.encounterId, patientId: conv.patientId }, book, today: clock.today, timeZone: clock.timeZone, now: new Date(), modelIsLocal: model.local, disclosed: new Set(), textShown: new Set(), denials: [], config: this.d.config }

      // 1. What to look up. A plan that does not fit the question (a refusal of a question about the records, a change that was not asked for, no calls) is
      // sent back to the planner once, with a fixed note; what it says the second time stands.
      let plan: ManaPlan
      let planned = false
      /** What of the model's plan was cut or changed (counts by reason, no text): kept with the answer's own checks. */
      let planNotes: Record<string, number> = {}
      if (o.preplan) plan = o.preplan
      else {
        let nudge: string | null = null
        let replanned = 0
        let checked: PlanCheck | null = null
        for (let attempt = 0; attempt < 2; attempt++) {
          await this.setPhase(a.id, 'planning')
          const user = renderPlanMessage({
            today: clock.today,
            weekday: new Date(`${clock.today}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
            time: timeLabel(new Date(), clock.timeZone),
            hasCurrentPatient: !!conv.patientId,
            patients: await modelDescriptions(db, me.facilityId, clock.today, book),
            focus: conv.focus,
            earlier: await this.earlierQuestions(conv.id, q.seq),
            question: o.question,
            nudge,
          })
          const started = Date.now()
          let result: StructuredResult<ManaPlan>
          try {
            result = await this.callModel(model, { prompt: PLAN_PROMPT, user, schema: ManaPlan, schemaName: 'mana_plan', maxOutputTokens: Math.min(PLAN_MAX_TOKENS, settings.ai.reasoning.maxOutputTokens) }, ac)
          } catch (err) {
            if (err instanceof AiProviderError) await this.recordRun(me, conv, 'mana_plan', PLAN_PROMPT, user, model, started, err)
            throw err
          }
          meta.model = result.model
          meta.runtime = result.runtime
          meta.weights = result.weightsSha256
          meta.planRunId = await this.recordRun(me, conv, 'mana_plan', PLAN_PROMPT, user, model, started, result)
          checked = validatePlan(result.output, { today: clock.today, question: o.question })
          const why = attempt === 0 ? await this.doubtPlan(ctx, checked, o.question, !!conv.patientId) : null
          if (!why) break
          nudge = NUDGES[why]
          replanned++
        }
        if (!checked) throw new Ended('failed', 'plan_invalid', 'Mana could not work out what to look up. Try asking in other words.', true)
        plan = checked.plan
        planned = true
        planNotes = { ...Object.fromEntries(Object.entries(checked.adjusted).map(([k, v]) => [`plan_${k}`, v])), ...(replanned ? { plan_replanned: replanned } : {}) }
      }
      const stored: StoredPlan = { type: 'plan', plan, question: o.question, resolution: null }

      // Requests that are not for the records: a fixed answer, nothing is read.
      const policy: Partial<Record<ManaPlan['kind'], { notice: string; outcome: StoredAnswer['outcome'] }>> = {
        write_request: { notice: MANA_READ_ONLY, outcome: 'refused' },
        general_knowledge: { notice: MANA_NO_KNOWLEDGE_SOURCE, outcome: 'refused' },
        out_of_scope: { notice: MANA_OUT_OF_SCOPE, outcome: 'refused' },
        clarify: { notice: plan.clarification ?? 'Which patient, or which time, do you mean?', outcome: 'clarify' },
        other: { notice: 'Ask about this patient, today’s queue or appointments, or your consultations.', outcome: 'clarify' },
      }
      const fixed = policy[plan.kind]
      if (fixed) {
        await this.finish(req, conv, a, { stored: { outcome: fixed.outcome, notice: fixed.notice, blocks: [], findings: [], candidates: [], removed: 0 }, plan: stored, facts: [], toolRuns: [], meta, ctx, readPatients, startedAt: t0, planned, validation: planNotes })
        return
      }
      if (!plan.calls.length) throw new Ended('failed', 'plan_empty', 'Mana could not work out what to look up. Try asking in other words.', true)

      // 2. Reading. Planning took a while: the time, the day and the doctor's standing are looked at again before anything is read. A patient the doctor named
      // who is not the patient the plan is about stops the question before anything is read (unless the doctor has just chosen that patient).
      await this.setPhase(a.id, 'retrieving')
      ctx.now = new Date()
      ctx.today = (await this.clock(me.facilityId)).today
      await this.requireStillAllowed(me)
      const mismatch = await this.wrongPatientCheck(ctx, plan, o.question, o.confirmed ?? new Set())
      if (mismatch) {
        // The patients it offers are shown to the doctor by name: they are on the audit log like any patient a list shows.
        await this.recordToolCalls(req, conv, a, [], ctx, new Set())
        await this.finish(req, conv, a, { stored: { outcome: 'clarify', notice: mismatch.notice, blocks: [], findings: [], candidates: mismatch.aliases, removed: 0 }, plan: { ...stored, resolution: { callIndexes: mismatch.callIndexes } }, facts: [], toolRuns: [], meta, ctx, readPatients, startedAt: t0, planned, validation: planNotes })
        return
      }
      const toolRuns: ToolRun[] = []
      let interrupted: unknown = null
      try {
        for (const call of plan.calls) {
          if (ac.signal.aborted) throw new Ended('cancelled', 'cancelled', 'This question was stopped.', true)
          const started = Date.now()
          const out = await runTool(ctx, call)
          toolRuns.push({ call, o: out, ms: Date.now() - started })
          if (out.patientId && out.status === 'ok') readPatients.add(out.patientId)
        }
      } catch (e) {
        interrupted = e
      }
      // What was read is on the record whatever happened next (a stop between two tools included): "who looked at this patient" must be answerable. If the audit log
      // cannot be written, the question fails and nothing is shown.
      await this.recordToolCalls(req, conv, a, toolRuns, ctx, readPatients)
      if (interrupted) throw interrupted

      // A name that fits several patients: nothing is guessed, the doctor chooses. One call at a time: the patients offered are the ones THAT call matched, and
      // choosing one settles that call only (a second name that is ambiguous is asked about next).
      const ambiguous = toolRuns.findIndex((t) => t.o.status === 'ambiguous')
      if (ambiguous >= 0) {
        const aliases = [...new Set(toolRuns[ambiguous]!.o.candidates)].slice(0, 5)
        await this.finish(req, conv, a, { stored: { outcome: 'ambiguous', notice: 'I found multiple matching patients. Please select one.', blocks: [], findings: [], candidates: aliases, removed: 0 }, plan: { ...stored, resolution: { callIndexes: [ambiguous] } }, facts: [], toolRuns, meta, ctx, readPatients, startedAt: t0, planned, validation: planNotes })
        return
      }

      // 3. What the tools returned, as facts and findings. Text that reads like an instruction to an AI system is not shown to the model.
      const gathered = gather(toolRuns)
      const allRefused = toolRuns.every((t) => t.o.status === 'refused')
      if (allRefused) {
        const reasons = [...new Set(toolRuns.map((t) => t.o.detail))].join(' ')
        await this.finish(req, conv, a, { stored: { outcome: 'refused', notice: reasons, blocks: [], findings: [], candidates: [], removed: 0 }, plan: stored, facts: [], toolRuns, meta, ctx, readPatients, startedAt: t0, planned, validation: planNotes })
        return
      }
      if (toolRuns.every((t) => t.o.status === 'error')) throw new Ended('failed', 'lookup_failed', 'The records could not be read just now. You can try again.', true)

      // 4. The answer, written from the facts only, and checked.
      let blocks: ManaAnswerBlock[] = []
      let removed = 0
      let produced = 0
      let blocked: string | null = null
      let reasons: Record<string, number> = {}
      let shown: AnswerFact[] = []
      const findings = [...gathered.findings]
      if (gathered.facts.length) {
        await this.setPhase(a.id, 'writing')
        const msg = renderAnswerMessage({ today: clock.today, question: o.question, facts: gathered.facts, findings: gathered.findings, maxChars: Math.min(settings.ai.reasoning.maxContextChars, ANSWER_MAX_CHARS) })
        shown = msg.shown
        if (msg.omitted) findings.push({ ref: `F${findings.length + 1}`, kind: 'absent', text: `${msg.omitted} more statement(s) were read but did not fit what the model can take at once. Ask a narrower question to see them.`, items: [] })
        const started = Date.now()
        let result: StructuredResult<ManaModelAnswer>
        try {
          result = await this.callModel(model, { prompt: ANSWER_PROMPT, user: msg.text, schema: ManaModelAnswer, schemaName: 'mana_answer', maxOutputTokens: Math.min(ANSWER_MAX_TOKENS, settings.ai.reasoning.maxOutputTokens) }, ac)
        } catch (err) {
          if (err instanceof AiProviderError) await this.recordRun(me, conv, 'mana_answer', ANSWER_PROMPT, msg.text, model, started, err)
          throw err
        }
        meta.model = result.model
        meta.runtime = result.runtime
        meta.weights = result.weightsSha256
        meta.answerRunId = await this.recordRun(me, conv, 'mana_answer', ANSWER_PROMPT, msg.text, model, started, result)
        await this.setPhase(a.id, 'verifying')
        const entities = await describePatients(db, me.facilityId, clock.today, book, book.all().map((r) => r.patientId))
        const checks = checkAnswer(result.output, {
          question: o.question,
          facts: shown,
          findings: gathered.findings.filter((f) => f.kind !== 'untrusted'),
          aliases: new Set(book.all().map((r) => r.alias)),
          patientNames: [...new Set(entities.flatMap((e) => e.displayName.toLowerCase().split(/[\s'’-]+/)).filter((w) => w.length >= 3))],
          today: clock.today,
          outdatedDays: settings.mana.outdatedDays,
        })
        blocks = checks.blocks
        removed = checks.removed
        produced = checks.produced
        blocked = checks.blocked
        reasons = checks.reasons
      }

      // What the question asked for and the plan could not use is said, not dropped quietly.
      if (planNotes.plan_too_many_patients) findings.push({ ref: `F${findings.length + 1}`, kind: 'absent', text: `Mana reads at most ${MAX_PATIENTS_PER_QUESTION} patients for one question, so it looked up the first ${MAX_PATIENTS_PER_QUESTION}. Ask about the others separately.`, items: [] })
      if (planNotes.plan_date_not_valid) findings.push({ ref: `F${findings.length + 1}`, kind: 'absent', text: 'A date in the question was not a real date within three years of today, so it was not used.', items: [] })

      const unverified = produced > 0 && blocks.length === 0
      const outcome: StoredAnswer['outcome'] = blocks.length ? 'answered' : 'not_established'
      // What "no answer" means depends on what happened: the tools found nothing (not recorded); the model wrote nothing the checks could use (it may have judged
      // that the records do not answer the question); or part of what was read was kept from the model (so the answer is not complete).
      const withheld = gathered.findings.some((f) => f.kind === 'untrusted')
      const notice = noticeFor({ unverified, blocks: blocks.length, withheld, facts: gathered.facts.length })
      await this.finish(req, conv, a, {
        stored: { outcome, notice, blocks, findings: findings.map((f) => ({ ref: f.ref, kind: f.kind, text: f.text, items: f.items })), candidates: [], removed },
        plan: stored,
        facts: shown,
        toolRuns,
        meta,
        ctx,
        readPatients,
        startedAt: t0,
        planned,
        validation: { ...planNotes, ...reasons },
        unverified: unverified ? (blocked ?? 'nothing_verified') : null,
      })
    } catch (err) {
      await this.markFailed(req, conv, a, err)
      // What is expected (a refusal, a model that is not there, a stop, a limit) is told to the doctor and needs no log line; anything else, a server error included, is logged.
      const expected = err instanceof Ended || err instanceof AiProviderError || err instanceof TooManyPatients || (err instanceof Error && err.message === 'aborted') || (err instanceof HttpError && err.statusCode < 500)
      if (!expected) req.log.error({ err, messageId: a.id }, 'Mana answer failed unexpectedly')
    } finally {
      if (held) gate.release()
      this.running.delete(a.id)
    }
  }

  private async earlierQuestions(conversationId: string, beforeSeq: number): Promise<string[]> {
    const rows = await this.d.db
      .select({ text: manaMessages.text })
      .from(manaMessages)
      .where(and(eq(manaMessages.conversationId, conversationId), eq(manaMessages.role, 'doctor'), sql`${manaMessages.seq} < ${beforeSeq}`, sql`(${manaMessages.plan} is null or ${manaMessages.plan}->>'type' is distinct from 'selection')`))
      .orderBy(desc(manaMessages.seq))
      .limit(EARLIER_QUESTIONS)
    return rows.map((r) => r.text ?? '').reverse()
  }

  /** Why the first plan should be looked at again (see `suspectPlan`), or null. A plan that is no plan at all is looked at again too. */
  private async doubtPlan(ctx: ManaCtx, checked: PlanCheck | null, question: string, hasCurrentPatient: boolean): Promise<keyof typeof NUDGES | null> {
    if (!checked) return 'unusable'
    const refusing = checked.plan.kind === 'out_of_scope' || checked.plan.kind === 'general_knowledge'
    // Whether the doctor named a patient of this clinic is only asked when the plan refused (and the doctor may read patients at all).
    const namesPatient = refusing && can(ctx.me.role, 'patients:read') && nameRunsIn(question).length > 0 ? (await patientsNamedIn(this.d.db, ctx.me.facilityId, question)).length > 0 : false
    return suspectPlan(checked.plan, question, { namesPatient, hasCurrentPatient })
  }

  /**
   * "What about Anita's allergies?" asked inside Meena's consultation, with a plan about "the current patient": the answer would be about the wrong person. When the
   * doctor's words name a patient of this clinic and a patient-reading call of the plan resolves to someone else, nothing is read: the doctor is asked which one.
   * A name in the question is a run of capitalised words ("Rahul Sharma"); the plan is about the patient it names only if that patient's name has EVERY word of the
   * run (so "Rahul Sharma" is not Rahul Verma, and "D'Souza" and "Al-Haddad" are compared as the doctor wrote them). A name written in lower case is not noticed.
   */
  private async wrongPatientCheck(ctx: ManaCtx, plan: ManaPlan, question: string, confirmed: ReadonlySet<string>): Promise<{ notice: string; aliases: string[]; callIndexes: number[] } | null> {
    const patientCalls = plan.calls.flatMap((c, i) => (PATIENT_TOOLS.has(c.tool) ? [{ c, i }] : []))
    if (!patientCalls.length) return null
    // Names of patients are not looked at for someone who may not read patients: the tools refuse them anyway.
    if (!can(ctx.me.role, 'patients:read')) return null
    const runs = nameRunsIn(question)
    if (!runs.length) return null
    const named = await patientsNamedIn(this.d.db, ctx.me.facilityId, question)
    if (!named.length) return null
    const partsOf = (w: string): string[] => [w, ...w.split(/['-]/).filter((x) => x.length >= 2)]
    const namedTokens = new Map(named.map((p) => [p.id, nameTokens(fullName(p))]))
    // A run names someone of this clinic when some patient has a word of it; the others ("Penicillin", "General Medicine") are not names of patients.
    const naming = runs.filter((run) => [...namedTokens.values()].some((tokens) => run.some((w) => partsOf(w).some((x) => tokens.has(x)))))
    if (!naming.length) return null
    const resolved: { i: number; patientId: string; tokens: Set<string> }[] = []
    for (const { c, i } of patientCalls) {
      const h = await resolveHandle(ctx, c.patient)
      if (h.kind !== 'one' || confirmed.has(h.patientId)) continue
      resolved.push({ i, patientId: h.patientId, tokens: nameTokens(fullName(await getPatientOr404(this.d.db, ctx.me.facilityId, h.patientId))) })
    }
    const mismatched = resolved.filter((r) => !naming.some((run) => coversRun(r.tokens, run)))
    if (!mismatched.length) return null
    // The patient the plan was about is always among the ones offered (the doctor may have meant exactly that one), then the patients whose name has the most words
    // of what the doctor wrote.
    const score = (p: { id: string }): number => Math.max(...naming.map((run) => run.filter((w) => partsOf(w).some((x) => namedTokens.get(p.id)!.has(x))).length))
    const ranked = [...named].sort((x, y) => score(y) - score(x))
    const candidates = [...new Set([...mismatched.map((m) => m.patientId), ...ranked.map((n) => n.id)])].slice(0, 5)
    const aliases = candidates.map((id) => ctx.book.aliasFor(id))
    for (const id of candidates) ctx.disclosed.add(id)
    const shown = await describePatients(this.d.db, ctx.me.facilityId, ctx.today, ctx.book, candidates)
    const nameOf = (id: string) => shown.find((e) => e.alias === ctx.book.aliasOf(id))?.displayName ?? 'that patient'
    const capital = (w: string) => w.replace(/(^|['’-])(\p{L})/gu, (_m, a: string, b: string) => `${a}${b.toUpperCase()}`)
    const unserved = naming.filter((run) => !resolved.some((r) => coversRun(r.tokens, run)))
    // What the doctor named, in words: the patient (or two) whose name has every word of what was written, and, when there is no such patient or there are many, what was written.
    const typed = (unserved.length ? unserved : naming)
      .slice(0, 2)
      .map((run) => {
        const exact = named.filter((p) => coversRun(namedTokens.get(p.id)!, run) && candidates.includes(p.id))
        return exact.length >= 1 && exact.length <= 2 ? exact.map((p) => nameOf(p.id)).join(' or ') : run.map(capital).join(' ')
      })
      .join(' and ')
    return {
      notice: `Your question names ${typed}, but I was about to look at ${[...new Set(mismatched.map((m) => nameOf(m.patientId)))].join(' and ')}. Which patient do you mean?`,
      aliases,
      callIndexes: mismatched.map((m) => m.i),
    }
  }

  /**
   * What each tool was asked and how it ended (no clinical text), who read which patient's record, which patients a list or a clarification showed, and the lookups
   * refused as "not found" that the audit log must tell apart (a patient of another clinic): all written in ONE transaction, so that what was read is on the audit
   * log or the question fails. Nothing is shown to the doctor unless this was written.
   */
  private async recordToolCalls(req: FastifyRequest, conv: ConvRow, a: MsgRow, runs: ToolRun[], ctx: ManaCtx, readIds: ReadonlySet<string>): Promise<void> {
    if (!runs.length && !ctx.disclosed.size && !ctx.denials.length) return
    await this.d.db.transaction(async (tx) => {
      if (runs.length) {
        await tx.insert(manaToolCalls).values(
          runs.map((t, i) => ({
            messageId: a.id,
            position: i,
            tool: t.call.tool,
            args: t.call,
            status: t.o.status,
            detail: t.o.detail.slice(0, 300),
            patientId: t.o.patientId,
            sourceCount: t.o.facts.reduce((n, f) => n + f.items.length, 0),
            durationMs: t.ms,
          })),
        )
      }
      for (const t of runs) {
        await audit(tx, req, {
          action: t.o.status === 'refused' ? 'mana.access_refused' : 'mana.tool_run',
          outcome: t.o.status === 'refused' ? 'denied' : t.o.status === 'error' ? 'failure' : 'success',
          entityType: 'mana_message',
          entityId: a.id,
          patientId: t.o.patientId,
          details: { conversationId: conv.id, tool: t.call.tool, status: t.o.status, facts: t.o.facts.length, findings: t.o.findings.length },
        })
      }
      await this.auditShown(tx, req, conv, a, ctx, new Set([...readIds, ...runs.flatMap((t) => (t.o.patientId ? [t.o.patientId] : []))]))
    })
  }

  /**
   * Patients that were SHOWN without their record being read (a list: the queue, check-ins, appointments, the doctor's day; the matches of a name; the patients a
   * clarification offers) are on the audit log one by one, as the patients whose records were read are: "who looked at this patient" must be answerable for them
   * too. Lookups that were refused as "not found" but that the audit log must tell apart (a patient of another clinic) are written here as well, once each.
   */
  private async auditShown(db: DbOrTx, req: FastifyRequest, conv: ConvRow, a: MsgRow, ctx: ManaCtx, readIds: ReadonlySet<string>): Promise<void> {
    for (const patientId of ctx.disclosed) {
      if (readIds.has(patientId)) continue
      await audit(db, req, { action: 'mana.patient_listed', entityType: 'patient', entityId: patientId, patientId, details: { conversationId: conv.id, messageId: a.id } })
    }
    const done = new Set<string>()
    for (const d of ctx.denials.splice(0)) {
      const key = `${d.entityType}:${d.entityId}:${d.reason ?? ''}`
      if (done.has(key)) continue
      done.add(key)
      await audit(db, req, { action: 'access.not_found', outcome: 'denied', entityType: d.entityType, entityId: d.entityId, details: { code: 'not_found', via: 'mana', ...(d.reason ? { reason: d.reason } : {}) } })
    }
  }

  /**
   * Stores how a question ended and writes its audit event, in one transaction. Consent is read again first: if a patient whose record was read has withdrawn
   * consent to AI help while the answer was being made, nothing of it is kept.
   */
  private async finish(
    req: FastifyRequest,
    conv: ConvRow,
    a: MsgRow,
    f: {
      stored: StoredAnswer
      plan: StoredPlan
      facts: AnswerFact[]
      toolRuns: ToolRun[]
      meta: { model: string; runtime: string | null; weights: string | null; planRunId: string | null; answerRunId: string | null }
      ctx: ManaCtx
      readPatients: Set<string>
      startedAt: number
      planned: boolean
      validation: Record<string, number>
      unverified?: string | null
      /**
       * HERO final: an answer composed by fixed rules: no model was asked (none is named on it), `subjects` are the patients it is about, and `extra` writes
       * further audit events (a proposed action) in the same transaction.
       */
      rules?: { intent: RulesIntent['kind']; subjects: string[]; extra?: (tx: DbOrTx) => Promise<void> }
    },
  ): Promise<void> {
    const { db, reasoning } = this.d
    const model = f.rules ? null : reasoning.model!
    // The doctor must still be who they were when the answer is kept (the answer can take minutes).
    await this.requireStillAllowed(f.ctx.me)
    const status: ManaMessageStatus = f.unverified ? 'unverified' : f.stored.outcome === 'refused' ? 'refused' : 'ready'
    const fromTools = f.toolRuns.flatMap((t) => (t.o.patientId ? [f.ctx.book.aliasOf(t.o.patientId)] : []))
    const fromRules = (f.rules?.subjects ?? []).map((id) => f.ctx.book.aliasOf(id))
    const patients = [...new Set([...fromTools, ...fromRules].filter((a): a is string => !!a))]
    const stored: StoredAnswer = { ...f.stored, patients }
    await db.transaction(async (tx) => {
      // Fixed answers and choices read nothing; an answer that read a patient's record is checked against the patient's consent as it stands NOW, in the same
      // transaction that keeps the answer: a patient who withdrew consent while it was being made (a minute or more) has none of it kept.
      // The patients whose records were read, and those whose free text a list showed: each consent is read inside the transaction and locked against a withdrawal
      // until it ends.
      for (const pid of new Set([...f.readPatients, ...f.ctx.textShown])) {
        if (await consentRefusal(f.ctx, tx, pid, true)) throw new Ended('failed', 'consent_changed', 'A patient’s consent to AI help with their record changed while the answer was being made, so nothing was kept.', false)
      }
      const [done] = await tx
        .update(manaMessages)
        .set({
          status,
          phase: null,
          plan: f.plan,
          answer: stored,
          provider: model?.provider ?? null,
          model: model ? f.meta.model : null,
          runtime: model ? f.meta.runtime : null,
          weightsSha256: model ? f.meta.weights : null,
          locality: model ? (model.local ? 'local' : 'external') : null,
          planPromptId: f.planned ? PLAN_PROMPT.id : null,
          answerPromptId: model && f.facts.length ? ANSWER_PROMPT.id : null,
          schemaVersion: MANA_CONTRACT_VERSION,
          checksVersion: model ? `${PLAN_CHECKS_VERSION}+${ANSWER_CHECKS_VERSION}` : RULES_VERSION,
          toolsVersion: model ? TOOLS_VERSION : RULES_VERSION,
          validation: f.validation,
          planRunId: f.meta.planRunId,
          answerRunId: f.meta.answerRunId,
          latencyMs: Date.now() - f.startedAt,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(manaMessages.id, a.id), eq(manaMessages.status, 'pending')))
        .returning({ id: manaMessages.id })
      // Stopped (or swept) while it was being made: what was made is not kept.
      if (!done) throw new Ended('cancelled', 'cancelled', 'This question was stopped.', true)
      if (f.facts.length) {
        const factOf = new Map<string, ManaSourceKind>()
        await tx.insert(manaMessageSources).values(
          f.facts.map((s) => {
            const kind: ManaSourceKind = s.items[0]?.kind ?? 'operational'
            factOf.set(s.ref, kind)
            return { messageId: a.id, ref: s.ref, kind, label: s.items[0]?.label ?? 'Records', text: s.text, patientId: s.patient ? (f.ctx.book.patientIdOf(s.patient) ?? null) : null, items: s.items }
          }),
        )
      }
      const focusRun = [...f.toolRuns].reverse().find((t) => t.o.status === 'ok' && t.o.patientId)
      const ruleSubject = f.rules?.subjects.length === 1 ? f.ctx.book.aliasOf(f.rules.subjects[0]!) : null
      const focus = focusRun?.o.patientId ? f.ctx.book.aliasOf(focusRun.o.patientId) : (ruleSubject ?? conv.focus)
      await tx.update(manaConversations).set({ entities: f.ctx.book.all(), focus, updatedAt: new Date() }).where(eq(manaConversations.id, conv.id))
      const cited = new Set(f.stored.blocks.flatMap((b) => b.refs))
      await audit(tx, req, {
        action: f.unverified ? 'mana.answer_unverified' : 'mana.answer',
        outcome: f.stored.outcome === 'refused' ? 'denied' : f.unverified ? 'failure' : 'success',
        entityType: 'mana_message',
        entityId: a.id,
        patientId: conv.patientId,
        details: {
          conversationId: conv.id,
          outcome: f.stored.outcome,
          tools: f.toolRuns.map((t) => `${t.call.tool}:${t.o.status}`),
          blocks: f.stored.blocks.length,
          removed: f.stored.removed,
          findings: f.stored.findings.length,
          sourcesRead: f.facts.length,
          sourcesCited: cited.size,
          patientsRead: [...f.readPatients].length,
          disclosed: [...f.ctx.disclosed].length,
          validation: f.validation,
          ...(f.unverified ? { unverifiedBecause: f.unverified } : {}),
          ...(model ? { model: { provider: model.provider, model: f.meta.model, local: model.local } } : { engine: 'rules', intent: f.rules?.intent ?? null, action: stored.action ? stored.action.kind : null }),
          latencyMs: Date.now() - f.startedAt,
        },
      })
      await f.rules?.extra?.(tx)
    })
  }

  /** How an answer that did not come about ended. Only a message that is still pending can be marked: a stop that came first stands. */
  private async markFailed(req: FastifyRequest, conv: ConvRow, a: MsgRow, err: unknown): Promise<void> {
    let status: ManaMessageStatus = 'failed'
    let code = 'internal_error'
    let message = 'Mana could not answer just now. You can try again.'
    let retryable = true
    if (err instanceof Ended) {
      status = err.status
      code = err.code
      message = err.message
      retryable = err.retryable
    } else if (err instanceof AiProviderError) {
      code = err.code
      retryable = err.retryable
      if (['unavailable', 'loading', 'unauthorized'].includes(err.code)) {
        status = 'unavailable'
        message = MANA_UNAVAILABLE
      } else if (err.code === 'cancelled') {
        status = 'cancelled'
        message = 'This question was stopped.'
      } else message = err.code === 'timeout' || err.code === 'invalid_output' ? err.message : 'Mana could not answer just now. You can try again.'
    } else if (err instanceof Error && err.message === 'aborted') {
      status = 'cancelled'
      code = 'cancelled'
      message = 'This question was stopped.'
    } else if (err instanceof HttpError) {
      code = err.code
      retryable = err.statusCode >= 500
      if (err.statusCode < 500) message = err.message
    } else if (err instanceof TooManyPatients) {
      code = 'too_many_patients'
      message = err.message
      retryable = false
    }
    const [done] = await this.d.db
      .update(manaMessages)
      .set({ status, phase: null, errorCode: code, errorMessage: message.slice(0, 400), retryable, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(manaMessages.id, a.id), eq(manaMessages.status, 'pending')))
      .returning({ id: manaMessages.id })
      .catch(() => [])
    if (done) {
      // A consent that changed, or a session that ended, while the answer was being made is a refusal, not a fault.
      const refused = code === 'consent_changed' || code === 'session_ended'
      await audit(this.d.db, req, { action: status === 'cancelled' ? 'mana.answer_cancelled' : 'mana.answer_failed', outcome: status === 'cancelled' ? 'success' : refused ? 'denied' : 'failure', entityType: 'mana_message', entityId: a.id, patientId: conv.patientId, details: { conversationId: conv.id, code, status } }).catch(() => undefined)
    }
  }

  // --- stopping and recovering ------------------------------------------------------------------------------------------------------------

  /** The doctor stopped waiting. The model call (and any wait for the model) ends, and nothing it was making is kept. */
  async cancel(req: FastifyRequest, me: SessionUser, messageId: string): Promise<ManaConversationState> {
    const { db } = this.d
    const [row] = await db.select().from(manaMessages).where(eq(manaMessages.id, messageId))
    if (!row) throw new HttpError(404, 'not_found', 'Message not found')
    const conv = await this.convOr404(me, row.conversationId)
    if (row.role !== 'mana' || row.status !== 'pending') throw conflict('Mana is not answering that any more', 'not_pending')
    const [done] = await db
      .update(manaMessages)
      .set({ status: 'cancelled', phase: null, errorCode: 'cancelled', errorMessage: 'This question was stopped.', retryable: true, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(manaMessages.id, messageId), eq(manaMessages.status, 'pending')))
      .returning({ id: manaMessages.id })
    // It finished first: nothing was cancelled, and nothing is said to have been.
    if (done) {
      this.running.get(messageId)?.abort()
      await audit(db, req, { action: 'mana.answer_cancelled', entityType: 'mana_message', entityId: messageId, patientId: conv.patientId, details: { conversationId: conv.id, code: 'cancelled', status: 'cancelled' } })
    }
    return this.state(me, conv)
  }

  /**
   * Answers that were being made when the server stopped cannot continue: they are failed (retryable) so their doctor can ask again. It fails EVERY pending
   * answer in the database, which is right for the one server this system runs as; a second server (or a rolling restart) on the same database would fail the
   * first one's live answers, and would need this to be limited to the answers its own process started.
   */
  async sweepInterrupted(): Promise<number> {
    const rows = await this.d.db
      .update(manaMessages)
      .set({ status: 'failed', phase: null, errorCode: 'interrupted', errorMessage: 'This answer was interrupted (the system restarted or stopped). You can ask again.', retryable: true, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(manaMessages.role, 'mana'), eq(manaMessages.status, 'pending')))
      .returning({ id: manaMessages.id })
    return rows.length
  }

  /** Stops every model call in progress (the server is closing). */
  abortAll(): void {
    for (const ac of this.running.values()) ac.abort()
  }
}

// --- what the tools returned, as the model and the doctor are shown it ---------------------------------------------------------------------------

const UNTRUSTED_TEXT = 'A record holds text that reads like an instruction to an AI system. Mana did not use it. You can read it in the record.'

/** Whether a tool's own account of why it found nothing is a sentence a doctor can read (the tools write some, and short labels for the details view). */
const readable = (s: string): string | null => (sentence(s) ? s : null)

export interface Gathered {
  facts: AnswerFact[]
  findings: AnswerFinding[]
}

/**
 * Numbers what the tools returned (S1, S2 ... for facts, F1 ... for findings), withholds text that reads like an instruction to an AI system (and says so, once
 * per record), and turns the tools' failures and empty results into findings the doctor reads. The model is shown the facts, and the findings except the ones
 * about withheld text.
 */
export function gather(runs: ToolRun[]): Gathered {
  const facts: AnswerFact[] = []
  const findings: AnswerFinding[] = []
  let s = 0
  let f = 0
  const withheld = new Set<string>()
  const untrusted = (items: AnswerFact['items']) => {
    const key = items.map((i) => `${i.label}|${i.excerpt}`).join('||') || `n${withheld.size}`
    if (withheld.has(key)) return
    withheld.add(key)
    findings.push({ ref: `F${++f}`, kind: 'untrusted', text: UNTRUSTED_TEXT, items })
  }
  for (const { o } of runs) {
    for (const fact of o.facts) {
      if (looksLikeInstruction(fact.text)) untrusted(fact.items)
      else facts.push({ ref: `S${++s}`, text: fact.text, patient: fact.patient, items: fact.items, ...(fact.trust ? { trust: fact.trust } : {}) })
    }
    for (const fi of o.findings) {
      if (looksLikeInstruction(fi.text)) untrusted(fi.items)
      else findings.push({ ref: `F${++f}`, kind: fi.kind, text: fi.text, items: fi.items })
    }
    if (!o.findings.length && !o.facts.length) {
      if (o.status === 'not_found' || o.status === 'empty') findings.push({ ref: `F${++f}`, kind: 'absent', text: readable(o.detail) ?? 'Nothing matching was found in the records you can read.', items: [] })
      else if (o.status === 'invalid') findings.push({ ref: `F${++f}`, kind: 'absent', text: `Mana could not use part of the question: ${readable(o.detail) ?? 'something was missing.'}`, items: [] })
      else if (o.status === 'error') findings.push({ ref: `F${++f}`, kind: 'absent', text: 'A lookup failed, so that part is not answered.', items: [] })
    }
    if (o.status === 'refused') findings.push({ ref: `F${++f}`, kind: 'absent', text: `Not read: ${o.detail}`, items: [] })
  }
  return { facts, findings }
}

export const newKey = () => crypto.randomUUID()
