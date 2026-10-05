import { ChangeVisitStatusRequest, CreateVisitRequest, EnteredInErrorRequest, OPEN_VISIT_STATUSES, RecordVitalsRequest, UpdateVisitRequest, VISIT_TRANSITIONS, VisitQuery, VisitStatus, VitalKind } from '@adaxai/contracts'
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { type Db, type DbOrTx, pgCode } from '../db/client.ts'
import { setLifecycleContext } from '../db/lifecycle.ts'
import { departments, encounters, observations, users, visits } from '../db/schema.ts'
import { badRequest, conflict, HttpError, notFound } from '../http/errors.ts'
import { parse } from '../http/validate.ts'
import { ageOn, facilityToday, getPatientOr404 } from '../patients/service.ts'
import { createVisit, getVisitOr404, loadVisits, standingWindow, toObservation, unitFor } from './service.ts'

const IdParams = z.object({ id: z.uuid() })
/** Of what a device sent, how many of the newest readings of each kind (per visit) the record's list of vital signs shows. */
const DEVICE_READINGS_LISTED = 5

async function assertDepartmentAndDoctor(db: DbOrTx, me: SessionUser, departmentId?: string, doctorId?: string | null) {
  if (departmentId) {
    const d = await db.query.departments.findFirst({ where: and(eq(departments.id, departmentId), eq(departments.facilityId, me.facilityId), eq(departments.isActive, true)) })
    if (!d) throw badRequest('Some fields are invalid', [{ path: 'departmentId', message: 'Choose an active department' }])
  }
  if (doctorId) {
    const u = await db.query.users.findFirst({ where: and(eq(users.id, doctorId), eq(users.role, 'doctor'), eq(users.isActive, true), eq(users.facilityId, me.facilityId)) })
    if (!u) throw badRequest('Some fields are invalid', [{ path: 'assignedDoctorId', message: 'Choose an active doctor' }])
  }
}

/** Encounter ids per visit, supplied by the encounters module once it is registered. */
export type EncounterLookup = (db: DbOrTx, visitIds: string[]) => Promise<Map<string, string>>

export function registerVisitRoutes(app: FastifyInstance, { db, encounterLookup }: { db: Db; encounterLookup?: EncounterLookup }) {
  const withEncounters = async (where: SQL, today: string) => {
    const base = await loadVisits(db, where, today)
    if (!encounterLookup || !base.length) return base
    const map = await encounterLookup(
      db,
      base.map((v) => v.id),
    )
    return base.map((v) => ({ ...v, encounterId: map.get(v.id) ?? null }))
  }

  // ---- Check a patient in: creates today's visit with the next token ----
  app.post('/api/visits', { config: { permission: 'queue:manage' } }, async (req, reply) => {
    const me = currentUser(req)
    const body = parse(CreateVisitRequest, req.body)
    await getPatientOr404(db, me.facilityId, body.patientId)
    await assertDepartmentAndDoctor(db, me, body.departmentId, body.assignedDoctorId)
    const today = await facilityToday(db, me.facilityId)
    try {
      const visit = await db.transaction(async (tx) => {
        await setLifecycleContext(tx, { actorId: me.id, source: 'check_in' })
        const v = await createVisit(tx, me, { patientId: body.patientId, departmentId: body.departmentId, assignedDoctorId: body.assignedDoctorId ?? null, priority: body.priority, chiefComplaint: body.chiefComplaint ?? null }, today)
        await audit(tx, req, { action: 'visit.create', entityType: 'visit', entityId: v.id, patientId: body.patientId, details: { token: v.tokenNumber, visitDate: today } })
        return v
      })
      const [out] = await withEncounters(eq(visits.id, visit.id), today)
      return reply.code(201).send(out)
    } catch (e) {
      if (pgCode(e) === '23505') throw conflict('This patient already has an open visit today', 'visit_already_open')
      throw e
    }
  })

  // ---- Queue ----
  app.get('/api/visits', { config: { permission: 'queue:read' } }, async (req) => {
    const me = currentUser(req)
    const q = parse(VisitQuery, req.query)
    const date = q.date ?? (await facilityToday(db, me.facilityId))
    const conds: SQL[] = [eq(visits.facilityId, me.facilityId), eq(visits.visitDate, date)]
    if (q.status) {
      const statuses = q.status.split(',').filter((s) => VisitStatus.safeParse(s).success) as VisitStatus[]
      if (statuses.length) conds.push(inArray(visits.status, statuses))
    }
    if (q.departmentId) conds.push(eq(visits.departmentId, q.departmentId))
    if (q.mine === 'true') {
      const mineCond = me.departmentId
        ? or(eq(visits.assignedDoctorId, me.id), and(isNull(visits.assignedDoctorId), eq(visits.departmentId, me.departmentId)))
        : eq(visits.assignedDoctorId, me.id)
      conds.push(mineCond!)
    }
    const list = await withEncounters(and(...conds)!, date)
    await audit(db, req, { action: 'queue.read', details: { date, count: list.length, mine: q.mine === 'true', patientIds: [...new Set(list.map((v) => v.patient.id))] } })
    return { date, visits: list }
  })

  app.get('/api/patients/:id/visits', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    const list = await withEncounters(and(eq(visits.facilityId, me.facilityId), eq(visits.patientId, id))!, await facilityToday(db, me.facilityId))
    await audit(db, req, { action: 'visit.list', entityType: 'patient', entityId: id, patientId: id })
    // Newest first for history views.
    return { visits: list.sort((a, b) => b.visitDate.localeCompare(a.visitDate) || b.tokenNumber - a.tokenNumber) }
  })

  app.get('/api/visits/:id', { config: { permission: 'queue:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const v = await getVisitOr404(db, me, id)
    await audit(db, req, { action: 'visit.read', entityType: 'visit', entityId: id, patientId: v.patientId })
    const [out] = await withEncounters(eq(visits.id, id), v.visitDate)
    return out
  })

  app.patch('/api/visits/:id', { config: { permission: 'queue:manage' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(UpdateVisitRequest, req.body)
    const v = await getVisitOr404(db, me, id)
    if (!OPEN_VISIT_STATUSES.includes(v.status)) throw conflict('Closed visits cannot be changed', 'visit_closed')
    // The consultation's author is fixed, so the doctor or department cannot change while the patient is with the doctor.
    if (v.status === 'in_consultation' && (body.departmentId !== undefined || body.assignedDoctorId !== undefined)) throw conflict('The patient is with the doctor; the doctor and department cannot change now', 'visit_in_consultation')
    await assertDepartmentAndDoctor(db, me, body.departmentId, body.assignedDoctorId)
    const changed = await db.transaction(async (tx) => {
      // Only while the visit is still in the state the check above saw.
      const [row] = await tx
        .update(visits)
        .set({ ...body, updatedAt: sql`now()` })
        .where(and(eq(visits.id, id), eq(visits.status, v.status)))
        .returning({ id: visits.id })
      if (!row) return false
      await audit(tx, req, { action: 'visit.update', entityType: 'visit', entityId: id, patientId: v.patientId, details: { changed: Object.keys(body) } })
      return true
    })
    if (!changed) throw conflict('The visit was changed by someone else. Refresh and try again.', 'stale_status')
    const [out] = await withEncounters(eq(visits.id, id), v.visitDate)
    return out
  })

  /**
   * Manual status change (queue). Allowed moves are in VISIT_TRANSITIONS and
   * are enforced again by the database, which also records who, when, how and
   * why in the visit's status history. Refused changes are audited.
   */
  app.post('/api/visits/:id/status', { config: { permission: 'queue:manage' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(ChangeVisitStatusRequest, req.body)
    const v = await getVisitOr404(db, me, id)
    const refuse = async (err: HttpError) => {
      await audit(db, req, { action: 'visit.status', outcome: 'failure', entityType: 'visit', entityId: id, patientId: v.patientId, details: { from: v.status, to: body.status, code: err.code } })
      throw err
    }
    if (body.from && body.from !== v.status) await refuse(conflict('The visit was changed by someone else. Refresh and try again.', 'stale_status'))
    if (!VISIT_TRANSITIONS[v.status].includes(body.status)) {
      await refuse(conflict(`A visit that is "${v.status}" cannot be changed to "${body.status}"`, 'invalid_transition'))
    }
    if (body.status === 'cancelled' && (body.reason ?? '').length < 2) {
      throw badRequest('Some fields are invalid', [{ path: 'reason', message: 'Give a reason for cancelling' }])
    }
    if (body.status === 'cancelled' || body.status === 'no_show') {
      const draft = await db.query.encounters.findFirst({ columns: { id: true }, where: and(eq(encounters.visitId, id), eq(encounters.status, 'in_progress')) })
      if (draft) await refuse(conflict('This visit has an unsigned consultation. The doctor must sign or discard it first.', 'consultation_in_progress'))
    }
    const updated = await db.transaction(async (tx) => {
      await setLifecycleContext(tx, { actorId: me.id, source: 'queue', reason: body.reason ?? null })
      // Compare-and-set on the old status so two people cannot apply conflicting changes.
      const [row] = await tx
        .update(visits)
        .set({ status: body.status, statusReason: body.reason ?? null, statusChangedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(visits.id, id), eq(visits.status, v.status)))
        .returning({ id: visits.id })
      if (!row) return false
      await audit(tx, req, { action: 'visit.status', entityType: 'visit', entityId: id, patientId: v.patientId, details: { from: v.status, to: body.status } })
      return true
    })
    if (!updated) await refuse(conflict('The visit was changed by someone else. Refresh and try again.', 'stale_status'))
    const [out] = await withEncounters(eq(visits.id, id), v.visitDate)
    return out
  })

  // ---- Vitals ----
  app.post('/api/visits/:id/observations', { config: { permission: 'observations:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(RecordVitalsRequest, req.body)
    const v = await getVisitOr404(db, me, id)
    if (!OPEN_VISIT_STATUSES.includes(v.status)) throw conflict('Vitals can only be added to an open visit', 'visit_closed')
    const measuredAt = body.measuredAt ? new Date(body.measuredAt) : new Date()
    if (measuredAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('Some fields are invalid', [{ path: 'measuredAt', message: 'Cannot be in the future' }])
    await db.transaction(async (tx) => {
      await setLifecycleContext(tx, { actorId: me.id, source: 'vitals' })
      await tx.insert(observations).values(
        body.items.map((i) => ({ patientId: v.patientId, visitId: id, kind: i.kind, value: i.value, unit: unitFor(i.kind), measuredAt, recordedBy: me.id })),
      )
      // Recording vitals on a waiting visit means intake has started.
      if (v.status === 'waiting') {
        await tx.update(visits).set({ status: 'in_triage', statusChangedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(visits.id, id), eq(visits.status, 'waiting')))
      }
      await audit(tx, req, { action: 'observation.create', entityType: 'visit', entityId: id, patientId: v.patientId, details: { kinds: body.items.map((i) => i.kind) } })
    })
    const [out] = await withEncounters(eq(visits.id, id), v.visitDate)
    return reply.code(201).send(out)
  })

  app.get('/api/patients/:id/observations', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const q = parse(z.object({ kind: VitalKind.optional(), includeErrors: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query)
    const p = await getPatientOr404(db, me.facilityId, id)
    const today = await facilityToday(db, me.facilityId)
    const recorder = alias(users, 'recorder')
    const rows = await db
      .select({ o: observations, by: recorder.fullName })
      .from(observations)
      .leftJoin(recorder, eq(recorder.id, observations.recordedBy))
      // The record's vital signs: every staff measurement, and of what a device sent the newest few of each kind per visit (so that an hour of a
      // band does not push what staff measured off the list). What a device SIMULATOR generated is not part of the record and is never listed here.
      .where(inArray(observations.id, standingWindow(db, and(eq(observations.patientId, id), q.kind ? eq(observations.kind, q.kind) : undefined, q.includeErrors === 'true' ? undefined : eq(observations.enteredInError, false)), DEVICE_READINGS_LISTED)))
      .orderBy(desc(observations.measuredAt))
      .limit(q.limit)
    await audit(db, req, { action: 'observation.read', entityType: 'patient', entityId: id, patientId: id })
    return { observations: rows.map(({ o, by }) => toObservation(o, ageOn(p.dateOfBirth, today), by)) }
  })

  app.post('/api/observations/:id/entered-in-error', { config: { permission: 'observations:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const { reason } = parse(EnteredInErrorRequest, req.body)
    const o = await db.query.observations.findFirst({ where: eq(observations.id, id) })
    if (!o) throw notFound('Observation')
    await getPatientOr404(db, me.facilityId, o.patientId)
    if (o.enteredInError) throw conflict('Already marked as entered in error', 'already_marked')
    await db.update(observations).set({ enteredInError: true, enteredInErrorReason: reason, enteredInErrorBy: me.id }).where(eq(observations.id, id))
    await audit(db, req, { action: 'observation.entered_in_error', entityType: 'observation', entityId: id, patientId: o.patientId, details: { kind: o.kind } })
    return { ok: true }
  })
}
