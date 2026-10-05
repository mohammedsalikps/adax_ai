import path from 'node:path'
import crypto from 'node:crypto'
import {
  AssignDeviceRequest,
  type AuscultationRecording,
  AuscultationSite,
  type Device,
  type DeviceHeartbeatResponse,
  DeviceInput,
  type DeviceList,
  DeviceReadingsRequest,
  EndAssignmentRequest,
  IdempotencyKey,
  OptionalText,
  UpdateDeviceRequest,
  usesGateway,
} from '@adaxai/contracts'
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CONTAINER_OF_MIME, sniffAudio } from '../ai/audio-sniff.ts'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Config } from '../config.ts'
import { requireConsent } from '../consents/service.ts'
import { type Db, pgCode } from '../db/client.ts'
import { auscultationRecordings, deviceAssignments, devices, encounters, files, patients, users, visits } from '../db/schema.ts'
import { discardStoredBytes, storeBytes } from '../files/storage.ts'
import { readUpload, type Upload } from '../files/upload.ts'
import { badRequest, conflict, HttpError, notFound } from '../http/errors.ts'
import type { RateLimiter } from '../http/rate-limit.ts'
import { parse } from '../http/validate.ts'
import { facilityToday, getPatientOr404 } from '../patients/service.ts'
import type { AppSettings } from '../settings/schema.ts'
import { assignmentAt, claimBatch, consentStillCovers, gatewayDevice, type GatewayDeps, ingestReadings, repeatIsNews, sha256Hex, simulatorAllowed, tokenHash, windowFor } from './gateway.ts'
import { patientDeviceReadings } from './readings.ts'

const IdParams = z.object({ id: z.uuid() })
const AUDIO_EXT: Record<string, string> = { 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/ogg': '.ogg', 'audio/webm': '.webm' }
const OPEN_VISIT = ['waiting', 'in_triage', 'ready', 'in_consultation'] as const
/** The live readings of an open consultation are read every few seconds: the audit log records that someone was watching, once per this many seconds. */
const READ_AUDIT_WINDOW_SECONDS = 300
const MAX_ASSIGNMENT_DAYS = 31

/**
 * Device integration BOUNDARY. No wearable band or smart stethoscope has been
 * connected or tested in this build: the registry, assignment, gateway
 * ingestion API and file upload are the documented interfaces a real device
 * integration would use (docs/DEVICES.md). Device readings are stored as
 * source = device, validation = device_unverified; what a record registered as
 * a SIMULATOR sends is stored as `simulated` and is never a measurement.
 */
export function registerDeviceRoutes(app: FastifyInstance, deps: { db: Db; config: Config; settings: AppSettings; limiter: RateLimiter; clock?: (() => number) | undefined }) {
  const { db, config, settings, limiter } = deps
  const clock = deps.clock ?? Date.now
  const gateway: GatewayDeps = { db, limiter, settings, config, clock }

  async function deviceOr404(me: SessionUser, id: string) {
    const d = await db.query.devices.findFirst({ where: and(eq(devices.id, id), eq(devices.facilityId, me.facilityId)) })
    if (!d) throw notFound('Device')
    return d
  }

  /** Admins manage devices but do not read patient records: they see that a device is in use, not by whom. */
  async function toDevices(rows: (typeof devices.$inferSelect)[], viewer: SessionUser): Promise<Device[]> {
    const showPatient = viewer.role !== 'admin'
    const ids = rows.map((r) => r.id)
    const assigner = alias(users, 'assigner')
    const open = ids.length
      ? await db
          .select({ a: deviceAssignments, given: patients.givenName, family: patients.familyName, mrn: patients.mrn, by: assigner.fullName })
          .from(deviceAssignments)
          .innerJoin(patients, eq(patients.id, deviceAssignments.patientId))
          .leftJoin(assigner, eq(assigner.id, deviceAssignments.assignedBy))
          .where(and(inArray(deviceAssignments.deviceId, ids), isNull(deviceAssignments.endedAt)))
      : []
    return rows.map((d) => {
      const a = open.find((x) => x.a.deviceId === d.id)
      return {
        id: d.id,
        kind: d.kind as Device['kind'],
        label: d.label,
        manufacturer: d.manufacturer,
        model: d.model,
        serialNumber: d.serialNumber,
        status: d.status as Device['status'],
        integration: d.integration as Device['integration'],
        simulated: d.integration === 'simulator',
        notes: d.notes,
        hasToken: !!d.ingestTokenHash,
        tokenCreatedAt: d.tokenCreatedAt?.toISOString() ?? null,
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        assignment: a
          ? {
              id: a.a.id,
              patientId: showPatient ? a.a.patientId : null,
              patientName: showPatient ? [a.given, a.family].filter(Boolean).join(' ') : null,
              mrn: showPatient ? a.mrn : null,
              assignedAt: a.a.assignedAt.toISOString(),
              assignedByName: a.by,
              visitId: showPatient ? a.a.visitId : null,
              encounterId: showPatient ? a.a.encounterId : null,
              validUntil: a.a.validUntil?.toISOString() ?? null,
            }
          : null,
        createdAt: d.createdAt.toISOString(),
      }
    })
  }

  // ---- Registry (admin) ----
  app.get('/api/devices', { config: { permission: 'devices:read' } }, async (req): Promise<DeviceList> => {
    const me = currentUser(req)
    const rows = await db.select().from(devices).where(eq(devices.facilityId, me.facilityId)).orderBy(devices.label)
    const list = await toDevices(rows, me)
    // The list shows which patients are on monitoring devices, so the read is audited with them.
    const patientIds = list.flatMap((d) => (d.assignment?.patientId ? [d.assignment.patientId] : []))
    await audit(db, req, { action: 'device.list_read', details: { devices: list.length, patientIds } })
    return { devices: list, simulatorAllowed: simulatorAllowed(config) }
  })

  app.post('/api/admin/devices', { config: { permission: 'devices:manage' } }, async (req, reply) => {
    const me = currentUser(req)
    const body = parse(DeviceInput, req.body)
    // A simulator generates values. It exists for development and tests, where the data is not clinical, and nowhere else.
    if (body.integration === 'simulator' && !simulatorAllowed(config)) throw conflict('A simulator cannot be registered in a clinical or production deployment', 'simulator_not_allowed')
    try {
      const [d] = await db.insert(devices).values({ ...body, manufacturer: body.manufacturer ?? null, model: body.model ?? null, notes: body.notes ?? null, facilityId: me.facilityId, createdBy: me.id }).returning()
      await audit(db, req, { action: 'device.register', entityType: 'device', entityId: d!.id, details: { kind: body.kind, integration: body.integration, simulated: body.integration === 'simulator' } })
      return reply.code(201).send((await toDevices([d!], me))[0])
    } catch (e) {
      if (pgCode(e) === '23505') throw conflict('A device with that serial number is already registered', 'serial_taken')
      throw e
    }
  })

  app.patch('/api/admin/devices/:id', { config: { permission: 'devices:manage' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    // Only what was sent is changed: the registration form's default for the integration must not apply to an edit that does not mention it.
    const sent = new Set(Object.keys((req.body ?? {}) as object))
    const body = Object.fromEntries(Object.entries(parse(UpdateDeviceRequest, req.body)).filter(([k]) => sent.has(k))) as z.output<typeof UpdateDeviceRequest>
    const before = await deviceOr404(me, id)
    // A record is a simulator from the start or never: readings stored through it stay what they were stored as (the database refuses this too).
    if (body.integration !== undefined && (body.integration === 'simulator') !== (before.integration === 'simulator')) throw conflict('A device record cannot be turned into a simulator, or a simulator into a device. Register a new record instead.', 'simulator_fixed')
    if (body.status === 'retired') {
      const open = await db.query.deviceAssignments.findFirst({ where: and(eq(deviceAssignments.deviceId, id), isNull(deviceAssignments.endedAt)) })
      if (open) throw conflict('End the device’s current assignment before retiring it', 'device_assigned')
    }
    // A retired device, or one no longer integrated through a gateway, cannot post readings: its token is revoked.
    const revoke = (body.status ?? before.status) === 'retired' || !usesGateway(body.integration ?? before.integration)
    const tokenReset = revoke && before.ingestTokenHash ? { ingestTokenHash: null, tokenCreatedAt: null } : {}
    const [d] = await db
      .update(devices)
      .set({ ...body, ...tokenReset, updatedAt: new Date() })
      .where(eq(devices.id, id))
      .returning()
      .catch((e: unknown) => {
        if (pgCode(e) === '23505') throw conflict('A device with that serial number is already registered', 'serial_taken')
        throw e
      })
    await audit(db, req, { action: 'device.update', entityType: 'device', entityId: id, details: { changed: Object.keys(body), tokenRevoked: 'ingestTokenHash' in tokenReset } })
    return (await toDevices([d!], me))[0]
  })

  /** Issues a new gateway token (shown once; only its hash is stored). Replaces any previous token. */
  app.post('/api/admin/devices/:id/token', { config: { permission: 'devices:manage' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const d = await deviceOr404(me, id)
    if (d.status !== 'active' || !usesGateway(d.integration)) throw conflict('Only active devices integrated through a gateway get a token', 'device_not_gateway')
    if (d.integration === 'simulator' && !simulatorAllowed(config)) throw conflict('A simulator may not post in a clinical or production deployment', 'simulator_not_allowed')
    const token = `adxdev_${crypto.randomBytes(32).toString('base64url')}`
    await db.update(devices).set({ ingestTokenHash: tokenHash(token), tokenCreatedAt: new Date(), updatedAt: new Date() }).where(eq(devices.id, id))
    await audit(db, req, { action: 'device.token_issue', entityType: 'device', entityId: id, details: { simulated: d.integration === 'simulator' } })
    return reply.code(201).send({ token, note: 'Shown once. Store it in the gateway configuration; it cannot be retrieved later.' })
  })

  app.delete('/api/admin/devices/:id/token', { config: { permission: 'devices:manage' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await deviceOr404(me, id)
    await db.update(devices).set({ ingestTokenHash: null, tokenCreatedAt: null, updatedAt: new Date() }).where(eq(devices.id, id))
    await audit(db, req, { action: 'device.token_revoke', entityType: 'device', entityId: id })
    return { revoked: true }
  })

  // ---- Assignment (nurse, doctor) ----
  app.post('/api/devices/:id/assignments', { config: { permission: 'devices:assign' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(AssignDeviceRequest, req.body)
    const d = await deviceOr404(me, id)
    if (d.status !== 'active') throw conflict('This device is retired', 'device_retired')
    await getPatientOr404(db, me.facilityId, body.patientId)
    await requireConsent(db, req, { patientId: body.patientId, type: 'device_monitoring', purpose: 'device assignment' })
    let visitId = body.visitId ?? null
    let encounterId: string | null = null
    if (body.visitId) {
      const v = await db.query.visits.findFirst({ where: and(eq(visits.id, body.visitId), eq(visits.patientId, body.patientId), eq(visits.facilityId, me.facilityId)) })
      if (!v) throw badRequest('Some fields are invalid', [{ path: 'visitId', message: 'Not a visit of this patient' }])
    }
    if (body.encounterId) {
      // Attached in a consultation: that consultation and its visit are recorded with the assignment.
      const e = await db.query.encounters.findFirst({ where: and(eq(encounters.id, body.encounterId), eq(encounters.patientId, body.patientId), eq(encounters.facilityId, me.facilityId)) })
      if (!e) throw badRequest('Some fields are invalid', [{ path: 'encounterId', message: 'Not a consultation of this patient' }])
      if (e.status !== 'in_progress') throw badRequest('Some fields are invalid', [{ path: 'encounterId', message: 'This consultation is not in progress' }])
      if (visitId && visitId !== e.visitId) throw badRequest('Some fields are invalid', [{ path: 'visitId', message: 'Not the visit of that consultation' }])
      encounterId = e.id
      visitId = e.visitId
    }
    if (!visitId) {
      // No visit named: the patient's open visit of today, if there is one, so that readings reach the queue and the consultation.
      const today = await facilityToday(db, me.facilityId)
      const open = await db.query.visits.findFirst({ where: and(eq(visits.patientId, body.patientId), eq(visits.facilityId, me.facilityId), eq(visits.visitDate, today), inArray(visits.status, [...OPEN_VISIT])) })
      visitId = open?.id ?? null
    }
    const now = clock()
    const validUntil = body.validUntil ? new Date(body.validUntil) : null
    if (validUntil && (validUntil.getTime() <= now + 60_000 || validUntil.getTime() > now + MAX_ASSIGNMENT_DAYS * 86_400_000)) throw badRequest('Some fields are invalid', [{ path: 'validUntil', message: `Choose a time from a minute to ${MAX_ASSIGNMENT_DAYS} days from now` }])
    try {
      const [a] = await db
        .insert(deviceAssignments)
        .values({ deviceId: id, patientId: body.patientId, visitId, encounterId, validUntil, assignedBy: me.id, assignedAt: new Date(now) })
        .returning({ id: deviceAssignments.id })
      await audit(db, req, { action: 'device.assign', entityType: 'device_assignment', entityId: a!.id, patientId: body.patientId, details: { deviceId: id, visitId, encounterId, validUntil: validUntil?.toISOString() ?? null, simulated: d.integration === 'simulator' } })
    } catch (e) {
      if (pgCode(e) === '23505') throw conflict('This device is already assigned. End that assignment first.', 'device_assigned')
      throw e
    }
    return reply.code(201).send((await toDevices([d], me))[0])
  })

  app.post('/api/device-assignments/:id/end', { config: { permission: 'devices:assign' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const { reason } = parse(EndAssignmentRequest, req.body)
    // Looked up within the caller's facility: another facility's assignment is "not found".
    const [row] = await db.select({ a: deviceAssignments }).from(deviceAssignments).innerJoin(devices, eq(devices.id, deviceAssignments.deviceId)).where(and(eq(deviceAssignments.id, id), eq(devices.facilityId, me.facilityId)))
    if (!row) throw notFound('Assignment')
    const a = row.a
    const d = await deviceOr404(me, a.deviceId)
    if (a.endedAt) throw conflict('This assignment has already ended', 'assignment_ended')
    await db.update(deviceAssignments).set({ endedAt: new Date(clock()), endedBy: me.id, endReason: reason }).where(and(eq(deviceAssignments.id, id), isNull(deviceAssignments.endedAt)))
    await audit(db, req, { action: 'device.unassign', entityType: 'device_assignment', entityId: id, patientId: a.patientId, details: { deviceId: d.id } })
    return (await toDevices([d], me))[0]
  })

  // ---- What the devices attached to a patient are saying now (doctor, nurse) ----
  app.get('/api/patients/:id/device-readings', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const p = await getPatientOr404(db, me.facilityId, id)
    const out = await patientDeviceReadings(db, p, settings, config, clock())
    // An open consultation reads this every few seconds. The audit log says who was watching whose readings, once per window, not once per read.
    if (limiter.hit(`device-readings-read:${me.id}:${id}`, { max: 1, windowSeconds: READ_AUDIT_WINDOW_SECONDS }).allowed) {
      await audit(db, req, { action: 'device.readings_read', entityType: 'patient', entityId: id, patientId: id, details: { devices: out.devices.length, simulated: out.devices.filter((d) => d.simulated).length, repeatsNotLoggedForSeconds: READ_AUDIT_WINDOW_SECONDS } })
    }
    return out
  })

  // ---- Gateway (device token, no user session) ----
  app.post('/api/device-ingest/readings', { config: { public: true } }, async (req, reply) => {
    const { device, refuse } = await gatewayDevice(gateway, req, reply)
    const body = parse(DeviceReadingsRequest, req.body)
    const { status, response } = await ingestReadings(gateway, req, device, refuse, body)
    return reply.code(status).send(response)
  })

  /** "Still here": lets a gateway that has nothing to send show that it is in contact, which is what tells stale readings from a disconnected device. */
  app.post('/api/device-ingest/heartbeat', { config: { public: true } }, async (req, reply): Promise<DeviceHeartbeatResponse> => {
    const { device } = await gatewayDevice(gateway, req, reply)
    const now = clock()
    return { ok: true, serverTime: new Date(now).toISOString(), simulator: device.integration === 'simulator', assigned: !!(await assignmentAt(db, device.id, new Date(now))) }
  })

  // ---- Stethoscope recordings ----
  /** The file must BE the audio container its type says it is: the first bytes decide, not the name or the declared type. */
  function audioOr400(up: Upload): string {
    const ext = AUDIO_EXT[up.mimetype]
    if (!ext || !settings.uploads.audio.types.includes(up.mimetype)) throw badRequest('Unsupported audio format', [{ path: 'file', message: 'Use WAV, MP3, M4A, OGG or WebM audio' }])
    if (sniffAudio(up.data) !== CONTAINER_OF_MIME[up.mimetype]) throw badRequest('Unsupported audio format', [{ path: 'file', message: 'The file is not the audio format it says it is' }])
    if (up.data.length > settings.uploads.audio.maxMb * 1024 * 1024) throw new HttpError(413, 'too_large', `Audio is larger than ${settings.uploads.audio.maxMb} MB`)
    return ext
  }
  const fieldsOf = (up: Upload) => Object.fromEntries(Object.entries(up.fields).map(([k, v]) => [k, v || undefined]))
  const Duration = z.coerce.number().int().min(1).max(3_600_000).optional()

  const AuscultationFields = z.object({
    site: AuscultationSite,
    note: OptionalText(300),
    encounterId: z.uuid().optional(),
    deviceId: z.uuid().optional(),
    /** A file chosen by staff, or a recording made in the browser from an audio input they chose. */
    captureMethod: z.enum(['file_upload', 'browser_recording']).default('file_upload'),
    durationMs: Duration,
    inputLabel: OptionalText(120),
  })

  app.post('/api/patients/:id/auscultations', { config: { permission: 'observations:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    await requireConsent(db, req, { patientId: id, type: 'device_monitoring', purpose: 'stethoscope recording' })
    const up = await readUpload(req, 'a stethoscope recording')
    const ext = audioOr400(up)
    const fields = parse(AuscultationFields, fieldsOf(up))
    if (fields.encounterId && !(await db.query.encounters.findFirst({ where: and(eq(encounters.id, fields.encounterId), eq(encounters.patientId, id), eq(encounters.facilityId, me.facilityId)) }))) throw badRequest('Some fields are invalid', [{ path: 'encounterId', message: 'Not a consultation of this patient' }])
    if (fields.deviceId) {
      const d = await deviceOr404(me, fields.deviceId)
      if (d.kind !== 'smart_stethoscope') throw badRequest('Some fields are invalid', [{ path: 'deviceId', message: 'Not a stethoscope' }])
      // What staff record or upload is not generated by a simulator, so it is not filed under one.
      if (d.integration === 'simulator') throw badRequest('Some fields are invalid', [{ path: 'deviceId', message: 'A simulator is not a stethoscope: recordings made by staff are not filed under it' }])
    }
    const stored = await storeBytes(config.storageDir, up.data, ext)
    const rec = await db
      .transaction(async (tx) => {
      const [f] = await tx
        .insert(files)
        .values({ facilityId: me.facilityId, patientId: id, encounterId: fields.encounterId ?? null, kind: 'stethoscope_audio', storageKey: stored.storageKey, originalName: path.basename(up.filename || `recording${ext}`).slice(0, 120), mimeType: up.mimetype, sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: me.id })
        .returning({ id: files.id })
      const [r] = await tx
        .insert(auscultationRecordings)
        .values({
          facilityId: me.facilityId,
          patientId: id,
          encounterId: fields.encounterId ?? null,
          fileId: f!.id,
          deviceId: fields.deviceId ?? null,
          site: fields.site,
          note: fields.note ?? null,
          dataOrigin: config.dataOrigin,
          captureMethod: fields.captureMethod,
          durationMs: fields.durationMs ?? null,
          inputLabel: fields.captureMethod === 'browser_recording' ? (fields.inputLabel ?? null) : null,
          createdBy: me.id,
        })
        .returning({ id: auscultationRecordings.id })
      await audit(tx, req, { action: 'auscultation.upload', entityType: 'auscultation_recording', entityId: r!.id, patientId: id, details: { site: fields.site, mimeType: up.mimetype, sizeBytes: stored.sizeBytes, captureMethod: fields.captureMethod } })
      return r!.id
      })
      .catch(async (e: unknown) => {
        // Nothing was recorded: the bytes written for it are not left behind.
        await discardStoredBytes(config.storageDir, stored.storageKey)
        throw e
      })
    return reply.code(201).send((await listAuscultations(me.facilityId, id)).find((x) => x.id === rec))
  })

  const GatewayAuscultationFields = z.object({ recordedAt: z.iso.datetime({ offset: true }), site: AuscultationSite, durationMs: Duration, idempotencyKey: IdempotencyKey.optional() })

  /**
   * The stethoscope side of the gateway boundary: a gateway for a smart stethoscope posts one recording with the device's token. Like a reading, it
   * belongs to the patient the device was assigned to when it was recorded, needs that patient's consent, and is stored once. Never tested with a
   * stethoscope: the only thing that has posted here is the simulator, whose recordings are generated tones and are stored as simulated.
   */
  app.post('/api/device-ingest/auscultations', { config: { public: true } }, async (req, reply) => {
    // A recording is a file of megabytes, not a few numbers: far fewer are allowed per token than readings.
    const { device, refuse } = await gatewayDevice(gateway, req, reply, settings.security.rateLimits.deviceRecordingPerToken, 'device-recording')
    if (device.kind !== 'smart_stethoscope') {
      await refuse('not_a_stethoscope')
      throw new HttpError(422, 'kind_not_allowed', 'Only a device registered as a smart stethoscope may send recordings')
    }
    // Before the file is read at all: a stethoscope that has not been assigned to anyone within the time a recording may arrive late has nothing
    // that could be stored, whatever it sends.
    const earliest = new Date(clock() - settings.devices.maxLateHours * 3_600_000)
    const assignedLately = await db.query.deviceAssignments.findFirst({ columns: { id: true }, where: and(eq(deviceAssignments.deviceId, device.id), or(isNull(deviceAssignments.endedAt), gt(deviceAssignments.endedAt, earliest))) })
    if (!assignedLately) {
      await refuse('no_assignment_at_measurement_time')
      throw conflict('The device was not assigned to a patient when this recording was made; it was not stored', 'outside_assignment')
    }
    const up = await readUpload(req, 'a stethoscope recording')
    const ext = audioOr400(up)
    const fields = parse(GatewayAuscultationFields, fieldsOf(up))
    const stamped = new Date(fields.recordedAt)
    const { assignment: a, at: recordedAt } = await windowFor(gateway, device, stamped, refuse, 'recording')
    const simulated = device.integration === 'simulator'
    const canonical = JSON.stringify({ recordedAt: stamped.toISOString(), site: fields.site, sha256: sha256Hex(up.data) })
    const stored = await storeBytes(config.storageDir, up.data, ext)
    try {
      const out = await db.transaction(async (tx) => {
        await consentStillCovers(tx, a.patientId, recordedAt, 'recording')
        const batch = await claimBatch(tx, { device, assignment: a, kind: 'auscultation', idempotencyKey: fields.idempotencyKey, canonical, measuredAt: recordedAt, itemCount: 1 })
        if (batch.duplicate) {
          const [existing] = await tx.select({ id: auscultationRecordings.id }).from(auscultationRecordings).where(eq(auscultationRecordings.deviceBatchId, batch.id))
          if (repeatIsNews(gateway, batch.id)) await audit(tx, req, { action: 'device.ingest', actorUserId: null, actorRole: 'device', entityType: 'device', entityId: device.id, patientId: a.patientId, facilityId: device.facilityId, details: { duplicate: true, batchId: batch.id, recording: true } })
          return { status: 200 as const, body: { stored: 0, duplicate: true, simulated, batchId: batch.id, recordingId: existing?.id ?? null } }
        }
        // The consultation the device was attached in, while that consultation is still open; otherwise the recording belongs to the patient only.
        const e = a.encounterId ? await tx.query.encounters.findFirst({ where: and(eq(encounters.id, a.encounterId), eq(encounters.status, 'in_progress')) }) : undefined
        const [f] = await tx
          .insert(files)
          .values({ facilityId: device.facilityId, patientId: a.patientId, encounterId: e?.id ?? null, kind: 'stethoscope_audio', storageKey: stored.storageKey, originalName: `${simulated ? 'simulated' : 'device'}-recording${ext}`, mimeType: up.mimetype, sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: null })
          .returning({ id: files.id })
        const [r] = await tx
          .insert(auscultationRecordings)
          .values({ facilityId: device.facilityId, patientId: a.patientId, encounterId: e?.id ?? null, fileId: f!.id, deviceId: device.id, site: fields.site, note: null, dataOrigin: config.dataOrigin, captureMethod: 'gateway', simulated, durationMs: fields.durationMs ?? null, deviceBatchId: batch.id, createdBy: null })
          .returning({ id: auscultationRecordings.id })
        await audit(tx, req, { action: 'device.ingest', actorUserId: null, actorRole: 'device', entityType: 'device', entityId: device.id, patientId: a.patientId, facilityId: device.facilityId, details: { recording: true, site: fields.site, sizeBytes: stored.sizeBytes, assignmentId: a.id, batchId: batch.id, simulated } })
        return { status: 201 as const, body: { stored: 1, duplicate: false, simulated, batchId: batch.id, recordingId: r!.id } }
      })
      // A repeat stored nothing: the bytes written for it are not part of any record.
      if (out.body.duplicate) await discardStoredBytes(config.storageDir, stored.storageKey)
      return reply.code(out.status).send(out.body)
    } catch (e) {
      await discardStoredBytes(config.storageDir, stored.storageKey)
      if (e instanceof HttpError && (e.code === 'idempotency_conflict' || e.code === 'consent_required')) await refuse(e.code === 'consent_required' ? 'consent_missing_or_withdrawn' : e.code, a.patientId)
      throw e
    }
  })

  async function listAuscultations(facilityId: string, patientId: string): Promise<AuscultationRecording[]> {
    const rows = await db
      .select({ r: auscultationRecordings, f: files, by: users.fullName, dev: devices.label })
      .from(auscultationRecordings)
      .innerJoin(files, eq(files.id, auscultationRecordings.fileId))
      .leftJoin(users, eq(users.id, auscultationRecordings.createdBy))
      .leftJoin(devices, eq(devices.id, auscultationRecordings.deviceId))
      .where(and(eq(auscultationRecordings.patientId, patientId), eq(auscultationRecordings.facilityId, facilityId)))
      .orderBy(desc(auscultationRecordings.createdAt))
    return rows.map(({ r, f, by, dev }) => ({
      id: r.id,
      patientId: r.patientId,
      encounterId: r.encounterId,
      fileId: r.fileId,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      site: r.site as AuscultationRecording['site'],
      note: r.note,
      device: r.deviceId && dev ? { id: r.deviceId, label: dev } : null,
      captureMethod: r.captureMethod as AuscultationRecording['captureMethod'],
      simulated: r.simulated,
      durationMs: r.durationMs,
      inputLabel: r.inputLabel,
      dataOrigin: r.dataOrigin,
      createdAt: r.createdAt.toISOString(),
      createdByName: by,
    }))
  }

  app.get('/api/patients/:id/auscultations', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    await audit(db, req, { action: 'auscultation.list', entityType: 'patient', entityId: id, patientId: id })
    return { recordings: await listAuscultations(me.facilityId, id) }
  })
}
