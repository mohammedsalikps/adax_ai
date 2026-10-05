import { z } from 'zod'
import { OptionalText, Text } from './common.ts'
import { VitalItem, VitalKind } from './vitals.ts'

export const DEVICE_KINDS = { wearable_band: 'Wearable band', smart_stethoscope: 'Smart stethoscope', thermal_camera: 'Thermal camera', other: 'Other device' } as const
export type DeviceKind = keyof typeof DEVICE_KINDS
export const DeviceKind = z.enum(Object.keys(DEVICE_KINDS) as [DeviceKind, ...DeviceKind[]])

/**
 * How data from the device reaches ADAXAI. None of these has been tested with real hardware in this build.
 * `simulator` is not a device at all: a program that generates values (scripts and tests). It is fixed when the record is made, it can never
 * become a device record or the other way round, and everything that arrives through it is stored and shown as simulated.
 */
export const DEVICE_INTEGRATIONS = {
  not_integrated: 'Not integrated (registry only)',
  manual_upload: 'Files uploaded by staff',
  gateway_api: 'Gateway posts readings (API boundary)',
  simulator: 'Simulator (generated values, not a device)',
} as const
export type DeviceIntegration = keyof typeof DEVICE_INTEGRATIONS
export const DeviceIntegration = z.enum(Object.keys(DEVICE_INTEGRATIONS) as [DeviceIntegration, ...DeviceIntegration[]])

/** The integrations that post through the token-authenticated gateway API (and therefore hold a token). */
export const usesGateway = (integration: string): boolean => integration === 'gateway_api' || integration === 'simulator'

/**
 * THE GATE: which kinds of reading each kind of device may send through the gateway. Anything else is refused and nothing of the batch is
 * stored. Blood pressure is in no list on purpose: no cuff or cuffless pipeline has been validated, so blood pressure is entered by staff.
 * Widening a list is a product and safety decision (a validated pipeline, the risk register, a decision record), not a setting.
 */
export const DEVICE_READING_KINDS: Record<DeviceKind, readonly VitalKind[]> = {
  wearable_band: ['heart_rate', 'spo2', 'temperature', 'respiratory_rate'],
  smart_stethoscope: [],
  thermal_camera: [],
  other: [],
}
export const kindAllowedFrom = (device: DeviceKind, kind: VitalKind): boolean => DEVICE_READING_KINDS[device].includes(kind)

export const DeviceInput = z.object({
  kind: DeviceKind,
  label: Text(80),
  manufacturer: OptionalText(80),
  model: OptionalText(80),
  serialNumber: Text(80),
  integration: DeviceIntegration.default('not_integrated'),
  notes: OptionalText(500),
})
export type DeviceInput = z.input<typeof DeviceInput>
export const UpdateDeviceRequest = DeviceInput.partial().extend({ status: z.enum(['active', 'retired']).optional() })
export type UpdateDeviceRequest = z.input<typeof UpdateDeviceRequest>

export const Device = z.object({
  id: z.uuid(),
  kind: DeviceKind,
  label: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string(),
  status: z.enum(['active', 'retired']),
  integration: DeviceIntegration,
  /** True for a simulator record: nothing that arrives through it is a measurement. */
  simulated: z.boolean(),
  notes: z.string().nullable(),
  hasToken: z.boolean(),
  tokenCreatedAt: z.string().nullable(),
  /** The last time the gateway (or simulator) presented this device's token, whatever it sent. */
  lastSeenAt: z.string().nullable(),
  /** Patient identity is null for viewers who manage devices but do not see patient records (admins). */
  assignment: z
    .object({
      id: z.uuid(),
      patientId: z.uuid().nullable(),
      patientName: z.string().nullable(),
      mrn: z.string().nullable(),
      assignedAt: z.string(),
      assignedByName: z.string().nullable(),
      /** The visit and consultation the device was attached for, when there is one (never shown to administrators). */
      visitId: z.uuid().nullable(),
      encounterId: z.uuid().nullable(),
      /** Readings measured at or after this time are refused (null: until the assignment is ended). */
      validUntil: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string(),
})
export type Device = z.infer<typeof Device>

export const DeviceList = z.object({ devices: z.array(Device), /** False in a clinical or production deployment: no simulator can be registered or post there. */ simulatorAllowed: z.boolean() })
export type DeviceList = z.infer<typeof DeviceList>

export const AssignDeviceRequest = z.object({
  patientId: z.uuid(),
  visitId: z.uuid().optional(),
  /** The consultation the device is attached in: its visit is recorded with the assignment. */
  encounterId: z.uuid().optional(),
  validUntil: z.iso.datetime({ offset: true }).optional(),
})
export type AssignDeviceRequest = z.input<typeof AssignDeviceRequest>
export const EndAssignmentRequest = z.object({ reason: Text(200) })

/** A key the gateway chooses for one batch: sending the same batch again stores nothing twice. */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/, '8 to 100 letters, digits, dots, colons, dashes or underscores')

/**
 * Body a device gateway sends to POST /api/device-ingest/readings with
 * `Authorization: Bearer <device token>` and `x-adaxai-csrf: 1`. The patient
 * is the one the device was assigned to when the readings were measured; the gateway never names one.
 * A `measuredAt` ahead of the server's clock (a gateway clock that runs fast; more than five minutes ahead is refused) is stored as the time
 * the batch arrived, so that a reading can never be "measured" later than it was received; one from longer ago than the server allows
 * (`devices.maxLateHours`) is refused.
 */
export const DeviceReadingsRequest = z.object({
  measuredAt: z.iso.datetime({ offset: true }),
  readings: z
    .array(VitalItem)
    .min(1)
    .max(20)
    .refine((xs) => new Set(xs.map((x) => x.kind)).size === xs.length, 'Each kind of reading can appear once in a batch'),
  /** Optional. Without it the batch is identified by what it says (device, time and values), so an exact repeat is still stored once. */
  idempotencyKey: IdempotencyKey.optional(),
})
export type DeviceReadingsRequest = z.input<typeof DeviceReadingsRequest>

export const ReadingValidation = z.enum(['device_unverified', 'simulated'])
export const DeviceIngestResponse = z.object({
  stored: z.number().int(),
  /** True when this batch had already been stored: nothing was stored again. */
  duplicate: z.boolean(),
  validationStatus: ReadingValidation,
  batchId: z.uuid(),
})
export type DeviceIngestResponse = z.infer<typeof DeviceIngestResponse>

export const DeviceHeartbeatResponse = z.object({ ok: z.literal(true), serverTime: z.string(), /** Whether the record behind this token is a simulator. A simulator program stops if it is not. */ simulator: z.boolean(), assigned: z.boolean() })
export type DeviceHeartbeatResponse = z.infer<typeof DeviceHeartbeatResponse>

// ---------------------------------------------------------------------------
// Reading states (V5): how current a device value is. Decided by one function, used by the API and the screen alike.
// ---------------------------------------------------------------------------

export const READING_STATES = {
  live: 'Live',
  stale: 'Stale',
  disconnected: 'Disconnected',
  no_data: 'No data',
  unavailable: 'Unavailable',
} as const
export type ReadingState = keyof typeof READING_STATES
export const ReadingState = z.enum(Object.keys(READING_STATES) as [ReadingState, ...ReadingState[]])

export interface ReadingStateThresholds {
  /** A reading measured at most this long ago is live. */
  liveSeconds: number
  /** A device whose gateway has not been heard from for longer than this is disconnected. */
  disconnectedSeconds: number
}

export interface ReadingStateInput {
  /** Milliseconds since the epoch, on the SERVER's clock. */
  now: number
  /** When the newest reading was measured (null: none in this assignment). */
  measuredAt: number | null
  /** When the gateway last presented the device's token (null: never). */
  lastSeenAt: number | null
  /** False when no reading can arrive at all: no open assignment, the assignment's time is over, the device is retired or has no gateway. */
  available: boolean
}

/**
 * The state of a device reading, or of a device when `measuredAt` is its newest reading of any kind.
 *   unavailable   nothing can arrive (see `available`)
 *   disconnected  the gateway has not been heard from within `disconnectedSeconds` (or never); a value shown with this state is the LAST one
 *   no_data       the gateway is in contact but has sent no reading
 *   live          measured within `liveSeconds`
 *   stale         older than that, with the gateway still in contact
 * A reading stamped slightly in the future (clock skew; the gateway refuses more than five minutes) counts as just measured.
 */
export function readingState(i: ReadingStateInput, t: ReadingStateThresholds): ReadingState {
  if (!i.available) return 'unavailable'
  if (i.lastSeenAt === null || i.now - i.lastSeenAt > t.disconnectedSeconds * 1000) return 'disconnected'
  if (i.measuredAt === null) return 'no_data'
  return i.now - i.measuredAt <= t.liveSeconds * 1000 ? 'live' : 'stale'
}

export const DeviceReading = z.object({
  observationId: z.uuid(),
  kind: VitalKind,
  value: z.number(),
  unit: z.string(),
  flag: z.enum(['normal', 'low', 'high', 'critical_low', 'critical_high']).nullable(),
  measuredAt: z.string(),
  receivedAt: z.string(),
  state: ReadingState,
  validationStatus: ReadingValidation,
})
export type DeviceReading = z.infer<typeof DeviceReading>

/** One device attached to the patient now, with the newest reading of each kind it has sent in this assignment. */
export const AttachedDevice = z.object({
  assignmentId: z.uuid(),
  deviceId: z.uuid(),
  label: z.string(),
  kind: DeviceKind,
  integration: DeviceIntegration,
  simulated: z.boolean(),
  assignedAt: z.string(),
  validUntil: z.string().nullable(),
  visitId: z.uuid().nullable(),
  encounterId: z.uuid().nullable(),
  lastSeenAt: z.string().nullable(),
  state: ReadingState,
  /** Why the state is what it is, in words, when it is not live. */
  reason: z.string().nullable(),
  /** The kinds this device may send (the gate); a kind without a reading is shown as "no data". */
  kinds: z.array(VitalKind),
  readings: z.array(DeviceReading),
  readingsStored: z.number().int(),
})
export type AttachedDevice = z.infer<typeof AttachedDevice>

export const PatientDeviceReadings = z.object({
  /** The server's clock when the states were decided: the screen ages the readings from here, not from its own clock. */
  serverTime: z.string(),
  thresholds: z.object({ liveSeconds: z.number(), disconnectedSeconds: z.number() }),
  /**
   * The patient's consent to device readings: `missing` (nothing can be attached or stored), `outdated` (given under an earlier wording: what an
   * attached device sends is still stored, but a device cannot be attached until the consent is recorded again), or `granted`.
   */
  consent: z.enum(['granted', 'outdated', 'missing']),
  devices: z.array(AttachedDevice),
})
export type PatientDeviceReadings = z.infer<typeof PatientDeviceReadings>

// ---------------------------------------------------------------------------
// Stethoscope recordings
// ---------------------------------------------------------------------------

export const AUSCULTATION_SITES = {
  aortic: 'Aortic area',
  pulmonic: 'Pulmonic area',
  tricuspid: 'Tricuspid area',
  mitral: 'Mitral area (apex)',
  lung_right_upper: 'Right upper lung',
  lung_left_upper: 'Left upper lung',
  lung_right_lower: 'Right lower lung',
  lung_left_lower: 'Left lower lung',
  abdomen: 'Abdomen',
  other: 'Other',
} as const
export type AuscultationSite = keyof typeof AUSCULTATION_SITES
export const AuscultationSite = z.enum(Object.keys(AUSCULTATION_SITES) as [AuscultationSite, ...AuscultationSite[]])

/**
 * How a recording got here. None of them is a verified stethoscope connection:
 *   file_upload        a file chosen by staff (for example exported from a stethoscope's own app)
 *   browser_recording  recorded in this browser from an audio input the member of staff chose; ADAXAI cannot tell what that input is
 *   gateway            posted by a device gateway with the device's token (the integration boundary; never tested with hardware)
 */
export const AUSCULTATION_CAPTURE = {
  file_upload: 'Uploaded file',
  browser_recording: 'Recorded in the browser',
  gateway: 'Sent by a device gateway',
} as const
export type AuscultationCapture = keyof typeof AUSCULTATION_CAPTURE
export const AuscultationCapture = z.enum(Object.keys(AUSCULTATION_CAPTURE) as [AuscultationCapture, ...AuscultationCapture[]])

export const AuscultationRecording = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid().nullable(),
  fileId: z.uuid(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  site: AuscultationSite,
  note: z.string().nullable(),
  device: z.object({ id: z.uuid(), label: z.string() }).nullable(),
  captureMethod: AuscultationCapture,
  /** True when the audio was generated by a simulator: tones, not a body sound. */
  simulated: z.boolean(),
  durationMs: z.number().int().nullable(),
  /** The name the browser gave the audio input it recorded from (as reported by the browser; not verified). */
  inputLabel: z.string().nullable(),
  dataOrigin: z.string(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
})
export type AuscultationRecording = z.infer<typeof AuscultationRecording>
