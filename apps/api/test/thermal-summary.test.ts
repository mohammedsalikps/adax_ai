import crypto from 'node:crypto'
import {
  Encounter,
  InsertIntoNoteRequest,
  PatientDetail,
  type RoiStats,
  simulateThermalMatrix,
  THERMAL_SIM_SIZE,
  type ThermalCaptureSource,
  type ThermalFlags,
  type ThermalModelStatus,
  type ThermalPair,
  ThermalSummary,
  ThermalSummaryReviewRequest,
  thermalStats,
  Visit,
} from '@adaxai/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildPatientContext } from '../src/ai/context.ts'
import { hashPassword } from '../src/auth/password.ts'
import type { SessionUser } from '../src/auth/sessions.ts'
import { buildConsultationInputs } from '../src/consult/inputs.ts'
import { departments, facilities, files, thermalCaptures, thermalRois, thermalSummaries, users } from '../src/db/schema.ts'
import { storeBytes } from '../src/files/storage.ts'
import { MANA_RULES_VERSION } from '../src/mana/answers.ts'
import { loadPatientRecord } from '../src/mana/record.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { type FlagsInput, modelUnavailable, type ThermalService } from '../src/thermal/client.ts'
import {
  composeThermalSummary,
  PAIRS_LISTED,
  QUOTED_MAX,
  quoted,
  REGIONS_LISTED,
  type SummaryCaptureInput,
  type SummaryRoiInput,
  THERMAL_LABEL_IMPORTED,
  THERMAL_LABEL_SIMULATED,
  THERMAL_LIMITATION_SURFACE,
  THERMAL_LIMITATION_VALIDATION,
  THERMAL_NO_MODEL,
  THERMAL_RULES_NOT_RUN,
  THERMAL_SUMMARY_COMPOSER_VERSION,
  THERMAL_SUMMARY_TEXT_MAX,
} from '../src/thermal/summary.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD, testConfig } from './helpers.ts'

// V6: the clinician-facing thermal summary. It is composed by fixed rules from what was measured and stored (no language model), decided once by
// a doctor, and only then, by a separate "Add to note", inserted into a consultation note; Mana and the consultation draft read the measured values
// and the reviewed summary, never a simulated capture. NO CAMERA AND NO THERMAL SERVICE are involved: captures are stored rows whose matrix is the
// simulator's (generated numbers, stored as synthetic), and the thermal service is a labelled test double whose rule output is worked out here from
// the stored statistics.

const NO_MODEL = modelUnavailable('No trained thermal model is installed.')

// --- the composer, on its own ------------------------------------------------------------------------------------------------------------

const RULES_PARAMS = { asymmetry_threshold_c: 1.0, hotspot_k: 2.0, hotspot_min_pixels: 12, max_hotspots: 10 }
const fixtureCapture = (over: Partial<SummaryCaptureInput> = {}): SummaryCaptureInput => ({
  width: 160,
  height: 120,
  minC: 22.1,
  maxC: 34.9,
  meanC: 29.3,
  stdC: 3.2,
  protocol: { bodyRegion: 'Knees', bodySite: 'knee', view: 'anterior' },
  captureSource: 'live_capture',
  simulated: false,
  pixelsWithReading: 19200,
  ...over,
})
const fixtureRois: SummaryRoiInput[] = [
  { label: 'Left knee', shape: 'ellipse', note: 'Drawn over the area the patient pointed to', stats: { pixelCount: 412, min: 30.12, max: 33.94, mean: 32.25, std: 0.81 } },
  { label: 'Right knee', shape: 'polygon', note: null, stats: { pixelCount: 398, min: 29.6, max: 33.03, mean: 30.85, std: 0.7 } },
]
const fixturePairs: ThermalPair[] = [{ a: 'Left knee', b: 'Right knee', meanDiff: 1.4, maxDiff: 0.91 }]
const fixtureFlags = (over: Partial<ThermalFlags> = {}): ThermalFlags => ({
  version: 'rules-v1',
  validated: false,
  disclaimer: 'Experimental rule-based flags. Not validated. Not a diagnosis.',
  params: RULES_PARAMS,
  image: { meanC: 29.31, stdC: 3.22, hotspotThresholdC: 35.75 },
  hotspots: [{ x: 93, y: 48, width: 9, height: 7, pixelCount: 41, maxC: 36.2, meanC: 35.9, aboveImageMeanC: 6.59 }],
  asymmetry: [{ a: 'Left knee', b: 'Right knee', meanDiffC: 1.4, flagged: true }],
  ...over,
})

/** Every number written in a text (version ids such as rules-v1 are names, not numbers). */
const numbersIn = (text: string) => [...text.replace(/\b[a-z]+(-[a-z]+)*-v\d+\b/g, '').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Math.abs(Number(m[0])))
const statNumbers = (s: RoiStats) => [s.pixelCount, s.min, s.max, s.mean, s.std].filter((v): v is number => v !== null)
const flagNumbers = (f: ThermalFlags) => [...Object.values(f.params), f.image.meanC, f.image.stdC, f.image.hotspotThresholdC, ...f.hotspots.flatMap((h) => Object.values(h)), ...f.asymmetry.map((a) => a.meanDiffC)]
const abs = (xs: number[]) => new Set(xs.map((x) => Math.abs(Number(x.toFixed(2)))))

/** Words that would make a summary a diagnosis, a score or a recommendation. */
const FORBIDDEN = [/pain score/i, /diagnos/i, /swelling detected/i, /fracture/i, /x-ray/i, /inflammation detected/i, /recommend/i, /suggests?\b/i, /consistent with/i, /likely/i, /abnormal/i]
/** The fixed limitation is the one place these words may appear: it says what the image does NOT show. */
const withoutLimitation = (text: string) => text.replace(THERMAL_LIMITATION_SURFACE, '')

describe('the composer: fixed rules, from stored numbers and the rules’ own output', () => {
  it('is deterministic and keeps its order: the measurements, each region, each pair, the rules, the model, then the limitations', () => {
    const a = composeThermalSummary(fixtureCapture(), fixtureRois, fixturePairs, fixtureFlags(), NO_MODEL)
    const b = composeThermalSummary(structuredClone(fixtureCapture()), structuredClone(fixtureRois), structuredClone(fixturePairs), structuredClone(fixtureFlags()), structuredClone(NO_MODEL))
    expect(b).toEqual(a)
    expect(a.composerVersion).toBe(THERMAL_SUMMARY_COMPOSER_VERSION)
    expect(a.composerVersion).toBe('thermal-summary-v1')
    expect(a.rulesVersion).toBe('rules-v1')
    expect(a.text).toBe(a.statements.map((s) => s.text).join('\n'))
    expect(a.statements.map((s) => s.basis)).toEqual(['measurement', 'measurement', 'measurement', 'measurement', 'rule', 'rule', 'model', 'limitation', 'limitation'])
    // Text written by staff (the body region, region labels, a region's comment) is quoted.
    expect(a.statements.map((s) => s.text)).toEqual([
      'Thermal image of “Knees” (Knee), anterior view, 19200 of 19200 pixels with a reading: whole image min 22.1 °C, max 34.9 °C, mean 29.3 °C, SD 3.2 °C.',
      'Region “Left knee” (ellipse, 412 pixels with a reading): min 30.12 °C, max 33.94 °C, mean 32.25 °C, SD 0.81 °C. Comment on this region (written by staff; not a measurement): “Drawn over the area the patient pointed to”.',
      'Region “Right knee” (polygon, 398 pixels with a reading): min 29.6 °C, max 33.03 °C, mean 30.85 °C, SD 0.7 °C.',
      '“Left knee” minus “Right knee”: mean difference 1.4 °C; difference of the highest values 0.91 °C.',
      'Thermal asymmetry of 1.4 °C between “Left knee” and “Right knee” (experimental rule rules-v1: flagged at 1.0 °C or more; not validated).',
      'Area warmer than the image average (experimental rule rules-v1: at least 2 SD above the image mean of 29.31 °C, 12 pixels or more; not validated): 41 pixels in the box at x 93, y 48 (9 × 7 pixels), mean 35.9 °C, highest 36.2 °C.',
      THERMAL_NO_MODEL,
      THERMAL_LIMITATION_SURFACE,
      THERMAL_LIMITATION_VALIDATION,
    ])
    expect(a.statements.find((s) => s.basis === 'model')!.text).toBe('No trained thermal model is installed: no model finding.')
  })

  it('states only numbers that were measured and stored, or that the rules returned; the measurements only the stored ones', () => {
    const capture = fixtureCapture()
    const flags = fixtureFlags()
    const s = composeThermalSummary(capture, fixtureRois, fixturePairs, flags, NO_MODEL)
    const stored = abs([capture.minC, capture.maxC, capture.meanC, capture.stdC!, capture.width, capture.height, capture.pixelsWithReading!, ...fixtureRois.flatMap((r) => statNumbers(r.stats)), ...fixturePairs.flatMap((p) => [p.meanDiff!, p.maxDiff!])])
    for (const st of s.statements.filter((x) => x.basis === 'measurement')) for (const n of numbersIn(st.text)) expect(stored.has(n), `${n} in “${st.text}”`).toBe(true)
    const ruled = abs(flagNumbers(flags))
    for (const st of s.statements.filter((x) => x.basis === 'rule')) for (const n of numbersIn(st.text)) expect(ruled.has(n), `${n} in “${st.text}”`).toBe(true)
    for (const st of s.statements.filter((x) => x.basis === 'model' || x.basis === 'limitation')) expect(numbersIn(st.text)).toEqual([])
  })

  it('never words a diagnosis, a score or a recommendation; the only mention of what the image cannot show is the fixed limitation', () => {
    for (const flags of [fixtureFlags(), fixtureFlags({ hotspots: [], asymmetry: [{ a: 'Left knee', b: 'Right knee', meanDiffC: 0.2, flagged: false }] }), null]) {
      for (const source of ['live_capture', 'gallery_import', 'file_upload', 'simulator'] as ThermalCaptureSource[]) {
        const s = composeThermalSummary(fixtureCapture({ captureSource: source, simulated: source === 'simulator' }), fixtureRois, fixturePairs, flags, NO_MODEL)
        for (const re of FORBIDDEN) expect(withoutLimitation(s.text), String(re)).not.toMatch(re)
        expect(s.text).toContain(THERMAL_LIMITATION_SURFACE)
        expect(s.text).toContain(THERMAL_LIMITATION_VALIDATION)
        expect(s.text).toContain(THERMAL_NO_MODEL)
      }
    }
  })

  it('labels a simulated capture SIMULATED and an imported one IMPORTED, before any number', () => {
    const sim = composeThermalSummary(fixtureCapture({ captureSource: 'simulator', simulated: true }), fixtureRois, fixturePairs, fixtureFlags(), NO_MODEL)
    expect(sim.statements[0]).toEqual({ basis: 'limitation', source: 'capture source', text: THERMAL_LABEL_SIMULATED })
    expect(sim.text.startsWith('SIMULATED: generated numbers, not a measurement of this patient.\n')).toBe(true)
    const imported = composeThermalSummary(fixtureCapture({ captureSource: 'gallery_import' }), fixtureRois, fixturePairs, fixtureFlags(), NO_MODEL)
    expect(imported.statements[0]!.text).toBe(THERMAL_LABEL_IMPORTED)
    expect(imported.text).not.toContain('SIMULATED')
    for (const source of ['live_capture', 'file_upload'] as ThermalCaptureSource[]) {
      const s = composeThermalSummary(fixtureCapture({ captureSource: source }), fixtureRois, fixturePairs, fixtureFlags(), NO_MODEL)
      expect(s.text).not.toMatch(/SIMULATED|IMPORTED/)
      expect(s.statements[0]!.basis).toBe('measurement')
    }
  })

  it('says so when the rules were not run, when they flagged nothing, and when a region has no reading; a model, if one were installed, is named and none of its output is stated', () => {
    const none = composeThermalSummary(fixtureCapture({ pixelsWithReading: null, stdC: null }), fixtureRois, fixturePairs, null, NO_MODEL)
    expect(none.rulesVersion).toBeNull()
    expect(none.statements.filter((s) => s.basis === 'rule')).toEqual([])
    expect(none.statements.map((s) => s.text)).toContain(THERMAL_RULES_NOT_RUN)
    expect(none.statements[0]!.text).toBe('Thermal image of “Knees” (Knee), anterior view, 160 × 120 pixels: whole image min 22.1 °C, max 34.9 °C, mean 29.3 °C.')

    const quiet = composeThermalSummary(fixtureCapture(), fixtureRois, fixturePairs, fixtureFlags({ hotspots: [], asymmetry: [{ a: 'Left knee', b: 'Right knee', meanDiffC: 0.4, flagged: false }] }), NO_MODEL)
    expect(quiet.statements.filter((s) => s.basis === 'rule').map((s) => s.text)).toEqual([
      'No thermal asymmetry of 1.0 °C or more between the paired regions (experimental rule rules-v1; not validated).',
      'No area at least 2 SD above the image mean over 12 pixels or more (experimental rule rules-v1; not validated).',
    ])

    const empty = composeThermalSummary(fixtureCapture(), [{ label: 'Ankle', shape: 'rect', stats: { pixelCount: 0, min: null, max: null, mean: null, std: null } }], [{ a: 'Ankle', b: 'Knee', meanDiff: null, maxDiff: null }], null, NO_MODEL)
    expect(empty.statements[1]!.text).toBe('Region “Ankle” (rectangle): no pixel with a reading.')
    expect(empty.statements[2]!.text).toBe('“Ankle” minus “Knee”: no difference can be given (a region has no pixel with a reading).')

    const model: ThermalModelStatus = { available: true, kind: 'research', modelId: 'example-model', version: '0.1', artifactSha256: 'a'.repeat(64), intendedUse: 'research only', evaluation: null, reason: null }
    const withModel = composeThermalSummary(fixtureCapture(), [], [], null, model)
    expect(withModel.statements.find((s) => s.basis === 'model')!.text).toBe('Thermal model example-model 0.1 (research) is installed; this summary contains no output from it.')
  })

  it('states text written by staff only quoted, on one line and shortened: a comment never reads as a measurement or a rule, nor makes a line of its own', () => {
    // A comment typed over several lines, with words no summary may state, a pain score, its own quotation marks and an imitation of a rule
    // statement; a body region and a label typed over two lines.
    const note = 'Patient pointed here.\nPain 8/10; suspected fracture, X-ray advised.\n\n  ” Thermal asymmetry of 9 °C between A and B (experimental rule rules-v1: flagged)'
    const rois: SummaryRoiInput[] = [{ ...fixtureRois[0]!, label: 'Left\nknee', note }, fixtureRois[1]!]
    const s = composeThermalSummary(fixtureCapture({ protocol: { bodyRegion: 'Knees\nDiagnosis: arthritis', bodySite: 'knee', view: 'anterior' } }), rois, [{ ...fixturePairs[0]!, a: 'Left\nknee' }], fixtureFlags({ asymmetry: [{ a: 'Left\nknee', b: 'Right knee', meanDiffC: 1.4, flagged: true }] }), NO_MODEL)
    // One line per statement: nothing written by staff starts a line.
    expect(s.text.split('\n')).toEqual(s.statements.map((x) => x.text))
    for (const x of s.statements) expect(x.text).not.toMatch(/\n/)
    for (const line of s.text.split('\n')) expect(line).not.toMatch(/^(Pain|X-ray|Diagnosis|”)/)

    const region = s.statements.find((x) => x.source === 'region “Left knee”')!
    expect(region.basis).toBe('measurement')
    // Cut at the quoting limit (80 characters, the last an ellipsis), whitespace collapsed, its own curly quote made straight so it cannot end the quote.
    const shown = 'Patient pointed here. Pain 8/10; suspected fracture, X-ray advised. " Thermal a…'
    expect([...shown]).toHaveLength(QUOTED_MAX)
    expect(region.text).toBe(`Region “Left knee” (ellipse, 412 pixels with a reading): min 30.12 °C, max 33.94 °C, mean 32.25 °C, SD 0.81 °C. Comment on this region (written by staff; not a measurement): “${shown}”.`)
    expect(s.statements[0]!.text).toMatch(/^Thermal image of “Knees Diagnosis: arthritis” \(Knee\), anterior view, /)
    expect(s.statements.map((x) => x.text)).toContain('“Left knee” minus “Right knee”: mean difference 1.4 °C; difference of the highest values 0.91 °C.')
    expect(s.statements.map((x) => x.text)).toContain('Thermal asymmetry of 1.4 °C between “Left knee” and “Right knee” (experimental rule rules-v1: flagged at 1.0 °C or more; not validated).')

    // Outside the quotes the summary is the composer's own words: no forbidden word, and every number a stored or a rule's one.
    const unquoted = (t: string) => t.replace(/“[^“”]*”/g, '“…”')
    expect(s.text.replace(/“[^“”]*”/g, '')).not.toMatch(/[“”]/)
    for (const re of FORBIDDEN) expect(withoutLimitation(unquoted(s.text)), String(re)).not.toMatch(re)
    const allowed = abs([22.1, 34.9, 29.3, 3.2, 160, 120, 19200, ...fixtureRois.flatMap((r) => statNumbers(r.stats)), 1.4, 0.91, ...flagNumbers(fixtureFlags())])
    for (const x of s.statements) for (const n of numbersIn(unquoted(x.text))) expect(allowed.has(n), `${n} in “${x.text}”`).toBe(true)

    expect(quoted('  short  ')).toBe('“short”')
    expect(quoted('x'.repeat(200))).toBe(`“${'x'.repeat(QUOTED_MAX - 1)}…”`)
    expect(quoted('😀'.repeat(100))).toBe(`“${'😀'.repeat(QUOTED_MAX - 1)}…”`) // cut between characters, never inside one
  })

  it('the largest study the inputs allow fits the note: regions and pairs beyond those listed are counted, and the text can be edited and inserted whole', () => {
    // 20 regions (the most that can be saved) with the longest labels and long comments over several lines, a pair for each region, every pair
    // flagged, ten hotspots, the longest body region and wide numbers: no summary is longer.
    const label = (i: number) => `Region ${String(i).padStart(2, '0')} ${'on the back of the left hand'.padEnd(30, '.')}`
    const rois: SummaryRoiInput[] = Array.from({ length: 20 }, (_, i) => ({ label: label(i), shape: 'polygon', note: 'A comment written over several lines.\n'.repeat(9).slice(0, 300), stats: { pixelCount: 327680, min: -123.45, max: -123.45, mean: -123.45, std: 123.45 } }))
    expect(rois.every((r) => r.label.length === 40)).toBe(true)
    const pairs: ThermalPair[] = rois.map((r, i) => ({ a: r.label, b: rois[(i + 1) % 20]!.label, meanDiff: -123.45, maxDiff: -123.45 }))
    const hotspot = { x: 12345.67, y: 12345.67, width: 12345.67, height: 12345.67, pixelCount: 327680, maxC: -123.45, meanC: -123.45, aboveImageMeanC: 123.45 }
    const flags = fixtureFlags({ params: { asymmetry_threshold_c: 1.25, hotspot_k: 2.25, hotspot_min_pixels: 12345, max_hotspots: 10 }, image: { meanC: -123.45, stdC: 123.45, hotspotThresholdC: 123.45 }, hotspots: Array.from({ length: 10 }, () => hotspot), asymmetry: pairs.map((p) => ({ a: p.a, b: p.b, meanDiffC: -123.45, flagged: true })) })
    const capture = fixtureCapture({ width: 640, height: 512, minC: -123.45, maxC: -123.45, meanC: -123.45, stdC: 123.45, pixelsWithReading: 327680, captureSource: 'gallery_import', protocol: { bodyRegion: 'B'.repeat(80), bodySite: 'other', view: 'right_lateral' } })
    const s = composeThermalSummary(capture, rois, pairs, flags, NO_MODEL)

    expect(s.text.length).toBeLessThanOrEqual(THERMAL_SUMMARY_TEXT_MAX)
    expect(THERMAL_SUMMARY_TEXT_MAX).toBe(8000)
    expect(s.statements.filter((x) => x.source.startsWith('region “'))).toHaveLength(REGIONS_LISTED)
    expect(s.statements.filter((x) => x.source.startsWith('regions “'))).toHaveLength(PAIRS_LISTED)
    expect(s.statements.map((x) => x.text)).toEqual(
      expect.arrayContaining([
        `${20 - REGIONS_LISTED} more regions are not listed in this summary; the image shows every region.`,
        `${20 - PAIRS_LISTED} more pairs of regions are not listed in this summary; the image shows every pair.`,
        `${20 - PAIRS_LISTED} more pairs of regions were flagged by the same experimental rule (rules-v1; not validated); the image shows every flagged pair.`,
        '7 more areas met the same experimental rule (rules-v1; not validated); the image shows them.',
      ]),
    )
    // The doctor can edit the whole text, and insert it into the note as it is.
    expect(ThermalSummaryReviewRequest.safeParse({ decision: 'edited', text: `${s.text} Reviewed.` }).success).toBe(true)
    expect(InsertIntoNoteRequest.safeParse({ version: 1, section: 'examination', text: s.text, subjectType: 'thermal_summary', subjectId: crypto.randomUUID() }).success).toBe(true)
    // One more region, or one fewer, counts the same way.
    expect(composeThermalSummary(capture, rois.slice(0, REGIONS_LISTED + 1), [], null, NO_MODEL).statements.map((x) => x.text)).toContain('1 more region is not listed in this summary; the image shows every region.')
    expect(composeThermalSummary(capture, rois.slice(0, REGIONS_LISTED), [], null, NO_MODEL).statements.some((x) => x.source === 'regions')).toBe(false)
  })
})

// --- the API ----------------------------------------------------------------------------------------------------------------------------

/** Statistics of the pixels of a box, rounded as the thermal service rounds them (its region statistics, worked out here for the fixture). */
function boxStats(m: Float32Array, box: { x: number; y: number; width: number; height: number }): RoiStats {
  const values: number[] = []
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) values.push(m[y * THERMAL_SIM_SIZE.width + x]!)
  const s = thermalStats(values)
  return { pixelCount: s.pixelCount, min: s.minC, max: s.maxC, mean: s.meanC, std: s.stdC }
}
const round2 = (v: number) => Math.round(v * 100) / 100
// Boxes around the simulator's warm spot and its mirror image (the generated oval is symmetric about the middle column).
const LEFT = { x: 93, y: 48, width: 12, height: 12 }
const RIGHT = { x: 55, y: 48, width: 12, height: 12 }

/**
 * The thermal service, as a labelled test double. Its rule output follows rules-v1 on the stored statistics: the image mean and SD over the pixels
 * with a reading, and a pair flagged when its mean difference is at least 1.0 °C. It finds no hotspot (the composer's own tests cover those).
 */
const flagsCalls: FlagsInput[] = []
const fakeThermal: Partial<ThermalService> = {
  async flags(input) {
    flagsCalls.push(input)
    const m = new Float32Array(input.matrix.buffer.slice(input.matrix.byteOffset, input.matrix.byteOffset + input.matrix.length))
    const img = thermalStats(m)
    const box = (id: string) => (id === 'left knee' ? LEFT : RIGHT)
    return {
      version: 'rules-v1',
      validated: false,
      disclaimer: 'Experimental rule-based flags. Not validated. Not a diagnosis.',
      params: RULES_PARAMS,
      image: { meanC: img.meanC!, stdC: img.stdC!, hotspotThresholdC: round2(img.meanC! + 2 * img.stdC!) },
      hotspots: [],
      asymmetry: input.pairs.map((p) => {
        const d = round2(boxStats(m, box(p.a)).mean! - boxStats(m, box(p.b)).mean!)
        return { a: p.a, b: p.b, meanDiffC: d, flagged: Math.abs(d) >= RULES_PARAMS.asymmetry_threshold_c }
      }),
    }
  },
  async modelStatus() {
    return NO_MODEL
  },
}

const settings = loadAppSettings()
const generous = { ...settings, security: { ...settings.security, rateLimits: { ...settings.security.rateLimits, loginPerIp: { max: 100_000, windowSeconds: 60 }, loginPerAccount: { max: 100_000, windowSeconds: 60 } } } }
const ctx = createTestApp({ thermal: fakeThermal as ThermalService, settings: generous })
let fx: Fixture
let nurse = ''
let doctor = ''
afterAll(() => ctx.close())

const audits = async (action: string) => (await adminQuery('SELECT actor_user_id, outcome, entity_id, patient_id, details FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows as { actor_user_id: string; outcome: string; entity_id: string; patient_id: string; details: Record<string, unknown> }[]
const sessionOf = (who: 'doctor' | 'nurse'): SessionUser => ({ id: fx.users[who], sessionId: 'test', username: `t.${who}`, fullName: `Test t.${who}`, role: who, facilityId: fx.facilityId, departmentId: fx.departments.gen, patientId: null, mustChangePassword: false })

let seq = 0
/** A patient (with consent to thermal imaging unless told otherwise), a visit and the doctor's consultation. */
async function consultation(o: { consent?: boolean; patientId?: string } = {}) {
  seq++
  const p = o.patientId
    ? { id: o.patientId }
    : PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Therm${'abcdefghij'[seq % 10]}${'klmnopqrst'[Math.floor(seq / 10) % 10]}`, phone: `98402 ${String(10000 + seq)}` }) })).json())
  if (!o.patientId && o.consent !== false) expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'thermal_imaging', method: 'verbal' } })).statusCode).toBe(201)
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Knee review' } })).json())
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  return { p, v, e }
}

/**
 * A capture stored as the capture routes store one, inserted directly (so these tests do not depend on the camera, the simulator route or the
 * thermal service): the simulator's matrix for a seed in the file store, its whole-image statistics, two regions and their pair, and as many
 * more regions as asked (with long labels and comments, unpaired). Approved unless told otherwise, as a doctor approves one on the review route:
 * a summary is composed only of an approved image.
 */
async function storeCapture(o: { patientId: string; encounterId: string | null; source?: ThermalCaptureSource; seed?: number; status?: 'draft' | 'approved' | 'rejected'; capturedAt?: Date; moreRegions?: number }) {
  const source = o.source ?? 'live_capture'
  const m = simulateThermalMatrix('localized_difference', o.seed ?? 7)
  const st = thermalStats(m)
  const matrix = await storeBytes(testConfig.storageDir, Buffer.from(m.buffer), '.f32')
  const base = { facilityId: fx.facilityId, patientId: o.patientId, encounterId: o.encounterId, uploadedBy: fx.users.nurse }
  const [rawFile] = await ctx.db.insert(files).values({ ...base, kind: 'thermal_raw', storageKey: `test/${crypto.randomUUID()}.jpg`, originalName: 'capture.jpg', mimeType: 'image/jpeg', sizeBytes: 1, sha256: 'f'.repeat(64) }).returning()
  const [matrixFile] = await ctx.db.insert(files).values({ ...base, kind: 'thermal_matrix', storageKey: matrix.storageKey, originalName: 'matrix.f32', mimeType: 'application/octet-stream', sizeBytes: matrix.sizeBytes, sha256: matrix.sha256 }).returning()
  const left = boxStats(m, LEFT)
  const right = boxStats(m, RIGHT)
  const pair: ThermalPair = { a: 'Left knee', b: 'Right knee', meanDiff: round2(left.mean! - right.mean!), maxDiff: round2(left.max! - right.max!) }
  const [c] = await ctx.db
    .insert(thermalCaptures)
    .values({
      ...base,
      rawFileId: rawFile!.id,
      matrixFileId: matrixFile!.id,
      width: THERMAL_SIM_SIZE.width,
      height: THERMAL_SIM_SIZE.height,
      minC: st.minC!,
      maxC: st.maxC!,
      meanC: st.meanC!,
      stdC: st.stdC,
      camera: { make: null, model: null, dateTime: null },
      parameters: {},
      extractor: { name: 'test-fixture', version: '0' },
      protocol: { bodyRegion: 'Knees', bodySite: 'knee', view: 'anterior' },
      pairStats: [pair],
      dataOrigin: 'synthetic',
      captureSource: source,
      simulated: source === 'simulator',
      capturedAt: o.capturedAt ?? null,
      createdBy: fx.users.nurse,
    })
    .returning()
  // Further regions: small boxes along the top of the image, each with its own statistics.
  const more = Array.from({ length: o.moreRegions ?? 0 }, (_, i) => {
    const box = { x: 2 + i * 8, y: 4, width: 6, height: 6 }
    return { captureId: c!.id, label: `Region ${String(i + 1).padStart(2, '0')} on the back of the hand`, shape: 'rect', ...box, pairWith: null, note: `A comment on region ${i + 1}, written by the doctor over two lines,\nlong enough to be shortened in the summary.`, stats: boxStats(m, box), sortOrder: i + 2, createdBy: fx.users.doctor }
  })
  await ctx.db.insert(thermalRois).values([
    { captureId: c!.id, label: 'Left knee', shape: 'rect', ...LEFT, pairWith: 'Right knee', note: 'Drawn over the warm area seen on screen', stats: left, sortOrder: 0, createdBy: fx.users.doctor },
    { captureId: c!.id, label: 'Right knee', shape: 'rect', ...RIGHT, pairWith: null, note: null, stats: right, sortOrder: 1, createdBy: fx.users.doctor },
    ...more,
  ])
  const status = o.status ?? 'approved'
  if (status !== 'draft') await ctx.db.update(thermalCaptures).set({ status, reviewNote: status === 'rejected' ? 'Out of focus' : null, reviewedBy: fx.users.doctor, reviewedAt: new Date() }).where(captureIs(c!.id))
  return { capture: c!, stats: st, left, right, pair, matrixFileId: matrixFile!.id }
}

/**
 * A summary stored before summaries were composed only of approved images (the routes no longer make one; inserted directly, as the database
 * allows: pending, then decided once).
 */
async function storedEarlier(capture: { id: string; patientId: string; encounterId: string | null }, decision?: 'accepted') {
  const [s] = await ctx.db
    .insert(thermalSummaries)
    .values({ facilityId: fx.facilityId, patientId: capture.patientId, encounterId: capture.encounterId, captureId: capture.id, composerVersion: 'thermal-summary-v1', rulesVersion: null, model: NO_MODEL, statements: [], text: 'A summary composed while its image was a draft (test fixture).', simulated: false, createdBy: fx.users.doctor })
    .returning()
  if (decision) await ctx.db.update(thermalSummaries).set({ status: decision, decidedBy: fx.users.doctor, decidedAt: new Date() }).where(eq(thermalSummaries.id, s!.id))
  return s!
}
const captureIs = (id: string) => eq(thermalCaptures.id, id)

const generate = (captureId: string, cookie = doctor) => call(ctx.app, 'POST', `/api/thermal/${captureId}/summaries`, { cookie })
const review = (summaryId: string, body: object, cookie = doctor) => call(ctx.app, 'POST', `/api/thermal-summaries/${summaryId}/review`, { cookie, body })
const insert = (e: { id: string; version: number }, body: object, cookie = doctor) => call(ctx.app, 'POST', `/api/encounters/${e.id}/insertions`, { cookie, body: { version: e.version, section: 'examination', subjectType: 'thermal_summary', ...body } })
async function generated(captureId: string): Promise<ThermalSummary> {
  const res = await generate(captureId)
  expect(res.statusCode, res.body).toBe(201)
  return ThermalSummary.parse(res.json())
}

describe('thermal summaries (API)', () => {
  beforeEach(async () => {
    await resetDatabase()
    fx = await createFixture(ctx.db)
    nurse = await login(ctx.app, 't.nurse')
    doctor = await login(ctx.app, 't.doctor')
    flagsCalls.length = 0
  })

  describe('composing', () => {
    it('a doctor composes a summary of a consenting patient’s capture from the stored statistics and the rules’ output; it is stored pending and audited', async () => {
      const { p, e } = await consultation()
      const { capture, stats, left, right, pair } = await storeCapture({ patientId: p.id, encounterId: e.id })
      expect(Math.abs(pair.meanDiff!)).toBeGreaterThanOrEqual(1) // the fixture's boxes differ by more than the rule's threshold

      expect((await generate(capture.id, nurse)).statusCode).toBe(403)
      const s = await generated(capture.id)
      expect(s).toMatchObject({ captureId: capture.id, encounterId: e.id, status: 'pending', finalText: null, decidedAt: null, decidedByName: null, simulated: false, composerVersion: 'thermal-summary-v1', rulesVersion: 'rules-v1', createdByName: 'Test t.doctor' })
      expect(s.model).toMatchObject({ available: false, modelId: null })
      expect(s.text).toBe(s.statements.map((x) => x.text).join('\n'))
      expect(s.statements[0]!.text).toBe(`Thermal image of “Knees” (Knee), anterior view, 19200 of 19200 pixels with a reading: whole image min ${stats.minC} °C, max ${stats.maxC} °C, mean ${stats.meanC} °C, SD ${stats.stdC} °C.`)
      expect(s.statements.map((x) => x.text)).toContain(`Thermal asymmetry of ${Math.abs(pair.meanDiff!)} °C between “Left knee” and “Right knee” (experimental rule rules-v1: flagged at 1.0 °C or more; not validated).`)
      expect(s.statements.map((x) => x.text)).toContain(THERMAL_NO_MODEL)

      // What the rules were given: the stored matrix and the regions, by their labels.
      expect(flagsCalls).toHaveLength(1)
      expect(flagsCalls[0]!.matrix.length).toBe(160 * 120 * 4)
      expect(flagsCalls[0]!.rois.map((r) => [r.id, r.shape])).toEqual([['left knee', 'rect'], ['right knee', 'rect']])
      expect(flagsCalls[0]!.pairs).toEqual([{ a: 'left knee', b: 'right knee' }])

      // Every number of a measurement is a stored one (the database's own values), and every number of a rule statement is the rules' output.
      const row = (await adminQuery('SELECT min_c::float AS min, max_c::float AS max, mean_c::float AS mean, std_c::float AS std FROM thermal_captures WHERE id = $1', [capture.id])).rows[0]
      const stored = abs([row.min, row.max, row.mean, row.std, 160, 120, 19200, ...statNumbers(left), ...statNumbers(right), pair.meanDiff!, pair.maxDiff!])
      for (const st of s.statements.filter((x) => x.basis === 'measurement')) for (const n of numbersIn(st.text)) expect(stored.has(n), `${n} in “${st.text}”`).toBe(true)
      for (const st of s.statements.filter((x) => x.basis === 'rule')) for (const n of numbersIn(st.text)) expect(abs([...Object.values(RULES_PARAMS), Math.abs(pair.meanDiff!)]).has(n), `${n} in “${st.text}”`).toBe(true)
      for (const re of FORBIDDEN) expect(withoutLimitation(s.text)).not.toMatch(re)

      expect(await audits('thermal.summary_generate')).toEqual([{ actor_user_id: fx.users.doctor, outcome: 'success', entity_id: s.id, patient_id: p.id, details: { captureId: capture.id, summaryId: s.id, composerVersion: 'thermal-summary-v1', rulesVersion: 'rules-v1', simulated: false } }])
      // Stored as composed.
      const dbRow = (await adminQuery('SELECT status, text, simulated, encounter_id, statements FROM thermal_summaries WHERE id = $1', [s.id])).rows[0]
      expect(dbRow).toMatchObject({ status: 'pending', text: s.text, simulated: false, encounter_id: e.id })
      expect(dbRow.statements).toEqual(s.statements)
    })

    it('lists a capture’s summaries newest first, for doctors and nurses of the facility', async () => {
      const { p, e } = await consultation()
      const { capture } = await storeCapture({ patientId: p.id, encounterId: e.id })
      const first = await generated(capture.id)
      const second = await generated(capture.id)
      const res = await call(ctx.app, 'GET', `/api/thermal/${capture.id}/summaries`, { cookie: nurse })
      expect(res.statusCode).toBe(200)
      const list = (res.json().summaries as unknown[]).map((x) => ThermalSummary.parse(x))
      expect(list.map((x) => x.id)).toEqual([second.id, first.id])
      expect(await audits('thermal.summary_list')).toEqual([expect.objectContaining({ actor_user_id: fx.users.nurse, entity_id: capture.id, details: { count: 2 } })])
    })

    it('needs the patient’s consent to thermal imaging: none recorded, or withdrawn, and nothing is composed', async () => {
      const without = await consultation({ consent: false })
      const a = await storeCapture({ patientId: without.p.id, encounterId: without.e.id })
      const res = await generate(a.capture.id)
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('consent_required')

      const withdrawn = await consultation()
      const b = await storeCapture({ patientId: withdrawn.p.id, encounterId: withdrawn.e.id })
      const consentId = (await adminQuery("SELECT id FROM consents WHERE patient_id = $1 AND type = 'thermal_imaging'", [withdrawn.p.id])).rows[0].id
      expect((await call(ctx.app, 'POST', `/api/patients/${withdrawn.p.id}/consents/${consentId}/withdraw`, { cookie: nurse, body: { reason: 'Changed mind' } })).statusCode).toBe(200)
      expect((await generate(b.capture.id)).json().error).toBe('consent_withdrawn')
      expect((await adminQuery('SELECT count(*)::int AS n FROM thermal_summaries')).rows[0].n).toBe(0)
      expect(flagsCalls).toHaveLength(0)
    })

    it('without the stored matrix the rules are not run, and the summary says so; a rejected image gets no summary', async () => {
      const { p, e } = await consultation()
      const { capture, matrixFileId } = await storeCapture({ patientId: p.id, encounterId: e.id })
      await adminQuery("UPDATE files SET deleted_at = now(), deleted_reason = 'retention (test)' WHERE id = $1", [matrixFileId])
      const s = await generated(capture.id)
      expect(flagsCalls).toHaveLength(0)
      expect(s.rulesVersion).toBeNull()
      expect(s.statements.filter((x) => x.basis === 'rule')).toEqual([])
      expect(s.text).toContain(THERMAL_RULES_NOT_RUN)
      expect(s.statements[0]!.text).toMatch(/^Thermal image of “Knees” \(Knee\), anterior view, 160 × 120 pixels: whole image min/)

      const other = await storeCapture({ patientId: p.id, encounterId: e.id, seed: 8, status: 'rejected' })
      expect((await generate(other.capture.id)).json().error).toBe('thermal_rejected')
    })

    it('only of an approved image, whose measurements and regions can no longer change: a draft and a rejected one are refused, and nothing is composed', async () => {
      const { p, e } = await consultation()
      const draft = await storeCapture({ patientId: p.id, encounterId: e.id, status: 'draft' })
      const res = await generate(draft.capture.id)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'thermal_not_approved', message: 'Approve the image first: a summary is composed from an approved image, whose measurements and regions can no longer change.' })
      const rejected = await storeCapture({ patientId: p.id, encounterId: e.id, seed: 8, status: 'rejected' })
      const refusedRejected = await generate(rejected.capture.id)
      expect([refusedRejected.statusCode, refusedRejected.json().error]).toEqual([409, 'thermal_rejected'])
      expect((await adminQuery('SELECT count(*)::int AS n FROM thermal_summaries')).rows[0].n).toBe(0)
      expect(await audits('thermal.summary_generate')).toEqual([])
      expect(flagsCalls).toHaveLength(0)

      // Approved on the review route, the draft's regions are frozen, and its summary can be composed.
      expect((await call(ctx.app, 'POST', `/api/thermal/${draft.capture.id}/review`, { cookie: doctor, body: { decision: 'approved' } })).json().status).toBe('approved')
      const redraw = await call(ctx.app, 'PUT', `/api/thermal/${draft.capture.id}/rois`, { cookie: doctor, body: { rois: [{ label: 'Left knee', shape: 'rect', ...RIGHT }] } })
      expect([redraw.statusCode, redraw.json().error]).toEqual([409, 'thermal_reviewed'])
      await expect(ctx.pool.query('DELETE FROM thermal_rois WHERE capture_id = $1', [draft.capture.id])).rejects.toMatchObject({ code: '42501' })
      expect((await generated(draft.capture.id)).captureId).toBe(draft.capture.id)
    })

    it('marks a simulated capture’s summary simulated and labels it SIMULATED first; an imported one IMPORTED', async () => {
      const { p, e } = await consultation()
      const sim = await storeCapture({ patientId: p.id, encounterId: e.id, source: 'simulator' })
      const s = await generated(sim.capture.id)
      expect(s.simulated).toBe(true)
      expect(s.statements[0]!.text).toBe(THERMAL_LABEL_SIMULATED)
      expect((await audits('thermal.summary_generate'))[0]!.details).toMatchObject({ simulated: true })
      const imported = await storeCapture({ patientId: p.id, encounterId: e.id, source: 'gallery_import', seed: 9 })
      const i = await generated(imported.capture.id)
      expect(i.simulated).toBe(false)
      expect(i.statements[0]!.text).toBe(THERMAL_LABEL_IMPORTED)
    })
  })

  describe('the doctor’s decision', () => {
    it('is taken once, by a doctor: accepted, edited (with the edit) or rejected; a second decision is refused', async () => {
      const { p, e } = await consultation()
      const { capture } = await storeCapture({ patientId: p.id, encounterId: e.id })
      const a = await generated(capture.id)
      expect((await review(a.id, { decision: 'accepted' }, nurse)).statusCode).toBe(403)
      const accepted = ThermalSummary.parse((await review(a.id, { decision: 'accepted' })).json())
      expect(accepted).toMatchObject({ status: 'accepted', finalText: null, decidedByName: 'Test t.doctor' })
      expect(accepted.decidedAt).not.toBeNull()
      const again = await review(a.id, { decision: 'rejected' })
      expect(again.statusCode).toBe(409)
      expect(again.json().error).toBe('summary_decided')

      const b = await generated(capture.id)
      expect((await review(b.id, { decision: 'edited' })).statusCode).toBe(400)
      const edited = ThermalSummary.parse((await review(b.id, { decision: 'edited', text: '  Left knee warmer than right on this image; measurements only.  ' })).json())
      expect(edited).toMatchObject({ status: 'edited', finalText: 'Left knee warmer than right on this image; measurements only.', text: b.text })

      const c = await generated(capture.id)
      expect(ThermalSummary.parse((await review(c.id, { decision: 'rejected' })).json())).toMatchObject({ status: 'rejected', finalText: null })
      expect((await audits('thermal.summary_review')).map((x) => x.details)).toEqual([
        { captureId: capture.id, decision: 'accepted', simulated: false },
        { captureId: capture.id, decision: 'edited', simulated: false },
        { captureId: capture.id, decision: 'rejected', simulated: false },
      ])
    })

    it('the database keeps what a summary says and its decision: no change, no deletion, no summary that starts decided', async () => {
      const { p, e } = await consultation()
      const { capture } = await storeCapture({ patientId: p.id, encounterId: e.id })
      const pending = await generated(capture.id)
      await expect(ctx.pool.query("UPDATE thermal_summaries SET text = 'changed' WHERE id = $1", [pending.id])).rejects.toMatchObject({ code: '42501' })
      await expect(ctx.pool.query('DELETE FROM thermal_summaries WHERE id = $1', [pending.id])).rejects.toMatchObject({ code: '42501' })
      await review(pending.id, { decision: 'accepted' })
      await expect(ctx.pool.query("UPDATE thermal_summaries SET status = 'rejected' WHERE id = $1", [pending.id])).rejects.toMatchObject({ code: '42501' })
      await expect(ctx.pool.query("UPDATE thermal_summaries SET final_text = 'later' , status = 'edited' WHERE id = $1", [pending.id])).rejects.toMatchObject({ code: '42501' })
      const cols = 'facility_id, patient_id, encounter_id, capture_id, composer_version, model, statements, text'
      const vals = [fx.facilityId, p.id, e.id, capture.id, 'thermal-summary-v1', '{}', '[]', 'x']
      await expect(ctx.pool.query(`INSERT INTO thermal_summaries (${cols}, status, decided_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'accepted', now())`, vals)).rejects.toMatchObject({ code: '23514' })
      await expect(ctx.pool.query(`INSERT INTO thermal_summaries (${cols}, simulated) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`, vals)).rejects.toMatchObject({ code: '23514' })
      expect((await adminQuery('SELECT status, text FROM thermal_summaries WHERE id = $1', [pending.id])).rows[0]).toEqual({ status: 'accepted', text: pending.text })
    })

    it('an edit may be as long as the note section the summary goes to: a long summary is edited whole and added to the note', async () => {
      const { p, e } = await consultation()
      // Twenty regions, each with a long label and a comment: the most a capture can have.
      const { capture } = await storeCapture({ patientId: p.id, encounterId: e.id, moreRegions: 18 })
      const s = await generated(capture.id)
      expect(s.text.length).toBeGreaterThan(2000) // longer than the edit limit before V6's review
      expect(s.statements.map((x) => x.text)).toContain(`${20 - REGIONS_LISTED} more regions are not listed in this summary; the image shows every region.`)
      expect((await review(s.id, { decision: 'edited', text: 'x'.repeat(8001) })).statusCode).toBe(400)
      const text = s.text.replace('Thermal image of', 'Thermal image (reviewed with the patient) of')
      const res = await review(s.id, { decision: 'edited', text })
      expect(res.statusCode, res.body).toBe(200)
      expect(ThermalSummary.parse(res.json())).toMatchObject({ status: 'edited', finalText: text })
      const added = await insert(e, { text, subjectId: s.id })
      expect(added.statusCode, added.body).toBe(201)
      expect(Encounter.parse(added.json()).note.examination).toBe(text)
    })

    it('only while its image is approved: a summary stored before that rule, of an image still a draft or since rejected, is not decided', async () => {
      const { p, e } = await consultation()
      const draft = await storeCapture({ patientId: p.id, encounterId: e.id, status: 'draft' })
      const rejected = await storeCapture({ patientId: p.id, encounterId: e.id, seed: 8, status: 'rejected' })
      for (const c of [draft, rejected]) {
        const s = await storedEarlier(c.capture)
        const res = await review(s.id, { decision: 'accepted' })
        expect([res.statusCode, res.json().error]).toEqual([409, 'thermal_not_approved'])
        expect((await adminQuery('SELECT status, decided_at FROM thermal_summaries WHERE id = $1', [s.id])).rows[0]).toEqual({ status: 'pending', decided_at: null })
      }
      expect(await audits('thermal.summary_review')).toEqual([])
    })
  })

  describe('Add to consultation (the note insertion route)', () => {
    it('only an accepted or edited summary of this consultation, exactly as reviewed, with its rules versions recorded and no model', async () => {
      const { p, e } = await consultation()
      const { capture } = await storeCapture({ patientId: p.id, encounterId: e.id })
      const s = await generated(capture.id)
      const pendingRes = await insert(e, { text: s.text, subjectId: s.id })
      expect(pendingRes.statusCode).toBe(409)
      expect(pendingRes.json().error).toBe('not_reviewed')

      await review(s.id, { decision: 'accepted' })
      expect((await insert(e, { text: `${s.text} Looks inflamed.`, subjectId: s.id })).json().error).toBe('text_mismatch')
      const res = await insert(e, { text: s.text, subjectId: s.id })
      expect(res.statusCode, res.body).toBe(201)
      const enc = Encounter.parse(res.json())
      expect(enc.note.examination).toBe(s.text)
      expect(enc.aiInsertions).toEqual([expect.objectContaining({ section: 'examination', subjectType: 'thermal_summary', subjectId: s.id, producedBy: 'thermal-summary-v1 · rules-v1', insertedByName: 'Test t.doctor', retained: true })])
      expect((await insert(enc, { text: s.text, subjectId: s.id })).json().error).toBe('already_inserted')
      expect((await audits('encounter.ai_insert'))[0]!.details).toMatchObject({ subjectType: 'thermal_summary', subjectId: s.id, section: 'examination' })

      // An edited summary: its edit, and only its edit.
      const b = await generated(capture.id)
      await review(b.id, { decision: 'edited', text: 'Left knee warmer than the right on this image (measurement only).' })
      expect((await insert(enc, { text: b.text, subjectId: b.id })).json().error).toBe('text_mismatch')
      const afterEdit = Encounter.parse((await insert(enc, { section: 'assessment', text: 'Left knee warmer than the right on this image (measurement only).', subjectId: b.id })).json())
      expect(afterEdit.note.assessment).toBe('Left knee warmer than the right on this image (measurement only).')

      // A rejected one never.
      const c = await generated(capture.id)
      await review(c.id, { decision: 'rejected' })
      expect((await insert(afterEdit, { text: c.text, subjectId: c.id })).json().error).toBe('not_reviewed')
      // Nobody but the authoring doctor inserts (nurses have no ai:use).
      expect((await insert(afterEdit, { text: s.text, section: 'plan', subjectId: s.id }, nurse)).statusCode).toBe(403)
    })

    it('without the rules’ output, the producer is the composer alone', async () => {
      const { p, e } = await consultation()
      const { capture, matrixFileId } = await storeCapture({ patientId: p.id, encounterId: e.id })
      await adminQuery("UPDATE files SET deleted_at = now(), deleted_reason = 'retention (test)' WHERE id = $1", [matrixFileId])
      const s = await generated(capture.id)
      await review(s.id, { decision: 'accepted' })
      const enc = Encounter.parse((await insert(e, { text: s.text, subjectId: s.id })).json())
      expect(enc.aiInsertions[0]!.producedBy).toBe('thermal-summary-v1')
    })

    it('never a simulated summary, even accepted', async () => {
      const { p, e } = await consultation()
      const sim = await storeCapture({ patientId: p.id, encounterId: e.id, source: 'simulator' })
      const s = await generated(sim.capture.id)
      await review(s.id, { decision: 'accepted' })
      const res = await insert(e, { text: s.text, subjectId: s.id })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'simulated_not_allowed', message: 'A simulated thermal summary cannot be added to a consultation note.' })
      const now = (await ctx.db.query.encounters.findFirst({ where: (t, { eq: is }) => is(t.id, e.id) }))!
      expect(now.examination ?? '').toBe('')
      expect((await adminQuery('SELECT count(*)::int AS n FROM note_insertions')).rows[0].n).toBe(0)
    })

    it('never the summary of an image that is not approved, even accepted (one stored before that rule): the note is unchanged', async () => {
      const { p, e } = await consultation()
      const draft = await storeCapture({ patientId: p.id, encounterId: e.id, status: 'draft' })
      const rejected = await storeCapture({ patientId: p.id, encounterId: e.id, seed: 8, status: 'rejected' })
      for (const c of [draft, rejected]) {
        const s = await storedEarlier(c.capture, 'accepted')
        const res = await insert(e, { text: s.text, subjectId: s.id })
        expect(res.statusCode).toBe(409)
        expect(res.json()).toMatchObject({ error: 'thermal_not_approved', message: 'This summary’s thermal image is not approved. Only the summary of an approved image can be added to the note.' })
      }
      const now = (await ctx.db.query.encounters.findFirst({ where: (t, { eq: is }) => is(t.id, e.id) }))!
      expect([now.examination ?? '', now.version]).toEqual(['', e.version])
      expect((await adminQuery('SELECT count(*)::int AS n FROM note_insertions')).rows[0].n).toBe(0)
      expect(await audits('encounter.ai_insert')).toEqual([])
    })

    it('not into another consultation, and not into a signed one', async () => {
      const { p, e } = await consultation()
      const { capture } = await storeCapture({ patientId: p.id, encounterId: e.id })
      const s = await generated(capture.id)
      await review(s.id, { decision: 'accepted' })
      const saved = Encounter.parse(
        (
          await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, {
            cookie: doctor,
            body: { version: e.version, note: { chiefComplaint: 'Knee review', history: '', pastHistory: '', examination: '', assessment: 'Reviewed.', plan: '', followUp: '' }, diagnoses: [{ description: 'Knee pain, under review', code: null, kind: 'provisional' }], prescription: [] },
          })
        ).json(),
      )
      expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
      const signed = await insert(saved, { text: s.text, subjectId: s.id })
      expect(signed.statusCode).toBe(409)
      expect(signed.json().error).toBe('encounter_signed')
      // HERO final (deliberate change): signing no longer closes the visit; the doctor completes it before the patient's next visit.
      expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)

      // The same patient's next consultation: the summary belongs to the earlier one.
      const next = await consultation({ patientId: p.id })
      const elsewhere = await insert(next.e, { text: s.text, subjectId: s.id })
      expect(elsewhere.statusCode).toBe(404)
      const stillEmpty = (await ctx.db.query.encounters.findFirst({ where: (t, { eq: is }) => is(t.id, next.e.id) }))!
      expect(stillEmpty.examination ?? '').toBe('')
    })
  })

  describe('Mana and the consultation draft', () => {
    it('read the measured values and the doctor-reviewed summary of approved captures; never a simulated capture; nothing after consent is withdrawn', async () => {
      const { p, e } = await consultation()
      const takenAt = new Date(Date.now() - 3_600_000)
      const live = await storeCapture({ patientId: p.id, encounterId: e.id, capturedAt: takenAt })
      const sim = await storeCapture({ patientId: p.id, encounterId: e.id, source: 'simulator', seed: 11 })
      const pendingOnly = await storeCapture({ patientId: p.id, encounterId: e.id, source: 'file_upload', seed: 12 })
      const s = await generated(live.capture.id)
      await review(s.id, { decision: 'accepted' })
      const simSummary = await generated(sim.capture.id)
      await review(simSummary.id, { decision: 'accepted' })
      await generated(pendingOnly.capture.id) // never reviewed

      // v4 since G14 changed the medicines answer; the thermal items read are those of v3.
      expect(MANA_RULES_VERSION).toBe('mana-record-v4')
      const me = sessionOf('doctor')
      const record = await loadPatientRecord(ctx.db, me, p.id, { encounterId: e.id, maxEncounters: 10, observationDays: 365 })
      const thermal = record.items.filter((i) => i.sourceType === 'thermal_capture')
      // Nothing of the simulated capture, by id or by its summary.
      expect(thermal.some((i) => i.sourceId === sim.capture.id)).toBe(false)
      expect(thermal.some((i) => i.excerpt.includes('SIMULATED'))).toBe(false)

      const measured = thermal.find((i) => i.sourceId === live.capture.id && i.field === 'Thermal measurement')!
      const { stats, left, pair } = live
      expect(measured).toMatchObject({ encounterId: e.id, date: takenAt.toISOString(), status: 'recorded', provenance: 'record' })
      expect(measured.excerpt).toContain(`Approved thermal measurement (Live capture), Knees: whole image min ${stats.minC} °C, max ${stats.maxC} °C, mean ${stats.meanC} °C, SD ${stats.stdC} °C`)
      expect(measured.excerpt).toContain(`region Left knee: min ${left.min} °C, max ${left.max} °C, mean ${left.mean} °C, SD ${left.std} °C, ${left.pixelCount} pixels`)
      expect(measured.excerpt).toContain(`Left knee minus Right knee mean ${pair.meanDiff} °C`)
      expect(measured.excerpt).toMatch(/\(measurement only, not validated\)$/)

      const reviewed = thermal.find((i) => i.sourceId === live.capture.id && i.field === 'Thermal summary (doctor-reviewed)')!
      expect(reviewed.provenance).toBe('clinician_stated')
      expect(reviewed.encounterId).toBe(e.id)
      expect(reviewed.excerpt.startsWith('Doctor-reviewed thermal summary (accepted by the doctor; composed by rules thermal-summary-v1, not validated): ')).toBe(true)
      expect(reviewed.excerpt).toContain(s.statements[0]!.text)
      // The capture whose summary was never reviewed: its measurement, and no summary.
      expect(thermal.filter((i) => i.sourceId === pendingOnly.capture.id).map((i) => i.field)).toEqual(['Thermal measurement'])
      expect(thermal.find((i) => i.sourceId === pendingOnly.capture.id)!.excerpt).toContain('(Uploaded file)')

      // The consultation draft (V3) reads the same items as sources.
      const enc = (await ctx.db.query.encounters.findFirst({ where: (t, { eq: is }) => is(t.id, e.id) }))!
      const inputs = await buildConsultationInputs(ctx.db, me, enc, { maxContextChars: 14_000, maxEncounters: 10, observationDays: 365, settings: { safety: settings.safety, outdatedDays: settings.mana.outdatedDays } })
      const keys = inputs.items.filter((i) => i.sourceType === 'thermal_capture').map((i) => i.key)
      expect(keys).toContain(`thermal_capture:${live.capture.id}:Thermal measurement`)
      expect(keys).toContain(`thermal_capture:${live.capture.id}:Thermal summary (doctor-reviewed)`)
      expect(keys.some((k) => k.includes(sim.capture.id))).toBe(false)

      // Consent withdrawn: no thermal item at all.
      const consentId = (await adminQuery("SELECT id FROM consents WHERE patient_id = $1 AND type = 'thermal_imaging'", [p.id])).rows[0].id
      expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/consents/${consentId}/withdraw`, { cookie: nurse, body: {} })).statusCode).toBe(200)
      const after = await loadPatientRecord(ctx.db, me, p.id, { encounterId: e.id, maxEncounters: 10, observationDays: 365 })
      expect(after.items.filter((i) => i.sourceType === 'thermal_capture')).toEqual([])
    })

    it('an edited summary is read as the doctor edited it', async () => {
      const { p, e } = await consultation()
      const live = await storeCapture({ patientId: p.id, encounterId: e.id })
      const s = await generated(live.capture.id)
      await review(s.id, { decision: 'edited', text: 'Left knee warmer than the right on this image.\nMeasurement only.' })
      const record = await loadPatientRecord(ctx.db, sessionOf('doctor'), p.id, { maxEncounters: 10, observationDays: 365 })
      const reviewed = record.items.find((i) => i.field === 'Thermal summary (doctor-reviewed)')!
      expect(reviewed.excerpt).toBe('Doctor-reviewed thermal summary (edited by the doctor; composed by rules thermal-summary-v1, not validated): Left knee warmer than the right on this image. Measurement only.')
    })

    it('the older assistant’s record context says how each approved image arrived, an imported one IMPORTED, and dates it when the camera took it if known; never a simulated or unapproved one', async () => {
      const { p, e } = await consultation()
      const takenAt = new Date(Date.now() - 3 * 86_400_000)
      const day = (d: Date) => d.toISOString().slice(0, 10)
      const live = await storeCapture({ patientId: p.id, encounterId: e.id, capturedAt: takenAt })
      const imported = await storeCapture({ patientId: p.id, encounterId: e.id, source: 'gallery_import', seed: 9 })
      const uploaded = await storeCapture({ patientId: p.id, encounterId: null, source: 'file_upload', seed: 10 })
      const sim = await storeCapture({ patientId: p.id, encounterId: e.id, source: 'simulator', seed: 11 })
      const draft = await storeCapture({ patientId: p.id, encounterId: e.id, seed: 12, status: 'draft' })
      const enc = (await ctx.db.query.encounters.findFirst({ where: (t, { eq: is }) => is(t.id, e.id) }))!
      const context = await buildPatientContext(ctx.db, enc, { priorEncounters: 5, observationDays: 30 })
      const thermal = new Map(context.items.filter((i) => i.sourceType === 'thermal_capture').map((i) => [i.sourceId, i.text]))
      expect([...thermal.keys()].sort()).toEqual([live.capture.id, imported.capture.id, uploaded.capture.id].sort())
      expect(thermal.has(sim.capture.id) || thermal.has(draft.capture.id)).toBe(false)
      const pairs = (c: { pair: ThermalPair }) => `Left knee minus Right knee mean ${c.pair.meanDiff} °C (measurements only, not validated)`
      expect(thermal.get(live.capture.id)).toBe(`Approved thermal measurement (Live capture), taken ${day(takenAt)}, Knees: ${pairs(live)}`)
      expect(thermal.get(imported.capture.id)).toBe(`Approved thermal measurement (IMPORTED: an earlier image chosen from the device, date taken not known), imported ${day(imported.capture.createdAt)}, Knees: ${pairs(imported)}`)
      expect(thermal.get(uploaded.capture.id)).toBe(`Approved thermal measurement (Uploaded file), stored ${day(uploaded.capture.createdAt)}, Knees: ${pairs(uploaded)}`)
    })
  })

  describe('workspace events', () => {
    it('are audited once per user, consultation and event in a minute, never with an image; repeats are answered the same', async () => {
      const { p, e } = await consultation()
      const event = (body: object, cookie = nurse, id = e.id) => call(ctx.app, 'POST', `/api/encounters/${id}/thermal-events`, { cookie, body })
      for (let i = 0; i < 3; i++) expect((await event({ event: 'workspace_opened', adapter: 'native_bridge', state: 'ready', deviceModel: 'FLIR ONE Pro' })).statusCode).toBe(204)
      expect(await audits('thermal.workspace_opened')).toEqual([
        { actor_user_id: fx.users.nurse, outcome: 'success', entity_id: e.id, patient_id: p.id, details: { adapter: 'native_bridge', state: 'ready', reason: null, deviceModel: 'FLIR ONE Pro', repeatsNotLoggedForSeconds: 60 } },
      ])
      // Another person, or another event, is its own entry.
      expect((await event({ event: 'workspace_opened', adapter: 'simulator' }, doctor)).statusCode).toBe(204)
      expect((await event({ event: 'capture_failed', adapter: 'native_bridge', state: 'error', reason: 'camera_busy' })).statusCode).toBe(204)
      expect((await audits('thermal.workspace_opened')).map((x) => x.actor_user_id)).toEqual([fx.users.nurse, fx.users.doctor])
      expect((await audits('thermal.capture_failed'))[0]!.details).toMatchObject({ adapter: 'native_bridge', state: 'error', reason: 'camera_busy' })
      // Only the listed events and adapters.
      expect((await event({ event: 'frame', adapter: 'native_bridge' })).statusCode).toBe(400)
      expect((await event({ event: 'camera_connected', adapter: 'usb' })).statusCode).toBe(400)
      const admin = await login(ctx.app, 't.admin')
      expect((await event({ event: 'camera_connected', adapter: 'native_bridge' }, admin)).statusCode).toBe(403)
      expect(await audits('thermal.camera_connected')).toEqual([])
    })
  })

  describe('facility isolation', () => {
    it('another facility’s staff reach no capture, summary or consultation of this one', async () => {
      const [other] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
      const [dept] = await ctx.db.insert(departments).values({ facilityId: other!.id, code: 'GEN', name: 'General Medicine' }).returning()
      const passwordHash = await hashPassword(TEST_PASSWORD)
      await ctx.db.insert(users).values([
        { facilityId: other!.id, username: 'o.doctor', fullName: 'Other doctor', role: 'doctor', passwordHash, departmentId: dept!.id },
        { facilityId: other!.id, username: 'o.nurse', fullName: 'Other nurse', role: 'nurse', passwordHash, departmentId: dept!.id },
      ])
      const oDoctor = await login(ctx.app, 'o.doctor')
      const oNurse = await login(ctx.app, 'o.nurse')
      const { e, p } = await consultation()
      const { capture } = await storeCapture({ patientId: p.id, encounterId: e.id })
      const s = await generated(capture.id)

      expect((await generate(capture.id, oDoctor)).statusCode).toBe(404)
      expect((await call(ctx.app, 'GET', `/api/thermal/${capture.id}/summaries`, { cookie: oNurse })).statusCode).toBe(404)
      expect((await review(s.id, { decision: 'accepted' }, oDoctor)).statusCode).toBe(404)
      expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/thermal-events`, { cookie: oNurse, body: { event: 'workspace_opened', adapter: 'native_bridge' } })).statusCode).toBe(404)
      expect(await audits('thermal.workspace_opened')).toEqual([])
      // Each refusal is on record, and nothing changed.
      const denied = (await adminQuery("SELECT details FROM audit_events WHERE action = 'access.not_found' ORDER BY id")).rows.map((r) => r.details.reason)
      expect(denied).toEqual(['other_facility', 'other_facility', 'other_facility', 'other_facility'])
      expect((await adminQuery('SELECT status FROM thermal_summaries WHERE id = $1', [s.id])).rows[0].status).toBe('pending')
      expect((await adminQuery('SELECT count(*)::int AS n FROM thermal_summaries')).rows[0].n).toBe(1)
    })
  })
})

