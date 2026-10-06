import { CONSENT_LABELS, CONSENT_VERSIONS, CONSENT_WITHDRAWAL_EFFECTS_FOR_PATIENT, type ConsentType, consentWording, medicineCourse, type NotificationPayload, type PortalAppointmentList, type PortalConsent, type PortalCurrentPrescriptionItem, type PortalCurrentPrescriptionResponse, type PortalNotifications, WithdrawConsentRequest, type PortalHome, type PortalProfile, type PortalRecord, type PortalRecordSummary, type PortalThermalReport, type PortalVisit, type PortalVital } from '@adaxai/contracts'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { SIMULATED } from '../devices/provenance.ts'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import { SESSION_COOKIE } from '../auth/sessions.ts'
import { consentState, withdrawConsentType } from '../consents/service.ts'
import type { Db } from '../db/client.ts'
import { allergies, appointments, consents, departments, diagnoses, encounterAmendments, encounters, facilities, notifications, observations, patients, prescriptionItems, thermalCaptures, users, visits } from '../db/schema.ts'
import { visitCompletedAt } from '../encounters/service.ts'
import { forbidden, HttpError, notFound } from '../http/errors.ts'
import { parse } from '../http/validate.ts'
import { facilityToday } from '../patients/service.ts'

/**
 * Patient portal API. Every query is scoped to the patient linked to the
 * signed-in account (session.patientId); no route accepts a patient id.
 * Only finalised information is shown: signed consultation records (with
 * amendments) once the doctor has completed the consultation, measured vital
 * signs, doctor-approved thermal measurements.
 * Drafts, unreviewed AI output, transcripts, audio and photographs are not
 * part of the portal.
 */
export function registerPortalRoutes(app: FastifyInstance, deps: { db: Db }) {
  const { db } = deps
  const perm = { config: { permission: 'portal:self' as const } }

  /**
   * The signed-in patient. Portal access also needs the patient's portal
   * consent on every request (withdrawal switches the account off as well;
   * this is the second line of defence).
   */
  async function self(req: FastifyRequest) {
    const me = currentUser(req)
    if (me.role !== 'patient' || !me.patientId) throw forbidden('This account is not linked to a patient record')
    const { state } = await consentState(db, me.patientId, 'portal_access')
    if (state !== 'granted' && state !== 'outdated') {
      await audit(db, req, { action: 'portal.access', outcome: 'denied', patientId: me.patientId, details: { reason: 'portal_consent_' + state } })
      req.denialAudited = true
      throw new HttpError(403, 'portal_consent_withdrawn', 'Online access to your records is switched off. Ask the clinic if you want it back.')
    }
    return { me, patientId: me.patientId }
  }

  const read = (req: FastifyRequest, patientId: string, what: string, entityId?: string) => audit(db, req, { action: 'portal.read', entityType: what, entityId: entityId ?? patientId, patientId, details: { what } })

  /**
   * The patient's consultation records: signed AND completed by the doctor (HERO final: signing alone does not show a record; the doctor's
   * explicit Complete does). Newest signing first. Every record signed before Complete existed has a completed visit.
   */
  async function completedRecords(patientId: string) {
    const doctor = alias(users, 'doctor')
    const rows = await db
      .select({ e: encounters, doctorName: doctor.fullName, reg: doctor.registrationNumber, dept: departments.name, visitDate: visits.visitDate, visitStatusChangedAt: visits.statusChangedAt })
      .from(encounters)
      .innerJoin(doctor, eq(doctor.id, encounters.doctorId))
      .innerJoin(visits, eq(visits.id, encounters.visitId))
      .innerJoin(departments, eq(departments.id, visits.departmentId))
      .where(and(eq(encounters.patientId, patientId), eq(encounters.status, 'signed'), eq(visits.status, 'completed')))
      .orderBy(desc(encounters.signedAt))
    const ids = rows.map((r) => r.e.id)
    const dx = ids.length ? await db.select().from(diagnoses).where(inArray(diagnoses.encounterId, ids)).orderBy(asc(diagnoses.sortOrder)) : []
    const rx = ids.length ? await db.select().from(prescriptionItems).where(inArray(prescriptionItems.encounterId, ids)).orderBy(asc(prescriptionItems.sortOrder)) : []
    return { rows, dx, rx }
  }

  /** A medicine as signed (the eight written fields). */
  const written = (p: typeof prescriptionItems.$inferSelect) => ({ drugName: p.drugName, strength: p.strength, form: p.form, dose: p.dose, route: p.route, frequency: p.frequency, duration: p.duration, instructions: p.instructions })
  /** ... with its structured course on the facility's calendar day `today` ("Duration not recorded" when it has none, never "Completed"). */
  const withCourse = (p: typeof prescriptionItems.$inferSelect, today: string): PortalCurrentPrescriptionItem => ({ ...written(p), durationDays: p.durationDays, startDate: p.startDate, course: medicineCourse(p, today) })

  const summary = (r: Awaited<ReturnType<typeof completedRecords>>['rows'][number], dx: (typeof diagnoses.$inferSelect)[], rx: (typeof prescriptionItems.$inferSelect)[]): PortalRecordSummary => ({
    id: r.e.id,
    signedAt: r.e.signedAt!.toISOString(),
    doctorName: r.doctorName,
    departmentName: r.dept,
    chiefComplaint: r.e.chiefComplaint,
    diagnoses: dx.filter((d) => d.encounterId === r.e.id).map((d) => ({ description: d.description, code: d.code })),
    prescriptionCount: rx.filter((p) => p.encounterId === r.e.id).length,
    followUp: r.e.followUp,
  })

  async function visitList(patientId: string): Promise<PortalVisit[]> {
    const doctor = alias(users, 'doctor')
    const rows = await db
      .select({ v: visits, dept: departments.name, doctorName: doctor.fullName, encId: encounters.id, encStatus: encounters.status })
      .from(visits)
      .innerJoin(departments, eq(departments.id, visits.departmentId))
      .leftJoin(encounters, and(eq(encounters.visitId, visits.id), ne(encounters.status, 'discarded')))
      .leftJoin(doctor, eq(doctor.id, encounters.doctorId))
      .where(eq(visits.patientId, patientId))
      .orderBy(desc(visits.visitDate), desc(visits.checkedInAt))
    return rows.map(({ v, dept, doctorName, encId, encStatus }) => ({
      id: v.id,
      visitDate: String(v.visitDate),
      tokenNumber: v.tokenNumber,
      departmentName: dept,
      doctorName,
      status: v.status,
      reasonForVisit: v.chiefComplaint,
      // A record is the patient's to open once the doctor has completed the consultation (as in completedRecords).
      recordId: encStatus === 'signed' && v.status === 'completed' ? encId : null,
    }))
  }

  app.get('/api/portal/home', perm, async (req): Promise<PortalHome> => {
    const { patientId } = await self(req)
    const p = (await db.query.patients.findFirst({ where: eq(patients.id, patientId) }))!
    const { rows } = await completedRecords(patientId)
    const visitsOut = await visitList(patientId)
    await read(req, patientId, 'home')
    return {
      profile: { fullName: [p.givenName, p.familyName].filter(Boolean).join(' '), mrn: p.mrn },
      upcoming: rows
        .filter((r) => r.e.followUp.trim())
        .slice(0, 3)
        .map((r) => ({ recordId: r.e.id, signedAt: r.e.signedAt!.toISOString(), followUp: r.e.followUp, doctorName: r.doctorName })),
      lastVisit: visitsOut[0] ?? null,
      counts: { records: rows.length, visits: visitsOut.length },
    }
  })

  app.get('/api/portal/profile', perm, async (req): Promise<PortalProfile> => {
    const { patientId } = await self(req)
    const [row] = await db.select({ p: patients, facility: facilities.name }).from(patients).innerJoin(facilities, eq(facilities.id, patients.facilityId)).where(eq(patients.id, patientId))
    const p = row!.p
    const al = await db.select().from(allergies).where(and(eq(allergies.patientId, patientId), eq(allergies.status, 'active')))
    await read(req, patientId, 'profile')
    return {
      mrn: p.mrn,
      fullName: [p.givenName, p.familyName].filter(Boolean).join(' '),
      dateOfBirth: String(p.dateOfBirth),
      sex: p.sex,
      phone: p.phone,
      email: p.email,
      address: [p.addressLine, p.city, p.state, p.postalCode].filter(Boolean).join(', ') || null,
      bloodGroup: p.bloodGroup,
      preferredLanguage: p.preferredLanguage,
      emergencyContact: { name: p.emergencyContactName, phone: p.emergencyContactPhone },
      allergies: al.map((a) => ({ substance: a.substance, reaction: a.reaction, severity: a.severity })),
      noKnownAllergies: p.noKnownAllergies,
      facilityName: row!.facility,
    }
  })

  app.get('/api/portal/visits', perm, async (req) => {
    const { patientId } = await self(req)
    const out = await visitList(patientId)
    await read(req, patientId, 'visits')
    return { visits: out }
  })

  app.get('/api/portal/records', perm, async (req) => {
    const { patientId } = await self(req)
    const { rows, dx, rx } = await completedRecords(patientId)
    await read(req, patientId, 'records')
    return { records: rows.map((r) => summary(r, dx, rx)) }
  })

  /**
   * "Today's prescription": the prescription of the patient's newest completed consultation (newest signing), from the same signed rows as
   * the record (no copy), with each medicine's course on the facility's calendar day (Day 3 of 7, Completed, Duration not recorded), the
   * advice (the note's plan) and the follow-up. `prescription` is null until a consultation of the patient has been completed.
   */
  app.get('/api/portal/prescriptions/current', perm, async (req): Promise<PortalCurrentPrescriptionResponse> => {
    const { me, patientId } = await self(req)
    const today = await facilityToday(db, me.facilityId)
    const { rows, dx, rx } = await completedRecords(patientId)
    const r = rows[0]
    await read(req, patientId, 'current_prescription', r?.e.id)
    if (!r) return { today, prescription: null }
    const completedAt = (await visitCompletedAt(db, [r.e.visitId])).get(r.e.visitId) ?? r.visitStatusChangedAt.toISOString()
    return {
      today,
      prescription: {
        recordId: r.e.id,
        date: String(r.visitDate),
        signedAt: r.e.signedAt!.toISOString(),
        completedAt,
        doctorName: r.doctorName,
        doctorRegistrationNumber: r.reg,
        departmentName: r.dept,
        diagnoses: dx.filter((d) => d.encounterId === r.e.id).map((d) => ({ description: d.description, code: d.code })),
        items: rx.filter((p) => p.encounterId === r.e.id).map((p) => withCourse(p, today)),
        advice: r.e.plan,
        followUp: r.e.followUp,
      },
    }
  })

  /** One completed consultation's record. Another patient's record, an unsigned draft, or a record not completed yet is "not found". */
  app.get('/api/portal/records/:id', perm, async (req): Promise<PortalRecord> => {
    const { me, patientId } = await self(req)
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const { rows, dx, rx } = await completedRecords(patientId)
    const r = rows.find((x) => x.e.id === id)
    if (!r) {
      // Another patient's record, a draft, one not completed yet or a wrong id: one answer for all, and the attempt is recorded.
      await audit(db, req, { action: 'portal.read', outcome: 'denied', entityType: 'record', entityId: id, patientId, details: { what: 'record', reason: 'not_found_or_not_owned' } })
      throw notFound('Record')
    }
    const author = alias(users, 'author')
    const am = await db.select({ a: encounterAmendments, name: author.fullName }).from(encounterAmendments).innerJoin(author, eq(author.id, encounterAmendments.authorId)).where(eq(encounterAmendments.encounterId, id)).orderBy(asc(encounterAmendments.createdAt))
    const today = await facilityToday(db, me.facilityId)
    await read(req, patientId, 'record', id)
    return {
      ...summary(r, dx, rx),
      doctorRegistrationNumber: r.reg,
      history: r.e.history,
      examination: r.e.examination,
      assessment: r.e.assessment,
      plan: r.e.plan,
      prescription: rx.filter((p) => p.encounterId === id).map((p) => withCourse(p, today)),
      amendments: am.map(({ a, name }) => ({ createdAt: a.createdAt.toISOString(), authorName: name, reason: a.reason, content: a.content })),
      contentHash: r.e.contentHash ?? '',
      today,
    }
  })

  /**
   * The patient's own appointments (a moved appointment is shown as its new
   * time), on the clinic's clock. No staff free text (the booking reason is
   * not shown) and nothing about other patients.
   */
  app.get('/api/portal/appointments', perm, async (req): Promise<PortalAppointmentList> => {
    const { patientId } = await self(req)
    const doctor = alias(users, 'doctor')
    const rows = await db
      .select({
        a: appointments,
        dept: departments.name,
        doctorName: doctor.fullName,
        timezone: facilities.timezone,
        localDate: sql<string>`to_char(${appointments.scheduledAt} at time zone ${facilities.timezone}, 'YYYY-MM-DD')`,
        localTime: sql<string>`to_char(${appointments.scheduledAt} at time zone ${facilities.timezone}, 'HH24:MI')`,
      })
      .from(appointments)
      .innerJoin(departments, eq(departments.id, appointments.departmentId))
      .innerJoin(facilities, eq(facilities.id, appointments.facilityId))
      .leftJoin(doctor, eq(doctor.id, appointments.doctorId))
      .where(and(eq(appointments.patientId, patientId), ne(appointments.status, 'rescheduled')))
      .orderBy(desc(appointments.scheduledAt))
      .limit(100)
    await read(req, patientId, 'appointments')
    return {
      appointments: rows.map(({ a, dept, doctorName, timezone, localDate, localTime }) => ({
        id: a.id,
        status: a.status,
        scheduledAt: a.scheduledAt.toISOString(),
        timezone,
        localDate,
        localTime,
        durationMinutes: a.durationMinutes,
        departmentName: dept,
        doctorName,
        awaitingOutcome: a.status === 'booked' && a.scheduledAt.getTime() <= Date.now(),
      })),
    }
  })

  /** Messages the clinic made available to this patient (only delivered ones exist for the patient). */
  app.get('/api/portal/notifications', perm, async (req): Promise<PortalNotifications> => {
    const { patientId } = await self(req)
    const mine = and(eq(notifications.patientId, patientId), eq(notifications.status, 'delivered'))
    // Unread first (so a read message cannot push an unread one out of the list), then newest delivery first. With more than 50 unread the oldest are not listed; the count stays right.
    const rows = await db.select().from(notifications).where(mine).orderBy(desc(sql`${notifications.readAt} is null`), desc(notifications.deliveredAt)).limit(50)
    const [counted] = await db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(and(mine, isNull(notifications.readAt)))
    const [clinic] = await db.select({ timezone: facilities.timezone }).from(facilities).where(eq(facilities.id, currentUser(req).facilityId))
    await read(req, patientId, 'notifications')
    return {
      unread: counted?.unread ?? 0,
      timezone: clinic?.timezone ?? 'UTC',
      notifications: rows.map((n) => ({ id: n.id, kind: n.kind, deliveredAt: (n.deliveredAt ?? n.createdAt).toISOString(), readAt: n.readAt?.toISOString() ?? null, appointmentId: n.appointmentId, payload: n.payload as NotificationPayload })),
    }
  })

  /** Marks one of the patient's own messages as read. Another patient's message is "not found"; reading twice changes nothing. */
  app.post('/api/portal/notifications/:id/read', perm, async (req) => {
    const { patientId } = await self(req)
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const [marked] = await db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.id, id), eq(notifications.patientId, patientId), eq(notifications.status, 'delivered'), isNull(notifications.readAt)))
      .returning({ id: notifications.id })
    if (!marked) {
      const own = await db.query.notifications.findFirst({ columns: { id: true }, where: and(eq(notifications.id, id), eq(notifications.patientId, patientId), eq(notifications.status, 'delivered')) })
      if (!own) {
        await audit(db, req, { action: 'portal.read', outcome: 'denied', entityType: 'notification', entityId: id, patientId, details: { what: 'notification', reason: 'not_found_or_not_owned' } })
        req.denialAudited = true
        throw notFound('Notification')
      }
    }
    await read(req, patientId, 'notification', id)
    return { ok: true }
  })

  app.get('/api/portal/vitals', perm, async (req) => {
    const { patientId } = await self(req)
    // What a device simulator generated is not a measurement of the patient: it is never shown to them.
    const rows = await db.select().from(observations).where(and(eq(observations.patientId, patientId), eq(observations.enteredInError, false), ne(observations.validationStatus, SIMULATED))).orderBy(desc(observations.measuredAt)).limit(500)
    await read(req, patientId, 'vitals')
    return { vitals: rows.map((o): PortalVital => ({ kind: o.kind as PortalVital['kind'], value: o.value, unit: o.unit, measuredAt: o.measuredAt.toISOString(), source: o.source as PortalVital['source'] })) }
  })

  app.get('/api/portal/consents', perm, async (req) => {
    const { patientId } = await self(req)
    const rows = await db.select().from(consents).where(eq(consents.patientId, patientId)).orderBy(desc(consents.recordedAt))
    await read(req, patientId, 'consents')
    return {
      consents: rows.map((c): PortalConsent => {
        const type = c.type as ConsentType
        // The wording this patient agreed to (an earlier version where applicable).
        const wording = consentWording(type, c.version) ?? CONSENT_LABELS[type]
        return {
          id: c.id,
          type,
          title: wording.title,
          description: wording.description,
          status: c.status as PortalConsent['status'],
          scope: c.scope,
          method: c.method,
          recordedAt: c.recordedAt.toISOString(),
          withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
          withdrawnVia: c.withdrawnVia,
          version: c.version,
          currentWording: c.version === CONSENT_VERSIONS[type],
          withdrawalEffect: c.status === 'granted' ? CONSENT_WITHDRAWAL_EFFECTS_FOR_PATIENT[type] : null,
        }
      }),
    }
  })

  /**
   * The patient withdraws one of their consents (granting stays with clinic
   * staff, who explain the wording). Withdrawing portal access signs the
   * patient out at once.
   */
  app.post('/api/portal/consents/:id/withdraw', perm, async (req, reply) => {
    const { me, patientId } = await self(req)
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(WithdrawConsentRequest, req.body ?? {})
    const c = await db.query.consents.findFirst({ where: and(eq(consents.id, id), eq(consents.patientId, patientId), eq(consents.status, 'granted')) })
    if (!c) {
      await audit(db, req, { action: 'consent.withdraw', outcome: 'denied', entityType: 'consent', entityId: id, patientId, details: { via: 'patient_portal', reason: 'not_found_or_not_owned' } })
      throw notFound('Active consent')
    }
    const result = await db.transaction((tx) => withdrawConsentType(tx, req, patientId, c.type as ConsentType, { userId: me.id, via: 'patient_portal', reason: body.reason ?? null }))
    const signedOut = c.type === 'portal_access'
    if (signedOut) void reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true, signedOut, effects: result.effects }
  })

  /** Doctor-approved thermal measurements (measurements only). A simulated capture is not a measurement of the patient: it is never shown to them, even approved. */
  app.get('/api/portal/thermal', perm, async (req) => {
    const { patientId } = await self(req)
    const rows = await db.select().from(thermalCaptures).where(and(eq(thermalCaptures.patientId, patientId), eq(thermalCaptures.status, 'approved'), eq(thermalCaptures.simulated, false))).orderBy(desc(thermalCaptures.createdAt))
    await read(req, patientId, 'thermal')
    return {
      reports: rows.map((t): PortalThermalReport => {
        const cam = t.camera as { make: string | null; model: string | null }
        return {
          id: t.id,
          createdAt: t.createdAt.toISOString(),
          bodyRegion: (t.protocol as { bodyRegion: string }).bodyRegion,
          reviewedAt: t.reviewedAt?.toISOString() ?? null,
          pairs: (t.pairStats as { a: string; b: string; meanDiff: number | null }[]).map((p) => ({ a: p.a, b: p.b, meanDiff: p.meanDiff })),
          camera: [cam.make, cam.model].filter(Boolean).join(' ') || null,
          dataOrigin: t.dataOrigin,
        }
      }),
    }
  })
}
