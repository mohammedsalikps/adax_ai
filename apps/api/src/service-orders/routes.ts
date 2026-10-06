import { CancelServiceOrderRequest, CreateServiceOrderRequest, isOpenServiceOrder, type ServiceOrder, type ServiceOrderList } from '@adaxai/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Config } from '../config.ts'
import { type Db, pgCode } from '../db/client.ts'
import { encounters, patients, serviceOrders, users } from '../db/schema.ts'
import { assertWithDoctor, type EncounterRow, getEncounterOr404 } from '../encounters/service.ts'
import { entryOrigin } from '../history/service.ts'
import { badRequest, conflict, deniedNotFound, forbidden } from '../http/errors.ts'
import type { RateLimiter } from '../http/rate-limit.ts'
import { parse } from '../http/validate.ts'
import { getPatientOr404 } from '../patients/service.ts'
import type { AppSettings } from '../settings/schema.ts'
import { advanceSimulatedOrders, readServiceOrders, serviceCatalogue, toServiceOrder } from './service.ts'

export interface ServiceOrderRouteDeps {
  db: Db
  config: Config
  /** `settings.serviceOrders`: the catalogue and the simulated provider's schedule. */
  settings: AppSettings
  limiter: RateLimiter
  /** The clock the simulated provider's schedule is read against (tests pass their own); defaults to the system clock. */
  clock?: (() => number) | undefined
}

const IdParams = z.object({ id: z.uuid() })

/**
 * An open order's list is read again every 30 s (the web app's poll) for as long as the simulated turnaround lasts. The audit log says who
 * looked at whose orders once per viewer, list and window, not once per read (as devices/routes.ts and consultation-context/routes.ts do);
 * each simulated step is kept in service_order_events whatever the audit says.
 */
export const SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS = 300

const NOT_IN_PROGRESS = 'Orders are placed in an open consultation. This consultation is signed or discarded, so the order was not sent.'

/**
 * Service orders (Doctor HERO final; contracts serviceOrders.ts; tables service_orders and service_order_events, migration 0033). The only
 * provider is the deterministic simulator (./service.ts): never present it as a real laboratory.
 *
 *   GET  /api/service-catalogue                     permission 'orders:read'  -> ServiceCatalogue
 *   POST /api/encounters/:id/service-orders         permission 'orders:write' (the consultation's own doctor, in progress) -> ServiceOrder (201;
 *                                                   200 for a repeat with the same idempotencyKey)
 *   GET  /api/encounters/:id/service-orders         permission 'orders:read'  -> ServiceOrderList
 *   GET  /api/patients/:id/service-orders           permission 'orders:read'  -> ServiceOrderList
 *   POST /api/service-orders/:id/cancel             permission 'orders:write' (the doctor who placed it; requested or in progress) -> ServiceOrder
 *
 * Every read first applies the simulated laboratory's due steps (deps.clock), so all readers see the same status. The database writes
 * service_order_events itself (trigger service_order_record): never insert into it. Audit: ids, codes, statuses, counts and flags only, never
 * the note or the cancel reason; a list read once per viewer, list and SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS (the web app polls it).
 */
export function registerServiceOrderRoutes(app: FastifyInstance, deps: ServiceOrderRouteDeps): void {
  const { db, config } = deps
  const so = deps.settings.serviceOrders
  const catalogue = serviceCatalogue(so)
  const now = () => new Date((deps.clock ?? Date.now)())
  const nameOf = async (id: string) => (await db.select({ n: users.fullName }).from(users).where(eq(users.id, id)))[0]?.n ?? null

  /** An order as it now stands (after any due simulated step). */
  async function currentOrder(me: SessionUser, orderId: string): Promise<ServiceOrder> {
    const { orders } = await readServiceOrders(db, me, { orderId }, now(), so.inProgressAfterMinutes)
    return orders[0]!
  }

  /**
   * A "Send order" repeated with the same key (a double tap, a retry after a lost answer) gets the order it already made. The key is the
   * caller's own (unique per doctor); used for a different consultation or service it is refused, never silently reused.
   */
  async function replay(me: SessionUser, e: EncounterRow, serviceCode: string, key: string): Promise<ServiceOrder | null> {
    const [prior] = await db
      .select({ id: serviceOrders.id, encounterId: serviceOrders.encounterId, serviceCode: serviceOrders.serviceCode })
      .from(serviceOrders)
      .where(and(eq(serviceOrders.orderedBy, me.id), eq(serviceOrders.idempotencyKey, key)))
    if (!prior) return null
    if (prior.encounterId !== e.id || prior.serviceCode !== serviceCode) throw conflict('This order was already sent with different details. Close the dialog and order again.', 'idempotency_key_reused')
    return currentOrder(me, prior.id)
  }

  /** A repeat answers with the order as it stands; the read is audited (it returns the order), never as a second order. */
  const auditRepeat = (req: FastifyRequest, e: EncounterRow, o: ServiceOrder) =>
    audit(db, req, { action: 'service_order.create_repeat', entityType: 'service_order', entityId: o.id, patientId: e.patientId, details: { encounterId: e.id, serviceCode: o.serviceCode, status: o.status } })

  /** A list read, audited once per viewer, list and window (counts only); the window is spent only on a read that was recorded. */
  async function auditListRead(req: FastifyRequest, me: SessionUser, scope: 'encounter' | 'patient', id: string, patientId: string, read: { orders: ServiceOrder[]; advanced: number }) {
    const key = `service-orders-read:${me.id}:${scope}:${id}`
    if (!deps.limiter.hit(key, { max: 1, windowSeconds: SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS }).allowed) return
    try {
      await audit(db, req, {
        action: 'service_order.list',
        entityType: scope,
        entityId: id,
        patientId,
        details: { count: read.orders.length, open: read.orders.filter((o) => isOpenServiceOrder(o.status)).length, advanced: read.advanced, repeatsNotLoggedForSeconds: SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS },
      })
    } catch (err) {
      deps.limiter.reset(key)
      throw err
    }
  }

  app.get('/api/service-catalogue', { config: { permission: 'orders:read' } }, async () => catalogue)

  app.get('/api/encounters/:id/service-orders', { config: { permission: 'orders:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const e = await getEncounterOr404(db, me, id)
    const read = await readServiceOrders(db, me, { encounterId: id }, now(), so.inProgressAfterMinutes)
    await auditListRead(req, me, 'encounter', id, e.patientId, read)
    return { orders: read.orders } satisfies ServiceOrderList
  })

  app.get('/api/patients/:id/service-orders', { config: { permission: 'orders:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    const read = await readServiceOrders(db, me, { patientId: id }, now(), so.inProgressAfterMinutes)
    await auditListRead(req, me, 'patient', id, id, read)
    return { orders: read.orders } satisfies ServiceOrderList
  })

  app.post('/api/encounters/:id/service-orders', { config: { permission: 'orders:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(CreateServiceOrderRequest, req.body)
    const e = await getEncounterOr404(db, me, id)
    if (body.idempotencyKey) {
      const again = await replay(me, e, body.serviceCode, body.idempotencyKey)
      if (again) {
        await auditRepeat(req, e, again)
        return reply.code(200).send(again)
      }
    }
    if (e.doctorId !== me.id) throw forbidden('Only the doctor of this consultation can order services in it')
    if (e.status !== 'in_progress') throw conflict(NOT_IN_PROGRESS, 'encounter_not_in_progress')
    await assertWithDoctor(db, e)
    const entry = so.catalogue.find((c) => c.code === body.serviceCode)
    if (!entry) throw badRequest('Some fields are invalid', [{ path: 'serviceCode', message: 'Choose a service from the list' }])
    const [patient] = await db.select({ dataOrigin: patients.dataOrigin }).from(patients).where(eq(patients.id, e.patientId))
    const at = now()
    try {
      const row = await db.transaction(async (tx) => {
        // The last look at the consultation, holding its row: a sign or discard that commits meanwhile either comes first (nothing is
        // ordered) or waits until the order is in.
        const [open] = await tx
          .select({ id: encounters.id })
          .from(encounters)
          .where(and(eq(encounters.id, id), eq(encounters.facilityId, me.facilityId), eq(encounters.status, 'in_progress'), eq(encounters.doctorId, me.id)))
          .for('share')
        if (!open) throw conflict(NOT_IN_PROGRESS, 'encounter_not_in_progress')
        const [r] = await tx
          .insert(serviceOrders)
          .values({
            facilityId: e.facilityId,
            patientId: e.patientId,
            visitId: e.visitId,
            encounterId: e.id,
            orderedBy: me.id,
            serviceCode: entry.code,
            serviceName: entry.name,
            category: entry.category,
            note: body.note ?? null,
            status: 'requested',
            provider: 'simulated',
            simulated: true,
            turnaroundMinutes: entry.turnaroundMinutes,
            idempotencyKey: body.idempotencyKey ?? null,
            requestedAt: at,
            statusChangedAt: at,
            dataOrigin: entryOrigin(patient?.dataOrigin ?? '', config.dataOrigin),
          })
          .returning()
        await audit(tx, req, {
          action: 'service_order.create',
          entityType: 'service_order',
          entityId: r!.id,
          patientId: e.patientId,
          details: { encounterId: id, serviceCode: entry.code, category: entry.category, simulated: true, withNote: !!body.note },
        })
        return r!
      })
      return reply.code(201).send(toServiceOrder(row, me.fullName, me))
    } catch (err) {
      // The same key sent twice at the same moment: the second insert meets the first one's unique key, and gets that order.
      if (pgCode(err) === '23505' && body.idempotencyKey) {
        const again = await replay(me, e, body.serviceCode, body.idempotencyKey)
        if (again) {
          await auditRepeat(req, e, again)
          return reply.code(200).send(again)
        }
      }
      throw err
    }
  })

  app.post('/api/service-orders/:id/cancel', { config: { permission: 'orders:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(CancelServiceOrderRequest, req.body)
    const [found] = await db.select({ orderedBy: serviceOrders.orderedBy, patientId: serviceOrders.patientId }).from(serviceOrders).where(and(eq(serviceOrders.id, id), eq(serviceOrders.facilityId, me.facilityId)))
    if (!found) {
      const [elsewhere] = await db.select({ id: serviceOrders.id }).from(serviceOrders).where(eq(serviceOrders.id, id))
      throw deniedNotFound('Order', { entityType: 'service_order', entityId: id, reason: elsewhere ? 'other_facility' : 'not_found' })
    }
    if (found.orderedBy !== me.id) throw forbidden('Only the doctor who placed this order can cancel it')
    const at = now()
    const outcome = await db.transaction(async (tx) => {
      // The simulated laboratory's due steps first (it may have completed the order before now), then the cancel, on the same locked row.
      await advanceSimulatedOrders(tx, { orderId: id }, at, so.inProgressAfterMinutes)
      const [cur] = await tx.select({ status: serviceOrders.status }).from(serviceOrders).where(eq(serviceOrders.id, id)).for('update')
      if (!cur || !isOpenServiceOrder(cur.status)) return { closed: cur?.status ?? 'cancelled' } as const
      const when = sql`greatest(${at.toISOString()}::timestamptz, ${serviceOrders.statusChangedAt})`
      const [r] = await tx
        .update(serviceOrders)
        .set({ status: 'cancelled', statusChangedAt: when, cancelledAt: when, cancelledBy: me.id, cancelReason: body.reason ?? null })
        .where(and(eq(serviceOrders.id, id), inArray(serviceOrders.status, ['requested', 'in_progress'])))
        .returning()
      await audit(tx, req, { action: 'service_order.cancel', entityType: 'service_order', entityId: id, patientId: r!.patientId, details: { encounterId: r!.encounterId, serviceCode: r!.serviceCode, from: cur.status, withReason: !!body.reason } })
      return { row: r! } as const
    })
    // Refused after the transaction: a step the simulated laboratory was due is kept (it happened at its scheduled time either way).
    if ('closed' in outcome) throw conflict(outcome.closed === 'completed' ? 'This order is already completed and can no longer be cancelled.' : 'This order is already cancelled.', 'service_order_closed')
    return toServiceOrder(outcome.row, await nameOf(outcome.row.orderedBy), me)
  })
}
