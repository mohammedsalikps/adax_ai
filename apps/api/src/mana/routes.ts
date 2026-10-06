import { AskManaRequest, type ManaAnswer, type ManaGenerationStatus, ManaIntent, type ManaSection, type ManaSource, type ManaStatement } from '@adaxai/contracts'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { type JobService, sha256 } from '../ai/jobs.ts'
import type { AiProviders, CitedText } from '../ai/providers.ts'
import type { JobExecutor } from '../ai/routes.ts'
import { makeScrubber } from '../ai/text.ts'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Db } from '../db/client.ts'
import { aiJobs, aiReviewActions, aiRuns, facilities, manaQuestions, noteInsertions, patients, users } from '../db/schema.ts'
import { conflict, HttpError, notFound } from '../http/errors.ts'
import { parse } from '../http/validate.ts'
import { consentState } from '../consents/service.ts'
import { getPatientOr404 } from '../patients/service.ts'
import type { AppSettings } from '../settings/schema.ts'
import { answerFromRecord, classifyQuestion, itemsForGeneration, MANA_RULES_VERSION } from './answers.ts'
import { loadPatientRecord, toSource } from './record.ts'

export interface ManaDeps {
  db: Db
  providers: AiProviders
  settings: AppSettings
  jobs: JobService
  executors: Map<string, JobExecutor>
  dataOrigin: 'clinical' | 'synthetic'
}

type QuestionRow = typeof manaQuestions.$inferSelect
type JobRow = typeof aiJobs.$inferSelect

const IdParams = z.object({ id: z.uuid() })
const MAX_GENERATED = 12
const MAX_CONFLICTS = 8
/** A question left 'pending' this long (server stopped mid-request) may be retried. */
const STALE_PENDING_MS = 10 * 60_000

interface Generated {
  statements: ManaStatement[]
  notFound: string[]
}

/** Calendar day in the facility's timezone (date-only values are already days). */
const localDay = (d: string, timeZone: string) => (d.length === 10 ? d : new Date(d).toLocaleDateString('en-CA', { timeZone }))

/** Record lines exactly as the AI provider sees them (also the input checksum). */
const recordLines = (items: ManaSource[], timeZone: string) => items.map((s) => `[${s.ref}] ${s.date ? localDay(s.date, timeZone) : 'undated'} · ${s.field} · ${s.status}: ${s.excerpt}`).join('\n')

/** Generated statements keep only citations that exist among the items sent; uncited ones are flagged. */
export function verifyCitations(out: { statements: CitedText[]; conflicts: CitedText[]; notFound: string[] }, sent: Set<string>): Generated {
  const clean = (c: CitedText, kind: 'generated' | 'conflict'): ManaStatement => {
    const refs = [...new Set(c.refs.map((r) => r.trim().replace(/^\[|\]$/g, '')))].filter((r) => sent.has(r))
    return { kind, text: c.text.trim().slice(0, 1000), refs, unsupported: refs.length === 0 }
  }
  // Separate caps, so a long list of statements can never push conflicts out.
  const statements = out.statements.map((s) => clean(s, 'generated')).filter((s) => s.text).slice(0, MAX_GENERATED)
  const conflicts = out.conflicts.map((s) => clean(s, 'conflict')).filter((s) => s.text).slice(0, MAX_CONFLICTS)
  return {
    statements: [...statements, ...conflicts],
    notFound: out.notFound
      .map((n) => n.trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 10),
  }
}

export function registerManaRoutes(app: FastifyInstance, deps: ManaDeps) {
  const { db, providers, settings, jobs, executors } = deps
  const rules = { safety: settings.safety, outdatedDays: settings.mana.outdatedDays }

  async function toAnswer(rows: QuestionRow[]): Promise<ManaAnswer[]> {
    if (!rows.length) return []
    const ids = rows.map((r) => r.id)
    const askers = await db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((r) => r.askedBy))]))
    const runIds = rows.flatMap((r) => (r.runId ? [r.runId] : []))
    const runs = runIds.length ? await db.select().from(aiRuns).where(inArray(aiRuns.id, runIds)) : []
    const reviews = await db
      .select({ subjectId: aiReviewActions.subjectId, at: aiReviewActions.createdAt, by: users.fullName })
      .from(aiReviewActions)
      .innerJoin(users, eq(users.id, aiReviewActions.actorId))
      .where(and(eq(aiReviewActions.subjectType, 'mana_answer'), eq(aiReviewActions.action, 'reviewed'), inArray(aiReviewActions.subjectId, ids)))
      .orderBy(desc(aiReviewActions.createdAt))
    const inserted = await db
      .select({ subjectId: noteInsertions.subjectId, n: sql<number>`count(*)::int` })
      .from(noteInsertions)
      .where(and(eq(noteInsertions.subjectType, 'mana_answer'), inArray(noteInsertions.subjectId, ids)))
      .groupBy(noteInsertions.subjectId)
    const jobRows = rows.some((r) => r.jobId) ? await db.select().from(aiJobs).where(inArray(aiJobs.id, rows.flatMap((r) => (r.jobId ? [r.jobId] : [])))) : []
    return rows.map((r) => {
      const run = runs.find((x) => x.id === r.runId)
      const job = jobRows.find((j) => j.id === r.jobId)
      const review = reviews.find((x) => x.subjectId === r.id)
      const gen = (r.generated as Generated | null) ?? { statements: [], notFound: [] }
      return {
        id: r.id,
        patientId: r.patientId,
        encounterId: r.encounterId,
        question: r.question,
        intent: ManaIntent.parse(r.intent),
        createdAt: r.createdAt.toISOString(),
        askedByName: askers.find((a) => a.id === r.askedBy)?.name ?? null,
        record: { rulesVersion: r.rulesVersion, sections: r.recordAnswer as ManaSection[] },
        generation: {
          status: r.generationStatus as ManaGenerationStatus,
          reason: r.generationReason,
          retryable: r.generationStatus === 'failed' && (r.generationRetryable || !!job?.retryable),
          jobId: r.jobId,
          provider: run?.provider ?? null,
          model: run?.model ?? null,
          promptVersion: run?.promptVersion ?? null,
          statements: gen.statements,
          notFound: gen.notFound,
        },
        sources: r.sources as ManaSource[],
        review: { reviewedAt: review?.at.toISOString() ?? null, reviewedByName: review?.by ?? null },
        insertions: inserted.find((x) => x.subjectId === r.id)?.n ?? 0,
      }
    })
  }

  /** Whether the AI part may run, and if not, why (shown to the doctor; never replaced by placeholder text). */
  async function generationGate(patientId: string, generate: boolean): Promise<{ status: ManaGenerationStatus; reason: string | null; consentState?: string }> {
    if (!generate) return { status: 'not_requested', reason: 'Answer read from the record only; no AI summary was requested.' }
    if (!providers.qa) return { status: 'unavailable', reason: providers.reasons.qa ?? providers.reasons.llm ?? 'No AI provider is configured.' }
    const { state } = await consentState(db, patientId, 'ai_record_assistant')
    if (state === 'withdrawn') return { status: 'consent_required', consentState: state, reason: 'The patient has withdrawn consent to Mana AI record summaries, so nothing is sent to the AI service. The answer above is read directly from the record.' }
    if (state === 'not_recorded') return { status: 'consent_required', consentState: state, reason: 'The patient has not consented to Mana AI record summaries (record it under Consents on the patient record). The answer above is read directly from the record.' }
    if (state === 'outdated') return { status: 'consent_required', consentState: state, reason: 'The patient agreed to an earlier wording of the Mana AI consent; read the current wording and record consent again.' }
    return { status: 'pending', reason: null }
  }

  /** Runs (or re-runs) the AI summary for a question from its stored source snapshot. */
  async function generate(req: FastifyRequest, q: QuestionRow, job: JobRow): Promise<void> {
    const qa = providers.qa
    // Consent is checked again on every run, including retries: if the patient
    // withdrew it (or the wording changed) since the question was asked, nothing is sent.
    const gate = await generationGate(q.patientId, true)
    if (gate.status === 'consent_required') {
      await audit(db, req, { action: 'mana.ai_blocked', outcome: 'denied', entityType: 'mana_question', entityId: q.id, patientId: q.patientId, details: { reason: 'consent_required', jobId: job.id } })
      throw new HttpError(409, 'consent_required', gate.reason!)
    }
    const input = job.input as { questionId: string; sentRefs: string[]; patientLine: string }
    const sent = new Set(input.sentRefs)
    const items = (q.sources as ManaSource[]).filter((s) => sent.has(s.ref))
    const patient = (await db.query.patients.findFirst({ where: eq(patients.id, q.patientId) }))!
    const question = makeScrubber(patient)(q.question)
    const timeZone = (await db.query.facilities.findFirst({ where: eq(facilities.id, q.facilityId) }))?.timezone ?? 'UTC'
    const recordText = recordLines(items, timeZone)
    const failureRun = () => ({ kind: 'patient_qa', provider: qa?.provider ?? 'none', model: qa?.model ?? 'none', capability: 'llm' as const, promptVersion: qa?.promptVersion ?? null, inputSha256: sha256(recordText + question) })
    try {
      await jobs.attempt(
        req,
        job,
        async () => {
          if (!qa) throw new HttpError(503, 'unavailable', providers.reasons.qa ?? 'No AI provider is configured.')
          const out = await qa.answer({ patientLine: input.patientLine, recordText, question })
          const generated = verifyCitations(out, sent)
          return {
            run: { kind: 'patient_qa', provider: qa.provider, model: out.model, capability: 'llm', promptVersion: qa.promptVersion, inputSha256: sha256(recordText + question), outputSha256: sha256(JSON.stringify(generated)), inputTokens: out.inputTokens, outputTokens: out.outputTokens, providerRequestId: out.requestId },
            summary: { statements: generated.statements.length, unsupported: generated.statements.filter((s) => s.unsupported).length, notFound: generated.notFound.length, itemsSent: items.length },
            persist: async (tx, runId) => {
              await tx.update(manaQuestions).set({ generationStatus: 'succeeded', generationReason: null, generationRetryable: false, generated, jobId: job.id, runId, updatedAt: new Date() }).where(eq(manaQuestions.id, q.id))
            },
          }
        },
        failureRun,
      )
    } catch (e) {
      if (!(e instanceof HttpError)) throw e
      const after = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, job.id) })
      await db
        .update(manaQuestions)
        .set({ generationStatus: 'failed', generationReason: after?.lastErrorMessage ?? e.message, generationRetryable: after?.retryable ?? false, jobId: job.id, updatedAt: new Date() })
        .where(eq(manaQuestions.id, q.id))
    }
  }

  /** A failure may be retried when it was marked retryable, or when the request that ran it never finished. */
  const retryAllowed = (q: QuestionRow, job: JobRow) =>
    (q.generationStatus === 'failed' && (q.generationRetryable || job.retryable)) || (q.generationStatus === 'pending' && Date.now() - q.updatedAt.getTime() > STALE_PENDING_MS)

  const retryExecutor: JobExecutor = async (req, _me, job) => {
    const q = await db.query.manaQuestions.findFirst({ where: eq(manaQuestions.id, (job.input as { questionId: string }).questionId) })
    if (!q) throw notFound('Mana question')
    if (!retryAllowed(q, job)) throw conflict('This AI summary cannot be retried', 'not_retryable')
    await generate(req, q, job)
  }
  executors.set('patient_qa', retryExecutor)

  async function questionOr404(me: SessionUser, id: string) {
    const q = await db.query.manaQuestions.findFirst({ where: and(eq(manaQuestions.id, id), eq(manaQuestions.facilityId, me.facilityId)) })
    if (!q) throw notFound('Mana answer')
    return q
  }

  /** Ask Mana about one patient. The record answer is always produced; the AI summary only when available and consented. */
  app.post('/api/patients/:id/mana/questions', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(AskManaRequest, req.body)
    await getPatientOr404(db, me.facilityId, id)
    if (body.idempotencyKey) {
      const existing = await db.query.manaQuestions.findFirst({ where: and(eq(manaQuestions.askedBy, me.id), eq(manaQuestions.idempotencyKey, body.idempotencyKey)) })
      if (existing) {
        if (existing.patientId !== id) throw conflict('That request key was already used for a different request', 'idempotency_key_reused')
        return reply.code(200).send((await toAnswer([existing]))[0])
      }
    }
    // The medicine list staff entered is read too (G14): "what is this patient on?" is answered from it, not from prescriptions alone.
    const record = await loadPatientRecord(db, me, id, { encounterId: body.encounterId, maxEncounters: settings.mana.maxEncounters, observationDays: settings.mana.observationDays, includeMedicineList: true })
    const intent = body.intent ?? classifyQuestion(body.question)
    const sections = answerFromRecord(intent, record, body.question, rules)
    const cited = new Set(sections.flatMap((s) => s.statements.flatMap((x) => x.refs)))
    const gate = await generationGate(id, body.generate)
    if (gate.consentState) await audit(db, req, { action: 'consent.blocked', outcome: 'denied', entityType: 'patient', entityId: id, patientId: id, details: { type: 'ai_record_assistant', purpose: 'Mana AI summary', state: gate.consentState } })
    const sentItems = gate.status === 'pending' ? itemsForGeneration(intent, record, cited, settings.mana.maxContextChars) : []
    const sentRefs = new Set(sentItems.map((i) => i.ref))
    const sources = record.items.filter((i) => cited.has(i.ref) || sentRefs.has(i.ref)).map(toSource)

    const [q] = await db
      .insert(manaQuestions)
      .values({
        facilityId: me.facilityId,
        patientId: id,
        encounterId: body.encounterId ?? null,
        askedBy: me.id,
        question: body.question,
        intent,
        rulesVersion: MANA_RULES_VERSION,
        recordAnswer: sections,
        sources,
        generationStatus: gate.status,
        generationReason: gate.reason,
        idempotencyKey: body.idempotencyKey ?? null,
        dataOrigin: deps.dataOrigin,
      })
      .returning()
    await audit(db, req, {
      action: 'mana.ask',
      entityType: 'mana_question',
      entityId: q!.id,
      patientId: id,
      details: { intent, rulesVersion: MANA_RULES_VERSION, encounterId: body.encounterId ?? null, sourcesCited: cited.size, generation: gate.status, itemsForAi: sentItems.length },
    })
    if (gate.status === 'pending') {
      let jobId: string | null = null
      try {
        const { job } = await jobs.create(req, me, { kind: 'patient_qa', patientId: id, encounterId: body.encounterId ?? null, input: { questionId: q!.id, intent, sentRefs: [...sentRefs], patientLine: `${record.ageBand} years, ${record.patient.sex}` } })
        jobId = job.id
        await db.update(manaQuestions).set({ jobId: job.id, updatedAt: new Date() }).where(eq(manaQuestions.id, q!.id))
        await generate(req, q!, job)
      } catch (e) {
        // The record answer is already stored; the AI part must not stay "in progress".
        req.log.error({ err: e, questionId: q!.id }, 'Mana AI summary did not complete')
        const reason = e instanceof HttpError && e.code === 'consent_required' ? e.message : 'The AI summary could not be completed.'
        await db
          .update(manaQuestions)
          .set({ generationStatus: e instanceof HttpError && e.code === 'consent_required' ? 'consent_required' : 'failed', generationReason: reason, generationRetryable: !!jobId && !(e instanceof HttpError && e.code === 'consent_required'), jobId, updatedAt: new Date() })
          .where(and(eq(manaQuestions.id, q!.id), eq(manaQuestions.generationStatus, 'pending')))
      }
    }
    const fresh = (await db.query.manaQuestions.findFirst({ where: eq(manaQuestions.id, q!.id) }))!
    return reply.code(201).send((await toAnswer([fresh]))[0])
  })

  /** Earlier questions about this patient (newest first). */
  app.get('/api/patients/:id/mana/questions', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    const rows = await db.select().from(manaQuestions).where(and(eq(manaQuestions.patientId, id), eq(manaQuestions.facilityId, me.facilityId))).orderBy(desc(manaQuestions.createdAt)).limit(20)
    await audit(db, req, { action: 'mana.read', entityType: 'patient', entityId: id, patientId: id, details: { answers: rows.length } })
    return { answers: await toAnswer(rows) }
  })

  /** Retry a failed AI summary (same question, same record snapshot). */
  app.post('/api/mana/questions/:id/retry', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const q = await questionOr404(me, id)
    if (q.generationStatus !== 'failed' && q.generationStatus !== 'pending') throw conflict('Only a failed AI summary can be retried', 'not_failed')
    const job = q.jobId ? await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, q.jobId) }) : null
    if (!job) throw conflict('This answer has no AI job to retry', 'no_job')
    if (!retryAllowed(q, job)) throw conflict(q.generationStatus === 'pending' ? 'This AI summary is still in progress' : 'This AI summary failure cannot be retried', q.generationStatus === 'pending' ? 'in_progress' : 'not_retryable')
    await generate(req, q, job)
    const after = await questionOr404(me, id)
    await audit(db, req, { action: 'ai.job_retry', outcome: after.generationStatus === 'succeeded' ? 'success' : 'failure', entityType: 'ai_job', entityId: job.id, patientId: q.patientId, details: { kind: job.kind, attempts: job.attempts } })
    return (await toAnswer([after]))[0]
  })

  /** The doctor marks an answer as reviewed (recorded with name and time; the answer itself never changes). */
  app.post('/api/mana/questions/:id/review', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const q = await questionOr404(me, id)
    await db.transaction(async (tx) => {
      await tx.insert(aiReviewActions).values({ subjectType: 'mana_answer', subjectId: q.id, action: 'reviewed', patientId: q.patientId, encounterId: q.encounterId, actorId: me.id })
      await audit(tx, req, { action: 'mana.review', entityType: 'mana_question', entityId: q.id, patientId: q.patientId })
    })
    return (await toAnswer([q]))[0]
  })
}
