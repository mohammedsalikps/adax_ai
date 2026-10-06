import {
  compareDoctorQueueRows,
  countDoctorQueue,
  type DoctorDay,
  type DoctorDayCounts,
  type DoctorDayPeriod,
  doctorDayRange,
  type DoctorDayTimelineRow,
  doctorQueueStatus,
  isSignedToComplete,
} from '@adaxai/contracts'
import { and, count, countDistinct, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import type { SessionUser } from '../auth/sessions.ts'
import type { DbOrTx } from '../db/client.ts'
import { allergies, appointments, encounters, facilities, patients, visits } from '../db/schema.ts'
import { notFound } from '../http/errors.ts'
import { fullName } from '../patients/service.ts'
import { mineVisits } from '../visits/service.ts'

/**
 * The doctor's day (Doctor HERO final, DESIGN §3, contracts doctorDay.ts): Home's counts and trend, and today's patients in time order, for the
 * signed-in doctor. Everything is counted in the database on the facility's calendar (its timezone), never on the browser's clock:
 *
 * - "Mine" is the rule of GET /api/visits?mine=true and GET /api/appointments?mine=true: assigned to me, or unassigned in my department.
 * - Today's rows: my visits of today (any status; a visit decides its row) and my appointments of today that are still booked with no visit
 *   ("Yet to see", overdue included). Their status is contracts' doctorQueueStatus; the counts are countDoctorQueue of them, so Home, My
 *   consultations and Mana say the same thing. Cancelled rows (a cancelled or no-show visit) are neither counted nor listed.
 * - The period (Today; Week = Monday to today; Month = the 1st to today) counts: seen = my completed visits; consultations = my consultations
 *   that are not discarded; completed = those whose visit is completed; patients = the different patients of those consultations. A
 *   consultation counts on the facility day of its visit (visits.visit_date, already a facility calendar day). Waiting, in consultation, yet to
 *   see and total are always today's.
 * - The trend has one point per day of the period up to today, each one counted (a day with nothing is a counted 0, never padded, never a
 *   future day).
 */

type Me = Pick<SessionUser, 'id' | 'facilityId' | 'departmentId'>

/** Appointments that are mine: the visits' rule (visits/service.ts mineVisits) on the appointment's own doctor and department. */
export function mineAppointments(me: Pick<SessionUser, 'id' | 'departmentId'>): SQL {
  return me.departmentId ? or(eq(appointments.doctorId, me.id), and(isNull(appointments.doctorId), eq(appointments.departmentId, me.departmentId)))! : eq(appointments.doctorId, me.id)
}

export interface FacilityDay {
  timezone: string
  /** The facility's calendar day at the given instant (YYYY-MM-DD). */
  today: string
}

/** The facility's timezone and its calendar day at `nowMs` (decided by PostgreSQL's timezone database, as the queue's "today" is). */
export async function facilityDayAt(db: DbOrTx, facilityId: string, nowMs: number): Promise<FacilityDay> {
  const at = new Date(nowMs).toISOString()
  const [row] = await db
    .select({ timezone: facilities.timezone, today: sql<string>`(${at}::timestamptz at time zone ${facilities.timezone})::date::text` })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
  if (!row) throw notFound('Facility')
  return row
}

/** Today's rows of the doctor, cancelled ones included (they are dropped from the counts by countDoctorQueue and from the timeline here). */
async function todayRows(db: DbOrTx, me: Me, day: FacilityDay, now: Date): Promise<DoctorDayTimelineRow[]> {
  const tz = day.timezone
  const visitRows = await db
    .select({
      id: visits.id,
      status: visits.status,
      priority: visits.priority,
      reason: visits.chiefComplaint,
      checkedInAt: visits.checkedInAt,
      p: patients,
      apptId: appointments.id,
      apptAt: appointments.scheduledAt,
      apptStatus: appointments.status,
      apptReason: appointments.reason,
      encId: encounters.id,
      encStatus: encounters.status,
      encDoctor: encounters.doctorId,
      // The appointment's time when the visit came from one, else the check-in time, on the facility's clock.
      time: sql<string>`to_char(coalesce(${appointments.scheduledAt}, ${visits.checkedInAt}) at time zone ${tz}, 'HH24:MI')`,
    })
    .from(visits)
    .innerJoin(patients, eq(patients.id, visits.patientId))
    .leftJoin(appointments, eq(appointments.visitId, visits.id))
    // At most one consultation per visit is not discarded (encounters_one_active_per_visit_uq), so this join never repeats a visit.
    .leftJoin(encounters, and(eq(encounters.visitId, visits.id), ne(encounters.status, 'discarded')))
    .where(and(eq(visits.facilityId, me.facilityId), eq(visits.visitDate, day.today), mineVisits(me)))

  const apptRows = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      at: appointments.scheduledAt,
      reason: appointments.reason,
      p: patients,
      time: sql<string>`to_char(${appointments.scheduledAt} at time zone ${tz}, 'HH24:MI')`,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .where(
      and(
        eq(appointments.facilityId, me.facilityId),
        // Booked and not arrived: an appointment that became a visit is that visit's row; a cancelled, no-show or moved one is not counted.
        eq(appointments.status, 'booked'),
        isNull(appointments.visitId),
        // The facility's calendar day, as an interval of instants.
        gte(appointments.scheduledAt, sql`(${day.today}::date)::timestamp at time zone ${tz}`),
        lt(appointments.scheduledAt, sql`(${day.today}::date + 1)::timestamp at time zone ${tz}`),
        mineAppointments(me),
      ),
    )

  const patientIds = [...new Set([...visitRows.map((r) => r.p.id), ...apptRows.map((r) => r.p.id)])]
  const allergyRows = patientIds.length
    ? await db
        .select({ patientId: allergies.patientId, substance: allergies.substance })
        .from(allergies)
        .where(and(inArray(allergies.patientId, patientIds), eq(allergies.status, 'active')))
    : []
  const allergyMap = new Map<string, string[]>()
  for (const a of allergyRows) allergyMap.set(a.patientId, [...(allergyMap.get(a.patientId) ?? []), a.substance])
  const patientOf = (p: typeof patients.$inferSelect): DoctorDayTimelineRow['patient'] => ({
    id: p.id,
    mrn: p.mrn,
    fullName: fullName(p),
    sex: p.sex,
    dateOfBirth: p.dateOfBirth,
    noKnownAllergies: p.noKnownAllergies,
    activeAllergies: allergyMap.get(p.id) ?? [],
  })

  const fromVisits = visitRows.map((r): DoctorDayTimelineRow => {
    const facts = { visitStatus: r.status, encounterStatus: r.encStatus, appointmentStatus: r.apptStatus }
    return {
      key: `visit:${r.id}`,
      status: doctorQueueStatus(facts),
      signedToComplete: isSignedToComplete(facts),
      time: r.time,
      scheduledAt: r.apptAt?.toISOString() ?? null,
      checkedInAt: r.checkedInAt.toISOString(),
      overdue: false,
      priority: r.priority,
      reason: r.reason ?? r.apptReason ?? null,
      patient: patientOf(r.p),
      visitId: r.id,
      visitStatus: r.status,
      encounterId: r.encId ?? null,
      encounterStatus: r.encStatus ?? null,
      encounterMine: !!r.encDoctor && r.encDoctor === me.id,
      appointmentId: r.apptId ?? null,
      appointmentStatus: r.apptStatus ?? null,
    }
  })
  const fromAppointments = apptRows.map(
    (a): DoctorDayTimelineRow => ({
      key: `appointment:${a.id}`,
      status: doctorQueueStatus({ appointmentStatus: a.status }),
      signedToComplete: false,
      time: a.time,
      scheduledAt: a.at.toISOString(),
      checkedInAt: null,
      overdue: a.at.getTime() <= now.getTime(),
      priority: 'normal',
      reason: a.reason ?? null,
      patient: patientOf(a.p),
      visitId: null,
      visitStatus: null,
      encounterId: null,
      encounterStatus: null,
      encounterMine: false,
      appointmentId: a.id,
      appointmentStatus: a.status,
    }),
  )
  return [...fromVisits, ...fromAppointments]
}

interface PeriodTotals {
  seenByDay: Map<string, number>
  consultationsByDay: Map<string, number>
  completed: number
  patients: number
}

/** My completed visits per day, and my consultations (not discarded) per day of their visit, between two facility days (inclusive). */
async function periodTotals(db: DbOrTx, me: Me, from: string, to: string): Promise<PeriodTotals> {
  const seen = await db
    .select({ day: visits.visitDate, n: count() })
    .from(visits)
    .where(and(eq(visits.facilityId, me.facilityId), eq(visits.status, 'completed'), gte(visits.visitDate, from), lte(visits.visitDate, to), mineVisits(me)))
    .groupBy(visits.visitDate)
  const mine = and(eq(encounters.facilityId, me.facilityId), eq(encounters.doctorId, me.id), ne(encounters.status, 'discarded'), gte(visits.visitDate, from), lte(visits.visitDate, to))
  const consultations = await db
    .select({ day: visits.visitDate, n: count(), completed: sql<number>`(count(*) filter (where ${visits.status} = 'completed'))::int` })
    .from(encounters)
    .innerJoin(visits, eq(visits.id, encounters.visitId))
    .where(mine)
    .groupBy(visits.visitDate)
  const [distinct] = await db.select({ n: countDistinct(encounters.patientId) }).from(encounters).innerJoin(visits, eq(visits.id, encounters.visitId)).where(mine)
  return {
    seenByDay: new Map(seen.map((r) => [r.day, Number(r.n)])),
    consultationsByDay: new Map(consultations.map((r) => [r.day, Number(r.n)])),
    completed: consultations.reduce((s, r) => s + Number(r.completed), 0),
    patients: Number(distinct?.n ?? 0),
  }
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + n, 0)

/** The doctor's day for a period, at `nowMs` (the route's clock). */
export async function loadDoctorDay(db: DbOrTx, me: Me, period: DoctorDayPeriod, nowMs: number): Promise<DoctorDay> {
  const now = new Date(nowMs)
  const day = await facilityDayAt(db, me.facilityId, nowMs)
  const range = doctorDayRange(period, day.today)
  const rows = await todayRows(db, me, day, now)
  const today = countDoctorQueue(rows.map((r) => r.status))
  const totals = await periodTotals(db, me, range.from, range.to)
  const counts: DoctorDayCounts = {
    // Today's "seen" is the completed rows of today (the same visits the period query counts for today).
    seen: period === 'today' ? today.seen : sum(totals.seenByDay),
    waiting: today.waiting,
    inConsultation: today.inConsultation,
    yetToSee: today.yetToSee,
    total: today.total,
    consultations: sum(totals.consultationsByDay),
    completed: totals.completed,
    patients: totals.patients,
  }
  return {
    period,
    timezone: day.timezone,
    today: day.today,
    from: range.from,
    to: range.to,
    counts,
    trend: range.days.map((d) => ({ date: d, seen: totals.seenByDay.get(d) ?? 0, consultations: totals.consultationsByDay.get(d) ?? 0 })),
    timeline: rows.filter((r) => r.status !== 'cancelled').sort(compareDoctorQueueRows),
    generatedAt: now.toISOString(),
  }
}
