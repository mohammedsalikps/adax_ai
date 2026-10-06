import path from 'node:path'
import {
  AiConsentRequest,
  type AiDraft,
  type CaptureStatus,
  ChunkFields,
  CONSENT_VERSIONS,
  CreateTranscriptRequest,
  DraftDecisionRequest,
  EndTranscriptRequest,
  type EncounterAi,
  JobRequest,
  ReviewRequest,
  SpeakerAssignmentRequest,
  StartLiveTranscriptRequest,
  type Transcript,
} from '@adaxai/contracts'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Config } from '../config.ts'
import type { Db } from '../db/client.ts'
import {
  aiDraftItems,
  aiDrafts,
  aiEvidence,
  aiJobs,
  aiRecommendations,
  aiReviewActions,
  aiRuns,
  auditEvents,
  clinicalFacts,
  files,
  patients,
  transcriptChunks,
  transcriptSegmentSpeakers,
  transcriptSegments,
  transcripts,
  users,
  visits,
} from '../db/schema.ts'
import { simulatorAllowed } from '../devices/gateway.ts'
import { assertWithDoctor, getEncounterOr404 } from '../encounters/service.ts'
import { discardStoredBytes, readStoredBytes, storeBytes } from '../files/storage.ts'
import { readUpload } from '../files/upload.ts'
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.ts'
import { enforceLimit, type RateLimiter } from '../http/rate-limit.ts'
import { parse } from '../http/validate.ts'
import { currentConsent, grantConsent, requireConsent as requireConsentFor } from '../consents/service.ts'
import type { RoutingRulesSource } from '../settings/load.ts'
import type { AppSettings } from '../settings/schema.ts'
import { compareFacts, COMPARE_RULES_VERSION, type EvidenceOut } from './compare.ts'
import { buildPatientContext, formatContext } from './context.ts'
import { type JobService, loadJobs, sha256, toRun } from './jobs.ts'
import { type AiProviders, aiStatus } from './providers.ts'
import { loadEvidence, reviewSubject } from './review.ts'
import { SAFETY_RULES_VERSION, safetyChecks } from './safety.ts'
import { CONTAINER_OF_MIME, sniffAudio } from './audio-sniff.ts'
import { isLikelyNonSpeech } from './stt.ts'
import { formatTranscript } from './anthropic.ts'
import { appendSegments, loadSegments, segmentIdsByLabel } from './transcripts.ts'
import { pseudonymize, segmentTranscript } from './text.ts'
import type { SpeechResult } from './providers.ts'

const IdParams = z.object({ id: z.uuid() })
const AUDIO_EXT: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
}

type JobRow = typeof aiJobs.$inferSelect
export type JobExecutor = (req: FastifyRequest, me: SessionUser, job: JobRow) => Promise<unknown>

export interface AiRouteDeps {
  db: Db
  config: Config
  providers: AiProviders
  settings: AppSettings
  routing: RoutingRulesSource
  jobs: JobService
  /** Executors by job kind, shared with other modules (images) for retries. */
  executors: Map<string, JobExecutor>
  /** The process-wide rate limiter (per-user limits on audio and on the costly steps). */
  limiter: RateLimiter
}

const evidenceValues = (subjectType: string, subjectId: string, ev: EvidenceOut[]) => ev.map((e) => ({ subjectType, subjectId, relation: e.relation, sourceType: e.sourceType, sourceId: e.sourceId, sourceRef: e.sourceRef, provenance: e.provenance, excerpt: e.excerpt.slice(0, 2000), note: e.note }))

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps) {
  const { db, config, providers, settings, routing, jobs, executors, limiter } = deps
  const limits = settings.security.rateLimits

  /** The encounter, if the caller may use AI on it: the authoring doctor, before signing. */
  async function editableEncounter(me: SessionUser, id: string) {
    const e = await getEncounterOr404(db, me, id)
    if (e.doctorId !== me.id) throw forbidden('Only the doctor who started this consultation can use the assistant on it')
    if (e.status === 'discarded') throw conflict('This draft was discarded; the assistant is no longer available for it', 'encounter_discarded')
    if (e.status !== 'in_progress') throw conflict('This consultation is signed; the assistant is no longer available for it', 'encounter_signed')
    return e
  }

  /**
   * Recording and AI assistance need the patient's ai_recording consent (ongoing
   * or for this consultation); steps that also use the record need the current
   * wording. Refusals are audited (consents/service.ts).
   */
  async function requireConsent(req: FastifyRequest, patientId: string, encounterId: string, needsCurrent = false) {
    return requireConsentFor(db, req, { patientId, type: 'ai_recording', encounterId, purpose: needsCurrent ? 'record-aware AI assistance' : 'consultation recording and AI assistance', acceptOlderWording: !needsCurrent })
  }

  async function transcriptOr404(me: SessionUser, id: string) {
    const t = await db.query.transcripts.findFirst({ where: eq(transcripts.id, id) })
    if (!t) throw notFound('Transcript')
    await getEncounterOr404(db, me, t.encounterId) // facility check
    return t
  }

  async function loadAi(me: SessionUser, encounterId: string): Promise<EncounterAi> {
    const e = await getEncounterOr404(db, me, encounterId)
    const consent = await currentConsent(db, e.patientId, 'ai_recording', encounterId)
    const [audioRows, transcriptRows, draftRows, runRows] = await Promise.all([
      db
        .select()
        .from(files)
        .where(and(eq(files.encounterId, encounterId), eq(files.kind, 'consultation_audio'), isNull(files.deletedAt), sql`coalesce(${files.originalName}, '') not like 'live-chunk-%'`))
        .orderBy(asc(files.createdAt)),
      db.select({ t: transcripts, by: users.fullName }).from(transcripts).leftJoin(users, eq(users.id, transcripts.createdBy)).where(eq(transcripts.encounterId, encounterId)).orderBy(asc(transcripts.createdAt)),
      db.select({ d: aiDrafts, r: aiRuns }).from(aiDrafts).innerJoin(aiRuns, eq(aiRuns.id, aiDrafts.runId)).where(eq(aiDrafts.encounterId, encounterId)).orderBy(desc(aiDrafts.createdAt)),
      db.select().from(aiRuns).where(eq(aiRuns.encounterId, encounterId)).orderBy(desc(aiRuns.createdAt)).limit(30),
    ])
    const segs = await loadSegments(
      db,
      transcriptRows.map((t) => t.t.id),
    )
    const chunkRows = transcriptRows.length
      ? await db
          .select()
          .from(transcriptChunks)
          .where(
            inArray(
              transcriptChunks.transcriptId,
              transcriptRows.map((t) => t.t.id),
            ),
          )
          .orderBy(asc(transcriptChunks.chunkIndex))
      : []
    const items = draftRows.length
      ? await db
          .select()
          .from(aiDraftItems)
          .where(
            inArray(
              aiDraftItems.draftId,
              draftRows.map((d) => d.d.id),
            ),
          )
          .orderBy(asc(aiDraftItems.sortOrder))
      : []
    const transcriptsOut: Transcript[] = transcriptRows.map(({ t, by }) => {
      const segments = segs.get(t.id) ?? []
      // The language most lines were detected in (typed text has none).
      const counts = new Map<string, number>()
      for (const x of segments) if (x.language) counts.set(x.language, (counts.get(x.language) ?? 0) + 1)
      const language = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      return {
        id: t.id,
        source: t.source as Transcript['source'],
        audioOrigin: (t.audioOrigin as Transcript['audioOrigin']) ?? null,
        status: t.status as Transcript['status'],
        audioFileId: t.audioFileId,
        segments,
        language,
        chunks: chunkRows.filter((c) => c.transcriptId === t.id).map((c) => ({ index: c.chunkIndex, offsetMs: c.offsetMs, durationMs: c.durationMs, language: c.language, status: c.status as 'received' | 'transcribed' | 'failed' })),
        endedAt: t.endedAt?.toISOString() ?? null,
        endReason: (t.endReason as Transcript['endReason']) ?? null,
        createdAt: t.createdAt.toISOString(),
        createdByName: by,
      }
    })
    const drafts: AiDraft[] = draftRows.map(({ d, r }) => ({
      id: d.id,
      transcriptId: d.transcriptId,
      createdAt: d.createdAt.toISOString(),
      run: toRun(r),
      items: items
        .filter((i) => i.draftId === d.id)
        .map((i) => ({
          id: i.id,
          section: i.section as AiDraft['items'][number]['section'],
          text: i.text,
          sourceSegmentIds: i.sourceSegmentIds as string[],
          unsupported: i.unsupported,
          decision: i.decision as AiDraft['items'][number]['decision'],
          finalText: i.finalText,
          decidedAt: i.decidedAt?.toISOString() ?? null,
        })),
    }))
    const factRows = await db.select().from(clinicalFacts).where(and(eq(clinicalFacts.encounterId, encounterId), ne(clinicalFacts.status, 'superseded'))).orderBy(asc(clinicalFacts.createdAt), asc(clinicalFacts.sortOrder))
    const recRows = await db
      .select({ r: aiRecommendations, run: aiRuns })
      .from(aiRecommendations)
      .innerJoin(aiRuns, eq(aiRuns.id, aiRecommendations.runId))
      .where(and(eq(aiRecommendations.encounterId, encounterId), ne(aiRecommendations.status, 'superseded')))
      .orderBy(asc(aiRecommendations.createdAt), asc(aiRecommendations.sortOrder))
    const evidence = await loadEvidence(db, [...factRows.map((f) => f.id), ...recRows.map((r) => r.r.id)])
    const factRunIds = [...new Set(factRows.map((f) => f.runId))]
    const factRuns = new Map((factRunIds.length ? await db.select().from(aiRuns).where(inArray(aiRuns.id, factRunIds)) : []).map((r) => [r.id, r]))
    // When a speaker label was last changed on each line, so a point extracted before the change can say its attribution may be out of date.
    const assignedRows = transcriptRows.length
      ? await db
          .select({ transcriptId: transcriptSegments.transcriptId, label: transcriptSegments.label, at: transcriptSegmentSpeakers.assignedAt })
          .from(transcriptSegmentSpeakers)
          .innerJoin(transcriptSegments, eq(transcriptSegments.id, transcriptSegmentSpeakers.segmentId))
          .where(
            inArray(
              transcriptSegments.transcriptId,
              transcriptRows.map((t) => t.t.id),
            ),
          )
      : []
    const jobList = await loadJobs(db, { encounterId })
    const reviews = await db
      .select({ a: aiReviewActions, by: users.fullName })
      .from(aiReviewActions)
      .leftJoin(users, eq(users.id, aiReviewActions.actorId))
      .where(eq(aiReviewActions.encounterId, encounterId))
      .orderBy(desc(aiReviewActions.createdAt))
      .limit(200)
    const entityIds = [...jobList.map((j) => j.id), ...transcriptRows.map((t) => t.t.id), ...drafts.map((d) => d.id), ...items.map((i) => i.id), ...factRows.map((f) => f.id), ...recRows.map((r) => r.r.id), ...runRows.map((r) => r.id)]
    const auditRows = await db
      .select({ a: auditEvents, by: users.fullName })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(and(eq(auditEvents.patientId, e.patientId), sql`(${auditEvents.action} like 'ai.%' or ${auditEvents.action} = 'consent.grant')`, or(entityIds.length ? inArray(auditEvents.entityId, entityIds) : sql`false`, sql`${auditEvents.details}->>'encounterId' = ${encounterId}`)))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(100)
    return {
      consent: {
        granted: !!consent,
        scope: (consent?.scope as 'ongoing' | 'encounter' | undefined) ?? null,
        recordedAt: consent?.recordedAt.toISOString() ?? null,
        version: consent?.version ?? null,
        current: consent?.version === CONSENT_VERSIONS.ai_recording,
      },
      status: await aiStatus(providers),
      audio: audioRows.map((f) => ({
        fileId: f.id,
        source: f.originalName?.startsWith('recording') ? 'browser_recording' : 'audio_upload',
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        createdAt: f.createdAt.toISOString(),
        transcriptId: transcriptRows.find((t) => t.t.audioFileId === f.id)?.t.id ?? null,
      })),
      transcripts: transcriptsOut,
      drafts,
      runs: runRows.map(toRun),
      jobs: jobList,
      facts: factRows.map((f) => {
        const ev = evidence.get(f.id) ?? []
        const sources = [...new Set(ev.filter((x) => x.sourceType === 'transcript_segment' && x.relation === 'supports').map((x) => x.sourceRef))]
        const run = factRuns.get(f.runId)
        return {
        id: f.id,
        jobId: f.jobId,
        transcriptId: f.transcriptId,
        category: f.category as EncounterAi['facts'][number]['category'],
        text: f.text,
        attribution: f.attribution as EncounterAi['facts'][number]['attribution'],
        certainty: f.certainty as 'stated' | 'uncertain',
        uncertaintyReason: f.uncertaintyReason,
        negated: f.negated,
        attributes: f.attributes as Record<string, unknown>,
        flags: f.flags as string[],
        status: f.status as EncounterAi['facts'][number]['status'],
        finalText: f.finalText,
        decidedAt: f.decidedAt?.toISOString() ?? null,
        evidence: ev,
        createdAt: f.createdAt.toISOString(),
        sourceSegmentIds: sources,
        producedBy: { provider: run?.provider ?? 'unknown', model: run?.model ?? 'unknown', version: run?.promptVersion ?? null, local: run?.locality ? run.locality === 'local' : null },
        speakerChanged: assignedRows.some((a) => a.transcriptId === f.transcriptId && sources.includes(a.label) && a.at > f.createdAt),
        }
      }),
      recommendations: recRows.map(({ r, run }) => ({
        id: r.id,
        jobId: r.jobId,
        source: r.source as 'rules' | 'llm',
        kind: r.kind,
        urgency: r.urgency as 'routine' | 'attention',
        text: r.text,
        rationale: r.rationale,
        instruction: r.instruction,
        missingInformation: r.missingInformation as { text: string }[],
        unsupported: r.unsupported,
        status: r.status as EncounterAi['recommendations'][number]['status'],
        finalText: r.finalText,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        producedBy: { provider: run.provider, model: run.model, version: run.promptVersion },
        evidence: evidence.get(r.id) ?? [],
      })),
      // The statements of a consultation draft are for the doctor who is making that consultation (V3): the decisions on them are not listed to others.
      reviewActions: reviews.filter(({ a }) => a.subjectType !== 'consultation_item' || e.doctorId === me.id).map(({ a, by }) => ({ id: a.id, subjectType: a.subjectType, subjectId: a.subjectId, action: a.action, text: a.text, reason: a.reason, actorName: by, createdAt: a.createdAt.toISOString() })),
      audit: auditRows.map(({ a, by }) => ({ id: String(a.id), action: a.action, outcome: a.outcome, actorName: by, occurredAt: a.occurredAt.toISOString() })),
    }
  }

  // -------------------------------------------------------------------------
  // Job executors. Each re-checks its preconditions, so a retry is as safe as
  // the first attempt.
  // -------------------------------------------------------------------------

  /** Hours of recording a single consultation may hold, and the longest a part may claim to start after the recording began. */
  const OFFSET_SLACK_MS = 5000

  const transcription: JobExecutor = async (req, me, job) => {
    const input = job.input as { fileId: string; transcriptId: string | null; chunkIndex: number | null; chunkId?: string | null; offsetMs?: number; source: 'audio_upload' | 'browser_recording' }
    const markFailed = async () => {
      if (input.chunkId) await db.update(transcriptChunks).set({ status: 'failed', updatedAt: new Date() }).where(and(eq(transcriptChunks.id, input.chunkId), eq(transcriptChunks.status, 'received')))
    }
    // Preconditions first. A refusal here fails the job (it must never sit at "running") and is answered as itself (a withdrawn consent is a consent error).
    const ready = await (async () => {
      const e = await editableEncounter(me, job.encounterId!)
      await assertWithDoctor(db, e)
      await requireConsent(req, e.patientId, e.id)
      const t = providers.transcriber
      if (!t) throw new HttpError(503, 'stt_unavailable', providers.reasons.stt ?? 'Local transcription is unavailable')
      const file = (await db.query.files.findFirst({ where: and(eq(files.id, input.fileId), eq(files.encounterId, e.id)) }))!
      if (file.deletedAt) throw conflict('The recording has been deleted under the retention policy', 'audio_deleted')
      return { e, t, file, data: await readStoredBytes(config.storageDir, file.storageKey) }
    })().catch(async (err: unknown) => {
      await markFailed()
      await jobs.fail(job, err)
      throw err
    })
    const { e, t, file, data } = ready
    const offsetMs = input.offsetMs ?? 0
    const runMeta = (r?: SpeechResult) => ({ kind: 'stt', provider: t.provider, model: r?.model.id ?? t.model, capability: 'stt' as const, promptVersion: null, inputSha256: file.sha256, locality: t.local ? ('local' as const) : ('external' as const), runtime: r?.model.runtime ?? null, weightsSha256: r?.model.weightsSha256 ?? null })
    try {
      return await jobs.attempt(
        req,
        job,
        async () => {
          const out = await t.transcribe(data, file.mimeType, `audio${AUDIO_EXT[file.mimeType] ?? ''}`, { language: settings.ai.stt.languageHint })
          // The model can take a while: consent may have been withdrawn, or the visit moved on, since it started. Nothing is stored if so.
          await requireConsent(req, e.patientId, e.id)
          await assertWithDoctor(db, e)
          const kept = out.segments.filter((x) => !isLikelyNonSpeech(x))
          return {
            run: { ...runMeta(out), outputSha256: sha256(JSON.stringify(out.segments.map((x) => x.text))) },
            summary: { segments: kept.length, droppedLikelyNonSpeech: out.segments.length - kept.length, durationMs: out.durationMs, ...(input.chunkIndex !== null && { chunkIndex: input.chunkIndex }) },
            persist: async (tx, runId) => {
              const toNew = kept.map((x) => ({ speaker: null, speakerSource: 'none' as const, text: x.text, chunkIndex: input.chunkIndex, startMs: offsetMs + x.startMs, endMs: offsetMs + x.endMs, confidence: x.confidence, language: out.language, avgLogprob: x.avgLogprob, noSpeechProb: x.noSpeechProb, runId }))
              let transcriptId = input.transcriptId
              if (!transcriptId) {
                // A whole file: recorded in the browser (the microphone) or uploaded.
                const [tr] = await tx.insert(transcripts).values({ encounterId: e.id, source: input.source, audioOrigin: input.source === 'audio_upload' ? 'upload' : 'microphone', audioFileId: file.id, sttRunId: runId, status: 'final', createdBy: me.id }).returning({ id: transcripts.id })
                transcriptId = tr!.id
              }
              await appendSegments(tx, transcriptId, toNew)
              if (input.chunkId) await tx.update(transcriptChunks).set({ durationMs: out.durationMs, language: out.language, runId, status: 'transcribed', updatedAt: new Date() }).where(eq(transcriptChunks.id, input.chunkId))
              return transcriptId
            },
          }
        },
        () => runMeta(),
      )
    } catch (err) {
      await markFailed()
      throw err
    }
  }

  const noteDraft: JobExecutor = async (req, me, job) => {
    const { transcriptId } = job.input as { transcriptId: string }
    const e = await editableEncounter(me, job.encounterId!)
    await requireConsent(req, e.patientId, e.id)
    const drafter = providers.drafter
    if (!drafter) throw new HttpError(503, 'ai_unavailable', providers.reasons.llm ?? 'AI drafting is unavailable')
    const patient = (await db.query.patients.findFirst({ where: eq(patients.id, e.patientId) }))!
    const segments = (await loadSegments(db, [transcriptId])).get(transcriptId)!
    if (!segments.length) throw badRequest('The transcript is empty')
    // Only the pseudonymised transcript leaves the server.
    const outbound = pseudonymize(segments, patient)
    const inputSha = sha256(JSON.stringify(outbound))
    return jobs.attempt(
      req,
      job,
      async () => {
        const result = await drafter.draft(outbound)
        const valid = new Set(segments.map((s) => s.id))
        const rows = result.items
          .filter((i) => i.text.trim())
          .map((i, n) => {
            const cited = [...new Set(i.sourceSegmentIds.filter((s) => valid.has(s)))]
            return { section: i.section, text: i.text.trim().slice(0, 8000), sourceSegmentIds: cited, unsupported: cited.length === 0, sortOrder: n }
          })
        return {
          run: { kind: 'note_draft', provider: drafter.provider, model: result.model, capability: 'llm', promptVersion: drafter.promptVersion, inputSha256: inputSha, outputSha256: sha256(JSON.stringify(result.items)), inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerRequestId: result.requestId },
          summary: { items: rows.length, unsupported: rows.filter((r) => r.unsupported).length },
          persist: async (tx, runId) => {
            // Earlier undecided suggestions for this transcript are superseded, not deleted.
            const earlier = await tx.select({ id: aiDrafts.id }).from(aiDrafts).where(eq(aiDrafts.transcriptId, transcriptId))
            if (earlier.length)
              await tx
                .update(aiDraftItems)
                .set({ decision: 'superseded' })
                .where(
                  and(
                    inArray(
                      aiDraftItems.draftId,
                      earlier.map((d) => d.id),
                    ),
                    inArray(aiDraftItems.decision, ['pending', 'deferred']),
                  ),
                )
            const [d] = await tx.insert(aiDrafts).values({ encounterId: e.id, transcriptId, runId }).returning({ id: aiDrafts.id })
            if (rows.length) await tx.insert(aiDraftItems).values(rows.map((r) => ({ ...r, draftId: d!.id })))
            return d!.id
          },
        }
      },
      () => ({ kind: 'note_draft', provider: drafter.provider, model: drafter.model, capability: 'llm', promptVersion: drafter.promptVersion, inputSha256: inputSha }),
    )
  }

  const extraction: JobExecutor = async (req, me, job) => {
    const { transcriptId } = job.input as { transcriptId: string }
    const e = await editableEncounter(me, job.encounterId!)
    await requireConsent(req, e.patientId, e.id)
    const extractor = providers.extractor
    if (!extractor) throw new HttpError(503, 'ai_unavailable', providers.reasons.llm ?? 'AI extraction is unavailable')
    const segments = (await loadSegments(db, [transcriptId])).get(transcriptId)!
    if (!segments.length) throw badRequest('The transcript is empty')
    const ctx = await buildPatientContext(db, e, settings.ai.context)
    // The rule set runs in this process on the transcript as it is; only a hosted model is given pseudonymised text.
    const local = extractor.local === true
    const outbound = local ? segments : pseudonymize(segments, ctx.patient)
    const inputSha = sha256(JSON.stringify(outbound))
    const runBase = { kind: 'extraction', provider: extractor.provider, capability: local ? ('rules' as const) : ('llm' as const), promptVersion: extractor.promptVersion, locality: local ? ('local' as const) : ('external' as const) }
    return jobs.attempt(
      req,
      job,
      async () => {
        const result = await extractor.extract(outbound)
        // Deterministic checks against the transcript and the record (not the model).
        const compared = compareFacts(
          result.facts.filter((f) => f.text.trim()),
          segments,
          ctx,
          settings.safety,
        )
        return {
          run: { ...runBase, model: result.model, inputSha256: inputSha, outputSha256: sha256(JSON.stringify(result.facts)), inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerRequestId: result.requestId },
          summary: { facts: compared.length, flagged: compared.filter((c) => c.flags.length).length, comparison: COMPARE_RULES_VERSION, ...('skippedLines' in result && typeof result.skippedLines === 'number' && result.skippedLines > 0 && { skippedLines: result.skippedLines }) },
          persist: async (tx, runId) => {
            // Decisions already made on this transcript carry forward: a point the doctor confirmed is not proposed a second time, and one they rejected does not come back.
            const decided = await tx.select({ id: clinicalFacts.id, category: clinicalFacts.category, text: clinicalFacts.text }).from(clinicalFacts).where(and(eq(clinicalFacts.transcriptId, transcriptId), inArray(clinicalFacts.status, ['accepted', 'edited', 'rejected'])))
            const decidedRefs = decided.length
              ? await tx.select({ id: aiEvidence.subjectId, ref: aiEvidence.sourceRef }).from(aiEvidence).where(and(eq(aiEvidence.subjectType, 'fact'), inArray(aiEvidence.subjectId, decided.map((d) => d.id)), eq(aiEvidence.sourceType, 'transcript_segment'), eq(aiEvidence.relation, 'supports')))
              : []
            const keyOf = (category: string, text: string, refs: string[]) => `${category}|${text.toLowerCase().replace(/\s+/g, ' ').trim()}|${[...new Set(refs)].sort().join(',')}`
            const known = new Set(decided.map((d) => keyOf(d.category, d.text, decidedRefs.filter((r) => r.id === d.id).map((r) => r.ref))))
            const fresh = compared.filter((c) => !known.has(keyOf(c.fact.category, c.fact.text, c.evidence.filter((x) => x.sourceType === 'transcript_segment' && x.relation === 'supports').map((x) => x.sourceRef))))
            await tx.update(clinicalFacts).set({ status: 'superseded' }).where(and(eq(clinicalFacts.transcriptId, transcriptId), inArray(clinicalFacts.status, ['pending', 'deferred'])))
            for (const [n, c] of fresh.entries()) {
              const f = c.fact
              const attributes = Object.fromEntries(Object.entries(f.details).filter(([, v]) => v !== null))
              const [row] = await tx
                .insert(clinicalFacts)
                .values({ jobId: job.id, runId, transcriptId, encounterId: e.id, patientId: e.patientId, category: f.category, text: f.text.trim().slice(0, 2000), attribution: f.attribution, certainty: f.certainty, uncertaintyReason: f.uncertaintyReason, negated: f.negated, attributes, flags: c.flags, sortOrder: n })
                .returning({ id: clinicalFacts.id })
              if (c.evidence.length) await tx.insert(aiEvidence).values(evidenceValues('fact', row!.id, c.evidence))
            }
            return fresh.length
          },
        }
      },
      () => ({ ...runBase, model: extractor.model, inputSha256: inputSha }),
    )
  }

  async function latestTranscriptId(encounterId: string): Promise<string | null> {
    const [t] = await db.select({ id: transcripts.id }).from(transcripts).where(eq(transcripts.encounterId, encounterId)).orderBy(desc(transcripts.createdAt)).limit(1)
    return t?.id ?? null
  }

  const safetyCheck: JobExecutor = async (req, me, job) => {
    const { transcriptId } = job.input as { transcriptId: string | null }
    const e = await editableEncounter(me, job.encounterId!)
    const ctx = await buildPatientContext(db, e, settings.ai.context)
    // The rules read the transcript only while recording consent is in place; otherwise they check the record alone.
    const transcriptAllowed = !!transcriptId && !!(await currentConsent(db, e.patientId, 'ai_recording', e.id))
    const segments = transcriptAllowed ? (await loadSegments(db, [transcriptId!])).get(transcriptId!)! : []
    const rules = routing.current()
    const facts = await db.select().from(clinicalFacts).where(and(eq(clinicalFacts.encounterId, e.id), inArray(clinicalFacts.status, ['pending', 'deferred', 'accepted', 'edited'])))
    const factEvidence = await loadEvidence(
      db,
      facts.map((f) => f.id),
    )
    const factInput = facts.map((f) => ({ text: f.finalText ?? f.text, flags: f.flags as string[], evidence: (factEvidence.get(f.id) ?? []).map((x) => ({ ...x, provenance: x.provenance as EvidenceOut['provenance'] })) }))
    const inputSha = sha256(JSON.stringify({ items: ctx.items, segments, facts: factInput }))
    return jobs.attempt(
      req,
      job,
      async () => {
        const recs = safetyChecks(ctx, segments, factInput, settings.safety, rules)
        return {
          run: { kind: 'safety_check', provider: 'adaxai-rules', model: SAFETY_RULES_VERSION, capability: 'rules', promptVersion: rules.version, inputSha256: inputSha, outputSha256: sha256(JSON.stringify(recs)) },
          summary: { recommendations: recs.length, attention: recs.filter((r) => r.urgency === 'attention').length },
          persist: async (tx, runId) => {
            await tx.update(aiRecommendations).set({ status: 'superseded' }).where(and(eq(aiRecommendations.encounterId, e.id), eq(aiRecommendations.source, 'rules'), inArray(aiRecommendations.status, ['pending', 'deferred'])))
            for (const [n, r] of recs.entries()) {
              const [row] = await tx
                .insert(aiRecommendations)
                .values({ jobId: job.id, runId, encounterId: e.id, patientId: e.patientId, source: 'rules', kind: r.kind, urgency: r.urgency, text: r.text, rationale: r.rationale, instruction: r.instruction, missingInformation: r.missingInformation, unsupported: false, sortOrder: n })
                .returning({ id: aiRecommendations.id })
              if (r.evidence.length) await tx.insert(aiEvidence).values(evidenceValues('recommendation', row!.id, r.evidence))
            }
            return recs.length
          },
        }
      },
      () => ({ kind: 'safety_check', provider: 'adaxai-rules', model: SAFETY_RULES_VERSION, capability: 'rules', promptVersion: rules.version, inputSha256: inputSha }),
    )
  }

  const recommendations: JobExecutor = async (req, me, job) => {
    const { transcriptId } = job.input as { transcriptId: string | null }
    const e = await editableEncounter(me, job.encounterId!)
    await requireConsent(req, e.patientId, e.id, true)
    const recommender = providers.recommender
    if (!recommender) throw new HttpError(503, 'ai_unavailable', providers.reasons.llm ?? 'AI recommendations are unavailable')
    const ctx = await buildPatientContext(db, e, settings.ai.context)
    const segments = transcriptId ? pseudonymize((await loadSegments(db, [transcriptId])).get(transcriptId)!, ctx.patient) : []
    const input = { patientLine: `Age band ${ctx.ageBand}, sex ${ctx.patient.sex}`, recordText: formatContext(ctx.items), transcriptText: segments.length ? formatTranscript(segments) : '(no transcript)' }
    const inputSha = sha256(JSON.stringify(input))
    const segById = new Map(segments.map((s) => [s.id, s]))
    const resolve = (ref: string): EvidenceOut | null => {
      const r = ref.replace(/[[\]\s]/g, '')
      const item = ctx.byRef.get(r)
      if (item) return { relation: 'supports', sourceType: item.sourceType, sourceId: item.sourceId, sourceRef: item.ref, provenance: item.provenance, excerpt: item.text, note: null }
      const s = segById.get(r)
      if (s) return { relation: 'supports', sourceType: 'transcript_segment', sourceId: null, sourceRef: s.id, provenance: s.speaker === 'Patient' ? 'patient_reported' : s.speaker === 'Doctor' ? 'clinician_stated' : 'transcript_unlabelled', excerpt: `${s.speaker ? `${s.speaker}: ` : ''}${s.text}`, note: null }
      return null
    }
    return jobs.attempt(
      req,
      job,
      async () => {
        const result = await recommender.recommend(input)
        const recs = result.recommendations
          .filter((r) => r.text.trim())
          .map((r) => {
            const support = r.supportingRefs.map(resolve).filter((x): x is EvidenceOut => !!x)
            const conflicts = r.conflicts.flatMap((c) =>
              c.refs
                .map(resolve)
                .filter((x): x is EvidenceOut => !!x)
                .map((x) => ({ ...x, relation: 'conflicts' as const, note: c.text.slice(0, 500) })),
            )
            return { r, evidence: [...support, ...conflicts], unsupported: support.length === 0 }
          })
        return {
          run: { kind: 'recommendations', provider: recommender.provider, model: result.model, capability: 'llm', promptVersion: recommender.promptVersion, inputSha256: inputSha, outputSha256: sha256(JSON.stringify(result.recommendations)), inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerRequestId: result.requestId },
          summary: { recommendations: recs.length, unsupported: recs.filter((x) => x.unsupported).length, insufficientData: result.insufficientData, ...(result.insufficientDataReason && { insufficientDataReason: result.insufficientDataReason.slice(0, 500) }) },
          persist: async (tx, runId) => {
            await tx.update(aiRecommendations).set({ status: 'superseded' }).where(and(eq(aiRecommendations.encounterId, e.id), eq(aiRecommendations.source, 'llm'), inArray(aiRecommendations.status, ['pending', 'deferred'])))
            for (const [n, { r, evidence, unsupported }] of recs.entries()) {
              const [row] = await tx
                .insert(aiRecommendations)
                .values({ jobId: job.id, runId, encounterId: e.id, patientId: e.patientId, source: 'llm', kind: r.kind, urgency: r.urgency, text: r.text.trim().slice(0, 2000), rationale: r.rationale.trim().slice(0, 2000), missingInformation: r.missingInformation.map((m) => ({ text: m.slice(0, 300) })), unsupported, sortOrder: n })
                .returning({ id: aiRecommendations.id })
              if (evidence.length) await tx.insert(aiEvidence).values(evidenceValues('recommendation', row!.id, evidence))
            }
            return recs.length
          },
        }
      },
      () => ({ kind: 'recommendations', provider: recommender.provider, model: recommender.model, capability: 'llm', promptVersion: recommender.promptVersion, inputSha256: inputSha }),
    )
  }

  executors.set('transcription', transcription)
  executors.set('note_draft', noteDraft)
  executors.set('extraction', extraction)
  executors.set('safety_check', safetyCheck)
  executors.set('recommendations', recommendations)

  /** Creates a job (or finds the one for this idempotency key) and runs it once. */
  async function startJob(req: FastifyRequest, me: SessionUser, o: Parameters<JobService['create']>[2]) {
    const { job, existing } = await jobs.create(req, me, o)
    if (existing) {
      if (job.status === 'running') throw conflict('This request is already being processed', 'job_running')
      if (job.status === 'failed') throw conflict('This request failed earlier. Use “Retry” on the failed job.', 'job_failed')
      return job
    }
    try {
      await executors.get(o.kind)!(req, me, job)
    } catch (err) {
      // Whatever stopped it (a refused precondition, a storage error), the job must not be left "running": nothing could ever finish it.
      await jobs.fail(job, err).catch(() => undefined)
      throw err
    }
    return job
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  app.get('/api/ai/status', { config: { permission: 'ai:use' } }, async () => aiStatus(providers))

  app.get('/api/encounters/:id/ai', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const out = await loadAi(me, id)
    // Named outside 'ai.*' so routine reads do not crowd the consultation's AI activity trail.
    const e = await getEncounterOr404(db, me, id)
    await audit(db, req, { action: 'encounter_ai.read', entityType: 'encounter', entityId: id, patientId: e.patientId })
    return out
  })

  /** Consent for this consultation only (the profile page records ongoing consent). */
  app.post('/api/encounters/:id/ai-consent', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const { method } = parse(AiConsentRequest, req.body)
    const e = await editableEncounter(me, id)
    await db.transaction((tx) => grantConsent(tx, req, { patientId: e.patientId, type: 'ai_recording', method, scope: 'encounter', encounterId: id, recordedBy: me.id }))
    return reply.code(201).send(await loadAi(me, id))
  })

  app.post('/api/encounters/:id/transcripts', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(CreateTranscriptRequest, req.body)
    const e = await editableEncounter(me, id)
    await requireConsent(req, e.patientId, id)
    const segments = segmentTranscript(body.text)
    await db.transaction(async (tx) => {
      const [t] = await tx.insert(transcripts).values({ encounterId: id, source: body.source, status: 'final', createdBy: me.id }).returning({ id: transcripts.id })
      await appendSegments(
        tx,
        t!.id,
        segments.map((s) => ({ speaker: s.speaker, speakerSource: 'typed_label', text: s.text })),
      )
      await audit(tx, req, { action: 'ai.transcript_create', entityType: 'transcript', entityId: t!.id, patientId: e.patientId, details: { source: body.source, segments: segments.length, encounterId: id } })
    })
    return reply.code(201).send(await loadAi(me, id))
  })

  /** Reads and checks an audio upload (type, size) without storing anything yet. */
  async function readAudio(req: FastifyRequest) {
    const up = await readUpload(req, 'an audio file')
    const mime = up.mimetype
    const ext = AUDIO_EXT[mime]
    if (!ext || !settings.uploads.audio.types.includes(mime)) throw badRequest('Unsupported audio format', [{ path: 'file', message: 'Use WebM, OGG, MP3, M4A or WAV audio' }])
    if (up.data.length > settings.uploads.audio.maxMb * 1024 * 1024) throw new HttpError(413, 'too_large', `Audio is larger than ${settings.uploads.audio.maxMb} MB`)
    // What the bytes are, not what the name or the declared type says: a file that is not audio of the declared kind is refused before it is stored.
    if (sniffAudio(up.data) !== CONTAINER_OF_MIME[mime]) throw new HttpError(415, 'unsupported_media', 'The file is not audio of the kind it says it is. Use a WebM, OGG, MP3, M4A or WAV recording.')
    return { up, mime, ext }
  }

  async function persistAudio(me: SessionUser, e: { id: string; patientId: string }, a: Awaited<ReturnType<typeof readAudio>>, originalName: string) {
    const stored = await storeBytes(config.storageDir, a.up.data, a.ext)
    const [file] = await db
      .insert(files)
      .values({ facilityId: me.facilityId, patientId: e.patientId, encounterId: e.id, kind: 'consultation_audio', storageKey: stored.storageKey, originalName, mimeType: a.mime, sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: me.id })
      .returning()
    return file!
  }

  async function storeAudio(req: FastifyRequest, me: SessionUser, e: { id: string; patientId: string }, nameFor: (ext: string, original: string | undefined, field: (n: string) => string | undefined) => string) {
    const a = await readAudio(req)
    // The upload took time to arrive (up to the size limit over a slow link): consent is checked again just before anything is stored, so a
    // patient who withdrew while it was arriving does not have it stored.
    await requireConsent(req, e.patientId, e.id)
    const originalName = nameFor(a.ext, a.up.filename, (n) => a.up.fields[n])
    return persistAudio(me, e, a, originalName)
  }

  /** Ends a live recording and says why. Idempotent: only a live one changes. */
  async function endLive(req: FastifyRequest, tid: string, e: { id: string; patientId: string }, reason: NonNullable<Transcript['endReason']>) {
    const ended = await db.update(transcripts).set({ status: 'final', endedAt: new Date(), endReason: reason }).where(and(eq(transcripts.id, tid), eq(transcripts.status, 'live'))).returning({ id: transcripts.id })
    if (ended.length) await audit(db, req, { action: 'ai.live_end', entityType: 'transcript', entityId: tid, patientId: e.patientId, details: { encounterId: e.id, reason } })
    return ended.length > 0
  }

  /** Stores consultation audio; transcribes it when speech-to-text is configured. */
  app.post('/api/encounters/:id/audio', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    await enforceLimit(db, limiter, req, reply, 'ai-audio', me.id, limits.aiAudioPerUser)
    const { id } = parse(IdParams, req.params)
    const e = await editableEncounter(me, id)
    await assertWithDoctor(db, e)
    await requireConsent(req, e.patientId, id)
    let recorded = false
    const file = await storeAudio(req, me, e, (ext, original, field) => {
      recorded = field('source') === 'browser_recording'
      return recorded ? `recording${ext}` : path.basename(original || `upload${ext}`).slice(0, 120)
    })
    await audit(db, req, { action: 'ai.audio_upload', entityType: 'file', entityId: file.id, patientId: e.patientId, details: { sizeBytes: file.sizeBytes, mimeType: file.mimeType, source: recorded ? 'browser_recording' : 'audio_upload', audioOrigin: recorded ? 'microphone' : 'upload', encounterId: id } })
    if (!providers.transcriber) return reply.code(201).send({ ...(await loadAi(me, id)), notice: providers.reasons.stt })
    try {
      await startJob(req, me, { kind: 'transcription', patientId: e.patientId, encounterId: id, input: { fileId: file.id, transcriptId: null, chunkIndex: null, source: recorded ? 'browser_recording' : 'audio_upload' } })
      return reply.code(201).send(await loadAi(me, id))
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      // The audio is kept; the doctor can retry the job or type the transcript.
      return reply.code(201).send({ ...(await loadAi(me, id)), notice: `${err.message} The audio was saved.` })
    }
  })

  /** The local speech service says it is ready right now, or recording is refused with its reason (no hosted fallback exists). */
  async function requireSpeechReady() {
    if (!providers.transcriber || providers.features?.liveTranscription === false) throw new HttpError(503, 'stt_unavailable', providers.reasons.stt ?? 'Live transcription is switched off.')
    const h = await providers.transcriber.health()
    if (h.state !== 'ready') throw new HttpError(503, 'stt_unavailable', h.reason ?? 'The local speech service is not ready.')
  }

  /**
   * Starts a live (chunked) transcript. Each part is transcribed as it arrives. Needs recording consent and a ready local speech service.
   * One recording at a time per consultation: a second is refused, unless the first has been silent so long that its page is gone
   * (then it is ended and replaced). Its parts come from the microphone, or are synthetic demo audio (computer voices): that is accepted only
   * where simulators are allowed (the gate of the device and thermal simulators), and the transcript records it for good.
   */
  app.post('/api/encounters/:id/live-transcripts', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const { audioOrigin } = parse(StartLiveTranscriptRequest, req.body ?? {})
    if (audioOrigin === 'demo_synthetic' && !simulatorAllowed(config)) throw conflict('Synthetic demo audio cannot be used in a clinical or production deployment', 'demo_audio_not_allowed')
    const e = await editableEncounter(me, id)
    await assertWithDoctor(db, e)
    await requireConsent(req, e.patientId, id)
    await requireSpeechReady()
    const staleMs = (settings.ai.stt.liveChunkSeconds * 3 + 60) * 1000
    const open = await db.query.transcripts.findFirst({ where: and(eq(transcripts.encounterId, id), eq(transcripts.status, 'live')) })
    if (open) {
      const [last] = await db.select({ at: sql<Date | null>`max(${transcriptChunks.createdAt})` }).from(transcriptChunks).where(eq(transcriptChunks.transcriptId, open.id))
      const quietSince = new Date(last?.at ?? open.createdAt).getTime()
      if (Date.now() - quietSince < staleMs) throw conflict('A recording is already running for this consultation (another tab or window). Stop it there first.', 'recording_in_progress')
      await endLive(req, open.id, e, 'stale_replaced')
    }
    let t: { id: string }
    try {
      // The consent is read again, and locked against a withdrawal, in the step that creates the recording: a withdrawal that committed while the
      // speech service was being asked is seen here, and one that commits after this step ends this recording itself (it waits for this step).
      const created = await db.transaction(async (tx) => {
        if (!(await currentConsent(tx, e.patientId, 'ai_recording', id, true))) return null
        const [row] = await tx.insert(transcripts).values({ encounterId: id, source: 'browser_recording', audioOrigin, status: 'live', createdBy: me.id }).returning({ id: transcripts.id })
        return row!
      })
      if (!created) {
        // Audited and refused with the consent's own wording (withdrawn or not recorded).
        await requireConsent(req, e.patientId, id)
        throw new HttpError(409, 'consent_withdrawn', 'The patient has withdrawn consent to recording.')
      }
      t = created
    } catch (err) {
      if ((err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') throw conflict('A recording is already running for this consultation (another tab or window). Stop it there first.', 'recording_in_progress')
      throw err
    }
    await audit(db, req, { action: 'ai.live_start', entityType: 'transcript', entityId: t.id, patientId: e.patientId, details: { encounterId: id, audioOrigin } })
    return reply.code(201).send({ ...(await loadAi(me, id)), transcriptId: t.id })
  })

  app.post('/api/transcripts/:id/chunks', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    await enforceLimit(db, limiter, req, reply, 'ai-audio', me.id, limits.aiAudioPerUser)
    const { id } = parse(IdParams, req.params)
    const t = await transcriptOr404(me, id)
    const e = await editableEncounter(me, t.encounterId)
    // Consent withdrawn (or never given): this recording ends here, so nothing more can be added to it.
    try {
      await requireConsent(req, e.patientId, e.id)
    } catch (err) {
      if (err instanceof HttpError && err.code.startsWith('consent_')) await endLive(req, id, e, 'consent_withdrawn')
      throw err
    }
    if (t.status !== 'live') throw conflict('This recording has ended', 'transcript_not_live')
    await assertWithDoctor(db, e)
    const a = await readAudio(req)
    // The part took time to arrive: consent is checked again just before anything is stored.
    await requireConsent(req, e.patientId, e.id)
    const fields = parse(ChunkFields, { chunkIndex: a.up.fields.chunkIndex, offsetMs: a.up.fields.offsetMs })
    // The recording's own clock cannot run ahead of the wall clock: a part claiming to start later than the recording has existed is refused.
    if (fields.offsetMs > Date.now() - t.createdAt.getTime() + OFFSET_SLACK_MS) throw badRequest('Some fields are invalid', [{ path: 'offsetMs', message: 'The part starts later than the recording has been running' }])
    // Parts follow each other on the recording's timeline: a later part cannot start before an earlier one did (it would overlap it and break the order of the lines).
    const [earlier] = await db
      .select({ idx: transcriptChunks.chunkIndex, offset: transcriptChunks.offsetMs })
      .from(transcriptChunks)
      .where(and(eq(transcriptChunks.transcriptId, id), sql`${transcriptChunks.chunkIndex} < ${fields.chunkIndex}`))
      .orderBy(desc(transcriptChunks.chunkIndex))
      .limit(1)
    if (earlier && fields.offsetMs < earlier.offset) throw badRequest('Some fields are invalid', [{ path: 'offsetMs', message: 'The part starts before the part that precedes it' }])
    const dup = await db.query.transcriptChunks.findFirst({ where: and(eq(transcriptChunks.transcriptId, id), eq(transcriptChunks.chunkIndex, fields.chunkIndex)) })
    if (dup) throw conflict('This part of the recording was already received', 'chunk_already_received')
    // The bytes are written first. The rows that make them part of the recording are written in one step that checks, under a lock, that the
    // recording is still live and the consent still holds: a withdrawal that is ending this recording right now either waits for this step (and
    // then ends the recording, part included) or has already ended it (and this part is refused). Refused bytes are removed again.
    const stored = await storeBytes(config.storageDir, a.up.data, a.ext)
    let saved: { fileId: string; chunkId: string } | null
    try {
      saved = await db.transaction(async (tx) => {
        const [live] = await tx.select({ id: transcripts.id }).from(transcripts).where(and(eq(transcripts.id, id), eq(transcripts.status, 'live'))).for('share')
        if (!live) throw conflict('This recording has ended', 'transcript_not_live')
        if (!(await currentConsent(tx, e.patientId, 'ai_recording', e.id, true))) return null
        const [row] = await tx
          .insert(files)
          .values({ facilityId: me.facilityId, patientId: e.patientId, encounterId: e.id, kind: 'consultation_audio', storageKey: stored.storageKey, originalName: `live-chunk-${fields.chunkIndex}${a.ext}`, mimeType: a.mime, sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: me.id })
          .returning({ id: files.id })
        const [part] = await tx.insert(transcriptChunks).values({ transcriptId: id, chunkIndex: fields.chunkIndex, fileId: row!.id, offsetMs: fields.offsetMs }).onConflictDoNothing().returning({ id: transcriptChunks.id })
        if (!part) throw conflict('This part of the recording was already received', 'chunk_already_received')
        await audit(tx, req, { action: 'ai.audio_chunk', entityType: 'file', entityId: row!.id, patientId: e.patientId, details: { transcriptId: id, chunkIndex: fields.chunkIndex, audioOrigin: t.audioOrigin ?? null } })
        return { fileId: row!.id, chunkId: part.id }
      })
    } catch (err) {
      await discardStoredBytes(config.storageDir, stored.storageKey)
      throw err
    }
    if (!saved) {
      await discardStoredBytes(config.storageDir, stored.storageKey)
      await endLive(req, id, e, 'consent_withdrawn')
      // Audited and refused with the consent's own wording.
      await requireConsent(req, e.patientId, e.id)
      throw new HttpError(409, 'consent_withdrawn', 'The patient has withdrawn consent to recording.')
    }
    try {
      await startJob(req, me, { kind: 'transcription', patientId: e.patientId, encounterId: e.id, input: { fileId: saved.fileId, transcriptId: id, chunkIndex: fields.chunkIndex, chunkId: saved.chunkId, offsetMs: fields.offsetMs, source: 'browser_recording' } })
      return reply.code(201).send(await loadAi(me, e.id))
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      return reply.code(201).send({ ...(await loadAi(me, e.id)), notice: `Part ${fields.chunkIndex + 1}: ${err.message} The audio was saved.` })
    }
  })

  app.post('/api/transcripts/:id/end', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const { reason } = parse(EndTranscriptRequest, req.body ?? {})
    const t = await transcriptOr404(me, id)
    const e = await editableEncounter(me, t.encounterId)
    // The reason is a fact about the patient's consent, not something the browser can assert: it is written as "consent withdrawn" only if it is.
    const stillConsented = reason === 'consent_withdrawn' && !!(await currentConsent(db, e.patientId, 'ai_recording', e.id))
    await endLive(req, id, e, stillConsented ? 'doctor_stopped' : reason)
    return loadAi(me, e.id)
  })

  /**
   * The doctor says who spoke a line. Recorded as reviewed metadata (append-only: every assignment stays); the words never change.
   * Facts extracted before a change say their attribution may be out of date.
   */
  app.post('/api/transcripts/:id/speakers', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(SpeakerAssignmentRequest, req.body)
    const t = await transcriptOr404(me, id)
    const e = await editableEncounter(me, t.encounterId)
    const labels = [...new Set(body.assignments.map((a) => a.segmentId))]
    const ids = await segmentIdsByLabel(db, id, labels)
    const unknown = labels.filter((l) => !ids.has(l))
    if (unknown.length) throw badRequest('Some lines are not in this transcript', unknown.map((l) => ({ path: 'assignments', message: `${l} is not a line of this transcript` })))
    await db.transaction(async (tx) => {
      // The later of two assignments for one line in one request stands.
      const last = new Map(body.assignments.map((a) => [a.segmentId, a.speaker]))
      await tx.insert(transcriptSegmentSpeakers).values([...last.entries()].map(([label, speaker]) => ({ segmentId: ids.get(label)!, speaker, assignedBy: me.id })))
      await audit(tx, req, { action: 'ai.speaker_assign', entityType: 'transcript', entityId: id, patientId: e.patientId, details: { encounterId: e.id, lines: last.size } })
    })
    return loadAi(me, e.id)
  })

  /**
   * What the capture panel needs to decide whether recording may start and to notice when it must stop: consent, the local speech service,
   * and whether a recording is running. Polled; it holds no patient content and is not audited per poll.
   */
  app.get('/api/encounters/:id/capture', { config: { permission: 'ai:use' } }, async (req): Promise<CaptureStatus> => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const e = await getEncounterOr404(db, me, id)
    const consent = await currentConsent(db, e.patientId, 'ai_recording', id)
    const status = await aiStatus(providers)
    const [visit] = await db.select({ status: visits.status }).from(visits).where(eq(visits.id, e.visitId))
    const open = await db.query.transcripts.findFirst({ where: and(eq(transcripts.encounterId, id), eq(transcripts.status, 'live')) })
    const [last] = open ? await db.select({ at: sql<Date | null>`max(${transcriptChunks.createdAt})` }).from(transcriptChunks).where(eq(transcriptChunks.transcriptId, open.id)) : [undefined]
    const closedReason =
      e.status === 'discarded'
        ? 'This draft was discarded.'
        : e.status !== 'in_progress'
          ? 'This consultation is signed.'
          : e.doctorId !== me.id
            ? 'Only the doctor who started this consultation can record it.'
            : visit?.status !== 'in_consultation'
              ? 'The visit is no longer with the doctor, so this consultation is paused. Continue it from the queue first.'
              : null
    const blockedReason =
      closedReason ??
      (!consent
        ? 'The patient’s consent to recording has not been recorded for this consultation.'
        : providers.features?.liveTranscription === false
          ? 'Live transcription is switched off.'
          : !status.stt.available
            ? (status.stt.reason ?? 'Local transcription is unavailable.')
            : null)
    return {
      consent: { granted: !!consent, scope: (consent?.scope as 'ongoing' | 'encounter' | undefined) ?? null, recordedAt: consent?.recordedAt.toISOString() ?? null, current: consent?.version === CONSENT_VERSIONS.ai_recording },
      speech: status.stt,
      live: { transcriptId: open?.id ?? null, startedAt: open?.createdAt.toISOString() ?? null, lastChunkAt: last?.at ? new Date(last.at).toISOString() : null, audioOrigin: (open?.audioOrigin as CaptureStatus['live']['audioOrigin']) ?? null },
      canRecord: blockedReason === null,
      blockedReason,
      closedReason,
    }
  })

  /** Generates a structured note draft from a transcript. Output is stored as pending suggestions only. */
  app.post('/api/transcripts/:id/drafts', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    await enforceLimit(db, limiter, req, reply, 'ai-step', me.id, limits.aiStepPerUser)
    const { id } = parse(IdParams, req.params)
    const { idempotencyKey } = parse(JobRequest, req.body ?? {})
    const t = await transcriptOr404(me, id)
    const e = await editableEncounter(me, t.encounterId)
    await requireConsent(req, e.patientId, e.id)
    if (!providers.drafter) throw new HttpError(503, 'ai_unavailable', providers.reasons.llm ?? 'AI drafting is unavailable')
    const job = await startJob(req, me, { kind: 'note_draft', patientId: e.patientId, encounterId: e.id, input: { transcriptId: id }, idempotencyKey })
    const [d] = await db.select({ id: aiDrafts.id }).from(aiDrafts).innerJoin(aiRuns, eq(aiRuns.id, aiDrafts.runId)).where(eq(aiRuns.jobId, job.id)).limit(1)
    return reply.code(201).send({ ...(await loadAi(me, e.id)), draftId: d?.id ?? null, jobId: job.id })
  })

  /** Extracts structured facts (with transcript evidence and record comparison). */
  app.post('/api/transcripts/:id/extract', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    await enforceLimit(db, limiter, req, reply, 'ai-step', me.id, limits.aiStepPerUser)
    const { id } = parse(IdParams, req.params)
    const { idempotencyKey } = parse(JobRequest, req.body ?? {})
    const t = await transcriptOr404(me, id)
    const e = await editableEncounter(me, t.encounterId)
    await requireConsent(req, e.patientId, e.id)
    if (!providers.extractor) throw new HttpError(503, 'ai_unavailable', providers.reasons.llm ?? 'AI extraction is unavailable')
    const job = await startJob(req, me, { kind: 'extraction', patientId: e.patientId, encounterId: e.id, input: { transcriptId: id }, idempotencyKey })
    return reply.code(201).send({ ...(await loadAi(me, e.id)), jobId: job.id })
  })

  /**
   * Decision support: deterministic safety rules always; language-model
   * recommendations too when configured and requested. A model failure
   * leaves the rule results in place and is reported, never papered over.
   */
  app.post('/api/encounters/:id/recommendations', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    await enforceLimit(db, limiter, req, reply, 'ai-step', me.id, limits.aiStepPerUser)
    const { id } = parse(IdParams, req.params)
    const body = parse(z.object({ includeLlm: z.boolean().default(true), idempotencyKey: z.uuid().optional() }), req.body ?? {})
    const e = await editableEncounter(me, id)
    const transcriptId = await latestTranscriptId(id)
    await startJob(req, me, { kind: 'safety_check', patientId: e.patientId, encounterId: id, input: { transcriptId }, idempotencyKey: body.idempotencyKey })
    let notice: string | null = null
    if (body.includeLlm) {
      if (!providers.recommender) notice = providers.reasons.llm ?? 'AI recommendations are unavailable.'
      else {
        try {
          await requireConsent(req, e.patientId, id, true)
          await startJob(req, me, { kind: 'recommendations', patientId: e.patientId, encounterId: id, input: { transcriptId } })
        } catch (err) {
          if (!(err instanceof HttpError)) throw err
          notice = `AI recommendations: ${err.message}`
        }
      }
    }
    return reply.code(201).send({ ...(await loadAi(me, id)), notice })
  })

  /** Re-runs a failed job. Its inputs and preconditions are checked again. */
  app.post('/api/ai-jobs/:id/retry', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const job = await db.query.aiJobs.findFirst({ where: and(eq(aiJobs.id, id), eq(aiJobs.facilityId, me.facilityId)) })
    if (!job) throw notFound('AI job')
    if (job.status !== 'failed') throw conflict(job.status === 'running' ? 'This job is still running' : 'This job has already succeeded', 'job_not_failed')
    const run = executors.get(job.kind)
    if (!run) throw badRequest('This job cannot be retried')
    try {
      await run(req, me, job)
    } catch (err) {
      await audit(db, req, { action: 'ai.job_retry', outcome: 'failure', entityType: 'ai_job', entityId: id, patientId: job.patientId, details: { kind: job.kind, attempts: job.attempts, code: err instanceof HttpError ? err.code : 'error' } })
      throw err
    }
    await audit(db, req, { action: 'ai.job_retry', entityType: 'ai_job', entityId: id, patientId: job.patientId, details: { kind: job.kind, attempts: job.attempts } })
    if (job.encounterId) await audit(db, req, { action: 'encounter_ai.read', entityType: 'encounter', entityId: job.encounterId, patientId: job.patientId, details: { via: 'retry' } })
    const after = (await loadJobs(db, { ids: [id] }))[0]!
    return { job: after, ...(job.encounterId ? { encounter: await loadAi(me, job.encounterId) } : {}) }
  })

  /** Doctor review of any AI output: accept, edit, reject or defer. */
  app.post('/api/ai-review/:type/:id', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { type, id } = parse(z.object({ type: z.enum(['fact', 'recommendation', 'draft_item', 'image_analysis']), id: z.uuid() }), req.params)
    const body = parse(ReviewRequest, req.body)
    const result = await reviewSubject(db, req, me, type, id, body, editableEncounter)
    return { ...(result.encounterId ? await loadAi(me, result.encounterId) : {}), item: result.item }
  })

  /** Earlier endpoint for note-draft items, kept for compatibility. */
  app.post('/api/ai-draft-items/:id/decision', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(DraftDecisionRequest, req.body)
    const result = await reviewSubject(db, req, me, 'draft_item', id, { action: body.decision, ...(body.text !== undefined && { text: body.text }), ...(body.confirmUnsupported !== undefined && { confirmFlags: body.confirmUnsupported }) }, editableEncounter)
    return { ...(await loadAi(me, result.encounterId!)), item: result.item }
  })

  return { loadAi, editableEncounter }
}
