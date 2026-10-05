import { OPEN_VISIT_STATUSES, OverrideRoutingRequest, type RoutingResponse, type RoutingSuggestion, type VisitStatus, type VitalKind } from '@adaxai/contracts'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Db } from '../db/client.ts'
import { aiReviewActions, departments, observations, patients, routingSuggestions, users, visits } from '../db/schema.ts'
import { conflict, notFound } from '../http/errors.ts'
import { parse } from '../http/validate.ts'
import { ageOn } from '../patients/service.ts'
import { SIMULATED } from '../devices/provenance.ts'
import { getVisitOr404, STAFF_FIRST } from '../visits/service.ts'
import type { RoutingRulesSource } from '../settings/load.ts'
import { suggestRouting } from './engine.ts'

const IdParams = z.object({ id: z.uuid() })
const WITH_DOCTOR = 'The patient is with the doctor; routing applies before the consultation starts'
type Row = typeof routingSuggestions.$inferSelect

export function registerRoutingRoutes(app: FastifyInstance, deps: { db: Db; routing: RoutingRulesSource }) {
  const { db, routing } = deps

  /** Visits of other facilities are "not found", and the lookup is audited (shared with the visit routes). */
  const visitOr404 = (me: SessionUser, id: string) => getVisitOr404(db, me, id)

  async function toOut(r: Row): Promise<RoutingSuggestion> {
    const creator = alias(users, 'creator')
    const reviewer = alias(users, 'reviewer')
    const [n] = await db
      .select({ c: creator.fullName, r: reviewer.fullName })
      .from(routingSuggestions)
      .leftJoin(creator, eq(creator.id, routingSuggestions.createdBy))
      .leftJoin(reviewer, eq(reviewer.id, routingSuggestions.reviewedBy))
      .where(eq(routingSuggestions.id, r.id))
    return {
      id: r.id,
      visitId: r.visitId,
      rulesVersion: r.rulesVersion,
      status: r.status as RoutingSuggestion['status'],
      suggestion: r.suggestion as RoutingSuggestion['suggestion'],
      createdAt: r.createdAt.toISOString(),
      createdByName: n?.c ?? null,
      reviewedByName: n?.r ?? null,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      reviewReason: r.reviewReason,
    }
  }

  const latest = async (visitId: string) => (await db.select().from(routingSuggestions).where(eq(routingSuggestions.visitId, visitId)).orderBy(desc(routingSuggestions.createdAt)).limit(1))[0] ?? null

  async function respond(visitId: string): Promise<RoutingResponse> {
    const r = await latest(visitId)
    return { suggestion: r ? await toOut(r) : null, rulesError: routing.lastError }
  }

  async function pendingOr409(me: SessionUser, id: string) {
    const r = await db.query.routingSuggestions.findFirst({ where: eq(routingSuggestions.id, id) })
    if (!r) throw notFound('Routing suggestion')
    const v = await visitOr404(me, r.visitId)
    if (r.status !== 'pending') throw conflict('This suggestion has already been reviewed', 'already_reviewed')
    if (!OPEN_VISIT_STATUSES.includes(v.status as VisitStatus)) throw conflict('Closed visits cannot be changed', 'visit_closed')
    return { r, v }
  }

  async function recordReview(req: FastifyRequest, me: SessionUser, r: Row, action: 'accepted' | 'rejected', reason: string | null, tx: Db | Parameters<Parameters<Db['transaction']>[0]>[0]) {
    await tx.insert(aiReviewActions).values({ subjectType: 'routing_suggestion', subjectId: r.id, action, reason, patientId: r.patientId, actorId: me.id })
    await audit(tx, req, { action: action === 'accepted' ? 'routing.apply' : 'routing.override', entityType: 'routing_suggestion', entityId: r.id, patientId: r.patientId, details: { visitId: r.visitId, rulesVersion: r.rulesVersion } })
  }

  app.get('/api/visits/:id/routing-suggestion', { config: { permission: 'queue:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const v = await visitOr404(me, id)
    await audit(db, req, { action: 'routing.read', entityType: 'visit', entityId: id, patientId: v.patientId })
    return respond(id)
  })

  /** Computes a fresh suggestion from the current rules and visit data; earlier pending ones are superseded. */
  app.post('/api/visits/:id/routing-suggestion', { config: { permission: 'queue:manage' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const v = await visitOr404(me, id)
    if (!OPEN_VISIT_STATUSES.includes(v.status as VisitStatus)) throw conflict('Closed visits cannot be routed', 'visit_closed')
    if (v.status === 'in_consultation') throw conflict(WITH_DOCTOR, 'visit_in_consultation')
    const rules = routing.current()
    const p = (await db.query.patients.findFirst({ where: eq(patients.id, v.patientId) }))!
    // What stands for each kind at this visit: the newest value staff measured, or a device's newest reading where staff measured none. NEVER a
    // device simulator's output: generated numbers must not make a visit urgent, raise a red flag or count as the intake's vital signs.
    const obs = await db
      .selectDistinctOn([observations.kind])
      .from(observations)
      .where(and(eq(observations.visitId, id), eq(observations.enteredInError, false), ne(observations.validationStatus, SIMULATED)))
      .orderBy(observations.kind, STAFF_FIRST, desc(observations.measuredAt))
    const latestByKind = new Map<string, number>(obs.map((o) => [o.kind, o.value]))
    const depts = await db.select({ id: departments.id, code: departments.code, name: departments.name }).from(departments).where(and(eq(departments.facilityId, me.facilityId), eq(departments.isActive, true)))
    const loads = await db
      .select({ id: users.id, fullName: users.fullName, departmentId: users.departmentId, load: sql<number>`count(${visits.id})::int` })
      .from(users)
      .leftJoin(visits, and(eq(visits.assignedDoctorId, users.id), eq(visits.visitDate, v.visitDate), inArray(visits.status, ['waiting', 'in_triage', 'ready', 'in_consultation'])))
      .where(and(eq(users.facilityId, me.facilityId), eq(users.role, 'doctor'), eq(users.isActive, true)))
      .groupBy(users.id)
    const out = suggestRouting(rules, {
      ageYears: ageOn(String(p.dateOfBirth), String(v.visitDate)),
      reasonForVisit: v.chiefComplaint ?? '',
      phone: p.phone,
      currentPriority: v.priority as 'normal' | 'urgent',
      vitals: [...latestByKind].map(([kind, value]) => ({ kind: kind as VitalKind, value })),
      departments: depts,
      doctors: loads,
    })
    await db.transaction(async (tx) => {
      await tx.update(routingSuggestions).set({ status: 'superseded' }).where(and(eq(routingSuggestions.visitId, id), eq(routingSuggestions.status, 'pending')))
      const [row] = await tx.insert(routingSuggestions).values({ visitId: id, patientId: v.patientId, rulesVersion: rules.version, suggestion: out, createdBy: me.id }).returning({ id: routingSuggestions.id })
      await audit(tx, req, { action: 'routing.suggest', entityType: 'routing_suggestion', entityId: row!.id, patientId: v.patientId, details: { visitId: id, rulesVersion: rules.version, redFlags: out.redFlags.map((f) => f.id), department: out.departmentCode } })
    })
    return reply.code(201).send(await respond(id))
  })

  /** Applies the suggested department, clinician and priority to the visit. */
  app.post('/api/routing-suggestions/:id/apply', { config: { permission: 'queue:manage' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const { r, v } = await pendingOr409(me, id)
    // The consultation's author is fixed: no reassignment while the patient is with the doctor (database-enforced too).
    if (v.status === 'in_consultation') throw conflict(WITH_DOCTOR, 'visit_in_consultation')
    const s = r.suggestion as RoutingSuggestion['suggestion']
    if (!s.departmentId) throw conflict('The suggested department is not available; edit the visit instead', 'department_unavailable')
    const dept = await db.query.departments.findFirst({ where: and(eq(departments.id, s.departmentId), eq(departments.isActive, true), eq(departments.facilityId, me.facilityId)) })
    if (!dept) throw conflict('The suggested department is no longer active; request a new suggestion', 'department_unavailable')
    await db.transaction(async (tx) => {
      const [done] = await tx
        .update(routingSuggestions)
        .set({ status: 'applied', reviewedBy: me.id, reviewedAt: new Date() })
        .where(and(eq(routingSuggestions.id, id), eq(routingSuggestions.status, 'pending')))
        .returning({ id: routingSuggestions.id })
      if (!done) throw conflict('This suggestion has already been reviewed', 'already_reviewed')
      // Compare-and-set on the visit status so a concurrent change is not overwritten.
      const [updated] = await tx
        .update(visits)
        .set({ departmentId: s.departmentId!, assignedDoctorId: s.doctorId, priority: s.priority, updatedAt: sql`now()` })
        .where(and(eq(visits.id, v.id), eq(visits.status, v.status), ne(visits.status, 'in_consultation')))
        .returning({ id: visits.id })
      if (!updated) throw conflict('The visit was changed by someone else. Refresh and try again.', 'stale_status')
      await recordReview(req, me, r, 'accepted', null, tx)
    })
    return respond(v.id)
  })

  /** Staff decide differently; the reason is recorded. The visit itself is edited separately. */
  app.post('/api/routing-suggestions/:id/override', { config: { permission: 'queue:manage' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const { reason } = parse(OverrideRoutingRequest, req.body)
    const { r, v } = await pendingOr409(me, id)
    await db.transaction(async (tx) => {
      const [changed] = await tx
        .update(routingSuggestions)
        .set({ status: 'overridden', reviewedBy: me.id, reviewedAt: new Date(), reviewReason: reason })
        .where(and(eq(routingSuggestions.id, id), eq(routingSuggestions.status, 'pending')))
        .returning({ id: routingSuggestions.id })
      // Someone else decided in the meantime: nothing is recorded twice.
      if (!changed) throw conflict('This suggestion was already decided', 'already_decided')
      await recordReview(req, me, r, 'rejected', reason, tx)
    })
    return respond(v.id)
  })
}
