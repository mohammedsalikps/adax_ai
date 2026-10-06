import { type DoctorDay, DoctorDayQuery } from '@adaxai/contracts'
import type { FastifyInstance } from 'fastify'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { Config } from '../config.ts'
import type { Db } from '../db/client.ts'
import type { RateLimiter } from '../http/rate-limit.ts'
import { parse } from '../http/validate.ts'
import type { AppSettings } from '../settings/schema.ts'
import { loadDoctorDay } from './queries.ts'

export interface DoctorDayRouteDeps {
  db: Db
  config: Config
  settings: AppSettings
  limiter: RateLimiter
  /** The clock "now" is read from (tests pass their own); defaults to the system clock. */
  clock?: (() => number) | undefined
}

/**
 * The doctor's day (Doctor HERO final; contracts doctorDay.ts; the counting rules are in ./queries.ts).
 *
 *   GET /api/doctor/day?period=today|week|month   config: { permission: 'doctor_day:read' } (doctors)
 *     -> DoctorDay. Counts, trend and today's timeline of the signed-in doctor ("mine" as visits?mine=true and appointments mine=true: assigned
 *        to me, or unassigned in my department), on the facility's calendar. Audit `doctor_day.read` with the period, the counts and the
 *        timeline's patientIds only (no names, reasons or other free text). Home and My consultations poll it every 30 s while visible.
 */
export function registerDoctorDayRoutes(app: FastifyInstance, deps: DoctorDayRouteDeps): void {
  const { db } = deps
  const now = deps.clock ?? Date.now
  app.get('/api/doctor/day', { config: { permission: 'doctor_day:read' } }, async (req): Promise<DoctorDay> => {
    const me = currentUser(req)
    const { period } = parse(DoctorDayQuery, req.query)
    const day = await loadDoctorDay(db, me, period, now())
    await audit(db, req, { action: 'doctor_day.read', details: { period, counts: day.counts, patientIds: [...new Set(day.timeline.map((r) => r.patient.id))] } })
    return day
  })
}
