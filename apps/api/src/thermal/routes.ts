import {
  CaptureProtocol,
  type DataOrigin,
  SaveRoisRequest,
  simulateThermalMatrix,
  THERMAL_SIM_SIZE,
  THERMAL_SIM_VERSION,
  THERMAL_TAXONOMY_VERSION,
  type ThermalCapture,
  ThermalDeviceReported,
  ThermalLabelInput,
  type ThermalModelStatus,
  type ThermalPair,
  ThermalReviewRequest,
  ThermalSimulateRequest,
  thermalStats,
  WithdrawLabelRequest,
} from '@adaxai/contracts'
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { SessionUser } from '../auth/sessions.ts'
import type { Config } from '../config.ts'
import { consentState, requireConsent } from '../consents/service.ts'
import { type Db, type DbOrTx, pgCode } from '../db/client.ts'
import { simulatorAllowed } from '../devices/gateway.ts'
import { devices, encounters, files, patients, thermalCaptures, thermalLabels, thermalRois, users } from '../db/schema.ts'
import { discardStoredBytes, readStoredBytes, type StoredFile, storeBytes } from '../files/storage.ts'
import { readUpload } from '../files/upload.ts'
import { badRequest, conflict, forbidden, HttpError, notFound } from '../http/errors.ts'
import { parse } from '../http/validate.ts'
import { getPatientOr404 } from '../patients/service.ts'
import type { RoiGeometry, ThermalService } from './client.ts'

const IdParams = z.object({ id: z.uuid() })
type CaptureRow = typeof thermalCaptures.$inferSelect
type RoiRow = typeof thermalRois.$inferSelect

/**
 * SHA-256 of the public FLIR sample files used for development
 * (scripts/fetch-thermal-samples.mjs). An upload of one of these is recorded
 * as `public_sample`, whatever the deployment's data origin.
 */
const PUBLIC_SAMPLE_SHA256 = new Set([
  '6cb40ab3967ca890fc90b2f4a53e6c4974d1865b4274f15fc8710da684591409',
  '7cbe5d9a04fb4daea8d750cbf8ea050f3c3a2fd5b530e756dee4d6b8f6615b58',
  'c2ae58509119695cea72c27a344569e6e53196e968e5e091671e8f7d1813a74f',
])

/** A file upload that names a signed or discarded consultation (409 encounter_not_in_progress). */
export const FILE_INTO_CLOSED_CONSULTATION = 'This consultation is signed or discarded, so no image can be added to it. Upload the image to the patient without a consultation, or into a consultation in progress.'

/**
 * A live capture's time, as the camera reported it, is taken only near the moment it arrives: at most this far ahead of the server's clock (a
 * tablet or camera clock a little fast) and at most this long before it. A time outside that is a wrong clock, not a live capture: refused.
 */
const FUTURE_TOLERANCE_MS = 5 * 60_000
const PAST_TOLERANCE_MS = 24 * 3_600_000

/**
 * The text fields of an upload (sent BEFORE the file). `simulator` is not among the sources: a simulated capture is made by the simulator route
 * only, never uploaded. `capturedAt` and `deviceReported` come with a live capture only (from the device bridge).
 */
const UploadFields = z.object({
  captureSource: z.enum(['live_capture', 'gallery_import', 'file_upload']).default('file_upload'),
  encounterId: z.uuid().optional(),
  capturedAt: z.iso.datetime({ offset: true }).optional(),
})

/** What the simulator's capture says about its "camera": nothing, because there is none. */
const SIMULATOR_CAMERA = { make: null, model: 'ADAXAI thermal simulator (SIMULATED)', dateTime: null }
const NO_PARAMETERS = { emissivity: null, objectDistanceM: null, reflectedTempC: null, atmosphericTempC: null, relativeHumidity: null, irWindowTempC: null, irWindowTransmission: null }

/** float32, little-endian, row-major: the layout of every stored matrix. NaN (no reading) stays NaN. */
function float32le(m: Float32Array): Buffer {
  const b = Buffer.alloc(m.length * 4)
  for (let i = 0; i < m.length; i++) b.writeFloatLE(m[i]!, i * 4)
  return b
}

/** Area of a polygon (shoelace), in square pixels. */
function polygonArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[(i + 1) % points.length]!
    twice += x1 * y2 - x2 * y1
  }
  return Math.abs(twice) / 2
}

async function loadLabels(db: Db, captureId: string): Promise<ThermalCapture['labels']> {
  const labeller = alias(users, 'labeller')
  const withdrawer = alias(users, 'withdrawer')
  const rows = await db
    .select({ l: thermalLabels, by: labeller.fullName, wby: withdrawer.fullName })
    .from(thermalLabels)
    .leftJoin(labeller, eq(labeller.id, thermalLabels.labelledBy))
    .leftJoin(withdrawer, eq(withdrawer.id, thermalLabels.withdrawnBy))
    .where(eq(thermalLabels.captureId, captureId))
    .orderBy(asc(thermalLabels.labelledAt))
  return rows.map(({ l, by, wby }) => ({
    id: l.id,
    scope: l.scope as 'capture' | 'roi',
    roiLabel: l.roiLabel,
    code: l.code,
    referenceStandard: l.referenceStandard,
    certainty: l.certainty,
    note: l.note,
    taxonomyVersion: l.taxonomyVersion,
    labelledById: l.labelledBy,
    labelledByName: by,
    labelledAt: l.labelledAt.toISOString(),
    withdrawn: l.withdrawnAt ? { at: l.withdrawnAt.toISOString(), byName: wby, reason: l.withdrawReason ?? '' } : null,
  }))
}

async function toCapture(db: Db, c: CaptureRow): Promise<ThermalCapture> {
  const creator = alias(users, 'creator')
  const reviewer = alias(users, 'reviewer')
  const [names] = await db
    .select({ createdByName: creator.fullName, reviewedByName: reviewer.fullName, originalName: files.originalName, rawSha256: files.sha256, deviceLabel: devices.label })
    .from(thermalCaptures)
    .leftJoin(creator, eq(creator.id, thermalCaptures.createdBy))
    .leftJoin(reviewer, eq(reviewer.id, thermalCaptures.reviewedBy))
    .innerJoin(files, eq(files.id, thermalCaptures.rawFileId))
    .leftJoin(devices, eq(devices.id, thermalCaptures.deviceId))
    .where(eq(thermalCaptures.id, c.id))
  const roiCreator = alias(users, 'roi_creator')
  const rois = await db
    .select({ r: thermalRois, by: roiCreator.fullName })
    .from(thermalRois)
    .leftJoin(roiCreator, eq(roiCreator.id, thermalRois.createdBy))
    .where(eq(thermalRois.captureId, c.id))
    .orderBy(asc(thermalRois.sortOrder))
  return {
    id: c.id,
    patientId: c.patientId,
    encounterId: c.encounterId,
    status: c.status as ThermalCapture['status'],
    originalName: names?.originalName ?? null,
    width: c.width,
    height: c.height,
    minC: c.minC,
    maxC: c.maxC,
    meanC: c.meanC,
    camera: c.camera as ThermalCapture['camera'],
    parameters: c.parameters as ThermalCapture['parameters'],
    protocol: c.protocol as ThermalCapture['protocol'],
    extractor: c.extractor as ThermalCapture['extractor'],
    rawFileId: c.rawFileId,
    rawSha256: names?.rawSha256 ?? '',
    matrixFileId: c.matrixFileId,
    visibleFileId: c.visibleFileId,
    stdC: c.stdC ?? null,
    captureSource: c.captureSource as ThermalCapture['captureSource'],
    simulated: c.simulated,
    capturedAt: c.capturedAt?.toISOString() ?? null,
    device: c.deviceId && names?.deviceLabel ? { id: c.deviceId, label: names.deviceLabel } : null,
    deviceReported: (c.deviceReported ?? null) as ThermalCapture['deviceReported'],
    rois: rois.map(({ r, by }) => ({
      id: r.id,
      label: r.label,
      shape: r.shape as ThermalCapture['rois'][number]['shape'],
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      points: (r.points ?? null) as [number, number][] | null,
      pairWith: r.pairWith,
      note: r.note,
      stats: r.stats as ThermalCapture['rois'][number]['stats'],
      createdByName: by,
      createdAt: r.createdAt.toISOString(),
    })),
    pairs: c.pairStats as ThermalPair[],
    review: c.reviewedAt ? { byName: names?.reviewedByName ?? null, at: c.reviewedAt.toISOString(), note: c.reviewNote } : null,
    createdAt: c.createdAt.toISOString(),
    createdByName: names?.createdByName ?? null,
    dataOrigin: c.dataOrigin as DataOrigin,
    labels: await loadLabels(db, c.id),
  }
}

/** A stored region as the thermal service takes it. */
const geometryOf = (r: RoiRow, id: string): RoiGeometry => ({ id, shape: r.shape as RoiGeometry['shape'], x: r.x, y: r.y, width: r.width, height: r.height, points: (r.points ?? null) as [number, number][] | null })

/** What a capture row says about where it came from, beyond the measurements (all fixed once stored: trigger in migration 0031). */
type CaptureValues = Omit<typeof thermalCaptures.$inferInsert, 'facilityId' | 'patientId' | 'encounterId' | 'rawFileId' | 'matrixFileId' | 'visibleFileId' | 'createdBy'>

export function registerThermalRoutes(app: FastifyInstance, deps: { db: Db; config: Config; thermal: ThermalService }) {
  const { db, config, thermal } = deps

  async function getCaptureOr404(me: SessionUser, id: string) {
    const c = await db.query.thermalCaptures.findFirst({ where: and(eq(thermalCaptures.id, id), eq(thermalCaptures.facilityId, me.facilityId)) })
    if (!c) throw notFound('Thermal image')
    return c
  }

  /**
   * The consultation a live capture, an imported image or a simulated capture is taken in: the caller's own consultation of this patient, in
   * this facility, still in progress. Another doctor's consultation, a signed or discarded one, another patient's or another facility's is refused.
   * Checked again where the capture is stored (`consultationStillOpen`): the image may take a while to process.
   */
  async function ownOpenConsultation(me: SessionUser, patientId: string, encounterId: string | undefined) {
    if (!encounterId) throw badRequest('Some fields are invalid', [{ path: 'encounterId', message: 'Required: the consultation this image is taken in' }])
    const e = await db.query.encounters.findFirst({ where: and(eq(encounters.id, encounterId), eq(encounters.patientId, patientId), eq(encounters.facilityId, me.facilityId)) })
    if (!e) throw badRequest('Some fields are invalid', [{ path: 'encounterId', message: 'Not a consultation of this patient' }])
    if (e.status !== 'in_progress') throw conflict('This consultation is not in progress. A thermal image is taken into an open consultation.', 'encounter_not_in_progress')
    if (e.doctorId !== me.id) throw forbidden('Only the doctor of this consultation can take thermal images into it')
    return e
  }

  /**
   * The last look at the patient's consent, inside the transaction that stores and holding the grant (as the device gateway does): a withdrawal
   * that commits while the image is being processed either comes first, and nothing is stored, or waits until the image has been stored.
   */
  async function consentStillCovers(tx: DbOrTx, patientId: string, encounterId: string | null) {
    const { state } = await consentState(tx, patientId, 'thermal_imaging', encounterId ?? undefined, true)
    if (state === 'granted') return
    const code = state === 'withdrawn' ? 'consent_withdrawn' : state === 'outdated' ? 'consent_outdated' : 'consent_required'
    throw new HttpError(409, code, 'The patient’s consent to thermal imaging no longer covers this image. Nothing was stored.')
  }

  /**
   * The last look at the consultation a live capture, an imported image or a simulated capture is taken in, inside the transaction that stores
   * it and holding the consultation's row (as the consent check holds the grant): still the caller's own, in this facility, in progress. A sign
   * or a discard that commits while the image is being processed either comes first, and nothing is stored, or waits until the image is stored.
   */
  async function consultationStillOpen(tx: DbOrTx, me: SessionUser, encounterId: string) {
    const [open] = await tx
      .select({ id: encounters.id })
      .from(encounters)
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, me.facilityId), eq(encounters.status, 'in_progress'), eq(encounters.doctorId, me.id)))
      .for('share')
    if (!open) throw conflict('This consultation was signed or discarded while the image was being processed. Nothing was stored.', 'encounter_not_in_progress')
  }

  /**
   * The last look at the consultation a file upload is filed under, inside the transaction that stores it and holding its row: still in
   * progress (whoever's it is). A sign or a discard that commits while the image is processed either comes first, and nothing is stored, or
   * waits until the image has been stored.
   */
  async function consultationStillInProgress(tx: DbOrTx, me: SessionUser, encounterId: string) {
    const [open] = await tx
      .select({ id: encounters.id })
      .from(encounters)
      .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, me.facilityId), eq(encounters.status, 'in_progress')))
      .for('share')
    if (!open) throw conflict('This consultation was signed or discarded while the image was being processed. Nothing was stored.', 'encounter_not_in_progress')
  }

  /** A capture that was not stored, for the audit log (why, and how it arrived; never the image). */
  const refused = (req: FastifyRequest, patientId: string, details: Record<string, unknown>, outcome: 'failure' | 'denied' = 'failure') =>
    audit(db, req, { action: 'thermal.capture_refused', outcome, entityType: 'patient', entityId: patientId, patientId, details })

  /**
   * Stores one capture: its original (or the simulator's descriptor), its matrix, its visible image if there is one, the capture row and the
   * audit event, in one transaction after the last consent check (and, for a capture taken in a consultation, the last look at that
   * consultation). If anything is refused, the bytes written for it are removed again.
   */
  async function persist(
    req: FastifyRequest,
    me: SessionUser,
    o: {
      patientId: string
      encounterId: string | null
      /** A live capture, an import or a simulated capture: taken into the caller's own consultation in progress, which is checked again here. */
      openConsultation: boolean
      /** A file upload filed under a consultation: that consultation (whoever's it is) must still be in progress, checked again here. */
      inProgressConsultation?: boolean
      /** How the capture arrived (source, simulated, case and seed), for the audit of a refusal. */
      arrival: Record<string, unknown>
      raw: { data: Buffer; ext: string; originalName: string; mimeType: string }
      matrix: Buffer
      visible: Buffer | null
      values: (raw: StoredFile) => CaptureValues
      details: (c: CaptureRow, raw: StoredFile) => Record<string, unknown>
    },
  ): Promise<CaptureRow> {
    const written: StoredFile[] = []
    try {
      const raw = await storeBytes(config.storageDir, o.raw.data, o.raw.ext)
      written.push(raw)
      const matrix = await storeBytes(config.storageDir, o.matrix, '.f32')
      written.push(matrix)
      const visible = o.visible ? await storeBytes(config.storageDir, o.visible, '.jpg') : null
      if (visible) written.push(visible)
      return await db.transaction(async (tx) => {
        await consentStillCovers(tx, o.patientId, o.encounterId)
        if (o.openConsultation) await consultationStillOpen(tx, me, o.encounterId!)
        else if (o.inProgressConsultation) await consultationStillInProgress(tx, me, o.encounterId!)
        const base = { facilityId: me.facilityId, patientId: o.patientId, encounterId: o.encounterId, uploadedBy: me.id }
        const [rawFile] = await tx.insert(files).values({ ...base, kind: 'thermal_raw', storageKey: raw.storageKey, originalName: o.raw.originalName, mimeType: o.raw.mimeType, sizeBytes: raw.sizeBytes, sha256: raw.sha256 }).returning({ id: files.id })
        const [matrixFile] = await tx.insert(files).values({ ...base, kind: 'thermal_matrix', storageKey: matrix.storageKey, originalName: 'matrix.f32', mimeType: 'application/octet-stream', sizeBytes: matrix.sizeBytes, sha256: matrix.sha256 }).returning({ id: files.id })
        const visibleFile = visible
          ? (await tx.insert(files).values({ ...base, kind: 'thermal_visible', storageKey: visible.storageKey, originalName: 'visible.jpg', mimeType: 'image/jpeg', sizeBytes: visible.sizeBytes, sha256: visible.sha256 }).returning({ id: files.id }))[0]
          : null
        const [c] = await tx
          .insert(thermalCaptures)
          .values({ ...o.values(raw), facilityId: me.facilityId, patientId: o.patientId, encounterId: o.encounterId, rawFileId: rawFile!.id, matrixFileId: matrixFile!.id, visibleFileId: visibleFile?.id ?? null, createdBy: me.id })
          .returning()
        // Sizes, versions, provenance and checksums only: never pixels, never the file.
        await audit(tx, req, { action: 'thermal.upload', entityType: 'thermal_capture', entityId: c!.id, patientId: o.patientId, details: o.details(c!, raw) })
        return c!
      })
    } catch (e) {
      for (const f of written) await discardStoredBytes(config.storageDir, f.storageKey)
      if (e instanceof HttpError && e.code.startsWith('consent_')) {
        await audit(db, req, { action: 'consent.blocked', outcome: 'denied', entityType: 'patient', entityId: o.patientId, patientId: o.patientId, details: { type: 'thermal_imaging', purpose: 'thermal image', code: e.code, atStore: true } })
      }
      if (e instanceof HttpError && e.code === 'encounter_not_in_progress') await refused(req, o.patientId, { ...o.arrival, encounterId: o.encounterId, reason: e.code, atStore: true }, 'denied')
      throw e
    }
  }

  /**
   * Upload a radiometric FLIR JPEG: a file chosen on the thermal pages (`file_upload`), an earlier radiometric file from the tablet
   * (`gallery_import`) or a live capture handed over by the native device bridge (`live_capture`). Whatever the source, the file itself must be a
   * radiometric FLIR file: the thermal service decodes it, and anything else is refused. Requires the patient's consent to thermal imaging.
   */
  app.post('/api/patients/:id/thermal', { config: { permission: 'thermal:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    const up = await readUpload(req, 'a thermal image')
    const data = up.data
    const field = (name: string) => up.fields[name] || undefined
    if (field('captureSource') === 'simulator') throw badRequest('Some fields are invalid', [{ path: 'captureSource', message: 'A simulated capture cannot be uploaded: only the simulator makes one' }])
    const f = parse(UploadFields, { captureSource: field('captureSource'), encounterId: field('encounterId'), capturedAt: field('capturedAt') })
    let protocolInput: unknown
    try {
      protocolInput = JSON.parse(field('protocol') ?? '{}')
    } catch {
      throw badRequest('Some fields are invalid', [{ path: 'protocol', message: 'Invalid capture details' }])
    }
    const protocol = parse(CaptureProtocol, protocolInput)
    let deviceReported: ThermalDeviceReported | null = null
    if (field('deviceReported')) {
      let input: unknown
      try {
        input = JSON.parse(field('deviceReported')!)
      } catch {
        throw badRequest('Some fields are invalid', [{ path: 'deviceReported', message: 'Invalid device details' }])
      }
      deviceReported = parse(ThermalDeviceReported, input)
    }
    const live = f.captureSource === 'live_capture'
    if (!live && f.capturedAt) throw badRequest('Some fields are invalid', [{ path: 'capturedAt', message: 'Only a live capture carries the camera’s capture time' }])
    if (!live && deviceReported) throw badRequest('Some fields are invalid', [{ path: 'deviceReported', message: 'Only a live capture carries what the device bridge reported' }])
    const capturedAt = f.capturedAt ? new Date(f.capturedAt) : null

    let encounterId: string | null = null
    if (f.captureSource === 'file_upload') {
      if (f.encounterId) {
        const e = await db.query.encounters.findFirst({ where: and(eq(encounters.id, f.encounterId), eq(encounters.patientId, id), eq(encounters.facilityId, me.facilityId)) })
        if (!e) throw badRequest('Some fields are invalid', [{ path: 'encounterId', message: 'Not a consultation of this patient' }])
        // Doctor HERO final: a file is filed under a consultation only while it is in progress. A signed record is frozen and a discarded
        // draft is not part of the record, so an image added to either afterwards would change what was signed or attach to nothing.
        if (e.status !== 'in_progress') {
          await refused(req, id, { captureSource: f.captureSource, simulated: false, encounterId: e.id, reason: 'encounter_not_in_progress' }, 'denied')
          throw conflict(FILE_INTO_CLOSED_CONSULTATION, 'encounter_not_in_progress')
        }
        encounterId = e.id
      }
    } else {
      encounterId = (await ownOpenConsultation(me, id, f.encounterId)).id
    }
    if (capturedAt) {
      const now = Date.now()
      const ahead = capturedAt.getTime() > now + FUTURE_TOLERANCE_MS
      if (ahead || capturedAt.getTime() < now - PAST_TOLERANCE_MS) {
        await refused(req, id, { captureSource: f.captureSource, simulated: false, encounterId, reason: 'captured_at_out_of_range' })
        throw new HttpError(
          422,
          'captured_at_out_of_range',
          `The capture time the camera reported is more than ${FUTURE_TOLERANCE_MS / 60_000} minutes ahead of this server’s clock or more than ${PAST_TOLERANCE_MS / 3_600_000} hours before the image arrived. Check the date and time of the camera and the tablet. Nothing was stored.`,
          [{ path: 'capturedAt', message: ahead ? 'In the future' : `More than ${PAST_TOLERANCE_MS / 3_600_000} hours ago` }],
        )
      }
    }
    // A consultation-only grant for this consultation covers it, as an ongoing grant does.
    await requireConsent(db, req, { patientId: id, type: 'thermal_imaging', purpose: 'thermal image', encounterId: encounterId ?? undefined })

    // The Python service validates and decodes; 422 rejections are passed through, a file without radiometric data saying so plainly.
    let ex: Awaited<ReturnType<ThermalService['extract']>>
    try {
      ex = await thermal.extract(data, 'upload.jpg')
    } catch (e) {
      if (e instanceof HttpError) {
        await refused(req, id, { captureSource: f.captureSource, simulated: false, encounterId, reason: e.code })
        if (e.code === 'not_radiometric') throw new HttpError(422, 'not_radiometric', `NON-RADIOMETRIC: ${e.message}`)
      }
      throw e
    }
    if (ex.matrix.length !== ex.width * ex.height * 4) throw new HttpError(502, 'thermal_invalid', 'The thermal service returned an inconsistent matrix.')

    // The registered camera this came from, matched by the serial number the bridge reported: an active thermal camera of this facility, never a
    // simulator record. No match leaves the device empty; what the bridge reported is kept as it was reported either way.
    const serial = deviceReported?.serialNumber?.trim()
    const device = serial
      ? await db.query.devices.findFirst({ where: and(eq(devices.facilityId, me.facilityId), eq(devices.serialNumber, serial), eq(devices.kind, 'thermal_camera'), eq(devices.status, 'active'), ne(devices.integration, 'simulator')) })
      : undefined
    const deviceId = device?.id ?? null

    const created = await persist(req, me, {
      patientId: id,
      encounterId,
      openConsultation: f.captureSource !== 'file_upload',
      // A file filed under a consultation: that consultation must still be in progress when the image is stored (any doctor's or nurse's upload).
      inProgressConsultation: f.captureSource === 'file_upload' && encounterId !== null,
      arrival: { captureSource: f.captureSource, simulated: false },
      raw: { data, ext: '.jpg', originalName: (up.filename || 'thermal.jpg').slice(0, 120), mimeType: 'image/jpeg' },
      matrix: ex.matrix,
      visible: ex.visibleJpeg,
      values: (raw) => ({
        width: ex.width,
        height: ex.height,
        minC: ex.minC,
        maxC: ex.maxC,
        meanC: ex.meanC,
        stdC: ex.stdC ?? null,
        camera: ex.camera,
        parameters: ex.parameters,
        extractor: ex.extractor,
        protocol,
        dataOrigin: PUBLIC_SAMPLE_SHA256.has(raw.sha256) ? 'public_sample' : config.dataOrigin,
        captureSource: f.captureSource,
        simulated: false,
        deviceId,
        capturedAt,
        deviceReported,
      }),
      details: (c, raw) => ({ width: ex.width, height: ex.height, extractor: ex.extractor.version, dataOrigin: c.dataOrigin, captureSource: f.captureSource, simulated: false, deviceId, encounterId, sha256: raw.sha256 }),
    })
    return reply.code(201).send(await toCapture(db, created))
  })

  /**
   * A SIMULATED capture (V6): a matrix generated by the thermal simulator for a case and seed (packages/contracts/src/thermalSim.ts), stored
   * like a capture so that the whole pipeline can be exercised without a camera. It is not a measurement of anyone: it is stored as `simulator`,
   * `simulated`, data origin `synthetic` (database constraints), has no visible image, and is never given to the patient portal, a model or an
   * assistant, a dataset export or a consultation note. It exists only where the data is not clinical and the deployment is not production.
   * The cases `invalid_capture` and `processing_failure` reproduce the failure paths: they are refused and audited, and nothing is stored.
   */
  app.post('/api/patients/:id/thermal/simulate', { config: { permission: 'thermal:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    if (!simulatorAllowed(config)) {
      await audit(db, req, { action: 'thermal.capture_refused', outcome: 'denied', details: { captureSource: 'simulator', reason: 'simulator_not_allowed' } })
      req.denialAudited = true
      throw new HttpError(403, 'simulator_not_allowed', 'The thermal simulator is not available in a clinical or production deployment.')
    }
    const body = parse(ThermalSimulateRequest, req.body)
    await getPatientOr404(db, me.facilityId, id)
    const e = await ownOpenConsultation(me, id, body.encounterId)
    await requireConsent(db, req, { patientId: id, type: 'thermal_imaging', purpose: 'thermal image', encounterId: e.id })
    const sim = { captureSource: 'simulator', simulated: true, case: body.case, seed: body.seed, encounterId: e.id }
    if (body.case === 'invalid_capture') {
      await refused(req, id, { ...sim, reason: 'thermal_invalid' })
      throw new HttpError(422, 'thermal_invalid', 'Invalid capture (SIMULATED): the simulated frame has no usable thermal data. Nothing was stored.')
    }
    if (body.case === 'processing_failure') {
      await refused(req, id, { ...sim, reason: 'thermal_processing_failed' })
      throw new HttpError(502, 'thermal_processing_failed', 'Processing failed (SIMULATED): the simulator reproduced a failure of thermal processing. Nothing was stored.')
    }
    const matrix = simulateThermalMatrix(body.case, body.seed)
    const s = thermalStats(matrix)
    if (s.minC === null || s.maxC === null || s.meanC === null) {
      await refused(req, id, { ...sim, reason: 'no_finite_pixels' })
      throw new HttpError(422, 'thermal_invalid', 'Invalid capture (SIMULATED): no pixel has a reading. Nothing was stored.')
    }
    const { minC, maxC, meanC } = s
    const { width, height } = THERMAL_SIM_SIZE
    // The "original" of a simulated capture is what it was generated from, so that it can be generated again and checked.
    const descriptor = Buffer.from(JSON.stringify({ simulator: THERMAL_SIM_VERSION, case: body.case, seed: body.seed, width, height }))
    const created = await persist(req, me, {
      patientId: id,
      encounterId: e.id,
      openConsultation: true,
      arrival: { captureSource: 'simulator', simulated: true, case: body.case, seed: body.seed },
      raw: { data: descriptor, ext: '.json', originalName: `simulated-${body.case}-${body.seed}.json`, mimeType: 'application/json' },
      matrix: float32le(matrix),
      visible: null,
      values: () => ({
        width,
        height,
        minC,
        maxC,
        meanC,
        stdC: s.stdC,
        camera: SIMULATOR_CAMERA,
        parameters: NO_PARAMETERS,
        extractor: { name: 'thermal-sim', version: THERMAL_SIM_VERSION },
        protocol: body.protocol,
        dataOrigin: 'synthetic',
        captureSource: 'simulator',
        simulated: true,
        deviceId: null,
        capturedAt: null,
        deviceReported: null,
      }),
      details: (_c, raw) => ({ width, height, extractor: THERMAL_SIM_VERSION, dataOrigin: 'synthetic', ...sim, deviceId: null, sha256: raw.sha256 }),
    })
    return reply.code(201).send(await toCapture(db, created))
  })

  app.get('/api/patients/:id/thermal', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    const rows = await db.select().from(thermalCaptures).where(and(eq(thermalCaptures.patientId, id), eq(thermalCaptures.facilityId, me.facilityId))).orderBy(desc(thermalCaptures.createdAt))
    await audit(db, req, { action: 'thermal.list', entityType: 'patient', entityId: id, patientId: id })
    return { captures: await Promise.all(rows.map((r) => toCapture(db, r))) }
  })

  /** Recent captures across the facility, e.g. those awaiting a doctor's review. Simulated ones are marked so. */
  app.get('/api/thermal', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const q = parse(z.object({ status: z.enum(['draft', 'approved', 'rejected']).optional() }), req.query)
    const rows = await db
      .select({ c: thermalCaptures, given: patients.givenName, family: patients.familyName, mrn: patients.mrn })
      .from(thermalCaptures)
      .innerJoin(patients, eq(patients.id, thermalCaptures.patientId))
      .where(and(eq(thermalCaptures.facilityId, me.facilityId), q.status ? eq(thermalCaptures.status, q.status) : undefined))
      .orderBy(desc(thermalCaptures.createdAt))
      .limit(50)
    await audit(db, req, { action: 'thermal.list', details: { status: q.status ?? null, count: rows.length, patientIds: [...new Set(rows.map((r) => r.c.patientId))] } })
    return {
      captures: rows.map(({ c, given, family, mrn }) => ({
        id: c.id,
        patientId: c.patientId,
        patientName: [given, family].filter(Boolean).join(' '),
        mrn,
        status: c.status,
        bodyRegion: (c.protocol as { bodyRegion: string }).bodyRegion,
        captureSource: c.captureSource,
        simulated: c.simulated,
        createdAt: c.createdAt.toISOString(),
      })),
    }
  })

  /**
   * Whether a thermal model is installed (V6). None is: the thermal service says so, and if it cannot be reached the answer is still
   * "unavailable", with that reason. Nothing in the product shows a model output this status does not describe.
   */
  app.get('/api/thermal/model-status', { config: { permission: 'patients:read' } }, async (): Promise<ThermalModelStatus> => thermal.modelStatus())

  app.get('/api/thermal/:id', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const c = await getCaptureOr404(me, id)
    await audit(db, req, { action: 'thermal.read', entityType: 'thermal_capture', entityId: id, patientId: c.patientId })
    return toCapture(db, c)
  })

  /**
   * Replaces the regions of a draft capture; statistics are computed by the thermal service (pixel centres inside the region, readings only).
   * A polygon's bounding box is worked out here from its points. A region saved again unchanged keeps its id, author and time.
   */
  app.put('/api/thermal/:id/rois', { config: { permission: 'thermal:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(SaveRoisRequest, req.body)
    const c = await getCaptureOr404(me, id)
    if (c.status !== 'draft') throw conflict('This thermal image has been reviewed; its regions can no longer change', 'thermal_reviewed')
    const beyond = (i: number) => badRequest('Some fields are invalid', [{ path: `rois.${i}`, message: 'Region extends beyond the image' }])
    const shapes = body.rois.map((r, i) => {
      if (r.shape !== 'polygon') {
        if (r.x + r.width > c.width + 0.01 || r.y + r.height > c.height + 0.01) throw beyond(i)
        return { x: r.x, y: r.y, width: r.width, height: r.height, points: null }
      }
      const points = r.points!
      if (points.some(([x, y]) => x > c.width + 0.01 || y > c.height + 0.01)) throw beyond(i)
      if (polygonArea(points) < 1e-6) throw badRequest('Some fields are invalid', [{ path: `rois.${i}.points`, message: 'A polygon must enclose an area' }])
      const xs = points.map((p) => p[0])
      const ys = points.map((p) => p[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, points }
    })
    const matrixFile = (await db.query.files.findFirst({ where: eq(files.id, c.matrixFileId) }))!
    const matrix = await readStoredBytes(config.storageDir, matrixFile.storageKey)
    const keyOf = (label: string) => label.trim().toLowerCase()
    const pairs = body.rois.filter((r) => r.pairWith).map((r) => ({ a: keyOf(r.label), b: keyOf(r.pairWith!) }))
    const uniquePairs = pairs.filter((p, i) => pairs.findIndex((q) => (q.a === p.a && q.b === p.b) || (q.a === p.b && q.b === p.a)) === i)
    const result = body.rois.length
      ? await thermal.roiStats({ width: c.width, height: c.height, matrix, rois: body.rois.map((r, i) => ({ id: keyOf(r.label), shape: r.shape, ...shapes[i]! })), pairs: uniquePairs })
      : { rois: [], pairs: [] }
    const labelOf = new Map(body.rois.map((r) => [keyOf(r.label), r.label.trim()]))

    // Which saved regions come back unchanged: matched by id (when the client sends the region's id) or by label, and the same in every respect.
    const before = await db.select().from(thermalRois).where(eq(thermalRois.captureId, id))
    const sentIds = (((req.body as { rois?: unknown } | null)?.rois ?? []) as { id?: unknown }[]).map((r) => (typeof r?.id === 'string' ? r.id : null))
    const near = (a: number, b: number) => Math.abs(a - b) < 0.006
    const samePoints = (a: unknown, b: [number, number][] | null) =>
      a === null || a === undefined ? b === null : Array.isArray(a) && b !== null && a.length === b.length && b.every(([x, y], k) => near(Number(a[k]?.[0]), x) && near(Number(a[k]?.[1]), y))
    const used = new Set<string>()
    const kept = body.rois.map((r, i) => {
      const s = shapes[i]!
      const old = before.find((o) => !used.has(o.id) && o.id === sentIds[i]) ?? before.find((o) => !used.has(o.id) && keyOf(o.label) === keyOf(r.label))
      const unchanged =
        old &&
        old.label === r.label.trim() &&
        old.shape === r.shape &&
        near(old.x, s.x) &&
        near(old.y, s.y) &&
        near(old.width, s.width) &&
        near(old.height, s.height) &&
        samePoints(old.points, s.points) &&
        (old.pairWith ?? null) === (r.pairWith?.trim() || null) &&
        (old.note ?? null) === (r.note ?? null)
      if (!unchanged) return null
      used.add(old.id)
      return old
    })

    await db.transaction(async (tx) => {
      await tx.delete(thermalRois).where(eq(thermalRois.captureId, id))
      if (body.rois.length) {
        await tx.insert(thermalRois).values(
          body.rois.map((r, i) => ({
            ...(kept[i] ? { id: kept[i].id, createdBy: kept[i].createdBy, createdAt: kept[i].createdAt } : { createdBy: me.id }),
            captureId: id,
            label: r.label.trim(),
            shape: r.shape,
            ...shapes[i]!,
            pairWith: r.pairWith?.trim() || null,
            note: r.note ?? null,
            stats: result.rois.find((s) => s.id === keyOf(r.label))!.stats,
            sortOrder: i,
          })),
        )
      }
      await tx
        .update(thermalCaptures)
        .set({ pairStats: result.pairs.map((p) => ({ ...p, a: labelOf.get(p.a) ?? p.a, b: labelOf.get(p.b) ?? p.b })) })
        .where(eq(thermalCaptures.id, id))
      await audit(tx, req, { action: 'thermal.rois_save', entityType: 'thermal_capture', entityId: id, patientId: c.patientId, details: { rois: body.rois.length, polygons: body.rois.filter((r) => r.shape === 'polygon').length, unchanged: kept.filter(Boolean).length } })
    })
    return toCapture(db, (await getCaptureOr404(me, id))!)
  })

  /** Doctor review. Approval means the measurements are fit to keep on record, not a diagnosis. A simulated capture can be reviewed (for demonstration); it stays simulated. */
  app.post('/api/thermal/:id/review', { config: { permission: 'thermal:approve' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(ThermalReviewRequest, req.body)
    const c = await getCaptureOr404(me, id)
    if (c.status !== 'draft') throw conflict('Already reviewed', 'thermal_reviewed')
    if (body.decision === 'rejected' && !body.note) throw badRequest('Some fields are invalid', [{ path: 'note', message: 'Give a reason for rejecting' }])
    await db.transaction(async (tx) => {
      await tx.update(thermalCaptures).set({ status: body.decision, reviewNote: body.note ?? null, reviewedBy: me.id, reviewedAt: new Date() }).where(and(eq(thermalCaptures.id, id), eq(thermalCaptures.status, 'draft')))
      await audit(tx, req, { action: 'thermal.review', entityType: 'thermal_capture', entityId: id, patientId: c.patientId, details: { decision: body.decision, simulated: c.simulated } })
    })
    return toCapture(db, (await getCaptureOr404(me, id))!)
  })

  /**
   * Experimental rule-based flags (hotspots, asymmetry between paired regions).
   * Computed on request and never stored: NOT validated, NOT a diagnosis.
   */
  app.get('/api/thermal/:id/flags', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const c = await getCaptureOr404(me, id)
    const rois = await db.select().from(thermalRois).where(eq(thermalRois.captureId, id)).orderBy(asc(thermalRois.sortOrder))
    const matrixFile = (await db.query.files.findFirst({ where: eq(files.id, c.matrixFileId) }))!
    const matrix = await readStoredBytes(config.storageDir, matrixFile.storageKey)
    const keyOf = (label: string) => label.trim().toLowerCase()
    const known = new Set(rois.map((r) => keyOf(r.label)))
    const pairs = rois.filter((r) => r.pairWith && known.has(keyOf(r.pairWith))).map((r) => ({ a: keyOf(r.label), b: keyOf(r.pairWith!) }))
    const uniquePairs = pairs.filter((p, i) => pairs.findIndex((q) => (q.a === p.a && q.b === p.b) || (q.a === p.b && q.b === p.a)) === i)
    const result = await thermal.flags({
      width: c.width,
      height: c.height,
      matrix,
      rois: rois.map((r) => geometryOf(r, keyOf(r.label))),
      pairs: uniquePairs,
    })
    const labelOf = new Map(rois.map((r) => [keyOf(r.label), r.label]))
    await audit(db, req, { action: 'thermal.flags', entityType: 'thermal_capture', entityId: id, patientId: c.patientId, details: { version: result.version, hotspots: result.hotspots.length, simulated: c.simulated } })
    return { ...result, asymmetry: result.asymmetry.map((a) => ({ ...a, a: labelOf.get(a.a) ?? a.a, b: labelOf.get(a.b) ?? a.b })) }
  })

  /** A doctor's label on an approved capture (whole image or one region). */
  app.post('/api/thermal/:id/labels', { config: { permission: 'thermal:label' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(ThermalLabelInput, req.body)
    const c = await getCaptureOr404(me, id)
    if (c.status !== 'approved') throw conflict('Only approved thermal images can be labelled', 'thermal_not_approved')
    let roiLabel: string | null = null
    if (body.scope === 'roi') {
      const rois = await db.select({ label: thermalRois.label }).from(thermalRois).where(eq(thermalRois.captureId, id))
      roiLabel = rois.find((r) => r.label.toLowerCase() === body.roiLabel!.trim().toLowerCase())?.label ?? null
      if (!roiLabel) throw badRequest('Some fields are invalid', [{ path: 'roiLabel', message: 'No region with that label' }])
    }
    try {
      await db.transaction(async (tx) => {
        const [l] = await tx
          .insert(thermalLabels)
          .values({ captureId: id, scope: body.scope, roiLabel, code: body.code, referenceStandard: body.referenceStandard, certainty: body.certainty, note: body.note ?? null, taxonomyVersion: THERMAL_TAXONOMY_VERSION, labelledBy: me.id })
          .returning({ id: thermalLabels.id })
        await audit(tx, req, { action: 'thermal.label_add', entityType: 'thermal_label', entityId: l!.id, patientId: c.patientId, details: { captureId: id, scope: body.scope, code: body.code } })
      })
    } catch (e) {
      if (pgCode(e) === '23505') throw conflict(`You have already labelled this ${body.scope === 'roi' ? 'region' : 'image'}. Withdraw your label first to change it.`, 'label_exists')
      throw e
    }
    return reply.code(201).send(await toCapture(db, c))
  })

  /** Withdraws one of the caller's own labels. The label stays on record, marked withdrawn. */
  app.post('/api/thermal/:id/labels/:labelId/withdraw', { config: { permission: 'thermal:label' } }, async (req) => {
    const me = currentUser(req)
    const { id, labelId } = parse(z.object({ id: z.uuid(), labelId: z.uuid() }), req.params)
    const body = parse(WithdrawLabelRequest, req.body)
    const c = await getCaptureOr404(me, id)
    const l = await db.query.thermalLabels.findFirst({ where: and(eq(thermalLabels.id, labelId), eq(thermalLabels.captureId, id)) })
    if (!l) throw notFound('Label')
    if (l.labelledBy !== me.id) throw forbidden('Only the doctor who added a label can withdraw it')
    if (l.withdrawnAt) throw conflict('This label has already been withdrawn', 'label_withdrawn')
    await db.transaction(async (tx) => {
      await tx.update(thermalLabels).set({ withdrawnAt: new Date(), withdrawnBy: me.id, withdrawReason: body.reason }).where(and(eq(thermalLabels.id, labelId), isNull(thermalLabels.withdrawnAt)))
      await audit(tx, req, { action: 'thermal.label_withdraw', entityType: 'thermal_label', entityId: labelId, patientId: c.patientId, details: { captureId: id } })
    })
    return toCapture(db, c)
  })
}
