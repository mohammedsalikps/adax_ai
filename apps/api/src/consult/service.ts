import crypto from 'node:crypto'
import {
  type ConsultationAi,
  type ConsultDraft,
  type ConsultItem,
  type ConsultSource,
  CONSULT_NOTE_SECTION,
  type DraftStatus,
  type DraftValidation,
  type RecordCheck,
  type ReviewConsultItemRequest,
  type ReasoningStatus,
  type ConsultSection,
  LIVE_DRAFT_STATUSES,
} from '@adaxai/contracts'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { audit } from '../audit/audit.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { consentState, requireConsent } from '../consents/service.ts'
import { type Db, type DbOrTx, pgCode } from '../db/client.ts'
import { aiEvidence, aiJobs, auditEvents, consultationDraftItems, consultationDrafts, encounters, noteInsertions, observations, users } from '../db/schema.ts'
import { getEncounterOr404 } from '../encounters/service.ts'
import { conflict, forbidden, HttpError, notFound } from '../http/errors.ts'
import type { Gate } from '../ai/llm/gate.ts'
import { LOCAL_AI_UNAVAILABLE, reasoningStatus } from '../ai/llm/status.ts'
import type { ReasoningModel } from '../ai/llm/types.ts'
import type { JobService, RunRecord } from '../ai/jobs.ts'
import { sha256 } from '../ai/jobs.ts'
import { AiProviderError } from '../ai/providers.ts'
import type { AppSettings } from '../settings/schema.ts'
import { RECORD_CHECK_VERSION } from '../mana/answers.ts'
import { buildConsultationInputs, type ConsultationInputs, type DeviceReading, deviceReadingsIn, deviceStream, diffManifests, idInKey, type ManifestDiff, type ManifestEntry, staleSummary, withoutDeviceStream } from './inputs.ts'
import { CONSULT_PROMPT, CONSULT_SCHEMA_VERSION, ConsultOutput, renderUserMessage } from './prompt.ts'
import { VALIDATION_VERSION, validateDraft } from './validate.ts'

export type DraftRow = typeof consultationDrafts.$inferSelect
type EncounterRow = typeof encounters.$inferSelect

export interface ReasoningConfig {
  mode: 'local' | 'hosted' | 'none'
  model: ReasoningModel | null
  /** Why there is no model (switched off, egress off, no key), shown instead of any placeholder output. */
  reason: string | null
  egress: { hosted: boolean; destination: string | null }
}

export interface ConsultDeps {
  db: Db
  jobs: JobService
  reasoning: ReasoningConfig
  gate: Gate
  settings: AppSettings
  /** The check run on every record-reading step: is this caller allowed to draft for this consultation. */
  editableEncounter: (me: SessionUser, id: string) => Promise<EncounterRow>
}

/** The consultation, if the caller may use AI on it: the authoring doctor, before signing. */
export function editableEncounterFor(db: Db) {
  return async (me: SessionUser, id: string): Promise<EncounterRow> => {
    const e = await getEncounterOr404(db, me, id)
    if (e.doctorId !== me.id) throw forbidden('Only the doctor who started this consultation can use the assistant on it')
    if (e.status === 'discarded') throw conflict('This draft was discarded; the assistant is no longer available for it', 'encounter_discarded')
    if (e.status !== 'in_progress') throw conflict('This consultation is signed; the assistant is no longer available for it', 'encounter_signed')
    return e
  }
}

/** The shape of a record id: only that is looked up, whatever a stored manifest holds. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const settingsOf = (s: AppSettings) => ({ maxContextChars: s.ai.reasoning.maxContextChars, maxEncounters: s.mana.maxEncounters, observationDays: s.mana.observationDays, settings: { safety: s.safety, outdatedDays: s.mana.outdatedDays } })

export class ConsultationService {
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly d: ConsultDeps) {}

  // --- status ---------------------------------------------------------------------------------------------------------------------------

  /** What the model server says about itself just now. */
  async status(opts: { fresh?: boolean } = {}): Promise<ReasoningStatus> {
    const { model, mode, reason } = this.d.reasoning
    return reasoningStatus({ mode, model, reason }, opts)
  }

  // --- reading --------------------------------------------------------------------------------------------------------------------------

  /** The consultation's AI state: model status, consent, the newest draft with its statements and sources, and whether the record moved since. */
  async get(me: SessionUser, encounter: EncounterRow, opts: { fresh?: boolean } = {}): Promise<ConsultationAi> {
    const { db } = this.d
    const status = await this.status(opts)
    const { state } = await consentState(db, encounter.patientId, 'ai_recording', encounter.id)
    const rows = await db.select().from(consultationDrafts).where(eq(consultationDrafts.encounterId, encounter.id)).orderBy(desc(consultationDrafts.version))
    // The draft shown is the newest one that is being made or has statements; an attempt that failed or was cancelled after it does not replace it.
    const latest = rows.find((r) => (LIVE_DRAFT_STATUSES as readonly string[]).includes(r.status)) ?? rows[0] ?? null
    const newer = rows[0] && latest && rows[0].version > latest.version ? rows[0] : null
    let inputs: ConsultationInputs | null = null
    // The record is read again only when something is to be compared with it: a finished draft (is it stale?) or no draft (the rules' own check).
    if (!latest || latest.status !== 'generating') {
      // What the doctor added to the note from this draft is not a change to the sources: it is left out of the comparison.
      const inserted = latest ? (await db.select({ section: noteInsertions.section, text: noteInsertions.text }).from(noteInsertions).innerJoin(consultationDraftItems, eq(consultationDraftItems.id, noteInsertions.subjectId)).where(and(eq(noteInsertions.subjectType, 'consultation_item'), eq(consultationDraftItems.draftId, latest.id)))) : []
      inputs = await buildConsultationInputs(db, me, encounter, { ...settingsOf(this.d.settings), stripInserted: inserted })
    }
    const draft = latest ? await this.toDraft(latest, inputs) : null
    const blocked = this.blockedReason(status, state, encounter)
    return {
      status,
      blockedReason: blocked,
      canGenerate: !blocked && draft?.status !== 'generating',
      consent: { state, type: 'ai_recording' },
      egress: this.d.reasoning.egress,
      draft,
      lastAttempt: newer ? { version: newer.version, status: newer.status as 'failed' | 'cancelled' | 'unavailable', errorCode: newer.errorCode, errorMessage: newer.errorMessage, retryable: newer.retryable, createdAt: newer.createdAt.toISOString() } : null,
      recordCheck: draft ? null : (inputs?.recordCheck ?? null),
      earlier: rows.filter((r) => r.id !== latest?.id).map((r) => ({ id: r.id, version: r.version, status: r.status as DraftStatus, createdAt: r.createdAt.toISOString() })),
    }
  }

  private blockedReason(status: ReasoningStatus, consent: string, encounter: EncounterRow): string | null {
    if (encounter.status !== 'in_progress') return 'This consultation is no longer open, so a new draft cannot be made.'
    if (consent === 'withdrawn') return 'The patient has withdrawn consent to recording and AI assistance, so no draft can be made.'
    if (consent === 'not_recorded') return 'The patient’s consent to recording and AI assistance has not been recorded. Record it first.'
    if (consent === 'outdated') return 'The patient agreed to an earlier wording of the consent. Read the current wording and record consent again.'
    if (!status.available) return status.reason ?? LOCAL_AI_UNAVAILABLE
    return null
  }

  private async toDraft(row: DraftRow, inputs: ConsultationInputs | null): Promise<ConsultDraft> {
    const { db } = this.d
    const itemRows = await db.select({ i: consultationDraftItems, by: users.fullName }).from(consultationDraftItems).leftJoin(users, eq(users.id, consultationDraftItems.decidedBy)).where(eq(consultationDraftItems.draftId, row.id)).orderBy(asc(consultationDraftItems.createdAt))
    const ids = itemRows.map((r) => r.i.id)
    const evidence = ids.length ? await db.select().from(aiEvidence).where(and(eq(aiEvidence.subjectType, 'consultation_item'), inArray(aiEvidence.subjectId, ids))).orderBy(asc(aiEvidence.createdAt)) : []
    const inserted = ids.length ? new Set((await db.select({ id: noteInsertions.subjectId }).from(noteInsertions).where(and(eq(noteInsertions.subjectType, 'consultation_item'), inArray(noteInsertions.subjectId, ids)))).map((r) => r.id)) : new Set<string>()
    const manifest = row.contextManifest as ManifestEntry[]
    const finished = row.status === 'ready' || row.status === 'partial'
    const raw = finished && inputs ? diffManifests(manifest, inputs.manifest) : null
    // A device's newer readings taking the place of its older ones do not by themselves make a draft stale, or mark a source as changed (see withoutDeviceStream).
    const diff = raw && inputs ? withoutDeviceStream(raw, manifest, await this.deviceReadings(row, inputs, raw)) : null
    const changed = new Set([...(diff?.changed ?? []), ...(diff?.removed ?? [])].map((m) => m.key))
    const removed = new Set((diff?.removed ?? []).map((m) => m.key))
    const summary = diff ? staleSummary(diff) : null
    const items: ConsultItem[] = itemRows.map(({ i, by }) => {
      const sources: ConsultSource[] = evidence
        .filter((e) => e.subjectId === i.id)
        .map((e) => ({
          key: e.note ?? '',
          ref: e.sourceRef,
          sourceType: e.sourceType,
          sourceId: e.sourceId,
          encounterId: null,
          date: manifest.find((m) => m.key === e.note)?.date ?? null,
          field: manifest.find((m) => m.key === e.note)?.field ?? e.sourceType,
          status: manifest.find((m) => m.key === e.note)?.status ?? '',
          provenance: e.provenance,
          excerpt: e.excerpt,
          change: removed.has(e.note ?? '') ? ('removed' as const) : changed.has(e.note ?? '') ? ('changed' as const) : null,
        }))
      return {
        id: i.id,
        section: i.section as ConsultSection,
        position: i.position,
        text: i.text,
        support: i.support as ConsultItem['support'],
        rationale: i.rationale,
        uncertainty: i.uncertainty,
        flags: i.flags as ConsultItem['flags'],
        sources,
        sourceChanged: sources.some((s) => s.change !== null),
        decision: i.decision as ConsultItem['decision'],
        finalText: i.finalText,
        decidedByName: by,
        decidedAt: i.decidedAt?.toISOString() ?? null,
        inNote: inserted.has(i.id),
        needsConfirmation: i.needsConfirmation,
      }
    })
    const [requester] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, row.requestedBy))
    return {
      id: row.id,
      encounterId: row.encounterId,
      version: row.version,
      status: row.status as DraftStatus,
      phase: (row.phase as ConsultDraft['phase']) ?? null,
      stale: !!summary,
      staleSummary: summary,
      insufficient: row.insufficient,
      model: row.provider ? { provider: row.provider, model: row.model ?? '', runtime: row.runtime, weightsSha256: row.weightsSha256, local: row.locality === 'local' } : null,
      promptVersion: row.promptId,
      schemaVersion: row.schemaVersion,
      rulesVersion: row.rulesVersion,
      contextSha256: row.contextSha256,
      sourceCount: row.sourceCount,
      omittedCount: row.omittedCount,
      requestedByName: requester?.name ?? null,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      latencyMs: row.latencyMs,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      retryable: row.retryable,
      validation: (row.validation as DraftValidation | null) ?? null,
      recordCheck: row.recordCheck as RecordCheck,
      items,
    }
  }

  /**
   * The device readings among the sources a draft was made from and those there are now, for the stale rule: those in the record now are read from it;
   * those the draft had that are no longer among the newest are looked up, and count only while they are still this patient's device readings,
   * unverified and not entered in error.
   */
  private async deviceReadings(row: DraftRow, inputs: ConsultationInputs, diff: ManifestDiff): Promise<Map<string, DeviceReading>> {
    const readings = deviceReadingsIn(inputs.record)
    const gone = new Map<string, string>()
    for (const m of diff.removed) {
      const id = m.sourceType === 'observation' ? idInKey(m.key) : null
      if (id && UUID.test(id)) gone.set(id, m.key)
    }
    if (!gone.size) return readings
    const rows = await this.d.db
      .select({ id: observations.id, kind: observations.kind, visitId: observations.visitId, measuredAt: observations.measuredAt })
      .from(observations)
      .where(and(inArray(observations.id, [...gone.keys()]), eq(observations.patientId, row.patientId), eq(observations.source, 'device'), eq(observations.validationStatus, 'device_unverified'), eq(observations.enteredInError, false)))
    for (const o of rows) readings.set(gone.get(o.id)!, { stream: deviceStream(o.kind, o.visitId), measuredAt: o.measuredAt.getTime() })
    return readings
  }

  /** One draft by id, without re-reading the record (the screen polls this while a draft is being made). */
  /**
   * The doctor's screen was given a finished draft: recorded once per doctor and draft (ids and counts only, never a word of it), not at every
   * refresh. It says the draft reached the doctor, which is as near to "viewed" as the server can know.
   */
  async noteViewed(req: FastifyRequest, me: SessionUser, encounter: EncounterRow, ai: ConsultationAi): Promise<void> {
    const d = ai.draft
    if (!d || (d.status !== 'ready' && d.status !== 'partial')) return
    const seen = await this.d.db.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.action, 'ai.consultation_draft_viewed'), eq(auditEvents.entityId, d.id), eq(auditEvents.actorUserId, me.id))).limit(1)
    if (seen.length) return
    await audit(this.d.db, req, { action: 'ai.consultation_draft_viewed', entityType: 'consultation_draft', entityId: d.id, patientId: encounter.patientId, details: { encounterId: encounter.id, version: d.version, statements: d.items.length, stale: d.stale, status: d.status } })
  }

  async getDraft(me: SessionUser, draftId: string): Promise<ConsultDraft> {
    const row = await this.draftOr404(me, draftId)
    return this.toDraft(row, null)
  }

  private async draftOr404(me: SessionUser, id: string): Promise<DraftRow> {
    const [row] = await this.d.db.select().from(consultationDrafts).where(and(eq(consultationDrafts.id, id), eq(consultationDrafts.facilityId, me.facilityId)))
    if (!row) throw notFound('Consultation draft')
    return row
  }

  // --- requesting -----------------------------------------------------------------------------------------------------------------------

  /**
   * Starts a draft. Everything that can be refused is refused before anything is read for the model: the doctor's right to this consultation
   * (the caller checked it), the patient's consent, the model's availability. Then the authorised inputs are built, a row says "generating",
   * and the work happens in the background so the request returns at once. The same idempotency key returns the same draft; a second request
   * while one is running is refused (the database enforces one running draft per consultation).
   */
  async request(req: FastifyRequest, me: SessionUser, encounter: EncounterRow, idempotencyKey: string): Promise<{ draft: ConsultDraft; created: boolean }> {
    const { db, reasoning, gate } = this.d
    const existing = await db.query.consultationDrafts.findFirst({ where: and(eq(consultationDrafts.requestedBy, me.id), eq(consultationDrafts.idempotencyKey, idempotencyKey)) })
    if (existing) {
      if (existing.encounterId !== encounter.id) throw conflict('That request key was already used for a different consultation', 'idempotency_key_reused')
      return { draft: await this.toDraft(existing, null), created: false }
    }
    await requireConsent(db, req, { patientId: encounter.patientId, type: 'ai_recording', encounterId: encounter.id, purpose: 'local AI consultation draft', acceptOlderWording: false })
    const model = reasoning.model
    if (!model) {
      await audit(db, req, { action: 'ai.consultation_draft', outcome: 'denied', entityType: 'encounter', entityId: encounter.id, patientId: encounter.patientId, details: { reason: 'no_model', mode: reasoning.mode } })
      throw new HttpError(503, 'ai_unavailable', reasoning.reason ?? LOCAL_AI_UNAVAILABLE)
    }
    const health = await model.health()
    if (health.state !== 'ready') {
      await audit(db, req, { action: 'ai.consultation_draft', outcome: 'failure', entityType: 'encounter', entityId: encounter.id, patientId: encounter.patientId, details: { reason: health.state, mode: reasoning.mode } })
      throw new HttpError(503, 'ai_unavailable', health.reason ?? LOCAL_AI_UNAVAILABLE)
    }
    if (gate.full) throw new HttpError(429, 'ai_busy', 'The local model is busy with other drafts. Try again in a moment.')

    const inputs = await buildConsultationInputs(db, me, encounter, settingsOf(this.d.settings))
    const base = {
      facilityId: me.facilityId,
      encounterId: encounter.id,
      patientId: encounter.patientId,
      idempotencyKey,
      promptId: CONSULT_PROMPT.id,
      schemaVersion: CONSULT_SCHEMA_VERSION,
      rulesVersion: RECORD_CHECK_VERSION,
      checksVersion: VALIDATION_VERSION,
      contextSha256: inputs.contextSha256,
      contextManifest: inputs.manifest,
      sourceCount: inputs.items.length,
      omittedCount: inputs.omitted,
      recordCheck: inputs.recordCheck,
      requestedBy: me.id,
    }

    // Too little to draft from: nothing is asked of the model, and the draft says so.
    if (!inputs.hasClinicalContent) {
      const row = await this.insertDraft({ ...base, status: 'ready', insufficient: true, completedAt: new Date(), validation: { produced: 0, kept: 0, removed: 0, flagged: 0, reasons: {} } })
      await audit(db, req, { action: 'ai.consultation_draft', entityType: 'consultation_draft', entityId: row.id, patientId: encounter.patientId, details: { encounterId: encounter.id, insufficient: true, sources: 0 } })
      return { draft: await this.toDraft(row, inputs), created: true }
    }

    const row = await this.insertDraft({ ...base, status: 'generating', phase: 'queued', insufficient: false, provider: model.provider, model: model.model, locality: model.local ? 'local' : 'external' })
    let job: typeof aiJobs.$inferSelect
    try {
      ;({ job } = await this.d.jobs.create(req, me, { kind: 'consultation_draft', patientId: encounter.patientId, encounterId: encounter.id, input: { draftId: row.id, sources: inputs.items.length, omitted: inputs.omitted, promptId: CONSULT_PROMPT.id }, idempotencyKey }))
      await db.update(consultationDrafts).set({ jobId: job.id }).where(eq(consultationDrafts.id, row.id))
      await audit(db, req, { action: 'ai.consultation_draft_requested', entityType: 'consultation_draft', entityId: row.id, patientId: encounter.patientId, details: { encounterId: encounter.id, version: row.version, sources: inputs.items.length, omitted: inputs.omitted, mode: reasoning.mode } })
    } catch (err) {
      // Nothing was started: the row must not stay "generating", or it would block every later request for this consultation.
      await this.markFailed(row.id, err)
      throw err
    }
    const ac = new AbortController()
    this.running.set(row.id, ac)
    // Detached on purpose: the request returns now; `run` records every outcome itself and never throws.
    void this.run(req, me, row, job, inputs, ac)
    return { draft: await this.toDraft({ ...row, jobId: job.id }, null), created: true }
  }

  private async insertDraft(values: Omit<typeof consultationDrafts.$inferInsert, 'id' | 'version'>): Promise<DraftRow> {
    const { db } = this.d
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [row] = await db
          .insert(consultationDrafts)
          .values({ ...values, version: sql`(select coalesce(max(version), 0) + 1 from consultation_drafts where encounter_id = ${values.encounterId})` as unknown as number })
          .returning()
        return row!
      } catch (e) {
        if (pgCode(e) !== '23505') throw e
        const x = e as { constraint?: string; cause?: { constraint?: string } }
        const text = x.constraint ?? x.cause?.constraint ?? ''
        if (text.includes('one_generating')) throw conflict('A draft for this consultation is already being made. Wait for it, or cancel it first.', 'generation_in_progress')
        if (text.includes('idem')) throw conflict('That request was already made.', 'idempotency_key_reused')
        // A concurrent request took the same version number: take the next one.
      }
    }
    throw new HttpError(409, 'version_conflict', 'The draft could not be started; try again.')
  }

  // --- running --------------------------------------------------------------------------------------------------------------------------

  private async run(req: FastifyRequest, me: SessionUser, row: DraftRow, job: typeof aiJobs.$inferSelect, inputs: ConsultationInputs, ac: AbortController): Promise<void> {
    const { db, gate, reasoning, jobs } = this.d
    const model = reasoning.model!
    let held = false
    // Set when the record is about to go to the model: before it, a refusal means nothing was sent.
    let sent = false
    try {
      await gate.acquire(ac.signal)
      held = true
      // Waiting for the model's turn can take minutes: consent and the consultation's state are read again before anything is sent to it.
      const { state: consentNow } = await consentState(db, row.patientId, 'ai_recording', row.encounterId)
      if (consentNow !== 'granted') throw new HttpError(409, 'consent_withdrawn', 'The patient’s consent to recording and AI assistance changed while the draft was waiting for the model, so nothing was sent to it.')
      const [still] = await db.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, row.encounterId))
      if (still?.status !== 'in_progress') throw new HttpError(409, 'consultation_closed', 'The consultation was closed while the draft was waiting for the model, so nothing was sent to it.')
      sent = true
      await db.update(consultationDrafts).set({ phase: 'running', startedAt: new Date(), updatedAt: new Date() }).where(and(eq(consultationDrafts.id, row.id), eq(consultationDrafts.status, 'generating')))
      const user = renderUserMessage({ patientLine: inputs.patientLine, today: inputs.today, items: inputs.items })
      const runBase: RunRecord = { kind: 'consultation_draft', provider: model.provider, model: model.model, capability: 'llm', promptVersion: CONSULT_PROMPT.id, inputSha256: sha256(user), locality: model.local ? 'local' : 'external' }
      const outcome = await jobs.attempt(
        req,
        job,
        async () => {
          const result = await model.generate({ prompt: CONSULT_PROMPT, user, schema: ConsultOutput, schemaName: 'consultation_draft', maxOutputTokens: this.d.settings.ai.reasoning.maxOutputTokens, signal: ac.signal })
          const validated = validateDraft(result.output, inputs, { outdatedDays: this.d.settings.mana.outdatedDays })
          const status: DraftStatus = validated.stats.removed > 0 || (!validated.items.length && !validated.insufficient) ? 'partial' : 'ready'
          return {
            run: { ...runBase, model: result.model, outputSha256: sha256(JSON.stringify(result.output)), inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerRequestId: result.requestId, runtime: result.runtime, weightsSha256: result.weightsSha256 },
            summary: { sources: inputs.items.length, omitted: inputs.omitted, produced: validated.stats.produced, kept: validated.stats.kept, removed: validated.stats.removed, flagged: validated.stats.flagged, insufficient: validated.insufficient },
            persist: async (tx: DbOrTx, runId: string) => {
              // A draft takes minutes, and the patient may have withdrawn consent (or the wording moved on) while the model was writing: then nothing of
              // its answer is kept, as for every other step that stores what AI made from a consultation.
              const { state: consentNow } = await consentState(tx, row.patientId, 'ai_recording', row.encounterId)
              if (consentNow !== 'granted') throw new HttpError(409, 'consent_withdrawn', 'The patient’s consent to recording and AI assistance changed while the draft was being made, so nothing was kept.')
              const [done] = await tx
                .update(consultationDrafts)
                .set({ status, phase: null, runId, insufficient: validated.insufficient, provider: model.provider, model: result.model, runtime: result.runtime, weightsSha256: result.weightsSha256, validation: validated.stats, completedAt: new Date(), updatedAt: new Date(), latencyMs: Date.now() - row.createdAt.getTime() })
                .where(and(eq(consultationDrafts.id, row.id), eq(consultationDrafts.status, 'generating')))
                .returning({ id: consultationDrafts.id })
              // Cancelled (or swept) while the model was answering: the answer is discarded, not stored.
              if (!done) throw new HttpError(409, 'draft_not_generating', 'This draft was cancelled.')
              await this.storeItems(tx, row, inputs, validated.items)
              return status
            },
          }
        },
        () => ({ ...runBase }),
      )
      void outcome
    } catch (err) {
      await this.markFailed(row.id, err)
      if (!(err instanceof HttpError) && !(err instanceof AiProviderError) && !(err instanceof Error && err.message === 'aborted')) req.log.error({ err, draftId: row.id }, 'consultation draft failed unexpectedly')
      if (err instanceof HttpError && err.code === 'consent_withdrawn') {
        await audit(db, req, { action: 'ai.consultation_draft', outcome: 'denied', entityType: 'consultation_draft', entityId: row.id, patientId: row.patientId, details: { reason: sent ? 'consent_withdrawn_while_generating' : 'consent_withdrawn_while_waiting', encounterId: row.encounterId } }).catch(() => undefined)
      }
    } finally {
      if (held) gate.release()
      this.running.delete(row.id)
    }
  }

  private async storeItems(tx: DbOrTx, row: DraftRow, inputs: ConsultationInputs, items: ReturnType<typeof validateDraft>['items']): Promise<void> {
    const byKey = new Map(inputs.items.map((i) => [i.key, i]))
    for (const it of items) {
      const [saved] = await tx
        .insert(consultationDraftItems)
        .values({ draftId: row.id, section: it.section, position: it.position, text: it.text, support: it.support, rationale: it.rationale, uncertainty: it.uncertainty, flags: it.flags, sourceKeys: it.sourceKeys, needsConfirmation: it.needsConfirmation })
        .returning({ id: consultationDraftItems.id })
      const evidence = it.sourceKeys
        .map((k) => byKey.get(k))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => ({ subjectType: 'consultation_item', subjectId: saved!.id, relation: 'supports', sourceType: s.sourceType, sourceId: s.sourceId, sourceRef: s.ref, provenance: s.provenance, excerpt: s.text.slice(0, 2000), note: s.key }))
      if (evidence.length) await tx.insert(aiEvidence).values(evidence)
    }
  }

  /** Records how a draft ended when it did not end well. Only a draft that is still generating can be marked: a cancel that came first stands. */
  private async markFailed(draftId: string, err: unknown): Promise<void> {
    const code = err instanceof HttpError ? err.code.replace(/^ai_/, '') : err instanceof AiProviderError ? err.code : 'internal_error'
    // The world changed under the draft (the patient withdrew consent, the consultation was closed): it ends as cancelled, with that reason, and cannot be retried.
    const withdrawn = code === 'consent_withdrawn' || code === 'consultation_closed'
    const cancelled = code === 'cancelled' || code === 'draft_not_generating' || withdrawn
    const unavailable = code === 'unavailable' || code === 'loading' || code === 'unauthorized'
    // The job service adds "You can retry." to what it tells a caller; the screen adds its own invitation, so the plain message is kept here.
    const message = withdrawn && err instanceof HttpError ? err.message : cancelled ? 'This draft was cancelled.' : err instanceof HttpError ? err.message.replace(/ You can retry\.$/, '') : err instanceof AiProviderError ? err.message : 'The draft could not be made.'
    // A provider's failure reaches here wrapped by the job service, which says "You can retry." only when trying again can help: that is the answer.
    const wrapped = err instanceof HttpError && err.code.startsWith('ai_')
    const retryable = withdrawn ? false : cancelled ? true : err instanceof AiProviderError ? err.retryable : wrapped ? err.message.endsWith('You can retry.') : err instanceof HttpError ? err.statusCode >= 500 : true
    await this.d.db
      .update(consultationDrafts)
      .set({ status: cancelled ? 'cancelled' : unavailable ? 'unavailable' : 'failed', phase: null, errorCode: withdrawn ? code : cancelled ? 'cancelled' : code, errorMessage: message.slice(0, 400), retryable, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(consultationDrafts.id, draftId), eq(consultationDrafts.status, 'generating')))
      .catch(() => undefined)
  }

  // --- cancelling and recovering --------------------------------------------------------------------------------------------------------

  async cancel(req: FastifyRequest, me: SessionUser, draftId: string): Promise<ConsultDraft> {
    const row = await this.draftOr404(me, draftId)
    await this.d.editableEncounter(me, row.encounterId)
    if (row.status !== 'generating') throw conflict('This draft is not being made any more', 'not_generating')
    const [done] = await this.d.db
      .update(consultationDrafts)
      .set({ status: 'cancelled', phase: null, errorCode: 'cancelled', errorMessage: 'This draft was cancelled.', retryable: true, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(consultationDrafts.id, draftId), eq(consultationDrafts.status, 'generating')))
      .returning()
    // It finished (or ended) first: nothing was cancelled, and nothing is said to have been.
    if (!done) return this.toDraft(await this.draftOr404(me, draftId), null)
    // The model call and any wait for it stop.
    this.running.get(draftId)?.abort()
    if (row.jobId) await this.d.db.update(aiJobs).set({ status: 'failed', lastErrorCode: 'cancelled', lastErrorMessage: 'Cancelled by the doctor.', retryable: true, updatedAt: new Date(), completedAt: new Date() }).where(and(eq(aiJobs.id, row.jobId), eq(aiJobs.status, 'running')))
    await audit(this.d.db, req, { action: 'ai.consultation_draft_cancelled', entityType: 'consultation_draft', entityId: draftId, patientId: row.patientId, details: { encounterId: row.encounterId, version: row.version } })
    return this.toDraft(done, null)
  }

  /** Drafts that were being made when the server stopped cannot continue: they are failed (retryable) so their doctor can ask again. */
  async sweepInterrupted(): Promise<number> {
    const rows = await this.d.db
      .update(consultationDrafts)
      .set({ status: 'failed', phase: null, errorCode: 'interrupted', errorMessage: 'This draft was interrupted (the system restarted or stopped). You can generate it again.', retryable: true, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(consultationDrafts.status, 'generating'))
      .returning({ id: consultationDrafts.id, jobId: consultationDrafts.jobId })
    const jobIds = rows.map((r) => r.jobId).filter((j): j is string => !!j)
    if (jobIds.length) await this.d.db.update(aiJobs).set({ status: 'failed', lastErrorCode: 'interrupted', lastErrorMessage: 'Interrupted by a restart.', retryable: true, updatedAt: new Date(), completedAt: new Date() }).where(and(inArray(aiJobs.id, jobIds), eq(aiJobs.status, 'running')))
    return rows.length
  }

  /** Stops every model call in progress (the server is closing). */
  abortAll(): void {
    for (const ac of this.running.values()) ac.abort()
  }
}

export const newKey = () => crypto.randomUUID()
export type { ReviewConsultItemRequest }
export { CONSULT_NOTE_SECTION }
