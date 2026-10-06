import {
  countDoctorQueue,
  doctorQueueStatus,
  type DoctorQueueStatus,
  MANA_NOT_ESTABLISHED,
  type ManaActionProposal,
  type ManaAnswerBody,
  type ManaSourceItem,
  SERVICE_ORDER_STATUS_LABELS,
  type ServiceOrderStatus,
  SIMULATED_REPORT_TEXT,
  simulatedOrderSchedule,
  simulatedOrderStatusAt,
  VITAL_ORDER,
  VITALS,
  type VitalKind,
} from '@adaxai/contracts'
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { can } from '../../auth/permissions.ts'
import { appointments, departments, encounters, observations, patientDocuments, patients, serviceOrders, users, visits, visitStatusEvents } from '../../db/schema.ts'
import { getPatientOr404 } from '../../patients/service.ts'
import { advanceSimulatedOrders } from '../../service-orders/service.ts'
import { looksLikeInstruction } from './answer.ts'
import { resolveHandle } from './entities.ts'
import { cap, dayLabel, dayOf, freeText, timeLabel } from './format.ts'
import { type ImagingModality, normService, type PatientRef, type RulesIntent } from './intents.ts'
import { blank } from './plan.ts'
import { band, consentRefusal, hiddenFor, listedPatient, mine, NOT_SHOWN, runTool, scrubberFor, STATUS_WORDS } from './tools.ts'
import type { ManaCtx, ToolFinding } from './types.ts'
import { proposeMedicine } from './actions.ts'

/**
 * The answers to the fixed-rule questions (intents.ts), composed by the server from structured queries: no model plans them, writes them or sees
 * them, so they are there when the model is not (or busy with a consultation draft). Each statement cites the facts it rests on (S1 ...), as a
 * checked model answer does; what was not recorded is said to be not recorded, never "none". The caller's role must hold the permissions each
 * question reads with (the same as the tools'), everything is read for this doctor in this clinic, and a patient's withdrawn consent to AI help
 * with their record stops the read of that record (and hides the free text of their visit in a list), as it does for the model's answers.
 * Simulated service orders are always said to be SIMULATED. Nothing here writes anything.
 */

export interface RulesFact {
  text: string
  /** The patient's handle, never a name. */
  patient: string | null
  items: ManaSourceItem[]
}

export interface RulesAnswer {
  outcome: ManaAnswerBody['outcome']
  notice: string | null
  facts: RulesFact[]
  /** Statements, each citing facts by their index in `facts`. */
  blocks: { text: string; facts: number[] }[]
  findings: ToolFinding[]
  /** Handles of the patients the doctor is asked to choose between. */
  candidates: string[]
  /** Patients whose record was read (their consent is read again before the answer is kept). */
  read: Set<string>
  /** Patients the answer is about. */
  subjects: string[]
  action: ManaActionProposal | null
  /** For the audit and the details: what was read, in counts and categories (no clinical text). */
  detail: string
}

/** What each question reads with: the permissions of the platform's own matrix that the caller's role must all hold (the tools' own). */
const NEEDS: Record<RulesIntent['kind'], readonly Parameters<typeof can>[1][]> = {
  next_patient: ['queue:read'],
  seen_today: ['queue:read', 'appointments:read'],
  waiting_longest: ['queue:read'],
  arrival_time: ['patients:read', 'queue:read'],
  nurse_triage: ['patients:read', 'queue:read'],
  orders: ['patients:read', 'orders:read'],
  imaging: ['patients:read'],
  allergies: ['patients:read', 'encounters:read'],
  add_medicine: ['patients:read', 'encounters:write'],
}

class Composer {
  facts: RulesFact[] = []
  blocks: { text: string; facts: number[] }[] = []
  findings: ToolFinding[] = []
  candidates: string[] = []
  read = new Set<string>()
  subjects = new Set<string>()
  outcome: ManaAnswerBody['outcome'] = 'answered'
  notice: string | null = null
  action: ManaActionProposal | null = null
  detail = ''

  fact(text: string, patient: string | null, items: ManaSourceItem[]): number {
    this.facts.push({ text: cap(text, 1200), patient, items: items.slice(0, 6) })
    return this.facts.length - 1
  }
  say(text: string, ...facts: number[]): void {
    this.blocks.push({ text: cap(text, 1500), facts })
  }
  absent(text: string, items: ManaSourceItem[] = []): void {
    this.findings.push({ kind: 'absent', text, items })
  }
  end(outcome: ManaAnswerBody['outcome'], notice: string | null): this {
    this.outcome = outcome
    this.notice = notice
    return this
  }
  done(): RulesAnswer {
    if (this.outcome === 'answered' && !this.blocks.length && !this.action) {
      this.outcome = 'not_established'
      this.notice ??= MANA_NOT_ESTABLISHED
    }
    return { outcome: this.outcome, notice: this.notice, facts: this.facts, blocks: this.blocks, findings: this.findings, candidates: this.candidates, read: this.read, subjects: [...this.subjects], action: this.action, detail: this.detail }
  }
}

const WHICH_PATIENT = 'Which patient do you mean? Ask from the patient’s consultation or page, or say the patient’s name.'

// --- small words -------------------------------------------------------------------------------------------------------------------------

/** A time today ("9:05 am"), or a day and a time ("2 Oct 2026 at 9:05 am"). */
const at = (ctx: ManaCtx, d: Date | string): string => (dayOf(new Date(d), ctx.timeZone) === ctx.today ? timeLabel(d, ctx.timeZone) : `${dayLabel(new Date(d), ctx.timeZone)} at ${timeLabel(d, ctx.timeZone)}`)
const waited = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const person = (name: string | null, role: string | null): string => (!name ? 'someone whose name is not recorded' : role && !name.toLowerCase().includes(role.toLowerCase()) ? `${name} (${role})` : name)
/** Record text as a quotation: one line, bounded, the patient's own identifiers replaced; text that reads like an instruction to an AI system is not repeated. */
const quote = (s: string, n: number, scrub: (t: string) => string): string => (looksLikeInstruction(s) ? '(not repeated here: it reads like an instruction to an AI system; read it in the record)' : `“${freeText(s, n, scrub)}”`)

const patientItem = (patientId: string, label: string, excerpt: string, status: string | null = null, date: string | null = null): ManaSourceItem => ({ kind: 'operational', label, date, status, excerpt: cap(excerpt, 400), link: { to: 'patient', id: patientId } })

// --- who the question is about -----------------------------------------------------------------------------------------------------------

type Resolved = { kind: 'one'; patientId: string; alias: string } | { kind: 'stop' }

/**
 * The patient a question is about, or an answer that stops it: "which patient?" (nobody is in scope), the patients to choose between (a name that fits
 * several, several check-ins in the window), or "not found". Patients shown to choose between are on the audit log like any patient a list shows.
 */
async function resolveWho(ctx: ManaCtx, who: PatientRef, c: Composer): Promise<Resolved> {
  if (who.by === 'none' || (who.by === 'current' && !ctx.scope.patientId)) {
    c.end('clarify', WHICH_PATIENT)
    return { kind: 'stop' }
  }
  if (who.by === 'arrived') return arrivedPatient(ctx, who.minutes, c)
  const h = await resolveHandle(ctx, who.by === 'current' ? 'current' : who.by === 'alias' ? who.alias : `name:${who.name}`)
  if (h.kind === 'one') return h
  if (h.kind === 'ambiguous') {
    h.candidates.forEach((x) => ctx.disclosed.add(x.patientId))
    c.candidates = h.candidates.map((x) => x.alias)
    c.end('ambiguous', 'I found multiple matching patients. Please select one.')
    return { kind: 'stop' }
  }
  c.absent(h.reason)
  c.end('not_established', MANA_NOT_ESTABLISHED)
  return { kind: 'stop' }
}

/** "The patient who arrived an hour ago": today's check-ins of the doctor's queue in that window (with the same slack as the check-ins tool). */
async function arrivedPatient(ctx: ManaCtx, minutes: number, c: Composer): Promise<Resolved> {
  const slack = Math.max(15, Math.round(minutes / 4))
  const from = new Date(ctx.now.getTime() - (minutes + slack) * 60_000)
  const to = new Date(ctx.now.getTime() - Math.max(0, minutes - slack) * 60_000)
  const rows = await ctx.db
    .select({ id: visits.patientId, at: visits.checkedInAt })
    .from(visits)
    .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.visitDate, ctx.today), gte(visits.checkedInAt, from), lt(visits.checkedInAt, to), mine(ctx)!))
    .orderBy(desc(visits.checkedInAt))
    .limit(6)
  const ids = [...new Set(rows.map((r) => r.id))]
  const window = `between ${timeLabel(from, ctx.timeZone)} and ${timeLabel(to, ctx.timeZone)}`
  if (ids.length === 1) return { kind: 'one', patientId: ids[0]!, alias: ctx.book.aliasFor(ids[0]!) }
  if (!ids.length) {
    c.absent(`Nobody in your queue checked in ${window} today.`)
    c.end('not_established', MANA_NOT_ESTABLISHED)
    return { kind: 'stop' }
  }
  ids.forEach((id) => ctx.disclosed.add(id))
  c.candidates = ids.slice(0, 5).map((id) => ctx.book.aliasFor(id))
  c.end('ambiguous', `${ids.length} patients in your queue checked in ${window}. Which one do you mean?`)
  return { kind: 'stop' }
}

/** The patient's record may be read for Mana (their consent to AI help), or the refusal is the answer. */
async function mayRead(ctx: ManaCtx, who: { patientId: string; alias: string }, c: Composer): Promise<boolean> {
  const refusal = await consentRefusal(ctx, ctx.db, who.patientId)
  if (refusal) {
    c.end('refused', refusal)
    return false
  }
  ctx.disclosed.add(who.patientId)
  c.read.add(who.patientId)
  c.subjects.add(who.patientId)
  return true
}

// --- the queue --------------------------------------------------------------------------------------------------------------------------

const OPEN_FOR_DOCTOR = ['ready', 'waiting', 'in_triage'] as const

const queueSelect = (ctx: ManaCtx) =>
  ctx.db
    .select({ v: visits, p: listedPatient, dept: departments.name, apptAt: appointments.scheduledAt })
    .from(visits)
    .innerJoin(patients, eq(patients.id, visits.patientId))
    .innerJoin(departments, eq(departments.id, visits.departmentId))
    .leftJoin(appointments, eq(appointments.visitId, visits.id))

type QueueRow = Awaited<ReturnType<ReturnType<typeof queueSelect>['where']>>[number]

/** One visit of the queue as a fact: the handle, age band, token, department, state, times, urgency and (consent allowing) the reason. */
function visitFact(ctx: ManaCtx, c: Composer, r: QueueRow, hidden: Set<string>): number {
  const alias = ctx.book.aliasFor(r.p.id)
  ctx.disclosed.add(r.p.id)
  const state = STATUS_WORDS[r.v.status] ?? r.v.status
  const since = r.v.status === 'ready' ? ` since ${at(ctx, r.v.statusChangedAt)}` : ''
  if (!hidden.has(r.p.id) && r.v.chiefComplaint) ctx.textShown.add(r.p.id)
  const reason = hidden.has(r.p.id) ? NOT_SHOWN : r.v.chiefComplaint ? `; reason ${quote(r.v.chiefComplaint, 140, scrubberFor(r.p))}` : '; no reason recorded'
  const text = `${alias} (${band(String(r.p.dob), r.p.sex, ctx.today)}), token ${r.v.tokenNumber}, ${r.dept}: ${state}${since}, checked in at ${at(ctx, r.v.checkedInAt)}${r.apptAt ? `, appointment at ${at(ctx, r.apptAt)}` : ''}${r.v.priority === 'urgent' ? ', urgent' : ''}${reason}.`
  return c.fact(text, alias, [patientItem(r.p.id, `Queue · token ${r.v.tokenNumber} · ${dayLabel(r.v.visitDate, ctx.timeZone)}`, text, state, r.v.visitDate)])
}

/**
 * Who is next for this doctor: today's visits that are the doctor's ("mine" as the queue page means it: assigned to the doctor, or unassigned in the
 * doctor's department) and waiting for a doctor. Ready before waiting or in triage; urgent first; then by appointment time when the visit has one, else
 * by check-in time. A visit already with a doctor is never "next".
 */
async function nextPatient(ctx: ManaCtx, c: Composer): Promise<void> {
  const rows = await queueSelect(ctx)
    .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.visitDate, ctx.today), inArray(visits.status, [...OPEN_FOR_DOCTOR]), mine(ctx)!))
    .limit(200)
  const rank = (r: QueueRow) => [r.v.status === 'ready' ? 0 : 1, r.v.priority === 'urgent' ? 0 : 1, (r.apptAt ?? r.v.checkedInAt).getTime()] as const
  rows.sort((a, b) => {
    const x = rank(a)
    const y = rank(b)
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.v.tokenNumber - b.v.tokenNumber
  })
  const ready = rows.filter((r) => r.v.status === 'ready').length
  const header = c.fact(`Your queue today (${dayLabel(ctx.today, ctx.timeZone)}): ${plural(ready, 'visit')} ready for the doctor, ${rows.length - ready} waiting or in triage.`, null, [
    { kind: 'operational', label: `Your queue · ${dayLabel(ctx.today, ctx.timeZone)}`, date: ctx.today, status: null, excerpt: `${ready} ready, ${rows.length - ready} waiting or in triage`, link: null },
  ])
  c.detail = `${rows.length} open visit(s) of yours today`
  if (!rows.length) {
    c.say('Nobody in your queue is waiting for you right now: none of your visits today is ready, waiting or in triage.', header)
    return
  }
  const hidden = await hiddenFor(ctx, rows.slice(0, 3).map((r) => r.p.id))
  const facts = rows.slice(0, 3).map((r) => visitFact(ctx, c, r, hidden))
  const top = rows[0]!
  const alias = ctx.book.aliasFor(top.p.id)
  c.subjects.add(top.p.id)
  const state = top.v.status === 'ready' ? `ready for you since ${at(ctx, top.v.statusChangedAt)}` : (STATUS_WORDS[top.v.status] ?? top.v.status)
  c.say(`Your next patient is ${alias}: ${state}${top.v.priority === 'urgent' ? ', marked urgent' : ''}; checked in at ${at(ctx, top.v.checkedInAt)} (token ${top.v.tokenNumber})${top.apptAt ? `; appointment at ${at(ctx, top.apptAt)}` : ''}.`, facts[0]!, header)
  if (rows.length > 1) {
    const after = rows.slice(1, 3).map((r) => `${ctx.book.aliasFor(r.p.id)} (${STATUS_WORDS[r.v.status] ?? r.v.status})`)
    c.say(`After that: ${after.join(', then ')}${rows.length > 3 ? `, and ${plural(rows.length - 3, 'more')}` : ''}.`, ...facts.slice(1))
  }
}

/** The doctor's own appointments today that have no visit yet ("mine" as the appointments page means it), on the clinic's calendar day. */
function myAppointmentsToday(ctx: ManaCtx): SQL {
  const me = ctx.me
  const own = me.departmentId ? or(eq(appointments.doctorId, me.id), and(isNull(appointments.doctorId), eq(appointments.departmentId, me.departmentId))) : eq(appointments.doctorId, me.id)
  return and(
    eq(appointments.facilityId, me.facilityId),
    gte(appointments.scheduledAt, sql`(${ctx.today}::date)::timestamp at time zone ${ctx.timeZone}`),
    lt(appointments.scheduledAt, sql`((${ctx.today}::date + 1))::timestamp at time zone ${ctx.timeZone}`),
    ne(appointments.status, 'rescheduled'),
    isNull(appointments.visitId),
    own!,
  )!
}

/**
 * How many patients the doctor has seen today, counted as Home counts them (contracts doctorDay: `doctorQueueStatus` and `countDoctorQueue` over the
 * doctor's own visits of today, and the doctor's booked appointments of today that have no visit yet): seen = visits completed.
 */
async function seenToday(ctx: ManaCtx, c: Composer): Promise<void> {
  const v = await ctx.db
    .select({ status: visits.status, enc: encounters.status })
    .from(visits)
    .leftJoin(encounters, and(eq(encounters.visitId, visits.id), ne(encounters.status, 'discarded')))
    .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.visitDate, ctx.today), mine(ctx)!))
  const a = await ctx.db.select({ status: appointments.status }).from(appointments).where(myAppointmentsToday(ctx))
  const statuses: DoctorQueueStatus[] = [...v.map((r) => doctorQueueStatus({ visitStatus: r.status, encounterStatus: r.enc })), ...a.map((r) => doctorQueueStatus({ appointmentStatus: r.status }))]
  const n = countDoctorQueue(statuses)
  const day = dayLabel(ctx.today, ctx.timeZone)
  const text = `Your patients today (${day}), counted as on Home: ${n.seen} seen (visit completed), ${n.waiting} waiting, ${n.inConsultation} in consultation, ${n.yetToSee} yet to see (booked, not checked in); ${n.total} in all.`
  const f = c.fact(text, null, [{ kind: 'operational', label: `Your day · ${day}`, date: ctx.today, status: null, excerpt: text, link: null }])
  c.detail = `${n.total} row(s) of your day counted`
  c.say(`You have seen ${plural(n.seen, 'patient')} today.`, f)
  c.say(`Still today: ${n.waiting} waiting, ${n.inConsultation} in consultation, ${n.yetToSee} yet to see.`, f)
}

/** Who has waited longest since checking in (today's visits waiting for a doctor: waiting, in triage or ready); the doctor's own when they say so. */
async function waitingLongest(ctx: ManaCtx, c: Composer, own: boolean): Promise<void> {
  const rows = await queueSelect(ctx)
    .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.visitDate, ctx.today), inArray(visits.status, [...OPEN_FOR_DOCTOR]), ...(own ? [mine(ctx)!] : [])))
    .orderBy(asc(visits.checkedInAt), asc(visits.tokenNumber))
    .limit(4)
  const whose = own ? 'your queue' : 'the clinic’s queue'
  c.detail = `${rows.length} waiting visit(s) read (${own ? 'mine' : 'clinic'})`
  if (!rows.length) {
    const f = c.fact(`Nobody in ${whose} is waiting today (${dayLabel(ctx.today, ctx.timeZone)}): no visit is waiting, in triage or ready.`, null, [{ kind: 'operational', label: `Queue · ${dayLabel(ctx.today, ctx.timeZone)}`, date: ctx.today, status: null, excerpt: 'No visit waiting', link: null }])
    c.say(`Nobody in ${whose} is waiting right now.`, f)
    return
  }
  const hidden = await hiddenFor(ctx, rows.map((r) => r.p.id))
  const facts = rows.map((r) => visitFact(ctx, c, r, hidden))
  const top = rows[0]!
  c.subjects.add(top.p.id)
  c.say(`${ctx.book.aliasFor(top.p.id)} has been waiting longest in ${whose}: checked in at ${at(ctx, top.v.checkedInAt)}, ${waited(ctx.now.getTime() - top.v.checkedInAt.getTime())} ago (now ${STATUS_WORDS[top.v.status] ?? top.v.status}).`, facts[0]!)
  if (rows.length > 1) c.say(`Next longest: ${rows.slice(1).map((r) => `${ctx.book.aliasFor(r.p.id)} (${waited(ctx.now.getTime() - r.v.checkedInAt.getTime())})`).join(', ')}.`, ...facts.slice(1))
}

/** When a patient arrived today: the check-in time of today's visit, and the appointment time when the visit has one. */
async function arrivalTime(ctx: ManaCtx, c: Composer, who: PatientRef): Promise<void> {
  const p = await resolveWho(ctx, who, c)
  if (p.kind !== 'one') return
  ctx.disclosed.add(p.patientId)
  c.subjects.add(p.patientId)
  const [v] = await queueSelect(ctx)
    .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.patientId, p.patientId), eq(visits.visitDate, ctx.today)))
    .orderBy(desc(visits.checkedInAt))
    .limit(1)
  c.detail = v ? 'a visit today' : 'no visit today'
  if (v) {
    const text = `${p.alias} checked in at ${at(ctx, v.v.checkedInAt)} today (token ${v.v.tokenNumber}, ${v.dept}${v.apptAt ? `; appointment at ${at(ctx, v.apptAt)}` : ''}); now ${STATUS_WORDS[v.v.status] ?? v.v.status}.`
    const f = c.fact(text, p.alias, [patientItem(p.patientId, `Visit · token ${v.v.tokenNumber} · ${dayLabel(v.v.visitDate, ctx.timeZone)}`, text, STATUS_WORDS[v.v.status] ?? v.v.status, v.v.visitDate)])
    c.say(`${p.alias} arrived (checked in) at ${at(ctx, v.v.checkedInAt)} today.`, f)
    if (v.apptAt) c.say(`${p.alias}’s appointment was at ${at(ctx, v.apptAt)}.`, f)
    return
  }
  const [appt] = await ctx.db
    .select({ at: appointments.scheduledAt, status: appointments.status })
    .from(appointments)
    .where(
      and(
        eq(appointments.facilityId, ctx.me.facilityId),
        eq(appointments.patientId, p.patientId),
        gte(appointments.scheduledAt, sql`(${ctx.today}::date)::timestamp at time zone ${ctx.timeZone}`),
        lt(appointments.scheduledAt, sql`((${ctx.today}::date + 1))::timestamp at time zone ${ctx.timeZone}`),
        inArray(appointments.status, ['booked']),
      ),
    )
    .orderBy(asc(appointments.scheduledAt))
    .limit(1)
  const [last] = await ctx.db
    .select({ at: visits.checkedInAt })
    .from(visits)
    .where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.patientId, p.patientId)))
    .orderBy(desc(visits.checkedInAt))
    .limit(1)
  const text = `${p.alias} has no check-in today (${dayLabel(ctx.today, ctx.timeZone)})${appt ? `; an appointment is booked at ${at(ctx, appt.at)} today` : ''}${last ? `; the last check-in on record was on ${dayLabel(last.at, ctx.timeZone)} at ${timeLabel(last.at, ctx.timeZone)}` : '; no earlier check-in is recorded'}.`
  const f = c.fact(text, p.alias, [patientItem(p.patientId, `Visits · ${dayLabel(ctx.today, ctx.timeZone)}`, text)])
  c.say(`${p.alias} has not checked in today.`, f)
  if (appt) c.say(`${p.alias} has an appointment at ${at(ctx, appt.at)} today.`, f)
  if (last) c.say(`The last check-in on record was on ${dayLabel(last.at, ctx.timeZone)} at ${timeLabel(last.at, ctx.timeZone)}.`, f)
}

// --- one patient's visit and record ---------------------------------------------------------------------------------------------------------

/**
 * What the nurse recorded at triage for the patient's visit (the consultation's visit when the question is asked in it, else today's): the reason at
 * check-in, the priority, the vital signs staff measured (with the time and who), the triage note (who and when; "No triage note is recorded" when
 * there is none), and how the visit moved (who and when). Device and simulated readings are not staff measurements and are not listed.
 */
async function nurseTriage(ctx: ManaCtx, c: Composer, who: PatientRef): Promise<void> {
  const p = await resolveWho(ctx, who, c)
  if (p.kind !== 'one' || !(await mayRead(ctx, p, c))) return
  const scrub = scrubberFor(await getPatientOr404(ctx.db, ctx.me.facilityId, p.patientId))
  let visitId: string | null = null
  if (ctx.scope.encounterId && ctx.scope.patientId === p.patientId) {
    const [e] = await ctx.db.select({ visitId: encounters.visitId }).from(encounters).where(and(eq(encounters.id, ctx.scope.encounterId), eq(encounters.facilityId, ctx.me.facilityId)))
    visitId = e?.visitId ?? null
  }
  if (!visitId) {
    const [v] = await ctx.db.select({ id: visits.id }).from(visits).where(and(eq(visits.facilityId, ctx.me.facilityId), eq(visits.patientId, p.patientId), eq(visits.visitDate, ctx.today))).orderBy(desc(visits.checkedInAt)).limit(1)
    visitId = v?.id ?? null
  }
  if (!visitId) {
    c.detail = 'no visit'
    c.absent(`No visit of ${p.alias} today is recorded, so there is no triage to report.`)
    c.end('not_established', MANA_NOT_ESTABLISHED)
    return
  }
  const [row] = await ctx.db
    .select({ v: visits, dept: departments.name, byName: users.fullName, byRole: users.role })
    .from(visits)
    .innerJoin(departments, eq(departments.id, visits.departmentId))
    .leftJoin(users, eq(users.id, visits.createdBy))
    .where(and(eq(visits.id, visitId), eq(visits.facilityId, ctx.me.facilityId)))
  if (!row) {
    c.end('not_established', MANA_NOT_ESTABLISHED)
    return
  }
  const v = row.v
  const day = dayLabel(v.visitDate, ctx.timeZone)
  const item = (excerpt: string, status: string | null = null): ManaSourceItem => ({ kind: 'operational', label: `Triage · token ${v.tokenNumber} · ${day}`, date: v.visitDate, status, excerpt: cap(excerpt, 400), link: { to: 'patient', id: p.patientId } })

  if (v.chiefComplaint) ctx.textShown.add(p.patientId)
  const reasonText = v.chiefComplaint ? `Reason at check-in: ${quote(v.chiefComplaint, 200, scrub)} (checked in at ${at(ctx, v.checkedInAt)} by ${person(row.byName, row.byRole)}).` : `No reason was recorded at check-in (checked in at ${at(ctx, v.checkedInAt)} by ${person(row.byName, row.byRole)}).`
  const fReason = c.fact(reasonText, p.alias, [item(reasonText)])
  c.say(reasonText, fReason)
  const priorityText = `Priority: ${v.priority === 'urgent' ? 'urgent' : 'normal'}.`
  c.say(priorityText, c.fact(`${p.alias}’s visit of ${day}: priority ${v.priority}.`, p.alias, [item(priorityText)]))

  const obs = await ctx.db
    .select({ o: observations, byName: users.fullName, byRole: users.role })
    .from(observations)
    .leftJoin(users, eq(users.id, observations.recordedBy))
    .where(and(eq(observations.visitId, v.id), eq(observations.enteredInError, false), eq(observations.source, 'manual'), eq(observations.validationStatus, 'manual_entry')))
    .orderBy(asc(observations.measuredAt))
    .limit(30)
  // Readings taken together are listed in the record's usual order (temperature, heart rate, ...).
  obs.sort((x, y) => x.o.measuredAt.getTime() - y.o.measuredAt.getTime() || VITAL_ORDER.indexOf(x.o.kind as VitalKind) - VITAL_ORDER.indexOf(y.o.kind as VitalKind))
  if (obs.length) {
    const parts = obs.map(({ o, byName, byRole }) => {
      const d = VITALS[o.kind as VitalKind]
      return `${d?.label ?? o.kind} ${Number(o.value).toFixed(d?.decimals ?? 1)} ${d?.unit ?? o.unit} at ${at(ctx, o.measuredAt)} by ${person(byName, byRole)}`
    })
    const text = `Vital signs measured by staff for this visit: ${parts.join('; ')}.`
    const f = c.fact(text, p.alias, obs.slice(0, 6).map(({ o }) => ({ kind: 'vital' as const, label: `${VITALS[o.kind as VitalKind]?.label ?? o.kind} · ${dayLabel(o.measuredAt, ctx.timeZone)}`, date: o.measuredAt.toISOString(), status: 'Measured by staff', excerpt: `${Number(o.value)} ${o.unit}`, link: { to: 'patient' as const, id: p.patientId } })))
    c.say(text, f)
  } else {
    c.say('No vital signs measured by staff are recorded for this visit.', c.fact(`No staff-measured vital signs are recorded for ${p.alias}’s visit of ${day}.`, p.alias, [item('No staff-measured vital signs')]))
  }

  if (v.triageNote) {
    const [author] = v.triageNoteBy ? await ctx.db.select({ name: users.fullName, role: users.role }).from(users).where(eq(users.id, v.triageNoteBy)) : []
    ctx.textShown.add(p.patientId)
    const text = `Triage note by ${person(author?.name ?? null, author?.role ?? null)}${v.triageNoteAt ? ` at ${at(ctx, v.triageNoteAt)}` : ''}: ${quote(v.triageNote, 1000, scrub)}`
    c.say(text, c.fact(text, p.alias, [item(text, 'Triage note')]))
  } else {
    c.say('No triage note is recorded.', c.fact(`No triage note is recorded for ${p.alias}’s visit of ${day}.`, p.alias, [item('No triage note is recorded.')]))
  }

  const events = await ctx.db
    .select({ e: visitStatusEvents, byName: users.fullName, byRole: users.role })
    .from(visitStatusEvents)
    .leftJoin(users, eq(users.id, visitStatusEvents.actorUserId))
    .where(eq(visitStatusEvents.visitId, v.id))
    .orderBy(asc(visitStatusEvents.id))
    .limit(20)
  if (events.length) {
    const steps = events.map(({ e, byName, byRole }) => `${e.fromStatus ? (STATUS_WORDS[e.toStatus] ?? e.toStatus) : `checked in (${STATUS_WORDS[e.toStatus] ?? e.toStatus})`} at ${at(ctx, e.changedAt)}${byName ? ` by ${person(byName, byRole)}` : ''}`)
    const text = `How the visit moved: ${steps.join('; ')}.`
    c.say(text, c.fact(text, p.alias, [item(text, STATUS_WORDS[v.status] ?? v.status)]))
  }
  c.detail = `visit read: ${obs.length} staff reading(s), note ${v.triageNote ? 'present' : 'absent'}, ${events.length} status event(s)`
}

// --- service orders ------------------------------------------------------------------------------------------------------------------------

type OrderRow = typeof serviceOrders.$inferSelect

/**
 * The simulated laboratory's due steps for a patient's orders, applied by the orders service's own function before they are read (as every read of
 * orders does: the steps are stored once, at the times the schedule gives), so that Mana says what the consultation screen says. Returns the steps applied.
 */
const advanceOrders = (ctx: ManaCtx, patientId: string): Promise<number> => ctx.db.transaction((tx) => advanceSimulatedOrders(tx, { patientId }, ctx.now, ctx.settings.serviceOrders.inProgressAfterMinutes))

/** Where an order stands now: the stored status, moved on by the simulated laboratory's fixed schedule exactly as the orders service moves it (contracts serviceOrders). */
function standing(ctx: ManaCtx, o: OrderRow): { status: ServiceOrderStatus; inProgressAt: Date | null; completedAt: Date | null } {
  const after = ctx.settings.serviceOrders.inProgressAfterMinutes
  if (!o.simulated || !o.turnaroundMinutes) return { status: o.status, inProgressAt: o.status === 'in_progress' ? o.statusChangedAt : null, completedAt: o.completedAt }
  const status = simulatedOrderStatusAt({ status: o.status, requestedAt: o.requestedAt, turnaroundMinutes: o.turnaroundMinutes }, ctx.now, after)
  const s = simulatedOrderSchedule({ requestedAt: o.requestedAt, turnaroundMinutes: o.turnaroundMinutes }, after)
  return { status, inProgressAt: status === 'requested' ? null : o.status === 'in_progress' ? o.statusChangedAt : s.inProgressAt, completedAt: status === 'completed' ? (o.completedAt ?? s.completedAt) : null }
}

/** Who carries the order out, in words that follow "the": always SIMULATED for the simulated provider. */
const provider = (o: OrderRow): string => (o.simulated ? (o.category === 'lab' ? 'SIMULATED lab' : o.category === 'imaging' ? 'SIMULATED imaging service' : 'SIMULATED service') : 'provider')

/** The same comparison the question's words were read with (intents.ts). */
const norm = normService
const SERVICE_NOISE = /\b(?:the|a|an|my|her|his|their|latest|last|recent|new|report|reports|result|results|request|requests|order|orders|test|tests)\b/g
type ServiceMatch = { kind: 'all' } | { kind: 'category'; category: 'lab' | 'imaging'; label: string } | { kind: 'text'; text: string }

function serviceMatch(text: string | null): ServiceMatch {
  const t = norm(text ?? '').replace(SERVICE_NOISE, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return { kind: 'all' }
  if (/^(?:lab|labs|laboratory|blood|blood work|bloods|investigations?|lab work)$/.test(t)) return { kind: 'category', category: 'lab', label: 'laboratory' }
  if (/^(?:imaging|scan|scans|radiology)$/.test(t)) return { kind: 'category', category: 'imaging', label: 'imaging' }
  // "The CT scan", "the chest X-ray study", "the lab TSH": the service is named by the other words ("scan", "lab" are not words of its name).
  const named = t
    .replace(/\b(?:scan|scans|study|studies|lab|labs|laboratory|imaging|radiology|investigations?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { kind: 'text', text: named || t }
}
/** Whether an order (or a catalogue entry) is the service the doctor named: its code, or every word the doctor gave as a word of its name. */
const fits = (m: ServiceMatch, s: { serviceCode?: string; code?: string; serviceName?: string; name?: string; category: string }): boolean => {
  if (m.kind === 'all') return true
  if (m.kind === 'category') return s.category === m.category
  const code = norm(s.serviceCode ?? s.code ?? '')
  const name = ` ${norm(s.serviceName ?? s.name ?? '')} `
  return code === m.text || m.text.split(' ').every((w) => name.includes(` ${w} `) || name.includes(`(${w})`) || code === w)
}

function orderSentence(ctx: ManaCtx, o: OrderRow, ask: 'ready' | 'received' | 'pending'): string {
  const s = standing(ctx, o)
  const name = o.serviceName
  const who = provider(o)
  const placed = at(ctx, o.requestedAt)
  if (s.status === 'cancelled') return `The ${name} order at the ${who} was cancelled at ${at(ctx, o.cancelledAt ?? o.statusChangedAt)}; there is no report.`
  if (s.status === 'completed') {
    const report = o.reportText ?? (o.simulated ? SIMULATED_REPORT_TEXT[o.category as keyof typeof SIMULATED_REPORT_TEXT] : null)
    const said = report ? ` Its report says: “${cap(report, 300)}”` : ' No report text is recorded.'
    return ask === 'received' ? `Yes: the ${who} received the ${name} request, and the order is completed (at ${at(ctx, s.completedAt ?? o.statusChangedAt)}).${said}` : `The ${name} order is completed by the ${who} (at ${at(ctx, s.completedAt ?? o.statusChangedAt)}).${said}`
  }
  if (s.status === 'in_progress') {
    const since = s.inProgressAt ? ` since ${at(ctx, s.inProgressAt)}` : ''
    return ask === 'received' ? `Yes: the ${who} received the ${name} request${since}; it is in progress.` : ask === 'ready' ? `The ${name} report is not ready yet: the ${who} received the request${since} and it is in progress.` : `${name}: in progress at the ${who}${since} (requested at ${placed}).`
  }
  return ask === 'received' ? `Not yet: the ${name} request was placed at ${placed} and the ${who} has not received it yet.` : ask === 'ready' ? `The ${name} report is not ready yet: the request was placed at ${placed} and the ${who} has not received it yet.` : `${name}: requested at ${placed}, not yet received by the ${who}.`
}

function orderFact(ctx: ManaCtx, c: Composer, o: OrderRow, alias: string, ask: 'ready' | 'received' | 'pending'): number {
  const s = standing(ctx, o)
  const text = `${alias}: ${orderSentence(ctx, o, ask)}`
  return c.fact(text, alias, [
    {
      kind: o.category === 'lab' ? 'investigation' : 'operational',
      label: `Service order · ${o.serviceName} · ${dayLabel(o.requestedAt, ctx.timeZone)}`,
      date: o.requestedAt.toISOString(),
      status: `${SERVICE_ORDER_STATUS_LABELS[s.status]}${o.simulated ? ' · SIMULATED' : ''}`,
      excerpt: cap(text, 400),
      link: { to: 'encounter', id: o.encounterId },
    },
  ])
}

/**
 * Where a patient's service orders stand ("is the lab report ready?", "did the lab receive the CBC request?", "which orders are pending?"). An order that was
 * never placed is said to be not placed, which is not the same as "not ready yet". Without a patient in the question or in scope, "which orders are pending"
 * is about the orders this doctor placed.
 */
async function ordersStatus(ctx: ManaCtx, c: Composer, intent: Extract<RulesIntent, { kind: 'orders' }>): Promise<void> {
  const who: PatientRef = intent.who.by === 'none' && ctx.scope.patientId ? { by: 'current' } : intent.who
  if (who.by === 'none' && intent.ask === 'pending') return myPendingOrders(ctx, c)
  const p = await resolveWho(ctx, who, c)
  if (p.kind !== 'one' || !(await mayRead(ctx, p, c))) return
  const advanced = await advanceOrders(ctx, p.patientId)
  const rows = await ctx.db
    .select()
    .from(serviceOrders)
    .where(and(eq(serviceOrders.facilityId, ctx.me.facilityId), eq(serviceOrders.patientId, p.patientId)))
    .orderBy(desc(serviceOrders.requestedAt))
    .limit(30)
  const m = serviceMatch(intent.service)
  const matched = rows.filter((o) => fits(m, o))
  c.detail = `${rows.length} order(s) read, ${matched.length} matching, ${advanced} simulated step(s) applied`
  const listItem = patientItem(p.patientId, `Service orders · ${dayLabel(ctx.today, ctx.timeZone)}`, `${rows.length} order(s) on record`)
  if (!rows.length) {
    c.say(`No service order was placed for ${p.alias}.`, c.fact(`No service order is recorded for ${p.alias}.`, p.alias, [listItem]))
    return
  }
  if (intent.ask === 'pending') {
    const open = matched.filter((o) => ['requested', 'in_progress'].includes(standing(ctx, o).status))
    const done = matched.filter((o) => standing(ctx, o).status === 'completed').length
    const cancelled = matched.filter((o) => standing(ctx, o).status === 'cancelled').length
    const others = `${done} completed, ${cancelled} cancelled`
    if (!open.length) {
      c.say(`No orders are pending for ${p.alias} (${others}).`, c.fact(`${p.alias}: no open service order; ${others}.`, p.alias, [listItem]))
      return
    }
    const facts = open.slice(0, 8).map((o) => orderFact(ctx, c, o, p.alias, 'pending'))
    c.say(`${plural(open.length, 'order')} pending for ${p.alias}: ${open.slice(0, 8).map((o) => orderSentence(ctx, o, 'pending').replace(/\.$/, '')).join('; ')}.`, ...facts)
    if (done + cancelled) c.say(`Also on record: ${others}.`, c.fact(`${p.alias}: ${others} service order(s).`, p.alias, [listItem]))
    return
  }
  if (!matched.length) {
    const named = m.kind === 'text' ? ctx.settings.serviceOrders.catalogue.find((e) => fits(m, e))?.name : null
    const what = m.kind === 'text' ? (named ?? `“${cap(intent.service ?? '', 60)}”`) : m.kind === 'category' ? `a ${m.label} service` : 'any service'
    c.say(`No order for ${what} was placed for ${p.alias}.`, c.fact(`${p.alias}: no service order for ${what} is recorded (${plural(rows.length, 'other order')} on record).`, p.alias, [listItem]))
    return
  }
  // The newest order of that service first; older ones of it are listed after.
  const facts = matched.slice(0, 3).map((o) => orderFact(ctx, c, o, p.alias, intent.ask))
  c.say(orderSentence(ctx, matched[0]!, intent.ask), facts[0]!)
  if (matched.length > 1) c.say(`Earlier orders of it: ${matched.slice(1, 3).map((o) => `${o.serviceName} of ${dayLabel(o.requestedAt, ctx.timeZone)} (${SERVICE_ORDER_STATUS_LABELS[standing(ctx, o).status]}${o.simulated ? ', SIMULATED' : ''})`).join('; ')}.`, ...facts.slice(1))
}

/** The open orders this doctor placed (any patient of the clinic), when no patient is named or in scope. */
async function myPendingOrders(ctx: ManaCtx, c: Composer): Promise<void> {
  const myOpenOrders = () =>
    ctx.db
      .select({ o: serviceOrders, p: listedPatient })
      .from(serviceOrders)
      .innerJoin(patients, eq(patients.id, serviceOrders.patientId))
      .where(and(eq(serviceOrders.facilityId, ctx.me.facilityId), eq(serviceOrders.orderedBy, ctx.me.id), inArray(serviceOrders.status, ['requested', 'in_progress'])))
      .orderBy(desc(serviceOrders.requestedAt))
      .limit(40)
  // The due simulated steps first (per patient, as the orders service applies them), then what is still open.
  for (const id of new Set((await myOpenOrders()).map((r) => r.p.id))) await advanceOrders(ctx, id)
  const rows = await myOpenOrders()
  // A patient who withdrew consent to AI help: their orders are not listed (what was ordered for them is their record).
  const hidden = await hiddenFor(ctx, rows.map((r) => r.p.id))
  const open = rows.filter((r) => !hidden.has(r.p.id) && ['requested', 'in_progress'].includes(standing(ctx, r.o).status))
  const header = c.fact(`Service orders you placed that are still open: ${open.length}${hidden.size ? ` (orders of ${plural(hidden.size, 'patient')} whose consent to AI help does not allow it are not listed)` : ''}.`, null, [
    { kind: 'operational', label: 'Your service orders', date: ctx.today, status: null, excerpt: `${open.length} open`, link: null },
  ])
  c.detail = `${rows.length} open order(s) of yours read`
  if (!open.length) {
    c.say('None of the service orders you placed is pending.', header)
    return
  }
  const facts = open.slice(0, 10).map((r) => {
    ctx.disclosed.add(r.p.id)
    c.read.add(r.p.id)
    return orderFact(ctx, c, r.o, ctx.book.aliasFor(r.p.id), 'pending')
  })
  c.say(`${plural(open.length, 'order')} you placed ${open.length === 1 ? 'is' : 'are'} pending: ${open.slice(0, 10).map((r) => `${ctx.book.aliasFor(r.p.id)}, ${orderSentence(ctx, r.o, 'pending').replace(/\.$/, '')}`).join('; ')}.`, header, ...facts)
}

// --- documents ----------------------------------------------------------------------------------------------------------------------------

const MODALITY_WORDS: Record<ImagingModality, string> = { mri: 'MRI', ct: 'CT', xray: 'X-ray', ultrasound: 'ultrasound' }

/**
 * The patient's latest imaging document of that kind (MRI, CT, X-ray, ultrasound) and its report as staff typed it, quoted with its date: nothing reads
 * the file itself, and a document without typed report text is said to have none ("Not recorded").
 */
async function imagingReport(ctx: ManaCtx, c: Composer, who: PatientRef, modality: ImagingModality): Promise<void> {
  const p = await resolveWho(ctx, who, c)
  if (p.kind !== 'one' || !(await mayRead(ctx, p, c))) return
  const scrub = scrubberFor(await getPatientOr404(ctx.db, ctx.me.facilityId, p.patientId))
  const rows = await ctx.db
    .select({ d: patientDocuments, by: users.fullName })
    .from(patientDocuments)
    .leftJoin(users, eq(users.id, patientDocuments.uploadedBy))
    .where(and(eq(patientDocuments.facilityId, ctx.me.facilityId), eq(patientDocuments.patientId, p.patientId), eq(patientDocuments.status, 'recorded'), eq(patientDocuments.modality, modality), inArray(patientDocuments.category, ['imaging_report', 'imaging_image'])))
    .orderBy(sql`${patientDocuments.studyDate} desc nulls last`, desc(patientDocuments.createdAt))
    .limit(5)
  const word = MODALITY_WORDS[modality]
  c.detail = `${rows.length} ${word} document(s) read`
  if (!rows.length) {
    c.say(`No ${word} report or image is on ${p.alias}’s record.`, c.fact(`No ${word} document is recorded for ${p.alias}.`, p.alias, [patientItem(p.patientId, `Documents · ${word}`, `No ${word} document`)]))
    return
  }
  const d = rows[0]!.d
  const when = d.studyDate ? `of ${dayLabel(d.studyDate, ctx.timeZone)}` : `(study date not recorded; added ${dayLabel(d.createdAt, ctx.timeZone)})`
  const item: ManaSourceItem = { kind: 'patient_record', label: `${d.category === 'imaging_report' ? 'Imaging report' : 'Imaging'} · ${cap(d.title, 60)} · ${d.studyDate ? dayLabel(d.studyDate, ctx.timeZone) : dayLabel(d.createdAt, ctx.timeZone)}`, date: d.studyDate ?? d.createdAt.toISOString(), status: 'Recorded', excerpt: cap(d.reportText ?? 'Report text: Not recorded', 400), link: { to: 'patient', id: p.patientId } }
  const head = `The latest ${word} on ${p.alias}’s record is “${freeText(d.title, 160, scrub)}” ${when}, added by ${rows[0]!.by ?? 'staff'} on ${dayLabel(d.createdAt, ctx.timeZone)}.`
  const f = c.fact(head, p.alias, [item])
  c.say(head, f)
  if (d.reportText) {
    ctx.textShown.add(p.patientId)
    const text = `Its report (as typed by staff) reads: ${quote(d.reportText, 1200, scrub)}`
    c.say(text, c.fact(text, p.alias, [item]))
  } else c.say('Report text: Not recorded (only the file was added; nothing reads the file itself).', c.fact(`${p.alias}’s ${word} “${freeText(d.title, 80, scrub)}”: report text not recorded.`, p.alias, [item]))
  if (rows.length > 1) c.say(`Earlier ${word} documents on record: ${rows.slice(1).map((r) => `“${freeText(r.d.title, 80, scrub)}” ${r.d.studyDate ? `of ${dayLabel(r.d.studyDate, ctx.timeZone)}` : `added ${dayLabel(r.d.createdAt, ctx.timeZone)}`}`).join('; ')}.`, f)
}

// --- allergies ----------------------------------------------------------------------------------------------------------------------------

/** The allergies on record, through the record answer's own fixed rules (answers.ts, via the record tool): what is recorded, absent, or in conflict. */
async function allergiesOnRecord(ctx: ManaCtx, c: Composer, who: PatientRef): Promise<void> {
  const p = await resolveWho(ctx, who, c)
  if (p.kind !== 'one') return
  const out = await runTool(ctx, blank('get_patient_record', { patient: p.alias, topic: 'allergies' }))
  c.detail = `record rules: ${out.facts.length} statement(s), ${out.findings.length} finding(s)`
  if (out.status === 'refused') {
    c.end('refused', out.detail)
    return
  }
  if (out.status === 'not_found' || out.status === 'error' || out.status === 'invalid') {
    c.absent(out.status === 'error' ? 'The record could not be read just now. You can try again.' : 'That patient was not found in this clinic.')
    c.end('not_established', MANA_NOT_ESTABLISHED)
    return
  }
  c.read.add(p.patientId)
  c.subjects.add(p.patientId)
  for (const f of out.facts) {
    const i = c.fact(f.text, f.patient, f.items)
    if (!looksLikeInstruction(f.text)) c.say(f.text.replace(/^Allergies:\s*/, ''), i)
  }
  for (const f of out.findings) c.findings.push(f)
}

// --- the entry point -----------------------------------------------------------------------------------------------------------------------

/**
 * Answers a fixed-rule question for this doctor. The caller's role must hold every permission the question reads with (checked first, before anything
 * is read); a record of another clinic is "not found", as everywhere.
 */
export async function answerByRules(ctx: ManaCtx, intent: RulesIntent): Promise<RulesAnswer> {
  const c = new Composer()
  if (NEEDS[intent.kind].some((p) => !can(ctx.me.role, p))) return c.end('refused', 'Your role is not allowed to read that.').done()
  switch (intent.kind) {
    case 'next_patient':
      await nextPatient(ctx, c)
      break
    case 'seen_today':
      await seenToday(ctx, c)
      break
    case 'waiting_longest':
      await waitingLongest(ctx, c, intent.mine)
      break
    case 'arrival_time':
      await arrivalTime(ctx, c, intent.who)
      break
    case 'nurse_triage':
      await nurseTriage(ctx, c, intent.who)
      break
    case 'orders':
      await ordersStatus(ctx, c, intent)
      break
    case 'imaging':
      await imagingReport(ctx, c, intent.who, intent.modality)
      break
    case 'allergies':
      await allergiesOnRecord(ctx, c, intent.who)
      break
    case 'add_medicine': {
      const r = await proposeMedicine(ctx, intent.command)
      c.end(r.outcome, r.notice)
      c.detail = r.detail
      if (r.action) {
        c.action = r.action
        c.say(r.text ?? r.action.summary)
      }
      if (r.patientId) c.subjects.add(r.patientId)
      break
    }
  }
  return c.done()
}
