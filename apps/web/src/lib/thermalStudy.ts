import { BODY_SITES, type BodySite, type CaptureProtocol, type Consent, DATA_ORIGIN_LABELS, type MyConsultation, type RoiStats, type ThermalCapture, type Visit } from '@adaxai/contracts'
import type { DialogHTMLAttributes, SyntheticEvent } from 'react'
import { fmtDateTime } from './format.ts'
import { fmtC } from './thermal.ts'

/**
 * Spread on a wrapper (`<div className="contents" {...CONTAIN_DIALOG_EVENTS}>`) around dialogs that may open inside another dialog (the
 * consultation's profile drawer, a side sheet): React passes a dialog's `cancel` and `close` events up the component tree, so without this,
 * Escape in the inner dialog would also close the one around it. The DOM types list these handlers for `<dialog>` only, hence the spread.
 */
const stopDialogEvent = (e: SyntheticEvent) => e.stopPropagation()
export const CONTAIN_DIALOG_EVENTS: Pick<DialogHTMLAttributes<HTMLDialogElement>, 'onCancel' | 'onClose'> = { onCancel: stopDialogEvent, onClose: stopDialogEvent }

/*
 * The pure parts of the doctor's Thermal page and thermal study (DESIGN §5.7): which patient and which study the page shows (its URL), whether
 * the patient's consent covers a new image, which consultation of the doctor's an image goes into, whether Upload and Capture are possible and
 * why not, what the camera pane can offer in this browser, the quick picks of today's patients, how the numbers are written, which facts of a
 * capture a doctor sees by default and which wait behind "Details", where the open study sits beside the camera, and the question before regions
 * not saved are discarded. No React and no DOM: unit-tested in node (test/thermalStudy.test.ts).
 */

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The page's URL: ?patientId= (the patient chosen) and ?capture= (the study open in place)
// ---------------------------------------------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ThermalPageParams {
  /** The patient chosen (preselected by ?patientId=). */
  patientId: string | null
  /** The thermal study open in place (?capture=). */
  captureId: string | null
}

/** Reads the page's parameters. Anything that is not an id is ignored, so a mistyped link shows the picker rather than an error. */
export function readThermalParams(params: Pick<URLSearchParams, 'get'>): ThermalPageParams {
  const id = (name: string) => {
    const v = params.get(name)?.trim() ?? ''
    return UUID.test(v) ? v.toLowerCase() : null
  }
  return { patientId: id('patientId'), captureId: id('capture') }
}

/** The search string for these parameters (empty parameters are left out). */
export function thermalSearch(p: ThermalPageParams): string {
  const out = new URLSearchParams()
  if (p.patientId) out.set('patientId', p.patientId)
  if (p.captureId) out.set('capture', p.captureId)
  const s = out.toString()
  return s ? `?${s}` : ''
}

/** Choosing a patient (from the search or a quick pick) closes any study that was open: a study shown is always the chosen patient's. */
export const choosePatient = (patientId: string): ThermalPageParams => ({ patientId: patientId.toLowerCase(), captureId: null })
/** "Change patient": back to the picker, nothing open. */
export const clearPatient = (): ThermalPageParams => ({ patientId: null, captureId: null })
/** Opening a study (after an upload or a capture, or from the recent list) chooses its patient as well. */
export const openStudy = (c: { id: string; patientId: string }): ThermalPageParams => ({ patientId: c.patientId.toLowerCase(), captureId: c.id.toLowerCase() })
/** Closing the study keeps the patient. */
export const closeStudy = (p: ThermalPageParams): ThermalPageParams => ({ patientId: p.patientId, captureId: null })

/** The patient the page is about: the one in the URL, or else the open study's own patient (a link that names only the study). */
export function effectivePatientId(p: ThermalPageParams, studyPatientId: string | null | undefined): string | null {
  return p.patientId ?? (p.captureId && studyPatientId ? studyPatientId.toLowerCase() : null)
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Consent to thermal imaging, as the server decides it (apps/api/src/consents/service.ts consentState)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type ThermalConsentState = 'granted' | 'outdated' | 'withdrawn' | 'not_recorded'

export interface ThermalConsent {
  state: ThermalConsentState
  /** Whether a new image may be stored (the server refuses an earlier wording for thermal images). */
  granted: boolean
  /** The state in a few words, for the patient line. */
  label: string
  /** Why Upload and Capture are not possible, or null when they are. */
  reason: string | null
}

type ConsentRow = Pick<Consent, 'type' | 'status' | 'scope' | 'encounterId' | 'recordedAt' | 'currentWording'>

/**
 * Whether the patient's consent covers a new thermal image, for this consultation when one is given. The same rule as the server: an ongoing
 * grant, or a grant for this consultation only, covers it; the grant with the current wording first, then the most recent; a grant with an
 * earlier wording is refused (the patient must hear the current one); otherwise the latest decision (ignoring consultation-only grants) says
 * whether it was withdrawn or never recorded. The server checks again when the image is stored.
 */
export function thermalConsent(consents: readonly ConsentRow[], encounterId?: string | null): ThermalConsent {
  const mine = consents.filter((c) => c.type === 'thermal_imaging')
  const covering = mine
    .filter((c) => c.status === 'granted' && (c.scope === 'ongoing' || (!!encounterId && c.encounterId === encounterId)))
    .sort((a, b) => Number(b.currentWording) - Number(a.currentWording) || b.recordedAt.localeCompare(a.recordedAt))
  const best = covering[0]
  if (best?.currentWording) return { state: 'granted', granted: true, label: best.scope === 'encounter' ? 'Granted for this consultation' : 'Granted', reason: null }
  if (best) return { state: 'outdated', granted: false, label: 'Granted with an earlier wording', reason: 'The patient agreed to an earlier wording of the consent to thermal imaging. Read the current wording and record it again on the patient’s page.' }
  const last = mine.filter((c) => !(c.scope === 'encounter' && c.status === 'granted')).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]
  if (last?.status === 'withdrawn') return { state: 'withdrawn', granted: false, label: 'Withdrawn', reason: 'The patient has withdrawn consent to thermal imaging: no new image can be added.' }
  return { state: 'not_recorded', granted: false, label: 'Not recorded', reason: 'The patient’s consent to thermal imaging is not recorded. Record it on the patient’s page first.' }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The doctor's consultation in progress, and what Upload and Capture can do
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The doctor's own consultation of this patient that is still in progress (GET /api/encounters/mine?status=in_progress), if any: today's first,
 * then the most recently updated. An image uploaded here goes into it; a capture can only go into it (the API's rule).
 */
export function openConsultationFor(items: readonly MyConsultation[], patientId: string | null | undefined, today?: string | null): MyConsultation | null {
  if (!patientId) return null
  const id = patientId.toLowerCase()
  const mine = items.filter((i) => i.status === 'in_progress' && i.patient.id.toLowerCase() === id)
  mine.sort((a, b) => Number(!!today && b.visit.visitDate === today) - Number(!!today && a.visit.visitDate === today) || b.updatedAt.localeCompare(a.updatedAt))
  return mine[0] ?? null
}

/** The exact words when Capture is not possible for want of a consultation (DESIGN §5.7). "My consultations" is a link where it is shown. */
export const CAPTURE_NEEDS_CONSULTATION = "Capture needs this patient's consultation in progress — start it from My consultations"

export type ActionBlock = 'no_patient' | 'checking' | 'unavailable' | 'consent' | 'no_consultation'

export interface ActionState {
  enabled: boolean
  /** Why it is not possible (null when it is). */
  block: ActionBlock | null
  reason: string | null
}

export interface AcquisitionInput {
  /** The chosen patient's record: none chosen, loading, failed, or read. */
  patient: 'none' | 'loading' | 'error' | 'ready'
  /** The doctor's consultations in progress: loading, failed, or read. */
  consultations: 'loading' | 'error' | 'ready'
  /** The consent for the image (for the consultation in progress when there is one). */
  consent: ThermalConsent | null
  /** The doctor's consultation of this patient in progress, if any. */
  openEncounterId: string | null
}

export interface Acquisition {
  upload: ActionState
  capture: ActionState
  /** The consultation an uploaded or captured image goes into (null: the patient only). */
  encounterId: string | null
}

const ok: ActionState = { enabled: false, block: null, reason: null }
const blocked = (block: ActionBlock, reason: string): ActionState => ({ enabled: false, block, reason })

/**
 * Whether [Upload thermal image] and [Capture thermal image] can be used, and why not. In order: a patient must be chosen; their record and the
 * doctor's consultations must have been read (an upload must know which consultation it belongs to, so it is never stored patient-only by
 * accident); their consent must cover a new image; and Capture needs the doctor's own consultation of this patient in progress (the API refuses a
 * live capture or a simulated one anywhere else). Upload without a consultation is stored with the patient only.
 */
export function thermalAcquisition(i: AcquisitionInput): Acquisition {
  const both = (s: ActionState): Acquisition => ({ upload: s, capture: s, encounterId: null })
  if (i.patient === 'none') return both(blocked('no_patient', 'Choose the patient first.'))
  if (i.patient === 'loading' || i.consultations === 'loading') return both(blocked('checking', 'Checking the patient’s consent and your consultations…'))
  if (i.patient === 'error') return both(blocked('unavailable', 'The patient’s record could not be read. Try again.'))
  if (i.consultations === 'error') return both(blocked('unavailable', 'Your consultations could not be checked. Try again.'))
  if (!i.consent?.granted) return both(blocked('consent', i.consent?.reason ?? 'The patient’s consent to thermal imaging is not recorded. Record it on the patient’s page first.'))
  const enabled = { ...ok, enabled: true }
  return {
    upload: enabled,
    capture: i.openEncounterId ? enabled : blocked('no_consultation', CAPTURE_NEEDS_CONSULTATION),
    encounterId: i.openEncounterId,
  }
}

export interface CameraOffer {
  /** Whether the ADAXAI tablet app's camera bridge is present (it is never present in a browser). */
  bridge: boolean
  /** Whether the labelled simulator may be offered here (not in a clinical or production deployment). */
  simulator: boolean
  /** One honest line about the camera. Never claims that FLIR capture works. */
  line: string
}

/** What the camera pane can offer on this device. */
export function cameraOffer(i: { bridge: boolean; simulatorAllowed: boolean | null | undefined }): CameraOffer {
  const simulator = i.simulatorAllowed === true
  if (i.bridge) return { bridge: true, simulator, line: 'Camera bridge present: connect the FLIR ONE in the camera pane.' }
  return { bridge: false, simulator, line: simulator ? 'FLIR ONE not connected · a simulator is available (SIMULATED)' : 'FLIR ONE not connected' }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Today's patients as quick picks
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface QuickPick {
  patientId: string
  fullName: string
  mrn: string
  /** The appointment time when the visit came from one, else the check-in time (ISO). */
  at: string
  tokenNumber: number
}

const GONE: readonly Visit['status'][] = ['cancelled', 'no_show']

/**
 * Today's patients of the doctor (GET /api/visits?mine=true) as quick picks: one per patient, cancelled and no-show visits left out, in the
 * order of the day (the appointment time when there is one, else the check-in time), at most `max`.
 */
export function thermalQuickPicks(visits: readonly Pick<Visit, 'status' | 'checkedInAt' | 'appointment' | 'patient' | 'tokenNumber'>[], max = 12): QuickPick[] {
  const seen = new Set<string>()
  return visits
    .filter((v) => !GONE.includes(v.status))
    .map((v) => ({ patientId: v.patient.id, fullName: v.patient.fullName, mrn: v.patient.mrn, at: v.appointment?.scheduledAt ?? v.checkedInAt, tokenNumber: v.tokenNumber }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.tokenNumber - b.tokenNumber)
    .filter((p) => (seen.has(p.patientId) ? false : (seen.add(p.patientId), true)))
    .slice(0, max)
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface StatCell {
  key: 'min' | 'max' | 'mean' | 'sd'
  label: string
  /** The number without its unit ("33.4"), or the words for a missing one. */
  value: string
  /** The unit, shown smaller ("°C"); empty for a missing value. */
  unit: string
  missing: boolean
}

const num = (v: number | null | undefined, digits: number) => (v === null || v === undefined || !Number.isFinite(v) ? null : v.toFixed(digits))

/**
 * The whole image's minimum, maximum, mean and standard deviation, to 0.1 °C (the numbers the server stored). An image stored before the
 * deviation was kept says so: it is never shown as 0.
 */
export function wholeImageStats(c: Pick<ThermalCapture, 'minC' | 'maxC' | 'meanC' | 'stdC'>): StatCell[] {
  const cell = (key: StatCell['key'], label: string, v: number | null | undefined, missingWords: string): StatCell => {
    const n = num(v, 1)
    return n === null ? { key, label, value: missingWords, unit: '', missing: true } : { key, label, value: n, unit: '°C', missing: false }
  }
  return [cell('min', 'Min', c.minC, 'Not available'), cell('max', 'Max', c.maxC, 'Not available'), cell('mean', 'Mean', c.meanC, 'Not available'), cell('sd', 'SD', c.stdC, 'Not stored for this image')]
}

/** The same four numbers as one line, for a screen reader or a compact list ("Min 30.1 °C · Max 36.2 °C · Mean 33.4 °C · SD 0.8 °C"). */
export const wholeImageStatsText = (c: Pick<ThermalCapture, 'minC' | 'maxC' | 'meanC' | 'stdC'>) => wholeImageStats(c).map((s) => `${s.label} ${s.missing ? s.value.toLowerCase() : `${s.value} ${s.unit}`}`).join(' · ')

const count = new Intl.NumberFormat('en-IN')

export interface RoiStatsParts {
  mean: string
  min: string
  max: string
  sd: string
  pixels: string
}

/** One region's numbers, to 0.01 °C ("No reading" for a missing one); null when no pixel inside it has a reading. */
export function roiStatsParts(s: Pick<RoiStats, 'pixelCount' | 'min' | 'max' | 'mean' | 'std'> | null | undefined): RoiStatsParts | null {
  if (!s || !s.pixelCount) return null
  const t = (v: number | null | undefined) => (num(v, 2) === null ? 'No reading' : fmtC(v, 2))
  return { mean: t(s.mean), min: t(s.min), max: t(s.max), sd: t(s.std), pixels: `${count.format(s.pixelCount)} px` }
}

/** A paired difference, signed ("+0.84 °C"), or "Not available". */
export const fmtDiff = (v: number | null | undefined) => (num(v, 2) === null ? 'Not available' : `${v! > 0 ? '+' : ''}${v!.toFixed(2)} °C`)

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What a doctor sees by default, and what waits behind "Details"
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The facts shown with the image: where on the body and when. */
export const CLINICAL_FACTS = ['region', 'taken'] as const
/** Engineering and provenance detail: only behind the study's "Details" (DESIGN §1: never in the primary workflow). */
export const DETAIL_FACTS = ['view', 'resolution', 'conditions', 'distance', 'emissivity', 'reflected', 'camera', 'extractor', 'dataOrigin', 'uploaded', 'reviewed', 'notes', 'fileName', 'sha256'] as const
export type ClinicalFactKey = (typeof CLINICAL_FACTS)[number]
export type DetailFactKey = (typeof DETAIL_FACTS)[number]

export interface Fact<K extends string> {
  key: K
  label: string
  value: string
}

const NOT_RECORDED = 'Not recorded'
const or = (v: string | null | undefined, missing = NOT_RECORDED) => (v === null || v === undefined || v.trim() === '' ? missing : v)

/** Where on the body: the fixed-list site and the free description, each once ("Knee · Right knee, anterior"). */
export function regionOf(c: Pick<ThermalCapture, 'protocol'>): string {
  const site = c.protocol.bodySite ? BODY_SITES[c.protocol.bodySite] : null
  return [site, c.protocol.bodyRegion].filter((v, i, a): v is string => !!v && !!v.trim() && a.findIndex((x) => x?.trim().toLowerCase() === v.trim().toLowerCase()) === i).join(' · ') || NOT_RECORDED
}

type FactCapture = Pick<ThermalCapture, 'protocol' | 'capturedAt' | 'createdAt' | 'createdByName' | 'width' | 'height' | 'parameters' | 'camera' | 'extractor' | 'dataOrigin' | 'review' | 'originalName' | 'rawSha256' | 'captureSource' | 'simulated'>

/**
 * The facts of a capture, split for the clinical study: `clinical` (shown with the image) and `details` (behind "Details"). The split is fixed
 * by CLINICAL_FACTS and DETAIL_FACTS, so emissivity, the extractor, the data origin, the file's SHA-256 and the like never reach the default
 * view. A missing value says "Not recorded", never a bare dash.
 */
export function captureFacts(c: FactCapture): { clinical: Fact<ClinicalFactKey>[]; details: Fact<DetailFactKey>[] } {
  const simulated = !!c.simulated || c.captureSource === 'simulator'
  const p = c.protocol
  const camera = [c.camera.make, c.camera.model].filter(Boolean).join(' ')
  const clinical: Fact<ClinicalFactKey>[] = [
    { key: 'region', label: 'Region', value: regionOf(c) },
    { key: 'taken', label: c.capturedAt ? 'Captured' : 'Received', value: fmtDateTime(c.capturedAt ?? c.createdAt) },
  ]
  const details: Fact<DetailFactKey>[] = [
    { key: 'view', label: 'View', value: or(p.view?.replace('_', ' ')) },
    { key: 'resolution', label: 'Resolution', value: `${c.width} × ${c.height}` },
    { key: 'conditions', label: 'Room / acclimatisation', value: p.roomTempC == null && p.acclimatisationMin == null ? NOT_RECORDED : `${p.roomTempC ?? '—'} °C · ${p.acclimatisationMin ?? '—'} min` },
    { key: 'distance', label: 'Distance', value: p.distanceM ? `${p.distanceM} m` : NOT_RECORDED },
    { key: 'emissivity', label: 'Emissivity (camera)', value: simulated ? 'Not applicable (SIMULATED)' : or(num(c.parameters.emissivity, 2)) },
    { key: 'reflected', label: 'Reflected temp (camera)', value: simulated ? 'Not applicable (SIMULATED)' : or(num(c.parameters.reflectedTempC, 1) && `${num(c.parameters.reflectedTempC, 1)} °C`) },
    { key: 'camera', label: 'Camera', value: or(camera) },
    { key: 'extractor', label: 'Extractor', value: `${c.extractor.name} ${c.extractor.version}` },
    { key: 'dataOrigin', label: 'Data origin', value: DATA_ORIGIN_LABELS[c.dataOrigin] ?? c.dataOrigin },
    { key: 'uploaded', label: 'Uploaded', value: `${fmtDateTime(c.createdAt)}${c.createdByName ? ` · ${c.createdByName}` : ''}` },
    { key: 'reviewed', label: 'Reviewed', value: c.review ? `${fmtDateTime(c.review.at)}${c.review.byName ? ` · ${c.review.byName}` : ''}${c.review.note ? ` · ${c.review.note}` : ''}` : 'Not reviewed yet' },
    { key: 'notes', label: 'Notes', value: or(p.notes) },
    { key: 'fileName', label: 'Original file', value: or(c.originalName) },
    { key: 'sha256', label: 'Original file SHA-256', value: or(c.rawSha256) },
  ]
  return { clinical, details }
}

/**
 * The capture details of the doctor's simplified upload dialog (DESIGN §5.7: the file, the body region from the fixed list, an optional note).
 * The site names the image, as the camera pane does; the view is not asked, so it is recorded as "other"; nothing is inferred from either. An
 * empty site gives an empty region, which the contract refuses.
 */
export function simpleUploadProtocol(v: { bodySite: string; notes: string }): CaptureProtocol {
  const site = Object.hasOwn(BODY_SITES, v.bodySite) ? (v.bodySite as BodySite) : null
  return { bodyRegion: site ? BODY_SITES[site] : '', bodySite: site, view: 'other', notes: v.notes }
}

/** The review status of an image in words, with its tone (the word always shown: colour is never the only cue). */
export function captureStatusSpec(status: ThermalCapture['status']): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (status === 'approved') return { label: 'Approved', tone: 'ok' }
  if (status === 'rejected') return { label: 'Rejected', tone: 'neutral' }
  return { label: 'Awaiting review', tone: 'warn' }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The open study: where it sits on the page, and regions drawn on it but not saved
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** A part of the Thermal page's study area: the camera, the open study, or the place the study will appear once the camera takes an image. */
export type StudyAreaSlot = 'camera' | 'study' | 'waiting'

/**
 * The area under [Upload] and [Capture]: the camera (while open) in a column beside the study, or the study alone. Each part has one key, the
 * same whether the camera is open or not, so the open study keeps its place in the page: opening or closing the camera never mounts it again
 * (which would drop regions drawn but not saved, the palette and span, and a polygon half drawn). With the camera open and no study yet, a
 * placeholder stands where the study will appear. Null when there is neither.
 */
export function studyArea(i: { camera: boolean; study: boolean }): { columns: boolean; slots: StudyAreaSlot[] } | null {
  if (!i.camera && !i.study) return null
  const slots: StudyAreaSlot[] = i.camera ? ['camera'] : []
  slots.push(i.study ? 'study' : 'waiting')
  return { columns: i.camera, slots }
}

/**
 * Regions drawn on the open study but not saved are asked about ("Discard the unsaved regions?") before anything discards them: closing the
 * study, opening another image, an upload or a capture. One rule wherever a study is shown (the Thermal page, the patient profile's thermal
 * images, the consultation's thermal workspace).
 */
export interface DiscardGuard {
  /** Whether regions are drawn but not saved (the viewer's `onDirtyChange`). */
  dirty: boolean
  /** What waits for the doctor's answer, or null. */
  readonly pending: (() => void) | null
  /** Runs `go` now; or, while regions are unsaved, holds it and asks. */
  guard(go: () => void): void
  /** "Discard the regions": nothing is unsaved any more, and what was held runs. */
  discard(): void
  /** "Keep editing": what was held is dropped, and the regions stay. */
  keep(): void
}

/** A discard guard; `onAsk(true)` shows the question, `onAsk(false)` takes it away. */
export function discardGuard(onAsk: (asking: boolean) => void): DiscardGuard {
  let pending: (() => void) | null = null
  const g: DiscardGuard = {
    dirty: false,
    get pending() {
      return pending
    },
    guard(go) {
      if (!g.dirty) return go()
      pending = go
      onAsk(true)
    },
    discard() {
      const go = pending
      pending = null
      g.dirty = false
      onAsk(false)
      go?.()
    },
    keep() {
      pending = null
      onAsk(false)
    },
  }
  return g
}
