import { type AuscultationRecording, type DeviceKind, DeviceReadingsRequest, OPEN_VISIT_STATUSES, SIMULATION_DEVICE_KINDS, SIMULATION_TICK_MS, SimulationAttachRequest, type SimulationAttachResult, SimulationBandTickRequest, type SimulationBandTickResult, type SimulationKind, SimulationStethoscopeRequest, type VisitStatus } from '@adaxai/contracts'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Config } from '../config.ts'
import { requireConsent } from '../consents/service.ts'
import { type Db, pgCode } from '../db/client.ts'
import { auscultationRecordings, deviceAssignments, devices, encounters, files, visits } from '../db/schema.ts'
import { discardStoredBytes, storeBytes } from '../files/storage.ts'
import { conflict, deniedNotFound, forbidden, HttpError } from '../http/errors.ts'
import { enforceLimit, type LimitRule, type RateLimiter } from '../http/rate-limit.ts'
import { parse } from '../http/validate.ts'
import { facilityToday } from '../patients/service.ts'
import type { AppSettings } from '../settings/schema.ts'
import { type AssignmentRow, claimBatch, consentStillCovers, type DeviceRow, type GatewayDeps, ingestReadings, type Refuse, sha256Hex, simulatorAllowed, windowFor } from './gateway.ts'
import { type SimRun, simulatedBatch, simulatedTick, simulatedToneWav, SIMULATOR_VERSION } from './simulator.ts'

/**
 * THE DEVICE SIMULATOR, RUN FROM THE CONSULTATION (HERO final). It is not a device: the same generator as the simulator program
 * (src/devices/simulator.ts), behind the doctor's session instead of a device token (no token ever reaches the browser), and only:
 *   - where simulators are allowed (never in a clinical or production deployment: refused and audited);
 *   - in the caller's OWN consultation, while it is in progress;
 *   - with the patient's consent to device readings;
 *   - through a device record REGISTERED AS A SIMULATOR (an administrator or a demo script registers one; this never creates one), so the
 *     server and the database triggers store everything it produces as simulated, exactly as they do for the simulator program. A simulator
 *     record left attached to a patient nobody is using it for now (that consultation is over, that visit closed) is moved to this consultation:
 *     its old assignment is ended (and audited) in the same transaction (simulatorReclaimable). A device record is never moved.
 * Values go through the gateway's own store path (`ingestReadings`: the gate, the assignment window, the consent, idempotency); a recording goes
 * through the gateway's building blocks (assignment window, consent re-checked while storing, a claimed batch) with the capture method the
 * database allows for it ('gateway'). The page drives the band with one request every few seconds while its toggle is on: there is no server
 * timer, so nothing keeps writing after the page is closed. The audit log gets ids, kinds and counts only, never a value or a sound.
 */

const IdParams = z.object({ id: z.uuid() })
/** Attaching is rare: a page that loops on it is stopped. */
const ATTACH_PER_USER: LimitRule = { max: 20, windowSeconds: 60 }
/** One tick every five seconds is 12 a minute; two tabs of the same consultation stay under this. */
const TICKS_PER_CONSULTATION: LimitRule = { max: 30, windowSeconds: 60 }
const RECORDINGS_PER_USER: LimitRule = { max: 6, windowSeconds: 60 }
/** A scenario runs for this many ticks from the time the simulator was attached, then starts again (so "fever" rises again after ten minutes). */
const CYCLE_TICKS = 120
/** The length of a generated-tones recording (simulatedToneWav's default). */
const TONE_SECONDS = 4

const KIND_WORD: Record<SimulationKind, string> = { band: 'band', stethoscope: 'stethoscope' }

/** A seed that depends only on the assignment: the same attachment always generates the same values for the same tick. */
const seedOf = (assignmentId: string) => Number.parseInt(assignmentId.replace(/-/g, '').slice(0, 8), 16) | 0

const covers = (a: AssignmentRow, at: number) => a.assignedAt.getTime() <= at && (!a.validUntil || a.validUntil.getTime() > at)

/** Why an assignment of a simulator record was ended by `simulation/attach` (stored with the assignment; the audit says `simulator_reclaimed`). */
export const SIMULATOR_RECLAIMED_REASON = 'Simulator moved to another consultation'

/** An open assignment of a simulator record, with what it was made for: the consultation's status, and the visit's status and day. */
export interface SimulatorUse {
  validUntil: Date | null
  encounterId: string | null
  encounterStatus: string | null
  visitId: string | null
  visitStatus: string | null
  visitDate: string | null
}

/**
 * Whether `simulation/attach` may move a SIMULATOR record (never a device record: the caller passes simulators only) away from the patient it is
 * attached to: nobody is using it now. Its attached time is over; or it was attached in a consultation that is no longer in progress (signed,
 * discarded); or it was attached outside a consultation (by staff, or a demo script) for a visit that is not open today (or for no visit). A
 * simulator attached in a consultation in progress, or by staff to a patient whose visit is open today (waiting, in triage, ready, in
 * consultation), stays where it is.
 */
export function simulatorReclaimable(u: SimulatorUse, now: number, today: string): boolean {
  if (u.validUntil && u.validUntil.getTime() <= now) return true
  if (u.encounterId) return u.encounterStatus !== 'in_progress'
  const visitOpenToday = !!u.visitId && OPEN_VISIT_STATUSES.includes(u.visitStatus as VisitStatus) && u.visitDate === today
  return !visitOpenToday
}

export interface SimulationDeps {
  db: Db
  config: Config
  settings: AppSettings
  limiter: RateLimiter
  clock: () => number
  gateway: GatewayDeps
  /** The patient's recordings as GET /api/patients/:id/auscultations returns them (devices/routes.ts). */
  listAuscultations: (facilityId: string, patientId: string) => Promise<AuscultationRecording[]>
}

export function registerDeviceSimulationRoutes(app: FastifyInstance, deps: SimulationDeps) {
  const { db, config, settings, limiter, clock, gateway } = deps

  /** A refusal, audited once with what it was about (ids and a reason, nothing else); the error handler then records nothing more. */
  const refuser =
    (req: FastifyRequest, encounterId: string, kind: SimulationKind): Refuse =>
    async (reason, patientId = null) => {
      await audit(db, req, { action: 'device.simulation_refused', outcome: 'denied', entityType: 'encounter', entityId: encounterId, patientId, details: { kind, reason, route: req.routeOptions.url ?? null } })
      req.denialAudited = true
    }

  async function allowedOr403(req: FastifyRequest, encounterId: string, kind: SimulationKind) {
    if (simulatorAllowed(config)) return
    await refuser(req, encounterId, kind)('simulator_not_allowed')
    throw new HttpError(403, 'simulator_not_allowed', 'The device simulator is not available in a clinical or production deployment.')
  }

  /** The caller's own consultation, in this facility, in progress. Anything else is refused and audited. */
  async function ownOpenConsultation(req: FastifyRequest, me: SessionUser, id: string, kind: SimulationKind) {
    const e = await db.query.encounters.findFirst({ where: and(eq(encounters.id, id), eq(encounters.facilityId, me.facilityId)) })
    if (!e) throw deniedNotFound('Consultation', { entityType: 'encounter', entityId: id, reason: 'simulation' })
    const refuse = refuser(req, id, kind)
    if (e.doctorId !== me.id) {
      await refuse('not_own_consultation', e.patientId)
      throw forbidden('Only the doctor of this consultation can run a simulator in it')
    }
    if (e.status !== 'in_progress') {
      await refuse('encounter_not_in_progress', e.patientId)
      throw conflict('This consultation is not in progress. A simulator runs only in an open consultation.', 'encounter_not_in_progress')
    }
    return e
  }

  /** The simulator record of this kind attached to the patient now (an open assignment that covers now), if there is one. */
  async function attachedSimulator(patientId: string, facilityId: string, kind: DeviceKind, now: number): Promise<{ a: AssignmentRow; d: DeviceRow } | null> {
    const rows = await db
      .select({ a: deviceAssignments, d: devices })
      .from(deviceAssignments)
      .innerJoin(devices, eq(devices.id, deviceAssignments.deviceId))
      .where(and(eq(deviceAssignments.patientId, patientId), eq(devices.facilityId, facilityId), eq(devices.kind, kind), eq(devices.integration, 'simulator'), eq(devices.status, 'active'), isNull(deviceAssignments.endedAt)))
      .orderBy(desc(deviceAssignments.assignedAt))
    return rows.find((r) => covers(r.a, now)) ?? null
  }

  async function attachedOr409(req: FastifyRequest, e: typeof encounters.$inferSelect, kind: SimulationKind, now: number) {
    const att = await attachedSimulator(e.patientId, e.facilityId, SIMULATION_DEVICE_KINDS[kind], now)
    if (att) return att
    await refuser(req, e.id, kind)('simulator_not_attached', e.patientId)
    throw conflict(`No simulator ${KIND_WORD[kind]} is attached to this patient. Attach one first.`, 'simulator_not_attached')
  }

  /** The common gates, in order: the request, simulators allowed, the caller's own open consultation, the caller's rate. */
  async function gates(req: FastifyRequest, reply: FastifyReply, kind: SimulationKind, limit: { scope: string; rule: LimitRule; per: 'user' | 'consultation' }) {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await allowedOr403(req, id, kind)
    const e = await ownOpenConsultation(req, me, id, kind)
    await enforceLimit(db, limiter, req, reply, limit.scope, limit.per === 'user' ? me.id : `${me.id}:${e.id}`, limit.rule)
    return { me, e }
  }

  // ---- Attach a free simulator record of that kind (or one nobody is using now) to the patient, for this consultation ----
  app.post('/api/encounters/:id/simulation/attach', { config: { permission: 'encounters:write' } }, async (req, reply): Promise<SimulationAttachResult> => {
    const { kind } = parse(SimulationAttachRequest, req.body)
    const { me, e } = await gates(req, reply, kind, { scope: 'device-simulation-attach', rule: ATTACH_PER_USER, per: 'user' })
    const deviceKind = SIMULATION_DEVICE_KINDS[kind]
    const refuse = refuser(req, e.id, kind)
    // Attaching needs the consent in its current wording (as attaching a device does).
    await requireConsent(db, req, { patientId: e.patientId, type: 'device_monitoring', purpose: 'simulated device' })
    const now = clock()
    const already = await attachedSimulator(e.patientId, me.facilityId, deviceKind, now)
    if (already) {
      void reply.code(200)
      return { kind, deviceId: already.d.id, label: already.d.label, assignmentId: already.a.id, alreadyAttached: true, simulated: true }
    }
    const sims = await db
      .select()
      .from(devices)
      .where(and(eq(devices.facilityId, me.facilityId), eq(devices.kind, deviceKind), eq(devices.integration, 'simulator'), eq(devices.status, 'active')))
      .orderBy(devices.label)
    if (!sims.length) {
      await refuse('no_simulator_registered', e.patientId)
      throw conflict(`No simulator ${KIND_WORD[kind]} is registered. An administrator registers one (for development: npm run demo:devices). Nothing was attached.`, 'no_simulator_registered')
    }
    const simIds = sims.map((s) => s.id)
    // Every open assignment of those records, with what it was made for (its consultation, its visit).
    const open = await db
      .select({ a: deviceAssignments, encounterStatus: encounters.status, visitStatus: visits.status, visitDate: visits.visitDate })
      .from(deviceAssignments)
      .leftJoin(encounters, eq(encounters.id, deviceAssignments.encounterId))
      .leftJoin(visits, eq(visits.id, deviceAssignments.visitId))
      .where(and(inArray(deviceAssignments.deviceId, simIds), isNull(deviceAssignments.endedAt)))
    const openOf = new Map(open.map((r) => [r.a.deviceId, r]))
    let chosen = sims.find((s) => !openOf.has(s.id))
    // None is free: one that nobody is using now (its consultation is over, its visit closed, its time over) is moved here, never one in use.
    let reclaim: (typeof open)[number] | null = null
    if (!chosen) {
      const today = await facilityToday(db, me.facilityId)
      const idle = open
        .filter((r) => simulatorReclaimable({ validUntil: r.a.validUntil, encounterId: r.a.encounterId, encounterStatus: r.encounterStatus, visitId: r.a.visitId, visitStatus: r.visitStatus, visitDate: r.visitDate }, now, today))
        .sort((x, y) => x.a.assignedAt.getTime() - y.a.assignedAt.getTime())[0]
      if (idle) {
        reclaim = idle
        chosen = sims.find((s) => s.id === idle.a.deviceId)
      }
    }
    if (!chosen) {
      await refuse('no_free_simulator', e.patientId)
      throw conflict(`Every simulator ${KIND_WORD[kind]} is in use in another patient’s consultation or open visit. End one of those assignments from the device list first. Nothing was attached.`, 'no_free_simulator')
    }
    const device = chosen
    try {
      const a = await db.transaction(async (tx) => {
        if (reclaim) {
          // Ended once, by this request only (another request that ended it first wins, and this one attaches nothing).
          const ended = await tx
            .update(deviceAssignments)
            .set({ endedAt: new Date(now), endedBy: me.id, endReason: SIMULATOR_RECLAIMED_REASON })
            .where(and(eq(deviceAssignments.id, reclaim.a.id), isNull(deviceAssignments.endedAt)))
            .returning({ id: deviceAssignments.id })
          if (!ended.length) throw conflict('This simulator was attached a moment ago by another request. Try again.', 'device_assigned')
          await audit(tx, req, { action: 'device.unassign', entityType: 'device_assignment', entityId: reclaim.a.id, patientId: reclaim.a.patientId, details: { deviceId: device.id, reason: 'simulator_reclaimed', simulated: true } })
        }
        const [row] = await tx
          .insert(deviceAssignments)
          .values({ deviceId: device.id, patientId: e.patientId, visitId: e.visitId, encounterId: e.id, validUntil: null, assignedBy: me.id, assignedAt: new Date(now) })
          .returning({ id: deviceAssignments.id })
        await audit(tx, req, { action: 'device.assign', entityType: 'device_assignment', entityId: row!.id, patientId: e.patientId, details: { deviceId: device.id, visitId: e.visitId, encounterId: e.id, validUntil: null, simulated: true, via: 'simulation' } })
        return row!
      })
      void reply.code(201)
      return { kind, deviceId: device.id, label: device.label, assignmentId: a.id, alreadyAttached: false, simulated: true }
    } catch (err) {
      // Another request attached the same record a moment earlier.
      if (pgCode(err) === '23505') throw conflict('This simulator was attached a moment ago by another request. Try again.', 'device_assigned')
      throw err
    }
  })

  // ---- One tick of the simulator band: one batch of generated values, stored as the gateway stores them (simulated) ----
  app.post('/api/encounters/:id/simulation/band-tick', { config: { permission: 'encounters:write' } }, async (req, reply): Promise<SimulationBandTickResult> => {
    const { scenario } = parse(SimulationBandTickRequest, req.body)
    const { e } = await gates(req, reply, 'band', { scope: 'device-simulation-tick', rule: TICKS_PER_CONSULTATION, per: 'consultation' })
    // What an attached device sends is stored under an earlier wording of the consent too (the gateway's rule); the store re-checks it.
    await requireConsent(db, req, { patientId: e.patientId, type: 'device_monitoring', purpose: 'simulated device readings', acceptOlderWording: true })
    const now = clock()
    const att = await attachedOr409(req, e, 'band', now)
    // The band shares the gateway's budget for its record with the simulator program.
    await enforceLimit(db, limiter, req, reply, 'device-ingest', att.d.id, settings.security.rateLimits.deviceIngestPerToken)
    // The tick is decided by the time since the simulator was attached: two tabs asking within the same five seconds ask for the same batch (same
    // idempotency key), which is stored once.
    const start = att.a.assignedAt.getTime()
    const elapsed = Math.max(0, Math.floor((now - start) / SIMULATION_TICK_MS))
    const cycle = Math.floor(elapsed / CYCLE_TICKS)
    const run: SimRun = { scenario, seed: seedOf(att.a.id), startMs: start + cycle * CYCLE_TICKS * SIMULATION_TICK_MS, intervalMs: SIMULATION_TICK_MS }
    const index = elapsed - cycle * CYCLE_TICKS
    const tick = simulatedTick(scenario, run.seed, index)
    const quiet = { stored: 0, duplicate: false, validationStatus: 'simulated' as const, scenario, measuredAt: null, kinds: [] }
    // Silence: the device is not heard from (it will show as disconnected).
    if (tick.send === 'nothing') return { sent: 'nothing', ...quiet }
    // In contact, as a gateway that presents its token is: what "disconnected" is decided from.
    await db.update(devices).set({ lastSeenAt: new Date(now) }).where(eq(devices.id, att.d.id))
    if (tick.send === 'heartbeat') return { sent: 'heartbeat', ...quiet }
    const batch = parse(DeviceReadingsRequest, simulatedBatch(run, index))
    const { status, response } = await ingestReadings(gateway, req, att.d, refuser(req, e.id, 'band'), batch, { via: 'simulation' })
    if (response.validationStatus !== 'simulated') throw new Error('A simulator batch was not stored as simulated')
    void reply.code(status)
    return { sent: 'readings', stored: response.stored, duplicate: response.duplicate, validationStatus: 'simulated', scenario, measuredAt: batch.measuredAt, kinds: batch.readings.map((r) => r.kind) }
  })

  // ---- One generated-tones recording through the simulator stethoscope (SIMULATED AUDIO) ----
  app.post('/api/encounters/:id/simulation/stethoscope', { config: { permission: 'encounters:write' } }, async (req, reply) => {
    const body = parse(SimulationStethoscopeRequest, req.body)
    const { me, e } = await gates(req, reply, 'stethoscope', { scope: 'device-simulation-recording', rule: RECORDINGS_PER_USER, per: 'user' })
    await requireConsent(db, req, { patientId: e.patientId, type: 'device_monitoring', purpose: 'simulated stethoscope recording', acceptOlderWording: true })
    const now = clock()
    const att = await attachedOr409(req, e, 'stethoscope', now)
    await enforceLimit(db, limiter, req, reply, 'device-recording', att.d.id, settings.security.rateLimits.deviceRecordingPerToken)
    // In contact, as a gateway that presents the record's token is (the device card's state is decided from it).
    await db.update(devices).set({ lastSeenAt: new Date(now) }).where(eq(devices.id, att.d.id))
    const refuse = refuser(req, e.id, 'stethoscope')
    const { assignment: a, at } = await windowFor(gateway, att.d, new Date(now), refuse, 'recording')
    if (a.patientId !== e.patientId) throw new Error('The simulator stethoscope’s assignment is not this patient’s')
    const seed = Math.floor(now / 1000) | 0
    const wav = simulatedToneWav(seed, TONE_SECONDS)
    const canonical = JSON.stringify({ recordedAt: at.toISOString(), site: body.site, sha256: sha256Hex(wav) })
    const stored = await storeBytes(config.storageDir, wav, '.wav')
    try {
      const out = await db.transaction(async (tx) => {
        await consentStillCovers(tx, a.patientId, at, 'recording')
        const batch = await claimBatch(tx, { device: att.d, assignment: a, kind: 'auscultation', idempotencyKey: `sim:${SIMULATOR_VERSION}:tones:${seed}:${now.toString(36)}`, canonical, measuredAt: at, itemCount: 1 })
        if (batch.duplicate) {
          const [existing] = await tx.select({ id: auscultationRecordings.id }).from(auscultationRecordings).where(eq(auscultationRecordings.deviceBatchId, batch.id))
          return { id: existing?.id ?? null, duplicate: true }
        }
        const [f] = await tx
          .insert(files)
          .values({ facilityId: e.facilityId, patientId: e.patientId, encounterId: e.id, kind: 'stethoscope_audio', storageKey: stored.storageKey, originalName: 'simulated-recording.wav', mimeType: 'audio/wav', sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: me.id })
          .returning({ id: files.id })
        // simulated = true because the record is a simulator: the database refuses anything else (device_simulated_guard).
        const [r] = await tx
          .insert(auscultationRecordings)
          .values({ facilityId: e.facilityId, patientId: e.patientId, encounterId: e.id, fileId: f!.id, deviceId: att.d.id, site: body.site, note: null, dataOrigin: config.dataOrigin, captureMethod: 'gateway', simulated: true, durationMs: TONE_SECONDS * 1000, deviceBatchId: batch.id, createdBy: me.id })
          .returning({ id: auscultationRecordings.id })
        await audit(tx, req, { action: 'device.ingest', entityType: 'device', entityId: att.d.id, patientId: e.patientId, details: { recording: true, site: body.site, sizeBytes: stored.sizeBytes, assignmentId: a.id, batchId: batch.id, encounterId: e.id, simulated: true, via: 'simulation' } })
        return { id: r!.id, duplicate: false }
      })
      if (out.duplicate) await discardStoredBytes(config.storageDir, stored.storageKey)
      const recording = (await deps.listAuscultations(me.facilityId, e.patientId)).find((x) => x.id === out.id)
      return reply.code(out.duplicate ? 200 : 201).send(recording)
    } catch (err) {
      await discardStoredBytes(config.storageDir, stored.storageKey)
      if (err instanceof HttpError && err.code === 'consent_required') await refuse('consent_missing_or_withdrawn', e.patientId)
      throw err
    }
  })
}
