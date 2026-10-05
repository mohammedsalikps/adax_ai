import crypto from 'node:crypto'
import { type DeviceIngestResponse, type DeviceKind, type DeviceReadingsRequest, kindAllowedFrom, usesGateway, VITALS } from '@adaxai/contracts'
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { audit } from '../audit/audit.ts'
import type { Config } from '../config.ts'
import { currentConsent } from '../consents/service.ts'
import type { Db, DbOrTx } from '../db/client.ts'
import { consents, deviceAssignments, deviceBatches, devices, facilities, observations, visits } from '../db/schema.ts'
import { badRequest, conflict, forbidden, HttpError, unauthorized } from '../http/errors.ts'
import { enforceLimit, type LimitRule, type RateLimiter } from '../http/rate-limit.ts'
import type { AppSettings } from '../settings/schema.ts'

/**
 * The device GATEWAY side of the boundary: requests that carry a device token instead of a user session. One place decides who the device is,
 * whether it may post at all, which patient a reading belongs to, whether the patient's consent covers it, and that a batch is stored once.
 * No hardware has been connected to this: a gateway is a separate program (docs/DEVICES.md), and the only one that exists is the labelled
 * simulator (src/devices/simulate-cli.ts).
 */

export type DeviceRow = typeof devices.$inferSelect
export type AssignmentRow = typeof deviceAssignments.$inferSelect

export interface GatewayDeps {
  db: Db
  limiter: RateLimiter
  settings: AppSettings
  config: Config
  /** The server's clock (milliseconds); tests pass their own. */
  clock: () => number
}

export const tokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

/**
 * A simulator exists only where the data is not clinical: in a clinical or production deployment it cannot be registered or issued a token, and a
 * token it was issued before is refused.
 */
export const simulatorAllowed = (config: Config) => config.dataOrigin !== 'clinical' && config.env !== 'production'

/** A time stamped further ahead of the server's clock than this is refused (a gateway with a wrong clock); less is taken as "now" (see `windowFor`). */
const FUTURE_TOLERANCE_MS = 5 * 60_000
const OPEN_VISIT = ['waiting', 'in_triage', 'ready', 'in_consultation'] as const
/** Guesses at a token from one address: bounded, and told to the audit log once per window, not once per guess. */
const UNKNOWN_TOKEN_PER_ADDRESS: LimitRule = { max: 30, windowSeconds: 60 }
const AUDIT_ONCE: LimitRule = { max: 1, windowSeconds: 300 }

export type Refuse = (reason: string, patientId?: string | null) => Promise<void>

/**
 * Who is calling: the device whose token was presented. Refusals are audited (with no patient: the gateway never names one) and answered
 * 401 (no or unknown token), 403 (a retired device, one with no gateway, a simulator where none is allowed) or 429. A device that gets through is
 * marked as seen now, which is what "disconnected" is later decided from. `limit` is the per-token rule of the route (recordings have their own).
 */
export async function gatewayDevice(deps: GatewayDeps, req: FastifyRequest, reply: FastifyReply, limit: LimitRule = deps.settings.security.rateLimits.deviceIngestPerToken, scope = 'device-ingest'): Promise<{ device: DeviceRow; refuse: Refuse }> {
  const { db } = deps
  const auth = req.headers.authorization ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) throw unauthorized('Device token required')
  const d = await db.query.devices.findFirst({ where: eq(devices.ingestTokenHash, tokenHash(token)) })
  const refuse: Refuse = async (reason, patientId = null) => {
    await audit(db, req, { action: 'device.ingest', outcome: 'denied', actorUserId: null, actorRole: 'device', ...(d && { entityType: 'device', entityId: d.id }), facilityId: d?.facilityId ?? null, patientId, details: { reason, route: req.routeOptions.url ?? null } })
    req.denialAudited = true
  }
  if (!d) {
    // Anyone can send any string here. Guessing is slowed per address, and the audit log (a hash chain every writer waits for) is told about the
    // first unknown token from an address in a window, not about every one.
    const guesses = deps.limiter.hit(`device-ingest-unknown:${req.ip}`, UNKNOWN_TOKEN_PER_ADDRESS)
    if (deps.limiter.hit(`device-ingest-unknown-audit:${req.ip}`, AUDIT_ONCE).allowed) await refuse('unknown_token')
    if (!guesses.allowed) {
      void reply.header('retry-after', String(guesses.retryAfter))
      throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${guesses.retryAfter} seconds.`)
    }
    throw unauthorized('Unknown device token')
  }
  await enforceLimit(db, deps.limiter, req, reply, scope, d.id, limit)
  if (d.status !== 'active' || !usesGateway(d.integration)) {
    await refuse('device_not_active_gateway')
    throw forbidden('This device may not post readings')
  }
  if (d.integration === 'simulator' && !simulatorAllowed(deps.config)) {
    await refuse('simulator_not_allowed')
    throw forbidden('A simulator may not post in this deployment')
  }
  await db.update(devices).set({ lastSeenAt: new Date(deps.clock()) }).where(eq(devices.id, d.id))
  return { device: d, refuse }
}

/** The assignment that covers `at`: started at or before it, not ended by then, and before its validity limit if it has one. */
export async function assignmentAt(db: DbOrTx, deviceId: string, at: Date): Promise<AssignmentRow | undefined> {
  return db.query.deviceAssignments.findFirst({
    where: and(eq(deviceAssignments.deviceId, deviceId), lte(deviceAssignments.assignedAt, at), or(isNull(deviceAssignments.endedAt), gt(deviceAssignments.endedAt, at)), or(isNull(deviceAssignments.validUntil), gt(deviceAssignments.validUntil, at))),
  })
}

/**
 * Whether the patient's consent to device readings covers something measured at `at`: it must be in place now and must already have been given
 * then. A renewal under newer wording continues the same consent, so the chain of superseded grants is walked back. With `lock` (inside the
 * transaction that stores) a withdrawal either commits first, and this says so, or waits until what is being stored has been stored.
 */
export async function deviceConsentCovers(db: DbOrTx, patientId: string, at: Date, lock = false): Promise<'ok' | 'missing' | 'given_later'> {
  const c = await currentConsent(db, patientId, 'device_monitoring', undefined, lock)
  if (!c) return 'missing'
  let since = c
  while (since.recordedAt > at) {
    const prev = await db.query.consents.findFirst({ where: and(eq(consents.supersededBy, since.id), eq(consents.status, 'superseded')) })
    if (!prev) break
    since = prev
  }
  return since.recordedAt > at ? 'given_later' : 'ok'
}

/**
 * The visit a reading measured at `at` is filed under, or null (it still belongs to the patient): the patient's visit of that day, in the
 * facility's time, that the patient had checked in to by then, and only if that visit is STILL OPEN when the reading arrives. A reading that
 * arrives after its visit was completed or cancelled is not added to it (a closed visit's vital signs do not change afterwards), and a visit
 * left open from an earlier day collects nothing.
 */
export async function visitForReading(db: DbOrTx, patientId: string, facilityId: string, at: Date): Promise<string | null> {
  const [v] = await db
    .select({ id: visits.id })
    .from(visits)
    .innerJoin(facilities, eq(facilities.id, visits.facilityId))
    .where(and(eq(visits.patientId, patientId), eq(visits.facilityId, facilityId), inArray(visits.status, [...OPEN_VISIT]), lte(visits.checkedInAt, at), sql`${visits.visitDate} = (${at.toISOString()}::timestamptz at time zone ${facilities.timezone})::date`))
    .orderBy(desc(visits.checkedInAt))
    .limit(1)
  return v?.id ?? null
}

const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex')

/**
 * Whose is it, and may it be stored? `stamped` is the time the gateway gave. The answer is the assignment that covers it and the time it is
 * stored under, or the request is refused, audited, and nothing is stored:
 *   - further ahead of the server's clock than the tolerance: refused (400);
 *   - ahead of it by less (a gateway clock that runs fast): taken as NOW, so that nothing is ever "measured" after it arrived, a value cannot
 *     stay live for the length of the skew, and a band handed to the next patient cannot file its last readings under them;
 *   - longer ago than `devices.maxLateHours`: refused (a token is not a way to write into the past without limit);
 *   - not assigned to anyone at that time, or outside that patient's consent: refused.
 */
export async function windowFor(deps: GatewayDeps, device: DeviceRow, stamped: Date, refuse: Refuse, what: 'readings' | 'recording'): Promise<{ assignment: AssignmentRow; at: Date }> {
  const now = deps.clock()
  const field = what === 'readings' ? 'measuredAt' : 'recordedAt'
  if (stamped.getTime() > now + FUTURE_TOLERANCE_MS) throw badRequest('Some fields are invalid', [{ path: field, message: 'In the future' }])
  const hours = deps.settings.devices.maxLateHours
  if (stamped.getTime() < now - hours * 3_600_000) {
    await refuse('measured_too_long_ago')
    throw new HttpError(422, 'too_late', `${what === 'readings' ? 'These readings were' : 'This recording was'} measured more than ${hours} hours ago; ${what === 'readings' ? 'they were' : 'it was'} not stored`)
  }
  const at = new Date(Math.min(stamped.getTime(), now))
  const a = await assignmentAt(deps.db, device.id, at)
  if (!a) {
    await refuse('no_assignment_at_measurement_time')
    throw conflict(`The device was not assigned to a patient when ${what === 'readings' ? 'these readings were measured; readings were' : 'this recording was made; it was'} not stored`, 'outside_assignment')
  }
  const covered = await deviceConsentCovers(deps.db, a.patientId, at)
  if (covered !== 'ok') {
    await refuse(covered === 'given_later' ? 'measured_before_consent' : 'consent_missing_or_withdrawn', a.patientId)
    throw consentRefusal(what)
  }
  return { assignment: a, at }
}

const consentRefusal = (what: 'readings' | 'recording') => conflict(`The patient’s consent to device readings does not cover ${what === 'readings' ? 'these readings; readings were' : 'this recording; it was'} not stored`, 'consent_required')

/**
 * The last look at the patient's consent, inside the transaction that stores and holding the consent row: a withdrawal that commits while a
 * batch is on its way either comes first (and the batch is refused here) or waits until the batch is stored. Throws the same refusal as `windowFor`.
 */
export async function consentStillCovers(tx: DbOrTx, patientId: string, at: Date, what: 'readings' | 'recording'): Promise<void> {
  if ((await deviceConsentCovers(tx, patientId, at, true)) !== 'ok') throw consentRefusal(what)
}

export interface BatchInput {
  device: DeviceRow
  assignment: AssignmentRow
  kind: 'readings' | 'auscultation'
  /** The key the gateway sent, if it sent one. */
  idempotencyKey: string | undefined
  /** What the batch says, in a fixed form: its hash tells a repeat from a different batch under the same key. */
  canonical: string
  measuredAt: Date
  itemCount: number
}

/**
 * Claims a batch inside `tx`. Returns the new batch id, or `{ duplicate }` when this very batch was stored before (nothing more must be stored).
 * The same key with different content is refused (409): a key names one batch. Without a key the batch is named by its content.
 */
export async function claimBatch(tx: DbOrTx, b: BatchInput): Promise<{ id: string; duplicate: boolean }> {
  const payloadSha256 = sha(b.canonical)
  const idempotencyKey = b.idempotencyKey ?? `auto:${payloadSha256}`
  const [created] = await tx
    .insert(deviceBatches)
    .values({ facilityId: b.device.facilityId, deviceId: b.device.id, assignmentId: b.assignment.id, patientId: b.assignment.patientId, kind: b.kind, idempotencyKey, payloadSha256, measuredAt: b.measuredAt, itemCount: b.itemCount, simulated: b.device.integration === 'simulator' })
    .onConflictDoNothing({ target: [deviceBatches.deviceId, deviceBatches.idempotencyKey] })
    .returning({ id: deviceBatches.id })
  if (created) return { id: created.id, duplicate: false }
  const existing = await tx.query.deviceBatches.findFirst({ where: and(eq(deviceBatches.deviceId, b.device.id), eq(deviceBatches.idempotencyKey, idempotencyKey)) })
  if (!existing || existing.payloadSha256 !== payloadSha256 || existing.kind !== b.kind) throw new HttpError(409, 'idempotency_conflict', 'This idempotency key was already used for a different batch; nothing was stored')
  return { id: existing.id, duplicate: true }
}

/** A repeat stores nothing; the audit log is told about the first repeat of a batch in a window, not about every retry of a gateway that is stuck. */
export const repeatIsNews = (deps: GatewayDeps, batchId: string) => deps.limiter.hit(`device-batch-repeat:${batchId}`, AUDIT_ONCE).allowed

/**
 * Stores one batch of readings from a gateway. The kinds a device may send are gated (blood pressure is in no list); the batch is stored once;
 * every reading is `device_unverified`, or `simulated` when the device record is a simulator (decided here from the record, never from the request).
 */
export async function ingestReadings(deps: GatewayDeps, req: FastifyRequest, device: DeviceRow, refuse: Refuse, body: z.output<typeof DeviceReadingsRequest>): Promise<{ status: 200 | 201; response: DeviceIngestResponse }> {
  const refused = body.readings.filter((r) => !kindAllowedFrom(device.kind as DeviceKind, r.kind))
  if (refused.length) {
    await refuse(`kind_not_allowed:${refused.map((r) => r.kind).join(',')}`)
    const names = refused.map((r) => VITALS[r.kind].label).join(', ')
    throw new HttpError(422, 'kind_not_allowed', `This kind of device may not send: ${names}. Nothing in the batch was stored.${refused.some((r) => r.kind.endsWith('_bp')) ? ' Blood pressure is entered by staff: no device pipeline for it has been validated.' : ''}`)
  }
  const stamped = new Date(body.measuredAt)
  const { assignment: a, at } = await windowFor(deps, device, stamped, refuse, 'readings')
  const simulated = device.integration === 'simulator'
  const validationStatus = simulated ? ('simulated' as const) : ('device_unverified' as const)
  // What the gateway said, as it said it: a retry of the same batch is the same batch whenever it arrives.
  const canonical = JSON.stringify({ measuredAt: stamped.toISOString(), readings: [...body.readings].sort((x, y) => x.kind.localeCompare(y.kind)).map((r) => [r.kind, r.value]) })
  try {
    return await deps.db.transaction(async (tx) => {
      await consentStillCovers(tx, a.patientId, at, 'readings')
      const batch = await claimBatch(tx, { device, assignment: a, kind: 'readings', idempotencyKey: body.idempotencyKey, canonical, measuredAt: at, itemCount: body.readings.length })
      if (batch.duplicate) {
        if (repeatIsNews(deps, batch.id)) await audit(tx, req, { action: 'device.ingest', actorUserId: null, actorRole: 'device', entityType: 'device', entityId: device.id, patientId: a.patientId, facilityId: device.facilityId, details: { duplicate: true, batchId: batch.id, assignmentId: a.id } })
        return { status: 200 as const, response: { stored: 0, duplicate: true, validationStatus, batchId: batch.id } }
      }
      const visitId = await visitForReading(tx, a.patientId, device.facilityId, at)
      const rows = await tx
        .insert(observations)
        .values(body.readings.map((r) => ({ patientId: a.patientId, visitId, kind: r.kind, value: r.value, unit: VITALS[r.kind].unit, measuredAt: at, source: 'device' as const, validationStatus, deviceId: device.id, deviceBatchId: batch.id })))
        .returning({ id: observations.id })
      await audit(tx, req, { action: 'device.ingest', actorUserId: null, actorRole: 'device', entityType: 'device', entityId: device.id, patientId: a.patientId, facilityId: device.facilityId, details: { readings: body.readings.map((r) => r.kind), assignmentId: a.id, batchId: batch.id, simulated, visitId } })
      return { status: 201 as const, response: { stored: rows.length, duplicate: false, validationStatus, batchId: batch.id } }
    })
  } catch (e) {
    if (e instanceof HttpError && (e.code === 'idempotency_conflict' || e.code === 'consent_required')) await refuse(e.code === 'consent_required' ? 'consent_missing_or_withdrawn' : e.code, a.patientId)
    throw e
  }
}

export { sha as sha256Hex }
