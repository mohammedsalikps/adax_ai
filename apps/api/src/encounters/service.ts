import crypto from 'node:crypto'
import type { Encounter } from '@adaxai/contracts'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SessionUser } from '../auth/sessions.ts'
import type { DbOrTx } from '../db/client.ts'
import { allergies, departments, diagnoses, encounterAmendments, encounters, facilities, observations, patients, prescriptionItems, users, visits } from '../db/schema.ts'
import { conflict, deniedNotFound, forbidden, notFound } from '../http/errors.ts'
import { ageOn, fullName } from '../patients/service.ts'
import { standingWindow, toObservation } from '../visits/service.ts'
import { loadInsertions } from './insertions.ts'

export type EncounterRow = typeof encounters.$inferSelect

export async function getEncounterOr404(db: DbOrTx, me: SessionUser, id: string): Promise<EncounterRow> {
  const e = await db.query.encounters.findFirst({ where: and(eq(encounters.id, id), eq(encounters.facilityId, me.facilityId)) })
  if (!e) {
    const elsewhere = await db.query.encounters.findFirst({ columns: { id: true }, where: eq(encounters.id, id) })
    throw deniedNotFound('Consultation', { entityType: 'encounter', entityId: id, reason: elsewhere ? 'other_facility' : 'not_found' })
  }
  return e
}

/** The visit's consultation that is not discarded (at most one, database index), if any. */
export async function activeEncounterForVisit(db: DbOrTx, visitId: string): Promise<EncounterRow | undefined> {
  return db.query.encounters.findFirst({ where: and(eq(encounters.visitId, visitId), ne(encounters.status, 'discarded')) })
}

export const PAUSED_MESSAGE = 'The visit is no longer with the doctor, so this draft is paused. Continue it from the queue or from your unsigned drafts first.'

/** Writes to a draft: only its author, only while it is an unsigned draft. */
export function assertOwnDraft(e: EncounterRow, me: SessionUser, verb: 'edit' | 'sign' | 'discard'): void {
  if (e.status === 'signed') throw conflict(verb === 'sign' ? 'Already signed' : 'This consultation is signed. Add an amendment instead.', 'encounter_signed')
  if (e.status === 'discarded') throw conflict('This draft was discarded. It is kept read-only and can no longer be changed.', 'encounter_discarded')
  if (e.doctorId !== me.id) throw forbidden(`Only the doctor who started this consultation can ${verb} it`)
}

/** Editing and signing need the visit to be with the doctor (continuing a paused draft brings it back). */
export async function assertWithDoctor(db: DbOrTx, e: EncounterRow): Promise<void> {
  const [v] = await db.select({ status: visits.status }).from(visits).where(eq(visits.id, e.visitId))
  if (v?.status !== 'in_consultation') throw conflict(PAUSED_MESSAGE, 'visit_not_in_consultation')
}

/** Deterministic JSON (sorted keys) so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export async function loadEncounter(db: DbOrTx, me: SessionUser, e: EncounterRow): Promise<Encounter> {
  const doctor = alias(users, 'doctor')
  const recorder = alias(users, 'recorder')
  const author = alias(users, 'author')
  const discarder = alias(users, 'discarder')
  const [row] = await db
    .select({ v: visits, p: patients, deptName: departments.name, doc: doctor, facilityName: facilities.name, discardedByName: discarder.fullName })
    .from(visits)
    .innerJoin(patients, eq(patients.id, visits.patientId))
    .innerJoin(departments, eq(departments.id, visits.departmentId))
    .innerJoin(facilities, eq(facilities.id, visits.facilityId))
    .innerJoin(doctor, eq(doctor.id, e.doctorId))
    .leftJoin(discarder, eq(discarder.id, sql`${e.discardedBy ?? null}::uuid`))
    .where(eq(visits.id, e.visitId))
  if (!row) throw notFound('Consultation')
  const { v, p, deptName, doc, facilityName, discardedByName } = row
  const [dx, rx, obs, am, al] = await Promise.all([
    db.select().from(diagnoses).where(eq(diagnoses.encounterId, e.id)).orderBy(asc(diagnoses.sortOrder)),
    db.select().from(prescriptionItems).where(eq(prescriptionItems.encounterId, e.id)).orderBy(asc(prescriptionItems.sortOrder)),
    db
      .select({ o: observations, by: recorder.fullName })
      .from(observations)
      .leftJoin(recorder, eq(recorder.id, observations.recordedBy))
      // The visit's vital signs: every measurement staff took, and of what a device sent only its newest reading of each kind (the stream, with its
      // states, is on the device readings card; a band worn for an hour would otherwise add thousands of rows here). Never a simulator's output.
      .where(inArray(observations.id, standingWindow(db, and(eq(observations.visitId, v.id), eq(observations.enteredInError, false)), 1)))
      .orderBy(desc(observations.measuredAt), desc(observations.createdAt)),
    db
      .select({ a: encounterAmendments, by: author.fullName })
      .from(encounterAmendments)
      .innerJoin(author, eq(author.id, encounterAmendments.authorId))
      .where(eq(encounterAmendments.encounterId, e.id))
      .orderBy(sql`${encounterAmendments.seq} nulls first`, asc(encounterAmendments.createdAt)),
    db.select({ substance: allergies.substance }).from(allergies).where(and(eq(allergies.patientId, p.id), eq(allergies.status, 'active'))),
  ])
  const age = ageOn(p.dateOfBirth, v.visitDate)
  const ownDraft = e.status === 'in_progress' && e.doctorId === me.id
  const note = {
    chiefComplaint: e.chiefComplaint,
    history: e.history,
    pastHistory: e.pastHistory,
    examination: e.examination,
    assessment: e.assessment,
    plan: e.plan,
    followUp: e.followUp,
  }
  return {
    id: e.id,
    status: e.status,
    version: e.version,
    visit: { id: v.id, visitDate: v.visitDate, tokenNumber: v.tokenNumber, departmentName: deptName, reasonForVisit: v.chiefComplaint, status: v.status, priority: v.priority },
    patient: {
      id: p.id,
      mrn: p.mrn,
      fullName: fullName(p),
      sex: p.sex,
      dateOfBirth: p.dateOfBirth,
      dateOfBirthEstimated: p.dateOfBirthEstimated,
      phone: p.phone,
      noKnownAllergies: p.noKnownAllergies,
      activeAllergies: al.map((a) => a.substance),
    },
    doctor: { id: doc.id, fullName: doc.fullName, registrationNumber: doc.registrationNumber },
    facilityName,
    note,
    diagnoses: dx.map((d) => ({ description: d.description, code: d.code, kind: d.kind })),
    prescription: rx.map((r) => ({ drugName: r.drugName, strength: r.strength, form: r.form, dose: r.dose, route: r.route, frequency: r.frequency, duration: r.duration, instructions: r.instructions })),
    vitals: obs.map(({ o, by }) => toObservation(o, age, by)),
    amendments: am.map(({ a, by }) => ({ id: a.id, reason: a.reason, content: a.content, authorName: by, createdAt: a.createdAt.toISOString(), seq: a.seq, contentHash: a.contentHash })),
    aiInsertions: await loadInsertions(db, e.id, note),
    startedAt: e.startedAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    signedAt: e.signedAt?.toISOString() ?? null,
    contentHash: e.contentHash,
    hashScheme: e.hashScheme,
    discarded: e.status === 'discarded' && e.discardedAt ? { at: e.discardedAt.toISOString(), byName: discardedByName ?? '', reason: e.discardReason ?? '' } : null,
    canEdit: ownDraft && v.status === 'in_consultation',
    canResume: ownDraft && ['waiting', 'in_triage', 'ready'].includes(v.status),
    canDiscard: ownDraft,
  }
}

/** Consultation id per visit id (for queue and history views); discarded drafts are left out. */
export async function encounterIdsForVisits(db: DbOrTx, visitIds: string[]): Promise<Map<string, string>> {
  if (!visitIds.length) return new Map()
  const rows = await db
    .select({ id: encounters.id, visitId: encounters.visitId })
    .from(encounters)
    .where(and(inArray(encounters.visitId, visitIds), ne(encounters.status, 'discarded')))
  return new Map(rows.map((r) => [r.visitId, r.id]))
}
