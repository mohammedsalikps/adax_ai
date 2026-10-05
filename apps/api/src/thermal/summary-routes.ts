import { type RoiStats, type ThermalCaptureSource, type ThermalFlags, ThermalModelStatus, type ThermalPair, type ThermalSummary, ThermalSummaryReviewRequest, type ThermalSummaryStatement, ThermalWorkspaceEventRequest } from '@adaxai/contracts'
import { and, asc, desc, eq, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Config } from '../config.ts'
import { requireConsent } from '../consents/service.ts'
import { type Db, pgCode } from '../db/client.ts'
import { files, thermalCaptures, thermalRois, thermalSummaries, users } from '../db/schema.ts'
import { getEncounterOr404 } from '../encounters/service.ts'
import { readStoredBytes } from '../files/storage.ts'
import { conflict, deniedNotFound } from '../http/errors.ts'
import type { RateLimiter } from '../http/rate-limit.ts'
import { parse } from '../http/validate.ts'
import { modelUnavailable, type RoiGeometry, type ThermalService } from './client.ts'
import { composeThermalSummary, pixelsWithReading, type SummaryCaptureInput } from './summary.ts'

const IdParams = z.object({ id: z.uuid() })
type CaptureRow = typeof thermalCaptures.$inferSelect
type SummaryRow = typeof thermalSummaries.$inferSelect

const NOT_APPROVED = 'Approve the image first: a summary is composed from an approved image, whose measurements and regions can no longer change.'

/** A workspace event is audited at most once per user, consultation and event in this many seconds (the screen may report it repeatedly). */
export const THERMAL_EVENT_AUDIT_WINDOW_SECONDS = 60

/** The database's guards on thermal summaries (migration 0031) answered as conflicts; the routes check first, these are the backstop. */
function guardRefusal(e: unknown, message: string, code: string): unknown {
  const c = pgCode(e)
  return c === '42501' || c === '23514' ? conflict(message, code) : e
}

/**
 * V6: the clinician-facing thermal summary (composed by fixed rules, `summary.ts`), the doctor's single decision on it, and the audit events of the
 * thermal imaging workspace. A summary is composed only of an approved image. It reaches a consultation note only through the note insertion
 * route (subject `thermal_summary`), once accepted or edited, while its image is approved, and never when simulated.
 */
export function registerThermalSummaryRoutes(app: FastifyInstance, deps: { db: Db; config: Config; thermal: ThermalService; limiter: RateLimiter }) {
  const { db, config, thermal, limiter } = deps

  async function getCaptureOr404(me: SessionUser, id: string): Promise<CaptureRow> {
    const c = await db.query.thermalCaptures.findFirst({ where: and(eq(thermalCaptures.id, id), eq(thermalCaptures.facilityId, me.facilityId)) })
    if (!c) {
      const elsewhere = await db.query.thermalCaptures.findFirst({ columns: { id: true }, where: eq(thermalCaptures.id, id) })
      throw deniedNotFound('Thermal image', { entityType: 'thermal_capture', entityId: id, reason: elsewhere ? 'other_facility' : 'not_found' })
    }
    return c
  }

  async function getSummaryOr404(me: SessionUser, id: string): Promise<SummaryRow> {
    const s = await db.query.thermalSummaries.findFirst({ where: and(eq(thermalSummaries.id, id), eq(thermalSummaries.facilityId, me.facilityId)) })
    if (!s) {
      const elsewhere = await db.query.thermalSummaries.findFirst({ columns: { id: true }, where: eq(thermalSummaries.id, id) })
      throw deniedNotFound('Thermal summary', { entityType: 'thermal_summary', entityId: id, reason: elsewhere ? 'other_facility' : 'not_found' })
    }
    return s
  }

  async function toSummaries(where: SQL): Promise<ThermalSummary[]> {
    const creator = alias(users, 'creator')
    const decider = alias(users, 'decider')
    const rows = await db
      .select({ s: thermalSummaries, createdByName: creator.fullName, decidedByName: decider.fullName })
      .from(thermalSummaries)
      .leftJoin(creator, eq(creator.id, thermalSummaries.createdBy))
      .leftJoin(decider, eq(decider.id, thermalSummaries.decidedBy))
      .where(where)
      .orderBy(desc(thermalSummaries.createdAt), desc(thermalSummaries.id))
    return rows.map(({ s, createdByName, decidedByName }) => ({
      id: s.id,
      captureId: s.captureId,
      encounterId: s.encounterId,
      composerVersion: s.composerVersion,
      rulesVersion: s.rulesVersion,
      model: s.model as ThermalModelStatus,
      statements: s.statements as ThermalSummaryStatement[],
      text: s.text,
      status: s.status as ThermalSummary['status'],
      finalText: s.finalText,
      decidedByName,
      decidedAt: s.decidedAt?.toISOString() ?? null,
      simulated: s.simulated,
      createdAt: s.createdAt.toISOString(),
      createdByName,
    }))
  }
  const toSummary = async (id: string) => (await toSummaries(eq(thermalSummaries.id, id)))[0]!

  /** The stored temperature matrix, or null when it is not available (no file, removed by retention, unreadable or the wrong size). */
  async function readMatrix(c: CaptureRow): Promise<Buffer | null> {
    const f = await db.query.files.findFirst({ where: eq(files.id, c.matrixFileId) })
    if (!f || f.deletedAt) return null
    try {
      const m = await readStoredBytes(config.storageDir, f.storageKey)
      return m.length === c.width * c.height * 4 ? m : null
    } catch {
      return null
    }
  }

  /** Whether a thermal model is installed, as the thermal service says (none is: V6). Anything that cannot be read as a model status counts as no model. */
  async function modelStatus(): Promise<ThermalModelStatus> {
    try {
      const parsed = ThermalModelStatus.safeParse(await thermal.modelStatus())
      if (parsed.success) return parsed.data
    } catch {
      // The client never throws here; a service that does is taken as giving no status.
    }
    return modelUnavailable('The thermal model status could not be read, so no thermal model can be used.')
  }

  /** The experimental rules' output for this capture, with region labels as the doctor wrote them (as the flags route returns it). */
  async function flagsFor(c: CaptureRow, rois: (typeof thermalRois.$inferSelect)[], matrix: Buffer): Promise<ThermalFlags> {
    const keyOf = (label: string) => label.trim().toLowerCase()
    const known = new Set(rois.map((r) => keyOf(r.label)))
    const pairs = rois.filter((r) => r.pairWith && known.has(keyOf(r.pairWith))).map((r) => ({ a: keyOf(r.label), b: keyOf(r.pairWith!) }))
    const uniquePairs = pairs.filter((p, i) => pairs.findIndex((q) => (q.a === p.a && q.b === p.b) || (q.a === p.b && q.b === p.a)) === i)
    const result = await thermal.flags({
      width: c.width,
      height: c.height,
      matrix,
      rois: rois.map((r): RoiGeometry => ({ id: keyOf(r.label), shape: r.shape as RoiGeometry['shape'], x: r.x, y: r.y, width: r.width, height: r.height, points: (r.points ?? null) as [number, number][] | null })),
      pairs: uniquePairs,
    })
    const labelOf = new Map(rois.map((r) => [keyOf(r.label), r.label]))
    return { ...result, asymmetry: result.asymmetry.map((a) => ({ ...a, a: labelOf.get(a.a) ?? a.a, b: labelOf.get(a.b) ?? a.b })) }
  }

  /**
   * Composes a summary of one capture and stores it, pending the doctor's decision. Doctors only; the patient's consent to thermal imaging is
   * required. The rules run on the stored matrix when it is available; otherwise the summary says they were not run.
   *
   * Only of an APPROVED capture: approval freezes the capture and its regions (database trigger, migration 0009), so the numbers a summary states
   * stay the stored ones for good. A draft's regions can still change; a rejected image is unfit for the record and gets no summary.
   */
  app.post('/api/thermal/:id/summaries', { config: { permission: 'thermal:approve' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const c = await getCaptureOr404(me, id)
    if (c.status === 'rejected') throw conflict('This thermal image was rejected as unfit for the record; no summary is made of it.', 'thermal_rejected')
    if (c.status !== 'approved') throw conflict(NOT_APPROVED, 'thermal_not_approved')
    await requireConsent(db, req, { patientId: c.patientId, type: 'thermal_imaging', purpose: 'thermal summary', encounterId: c.encounterId ?? undefined })
    const rois = await db.select().from(thermalRois).where(eq(thermalRois.captureId, id)).orderBy(asc(thermalRois.sortOrder))
    const matrix = await readMatrix(c)
    const flags = matrix ? await flagsFor(c, rois, matrix) : null
    const model = await modelStatus()
    const composed = composeThermalSummary(
      {
        width: c.width,
        height: c.height,
        minC: c.minC,
        maxC: c.maxC,
        meanC: c.meanC,
        stdC: c.stdC,
        protocol: c.protocol as SummaryCaptureInput['protocol'],
        captureSource: c.captureSource as ThermalCaptureSource,
        simulated: c.simulated,
        pixelsWithReading: matrix ? pixelsWithReading(matrix) : null,
      },
      rois.map((r) => ({ label: r.label, shape: r.shape, note: r.note, stats: r.stats as RoiStats })),
      c.pairStats as ThermalPair[],
      flags,
      model,
    )
    let created: SummaryRow
    try {
      created = await db.transaction(async (tx) => {
        const [s] = await tx
          .insert(thermalSummaries)
          .values({ facilityId: c.facilityId, patientId: c.patientId, encounterId: c.encounterId, captureId: c.id, composerVersion: composed.composerVersion, rulesVersion: composed.rulesVersion, model, statements: composed.statements, text: composed.text, simulated: c.simulated, createdBy: me.id })
          .returning()
        await audit(tx, req, { action: 'thermal.summary_generate', entityType: 'thermal_summary', entityId: s!.id, patientId: c.patientId, details: { captureId: c.id, summaryId: s!.id, composerVersion: composed.composerVersion, rulesVersion: composed.rulesVersion, simulated: c.simulated } })
        return s!
      })
    } catch (e) {
      throw guardRefusal(e, 'The thermal summary could not be stored: a summary starts pending and is simulated exactly when its image is.', 'thermal_summary_refused')
    }
    return reply.code(201).send(await toSummary(created.id))
  })

  /** The summaries of one capture, newest first. */
  app.get('/api/thermal/:id/summaries', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const c = await getCaptureOr404(me, id)
    const summaries = await toSummaries(eq(thermalSummaries.captureId, c.id))
    await audit(db, req, { action: 'thermal.summary_list', entityType: 'thermal_capture', entityId: id, patientId: c.patientId, details: { count: summaries.length } })
    return { summaries }
  })

  /**
   * The doctor's decision on a summary: accepted, edited (the edit is kept as the final text) or rejected. Once; it never changes after. Only while
   * its image is approved (a summary is composed of nothing else; this holds for any summary stored before that rule).
   */
  app.post('/api/thermal-summaries/:id/review', { config: { permission: 'thermal:approve' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(ThermalSummaryReviewRequest, req.body)
    const s = await getSummaryOr404(me, id)
    const decided = () => conflict('This summary has already been reviewed, and a reviewed summary does not change. Generate a new summary if needed.', 'summary_decided')
    if (s.status !== 'pending') throw decided()
    const c = await db.query.thermalCaptures.findFirst({ columns: { status: true }, where: and(eq(thermalCaptures.id, s.captureId), eq(thermalCaptures.facilityId, me.facilityId)) })
    if (c?.status !== 'approved') throw conflict('This summary’s thermal image is not approved, so the summary cannot be reviewed: a summary is decided only for an approved image, whose measurements and regions can no longer change.', 'thermal_not_approved')
    const finalText = body.decision === 'edited' ? body.text!.trim() : null
    let row: SummaryRow | null
    try {
      row = await db.transaction(async (tx) => {
        const [u] = await tx
          .update(thermalSummaries)
          .set({ status: body.decision, finalText, decidedBy: me.id, decidedAt: new Date() })
          .where(and(eq(thermalSummaries.id, id), eq(thermalSummaries.status, 'pending')))
          .returning()
        if (!u) return null
        await audit(tx, req, { action: 'thermal.summary_review', entityType: 'thermal_summary', entityId: id, patientId: s.patientId, details: { captureId: s.captureId, decision: body.decision, simulated: s.simulated } })
        return u
      })
    } catch (e) {
      throw guardRefusal(e, 'This summary has already been reviewed, and a reviewed summary does not change.', 'summary_decided')
    }
    if (!row) throw decided()
    return toSummary(row.id)
  })

  /**
   * What the thermal imaging workspace reports for the audit log (opened, camera connected or disconnected, a capture failed): never a frame or an
   * image. At most one audit event per user, consultation and event per window; repeats inside it are answered the same and not logged.
   */
  app.post('/api/encounters/:id/thermal-events', { config: { permission: 'thermal:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(ThermalWorkspaceEventRequest, req.body)
    const e = await getEncounterOr404(db, me, id)
    if (limiter.hit(`thermal-event:${me.id}:${e.id}:${body.event}`, { max: 1, windowSeconds: THERMAL_EVENT_AUDIT_WINDOW_SECONDS }).allowed) {
      await audit(db, req, {
        action: `thermal.${body.event}`,
        entityType: 'encounter',
        entityId: e.id,
        patientId: e.patientId,
        details: { adapter: body.adapter, state: body.state ?? null, reason: body.reason ?? null, deviceModel: body.deviceModel ?? null, repeatsNotLoggedForSeconds: THERMAL_EVENT_AUDIT_WINDOW_SECONDS },
      })
    }
    return reply.code(204).send()
  })
}
