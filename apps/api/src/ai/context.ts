import { type Provenance, THERMAL_CAPTURE_SOURCES, type ThermalCaptureSource, VITALS, type VitalKind } from '@adaxai/contracts'
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm'
import { standingWindow } from '../visits/service.ts'
import type { DbOrTx } from '../db/client.ts'
import { allergies, diagnoses, encounters, observations, patients, prescriptionItems, thermalCaptures, visits } from '../db/schema.ts'
import { ageOn } from '../patients/service.ts'
import { makeScrubber } from './text.ts'

/** One record item the AI may see and cite, with where it came from. */
export interface ContextItem {
  ref: string
  sourceType: 'allergy' | 'patient' | 'prescription_item' | 'diagnosis' | 'prior_encounter' | 'observation' | 'encounter_note' | 'thermal_capture'
  sourceId: string | null
  provenance: Provenance
  /** Exactly what is shown to the model and kept as the evidence excerpt. */
  text: string
}

export interface PatientContext {
  patient: typeof patients.$inferSelect
  ageYears: number
  ageBand: string
  items: ContextItem[]
  byRef: Map<string, ContextItem>
  activeAllergies: (typeof allergies.$inferSelect)[]
  /** Observations at the current visit (not entered in error), newest first. */
  visitObservations: (typeof observations.$inferSelect)[]
  priorPrescriptions: (typeof prescriptionItems.$inferSelect)[]
  priorDiagnoses: (typeof diagnoses.$inferSelect)[]
  currentPrescription: (typeof prescriptionItems.$inferSelect)[]
  scrub: (text: string) => string
}

const NOTE_LABELS: [keyof typeof encounters.$inferSelect, string][] = [
  ['chiefComplaint', 'Chief complaint'],
  ['history', 'History of present illness'],
  ['pastHistory', 'Medical history'],
  ['examination', 'Examination'],
  ['assessment', 'Assessment'],
  ['plan', 'Plan'],
  ['followUp', 'Follow-up'],
]

const day = (d: Date) => d.toISOString().slice(0, 10)
const fmtValue = (kind: VitalKind, v: number) => `${v.toFixed(VITALS[kind].decimals)} ${VITALS[kind].unit}`

/**
 * Builds the record context for one consultation: only this patient's data,
 * identifiers scrubbed from free text, each item with a stable reference.
 */
export async function buildPatientContext(db: DbOrTx, encounter: typeof encounters.$inferSelect, opts: { priorEncounters: number; observationDays: number }): Promise<PatientContext> {
  const patient = (await db.query.patients.findFirst({ where: eq(patients.id, encounter.patientId) }))!
  const scrub = makeScrubber(patient)
  const today = day(new Date())
  const ageYears = ageOn(String(patient.dateOfBirth), today)
  const ageBand = ageYears >= 90 ? '90+' : `${Math.floor(ageYears / 10) * 10}-${Math.floor(ageYears / 10) * 10 + 9}`
  const items: ContextItem[] = []
  const add = (prefix: string, i: Omit<ContextItem, 'ref'>) => items.push({ ...i, ref: `${prefix}${items.filter((x) => x.ref.startsWith(prefix)).length + 1}` })

  const activeAllergies = await db.select().from(allergies).where(and(eq(allergies.patientId, patient.id), eq(allergies.status, 'active')))
  for (const a of activeAllergies) add('A', { sourceType: 'allergy', sourceId: a.id, provenance: 'record', text: `Recorded allergy: ${a.substance}${a.reaction ? ` (reaction: ${scrub(a.reaction)})` : ''}, severity ${a.severity}` })
  if (!activeAllergies.length) add('A', { sourceType: 'patient', sourceId: null, provenance: 'record', text: patient.noKnownAllergies ? 'Record states: no known allergies' : 'Allergy status: not recorded' })

  const prior = await db
    .select()
    .from(encounters)
    .where(and(eq(encounters.patientId, patient.id), eq(encounters.status, 'signed'), ne(encounters.id, encounter.id)))
    .orderBy(desc(encounters.signedAt))
    .limit(opts.priorEncounters)
  const priorIds = prior.map((e) => e.id)
  const priorDiagnoses = priorIds.length ? await db.select().from(diagnoses).where(inArray(diagnoses.encounterId, priorIds)) : []
  const priorPrescriptions = priorIds.length ? await db.select().from(prescriptionItems).where(inArray(prescriptionItems.encounterId, priorIds)) : []
  for (const e of prior) {
    const when = e.signedAt ? day(e.signedAt) : day(e.startedAt)
    add('E', { sourceType: 'prior_encounter', sourceId: e.id, provenance: 'record', text: `Consultation ${when}: complaint "${scrub(e.chiefComplaint).slice(0, 300)}"; assessment "${scrub(e.assessment).slice(0, 300)}"` })
    for (const d of priorDiagnoses.filter((x) => x.encounterId === e.id)) add('D', { sourceType: 'diagnosis', sourceId: d.id, provenance: 'record', text: `Diagnosis ${when}: ${scrub(d.description)}${d.code ? ` (${d.code})` : ''}` })
    for (const m of priorPrescriptions.filter((x) => x.encounterId === e.id)) add('M', { sourceType: 'prescription_item', sourceId: m.id, provenance: 'record', text: `Prescribed ${when}: ${m.drugName} ${m.strength} ${m.form}, ${m.dose}, ${m.frequency}, ${m.duration}`.replace(/\s+/g, ' ') })
  }

  const since = new Date(Date.now() - opts.observationDays * 86_400_000)
  const obs = await db
    .select()
    .from(observations)
    // Every staff measurement, and of what a device sent only the newest few of each kind per visit: a band's stream must not push what staff
    // measured out of the sixty rows. A device simulator's values are not part of the record and are never given to a model or to the rules.
    .where(inArray(observations.id, standingWindow(db, and(eq(observations.patientId, patient.id), eq(observations.enteredInError, false), gte(observations.measuredAt, since)), 3)))
    .orderBy(desc(observations.measuredAt))
    .limit(60)
  // At this visit what staff measured stands: the rules take the first reading of each kind, so staff measurements come first (newest first
  // within each), and a device's unverified reading is the one that counts only where staff measured nothing of that kind.
  const visitObservations = obs.filter((o) => o.visitId === encounter.visitId).sort((a, b) => Number(a.source === 'device') - Number(b.source === 'device'))
  for (const o of obs) {
    const kind = o.kind as VitalKind
    const here = o.visitId === encounter.visitId
    add('V', { sourceType: 'observation', sourceId: o.id, provenance: o.source === 'device' ? 'device_measured' : 'staff_measured', text: `${VITALS[kind].label} ${fmtValue(kind, o.value)} measured ${here ? 'at this visit' : day(o.measuredAt)}${o.source === 'device' ? ' by a device (unverified)' : ''}` })
  }

  for (const [key, label] of NOTE_LABELS) {
    const v = String(encounter[key] ?? '').trim()
    if (v) add('N', { sourceType: 'encounter_note', sourceId: encounter.id, provenance: 'clinician_stated', text: `Current note, ${label}: ${scrub(v).slice(0, 1500)}` })
  }
  const currentPrescription = await db.select().from(prescriptionItems).where(eq(prescriptionItems.encounterId, encounter.id))
  for (const m of currentPrescription) add('P', { sourceType: 'prescription_item', sourceId: m.id, provenance: 'clinician_stated', text: `Current prescription draft: ${m.drugName} ${m.strength} ${m.form}, ${m.dose}, ${m.frequency}, ${m.duration}`.replace(/\s+/g, ' ') })

  // Approved thermal measurements only; a simulated capture (generated numbers, not a measurement) is never given to a model. Each says how the
  // image arrived, an imported one IMPORTED (an earlier image: when it was taken is not known), and is dated when the camera took it if the camera
  // said so, otherwise when it was stored.
  const thermal = await db
    .select()
    .from(thermalCaptures)
    .where(and(eq(thermalCaptures.patientId, patient.id), eq(thermalCaptures.status, 'approved'), eq(thermalCaptures.simulated, false)))
    .orderBy(desc(thermalCaptures.createdAt))
    .limit(3)
  for (const t of thermal) {
    const pairs = (t.pairStats as { a: string; b: string; meanDiff: number | null }[]).map((p) => `${scrub(p.a)} minus ${scrub(p.b)} mean ${p.meanDiff ?? 'n/a'} °C`).join('; ')
    const source = t.captureSource === 'gallery_import' ? 'IMPORTED: an earlier image chosen from the device, date taken not known' : (THERMAL_CAPTURE_SOURCES[t.captureSource as ThermalCaptureSource] ?? t.captureSource)
    const when = t.capturedAt ? `taken ${day(t.capturedAt)}` : `${t.captureSource === 'gallery_import' ? 'imported' : 'stored'} ${day(t.createdAt)}`
    add('T', { sourceType: 'thermal_capture', sourceId: t.id, provenance: 'record', text: `Approved thermal measurement (${source}), ${when}, ${scrub((t.protocol as { bodyRegion: string }).bodyRegion)}: ${pairs || 'no paired regions'} (measurements only, not validated)` })
  }

  // Visit of this encounter: the reason for visit is part of the record.
  const [visit] = await db.select().from(visits).where(eq(visits.id, encounter.visitId))
  if (visit?.chiefComplaint) add('N', { sourceType: 'encounter_note', sourceId: visit.id, provenance: 'record', text: `Reason for visit recorded at check-in: ${scrub(visit.chiefComplaint)}` })

  return { patient, ageYears, ageBand, items, byRef: new Map(items.map((i) => [i.ref, i])), activeAllergies, visitObservations, priorPrescriptions, priorDiagnoses, currentPrescription, scrub }
}

export const formatContext = (items: ContextItem[]) => items.map((i) => `[${i.ref}] ${i.text}`).join('\n')
