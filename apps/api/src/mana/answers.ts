import { type ManaIntent, type ManaSection, type ManaStatement, VITAL_ORDER, VITALS, type VitalKind } from '@adaxai/contracts'
import { nameMatches, sharedGroup } from '../ai/compare.ts'
import type { AppSettings } from '../settings/schema.ts'
import type { ItemData, PatientRecord, RecordItem, SignedConsultation } from './record.ts'

/**
 * Mana's record answers: explicit, versioned rules that read the patient's
 * record and say what is documented, what is absent, what conflicts and what
 * may be outdated. No language model is involved; every statement cites the
 * record items it was built from. Change the version when the rules change.
 */
export const MANA_RULES_VERSION = 'mana-record-v2'

/** Question classification (first match wins). Suggested questions carry their intent explicitly. */
const INTENT_RULES: [ManaIntent, RegExp][] = [
  // "Any mention of fever?" asks where the record says something, not for a vitals comparison.
  ['search', /\b(any mention|mentions? of|mentioned|does the record (say|mention|contain)|search (for|the record)|look for|find)\b/i],
  ['briefing', /\b(brief(ing)?|pre-?consult\w*|prepare me|before (the|this) (visit|consult\w*))\b/i],
  ['changes_since_last', /\b(what('?s| has| have)? changed|changes?|since (the |his |her |their )?(last|previous|prior)|new since|differen\w*)\b/i],
  ['allergies', /\ballerg\w*/i],
  ['last_prescription', /\b(medicat\w*|medicines?|drugs?|prescri\w*|tablets?|doses?|treatment)\b/i],
  ['vitals_compare', /\b(vitals?|bp|blood pressure|pulse|heart rate|temperature|temp|fever|spo2|oxygen|saturation|weight|glucose|sugar|respirat\w*)\b/i],
  ['diagnoses', /\b(diagnos\w*|problems?|conditions?|comorbid\w*)\b/i],
  ['history_summary', /\b(summar\w*|history|background|overview)\b/i],
]

export function classifyQuestion(question: string): ManaIntent {
  return INTENT_RULES.find(([, re]) => re.test(question))?.[0] ?? 'search'
}

export interface RuleSettings {
  safety: AppSettings['safety']
  /** Records older than this many days are flagged as possibly outdated. */
  outdatedDays: number
}

// --- statement helpers -------------------------------------------------------

const st = (kind: ManaStatement['kind'], text: string, refs: string[] = []): ManaStatement => ({ kind, text, refs: [...new Set(refs)], unsupported: false })
const doc = (text: string, refs: string[]) => st('documented', text, refs)
const absent = (text: string, refs: string[] = []) => st('absent', text, refs)
const conflict = (text: string, refs: string[]) => st('conflict', text, refs)
const outdated = (text: string, refs: string[]) => st('outdated', text, refs)

const isData = <T extends ItemData['t']>(t: T) => (i: RecordItem): i is RecordItem & { data: Extract<ItemData, { t: T }> } => i.data.t === t

class Ctx {
  constructor(
    readonly r: PatientRecord,
    readonly s: RuleSettings,
  ) {}

  date(iso: string | null): string {
    if (!iso) return 'an unknown date'
    const d = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: iso.length === 10 ? 'UTC' : this.r.timeZone })
  }
  /** Calendar days between the item's day (facility timezone) and today. */
  daysAgo(iso: string): number {
    const dayOf = iso.length === 10 ? iso : new Date(iso).toLocaleDateString('en-CA', { timeZone: this.r.timeZone })
    return Math.round((Date.parse(`${this.r.today}T00:00:00Z`) - Date.parse(`${dayOf}T00:00:00Z`)) / 86_400_000)
  }
  get allergies() {
    return this.r.items.filter(isData('allergy'))
  }
  get allergyStatus() {
    return this.r.items.find(isData('allergy_status')) ?? null
  }
  get observations() {
    return this.r.items.filter(isData('observation'))
  }
  visitReason(visitId: string | null) {
    return visitId ? (this.r.items.filter(isData('visit')).find((i) => i.data.visitId === visitId) ?? null) : null
  }
  meds(c: SignedConsultation) {
    return c.items.filter(isData('medication'))
  }
  dx(c: SignedConsultation) {
    return c.items.filter(isData('diagnosis'))
  }
  note(c: { items: RecordItem[] }, section: string) {
    return c.items.filter(isData('note')).find((i) => i.data.section === section) ?? null
  }
  amendments(c: SignedConsultation) {
    return c.items.filter(isData('amendment'))
  }
  get currentMeds() {
    return (this.r.current?.items ?? []).filter(isData('medication'))
  }
  /** The medicines staff typed into the patient's record as current (the medicine list; not a prescription). */
  get recordedMeds() {
    return this.r.items.filter(isData('patient_medication')).filter((m) => m.data.status !== 'stopped')
  }
  get currentDx() {
    return (this.r.current?.items ?? []).filter(isData('diagnosis'))
  }
  /** Most recent signed consultation that has a prescription. */
  get lastPrescribed() {
    return this.r.consultations.find((c) => this.meds(c).length > 0) ?? null
  }
  who(c: SignedConsultation) {
    return c.doctorName ? ` by ${c.doctorName}` : ''
  }
}

// --- building blocks ------------------------------------------------------------

function allergySection(c: Ctx): ManaSection {
  const out: ManaStatement[] = []
  const active = c.allergies.filter((a) => a.data.active)
  for (const a of active) out.push(doc(`Allergy to ${a.data.substance}${a.data.reaction ? ` (reaction: ${a.data.reaction})` : ''}, severity ${a.data.severity}, recorded ${c.date(a.date)}.`, [a.ref]))
  const status = c.allergyStatus
  if (!active.length && status) out.push(status.data.noKnownAllergies ? doc('The record states no known allergies.', [status.ref]) : absent('Allergy status is not recorded.', [status.ref]))
  const inactive = c.allergies.filter((a) => !a.data.active)
  if (inactive.length) out.push(doc(`Marked inactive: ${inactive.map((a) => a.data.substance).join(', ')}.`, inactive.map((a) => a.ref)))
  if (c.r.patient.noKnownAllergies && active.length) out.push(conflict('The record says “no known allergies” but also lists active allergies. Confirm with the patient.', active.map((a) => a.ref)))
  out.push(...allergyMedicationConflicts(c))
  return { title: 'Allergies', statements: out }
}

/** Recorded allergy vs. today's draft prescription, the last signed prescription and the medicine list staff typed in. */
function allergyMedicationConflicts(c: Ctx): ManaStatement[] {
  const out: ManaStatement[] = []
  const last = c.lastPrescribed
  const meds = [
    ...c.currentMeds.map((m) => ({ m, where: 'today’s draft prescription' })),
    ...(last ? c.meds(last).map((m) => ({ m, where: `the prescription of ${c.date(last.date)}` })) : []),
    ...c.recordedMeds.map((m) => ({ m, where: 'the medicine list in the record' })),
  ]
  for (const a of c.allergies.filter((x) => x.data.active)) {
    for (const { m, where } of meds) {
      const group = sharedGroup(m.data.drugName, a.data.substance, c.s.safety.allergyGroups)
      if (group || nameMatches(m.data.drugName, a.data.substance)) {
        out.push(conflict(`${m.data.drugName} (${where}) and the recorded allergy to ${a.data.substance}${group ? ` belong to the same configured group (“${group}”)` : ' have matching names'}. Check before prescribing.`, [m.ref, a.ref]))
      }
    }
  }
  return out
}

function medicationLines(c: Ctx, meds: (RecordItem & { data: Extract<ItemData, { t: 'medication' }> })[]): ManaStatement[] {
  return meds.map((m) => doc(m.data.summary, [m.ref]))
}

function lastPrescriptionSections(c: Ctx): ManaSection[] {
  const sections: ManaSection[] = []
  const last = c.lastPrescribed
  const out: ManaStatement[] = []
  if (!last) {
    out.push(absent(c.r.consultations.length ? `No prescription in ${signedScope(c)}.` : 'There is no signed consultation in the record.'))
  } else {
    const latest = c.r.consultations[0]!
    if (latest !== last) out.push(doc(`The most recent signed consultation (${c.date(latest.date)}) has no prescription; the last prescription is from ${c.date(last.date)}.`, latest.items.slice(0, 1).map((i) => i.ref)))
    out.push(...medicationLines(c, c.meds(last)))
    const age = c.daysAgo(last.date)
    if (age > c.s.outdatedDays) out.push(outdated(`This prescription is ${age} days old; the patient’s current medicines may differ. Confirm what they take now.`, c.meds(last).map((m) => m.ref)))
    const am = c.amendments(last)
    if (am.length) out.push(outdated(`That consultation was amended on ${am.map((a) => c.date(a.date)).join(', ')}; read the amendment, which may correct the prescription.`, am.map((a) => a.ref)))
    const earlier = c.r.consultations.filter((x) => x !== last && c.meds(x).length && x.date < last.date)[0]
    if (earlier) out.push(doc(`Before that, on ${c.date(earlier.date)}: ${c.meds(earlier).map((m) => m.data.drugName).join(', ')}.`, c.meds(earlier).map((m) => m.ref)))
  }
  sections.push({ title: last ? `Last signed prescription · ${c.date(last.date)}${c.who(last)}` : 'Last signed prescription', statements: out })
  if (c.r.current) {
    sections.push({ title: 'Today’s consultation (draft, not signed)', statements: c.currentMeds.length ? medicationLines(c, c.currentMeds) : [absent('No medicines in today’s draft prescription yet.')] })
  }
  const conflicts = allergyMedicationConflicts(c)
  if (conflicts.length) sections.push({ title: 'Safety', statements: conflicts })
  return sections
}

const fmtV = (kind: VitalKind, v: number) => `${v.toFixed(VITALS[kind].decimals)} ${VITALS[kind].unit}`
type Obs = RecordItem & { data: Extract<ItemData, { t: 'observation' }> }
const how = (o: Obs) => (o.data.source === 'device' ? `device reading, ${o.data.validationStatus.replace(/_/g, ' ')}` : 'measured by staff')
const fromDevice = (o: Obs) => o.data.source === 'device'
/** Said after a value in a list of readings when a device sent it: an unverified value is never listed as if staff had measured it. */
const deviceTag = (o: Obs) => (fromDevice(o) ? `, ${how(o)}` : '')
/**
 * The reading that stands for a kind at a visit: what staff measured, if they measured it, else the newest device reading (rules v2). A device sends
 * a value every few seconds and none of them is verified, so its readings are reported as such and are never set against each other, or against a
 * staff measurement, as "recorded twice with different values".
 */
const standing = (list: Obs[]): Obs | undefined => list.find((o) => !fromDevice(o)) ?? list[0]

function delta(kind: VitalKind, now: number, before: number): string {
  const d = now - before
  if (Math.abs(d) < 10 ** -VITALS[kind].decimals / 2) return 'no change'
  return `${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(VITALS[kind].decimals)} ${VITALS[kind].unit}`
}

/** Today's readings compared with the previous reading of the same kind. */
function vitalsSection(c: Ctx, title = 'Vital signs'): ManaSection {
  const out: ManaStatement[] = []
  const obs = c.observations
  const visitId = c.r.currentVisitId
  const here = visitId ? obs.filter((o) => o.data.visitId === visitId) : []
  if (!here.length) {
    out.push(absent(visitId ? 'No vital signs are recorded at this visit.' : 'There is no visit today, so there is nothing to compare with.'))
    const latest = VITAL_ORDER.map((k) => obs.find((o) => o.data.kind === k)).filter((o): o is NonNullable<typeof o> => !!o)
    if (latest.length) out.push(doc(`Latest recorded readings: ${latest.map((o) => `${VITALS[o.data.kind].label} ${fmtV(o.data.kind, o.data.value)} (${c.date(o.date)}${deviceTag(o)})`).join('; ')}.`, latest.map((o) => o.ref)))
    else out.push(absent(`No vital signs in the last ${c.r.window.observationDays} days.`))
    return { title, statements: out }
  }
  for (const kind of VITAL_ORDER) {
    const mine = here.filter((o) => o.data.kind === kind)
    const cur = standing(mine)
    if (!cur) continue
    // Several staff measurements of one kind at the same visit that disagree (a device's readings are not measurements to set against each other).
    const tol = c.s.safety.vitalTolerance[kind]
    const off = tol !== undefined && !fromDevice(cur) ? mine.filter((o) => !fromDevice(o) && Math.abs(o.data.value - cur.data.value) > tol) : []
    const device = fromDevice(cur) ? undefined : mine.find(fromDevice)
    const alsoDevice = () => {
      if (device) out.push(doc(`A device also sent ${VITALS[kind].label.toLowerCase()} at this visit: latest ${fmtV(kind, device.data.value)} (${how(device)}).`, [device.ref]))
    }
    if (off.length) out.push(conflict(`${VITALS[kind].label} was recorded more than once at this visit with different values: ${[cur, ...off].map((o) => fmtV(kind, o.data.value)).join(' and ')}. Check which is correct.`, [cur.ref, ...off.map((o) => o.ref)]))
    const prev = standing(obs.filter((o) => o.data.kind === kind && o.data.visitId !== visitId && o.data.measuredAt < cur.data.measuredAt))
    if (!prev) {
      out.push(doc(`${VITALS[kind].label} ${fmtV(kind, cur.data.value)} at this visit (${how(cur)}); no earlier reading in the last ${c.r.window.observationDays} days.`, [cur.ref]))
      alsoDevice()
      continue
    }
    out.push(doc(`${VITALS[kind].label} ${fmtV(kind, cur.data.value)} at this visit (${how(cur)}); previous ${fmtV(kind, prev.data.value)} on ${c.date(prev.date)} (${how(prev)}): ${delta(kind, cur.data.value, prev.data.value)}.`, [cur.ref, prev.ref]))
    alsoDevice()
    const age = c.daysAgo(prev.data.measuredAt.toISOString())
    if (age > c.s.outdatedDays) out.push(outdated(`The previous ${VITALS[kind].label.toLowerCase()} reading is ${age} days old.`, [prev.ref]))
  }
  const measured = new Set(here.map((o) => o.data.kind))
  const notToday = VITAL_ORDER.filter((k) => !measured.has(k)).map((k) => obs.find((o) => o.data.kind === k)).filter((o): o is NonNullable<typeof o> => !!o)
  if (notToday.length) out.push(doc(`Not measured at this visit; last recorded: ${notToday.map((o) => `${VITALS[o.data.kind].label} ${fmtV(o.data.kind, o.data.value)} on ${c.date(o.date)}${deviceTag(o)}`).join('; ')}.`, notToday.map((o) => o.ref)))
  return { title, statements: out }
}

function diagnosesSection(c: Ctx): ManaSection {
  const out: ManaStatement[] = []
  for (const cons of c.r.consultations) {
    const dx = c.dx(cons)
    if (dx.length) out.push(doc(`${c.date(cons.date)}: ${dx.map((d) => `${d.data.description}${d.data.code ? ` (${d.data.code})` : ''}`).join('; ')}.`, dx.map((d) => d.ref)))
  }
  if (!out.length) out.push(absent(c.r.consultations.length ? `No diagnoses are recorded in ${signedScope(c)}.` : 'There is no signed consultation in the record.'))
  if (c.r.current) {
    if (c.currentDx.length) out.push(doc(`In today’s draft (not signed): ${c.currentDx.map((d) => d.data.description).join('; ')}.`, c.currentDx.map((d) => d.ref)))
  }
  return { title: 'Diagnoses on record', statements: out }
}

function consultationLine(c: Ctx, cons: SignedConsultation): ManaStatement[] {
  const out: ManaStatement[] = []
  const parts: [string, string][] = [
    ['chiefComplaint', 'complaint'],
    ['assessment', 'assessment'],
    ['plan', 'plan'],
    ['followUp', 'follow-up'],
  ]
  const found = parts.map(([sec, label]) => ({ label, item: c.note(cons, sec) })).filter((x) => x.item)
  out.push(doc(`${c.date(cons.date)}${c.who(cons)}: ${found.length ? found.map((x) => `${x.label} “${x.item!.excerpt.slice(0, 240)}”`).join('; ') : 'no complaint, assessment or plan documented'}.`, found.map((x) => x.item!.ref)))
  const am = c.amendments(cons)
  if (am.length) out.push(outdated(`Amended on ${am.map((a) => c.date(a.date)).join(', ')}: the amendment may correct this consultation.`, am.map((a) => a.ref)))
  return out
}

/** True when older signed consultations exist beyond the window Mana reads. */
const truncated = (c: Ctx) => c.r.signedTotal > c.r.consultations.length
/** What "the record" means in an absence statement (never claims more than was read). */
const signedScope = (c: Ctx) => (truncated(c) ? `the ${c.r.consultations.length} most recent of ${c.r.signedTotal} signed consultations (older ones were not read)` : 'the signed consultations')

function coverage(c: Ctx): ManaStatement[] {
  const out: ManaStatement[] = []
  if (c.r.signedTotal > c.r.consultations.length) out.push(doc(`Only the ${c.r.consultations.length} most recent of ${c.r.signedTotal} signed consultations are included.`, []))
  const latest = c.r.consultations[0]
  if (latest) {
    const age = c.daysAgo(latest.date)
    if (age > c.s.outdatedDays) out.push(outdated(`The most recent signed consultation is ${age} days old (${c.date(latest.date)}).`, latest.items.slice(0, 1).map((i) => i.ref)))
  }
  return out
}

// --- intents ------------------------------------------------------------------

function historySummary(c: Ctx): ManaSection[] {
  const consultations: ManaStatement[] = c.r.consultations.flatMap((cons) => consultationLine(c, cons))
  if (!consultations.length) consultations.push(absent('There is no signed consultation in the record.'))
  const meds: ManaStatement[] = c.r.consultations.filter((cons) => c.meds(cons).length).map((cons) => doc(`${c.date(cons.date)}: ${c.meds(cons).map((m) => m.data.drugName).join(', ')}.`, c.meds(cons).map((m) => m.ref)))
  if (!meds.length) meds.push(absent(`No medicines in ${signedScope(c)}.`))
  return [allergySection(c), diagnosesSection(c), { title: 'Medicines prescribed', statements: meds }, { title: 'Consultations', statements: [...consultations, ...coverage(c)] }]
}

function briefing(c: Ctx): ManaSection[] {
  const today: ManaStatement[] = []
  const reason = c.visitReason(c.r.currentVisitId)
  if (reason) today.push(doc(`Reason for visit: “${reason.excerpt}”.`, [reason.ref]))
  else today.push(absent(c.r.currentVisitId ? 'No reason for visit was recorded at check-in.' : 'There is no visit today.'))
  const vitals = vitalsSection(c, 'Today’s vital signs')
  const last = c.r.consultations[0]
  const lastSection: ManaSection = { title: 'Last consultation', statements: last ? consultationLine(c, last) : [absent('There is no signed consultation in the record.')] }
  const lastRx = lastPrescriptionSections(c).filter((s) => s.title !== 'Safety')
  const dx = diagnosesSection(c)
  const quality = coverage(c)
  return [allergySection(c), { title: 'Today', statements: today }, vitals, lastSection, ...lastRx, dx, ...(quality.length ? [{ title: 'Data quality', statements: quality }] : [])]
}

function changesSinceLast(c: Ctx): ManaSection[] {
  const [latest, previous] = c.r.consultations
  const now = c.r.current ? { label: 'today’s consultation (draft)', visitId: c.r.current.encounter.visitId, meds: c.currentMeds, dx: c.currentDx, assessment: c.note(c.r.current, 'assessment'), date: c.r.today } : latest && previous ? { label: `the consultation of ${c.date(latest.date)}`, visitId: latest.encounter.visitId, meds: c.meds(latest), dx: c.dx(latest), assessment: c.note(latest, 'assessment'), date: latest.date } : null
  const before = c.r.current ? latest : previous
  if (!now || !before) return [{ title: 'Changes since the previous visit', statements: [absent(c.r.current ? 'There is no earlier signed consultation to compare with.' : 'At least two signed consultations are needed to compare (or ask from inside today’s consultation).')] }]

  const head = doc(`Comparing ${now.label} with the signed consultation of ${c.date(before.date)}${c.who(before)}.`, c.note(before, 'chiefComplaint') ? [c.note(before, 'chiefComplaint')!.ref] : [])
  const out: ManaStatement[] = [head]

  const rNow = c.visitReason(now.visitId)
  const rBefore = c.visitReason(before.encounter.visitId)
  if (rNow && rBefore) out.push(doc(`Reason for visit: now “${rNow.excerpt}”; previously “${rBefore.excerpt}”.`, [rNow.ref, rBefore.ref]))

  // Vital signs at the two visits.
  const obs = c.observations
  for (const kind of VITAL_ORDER) {
    const a = standing(obs.filter((o) => o.data.kind === kind && o.data.visitId === now.visitId))
    const b = standing(obs.filter((o) => o.data.kind === kind && o.data.visitId === before.encounter.visitId))
    if (a && b) out.push(doc(`${VITALS[kind].label}: ${fmtV(kind, a.data.value)} now${deviceTag(a)}, ${fmtV(kind, b.data.value)} then${deviceTag(b)} (${delta(kind, a.data.value, b.data.value)}).`, [a.ref, b.ref]))
  }

  // Medicines. An empty prescription does not show that medicines were stopped.
  const beforeMeds = c.meds(before)
  if (!now.meds.length) {
    if (c.r.current) out.push(absent('No medicines in today’s draft prescription yet, so medicine changes cannot be compared.'))
    else if (beforeMeds.length) out.push(absent(`The consultation of ${c.date(now.date)} has no prescription, so the record does not show whether ${beforeMeds.map((m) => m.data.drugName).join(', ')} ${beforeMeds.length > 1 ? 'were' : 'was'} continued or stopped.`, beforeMeds.map((m) => m.ref)))
    else out.push(absent('No medicines in either consultation.'))
  } else {
    const started = now.meds.filter((m) => !beforeMeds.some((b) => nameMatches(b.data.drugName, m.data.drugName)))
    const stopped = beforeMeds.filter((b) => !now.meds.some((m) => nameMatches(b.data.drugName, m.data.drugName)))
    const continued = now.meds.filter((m) => beforeMeds.some((b) => nameMatches(b.data.drugName, m.data.drugName)))
    if (started.length) out.push(doc(`New medicines: ${started.map((m) => m.data.drugName).join(', ')}.`, started.map((m) => m.ref)))
    if (stopped.length) out.push(doc(`No longer prescribed: ${stopped.map((m) => m.data.drugName).join(', ')}.`, stopped.map((m) => m.ref)))
    for (const m of continued) {
      const b = beforeMeds.find((x) => nameMatches(x.data.drugName, m.data.drugName))!
      out.push(doc(m.data.summary === b.data.summary ? `${m.data.drugName}: unchanged.` : `${m.data.drugName}: now “${m.data.summary}”; before “${b.data.summary}”.`, [m.ref, b.ref]))
    }
  }

  // Diagnoses.
  const beforeDx = c.dx(before)
  if (!now.dx.length && c.r.current) out.push(absent('No diagnoses in today’s draft yet.'))
  else {
    const added = now.dx.filter((d) => !beforeDx.some((b) => nameMatches(b.data.description, d.data.description)))
    const dropped = beforeDx.filter((b) => !now.dx.some((d) => nameMatches(b.data.description, d.data.description)))
    if (added.length) out.push(doc(`New diagnoses: ${added.map((d) => d.data.description).join('; ')}.`, added.map((d) => d.ref)))
    if (dropped.length) out.push(doc(`Diagnosed before but not listed now: ${dropped.map((d) => d.data.description).join('; ')}.`, dropped.map((d) => d.ref)))
  }
  if (now.assessment || c.note(before, 'assessment')) {
    const b = c.note(before, 'assessment')
    out.push(doc(`Assessment: now “${now.assessment?.excerpt.slice(0, 200) ?? 'not written yet'}”; before “${b?.excerpt.slice(0, 200) ?? 'not documented'}”.`, [now.assessment?.ref, b?.ref].filter((x): x is string => !!x)))
  }

  // Allergies recorded since, amendments since.
  const newAllergies = c.allergies.filter((a) => a.data.active && a.date && a.date > before.date)
  if (newAllergies.length) out.push(doc(`Allergy recorded since then: ${newAllergies.map((a) => `${a.data.substance} (${c.date(a.date)})`).join(', ')}.`, newAllergies.map((a) => a.ref)))
  const am = c.amendments(before)
  if (am.length) out.push(outdated(`The earlier consultation was amended on ${am.map((a) => c.date(a.date)).join(', ')}.`, am.map((a) => a.ref)))
  return [{ title: 'Changes since the previous visit', statements: out }]
}

const STOPWORDS = new Set('the and for with what was were has have had did does this that these those from about since when which who whom whose how why last previous today patient patients his her their him them any all are is be been being give tell show list me please there than then into onto over under after before during visit visits record records mention mentions mentioned search find look anything something note notes'.split(' '))

/** Free-text question: record items whose text mentions the question's words. */
function search(c: Ctx, question: string): ManaSection[] {
  const terms = [...new Set(question.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))]
  if (!terms.length) return [{ title: 'Record search', statements: [absent('The question has no specific words to look for. Try a suggested question or name a symptom, medicine or test.')] }]
  // A term matches at the start of a word, so "rash" finds "rashes" but not "crash".
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = terms.map((t) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(t.length >= 6 ? t.slice(0, 5) : t)}`, 'iu'))
  const hits = c.r.items
    // "Allergy status: not recorded" is an absence, not a mention; "no known allergies" is documented.
    .filter((i) => !(i.data.t === 'allergy_status' && !i.data.noKnownAllergies))
    .filter((i) => {
      const hay = `${i.field} ${i.excerpt}`
      return patterns.some((re) => re.test(hay))
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  const shown = hits.slice(0, 15)
  const out: ManaStatement[] = shown.map((i) => doc(`${c.date(i.date)} · ${i.field}: “${i.excerpt.slice(0, 300)}”`, [i.ref]))
  if (!shown.length) out.push(absent(`Nothing in the record items Mana reads${truncated(c) ? ` (${signedScope(c)}, vital signs of the last ${c.r.window.observationDays} days)` : ''} mentions ${terms.map((t) => `“${t}”`).join(', ')}.`))
  else if (hits.length > shown.length) out.push(doc(`${hits.length - shown.length} more matching item(s) not shown.`, []))
  return [{ title: `Record items mentioning ${terms.slice(0, 4).join(', ')}`, statements: out }]
}

/** Builds the record answer for an intent. Pure: same record, same answer. */
export function answerFromRecord(intent: ManaIntent, record: PatientRecord, question: string, settings: RuleSettings): ManaSection[] {
  const c = new Ctx(record, settings)
  switch (intent) {
    case 'briefing':
      return briefing(c)
    case 'history_summary':
      return historySummary(c)
    case 'last_prescription':
      return lastPrescriptionSections(c)
    case 'vitals_compare':
      return [vitalsSection(c)]
    case 'changes_since_last':
      return changesSinceLast(c)
    case 'allergies':
      return [allergySection(c)]
    case 'diagnoses':
      return [diagnosesSection(c)]
    case 'search':
      return search(c, question)
  }
}

/** Record items the AI summary may see for an intent (patient-scoped, bounded; never the whole database). */
export function itemsForGeneration(intent: ManaIntent, record: PatientRecord, cited: Set<string>, maxChars: number): RecordItem[] {
  const pick: Record<ManaIntent, ItemData['t'][]> = {
    briefing: ['allergy', 'allergy_status', 'note', 'diagnosis', 'medication', 'amendment', 'observation', 'visit', 'thermal'],
    history_summary: ['allergy', 'allergy_status', 'note', 'diagnosis', 'medication', 'amendment', 'visit'],
    changes_since_last: ['allergy', 'allergy_status', 'note', 'diagnosis', 'medication', 'amendment', 'observation', 'visit'],
    last_prescription: ['allergy', 'allergy_status', 'medication', 'amendment'],
    vitals_compare: ['observation', 'visit'],
    allergies: ['allergy', 'allergy_status', 'medication'],
    diagnoses: ['diagnosis', 'note', 'amendment'],
    search: [],
  }
  const wanted = new Set(pick[intent])
  const chosen = record.items.filter((i) => cited.has(i.ref) || wanted.has(i.data.t))
  // Within the character budget: items the record answer cites and the allergy
  // record first (never dropped for age), then the newest; restored to record order.
  const order = new Map(record.items.map((i, n) => [i.ref, n]))
  const priority = (i: RecordItem) => (cited.has(i.ref) ? 0 : i.data.t === 'allergy' || i.data.t === 'allergy_status' ? 1 : 2)
  let used = 0
  const kept: RecordItem[] = []
  for (const i of [...chosen].sort((a, b) => priority(a) - priority(b) || (b.date ?? '').localeCompare(a.date ?? ''))) {
    const len = i.excerpt.length + i.field.length + 40
    if (used + len > maxChars) continue
    used += len
    kept.push(i)
  }
  return kept.sort((a, b) => order.get(a.ref)! - order.get(b.ref)!)
}

// --- the record check (consultation draft, V3) -------------------------------------------------------------------------------------------

/** Version of the explicit rules that find what is conflicting, old or missing in a record. Change it when the rules change. */
export const RECORD_CHECK_VERSION = 'record-check-v2'

export interface RecordFinding {
  text: string
  refs: string[]
}

/**
 * What the record itself shows to be conflicting, old or missing, found by the same explicit rules as the answers above (no language model).
 * The consultation draft shows these whether or not a model is available, and labels them as rules. Pure: same record, same findings.
 */
export function recordChecks(record: PatientRecord, settings: RuleSettings): { conflicts: RecordFinding[]; outdated: RecordFinding[]; missing: RecordFinding[] } {
  const c = new Ctx(record, settings)
  const conflicts: RecordFinding[] = []
  const old: RecordFinding[] = []
  const missing: RecordFinding[] = []
  const active = c.allergies.filter((a) => a.data.active)

  // Conflicts: an allergy against "no known allergies"; an allergy against a drafted or recent medicine of the same configured group; staff measurements
  // of one kind at this visit that disagree beyond the configured tolerance (a device's unverified readings are not set against them or each other).
  if (record.patient.noKnownAllergies && active.length) conflicts.push({ text: 'The record says “no known allergies” but also lists active allergies. Confirm with the patient.', refs: active.map((a) => a.ref) })
  for (const s of allergyMedicationConflicts(c)) conflicts.push({ text: s.text, refs: s.refs })
  const visitId = record.currentVisitId
  const here = visitId ? c.observations.filter((o) => o.data.visitId === visitId) : []
  for (const kind of VITAL_ORDER) {
    const mine = here.filter((o) => o.data.kind === kind && !fromDevice(o))
    const cur = mine[0]
    if (!cur) continue
    const tol = settings.safety.vitalTolerance[kind]
    const off = tol !== undefined ? mine.filter((o) => Math.abs(o.data.value - cur.data.value) > tol) : []
    if (off.length) conflicts.push({ text: `${VITALS[kind].label} was recorded more than once at this visit with different values: ${[cur, ...off].map((o) => fmtV(kind, o.data.value)).join(' and ')}. Check which is correct.`, refs: [cur.ref, ...off.map((o) => o.ref)] })
  }

  // Outdated: the newest signed consultation and the last prescription are older than the configured age; an amendment may correct the prescription.
  const latest = record.consultations[0]
  if (latest) {
    const age = c.daysAgo(latest.date)
    if (age > settings.outdatedDays) old.push({ text: `The most recent signed consultation is ${age} days old (${c.date(latest.date)}).`, refs: latest.items.slice(0, 1).map((i) => i.ref) })
  }
  const last = c.lastPrescribed
  if (last) {
    const age = c.daysAgo(last.date)
    if (age > settings.outdatedDays) old.push({ text: `The last prescription is ${age} days old; the patient’s current medicines may differ. Confirm what they take now.`, refs: c.meds(last).map((m) => m.ref) })
    const am = c.amendments(last)
    if (am.length) old.push({ text: `The consultation with that prescription was amended on ${am.map((a) => c.date(a.date)).join(', ')}; read the amendment, which may correct the prescription.`, refs: am.map((a) => a.ref) })
  }

  // Missing: what the record could hold and does not, for this visit.
  const status = c.allergyStatus
  if (!active.length && status && !status.data.noKnownAllergies) missing.push({ text: 'Allergy status is not recorded.', refs: [status.ref] })
  if (visitId) {
    if (!c.visitReason(visitId)) missing.push({ text: 'No reason for visit was recorded at check-in.', refs: [] })
    if (!here.length) missing.push({ text: 'No vital signs are recorded at this visit.', refs: [] })
  }
  if (record.current && !c.note(record.current, 'chiefComplaint')) missing.push({ text: 'The chief complaint of today’s note is empty.', refs: [] })
  const listedMedicines = record.items.some((i) => i.data.t === 'patient_medication' && i.data.status === 'current')
  if (!listedMedicines && !c.currentMeds.length && !last) missing.push({ text: 'No current medicines are recorded.', refs: [] })
  return { conflicts, outdated: old, missing }
}
