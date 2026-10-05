import { z } from 'zod'
import { OptionalText, Text } from './common.ts'
import { NOTE_SECTION_MAX } from './encounters.ts'

export const THERMAL_VIEWS = ['anterior', 'posterior', 'left_lateral', 'right_lateral', 'plantar', 'dorsal', 'other'] as const

/** Where on the body the camera was pointed (V6). Metadata only: nothing is inferred from it. */
export const BODY_SITES = { hand: 'Hand', arm: 'Arm', leg: 'Leg', knee: 'Knee', ankle: 'Ankle', face: 'Face', joint: 'Joint', other: 'Other' } as const
export type BodySite = keyof typeof BODY_SITES

/**
 * How a thermal image reached ADAXAI (V6). `live_capture`: captured in the consultation from a camera connected to the tablet (the native
 * bridge hands over the camera's own radiometric file); `gallery_import`: an earlier radiometric file chosen from the device; `file_upload`:
 * uploaded on the thermal pages (every capture before V6); `simulator`: generated numbers, set by the server's simulator route only. Live and
 * imported are what the application that sent the file says; the file itself is checked to be a radiometric FLIR file either way.
 */
export const THERMAL_CAPTURE_SOURCES = { live_capture: 'Live capture', gallery_import: 'Imported', file_upload: 'Uploaded file', simulator: 'Simulated' } as const
export type ThermalCaptureSource = keyof typeof THERMAL_CAPTURE_SOURCES

/** How the image was taken. Thermal readings depend heavily on these conditions. */
export const CaptureProtocol = z.object({
  bodyRegion: Text(80),
  /** V6: the region from a fixed list, beside the free description (older captures have none). */
  bodySite: z.enum(Object.keys(BODY_SITES) as [BodySite, ...BodySite[]]).nullable().optional(),
  view: z.enum(THERMAL_VIEWS).default('anterior'),
  roomTempC: z.number().min(10).max(40).nullable().optional(),
  acclimatisationMin: z.number().int().min(0).max(120).nullable().optional(),
  distanceM: z.number().min(0.1).max(10).nullable().optional(),
  notes: OptionalText(500),
})
export type CaptureProtocol = z.input<typeof CaptureProtocol>

export const RoiShape = z.enum(['rect', 'ellipse', 'polygon'])
/** A polygon's corners, in image pixels: 3 to 64 points. */
export const RoiPoints = z.array(z.tuple([z.number().min(0), z.number().min(0)])).min(3).max(64)
export const ThermalRoiInput = z
  .object({
    label: Text(40),
    shape: RoiShape,
    /** For a polygon, its bounding box (the server works it out again from the points). */
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
    /** Polygon only (V6). */
    points: RoiPoints.nullable().optional(),
    /** Label of the contralateral region to compare with (e.g. "Left knee" vs "Right knee"). */
    pairWith: z.string().trim().max(40).nullable().optional(),
    /** The doctor's note on this region (V6). */
    note: OptionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.shape === 'polygon' && !v.points) ctx.addIssue({ code: 'custom', path: ['points'], message: 'A polygon needs at least three points' })
    if (v.shape !== 'polygon' && v.points) ctx.addIssue({ code: 'custom', path: ['points'], message: 'Only a polygon has points' })
  })
export type ThermalRoiInput = z.input<typeof ThermalRoiInput>

export const SaveRoisRequest = z.object({ rois: z.array(ThermalRoiInput).max(20) }).superRefine((v, ctx) => {
  const labels = v.rois.map((r) => r.label.trim().toLowerCase())
  if (new Set(labels).size !== labels.length) ctx.addIssue({ code: 'custom', path: ['rois'], message: 'Region labels must be unique' })
  v.rois.forEach((r, i) => {
    if (r.pairWith && !labels.includes(r.pairWith.trim().toLowerCase())) ctx.addIssue({ code: 'custom', path: ['rois', i, 'pairWith'], message: 'Pair with an existing region label' })
    if (r.pairWith && r.pairWith.trim().toLowerCase() === r.label.trim().toLowerCase()) ctx.addIssue({ code: 'custom', path: ['rois', i, 'pairWith'], message: 'A region cannot be paired with itself' })
  })
})
export type SaveRoisRequest = z.input<typeof SaveRoisRequest>

export const RoiStats = z.object({ pixelCount: z.number().int(), min: z.number().nullable(), max: z.number().nullable(), mean: z.number().nullable(), std: z.number().nullable() })
export type RoiStats = z.infer<typeof RoiStats>

export const ThermalRoi = z.object({
  id: z.uuid(),
  label: z.string(),
  shape: RoiShape,
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  points: RoiPoints.nullable(),
  pairWith: z.string().nullable(),
  note: z.string().nullable(),
  stats: RoiStats,
  createdByName: z.string().nullable(),
  createdAt: z.string(),
})
export type ThermalRoi = z.infer<typeof ThermalRoi>
export const ThermalPair = z.object({ a: z.string(), b: z.string(), meanDiff: z.number().nullable(), maxDiff: z.number().nullable() })
export type ThermalPair = z.infer<typeof ThermalPair>

export const ThermalStatus = z.enum(['draft', 'approved', 'rejected'])

const nullableNum = z.number().nullable()
export const ThermalCapture = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid().nullable(),
  status: ThermalStatus,
  originalName: z.string().nullable(),
  width: z.number().int(),
  height: z.number().int(),
  minC: z.number(),
  maxC: z.number(),
  meanC: z.number(),
  camera: z.object({ make: z.string().nullable(), model: z.string().nullable(), dateTime: z.string().nullable() }),
  parameters: z.object({
    emissivity: nullableNum,
    objectDistanceM: nullableNum,
    reflectedTempC: nullableNum,
    atmosphericTempC: nullableNum,
    relativeHumidity: nullableNum,
    irWindowTempC: nullableNum,
    irWindowTransmission: nullableNum,
  }),
  protocol: CaptureProtocol.extend({ view: z.enum(THERMAL_VIEWS) }),
  extractor: z.object({ name: z.string(), version: z.string() }),
  rawFileId: z.uuid(),
  /** SHA-256 of the original file as received (V6: shown with the study). */
  rawSha256: z.string(),
  matrixFileId: z.uuid(),
  visibleFileId: z.uuid().nullable(),
  /** Standard deviation over the whole image, °C (V6; null for captures stored before it was kept). */
  stdC: z.number().nullable(),
  /** V6 provenance. `simulated` is true exactly when `captureSource` is `simulator` (database constraint). */
  captureSource: z.enum(Object.keys(THERMAL_CAPTURE_SOURCES) as [ThermalCaptureSource, ...ThermalCaptureSource[]]),
  simulated: z.boolean(),
  /** When the camera says it took the image (from the device bridge or the file); null when nothing said. */
  capturedAt: z.string().nullable(),
  /** The registered device it was matched to (by serial number), if any. */
  device: z.object({ id: z.uuid(), label: z.string() }).nullable(),
  /** What the device bridge reported about the camera, as reported: not verified by ADAXAI. */
  deviceReported: z.lazy(() => ThermalDeviceReported).nullable(),
  rois: z.array(ThermalRoi),
  pairs: z.array(ThermalPair),
  review: z.object({ byName: z.string().nullable(), at: z.string(), note: z.string().nullable() }).nullable(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  dataOrigin: z.lazy(() => DataOrigin),
  /** Clinician labels, including withdrawn ones (shown struck through). */
  labels: z.array(z.lazy(() => ThermalLabel)),
})
export type ThermalCapture = z.infer<typeof ThermalCapture>

export const ThermalReviewRequest = z.object({ decision: z.enum(['approved', 'rejected']), note: OptionalText(500) })
export type ThermalReviewRequest = z.input<typeof ThermalReviewRequest>

/** Where the image data came from. Anything but `clinical` is excluded from any performance claim. */
export const DataOrigin = z.enum(['clinical', 'synthetic', 'public_sample'])
export type DataOrigin = z.infer<typeof DataOrigin>
export const DATA_ORIGIN_LABELS: Record<DataOrigin, string> = {
  clinical: 'Clinical',
  synthetic: 'Synthetic / demonstration',
  public_sample: 'Public sample file',
}

// ---------------------------------------------------------------------------
// Clinician labels (ground truth for future evaluation). Versioned taxonomy.
// ---------------------------------------------------------------------------

export const THERMAL_TAXONOMY_VERSION = 'thermal-labels-v1'

export const CAPTURE_FINDINGS = {
  no_significant_finding: 'No significant thermal finding',
  inflammatory_pattern: 'Pattern consistent with inflammation',
  infective_pattern: 'Pattern consistent with infection',
  vascular_pattern: 'Pattern consistent with reduced perfusion',
  musculoskeletal_pattern: 'Pattern consistent with musculoskeletal injury',
  other_finding: 'Other finding',
  uninterpretable: 'Not interpretable (image quality or protocol)',
} as const
export const ROI_FINDINGS = {
  normal: 'Normal for this region',
  warmer_than_expected: 'Warmer than expected',
  cooler_than_expected: 'Cooler than expected',
  indeterminate: 'Indeterminate',
} as const
/** How the label was established. Clinical impression alone is the weakest reference. */
export const REFERENCE_STANDARDS = {
  clinical_impression: 'Clinical impression at the time',
  confirmed_investigation: 'Confirmed by investigation (lab or imaging)',
  follow_up: 'Confirmed at follow-up',
} as const
export const LABEL_CERTAINTY = { certain: 'Certain', probable: 'Probable', uncertain: 'Uncertain' } as const

type Keys<T> = [keyof T & string, ...(keyof T & string)[]]
const keys = <T extends object>(o: T) => Object.keys(o) as Keys<T>

export const ThermalLabelInput = z
  .object({
    scope: z.enum(['capture', 'roi']),
    /** Region label, for scope `roi`. */
    roiLabel: z.string().trim().max(40).nullable().optional(),
    code: z.string(),
    referenceStandard: z.enum(keys(REFERENCE_STANDARDS)),
    certainty: z.enum(keys(LABEL_CERTAINTY)),
    note: OptionalText(500),
  })
  .superRefine((v, ctx) => {
    const codes: readonly string[] = keys(v.scope === 'capture' ? CAPTURE_FINDINGS : ROI_FINDINGS)
    if (!codes.includes(v.code)) ctx.addIssue({ code: 'custom', path: ['code'], message: 'Choose a finding from the list' })
    if (v.scope === 'roi' && !v.roiLabel) ctx.addIssue({ code: 'custom', path: ['roiLabel'], message: 'Choose a region' })
    if (v.scope === 'capture' && v.roiLabel) ctx.addIssue({ code: 'custom', path: ['roiLabel'], message: 'Whole-image labels have no region' })
  })
export type ThermalLabelInput = z.input<typeof ThermalLabelInput>

export const ThermalLabel = z.object({
  id: z.uuid(),
  scope: z.enum(['capture', 'roi']),
  roiLabel: z.string().nullable(),
  code: z.string(),
  referenceStandard: z.string(),
  certainty: z.string(),
  note: z.string().nullable(),
  taxonomyVersion: z.string(),
  labelledById: z.uuid(),
  labelledByName: z.string().nullable(),
  labelledAt: z.string(),
  withdrawn: z.object({ at: z.string(), byName: z.string().nullable(), reason: z.string() }).nullable(),
})
export type ThermalLabel = z.infer<typeof ThermalLabel>

export const WithdrawLabelRequest = z.object({ reason: Text(300) })

// ---------------------------------------------------------------------------
// Experimental rule-based flags (NOT validated, NOT diagnostic).
// ---------------------------------------------------------------------------

export const ThermalFlags = z.object({
  version: z.string(),
  validated: z.literal(false),
  disclaimer: z.string(),
  params: z.object({ asymmetry_threshold_c: z.number(), hotspot_k: z.number(), hotspot_min_pixels: z.number(), max_hotspots: z.number() }),
  image: z.object({ meanC: z.number(), stdC: z.number(), hotspotThresholdC: z.number() }),
  hotspots: z.array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), pixelCount: z.number(), maxC: z.number(), meanC: z.number(), aboveImageMeanC: z.number() })),
  asymmetry: z.array(z.object({ a: z.string(), b: z.string(), meanDiffC: z.number(), flagged: z.boolean() })),
})
export type ThermalFlags = z.infer<typeof ThermalFlags>

// ---------------------------------------------------------------------------
// De-identified dataset exports and their evaluation.
// ---------------------------------------------------------------------------

export const THERMAL_DATASET_SCHEMA = 'adaxai-thermal-dataset/1'

export const ThermalDataSummary = z.object({
  captures: z.object({ draft: z.number(), approved: z.number(), rejected: z.number() }),
  approvedWithResearchConsent: z.number(),
  labelledCaptures: z.number(),
  activeLabels: z.number(),
  labelCounts: z.record(z.string(), z.number()),
  dataOrigins: z.record(z.string(), z.number()),
})
export type ThermalDataSummary = z.infer<typeof ThermalDataSummary>

export const ThermalDatasetExport = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  fileSha256: z.string(),
  sizeBytes: z.number(),
  summary: z.object({
    captures: z.number(),
    subjects: z.number(),
    labelledCaptures: z.number(),
    dataOrigins: z.record(z.string(), z.number()),
    excludedNoResearchConsent: z.number(),
  }),
  evaluation: z.object({ at: z.string(), report: z.record(z.string(), z.unknown()), markdown: z.string() }).nullable(),
})
export type ThermalDatasetExport = z.infer<typeof ThermalDatasetExport>

// ---------------------------------------------------------------------------
// V6: live capture, the simulator, the model status and reviewable summaries.
// ---------------------------------------------------------------------------

/**
 * What the native device bridge reported about the camera and the software that read it, sent with a live capture. Every field is what the
 * bridge said (from the FLIR Atlas SDK: `CameraInformation`, `Identity`, `ThermalSdkAndroid.getVersion()`); ADAXAI does not verify it.
 */
export const ThermalDeviceReported = z.object({
  model: z.string().max(120).nullable(),
  serialNumber: z.string().max(120).nullable(),
  /** Firmware ("program version" in the SDK). */
  programVersion: z.string().max(120).nullable(),
  articleNumber: z.string().max(120).nullable(),
  /** The SDK's device identity (`Identity.deviceId`) and interface (`USB` for a FLIR ONE on USB-C). */
  deviceId: z.string().max(200).nullable(),
  interface: z.string().max(40).nullable(),
  sdk: z.object({ name: z.string().max(80), version: z.string().max(40).nullable(), commitHash: z.string().max(80).nullable() }).nullable(),
  bridge: z.object({ name: z.string().max(80), version: z.string().max(40) }).nullable(),
})
export type ThermalDeviceReported = z.infer<typeof ThermalDeviceReported>

/**
 * The simulator's cases (V6). Deterministic for a seed (`thermalSim.ts`), for tests, development and demonstrations without a camera.
 * Everything they produce is SIMULATED: generated numbers, not a measurement of anyone. `invalid_capture` and `processing_failure` exercise
 * the failure paths (nothing is stored); `disconnected` is a camera state and never reaches the server.
 */
export const THERMAL_SIM_CASES = {
  normal: 'Even distribution',
  localized_difference: 'Localized temperature difference',
  high_variance: 'High variance',
  missing_data: 'Missing data (pixels without a reading)',
  invalid_capture: 'Invalid capture',
  disconnected: 'Disconnected camera',
  processing_failure: 'Processing failure',
} as const
export type ThermalSimCase = keyof typeof THERMAL_SIM_CASES
/** The cases the server's simulator route accepts (the others are camera states). */
export const THERMAL_SIM_CAPTURE_CASES = ['normal', 'localized_difference', 'high_variance', 'missing_data', 'invalid_capture', 'processing_failure'] as const
export const ThermalSimulateRequest = z.object({
  case: z.enum(THERMAL_SIM_CAPTURE_CASES),
  seed: z.number().int().min(0).max(2 ** 31 - 1),
  encounterId: z.uuid(),
  protocol: CaptureProtocol,
})
export type ThermalSimulateRequest = z.input<typeof ThermalSimulateRequest>

/**
 * Whether a thermal model is installed (V6). There is none: `available` is false and `reason` says so. A model would be described here by
 * its id, version, the hash of its weights, what it is (`real`: trained and evaluated for its stated task; `research`; `simulation`) and
 * its evaluation; nothing in the product shows a model output that this status does not describe.
 */
export const ThermalModelStatus = z.object({
  available: z.boolean(),
  kind: z.enum(['real', 'research', 'simulation']).nullable(),
  modelId: z.string().nullable(),
  version: z.string().nullable(),
  artifactSha256: z.string().nullable(),
  intendedUse: z.string().nullable(),
  evaluation: z.object({ runId: z.string().nullable(), summary: z.string() }).nullable(),
  reason: z.string().nullable(),
})
export type ThermalModelStatus = z.infer<typeof ThermalModelStatus>

/** Where a summary statement comes from: measured values, a documented rule (experimental), a model, or what is not there. */
export const THERMAL_STATEMENT_BASES = { measurement: 'Measured', rule: 'Experimental rule', model: 'Model', limitation: 'Limitation' } as const
export const ThermalSummaryStatement = z.object({
  basis: z.enum(Object.keys(THERMAL_STATEMENT_BASES) as [keyof typeof THERMAL_STATEMENT_BASES, ...(keyof typeof THERMAL_STATEMENT_BASES)[]]),
  text: z.string(),
  /** What it rests on, in words: "whole image", "region Left knee", "rules-v1: |mean difference| ≥ 1.0 °C". */
  source: z.string(),
})
export type ThermalSummaryStatement = z.infer<typeof ThermalSummaryStatement>

export const THERMAL_SUMMARY_DECISIONS = { pending: 'To review', accepted: 'Accepted', edited: 'Edited and accepted', rejected: 'Rejected' } as const
/**
 * A clinician-facing summary of one thermal study (V6), composed by fixed rules from what was measured (no language model), reviewed by the
 * doctor (accept, edit, reject) and only then offered for the note, by a separate "Add to note". It never states a diagnosis, a pain score or
 * a recommendation; it says what was measured, what an experimental rule found, that no model is installed, and what the image cannot show.
 */
export const ThermalSummary = z.object({
  id: z.uuid(),
  captureId: z.uuid(),
  encounterId: z.uuid().nullable(),
  composerVersion: z.string(),
  rulesVersion: z.string().nullable(),
  model: ThermalModelStatus,
  statements: z.array(ThermalSummaryStatement),
  text: z.string(),
  status: z.enum(Object.keys(THERMAL_SUMMARY_DECISIONS) as [keyof typeof THERMAL_SUMMARY_DECISIONS, ...(keyof typeof THERMAL_SUMMARY_DECISIONS)[]]),
  finalText: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  simulated: z.boolean(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
})
export type ThermalSummary = z.infer<typeof ThermalSummary>
/** An edit is as long as the Examination section the summary is added to (and the note insertion takes): any composed summary can be edited. */
export const ThermalSummaryReviewRequest = z
  .object({ decision: z.enum(['accepted', 'edited', 'rejected']), text: OptionalText(NOTE_SECTION_MAX.examination) })
  .superRefine((v, ctx) => {
    if (v.decision === 'edited' && !v.text?.trim()) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Write the edited summary' })
  })
export type ThermalSummaryReviewRequest = z.input<typeof ThermalSummaryReviewRequest>

/** What the thermal imaging workspace reports for the audit log (V6). Never a frame, never an image. */
export const THERMAL_WORKSPACE_EVENTS = ['workspace_opened', 'camera_connected', 'connect_failed', 'camera_disconnected', 'capture_failed'] as const
export const ThermalWorkspaceEventRequest = z.object({
  event: z.enum(THERMAL_WORKSPACE_EVENTS),
  adapter: z.enum(['native_bridge', 'simulator']),
  /** A state or error code from the adapter, and the camera model it reported: short words, never patient data. */
  state: z.string().trim().max(40).nullable().optional(),
  reason: z.string().trim().max(200).nullable().optional(),
  deviceModel: z.string().trim().max(120).nullable().optional(),
})
export type ThermalWorkspaceEventRequest = z.input<typeof ThermalWorkspaceEventRequest>
