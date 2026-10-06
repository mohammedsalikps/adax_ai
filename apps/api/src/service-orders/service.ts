import {
  isOpenServiceOrder,
  OPEN_SERVICE_ORDER_STATUSES,
  type ServiceCatalogue,
  type ServiceCategory,
  type ServiceOrder,
  type ServiceOrderStatus,
  SIMULATED_REPORT_TEXT,
  simulatedOrderSchedule,
  simulatedOrderStatusAt,
} from '@adaxai/contracts'
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { SessionUser } from '../auth/sessions.ts'
import type { Db, DbOrTx } from '../db/client.ts'
import { serviceOrders, users } from '../db/schema.ts'
import type { AppSettings } from '../settings/schema.ts'

/**
 * Service orders (Doctor HERO final): the catalogue, the simulated laboratory's steps and the read model. The routes are in ./routes.ts; Mana's
 * deterministic "lab / orders status" answers read orders through `readServiceOrders` so they say the same as the consultation screen.
 *
 * No laboratory or imaging system is connected. The only provider is a deterministic simulator: an order moves to in progress
 * `inProgressAfterMinutes` after it was requested and to completed `turnaroundMinutes` after it was requested (contracts
 * simulatedOrderSchedule). The steps are applied when the orders are next read, each stored once with the time its schedule gives (never the
 * time it was read), and the database writes each one to service_order_events (trigger). A completed simulated order carries only the fixed
 * sentence that nothing was performed (SIMULATED_REPORT_TEXT). Nothing here writes an investigation result or invents a value.
 */

export type ServiceOrderRow = typeof serviceOrders.$inferSelect
export type ServiceOrderSettings = AppSettings['serviceOrders']

/** Which orders a read covers: one consultation's, one patient's, or one order. */
export type ServiceOrderScope = { encounterId: string } | { patientId: string } | { orderId: string }

/** The most orders one list returns (newest first). */
export const SERVICE_ORDER_LIST_LIMIT = 200

const OPEN = OPEN_SERVICE_ORDER_STATUSES as [ServiceOrderStatus, ...ServiceOrderStatus[]]

/** GET /api/service-catalogue: the configured services, every one of them going to the simulated provider. */
export function serviceCatalogue(s: ServiceOrderSettings): ServiceCatalogue {
  return {
    provider: s.provider,
    simulated: true,
    services: s.catalogue.map((c) => ({ code: c.code, name: c.name, category: c.category, turnaroundMinutes: c.turnaroundMinutes, simulated: true })),
  }
}

function scopeWhere(scope: ServiceOrderScope): SQL {
  if ('encounterId' in scope) return eq(serviceOrders.encounterId, scope.encounterId)
  if ('patientId' in scope) return eq(serviceOrders.patientId, scope.patientId)
  return eq(serviceOrders.id, scope.orderId)
}

const categoryOf = (c: string): ServiceCategory => (c === 'lab' || c === 'imaging' ? c : 'other')

/** A step's time: the schedule's, but never before the order's current status began (the database refuses a step back in time). */
const notBefore = (at: Date) => sql`greatest(${at.toISOString()}::timestamptz, ${serviceOrders.statusChangedAt})`

/**
 * Brings every open simulated order in `scope` to the status its fixed schedule gives for `now`, inside the caller's transaction: the orders
 * are locked (in id order, so two readers never wait for each other in a circle) and each step is one update whose time is the schedule's.
 * A reader that waited for another sees the other's steps and does not repeat them; a cancel that came first leaves the order alone. Returns
 * how many steps were applied.
 */
export async function advanceSimulatedOrders(tx: DbOrTx, scope: ServiceOrderScope, now: Date, inProgressAfterMinutes: number): Promise<number> {
  const rows = await tx
    .select()
    .from(serviceOrders)
    .where(and(scopeWhere(scope), eq(serviceOrders.simulated, true), inArray(serviceOrders.status, OPEN)))
    .orderBy(asc(serviceOrders.id))
    .for('update')
  let steps = 0
  for (const r of rows) {
    if (r.turnaroundMinutes === null) continue
    const plan = { requestedAt: r.requestedAt, turnaroundMinutes: r.turnaroundMinutes }
    const target = simulatedOrderStatusAt({ ...plan, status: r.status }, now, inProgressAfterMinutes)
    if (target === r.status) continue
    const schedule = simulatedOrderSchedule(plan, inProgressAfterMinutes)
    let status = r.status
    if (status === 'requested') {
      const [moved] = await tx
        .update(serviceOrders)
        .set({ status: 'in_progress', statusChangedAt: notBefore(schedule.inProgressAt) })
        .where(and(eq(serviceOrders.id, r.id), eq(serviceOrders.status, 'requested')))
        .returning({ status: serviceOrders.status })
      if (!moved) continue
      status = moved.status
      steps++
    }
    if (target === 'completed' && status === 'in_progress') {
      const at = notBefore(schedule.completedAt)
      const [done] = await tx
        .update(serviceOrders)
        .set({ status: 'completed', statusChangedAt: at, completedAt: at, reportText: SIMULATED_REPORT_TEXT[categoryOf(r.category)] })
        .where(and(eq(serviceOrders.id, r.id), eq(serviceOrders.status, 'in_progress')))
        .returning({ id: serviceOrders.id })
      if (done) steps++
    }
  }
  return steps
}

/** One order as the API returns it; `canCancel` is the caller's (they placed it, it is still open, and they are a doctor). */
export function toServiceOrder(r: ServiceOrderRow, orderedByName: string | null, me: Pick<SessionUser, 'id' | 'role'>): ServiceOrder {
  return {
    id: r.id,
    patientId: r.patientId,
    encounterId: r.encounterId,
    visitId: r.visitId,
    serviceCode: r.serviceCode,
    serviceName: r.serviceName,
    category: categoryOf(r.category),
    note: r.note,
    status: r.status,
    provider: 'simulated',
    simulated: r.simulated,
    requestedAt: r.requestedAt.toISOString(),
    statusChangedAt: r.statusChangedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    reportText: r.reportText,
    orderedByName,
    canCancel: me.role === 'doctor' && r.orderedBy === me.id && isOpenServiceOrder(r.status),
  }
}

/** The orders in `scope`, newest first, with who placed them. */
export async function listServiceOrders(db: DbOrTx, me: Pick<SessionUser, 'id' | 'role'>, scope: ServiceOrderScope): Promise<ServiceOrder[]> {
  const rows = await db
    .select({ o: serviceOrders, by: users.fullName })
    .from(serviceOrders)
    .leftJoin(users, eq(users.id, serviceOrders.orderedBy))
    .where(scopeWhere(scope))
    .orderBy(desc(serviceOrders.requestedAt), desc(serviceOrders.id))
    .limit(SERVICE_ORDER_LIST_LIMIT)
  return rows.map(({ o, by }) => toServiceOrder(o, by, me))
}

/**
 * The read every caller uses: first the simulated laboratory's due steps (one short transaction holding the orders' rows), then the orders as
 * they now stand. The caller has already checked that `me` may see the scope (facility, permission) and audits the read.
 */
export async function readServiceOrders(db: Db, me: Pick<SessionUser, 'id' | 'role'>, scope: ServiceOrderScope, now: Date, inProgressAfterMinutes: number): Promise<{ orders: ServiceOrder[]; advanced: number }> {
  const advanced = await db.transaction((tx) => advanceSimulatedOrders(tx, scope, now, inProgressAfterMinutes))
  return { orders: await listServiceOrders(db, me, scope), advanced }
}
