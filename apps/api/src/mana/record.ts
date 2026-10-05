import { type ManaSource, type ManaSourceStatus, type RoiStats, THERMAL_CAPTURE_SOURCES, type ThermalCaptureSource, type ThermalPair, VITALS, type VitalKind } from '@adaxai/contracts'
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm'
import { SIMULATED } from '../devices/provenance.ts'
import type { SessionUser } from '../auth/sessions.ts'
import { consentState } from '../consents/service.ts'
import type { DbOrTx } from '../db/client.ts'
import { allergies, diagnoses, encounterAmendments, encounters, facilities, investigationResults, observations, patientConditions, patientMedications, prescriptionItems, thermalCaptures, thermalRois, thermalSummaries, users, visits } from '../db/schema.ts'
import { makeScrubber } from '../ai/text.ts'
import { notFound } from '../http/errors.ts'
import { ageOn, facilityToday, getPatientOr404, type PatientRow } from '../patients/service.ts'

/**
 * Patient-scoped record retrieval for Mana. Everything a Mana answer can cite
 * comes from here: one patient of the caller's facility, a bounded window of
 * signed consultations, observations and visits, each item with a stable
 * reference, its date, record field, status and an excerpt. Free text has the
 * patient's identifiers replaced, so the same excerpt can be shown to the
 * doctor and, with consent, sent to an AI provider.
 */

type EncounterRow = typeof encounters.$inferSelect
type ObservationRow = typeof observations.$inferSelect

/** Typed payload the explicit rules work with (not sent anywhere). */
export type ItemData =
  | { t: 'allergy'; substance: string; reaction: string | null; severity: string; active: boolean; recordedAt: Date }
  | { t: 'allergy_status'; noKnownAllergies: boolean }
  | { t: 'note'; section: NoteSection; value: string; current: boolean }
  | { t: 'diagnosis'; description: string; code: string | null; kind: string; current: boolean }
  | { t: 'medication'; drugName: string; summary: string; current: boolean }
  | { t: 'amendment'; reason: string; createdAt: Date }
  | { t: 'observation'; kind: VitalKind; value: number; unit: string; source: string; validationStatus: string; visitId: string | null; measuredAt: Date }
  | { t: 'visit'; visitId: string; visitDate: string; reason: string }
  | { t: 'thermal'; region: string; captureId: string; kind: 'measurement' | 'reviewed_summary' }
  | { t: 'condition'; name: string; status: string }
  | { t: 'patient_medication'; drugName: string; summary: string; status: string }
  | { t: 'investigation'; testName: string; flag: string; collectedOn: string }

export interface RecordItem extends ManaSource {
  data: ItemData
}

export type NoteSection = 'chiefComplaint' | 'history' | 'pastHistory' | 'examination' | 'assessment' | 'plan' | 'followUp'
export const NOTE_FIELDS: [NoteSection, string][] = [
  ['chiefComplaint', 'Chief complaint'],
  ['history', 'History of present illness'],
  ['pastHistory', 'Medical history'],
  ['examination', 'Examination'],
  ['assessment', 'Assessment'],
  ['plan', 'Plan'],
  ['followUp', 'Follow-up'],
]

export interface SignedConsultation {
  encounter: EncounterRow
  doctorName: string | null
  date: string
  amended: boolean
  items: RecordItem[]
}

export interface PatientRecord {
  patient: PatientRow
  ageYears: number
  ageBand: string
  today: string
  /** Facility timezone (IANA), for displaying dates. */
  timeZone: string
  /** Signed consultations, newest first (bounded by `maxEncounters`). */
  consultations: SignedConsultation[]
  /** Total signed consultations, including any beyond the window. */
  signedTotal: number
  /** The consultation the doctor is in (draft), if any. */
  current: { encounter: EncounterRow; items: RecordItem[] } | null
  /** The visit "today" refers to: the current consultation's visit, else today's latest visit. */
  currentVisitId: string | null
  items: RecordItem[]
  byRef: Map<string, RecordItem>
  scrub: (text: string) => string
  window: { maxEncounters: number; observationDays: number }
}

export interface RecordOptions {
  encounterId?: string | undefined
  maxEncounters: number
  observationDays: number
  /** Also the history typed in by staff (slice V1): conditions, medicines and investigation results. Off for Mana's own answers; on for the consultation draft. */
  includeHistory?: boolean | undefined
}

/** Readings kept per vital-sign kind, visit and source (the newest): what a device sent never pushes what staff measured out of the window. */
const OBSERVATIONS_PER_KIND_AND_VISIT = 5

const day = (d: Date) => d.toISOString().slice(0, 10)
const fmt = (kind: VitalKind, v: number) => `${v.toFixed(VITALS[kind].decimals)} ${VITALS[kind].unit}`
const medSummary = (m: typeof prescriptionItems.$inferSelect) =>
  [m.drugName, m.strength, m.form, m.dose && `${m.dose}`, m.route, m.frequency, m.duration && `for ${m.duration}`, m.instructions].filter(Boolean).join(', ').replace(/\s+/g, ' ')

/**
 * Loads the record for one patient of the caller's facility (404 otherwise;
 * another facility's patient is indistinguishable from a missing one). An
 * `encounterId` must belong to the same patient.
 */
export async function loadPatientRecord(db: DbOrTx, me: SessionUser, patientId: string, opts: RecordOptions): Promise<PatientRecord> {
  const patient = await getPatientOr404(db, me.facilityId, patientId)
  let currentEncounter: EncounterRow | null = null
  if (opts.encounterId) {
    currentEncounter = (await db.query.encounters.findFirst({ where: and(eq(encounters.id, opts.encounterId), eq(encounters.facilityId, me.facilityId), eq(encounters.patientId, patient.id)) })) ?? null
    if (!currentEncounter) throw notFound('Consultation')
  }
  const scrub = makeScrubber(patient)
  const today = await facilityToday(db, me.facilityId)
  const timeZone = (await db.query.facilities.findFirst({ where: eq(facilities.id, me.facilityId) }))?.timezone ?? 'UTC'
  const ageYears = ageOn(String(patient.dateOfBirth), today)
  const ageBand = ageYears >= 90 ? '90+' : `${Math.floor(ageYears / 10) * 10}-${Math.floor(ageYears / 10) * 10 + 9}`

  const items: RecordItem[] = []
  const counters = new Map<string, number>()
  const add = (prefix: string, i: Omit<RecordItem, 'ref'>): RecordItem => {
    const n = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, n)
    const item = { ...i, ref: `${prefix}${n}` }
    items.push(item)
    return item
  }

  // Allergies (active first), or the recorded allergy status.
  const allergyRows = await db.select().from(allergies).where(eq(allergies.patientId, patient.id)).orderBy(asc(allergies.status), desc(allergies.recordedAt))
  for (const a of allergyRows) {
    const active = a.status === 'active'
    add('A', {
      sourceType: 'allergy',
      sourceId: a.id,
      encounterId: null,
      date: a.recordedAt.toISOString(),
      field: 'Allergy',
      status: active ? 'active' : 'inactive',
      provenance: 'record',
      excerpt: `${active ? 'Allergy' : 'Inactive allergy'}: ${scrub(a.substance)}${a.reaction ? ` (reaction: ${scrub(a.reaction)})` : ''}, severity ${a.severity}`,
      data: { t: 'allergy', substance: scrub(a.substance), reaction: a.reaction ? scrub(a.reaction) : null, severity: a.severity, active, recordedAt: a.recordedAt },
    })
  }
  if (!allergyRows.some((a) => a.status === 'active')) {
    add('A', {
      sourceType: 'patient',
      sourceId: patient.id,
      encounterId: null,
      date: patient.updatedAt.toISOString(),
      field: 'Allergy status',
      status: 'recorded',
      provenance: 'record',
      excerpt: patient.noKnownAllergies ? 'Allergy status: no known allergies' : 'Allergy status: not recorded',
      data: { t: 'allergy_status', noKnownAllergies: patient.noKnownAllergies },
    })
  }

  // Signed consultations, newest first.
  const signedRows = await db
    .select({ e: encounters, doctorName: users.fullName })
    .from(encounters)
    .leftJoin(users, eq(users.id, encounters.doctorId))
    .where(and(eq(encounters.patientId, patient.id), eq(encounters.facilityId, me.facilityId), eq(encounters.status, 'signed')))
    .orderBy(desc(encounters.signedAt))
  const signedTotal = signedRows.length
  const window = signedRows.slice(0, opts.maxEncounters)
  const ids = window.map((r) => r.e.id)
  const [dxRows, rxRows, amRows] = ids.length
    ? await Promise.all([
        db.select().from(diagnoses).where(inArray(diagnoses.encounterId, ids)).orderBy(asc(diagnoses.sortOrder)),
        db.select().from(prescriptionItems).where(inArray(prescriptionItems.encounterId, ids)).orderBy(asc(prescriptionItems.sortOrder)),
        db.select().from(encounterAmendments).where(inArray(encounterAmendments.encounterId, ids)).orderBy(asc(encounterAmendments.createdAt)),
      ])
    : [[], [], []]

  const consultations: SignedConsultation[] = window.map(({ e, doctorName }) => {
    const date = (e.signedAt ?? e.startedAt).toISOString()
    const amended = amRows.some((a) => a.encounterId === e.id)
    const status: ManaSourceStatus = amended ? 'amended' : 'signed'
    const own: RecordItem[] = []
    for (const [key, label] of NOTE_FIELDS) {
      const v = String(e[key] ?? '').trim()
      if (v) own.push(add('N', { sourceType: 'encounter_note', sourceId: e.id, encounterId: e.id, date, field: label, status, provenance: 'clinician_stated', excerpt: scrub(v).slice(0, 1500), data: { t: 'note', section: key, value: v, current: false } }))
    }
    for (const d of dxRows.filter((x) => x.encounterId === e.id)) {
      own.push(add('D', { sourceType: 'diagnosis', sourceId: d.id, encounterId: e.id, date, field: 'Diagnosis', status, provenance: 'clinician_stated', excerpt: `${scrub(d.description)}${d.code ? ` (${d.code})` : ''}, ${d.kind}`, data: { t: 'diagnosis', description: d.description, code: d.code, kind: d.kind, current: false } }))
    }
    for (const m of rxRows.filter((x) => x.encounterId === e.id)) {
      own.push(add('M', { sourceType: 'prescription_item', sourceId: m.id, encounterId: e.id, date, field: 'Prescription', status, provenance: 'clinician_stated', excerpt: scrub(medSummary(m)), data: { t: 'medication', drugName: m.drugName, summary: medSummary(m), current: false } }))
    }
    for (const a of amRows.filter((x) => x.encounterId === e.id)) {
      own.push(add('X', { sourceType: 'amendment', sourceId: a.id, encounterId: e.id, date: a.createdAt.toISOString(), field: 'Amendment', status: 'recorded', provenance: 'clinician_stated', excerpt: `Reason: ${scrub(a.reason)}. ${scrub(a.content)}`.slice(0, 1500), data: { t: 'amendment', reason: a.reason, createdAt: a.createdAt } }))
    }
    return { encounter: e, doctorName, date, amended, items: own }
  })

  // The consultation in progress (draft): its note, diagnoses and prescription.
  let current: PatientRecord['current'] = null
  if (currentEncounter && currentEncounter.status === 'in_progress') {
    const e = currentEncounter
    const date = e.updatedAt.toISOString()
    const own: RecordItem[] = []
    for (const [key, label] of NOTE_FIELDS) {
      const v = String(e[key] ?? '').trim()
      if (v) own.push(add('C', { sourceType: 'encounter_note', sourceId: e.id, encounterId: e.id, date, field: `${label} (today’s draft)`, status: 'draft', provenance: 'clinician_stated', excerpt: scrub(v).slice(0, 1500), data: { t: 'note', section: key, value: v, current: true } }))
    }
    const [dx, rx] = await Promise.all([
      db.select().from(diagnoses).where(eq(diagnoses.encounterId, e.id)).orderBy(asc(diagnoses.sortOrder)),
      db.select().from(prescriptionItems).where(eq(prescriptionItems.encounterId, e.id)).orderBy(asc(prescriptionItems.sortOrder)),
    ])
    for (const d of dx) own.push(add('C', { sourceType: 'diagnosis', sourceId: d.id, encounterId: e.id, date, field: 'Diagnosis (today’s draft)', status: 'draft', provenance: 'clinician_stated', excerpt: `${scrub(d.description)}${d.code ? ` (${d.code})` : ''}, ${d.kind}`, data: { t: 'diagnosis', description: d.description, code: d.code, kind: d.kind, current: true } }))
    for (const m of rx) own.push(add('P', { sourceType: 'prescription_item', sourceId: m.id, encounterId: e.id, date, field: 'Prescription (today’s draft)', status: 'draft', provenance: 'clinician_stated', excerpt: scrub(medSummary(m)), data: { t: 'medication', drugName: m.drugName, summary: medSummary(m), current: true } }))
    current = { encounter: e, items: own }
  }

  // Visits (reason for visit as recorded at check-in), newest first.
  const visitRows = await db.select().from(visits).where(and(eq(visits.patientId, patient.id), eq(visits.facilityId, me.facilityId))).orderBy(desc(visits.visitDate), desc(visits.checkedInAt)).limit(opts.maxEncounters + 2)
  const currentVisitId = currentEncounter?.visitId ?? visitRows.find((v) => v.visitDate === today && v.status !== 'cancelled')?.id ?? null
  for (const v of visitRows) {
    if (!v.chiefComplaint?.trim()) continue
    add('R', { sourceType: 'visit', sourceId: v.id, encounterId: null, date: v.visitDate, field: v.id === currentVisitId ? 'Reason for visit (this visit)' : 'Reason for visit', status: 'recorded', provenance: 'record', excerpt: scrub(v.chiefComplaint), data: { t: 'visit', visitId: v.id, visitDate: v.visitDate, reason: v.chiefComplaint } })
  }

  // Observations in the window (not entered in error), newest first. Bounded per
  // kind, visit and source, so a burst of device readings cannot push this visit's or an
  // earlier visit's readings, or what staff measured at the same visit, out of the window
  // (and make them look absent). SIMULATED values are not read at all: a device simulator's
  // output is not part of anyone's record, so neither a model nor the record rules ever see it.
  const since = new Date(Date.now() - opts.observationDays * 86_400_000)
  const ranked = db
    .select({ id: observations.id, rn: sql<number>`row_number() over (partition by ${observations.kind}, ${observations.visitId}, ${observations.source} order by ${observations.measuredAt} desc)`.as('rn') })
    .from(observations)
    .where(and(eq(observations.patientId, patient.id), eq(observations.enteredInError, false), gte(observations.measuredAt, since), ne(observations.validationStatus, SIMULATED)))
    .as('ranked')
  const keep = db.select({ id: ranked.id }).from(ranked).where(lte(ranked.rn, OBSERVATIONS_PER_KIND_AND_VISIT))
  const obs: ObservationRow[] = await db.select().from(observations).where(inArray(observations.id, keep)).orderBy(desc(observations.measuredAt))
  for (const o of obs) {
    const kind = o.kind as VitalKind
    const how = o.source === 'device' ? `device reading (${o.validationStatus.replace(/_/g, ' ')})` : 'measured by staff'
    add('V', {
      sourceType: 'observation',
      sourceId: o.id,
      encounterId: null,
      date: o.measuredAt.toISOString(),
      field: VITALS[kind].label,
      status: 'recorded',
      provenance: o.source === 'device' ? 'device_measured' : 'staff_measured',
      excerpt: `${VITALS[kind].label} ${fmt(kind, o.value)}, ${how}${o.visitId && o.visitId === currentVisitId ? ', this visit' : ''}`,
      data: { t: 'observation', kind, value: o.value, unit: o.unit, source: o.source, validationStatus: o.validationStatus, visitId: o.visitId, measuredAt: o.measuredAt },
    })
  }

  // Approved thermal measurements (measurements only; not validated), each with the doctor's latest reviewed summary of it (accepted or edited), if
  // any. A SIMULATED capture is never read (generated numbers are nobody's record), and none at all once the patient has withdrawn consent to
  // thermal imaging.
  const thermalConsent = await consentState(db, patient.id, 'thermal_imaging')
  const thermal =
    thermalConsent.state === 'withdrawn'
      ? []
      : await db
          .select()
          .from(thermalCaptures)
          .where(and(eq(thermalCaptures.patientId, patient.id), eq(thermalCaptures.facilityId, me.facilityId), eq(thermalCaptures.status, 'approved'), eq(thermalCaptures.simulated, false)))
          .orderBy(desc(thermalCaptures.createdAt))
          .limit(3)
  const thermalIds = thermal.map((t) => t.id)
  const [thermalRoiRows, reviewedSummaries] = thermalIds.length
    ? await Promise.all([
        db.select().from(thermalRois).where(inArray(thermalRois.captureId, thermalIds)).orderBy(asc(thermalRois.sortOrder)),
        db
          .select()
          .from(thermalSummaries)
          .where(and(inArray(thermalSummaries.captureId, thermalIds), inArray(thermalSummaries.status, ['accepted', 'edited']), eq(thermalSummaries.simulated, false)))
          .orderBy(desc(thermalSummaries.decidedAt), desc(thermalSummaries.createdAt)),
      ])
    : [[], []]
  const deg = (v: number) => `${Number(v.toFixed(2))} °C`
  const roiText = (s: RoiStats) =>
    !s.pixelCount || s.mean === null ? 'no reading' : [s.min !== null && `min ${deg(s.min)}`, s.max !== null && `max ${deg(s.max)}`, `mean ${deg(s.mean)}`, s.std !== null && `SD ${deg(s.std)}`, `${s.pixelCount} pixels`].filter(Boolean).join(', ')
  for (const t of thermal) {
    const region = (t.protocol as { bodyRegion: string }).bodyRegion
    const source = THERMAL_CAPTURE_SOURCES[t.captureSource as ThermalCaptureSource] ?? t.captureSource
    const date = (t.capturedAt ?? t.createdAt).toISOString()
    const whole = `whole image min ${deg(t.minC)}, max ${deg(t.maxC)}, mean ${deg(t.meanC)}${t.stdC !== null ? `, SD ${deg(t.stdC)}` : ''}`
    const regions = thermalRoiRows.filter((r) => r.captureId === t.id).map((r) => `region ${scrub(r.label)}: ${roiText(r.stats as RoiStats)}`)
    const pairs = (t.pairStats as ThermalPair[]).map((p) => `${scrub(p.a)} minus ${scrub(p.b)} mean ${p.meanDiff ?? 'n/a'} °C`)
    add('T', {
      sourceType: 'thermal_capture',
      sourceId: t.id,
      encounterId: t.encounterId,
      date,
      field: 'Thermal measurement',
      status: 'recorded',
      provenance: 'record',
      excerpt: `Approved thermal measurement (${source}), ${scrub(region)}: ${[whole, ...regions, ...(pairs.length ? pairs : ['no paired regions'])].join('; ')} (measurement only, not validated)`,
      data: { t: 'thermal', region, captureId: t.id, kind: 'measurement' },
    })
    const summary = reviewedSummaries.find((s) => s.captureId === t.id)
    if (summary) {
      add('T', {
        sourceType: 'thermal_capture',
        sourceId: t.id,
        encounterId: t.encounterId,
        date: (summary.decidedAt ?? summary.createdAt).toISOString(),
        field: 'Thermal summary (doctor-reviewed)',
        status: 'recorded',
        provenance: 'clinician_stated',
        excerpt: `Doctor-reviewed thermal summary (${summary.status === 'edited' ? 'edited' : 'accepted'} by the doctor; composed by rules ${summary.composerVersion}, not validated): ${scrub(summary.finalText ?? summary.text).replace(/\s*\n\s*/g, ' ')}`.slice(0, 1500),
        data: { t: 'thermal', region, captureId: t.id, kind: 'reviewed_summary' },
      })
    }
  }

  // The history typed in by staff (conditions, the medicines list, results), when asked for. Entries marked as made in error are left out.
  if (opts.includeHistory) {
    const [conditions, medicines, results] = await Promise.all([
      db.select().from(patientConditions).where(and(eq(patientConditions.patientId, patient.id), ne(patientConditions.status, 'entered_in_error'))).orderBy(desc(patientConditions.enteredAt)),
      db.select().from(patientMedications).where(and(eq(patientMedications.patientId, patient.id), ne(patientMedications.status, 'entered_in_error'))).orderBy(desc(patientMedications.enteredAt)),
      db.select().from(investigationResults).where(and(eq(investigationResults.patientId, patient.id), ne(investigationResults.status, 'entered_in_error'))).orderBy(desc(investigationResults.collectedOn)).limit(30),
    ])
    for (const c of conditions) {
      add('H', {
        sourceType: 'patient_condition',
        sourceId: c.id,
        encounterId: null,
        date: c.enteredAt.toISOString(),
        field: 'Known condition',
        status: c.status === 'resolved' ? 'inactive' : 'active',
        provenance: 'record',
        excerpt: `Condition: ${scrub(c.name)}${c.code ? ` (${scrub(c.code)})` : ''}, since ${c.sinceMonth ? `${String(c.sinceMonth).padStart(2, '0')}/` : ''}${c.sinceYear}, ${c.status}${c.note ? `. Note: ${scrub(c.note)}` : ''}`,
        data: { t: 'condition', name: c.name, status: c.status },
      })
    }
    for (const m of medicines) {
      const detail = [m.drugName, m.strength, m.form, `dose ${m.dose}`, m.route, m.frequency].filter(Boolean).join(', ')
      add('U', {
        sourceType: 'patient_medication',
        sourceId: m.id,
        encounterId: null,
        date: m.enteredAt.toISOString(),
        field: m.status === 'stopped' ? 'Stopped medicine' : 'Current medicine',
        status: m.status === 'stopped' ? 'inactive' : 'active',
        provenance: 'record',
        excerpt: `${m.status === 'stopped' ? 'Stopped medicine' : 'Current medicine'}: ${scrub(detail)}${m.reason ? `; for ${scrub(m.reason)}` : ''}${m.startedOn ? `; started ${m.startedOn}` : ''}${m.stoppedOn ? `; stopped ${m.stoppedOn}` : ''}${m.status === 'stopped' && m.statusReason ? ` (${scrub(m.statusReason)})` : ''}`,
        data: { t: 'patient_medication', drugName: m.drugName, summary: detail, status: m.status },
      })
    }
    for (const r of results) {
      const range = r.refText ? ` (reference ${r.refText})` : r.refLow !== null || r.refHigh !== null ? ` (reference ${r.refLow ?? ''} to ${r.refHigh ?? ''})` : ''
      add('L', {
        sourceType: 'investigation_result',
        sourceId: r.id,
        encounterId: null,
        date: r.collectedOn,
        field: 'Investigation result',
        status: 'recorded',
        provenance: 'record',
        excerpt: `Result: ${scrub(r.testName)} ${scrub(r.valueText)}${r.unit ? ` ${scrub(r.unit)}` : ''}${scrub(range)}, flag ${r.flag}, collected ${r.collectedOn}${r.note ? `. ${scrub(r.note)}` : ''}`,
        data: { t: 'investigation', testName: r.testName, flag: r.flag, collectedOn: r.collectedOn },
      })
    }
  }

  return {
    patient,
    ageYears,
    ageBand,
    today,
    timeZone,
    consultations,
    signedTotal,
    current,
    currentVisitId,
    items,
    byRef: new Map(items.map((i) => [i.ref, i])),
    scrub,
    window: { maxEncounters: opts.maxEncounters, observationDays: opts.observationDays },
  }
}

/** The public part of an item (what is stored as the source snapshot). */
export const toSource = ({ data: _data, ...s }: RecordItem): ManaSource => s

export { day as isoDay }
