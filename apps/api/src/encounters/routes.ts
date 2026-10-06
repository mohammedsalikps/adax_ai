import {
  AmendmentRequest,
  CompleteEncounterRequest,
  type CompleteEncounterResult,
  CURRENT_ENCOUNTER_HASH_SCHEME,
  DiscardDraftRequest,
  type MyConsultationsResponse,
  MyConsultationsQuery,
  OPEN_VISIT_STATUSES,
  SaveDraftRequest,
  SIGN_ATTESTATION,
  SignRequest,
  signIssues,
  type StatusEvent,
  type TimelineEntry,
  type VisitStatus,
} from '@adaxai/contracts'
import { and, asc, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { Db } from '../db/client.ts'
import { setLifecycleContext } from '../db/lifecycle.ts'
import { appointments, departments, diagnoses, encounterAmendments, encounters, encounterStatusEvents, patients, prescriptionItems, users, visits, visitStatusEvents } from '../db/schema.ts'
import { badRequest, conflict, forbidden, HttpError } from '../http/errors.ts'
import { parse } from '../http/validate.ts'
import { facilityToday, fullName, getPatientOr404 } from '../patients/service.ts'
import { patientPortalAccess } from '../portal/access.ts'
import { getVisitOr404 } from '../visits/service.ts'
import { activeEncounterForVisit, assertOwnDraft, assertWithDoctor, getEncounterOr404, loadEncounter, PAUSED_MESSAGE, sha256 } from './service.ts'
import { canonicalJsonStrict, verifyEncounterById } from './verify.ts'

const IdParams = z.object({ id: z.uuid() })
/** Open visit statuses other than "with doctor": a draft on such a visit is paused until its author continues it. */
const PAUSED_VISIT_STATUSES: VisitStatus[] = OPEN_VISIT_STATUSES.filter((s) => s !== 'in_consultation')
/** Signed records are listed in "My consultations" for this many days. */
const SIGNED_WINDOW_DAYS = 30

export function registerEncounterRoutes(app: FastifyInstance, { db }: { db: Db }) {
  /**
   * Start the consultation for a visit, or open the one that exists. Starting
   * moves the visit to "with doctor" and assigns it to the doctor. A visit has
   * at most one consultation that is not discarded (database index), so
   * concurrent starts get the same consultation. The author continuing their
   * own draft whose visit went back to the queue moves the visit to the
   * doctor again; anyone else just opens it (read-only).
   */
  app.post('/api/visits/:id/encounter', { config: { permission: 'encounters:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const visit = await getVisitOr404(db, me, id)
    const existing = await activeEncounterForVisit(db, id)
    if (existing) {
      if (existing.status === 'in_progress' && existing.doctorId === me.id) {
        // Decided on the locked, current visit row: a concurrent start or resume may already have moved it.
        const resumed = await db.transaction(async (tx) => {
          const [cur] = await tx.select({ status: visits.status }).from(visits).where(eq(visits.id, id)).for('update')
          if (!cur || !PAUSED_VISIT_STATUSES.includes(cur.status)) return false
          await setLifecycleContext(tx, { actorId: me.id, source: 'consultation_resume' })
          await tx.update(visits).set({ status: 'in_consultation', assignedDoctorId: me.id, statusChangedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(visits.id, id))
          await audit(tx, req, { action: 'encounter.resume', entityType: 'encounter', entityId: existing.id, patientId: existing.patientId, details: { visitId: id, fromStatus: cur.status } })
          return true
        })
        if (resumed) return loadEncounter(db, me, existing)
      }
      // Opening the full record is audited like a read.
      await audit(db, req, { action: 'encounter.read', entityType: 'encounter', entityId: existing.id, patientId: existing.patientId, details: { via: 'resume', visitId: id } })
      return loadEncounter(db, me, existing)
    }
    if (!OPEN_VISIT_STATUSES.includes(visit.status)) throw conflict('This visit is closed', 'visit_closed')

    const created = await db.transaction(async (tx) => {
      await setLifecycleContext(tx, { actorId: me.id, source: 'consultation_start' })
      const [e] = await tx
        .insert(encounters)
        .values({ facilityId: me.facilityId, patientId: visit.patientId, visitId: id, doctorId: me.id, chiefComplaint: visit.chiefComplaint ?? '' })
        .onConflictDoNothing({ target: encounters.visitId, where: sql`status <> 'discarded'` })
        .returning()
      if (!e) return null // another request started it first
      // Compare-and-set: a visit closed or changed meanwhile is not reopened (the insert rolls back).
      const [v] = await tx
        .update(visits)
        .set({ status: 'in_consultation', assignedDoctorId: me.id, statusChangedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(visits.id, id), eq(visits.status, visit.status)))
        .returning({ id: visits.id })
      if (!v) throw conflict('The visit was changed by someone else. Refresh and try again.', 'stale_status')
      await audit(tx, req, {
        action: 'encounter.start',
        entityType: 'encounter',
        entityId: e.id,
        patientId: visit.patientId,
        details: { visitId: id, fromStatus: visit.status, ...(visit.assignedDoctorId && visit.assignedDoctorId !== me.id && { reassignedFrom: visit.assignedDoctorId }) },
      })
      return e
    })
    const e = created ?? (await activeEncounterForVisit(db, id))
    if (!e) throw conflict('The visit was changed by someone else. Refresh and try again.', 'stale_status')
    // Another request started it first: this caller opens that record, which is audited like any read.
    if (!created) await audit(db, req, { action: 'encounter.read', entityType: 'encounter', entityId: e.id, patientId: e.patientId, details: { via: 'concurrent_start', visitId: id } })
    return reply.code(created ? 201 : 200).send(await loadEncounter(db, me, e))
  })

  /** The doctor's own consultations: unsigned drafts (any day), or records signed in the last 30 days. */
  app.get('/api/encounters/mine', { config: { permission: 'encounters:write' } }, async (req) => {
    const me = currentUser(req)
    const q = parse(MyConsultationsQuery, req.query)
    const conds = [eq(encounters.doctorId, me.id), eq(encounters.facilityId, me.facilityId), eq(encounters.status, q.status)]
    if (q.status === 'signed') conds.push(gte(encounters.signedAt, sql`now() - make_interval(days => ${SIGNED_WINDOW_DAYS})`))
    const rows = await db
      .select({ e: encounters, v: visits, p: patients, dept: departments.name })
      .from(encounters)
      .innerJoin(visits, eq(visits.id, encounters.visitId))
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .innerJoin(departments, eq(departments.id, visits.departmentId))
      .where(and(...conds))
      .orderBy(q.status === 'signed' ? desc(encounters.signedAt) : desc(encounters.updatedAt))
      .limit(200)
    const ids = rows.map((r) => r.e.id)
    const count = (table: typeof diagnoses | typeof prescriptionItems | typeof encounterAmendments) =>
      ids.length ? db.select({ id: table.encounterId, n: sql<number>`count(*)::int` }).from(table).where(inArray(table.encounterId, ids)).groupBy(table.encounterId) : Promise.resolve([])
    const [dx, rx, am] = await Promise.all([count(diagnoses), count(prescriptionItems), count(encounterAmendments)])
    const n = (list: { id: string; n: number }[], id: string) => list.find((x) => x.id === id)?.n ?? 0
    const out: MyConsultationsResponse = {
      status: q.status,
      today: await facilityToday(db, me.facilityId),
      signedWindowDays: SIGNED_WINDOW_DAYS,
      items: rows.map(({ e, v, p, dept }) => ({
        encounterId: e.id,
        status: e.status,
        version: e.version,
        startedAt: e.startedAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
        signedAt: e.signedAt?.toISOString() ?? null,
        patient: { id: p.id, fullName: fullName(p), mrn: p.mrn },
        visit: { id: v.id, visitDate: v.visitDate, tokenNumber: v.tokenNumber, status: v.status, departmentName: dept },
        progress: {
          sectionsWithText: [e.chiefComplaint, e.history, e.pastHistory, e.examination, e.assessment, e.plan, e.followUp].filter((t) => t.trim()).length,
          diagnoses: n(dx, e.id),
          medicines: n(rx, e.id),
        },
        amendmentCount: n(am, e.id),
      })),
    }
    await audit(db, req, { action: 'encounter.list', details: { status: q.status, count: out.items.length, patientIds: [...new Set(out.items.map((i) => i.patient.id))] } })
    return out
  })

  app.get('/api/encounters/:id', { config: { permission: 'encounters:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const e = await getEncounterOr404(db, me, id)
    await audit(db, req, { action: 'encounter.read', entityType: 'encounter', entityId: id, patientId: e.patientId })
    return loadEncounter(db, me, e)
  })

  /** Status history of the consultation and its visit, with who, when, how and why. */
  app.get('/api/encounters/:id/history', { config: { permission: 'encounters:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const e = await getEncounterOr404(db, me, id)
    const actor = alias(users, 'actor')
    const [ve, ee] = await Promise.all([
      db.select({ r: visitStatusEvents, by: actor.fullName }).from(visitStatusEvents).leftJoin(actor, eq(actor.id, visitStatusEvents.actorUserId)).where(eq(visitStatusEvents.visitId, e.visitId)).orderBy(asc(visitStatusEvents.id)),
      db.select({ r: encounterStatusEvents, by: actor.fullName }).from(encounterStatusEvents).leftJoin(actor, eq(actor.id, encounterStatusEvents.actorUserId)).where(eq(encounterStatusEvents.encounterId, id)).orderBy(asc(encounterStatusEvents.id)),
    ])
    const events: (StatusEvent & { order: number })[] = [
      ...ve.map(({ r, by }) => ({ subject: 'visit' as const, from: r.fromStatus, to: r.toStatus, source: r.source, reason: r.reason, actorName: by, at: r.changedAt.toISOString(), order: 0 })),
      ...ee.map(({ r, by }) => ({ subject: 'consultation' as const, from: r.fromStatus, to: r.toStatus, source: r.source, reason: r.reason, actorName: by, at: r.changedAt.toISOString(), order: 1 })),
    ]
    // Same transaction time: the consultation change is shown before the visit change it caused.
    events.sort((a, b) => a.at.localeCompare(b.at) || b.order - a.order)
    await audit(db, req, { action: 'encounter.history_read', entityType: 'encounter', entityId: id, patientId: e.patientId })
    return { events: events.map(({ order: _order, ...ev }) => ev) }
  })

  /** Re-checks a signed record against its fingerprints. See verify.ts for what is and is not covered. */
  app.get('/api/encounters/:id/verification', { config: { permission: 'encounters:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const e = await getEncounterOr404(db, me, id)
    // Read in one snapshot; the audit entry for the check is written afterwards (the chain needs READ COMMITTED).
    const result = await verifyEncounterById(db, e.id)
    await audit(db, req, { action: 'encounter.verify', entityType: 'encounter', entityId: id, patientId: e.patientId, details: { status: result.status, scheme: result.scheme, failed: result.checks.filter((c) => c.result === 'fail').map((c) => c.key) } })
    return result
  })

  /** Autosave of the working draft: the author only, before signing, while the visit is with the doctor. */
  app.put('/api/encounters/:id/draft', { config: { permission: 'encounters:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(SaveDraftRequest, req.body)
    const e = await getEncounterOr404(db, me, id)
    assertOwnDraft(e, me, 'edit')
    await assertWithDoctor(db, e)
    // A course given in days without a first day starts on the consultation's date (stored, so what is signed says it: scheme v3).
    const visitDate = body.prescription.some((p) => p.durationDays && !p.startDate) ? ((await db.select({ d: visits.visitDate }).from(visits).where(eq(visits.id, e.visitId)))[0]?.d ?? null) : null
    const rxRows = body.prescription.map((p, i) => ({ encounterId: id, ...p, durationDays: p.durationDays ?? null, startDate: p.startDate ?? (p.durationDays ? visitDate : null), sortOrder: i }))

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(encounters)
        .set({ ...body.note, version: sql`${encounters.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(encounters.id, id), eq(encounters.version, body.version), eq(encounters.status, 'in_progress'), withDoctor))
        .returning()
      if (!row) return null
      await tx.delete(diagnoses).where(eq(diagnoses.encounterId, id))
      if (body.diagnoses.length) await tx.insert(diagnoses).values(body.diagnoses.map((d, i) => ({ encounterId: id, description: d.description, code: d.code ?? null, kind: d.kind, sortOrder: i })))
      await tx.delete(prescriptionItems).where(eq(prescriptionItems.encounterId, id))
      if (rxRows.length) await tx.insert(prescriptionItems).values(rxRows)
      await audit(tx, req, { action: 'encounter.save', entityType: 'encounter', entityId: id, patientId: e.patientId, details: { version: row.version } })
      return row
    })
    if (!updated) await explainRefusedWrite(db, me, id)
    return loadEncounter(db, me, updated!)
  })

  /**
   * Signing freezes the record (database-enforced). It no longer completes the
   * visit (HERO final): the visit stays with the doctor, and cannot go back to
   * the queue (migration 0033), until the doctor completes the consultation
   * (POST /api/encounters/:id/complete). The visit must be with the doctor; the
   * change is compare-and-set, so a stale or concurrent request changes nothing.
   */
  app.post('/api/encounters/:id/sign', { config: { permission: 'encounters:sign' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(SignRequest, req.body)
    const e = await getEncounterOr404(db, me, id)
    assertOwnDraft(e, me, 'sign')
    if (e.version !== body.version) throw new HttpError(409, 'version_conflict', 'Unsaved or newer changes exist. Review the latest version before signing.')
    await assertWithDoctor(db, e)

    const current = await loadEncounter(db, me, e)
    const missing = signIssues(current)
    if (missing.length) throw badRequest('The record is not complete enough to sign', missing)

    const signedAt = new Date()
    // What is signed (scheme adaxai.encounter.v3: v2 plus each medicine's durationDays and startDate; see verify.ts for what is covered).
    const snapshot = {
      scheme: CURRENT_ENCOUNTER_HASH_SCHEME,
      encounterId: e.id,
      facilityId: e.facilityId,
      patient: { id: current.patient.id, mrn: current.patient.mrn, fullName: current.patient.fullName, dateOfBirth: current.patient.dateOfBirth, sex: current.patient.sex },
      doctor: current.doctor,
      visit: { id: current.visit.id, visitDate: current.visit.visitDate, tokenNumber: current.visit.tokenNumber, reasonForVisit: current.visit.reasonForVisit },
      note: current.note,
      diagnoses: current.diagnoses,
      prescription: current.prescription,
      // AI-produced text in the note keeps a reference to the AI artifact it came from.
      aiInsertions: current.aiInsertions.map((i) => ({ id: i.id, section: i.section, subjectType: i.subjectType, subjectId: i.subjectId, producedBy: i.producedBy, insertedAt: i.insertedAt, retained: i.retained })),
      attestation: SIGN_ATTESTATION,
      signedAt: signedAt.toISOString(),
    }
    const contentHash = sha256(canonicalJsonStrict(snapshot))
    const signed = await db.transaction(async (tx) => {
      await setLifecycleContext(tx, { actorId: me.id, source: 'consultation_signed' })
      const [row] = await tx
        .update(encounters)
        .set({ status: 'signed', signedAt, signedSnapshot: snapshot, contentHash, hashScheme: CURRENT_ENCOUNTER_HASH_SCHEME, version: sql`${encounters.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(encounters.id, id), eq(encounters.version, body.version), eq(encounters.status, 'in_progress')))
        .returning()
      if (!row) throw new HttpError(409, 'version_conflict', 'The consultation changed while signing. Review and sign again.')
      // The visit must still be with the doctor at this moment (locked, so it cannot leave while the record is signed); it stays there.
      const [v] = await tx.select({ id: visits.id }).from(visits).where(and(eq(visits.id, e.visitId), eq(visits.status, 'in_consultation'))).for('share')
      if (!v) throw conflict(PAUSED_MESSAGE, 'visit_not_in_consultation')
      await audit(tx, req, { action: 'encounter.sign', entityType: 'encounter', entityId: id, patientId: e.patientId, details: { contentHash, hashScheme: CURRENT_ENCOUNTER_HASH_SCHEME, visitId: e.visitId } })
      return row
    })
    return loadEncounter(db, me, signed)
  })

  /**
   * Completes a signed consultation (HERO final; signing no longer does): the
   * visit moves from "with the doctor" to completed (the database requires the
   * signed record, and completes the linked appointment with it), the status
   * history names the doctor and "consultation completed", and the record and
   * its prescription become visible to the patient. Only the doctor who signed
   * it, only once: a second request changes nothing and says so (409).
   */
  app.post('/api/encounters/:id/complete', { config: { permission: 'encounters:sign' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(CompleteEncounterRequest, req.body ?? {})
    const e = await getEncounterOr404(db, me, id)
    if (e.status === 'discarded') throw conflict('This draft was discarded. It is kept read-only and cannot be completed.', 'encounter_discarded')
    if (e.status !== 'signed') throw conflict('Sign the consultation before completing it.', 'not_signed')
    if (e.doctorId !== me.id) throw forbidden('Only the doctor who signed this consultation can complete it')
    if (body.version !== undefined && body.version !== e.version) throw new HttpError(409, 'version_conflict', 'This consultation changed since you opened it. Reload it first.')

    const completed = await db.transaction(async (tx) => {
      await setLifecycleContext(tx, { actorId: me.id, source: 'consultation_completed' })
      // Compare-and-set: only a visit still with the doctor is completed; a concurrent second request finds it completed and changes nothing.
      const [v] = await tx
        .update(visits)
        .set({ status: 'completed', statusChangedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(visits.id, e.visitId), eq(visits.status, 'in_consultation')))
        .returning({ id: visits.id, completedAt: visits.statusChangedAt })
      if (!v) {
        const [now] = await tx.select({ status: visits.status }).from(visits).where(eq(visits.id, e.visitId))
        if (now?.status === 'completed') throw conflict('This consultation is already completed.', 'already_completed')
        throw conflict('The visit is no longer with the doctor, so this consultation cannot be completed now. Refresh and try again.', 'visit_not_in_consultation')
      }
      const [appt] = await tx.select({ id: appointments.id }).from(appointments).where(eq(appointments.visitId, e.visitId))
      // Ids only (no clinical text).
      await audit(tx, req, { action: 'encounter.complete', entityType: 'encounter', entityId: id, patientId: e.patientId, details: { visitId: e.visitId, appointmentId: appt?.id ?? null } })
      return v
    })
    const out: CompleteEncounterResult = { encounterId: id, visitId: e.visitId, completedAt: completed.completedAt.toISOString(), patientPortalAccess: await patientPortalAccess(db, e.patientId) }
    return out
  })

  /**
   * Closes an unsigned draft without signing. The draft is kept read-only
   * with who, when and why (database-enforced), it leaves the patient's
   * record, and the visit goes back to the queue if it was with the doctor.
   */
  app.post('/api/encounters/:id/discard', { config: { permission: 'encounters:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(DiscardDraftRequest, req.body)
    const e = await getEncounterOr404(db, me, id)
    assertOwnDraft(e, me, 'discard')
    if (e.version !== body.version) throw new HttpError(409, 'version_conflict', 'The draft changed since you opened it. Review the latest version first.')
    const discarded = await db.transaction(async (tx) => {
      await setLifecycleContext(tx, { actorId: me.id, source: 'consultation_discarded', reason: body.reason })
      const [row] = await tx
        .update(encounters)
        .set({ status: 'discarded', discardedAt: sql`now()`, discardedBy: me.id, discardReason: body.reason, version: sql`${encounters.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(encounters.id, id), eq(encounters.version, body.version), eq(encounters.status, 'in_progress')))
        .returning()
      if (!row) throw new HttpError(409, 'version_conflict', 'The draft changed while discarding. Review it and try again.')
      const back = await tx
        .update(visits)
        .set({ status: 'ready', statusChangedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(visits.id, e.visitId), eq(visits.status, 'in_consultation')))
        .returning({ id: visits.id })
      // The reason stays with the consultation and its status history, not in the audit log.
      await audit(tx, req, { action: 'encounter.discard', entityType: 'encounter', entityId: id, patientId: e.patientId, details: { visitId: e.visitId, visitReturnedToQueue: back.length > 0, version: row.version } })
      return row
    })
    return loadEncounter(db, me, discarded)
  })

  /**
   * Post-signing correction: the signed record stays unchanged; the amendment
   * is appended, attributed, timestamped and linked into the record's
   * fingerprint chain by the database.
   */
  app.post('/api/encounters/:id/amendments', { config: { permission: 'encounters:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(AmendmentRequest, req.body)
    const e = await getEncounterOr404(db, me, id)
    if (e.status !== 'signed') throw conflict('Edit the draft directly; amendments are for signed records', 'not_signed')
    // Product decision (docs/STATUS.md): only the doctor who signed a consultation amends it.
    if (e.doctorId !== me.id) throw forbidden('Only the doctor who signed this consultation can amend it')
    await db.transaction(async (tx) => {
      const [a] = await tx
        .insert(encounterAmendments)
        .values({ encounterId: id, authorId: me.id, reason: body.reason, content: body.content })
        .returning({ id: encounterAmendments.id, seq: encounterAmendments.seq, contentHash: encounterAmendments.contentHash })
      await audit(tx, req, { action: 'encounter.amend', entityType: 'encounter', entityId: id, patientId: e.patientId, details: { amendmentId: a!.id, seq: a!.seq, contentHash: a!.contentHash } })
    })
    return reply.code(201).send(await loadEncounter(db, me, e))
  })

  /** Patient timeline: every visit, with consultation summaries where they exist (discarded drafts are not part of it). */
  app.get('/api/patients/:id/timeline', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    const doctor = alias(users, 'doctor')
    const rows = await db
      .select({ v: visits, e: encounters, deptName: departments.name, doctorName: doctor.fullName })
      .from(visits)
      .innerJoin(departments, eq(departments.id, visits.departmentId))
      .leftJoin(encounters, and(eq(encounters.visitId, visits.id), ne(encounters.status, 'discarded')))
      .leftJoin(doctor, eq(doctor.id, sql`coalesce(${encounters.doctorId}, ${visits.assignedDoctorId})`))
      .where(and(eq(visits.patientId, id), eq(visits.facilityId, me.facilityId)))
      .orderBy(desc(visits.visitDate), desc(visits.tokenNumber))
    const encIds = rows.flatMap((r) => (r.e ? [r.e.id] : []))
    const [dx, rx, am] = encIds.length
      ? await Promise.all([
          db.select().from(diagnoses).where(inArray(diagnoses.encounterId, encIds)).orderBy(asc(diagnoses.sortOrder)),
          db.select().from(prescriptionItems).where(inArray(prescriptionItems.encounterId, encIds)).orderBy(asc(prescriptionItems.sortOrder)),
          db.select({ encounterId: encounterAmendments.encounterId, n: sql<number>`count(*)::int` }).from(encounterAmendments).where(inArray(encounterAmendments.encounterId, encIds)).groupBy(encounterAmendments.encounterId),
        ])
      : [[], [], []]
    const entries: TimelineEntry[] = rows.map(({ v, e, deptName, doctorName }) => ({
      kind: e ? 'encounter' : 'visit',
      id: e?.id ?? v.id,
      date: v.visitDate,
      title: e ? (e.status === 'signed' ? 'Consultation' : 'Consultation in progress') : 'OPD visit',
      status: e ? e.status : v.status,
      doctorName,
      departmentName: deptName,
      diagnoses: dx.filter((d) => d.encounterId === e?.id).map((d) => (d.code ? `${d.description} (${d.code})` : d.description)),
      medications: rx.filter((r) => r.encounterId === e?.id).map((r) => [r.drugName, r.strength].filter(Boolean).join(' ')),
      amendmentCount: am.find((a) => a.encounterId === e?.id)?.n ?? 0,
      encounterId: e?.id ?? null,
    }))
    await audit(db, req, { action: 'patient.timeline_read', entityType: 'patient', entityId: id, patientId: id })
    return { entries }
  })
}

/** The draft's visit is still with the doctor (checked atomically with the write). */
const withDoctor = sql`exists (select 1 from ${visits} where ${visits.id} = ${encounters.visitId} and ${visits.status} = 'in_consultation')`

/** Says why a compare-and-set write to a draft changed nothing. */
async function explainRefusedWrite(db: Db, me: Parameters<typeof assertOwnDraft>[1], id: string): Promise<never> {
  const now = await getEncounterOr404(db, me, id)
  assertOwnDraft(now, me, 'edit')
  await assertWithDoctor(db, now)
  throw new HttpError(409, 'version_conflict', `This consultation was changed elsewhere (now version ${now.version}). Reload to continue.`)
}
