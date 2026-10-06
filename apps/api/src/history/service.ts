import {
  type Condition,
  type ConditionInput,
  type RecordOrigin,
  flagResult,
  type Investigation,
  type InvestigationFlag,
  type InvestigationInput,
  type Medication,
  type MedicationInput,
  type PatientHistory,
  type PriorConsultation,
  plainNumber,
} from '@adaxai/contracts'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DbOrTx } from '../db/client.ts'
import { departments, diagnoses, encounterAmendments, encounters, investigationResults, observations, patientConditions, patientHistoryEvents, patientMedications, prescriptionItems, users, visits } from '../db/schema.ts'
import { ageOn, facilityToday, listAllergies, type PatientRow } from '../patients/service.ts'
import { SIMULATED } from '../devices/provenance.ts'
import { STAFF_FIRST, toObservation } from '../visits/service.ts'
import { documentsSummary, listProcedures } from '../documents/service.ts'

/** What an entry's origin is: its patient's when that is known, otherwise the deployment's (never one that disagrees with the patient). */
export const entryOrigin = (patientOrigin: string, deployment: RecordOrigin): RecordOrigin => (patientOrigin === 'synthetic' || patientOrigin === 'clinical' ? patientOrigin : deployment)

/** How many earlier consultations and results the read model returns (the rest are counted, so the screen can say so). */
export const HISTORY_CONSULTATIONS = 20
export const HISTORY_INVESTIGATIONS = 30

type ConditionRow = typeof patientConditions.$inferSelect
type MedicationRow = typeof patientMedications.$inferSelect
type InvestigationRow = typeof investigationResults.$inferSelect

export const toCondition = (r: ConditionRow, by: string | null): Condition => ({
  id: r.id,
  name: r.name,
  code: r.code,
  sinceYear: r.sinceYear,
  sinceMonth: r.sinceMonth,
  status: r.status,
  note: r.note,
  enteredByName: by,
  enteredAt: r.enteredAt.toISOString(),
  dataOrigin: r.dataOrigin as RecordOrigin,
})

export const toMedication = (r: MedicationRow, by: string | null): Medication => ({
  id: r.id,
  drugName: r.drugName,
  strength: r.strength,
  form: r.form,
  dose: r.dose,
  route: r.route,
  frequency: r.frequency,
  startedOn: r.startedOn,
  stoppedOn: r.stoppedOn,
  status: r.status,
  reason: r.reason,
  statusReason: r.statusReason,
  enteredByName: by,
  enteredAt: r.enteredAt.toISOString(),
  dataOrigin: r.dataOrigin as RecordOrigin,
})

export const toInvestigation = (r: InvestigationRow, by: string | null): Investigation => ({
  id: r.id,
  testName: r.testName,
  valueText: r.valueText,
  valueNumber: r.valueNumber,
  unit: r.unit,
  refLow: r.refLow,
  refHigh: r.refHigh,
  refText: r.refText,
  flag: r.flag as InvestigationFlag,
  collectedOn: r.collectedOn,
  resultedOn: r.resultedOn,
  status: r.status,
  note: r.note,
  enteredByName: by,
  enteredAt: r.enteredAt.toISOString(),
  dataOrigin: r.dataOrigin as RecordOrigin,
})

/** The flag stored with a result: from the numbers when it has them, otherwise the clinician's reading, otherwise unknown. */
export function resultFlag(i: Pick<InvestigationInput, 'valueText' | 'valueNumber' | 'refLow' | 'refHigh' | 'interpretation'>): InvestigationFlag {
  // A result that is only a number is compared as one, whether or not the number was entered separately.
  const computed = flagResult(i.valueNumber ?? plainNumber(i.valueText), i.refLow, i.refHigh)
  if (computed) return computed
  return i.interpretation ?? 'unknown'
}

const clean = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v.trim())

/** Records a creation or a status change of one entry. Call inside the transaction that makes the change. */
export async function recordHistoryEvent(
  tx: DbOrTx,
  e: { patientId: string; entityType: 'condition' | 'medication' | 'investigation' | 'procedure' | 'document'; entityId: string; action: 'created' | 'status_changed'; fromStatus?: string | null; toStatus: string; reason?: string | null; actorUserId: string },
): Promise<void> {
  await tx.insert(patientHistoryEvents).values({ patientId: e.patientId, entityType: e.entityType, entityId: e.entityId, action: e.action, fromStatus: e.fromStatus ?? null, toStatus: e.toStatus, reason: e.reason ?? null, actorUserId: e.actorUserId })
}

export const conditionValues = (patientId: string, enteredBy: string, dataOrigin: RecordOrigin, i: ConditionInput) => ({
  patientId,
  name: i.name.trim(),
  code: i.code ?? null,
  sinceYear: i.sinceYear,
  sinceMonth: i.sinceMonth ?? null,
  status: i.status ?? ('active' as const),
  note: clean(i.note),
  dataOrigin,
  enteredBy,
})

export const medicationValues = (patientId: string, enteredBy: string, dataOrigin: RecordOrigin, i: MedicationInput) => ({
  patientId,
  drugName: i.drugName.trim(),
  strength: clean(i.strength),
  form: clean(i.form),
  dose: i.dose.trim(),
  route: clean(i.route),
  frequency: i.frequency.trim(),
  startedOn: i.startedOn ?? null,
  reason: clean(i.reason),
  dataOrigin,
  enteredBy,
})

export const investigationValues = (patientId: string, enteredBy: string, dataOrigin: RecordOrigin, i: InvestigationInput) => ({
  patientId,
  testName: i.testName.trim(),
  valueText: i.valueText.trim(),
  valueNumber: i.valueNumber ?? plainNumber(i.valueText),
  unit: clean(i.unit),
  refLow: i.refLow ?? null,
  refHigh: i.refHigh ?? null,
  refText: clean(i.refText),
  flag: resultFlag(i),
  collectedOn: i.collectedOn,
  resultedOn: i.resultedOn ?? null,
  note: clean(i.note),
  dataOrigin,
  enteredBy,
})

/**
 * Everything the consultation screen needs to show a patient's history, in one
 * read. Entries marked as errors are left out; drafts and discarded drafts are
 * not part of the history; only signed consultations are.
 */
export async function loadHistory(db: DbOrTx, p: PatientRow): Promise<PatientHistory> {
  const enteredBy = alias(users, 'entered_by_user')
  const doctor = alias(users, 'consult_doctor')
  const recorder = alias(users, 'recorder')
  const today = await facilityToday(db, p.facilityId)
  const age = ageOn(p.dateOfBirth, today)

  const [allergyList, conditionRows, medicationRows, investigationRows, [investigationCount], consultationRows, [consultationCount], vitalRows] = await Promise.all([
    listAllergies(db, p.id),
    db
      .select({ r: patientConditions, by: enteredBy.fullName })
      .from(patientConditions)
      .leftJoin(enteredBy, eq(enteredBy.id, patientConditions.enteredBy))
      .where(and(eq(patientConditions.patientId, p.id), ne(patientConditions.status, 'entered_in_error')))
      .orderBy(asc(patientConditions.sinceYear), asc(patientConditions.name)),
    db
      .select({ r: patientMedications, by: enteredBy.fullName })
      .from(patientMedications)
      .leftJoin(enteredBy, eq(enteredBy.id, patientMedications.enteredBy))
      .where(and(eq(patientMedications.patientId, p.id), ne(patientMedications.status, 'entered_in_error')))
      .orderBy(asc(patientMedications.drugName)),
    db
      .select({ r: investigationResults, by: enteredBy.fullName })
      .from(investigationResults)
      .leftJoin(enteredBy, eq(enteredBy.id, investigationResults.enteredBy))
      .where(and(eq(investigationResults.patientId, p.id), ne(investigationResults.status, 'entered_in_error')))
      .orderBy(desc(investigationResults.collectedOn), desc(investigationResults.enteredAt), asc(investigationResults.testName))
      .limit(HISTORY_INVESTIGATIONS),
    db.select({ n: sql<number>`count(*)::int` }).from(investigationResults).where(and(eq(investigationResults.patientId, p.id), ne(investigationResults.status, 'entered_in_error'))),
    db
      .select({ e: encounters, v: visits, deptName: departments.name, doctorName: doctor.fullName })
      .from(encounters)
      .innerJoin(visits, eq(visits.id, encounters.visitId))
      .leftJoin(departments, eq(departments.id, visits.departmentId))
      .leftJoin(doctor, eq(doctor.id, encounters.doctorId))
      .where(and(eq(encounters.patientId, p.id), eq(encounters.status, 'signed')))
      .orderBy(desc(encounters.signedAt))
      .limit(HISTORY_CONSULTATIONS),
    db.select({ n: sql<number>`count(*)::int` }).from(encounters).where(and(eq(encounters.patientId, p.id), eq(encounters.status, 'signed'))),
    db
      .selectDistinctOn([observations.kind], { o: observations, by: recorder.fullName })
      .from(observations)
      .leftJoin(recorder, eq(recorder.id, observations.recordedBy))
      // What staff measured stands; a device's unverified reading only where they measured nothing of that kind; never a simulator's output.
      .where(and(eq(observations.patientId, p.id), eq(observations.enteredInError, false), ne(observations.validationStatus, SIMULATED)))
      .orderBy(observations.kind, STAFF_FIRST, desc(observations.measuredAt), desc(observations.createdAt)),
  ])

  // The newest result of every test, so a long run of one test cannot push the others off the screen; with the most recent ones overall.
  // HERO final: surgeries and the documents line (counts and the latest few titles) come in the same read.
  const [latestPerTest, procedures, documents] = await Promise.all([
    db
      .selectDistinctOn([sql`lower(${investigationResults.testName})`], { r: investigationResults, by: enteredBy.fullName })
      .from(investigationResults)
      .leftJoin(enteredBy, eq(enteredBy.id, investigationResults.enteredBy))
      .where(and(eq(investigationResults.patientId, p.id), ne(investigationResults.status, 'entered_in_error')))
      .orderBy(sql`lower(${investigationResults.testName})`, desc(investigationResults.collectedOn), desc(investigationResults.enteredAt)),
    listProcedures(db, p.id),
    documentsSummary(db, p.id),
  ])
  const shownIds = new Set(investigationRows.map(({ r }) => r.id))
  const results = [...investigationRows, ...latestPerTest.filter(({ r }) => !shownIds.has(r.id))].sort((a, b) => b.r.collectedOn.localeCompare(a.r.collectedOn) || b.r.enteredAt.getTime() - a.r.enteredAt.getTime() || a.r.testName.localeCompare(b.r.testName))

  const encIds = consultationRows.map((r) => r.e.id)
  const [dx, rx, am] = encIds.length
    ? await Promise.all([
        db.select().from(diagnoses).where(inArray(diagnoses.encounterId, encIds)).orderBy(asc(diagnoses.sortOrder)),
        db.select().from(prescriptionItems).where(inArray(prescriptionItems.encounterId, encIds)).orderBy(asc(prescriptionItems.sortOrder)),
        db.select({ encounterId: encounterAmendments.encounterId, n: sql<number>`count(*)::int` }).from(encounterAmendments).where(inArray(encounterAmendments.encounterId, encIds)).groupBy(encounterAmendments.encounterId),
      ])
    : [[], [], []]

  const consultations: PriorConsultation[] = consultationRows.map(({ e, v, deptName, doctorName }) => ({
    encounterId: e.id,
    visitId: v.id,
    date: v.visitDate,
    signedAt: (e.signedAt ?? e.updatedAt).toISOString(),
    doctorName,
    departmentName: deptName,
    chiefComplaint: e.chiefComplaint,
    diagnoses: dx.filter((d) => d.encounterId === e.id).map((d) => ({ description: d.description, code: d.code, kind: d.kind })),
    prescription: rx
      .filter((r) => r.encounterId === e.id)
      // HERO final: the structured course (number of days and start date), null for medicines prescribed without one.
      .map((r) => ({ drugName: r.drugName, strength: r.strength, form: r.form, dose: r.dose, route: r.route, frequency: r.frequency, duration: r.duration, instructions: r.instructions, durationDays: r.durationDays ?? null, startDate: r.startDate ?? null })),
    amendmentCount: am.find((a) => a.encounterId === e.id)?.n ?? 0,
  }))

  // Current medicines first, then stopped ones (most recently stopped first).
  const meds = medicationRows.map(({ r, by }) => toMedication(r, by))
  meds.sort((a, b) => Number(b.status === 'current') - Number(a.status === 'current') || (b.stoppedOn ?? '').localeCompare(a.stoppedOn ?? '') || a.drugName.localeCompare(b.drugName))

  return {
    patientId: p.id,
    generatedAt: new Date().toISOString(),
    noKnownAllergies: p.noKnownAllergies,
    allergies: allergyList.filter((a) => a.status === 'active'),
    conditions: conditionRows.map(({ r, by }) => toCondition(r, by)),
    medications: meds,
    investigations: results.map(({ r, by }) => toInvestigation(r, by)),
    consultations,
    latestVitals: vitalRows.map(({ o, by }) => toObservation(o, age, by)).sort((a, b) => b.measuredAt.localeCompare(a.measuredAt)),
    more: { consultations: Math.max(0, (consultationCount?.n ?? 0) - consultations.length), investigations: Math.max(0, (investigationCount?.n ?? 0) - results.length) },
    procedures,
    documents,
  }
}
