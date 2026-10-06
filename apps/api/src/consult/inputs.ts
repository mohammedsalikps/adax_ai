import crypto from 'node:crypto'
import type { RecordCheck } from '@adaxai/contracts'
import type { SessionUser } from '../auth/sessions.ts'
import type { DbOrTx } from '../db/client.ts'
import { type ConfirmedPoint, listConfirmedPoints } from '../ai/confirmed.ts'
import { type RuleSettings, recordChecks, RECORD_CHECK_VERSION } from '../mana/answers.ts'
import { sourceLine } from './prompt.ts'
import { loadPatientRecord, type PatientRecord, type RecordItem } from '../mana/record.ts'
import type { encounters } from '../db/schema.ts'

/**
 * What the consultation draft may read, assembled on the server for ONE consultation of ONE patient of the caller's facility, and only after the
 * caller was authorised for it. This is the single place that decides what reaches the model: the authorised record (signed notes, diagnoses,
 * prescriptions, allergies, typed-in history, vital signs), the doctor's own draft of today's note, diagnoses and prescription, the reason for
 * the visit, and the important points the doctor CONFIRMED during capture. Rejected and unreviewed points, the transcript itself and the audio
 * are never here. Every item has a stable key, so a later change to the record can be told from the manifest the draft stored.
 */

export interface SourceItem {
  /** Stable identity: survives re-numbering, used for evidence and for noticing that a source changed. */
  key: string
  /** The id the model cites (A1, N2, F1 ...); only meaningful within one generation. */
  ref: string
  /** 0 this visit, 1 allergies / conditions / current medicines, 2 the latest signed consultation and results, 3 the rest. */
  priority: 0 | 1 | 2 | 3
  sourceType: string
  sourceId: string | null
  encounterId: string | null
  date: string | null
  field: string
  status: string
  provenance: string
  /** Exactly what the model sees and what is kept as the evidence excerpt (identifiers replaced, one source never longer than the cap). */
  text: string
  /** Hash of the full item (not the shortened text), so any change to it is noticed. */
  hash: string
}

export interface ManifestEntry {
  key: string
  ref: string
  sourceType: string
  field: string
  date: string | null
  status: string
  hash: string
}

export interface ConsultationInputs {
  patientLine: string
  today: string
  timeZone: string
  /** What the model is shown, in the order it is shown. */
  items: SourceItem[]
  /** Available items that did not fit the budget (the draft says how many). */
  omitted: number
  manifest: ManifestEntry[]
  contextSha256: string
  /** False when there is nothing of the patient's to draft from: nothing is then asked of the model. */
  hasClinicalContent: boolean
  recordCheck: RecordCheck
  record: PatientRecord
}

export interface InputOptions {
  maxContextChars: number
  maxEncounters: number
  observationDays: number
  settings: RuleSettings
  /**
   * Texts the doctor added to today's note from the draft being compared with. They are taken out of the note when its fingerprint is made, so
   * that adding an accepted statement to the note does not make the draft "stale": only what the doctor wrote or changed otherwise does.
   */
  stripInserted?: { section: string; text: string }[]
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const keyOf = (type: string, id: string | null, field: string) => `${type}:${id ?? 'none'}:${field}`
/** The words of the user message around the sources (who, today, the headings, the task) with room for the longest age band and today's date. */
const FIXED_MESSAGE_CHARS = 260
const SOURCE_CHARS = 800
const CURRENT_VISIT_CHARS = 1500
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

function priorityOf(r: RecordItem, record: PatientRecord): SourceItem['priority'] {
  const prefix = /^[A-Z]+/.exec(r.ref)![0]
  if (prefix === 'C' || prefix === 'P') return 0
  if (prefix === 'R' && r.field.includes('this visit')) return 0
  if (prefix === 'V' && r.data.t === 'observation' && r.data.visitId && r.data.visitId === record.currentVisitId) return 0
  if (prefix === 'A' || prefix === 'H' || prefix === 'U') return 1
  const latest = record.consultations[0]?.encounter.id
  if ((prefix === 'N' || prefix === 'D' || prefix === 'M' || prefix === 'X') && latest && r.encounterId === latest) return 2
  if (prefix === 'L') return 2
  return 3
}

/** A note field without the statements the doctor added to it from the draft (each was appended on a line of its own, or was the whole field). */
function withoutInserted(value: string, section: string, inserted: { section: string; text: string }[]): string {
  let out = value
  for (const i of inserted.filter((x) => x.section === section)) out = out.includes(`\n${i.text}`) ? out.replace(`\n${i.text}`, '') : out.replace(i.text, '')
  return out.trim()
}

function fromRecord(r: RecordItem, record: PatientRecord, inserted: { section: string; text: string }[]): SourceItem | null {
  const priority = priorityOf(r, record)
  // The fingerprint of today's draft note leaves out what was added to it from the draft (see InputOptions.stripInserted). A field that holds
  // nothing but such statements is not a source of its own: it was not there when the draft was made.
  const stripped = r.status === 'draft' && r.data.t === 'note' && inserted.some((i) => i.section === (r.data as { section: string }).section) ? withoutInserted(r.data.value, r.data.section, inserted) : null
  if (stripped === '') return null
  const fingerprinted = stripped !== null ? record.scrub(stripped).slice(0, 1500) : r.excerpt
  return {
    key: keyOf(r.sourceType, r.sourceId, r.field),
    ref: r.ref,
    priority,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    encounterId: r.encounterId,
    date: r.date,
    field: r.field,
    status: r.status,
    provenance: r.provenance,
    text: cut(r.excerpt, priority === 0 ? CURRENT_VISIT_CHARS : SOURCE_CHARS),
    // The doctor's own draft is stamped with the time it was last saved: that is not part of what it says, so an unchanged field is not "changed".
    hash: sha(`${fingerprinted}|${r.status}|${r.status === 'draft' ? '' : (r.date ?? '')}`),
  }
}

const POINT_LABEL: Record<string, string> = {
  chief_complaint: 'Chief complaint',
  symptom: 'Symptom',
  past_medical_history: 'Past medical history',
  medication_history: 'Medicine history',
  allergy: 'Allergy',
  family_history: 'Family history',
  social_history: 'Social history',
  examination_finding: 'Examination finding',
  vital_sign: 'Vital sign',
  clinician_assessment: 'Doctor’s assessment',
  plan: 'Plan',
  medication_mention: 'Medicine mentioned',
  follow_up: 'Follow-up',
  red_flag: 'Warning sign',
  duration: 'Duration',
  patient_concern: 'Patient concern',
  investigation_mention: 'Investigation mentioned',
}
const SAID_BY: Record<string, string> = { patient_reported: 'the patient said', clinician_stated: 'the doctor said', other_speaker: 'someone else said' }

function fromPoint(p: ConfirmedPoint, ref: string, scrub: (t: string) => string): SourceItem {
  const text = scrub(p.text)
  return {
    key: keyOf('clinical_fact', p.id, 'Confirmed point'),
    ref,
    priority: 0,
    sourceType: 'clinical_fact',
    sourceId: p.id,
    encounterId: null,
    date: p.confirmedAt,
    field: `${POINT_LABEL[p.category] ?? 'Point'} (confirmed point, ${SAID_BY[p.attribution] ?? 'said in the consultation'})`,
    status: 'confirmed by the doctor',
    provenance: 'doctor_confirmed',
    text: cut(text, CURRENT_VISIT_CHARS),
    hash: sha(`${text}|${p.edited ? 'edited' : 'accepted'}`),
  }
}

/**
 * Items that fit the budget: this visit first (the reason, the doctor's own notes and the measurements, then the points the doctor confirmed), then the
 * safety record, then the latest consultation, then the newest of the rest. NOTHING goes over the budget, this visit's items included: the model has a
 * fixed context, and a request that does not fit it fails instead of being cut. What does not fit is counted, and the draft says how many were not shown.
 */
export function withinBudget(all: SourceItem[], maxChars: number): { items: SourceItem[]; omitted: number } {
  const ownWords = (i: SourceItem) => (i.priority === 0 && i.sourceType === 'clinical_fact' ? 1 : 0)
  const order = [...all].sort((a, b) => a.priority - b.priority || ownWords(a) - ownWords(b) || (b.date ?? '').localeCompare(a.date ?? ''))
  // What is counted is what is sent: each source as the model reads it (its line and the line break), and the fixed words around them. The message
  // the model gets is then never longer than the budget.
  let used = FIXED_MESSAGE_CHARS
  const kept: SourceItem[] = []
  for (const i of order) {
    const len = sourceLine(i).length + 1
    if (used + len > maxChars) continue
    used += len
    kept.push(i)
  }
  return { items: kept, omitted: all.length - kept.length }
}

export const manifestOf = (items: SourceItem[]): ManifestEntry[] => items.map((i) => ({ key: i.key, ref: i.ref, sourceType: i.sourceType, field: i.field, date: i.date, status: i.status, hash: i.hash }))

export const contextHash = (items: SourceItem[]): string =>
  sha(
    items
      .map((i) => `${i.key}:${i.hash}`)
      .sort()
      .join('\n'),
  )

/**
 * Builds the inputs. `me` is the signed-in doctor; the record loader answers 404 for another facility's patient, so nothing is read for a
 * patient the caller may not see. The caller has already checked that `encounter` is theirs to work on.
 */
export async function buildConsultationInputs(db: DbOrTx, me: SessionUser, encounter: typeof encounters.$inferSelect, opts: InputOptions): Promise<ConsultationInputs> {
  const record = await loadPatientRecord(db, me, encounter.patientId, { encounterId: encounter.id, maxEncounters: opts.maxEncounters, observationDays: opts.observationDays, includeHistory: true })
  const confirmed = await listConfirmedPoints(db, encounter.id)
  const all: SourceItem[] = record.items.map((r) => fromRecord(r, record, opts.stripInserted ?? [])).filter((i): i is SourceItem => !!i)
  confirmed.forEach((p, n) => all.push(fromPoint(p, `F${n + 1}`, record.scrub)))
  const { items, omitted } = withinBudget(all, opts.maxContextChars)
  const recordCheck = buildRecordCheck(record, opts.settings, items)
  return {
    patientLine: `${record.ageBand} years, ${record.patient.sex}`,
    today: record.today,
    timeZone: record.timeZone,
    items,
    omitted,
    manifest: manifestOf(items),
    contextSha256: contextHash(items),
    // An allergy status line ("not recorded") says nothing about the patient's problem: with nothing else there is nothing to draft from.
    hasClinicalContent: items.some((i) => !(i.sourceType === 'patient' && i.field === 'Allergy status')),
    recordCheck,
    record,
  }
}

/** The explicit-rule findings (no AI), with refs turned into the stable keys the draft stores. */
function buildRecordCheck(record: PatientRecord, settings: RuleSettings, shown: SourceItem[]): RecordCheck {
  const found = recordChecks(record, settings)
  const keyOfRef = new Map(shown.map((i) => [i.ref, i.key]))
  const conv = (f: { text: string; refs: string[] }) => ({ text: f.text, refs: f.refs, keys: f.refs.map((r) => keyOfRef.get(r)).filter((k): k is string => !!k) })
  return { rulesVersion: RECORD_CHECK_VERSION, conflicts: found.conflicts.map(conv), outdated: found.outdated.map(conv), missing: found.missing.map(conv) }
}

export interface ManifestDiff {
  changed: ManifestEntry[]
  removed: ManifestEntry[]
  added: ManifestEntry[]
}

/** What differs between the sources a draft was made from and the sources there are now. */
export function diffManifests(then: ManifestEntry[], now: ManifestEntry[]): ManifestDiff {
  const before = new Map(then.map((m) => [m.key, m]))
  const after = new Map(now.map((m) => [m.key, m]))
  return {
    changed: now.filter((m) => before.has(m.key) && before.get(m.key)!.hash !== m.hash),
    removed: then.filter((m) => !after.has(m.key)),
    added: now.filter((m) => !before.has(m.key)),
  }
}

/**
 * A reading a device sent, as the stale rule reads it. Only an unverified reading from a device that is not a simulator, is not entered in error and is
 * still this patient's is one (a simulator's readings never reach the draft at all).
 */
export interface DeviceReading {
  /** The kind of reading and the visit it belongs to: within one of these, a device's newer readings take the place of its older ones among the newest few the draft reads. */
  stream: string
  measuredAt: number
}

export const deviceStream = (kind: string, visitId: string | null): string => `${kind}|${visitId ?? 'none'}`

/** The device readings among the items the draft would be made from now, by key. */
export function deviceReadingsIn(record: PatientRecord): Map<string, DeviceReading> {
  const out = new Map<string, DeviceReading>()
  for (const r of record.items) {
    if (r.data.t !== 'observation' || r.data.source !== 'device' || r.data.validationStatus !== 'device_unverified') continue
    out.set(keyOf(r.sourceType, r.sourceId, r.field), { stream: deviceStream(r.data.kind, r.data.visitId), measuredAt: r.data.measuredAt.getTime() })
  }
  return out
}

/** The record id in a source's key (null when the key has none). */
export const idInKey = (key: string): string | null => {
  const id = key.split(':')[1]
  return id && id !== 'none' ? id : null
}

/**
 * The diff without what a device sending readings does to it by itself. The record keeps the newest few readings of each kind, visit and source, and the
 * draft reads those: a device that sends a reading every few seconds puts newer ones in and pushes the oldest out, so that, counted as changes, every
 * draft would be out of date seconds after it was made, and making it again would not help. Of the device readings (`readings`: those the draft had and
 * those there are now, see DeviceReading), two differences are therefore not counted:
 * - a reading the draft did not have, of a kind and visit it had device readings of, measured after the newest of those: a newer value of what it had;
 * - a reading the draft had that is no longer among the newest: it is still on the record, unchanged; newer ones took its place.
 * Everything else counts as before: what staff measured; a reading that changed; one entered in error or taken off the patient (it is no device reading of
 * this patient any more, so it is not in `readings`); a device's first reading of a kind, or at a visit, the draft had none of (that is new information,
 * not a newer value of something the draft had: the draft is stale); the note, the points, the allergies, the medicines, thermal, and every other source.
 */
export function withoutDeviceStream(d: ManifestDiff, then: ManifestEntry[], readings: ReadonlyMap<string, DeviceReading>): ManifestDiff {
  const newestHad = new Map<string, number>()
  for (const m of then) {
    const r = readings.get(m.key)
    if (r) newestHad.set(r.stream, Math.max(newestHad.get(r.stream) ?? -Infinity, r.measuredAt))
  }
  const newer = (m: ManifestEntry) => {
    const r = readings.get(m.key)
    const had = r ? newestHad.get(r.stream) : undefined
    return r !== undefined && had !== undefined && r.measuredAt > had
  }
  return { changed: d.changed, removed: d.removed.filter((m) => !readings.has(m.key)), added: d.added.filter((m) => !newer(m)) }
}

/** One sentence for the screen: what changed since the draft was made, in the doctor's words for each field. */
export function staleSummary(d: ManifestDiff): string | null {
  const n = d.changed.length + d.removed.length + d.added.length
  if (!n) return null
  const names = [...new Set([...d.changed, ...d.removed, ...d.added].map((m) => m.field.replace(/ \(today’s draft\)$/, '')))].slice(0, 4)
  const parts = [d.changed.length && `${d.changed.length} changed`, d.added.length && `${d.added.length} added`, d.removed.length && `${d.removed.length} removed`].filter(Boolean)
  return `The record, your notes or the confirmed points have changed since this draft was made (${parts.join(', ')}: ${names.join('; ')}${n > names.length ? '; …' : ''}). Generate a new draft to include them.`
}
