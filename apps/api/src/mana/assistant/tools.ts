import { isConsultationTopic, MANA_TOOLS, type ManaConsultationTopic, type ManaSourceItem, type ManaToolName, type ManaTopic, type PlannedCall } from '@adaxai/contracts'
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { makeScrubber } from '../../ai/text.ts'
import { can } from '../../auth/permissions.ts'
import type { Config } from '../../config.ts'
import { buildConsultationContext } from '../../consultation-context/build.ts'
import { appointments, departments, encounters, facilities, patients, users, visits } from '../../db/schema.ts'
import { consentState } from '../../consents/service.ts'
import type { DbOrTx } from '../../db/client.ts'
import type { DenialAudit } from '../../http/errors.ts'
import { ageOn, fullName, getPatientOr404 } from '../../patients/service.ts'
import { type RuleSettings, answerFromRecord } from '../answers.ts'
import { loadPatientRecord, type PatientRecord } from '../record.ts'
import { contextFacts } from './consultation.ts'
import { resolveHandle, searchPatients, TooManyPatients } from './entities.ts'
import { addDays, cap, dayLabel, dayOf, freeText, scrubGeneric, timeLabel, toSourceItem } from './format.ts'
import { type ManaCtx, outcome, type ToolDef, type ToolFact, type ToolFinding, type ToolOutcome } from './types.ts'

/**
 * The registered tools: the only things Mana can do, and none of them writes. A tool checks that the caller's role holds every permission it needs
 * BEFORE it reads anything, reads only this clinic's records (the clinic is the caller's, never an argument), and returns the least that answers:
 * short sentences made from records, and the records they rest on. Patients appear as handles (P1, P2 ...), never as names; the free text of a record
 * (a note, a reason for a visit) has the patient's own name, MRN and telephone number replaced, and any telephone or record number replaced whoever it
 * belongs to. That is a best effort made of patterns: a name of someone else written in a note is not recognised.
 */
// v2 (D2): `consultation_context`, the consultation the conversation was opened in, read through the consultation context (consultation-context/build.ts).
// v3: it leaves out what the patient's consents to thermal imaging and to recording keep out, and a rejected point; it says nothing waits for review only of
// what it could count.
// v4 (ML audit G14): `get_patient_record` with the topic "medicines" gives the patient's medicine list as recorded (current medicines, those marked stopped,
// or "No current medicines are recorded.") before the last signed prescription and today's draft, each labelled by where it comes from (mana-record-v4).
// The consultation context names a transcript of synthetic demo audio as such (consultation-context/build.ts).
export const TOOLS_VERSION = 'mana-tools-v4'

const MAX_ROWS = 20
const MAX_FACTS_PER_TOOL = 24
/** How many signed consultations a lookup by date searches (the most the settings allow): a date older than that is said to be out of reach, not "not recorded". */
const DATE_LOOKUP_ENCOUNTERS = 50

const STATUS_WORDS: Record<string, string> = {
  waiting: 'waiting',
  in_triage: 'in triage',
  ready: 'ready for the doctor',
  in_consultation: 'with a doctor',
  completed: 'completed',
  cancelled: 'cancelled',
  no_show: 'did not attend',
  booked: 'booked',
  checked_in: 'checked in',
  rescheduled: 'rescheduled',
}

/** Ten-year age band and sex, the most a handle tells the model about a patient. */
function band(dob: string, sex: string, today: string): string {
  const y = ageOn(String(dob), today)
  return `${sex}, ${y >= 90 ? '90+' : `${Math.floor(y / 10) * 10}-${Math.floor(y / 10) * 10 + 9}`} years`
}

type Scrub = (t: string) => string
interface PatientIdentity {
  givenName: string
  familyName: string | null
  mrn: string
  phone: string
  emergencyContactName: string | null
  emergencyContactPhone: string | null
}
/** The replacement for one patient's free text: the patient's own identifiers, then any telephone or record number. */
const scrubberFor = (p: PatientIdentity): Scrub => {
  const own = makeScrubber(p)
  return (t) => scrubGeneric(own(t))
}

/**
 * Patients whose reasons and notes Mana does not show: those whose latest decision about AI help with their record is a withdrawal (also when the model
 * is on this computer); and, with a model that is NOT on this computer, every patient whose consent is not granted in its current wording.
 */
async function hiddenFor(ctx: ManaCtx, patientIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(patientIds)]
  if (!ids.length) return new Set()
  if (ctx.modelIsLocal) {
    const { rows } = await ctx.db.execute<{ patient_id: string; status: string } & Record<string, unknown>>(sql`
      select distinct on (patient_id) patient_id, status
      from consents
      where type = 'ai_record_assistant' and patient_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        and not (scope = 'encounter' and status = 'granted')
      order by patient_id, recorded_at desc`)
    return new Set(rows.filter((r) => r.status === 'withdrawn').map((r) => r.patient_id))
  }
  const hidden = new Set<string>()
  for (const id of ids) if ((await consentState(ctx.db, id, 'ai_record_assistant')).state !== 'granted') hidden.add(id)
  return hidden
}

const NOT_SHOWN = '; reason not shown (the patient’s consent to AI help does not allow it)'

/** Reading one patient's record: a withdrawn consent stops it (also when the model is local); a hosted model needs the consent to be granted. */
export async function consentRefusal(ctx: Pick<ManaCtx, 'modelIsLocal'>, db: DbOrTx, patientId: string, lock = false): Promise<string | null> {
  const { state } = await consentState(db, patientId, 'ai_record_assistant', undefined, lock)
  if (state === 'withdrawn') return 'The patient has withdrawn consent to AI help with their record, so Mana does not read it. Their record is still open to you in the consultation screens.'
  if (!ctx.modelIsLocal && state !== 'granted') return 'This server would send the record to a model that does not run on this computer, which needs the patient’s consent to Mana AI record summaries.'
  return null
}

const need = (call: PlannedCall, field: keyof PlannedCall, what: string): ToolOutcome | null => (call[field] === null || call[field] === undefined || call[field] === '' ? outcome('invalid', `${what} is needed.`) : null)

interface Who {
  patientId: string
  alias: string
  scrub: Scrub
}

/** The patient a call is about, or the outcome to return instead (not found, ambiguous, refused by consent). */
async function patientFor(ctx: ManaCtx, call: PlannedCall): Promise<Who | ToolOutcome> {
  const h = await resolveHandle(ctx, call.patient)
  if (h.kind === 'none') return outcome('not_found', h.reason)
  if (h.kind === 'ambiguous') {
    h.candidates.forEach((c) => ctx.disclosed.add(c.patientId))
    return outcome('ambiguous', `${h.candidates.length} patients match.`, { candidates: h.candidates.map((c) => c.alias) })
  }
  const refusal = await consentRefusal(ctx, ctx.db, h.patientId)
  if (refusal) return outcome('refused', refusal, { patientId: h.patientId })
  ctx.disclosed.add(h.patientId)
  return { patientId: h.patientId, alias: h.alias, scrub: scrubberFor(await getPatientOr404(ctx.db, ctx.me.facilityId, h.patientId)) }
}
const isOutcome = (x: unknown): x is ToolOutcome => typeof x === 'object' && x !== null && 'status' in x

const TOPIC_INTENT: Record<Exclude<ManaTopic, 'investigations' | ManaConsultationTopic>, Parameters<typeof answerFromRecord>[0]> = {
  briefing: 'briefing',
  history: 'history_summary',
  allergies: 'allergies',
  medicines: 'last_prescription',
  vitals: 'vitals_compare',
  diagnoses: 'diagnoses',
  changes: 'changes_since_last',
  search: 'search',
}

const rules = (ctx: ManaCtx): RuleSettings => ({ safety: ctx.settings.safety, outdatedDays: ctx.settings.mana.outdatedDays })

// --- one patient's record ----------------------------------------------------------------------------------------------------------------

const getPatientRecord: ToolDef = {
  name: 'get_patient_record',
  needs: ['patients:read', 'encounters:read'],
  async run(ctx, call) {
    const topic = call.topic ?? 'briefing'
    // What one consultation holds is read by its own tool, not out of the patient's record.
    if (isConsultationTopic(topic)) return outcome('invalid', 'That topic is about the open consultation, not about the patient’s record.')
    if (topic === 'search') {
      const missing = need(call, 'text', 'A word or phrase to look for')
      if (missing) return missing
    }
    const who = await patientFor(ctx, call)
    if (isOutcome(who)) return who
    // The consultation the conversation was opened in is read with its draft only for ITS patient.
    const record = await loadPatientRecord(ctx.db, ctx.me, who.patientId, {
      encounterId: ctx.scope.patientId === who.patientId ? (ctx.scope.encounterId ?? undefined) : undefined,
      maxEncounters: ctx.settings.mana.maxEncounters,
      observationDays: ctx.settings.mana.observationDays,
      includeHistory: true,
    })
    const facts: ToolFact[] = []
    const findings: ToolFinding[] = []
    const itemsOf = (refs: string[]): ManaSourceItem[] => refs.flatMap((r) => (record.byRef.get(r) ? [toSourceItem(record.byRef.get(r)!, record)] : [])).slice(0, 6)
    if (topic === 'investigations') {
      const results = record.items.filter((x) => x.data.t === 'investigation')
      for (const i of results.slice(0, MAX_FACTS_PER_TOOL)) facts.push({ text: cap(who.scrub(i.excerpt), 300), patient: who.alias, items: [toSourceItem(i, record)] })
      if (!facts.length) findings.push({ kind: 'absent', text: 'No investigation results are recorded for this patient.', items: [] })
      if (results.length > MAX_FACTS_PER_TOOL) findings.push({ kind: 'absent', text: `Only the first ${MAX_FACTS_PER_TOOL} of ${results.length} investigation results are shown.`, items: [] })
    } else {
      const sections = answerFromRecord(TOPIC_INTENT[topic], record, call.text ?? '', rules(ctx))
      for (const section of sections) {
        for (const st of section.statements) {
          const items = itemsOf(st.refs)
          if (st.kind === 'documented' || st.kind === 'generated') facts.push({ text: cap(who.scrub(`${section.title}: ${st.text}`), 360), patient: who.alias, items })
          else findings.push({ kind: st.kind === 'conflict' ? 'conflict' : st.kind === 'outdated' ? 'outdated' : 'absent', text: cap(who.scrub(st.text), 360), items })
        }
      }
    }
    const kept = facts.slice(0, MAX_FACTS_PER_TOOL)
    if (facts.length > kept.length) findings.push({ kind: 'absent', text: `Only the first ${MAX_FACTS_PER_TOOL} of ${facts.length} statements are shown.`, items: [] })
    const detail = `${topic}: ${kept.length} statement(s), ${findings.length} finding(s); ${record.consultations.length} of ${record.signedTotal} signed consultation(s) read`
    return outcome(kept.length || findings.length ? 'ok' : 'empty', detail, { facts: kept, findings, patientId: who.patientId })
  },
}

const getPatientVisits: ToolDef = {
  name: 'get_patient_visits',
  needs: ['patients:read', 'queue:read'],
  async run(ctx, call) {
    const who = await patientFor(ctx, call)
    if (isOutcome(who)) return who
    const LIMIT = 12
    const rows = await ctx.db
      .select({ v: visits, dept: departments.name, doctor: users.fullName, e: { id: encounters.id, status: encounters.status, signedAt: encounters.signedAt } })
      .from(visits)
      .innerJoin(departments, eq(departments.id, visits.departmentId))
      .leftJoin(users, eq(users.id, visits.assignedDoctorId))
      .leftJoin(encounters, and(eq(encounters.visitId, visits.id), sql`${encounters.status} <> 'discarded'`))
      .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.patientId, who.patientId)))
      .orderBy(desc(visits.visitDate), desc(visits.tokenNumber))
      .limit(LIMIT)
    if (!rows.length) return outcome('empty', 'no visits', { findings: [{ kind: 'absent', text: 'No visits are recorded for this patient.', items: [] }], patientId: who.patientId })
    const hidden = (await hiddenFor(ctx, [who.patientId])).has(who.patientId)
    const facts: ToolFact[] = rows.map(({ v, dept, doctor, e }) => {
      const reason = hidden ? NOT_SHOWN : v.chiefComplaint ? `; reason “${freeText(v.chiefComplaint, 160, who.scrub)}”` : '; no reason recorded'
      const signed = e?.status === 'signed' ? `; the consultation was signed${e.signedAt ? ` on ${dayLabel(e.signedAt, ctx.timeZone)}` : ''}` : e?.status === 'in_progress' ? '; a consultation is open (not signed)' : ''
      const text = `Visit on ${dayLabel(v.visitDate, ctx.timeZone)} (${dept}${doctor ? `, ${doctor}` : ''}): ${STATUS_WORDS[v.status] ?? v.status}${reason}${signed}.`
      const item: ManaSourceItem = { kind: 'operational', label: `Visit · ${dayLabel(v.visitDate, ctx.timeZone)}`, date: v.visitDate, status: STATUS_WORDS[v.status] ?? v.status, excerpt: cap(text, 400), link: e?.id ? { to: 'encounter', id: e.id } : { to: 'patient', id: who.patientId } }
      return { text, patient: who.alias, items: [item] }
    })
    // What the summary says is exactly what the rows say: the newest visit with its state (a cancelled or missed visit is not "completed"), and the newest completed one, if there is one.
    const latest = rows[0]!
    const done = rows.find(({ v }) => v.status === 'completed')
    facts.unshift({
      text: `The most recent visit on record was on ${dayLabel(latest.v.visitDate, ctx.timeZone)} (${STATUS_WORDS[latest.v.status] ?? latest.v.status}); ${done ? `the last completed visit was on ${dayLabel(done.v.visitDate, ctx.timeZone)}.` : 'no completed visit is recorded among the visits read.'}`,
      patient: who.alias,
      items: [facts[0]!.items[0]!],
    })
    return outcome('ok', `${rows.length} visit(s)`, { facts, patientId: who.patientId, ...(rows.length === LIMIT ? { findings: [{ kind: 'absent' as const, text: `Only the ${LIMIT} most recent visits are read.`, items: [] }] } : {}) })
  },
}

const getConsultation: ToolDef = {
  name: 'get_consultation',
  needs: ['patients:read', 'encounters:read'],
  async run(ctx, call) {
    const which = call.which ?? 'last'
    if (which === 'date') {
      const missing = need(call, 'date', 'A date')
      if (missing) return missing
    }
    const who = await patientFor(ctx, call)
    if (isOutcome(who)) return who
    // A lookup by date searches as many signed consultations as the settings allow; the others read only the newest few.
    const record: PatientRecord = await loadPatientRecord(ctx.db, ctx.me, who.patientId, {
      maxEncounters: which === 'date' ? DATE_LOOKUP_ENCOUNTERS : ctx.settings.mana.maxEncounters,
      observationDays: ctx.settings.mana.observationDays,
      includeHistory: false,
    })
    // The day a consultation was signed, in the clinic's own time zone.
    const sameDay = which === 'date' ? record.consultations.filter((x) => dayOf(new Date(x.date), ctx.timeZone) === call.date) : []
    const c = which === 'last' ? record.consultations[0] : which === 'previous' ? record.consultations[1] : sameDay[0]
    if (!c) {
      const partial = record.signedTotal > record.consultations.length
      const reach = partial ? ` (only the ${record.consultations.length} most recent of the patient’s ${record.signedTotal} signed consultations were searched)` : ''
      const text =
        which === 'date'
          ? `No signed consultation of this patient is recorded on ${dayLabel(call.date, ctx.timeZone)}${reach}.`
          : `No ${which === 'last' ? 'signed consultation' : 'earlier signed consultation'} of this patient is recorded.`
      return outcome('not_found', which === 'date' ? `no signed consultation on ${call.date}` : `no ${which} signed consultation in the window read`, { findings: [{ kind: 'absent', text, items: [] }], patientId: who.patientId })
    }
    const facts: ToolFact[] = []
    const header = `Signed consultation of ${dayLabel(c.date, ctx.timeZone)}${c.doctorName ? ` by ${c.doctorName}` : ''}${c.amended ? ' (later amended)' : ''}.`
    facts.push({ text: header, patient: who.alias, items: [] })
    for (const i of c.items) {
      const item = toSourceItem(i, record)
      const d = i.data
      if (d.t === 'note' && d.value.trim()) facts.push({ text: `${i.field}: ${freeText(d.value, 300, who.scrub)}`, patient: who.alias, items: [item] })
      else if (d.t === 'diagnosis') facts.push({ text: `Diagnosis: ${freeText(d.description, 160, who.scrub)}${d.code ? ` (${d.code})` : ''}.`, patient: who.alias, items: [item] })
      else if (d.t === 'medication') facts.push({ text: `Prescribed: ${freeText(d.summary, 240, who.scrub)}.`, patient: who.alias, items: [item] })
      else if (d.t === 'amendment') facts.push({ text: `Amendment of ${dayLabel(d.createdAt, ctx.timeZone)}: ${freeText(d.reason, 200, who.scrub)}`, patient: who.alias, items: [item] })
    }
    facts[0]!.items = facts[1]?.items.slice(0, 1) ?? []
    const findings: ToolFinding[] = sameDay.length > 1 ? [{ kind: 'absent', text: `${sameDay.length} signed consultations of this patient are recorded on that day; this is the most recent of them.`, items: [] }] : []
    return outcome('ok', `${which} signed consultation, ${facts.length - 1} item(s)`, { facts: facts.slice(0, MAX_FACTS_PER_TOOL), findings, patientId: who.patientId })
  },
}

// --- finding a patient ---------------------------------------------------------------------------------------------------------------

const findPatient: ToolDef = {
  name: 'find_patient',
  needs: ['patients:read'],
  async run(ctx, call) {
    const missing = need(call, 'text', 'A name, an MRN or telephone digits')
    if (missing) return missing
    const rows = await searchPatients(ctx.db, ctx.me.facilityId, call.text!, 6, { mrnPrefix: true, phone: true })
    if (!rows.length) return outcome('not_found', 'no match', { findings: [{ kind: 'absent', text: 'No patient of this clinic matches that.', items: [] }] })
    const q = call.text!.toLowerCase().replace(/\s+/g, ' ').trim()
    const exact = rows.filter((r) => fullName(r).toLowerCase() === q)
    const chosen = rows.length === 1 ? rows : exact.length === 1 && q.includes(' ') ? exact : null
    const shown = chosen ?? rows.slice(0, 5)
    const aliases = shown.map((r) => ctx.book.aliasFor(r.id))
    shown.forEach((r) => ctx.disclosed.add(r.id))
    if (!chosen) return outcome('ambiguous', `${shown.length} patients match`, { candidates: aliases })
    const r = chosen[0]!
    return outcome('ok', 'one match', {
      patientId: r.id,
      facts: [{ text: `${aliases[0]} is ${band(String(r.dateOfBirth), r.sex, ctx.today)} and is a patient of this clinic.`, patient: aliases[0]!, items: [{ kind: 'patient_record', label: 'Patient record', date: null, status: null, excerpt: `${aliases[0]}: ${band(String(r.dateOfBirth), r.sex, ctx.today)}`, link: { to: 'patient', id: r.id } }] }],
    })
  },
}

// --- the clinic's day ----------------------------------------------------------------------------------------------------------------

interface ListedPatient extends PatientIdentity {
  id: string
  dob: string
  sex: string
}
/** The columns of a patient that a list needs: the handle's age band, and the identifiers to take out of the free text of that patient's rows. */
const listedPatient = {
  id: patients.id,
  dob: patients.dateOfBirth,
  sex: patients.sex,
  givenName: patients.givenName,
  familyName: patients.familyName,
  mrn: patients.mrn,
  phone: patients.phone,
  emergencyContactName: patients.emergencyContactName,
  emergencyContactPhone: patients.emergencyContactPhone,
}

interface VisitRowOut {
  v: typeof visits.$inferSelect
  p: ListedPatient
  dept: string
  doctor: string | null
}

async function visitFacts(ctx: ManaCtx, rows: VisitRowOut[], when: (v: typeof visits.$inferSelect) => string): Promise<ToolFact[]> {
  const hidden = await hiddenFor(ctx, rows.map((r) => r.p.id))
  return rows.map(({ v, p, dept, doctor }) => {
    const alias = ctx.book.aliasFor(p.id)
    ctx.disclosed.add(p.id)
    if (!hidden.has(p.id) && v.chiefComplaint) ctx.textShown.add(p.id)
    const reason = hidden.has(p.id) ? NOT_SHOWN : v.chiefComplaint ? `; reason “${freeText(v.chiefComplaint, 140, scrubberFor(p))}”` : '; no reason recorded'
    const text = `${alias} (${band(String(p.dob), p.sex, ctx.today)}), token ${v.tokenNumber}, ${dept}: ${STATUS_WORDS[v.status] ?? v.status}, ${when(v)}${v.priority === 'urgent' ? ', urgent' : ''}${doctor ? `, assigned to ${doctor}` : ''}${reason}.`
    return { text, patient: alias, items: [{ kind: 'operational', label: `Queue · token ${v.tokenNumber} · ${dayLabel(v.visitDate, ctx.timeZone)}`, date: v.visitDate, status: STATUS_WORDS[v.status] ?? v.status, excerpt: cap(text, 400), link: { to: 'patient', id: p.id } }] }
  })
}

const visitSelect = (ctx: ManaCtx) => ctx.db.select({ v: visits, p: listedPatient, dept: departments.name, doctor: users.fullName }).from(visits).innerJoin(patients, eq(patients.id, visits.patientId)).innerJoin(departments, eq(departments.id, visits.departmentId)).leftJoin(users, eq(users.id, visits.assignedDoctorId))

/** The same meaning of "mine" as the queue page: assigned to me, or unassigned in my department. */
const mine = (ctx: ManaCtx) => (ctx.me.departmentId ? or(eq(visits.assignedDoctorId, ctx.me.id), and(isNull(visits.assignedDoctorId), eq(visits.departmentId, ctx.me.departmentId))) : eq(visits.assignedDoctorId, ctx.me.id))

const getTodayQueue: ToolDef = {
  name: 'get_today_queue',
  needs: ['queue:read'],
  async run(ctx, call) {
    const counts = await ctx.db
      .select({ status: visits.status, n: sql<number>`count(*)::int` })
      .from(visits)
      .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.visitDate, ctx.today), ...(call.mine ? [mine(ctx)!] : [])))
      .groupBy(visits.status)
    // In the order of a visit's life (what the database returns is in no order).
    const lifeOrder = ['waiting', 'in_triage', 'ready', 'in_consultation', 'completed', 'cancelled', 'no_show']
    counts.sort((x, y) => (lifeOrder.indexOf(x.status) + 1 || 99) - (lifeOrder.indexOf(y.status) + 1 || 99))
    const total = counts.reduce((n, c) => n + c.n, 0)
    const summary = counts.length ? counts.map((c) => `${c.n} ${STATUS_WORDS[c.status] ?? c.status}`).join(', ') : 'nobody'
    const open = ['waiting', 'in_triage', 'ready', 'in_consultation'] as const
    const statusCond = call.status === 'any' ? [] : call.status ? [eq(visits.status, call.status)] : [inArray(visits.status, [...open])]
    const rows = await visitSelect(ctx)
      .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.visitDate, ctx.today), ...statusCond, ...(call.mine ? [mine(ctx)!] : [])))
      .orderBy(asc(visits.tokenNumber))
      .limit(MAX_ROWS + 1)
    const facts: ToolFact[] = [{ text: `${call.mine ? 'Your queue' : 'The clinic’s queue'} today (${dayLabel(ctx.today, ctx.timeZone)}): ${total} visit(s): ${summary}.`, patient: null, items: [{ kind: 'operational', label: `Queue · ${dayLabel(ctx.today, ctx.timeZone)}`, date: ctx.today, status: null, excerpt: `${total} visit(s): ${summary}`, link: null }] }]
    facts.push(...(await visitFacts(ctx, rows.slice(0, MAX_ROWS), (v) => `checked in at ${timeLabel(v.checkedInAt, ctx.timeZone)}`)))
    const detail = `${total} visit(s) today, ${Math.min(rows.length, MAX_ROWS)} listed${rows.length > MAX_ROWS ? ' (more not shown)' : ''}`
    return outcome(total ? 'ok' : 'empty', detail, { facts, ...(rows.length > MAX_ROWS ? { findings: [{ kind: 'absent' as const, text: `Only the first ${MAX_ROWS} visits are shown.`, items: [] }] } : {}) })
  },
}

const getRecentVisits: ToolDef = {
  name: 'get_recent_visits',
  needs: ['queue:read'],
  async run(ctx, call) {
    const when = call.when ?? 'today'
    let from: Date | null = null
    let to: Date | null = null
    let day: string | null = null
    let described: string
    if (when === 'last_minutes' || when === 'minutes_ago') {
      const missing = need(call, 'minutes', 'A number of minutes')
      if (missing) return missing
      const n = call.minutes!
      const slack = Math.max(15, Math.round(n / 4))
      from = new Date(ctx.now.getTime() - (when === 'last_minutes' ? n : n + slack) * 60_000)
      to = new Date(ctx.now.getTime() - (when === 'last_minutes' ? 0 : Math.max(0, n - slack)) * 60_000)
      described = `between ${timeLabel(from, ctx.timeZone)} and ${timeLabel(to, ctx.timeZone)} on ${dayLabel(dayOf(to, ctx.timeZone), ctx.timeZone)}`
    } else if (when === 'yesterday') {
      day = addDays(ctx.today, -1)
      described = `on ${dayLabel(day, ctx.timeZone)}`
    } else if (when === 'date') {
      const missing = need(call, 'date', 'A date')
      if (missing) return missing
      day = call.date!
      described = `on ${dayLabel(day, ctx.timeZone)}`
    } else if (when === 'today') {
      day = ctx.today
      described = `today (${dayLabel(day, ctx.timeZone)})`
    } else return outcome('invalid', 'That time window is not about visits that already happened.')
    const rows = await visitSelect(ctx)
      .where(and(eq(visits.facilityId, ctx.me.facilityId), ...(from && to ? [gte(visits.checkedInAt, from), lt(visits.checkedInAt, to)] : [eq(visits.visitDate, day!)]), ...(call.mine ? [mine(ctx)!] : [])))
      .orderBy(desc(visits.checkedInAt))
      .limit(MAX_ROWS + 1)
    const header: ToolFact = { text: `Checked in ${described}: ${Math.min(rows.length, MAX_ROWS)}${rows.length > MAX_ROWS ? '+' : ''} visit(s).`, patient: null, items: [{ kind: 'operational', label: 'Check-ins', date: day, status: null, excerpt: `Checked in ${described}`, link: null }] }
    const facts = [header, ...(await visitFacts(ctx, rows.slice(0, MAX_ROWS), (v) => `checked in at ${timeLabel(v.checkedInAt, ctx.timeZone)}`))]
    return outcome(rows.length ? 'ok' : 'empty', `${rows.length} visit(s) ${when}`, { facts, ...(rows.length > MAX_ROWS ? { findings: [{ kind: 'absent' as const, text: `Only the first ${MAX_ROWS} check-ins are shown.`, items: [] }] } : {}) })
  },
}

const getAppointments: ToolDef = {
  name: 'get_appointments',
  needs: ['appointments:read', 'patients:read'],
  async run(ctx, call) {
    const when = call.when ?? 'today'
    let described: string
    let from: Date
    let to: Date
    /** The instants a calendar day of the clinic begins and ends (its own time zone). */
    const localDay = async (d: string) => {
      const { rows } = await ctx.db.execute<{ f: number; t: number } & Record<string, unknown>>(sql`select extract(epoch from (${d}::date)::timestamp at time zone ${ctx.timeZone})::float8 as f, extract(epoch from ((${d}::date + 1)::timestamp at time zone ${ctx.timeZone}))::float8 as t`)
      return { from: new Date(Number(rows[0]!.f) * 1000), to: new Date(Number(rows[0]!.t) * 1000) }
    }
    if (when === 'next_minutes') {
      const missing = need(call, 'minutes', 'A number of minutes')
      if (missing) return missing
      from = ctx.now
      to = new Date(ctx.now.getTime() + call.minutes! * 60_000)
      described = `in the next ${call.minutes} minute(s) (until ${timeLabel(to, ctx.timeZone)})`
    } else {
      let d: string
      if (when === 'today') d = ctx.today
      else if (when === 'tomorrow') d = addDays(ctx.today, 1)
      else if (when === 'yesterday') d = addDays(ctx.today, -1)
      else if (when === 'date') {
        const missing = need(call, 'date', 'A date')
        if (missing) return missing
        d = call.date!
      } else return outcome('invalid', 'That time window does not fit appointments.')
      ;({ from, to } = await localDay(d))
      described = `on ${dayLabel(d, ctx.timeZone)}`
    }
    const rows = await ctx.db
      .select({ a: appointments, p: listedPatient, dept: departments.name, doctor: users.fullName })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .innerJoin(departments, eq(departments.id, appointments.departmentId))
      .leftJoin(users, eq(users.id, appointments.doctorId))
      .where(and(eq(appointments.facilityId, ctx.me.facilityId), gte(appointments.scheduledAt, from), lt(appointments.scheduledAt, to), sql`${appointments.status} not in ('rescheduled')`, ...(call.mine ? [eq(appointments.doctorId, ctx.me.id)] : [])))
      .orderBy(asc(appointments.scheduledAt))
      .limit(MAX_ROWS + 1)
    const hidden = await hiddenFor(ctx, rows.map((r) => r.p.id))
    const facts: ToolFact[] = [{ text: `${call.mine ? 'Your appointments' : 'Appointments'} ${described}: ${Math.min(rows.length, MAX_ROWS)}${rows.length > MAX_ROWS ? '+' : ''}.`, patient: null, items: [{ kind: 'appointment', label: 'Appointments', date: null, status: null, excerpt: `Appointments ${described}`, link: null }] }]
    for (const { a, p, dept, doctor } of rows.slice(0, MAX_ROWS)) {
      const alias = ctx.book.aliasFor(p.id)
      ctx.disclosed.add(p.id)
      if (!hidden.has(p.id) && a.reason) ctx.textShown.add(p.id)
      const reason = hidden.has(p.id) ? NOT_SHOWN : a.reason ? `; reason “${freeText(a.reason, 140, scrubberFor(p))}”` : ''
      const text = `${timeLabel(a.scheduledAt, ctx.timeZone)} on ${dayLabel(a.scheduledAt, ctx.timeZone)} (${a.durationMinutes} min): ${alias} (${band(String(p.dob), p.sex, ctx.today)}), ${dept}${doctor ? ` with ${doctor}` : ''}: ${STATUS_WORDS[a.status] ?? a.status}${reason}.`
      facts.push({ text, patient: alias, items: [{ kind: 'appointment', label: `Appointment · ${dayLabel(a.scheduledAt, ctx.timeZone)} · ${timeLabel(a.scheduledAt, ctx.timeZone)}`, date: a.scheduledAt.toISOString(), status: STATUS_WORDS[a.status] ?? a.status, excerpt: cap(text, 400), link: { to: 'patient', id: p.id } }] })
    }
    return outcome(rows.length ? 'ok' : 'empty', `${rows.length} appointment(s)`, { facts, ...(rows.length > MAX_ROWS ? { findings: [{ kind: 'absent' as const, text: `Only the first ${MAX_ROWS} appointments are shown.`, items: [] }] } : {}) })
  },
}

const getMyConsultations: ToolDef = {
  name: 'get_my_consultations',
  needs: ['encounters:read'],
  async run(ctx, call) {
    const when = call.when ?? 'today'
    let day: string
    if (when === 'today') day = ctx.today
    else if (when === 'yesterday') day = addDays(ctx.today, -1)
    else if (when === 'date') {
      const missing = need(call, 'date', 'A date')
      if (missing) return missing
      day = call.date!
    } else return outcome('invalid', 'That time window does not fit consultations.')
    const signedDay = sql`(${encounters.signedAt} at time zone ${ctx.timeZone})::date = ${day}::date`
    const startedDay = sql`(${encounters.startedAt} at time zone ${ctx.timeZone})::date = ${day}::date`
    const mineOnDay = and(eq(encounters.facilityId, ctx.me.facilityId), eq(encounters.doctorId, ctx.me.id), or(signedDay, startedDay))
    // The counts are counted by the database over every consultation of the day, not over the rows listed below.
    const [agg] = await ctx.db
      .select({
        signed: sql<number>`count(*) filter (where ${encounters.status} = 'signed' and ${signedDay})::int`,
        open: sql<number>`count(*) filter (where ${encounters.status} = 'in_progress' and ${startedDay})::int`,
        discarded: sql<number>`count(*) filter (where ${encounters.status} = 'discarded' and ${startedDay})::int`,
      })
      .from(encounters)
      .where(mineOnDay)
    const { signed, open, discarded } = agg ?? { signed: 0, open: 0, discarded: 0 }
    const rows = await ctx.db
      .select({ e: { id: encounters.id, status: encounters.status, startedAt: encounters.startedAt, signedAt: encounters.signedAt }, p: { id: patients.id, dob: patients.dateOfBirth, sex: patients.sex } })
      .from(encounters)
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .where(mineOnDay)
      .orderBy(asc(encounters.startedAt))
      .limit(MAX_ROWS + 1)
    const facts: ToolFact[] = [{ text: `Your consultations on ${dayLabel(day, ctx.timeZone)}: ${signed} signed that day, ${open} open (started that day, not signed), ${discarded} discarded.`, patient: null, items: [{ kind: 'operational', label: `Your consultations · ${dayLabel(day, ctx.timeZone)}`, date: day, status: null, excerpt: `${signed} signed, ${open} open, ${discarded} discarded`, link: null }] }]
    for (const { e, p } of rows.slice(0, MAX_ROWS)) {
      const alias = ctx.book.aliasFor(p.id)
      ctx.disclosed.add(p.id)
      const text = `${alias} (${band(String(p.dob), p.sex, ctx.today)}): consultation ${e.status === 'signed' ? `signed at ${timeLabel(e.signedAt ?? e.startedAt, ctx.timeZone)}` : e.status === 'in_progress' ? `open, started at ${timeLabel(e.startedAt, ctx.timeZone)}` : 'discarded'}.`
      facts.push({ text, patient: alias, items: [{ kind: 'operational', label: `Consultation · ${dayLabel(e.startedAt, ctx.timeZone)}`, date: e.startedAt.toISOString(), status: e.status, excerpt: cap(text, 400), link: { to: 'encounter', id: e.id } }] })
    }
    return outcome(signed + open + discarded ? 'ok' : 'empty', `${signed + open + discarded} consultation(s), ${signed} signed`, { facts, ...(rows.length > MAX_ROWS ? { findings: [{ kind: 'absent' as const, text: `Only the first ${MAX_ROWS} consultations are listed; the counts above are of all of them.`, items: [] }] } : {}) })
  },
}

// --- the clinic and the doctor -------------------------------------------------------------------------------------------------------

const getFacilityInformation: ToolDef = {
  name: 'get_facility_information',
  needs: ['departments:read'],
  async run(ctx) {
    const [f] = await ctx.db.select({ name: facilities.name, timezone: facilities.timezone }).from(facilities).where(eq(facilities.id, ctx.me.facilityId))
    if (!f) return outcome('not_found', 'no clinic')
    const deps = await ctx.db.select({ name: departments.name, code: departments.code }).from(departments).where(and(eq(departments.facilityId, ctx.me.facilityId), eq(departments.isActive, true))).orderBy(asc(departments.name))
    const text = `The clinic is ${f.name} (time zone ${f.timezone}). Departments: ${deps.map((d) => `${d.name} (${d.code})`).join(', ') || 'none recorded'}.`
    return outcome('ok', `${deps.length} department(s)`, { facts: [{ text, patient: null, items: [{ kind: 'facility', label: 'Clinic information', date: null, status: null, excerpt: cap(text, 400), link: null }] }] })
  },
}

const getCurrentContext: ToolDef = {
  name: 'get_current_context',
  needs: [],
  async run(ctx) {
    const [dept] = ctx.me.departmentId ? await ctx.db.select({ name: departments.name }).from(departments).where(eq(departments.id, ctx.me.departmentId)) : []
    const facts: ToolFact[] = [
      { text: `It is ${timeLabel(ctx.now, ctx.timeZone)} on ${dayLabel(ctx.today, ctx.timeZone)} (clinic time). The user is ${ctx.me.fullName}, a doctor${dept ? ` in ${dept.name}` : ''}.`, patient: null, items: [{ kind: 'operational', label: 'Session', date: ctx.today, status: null, excerpt: `${ctx.me.fullName}`, link: null }] },
    ]
    if (ctx.scope.patientId) {
      const [p] = await ctx.db.select(listedPatient).from(patients).where(and(eq(patients.id, ctx.scope.patientId), eq(patients.facilityId, ctx.me.facilityId)))
      if (p) {
        const alias = ctx.book.aliasFor(p.id)
        ctx.disclosed.add(p.id)
        const [v] = ctx.scope.encounterId ? await ctx.db.select({ reason: visits.chiefComplaint }).from(encounters).innerJoin(visits, eq(visits.id, encounters.visitId)).where(and(eq(encounters.id, ctx.scope.encounterId), eq(encounters.facilityId, ctx.me.facilityId))) : []
        const hidden = (await hiddenFor(ctx, [p.id])).has(p.id)
        if (!hidden && v?.reason) ctx.textShown.add(p.id)
        const text = `${ctx.scope.encounterId ? 'The open consultation' : 'The patient record open in this conversation'} is for ${alias} (${band(String(p.dob), p.sex, ctx.today)})${v?.reason && !hidden ? `; reason “${freeText(v.reason, 140, scrubberFor(p))}”` : ''}.`
        facts.push({ text, patient: alias, items: [{ kind: 'operational', label: ctx.scope.encounterId ? 'Open consultation' : 'Open patient record', date: ctx.today, status: null, excerpt: cap(text, 400), link: ctx.scope.encounterId ? { to: 'encounter', id: ctx.scope.encounterId } : { to: 'patient', id: p.id } }] })
        return outcome('ok', 'context with an open consultation', { facts, patientId: p.id })
      }
    }
    facts.push({ text: 'This conversation is not about a particular patient.', patient: null, items: [] })
    return outcome('ok', 'context without a consultation', { facts })
  },
}

// --- the consultation the conversation was opened in (D2) --------------------------------------------------------------------------------

/**
 * The deployment as the consultation context reads it when Mana was not given the server's configuration: it reads only `env` and `dataOrigin` (whether a
 * simulator may post here, devices/gateway.ts), and this is the strictest answer (none may). Mana leaves SIMULATED items out whatever the answer is.
 */
const UNKNOWN_DEPLOYMENT = { env: 'production', dataOrigin: 'clinical' } as Config

const getConsultationContext: ToolDef = {
  name: 'consultation_context',
  needs: ['patients:read', 'encounters:read'],
  async run(ctx, call) {
    const topic: ManaConsultationTopic = isConsultationTopic(call.topic) ? call.topic : 'consultation_recorded'
    // Only the consultation this conversation was opened in, and only for its patient: there is no argument that names another one.
    if (!ctx.scope.encounterId || !ctx.scope.patientId) return outcome('refused', 'This conversation was not opened in a consultation, so there is no consultation to read. Ask from the consultation itself.')
    const h = await resolveHandle(ctx, call.patient ?? 'current')
    if (h.kind === 'none') return outcome('not_found', h.reason)
    if (h.kind === 'ambiguous' || h.patientId !== ctx.scope.patientId) return outcome('refused', 'Mana reads only the consultation this conversation was opened in, for its own patient.')
    const refusal = await consentRefusal(ctx, ctx.db, h.patientId)
    if (refusal) return outcome('refused', refusal, { patientId: h.patientId })
    // The same read model, with the same isolation, as the consultation's Overview: who may see what is decided inside it, from the caller. It throws a 404
    // (with its audit reason) for another clinic's consultation, which runTool turns into "not found".
    const c = await buildConsultationContext({ db: ctx.db, settings: ctx.settings, config: ctx.config ?? UNKNOWN_DEPLOYMENT }, ctx.me, ctx.scope.encounterId, { now: ctx.now.getTime() })
    if (c.patientId !== h.patientId) return outcome('not_found', 'not found')
    const [e] = await ctx.db.select({ status: encounters.status, doctorId: encounters.doctorId }).from(encounters).where(and(eq(encounters.id, c.encounterId), eq(encounters.facilityId, ctx.me.facilityId)))
    if (!e) return outcome('not_found', 'not found')
    // What the patient's other consents keep out of what Mana reads, as the other paths keep it out: the thermal images once consent to thermal imaging is
    // withdrawn (as the patient's record does, record.ts); the conversation and its points unless consent to recording and AI assistance is granted, in its
    // current wording, for this consultation (as the consultation draft requires, consult/service.ts).
    const [thermal, recording] = await Promise.all([consentState(ctx.db, h.patientId, 'thermal_imaging'), consentState(ctx.db, h.patientId, 'ai_recording', c.encounterId)])
    ctx.disclosed.add(h.patientId)
    const scrub = scrubberFor(await getPatientOr404(ctx.db, ctx.me.facilityId, h.patientId))
    const out = contextFacts(c, topic, {
      encounterId: c.encounterId,
      alias: h.alias,
      scrub,
      timeZone: ctx.timeZone,
      today: ctx.today,
      signed: e.status === 'signed',
      isAuthor: e.doctorId === ctx.me.id,
      withheld: { thermal: thermal.state === 'withdrawn', conversation: recording.state !== 'granted' },
    })
    return outcome(out.facts.length || out.findings.length ? 'ok' : 'empty', out.detail, { facts: out.facts, findings: out.findings, patientId: h.patientId })
  },
}

export const REGISTRY: Record<ManaToolName, ToolDef> = {
  get_current_context: getCurrentContext,
  find_patient: findPatient,
  get_patient_record: getPatientRecord,
  get_patient_visits: getPatientVisits,
  get_consultation: getConsultation,
  get_today_queue: getTodayQueue,
  get_recent_visits: getRecentVisits,
  get_appointments: getAppointments,
  get_my_consultations: getMyConsultations,
  get_facility_information: getFacilityInformation,
  consultation_context: getConsultationContext,
}

if (Object.keys(REGISTRY).sort().join() !== Object.keys(MANA_TOOLS).sort().join()) throw new Error('the registry and the contract list different tools')

/**
 * Runs one planned call. The order is the point: the caller's permissions are checked first, with nothing read; then the tool reads (for this doctor,
 * in this clinic); and whatever goes wrong inside it is an `error` outcome with no detail of the failure, never an exception for the model to see.
 */
export async function runTool(ctx: ManaCtx, call: PlannedCall): Promise<ToolOutcome> {
  const def = REGISTRY[call.tool]
  if (!def) return outcome('invalid', 'That is not a tool Mana has.')
  const lacking = def.needs.filter((p) => !can(ctx.me.role, p))
  if (lacking.length) return outcome('refused', 'Your role is not allowed to read that.')
  try {
    return await def.run(ctx, call)
  } catch (e) {
    if (e instanceof TooManyPatients) return outcome('refused', e.message)
    // A patient or record outside the clinic is the same answer as one that does not exist (the lookup audits the difference).
    if (typeof e === 'object' && e && 'statusCode' in e && (e as { statusCode: number }).statusCode === 404) {
      const denial = (e as { auditDenial?: DenialAudit }).auditDenial
      if (denial) ctx.denials.push(denial)
      return outcome('not_found', 'not found')
    }
    return outcome('error', 'The lookup failed.')
  }
}
