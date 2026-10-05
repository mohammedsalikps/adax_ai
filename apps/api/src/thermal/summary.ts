import { BODY_SITES, type BodySite, NOTE_SECTION_MAX, type RoiStats, THERMAL_VIEWS, type ThermalCaptureSource, type ThermalFlags, type ThermalModelStatus, type ThermalPair, type ThermalSummaryStatement } from '@adaxai/contracts'

/**
 * The clinician-facing summary of one thermal study (V6), composed by fixed rules (no language model) from what was measured and stored, what the
 * experimental rules of the thermal service (rules-v1) found, and whether a thermal model is installed. Deterministic: the same inputs give the
 * same statements and the same text.
 *
 * It says what was measured (the stored statistics, as stored), what an experimental rule flagged (worded as experimental and not validated), that
 * no model finding exists, and what a thermal image cannot show. It never states a diagnosis, a pain score or a recommendation, and nothing is
 * inferred from the body site. A simulated capture is labelled SIMULATED first, an imported one IMPORTED. Text written by staff (region labels and
 * comments, the body region) appears only quoted, on one line and shortened (`quoted`). Change the version when the wording or what is stated
 * changes: summaries stored earlier keep the version they were composed with.
 */
export const THERMAL_SUMMARY_COMPOSER_VERSION = 'thermal-summary-v1'

/** What the composer reads of a capture (a `ThermalCapture` has all of it). */
export interface SummaryCaptureInput {
  width: number
  height: number
  minC: number
  maxC: number
  meanC: number
  /** Null for captures stored before V6 kept it. */
  stdC: number | null
  protocol: { bodyRegion: string; bodySite?: BodySite | null | undefined; view: string }
  captureSource: ThermalCaptureSource
  simulated: boolean
  /** Pixels of the stored matrix that hold a reading; null or absent when the matrix could not be read. */
  pixelsWithReading?: number | null | undefined
}

/** What the composer reads of a region (a `ThermalRoi` has all of it). */
export interface SummaryRoiInput {
  label: string
  shape: string
  note?: string | null | undefined
  stats: RoiStats
}

export interface ComposedThermalSummary {
  statements: ThermalSummaryStatement[]
  text: string
  composerVersion: string
  /** The rules version whose output the summary states; null when the rules were not run. */
  rulesVersion: string | null
}

/** Hotspots stated one by one; any beyond are counted in one statement (the image shows them all). */
const HOTSPOTS_LISTED = 3
/**
 * Regions, and pairs of regions (their differences, and the pairs a rule flagged), stated one by one; any beyond are counted in one statement. With
 * these, the longest summary the inputs allow (20 regions with the longest labels and comments, a pair for each, every pair flagged, every hotspot)
 * stays within THERMAL_SUMMARY_TEXT_MAX.
 */
export const REGIONS_LISTED = 12
export const PAIRS_LISTED = 6
/** The longest a summary's text can be: the Examination section it is added to, which is also the most the note insertion takes. */
export const THERMAL_SUMMARY_TEXT_MAX = NOTE_SECTION_MAX.examination
/** The most of one piece of staff-written text a summary quotes; longer text is cut and ends with an ellipsis. */
export const QUOTED_MAX = 80

/** The fixed limitation every summary carries (what the image measures and what it cannot show). */
export const THERMAL_LIMITATION_SURFACE = 'Thermal imaging measures skin-surface temperature only; it does not measure pain and does not show swelling, inflammation, infection or fractures.'
export const THERMAL_LIMITATION_VALIDATION = 'Not clinically validated.'
export const THERMAL_LABEL_SIMULATED = 'SIMULATED: generated numbers, not a measurement of this patient.'
export const THERMAL_LABEL_IMPORTED = 'IMPORTED: an earlier image chosen from the device.'
export const THERMAL_NO_MODEL = 'No trained thermal model is installed: no model finding.'
export const THERMAL_RULES_NOT_RUN = 'The experimental rules were not run: the temperature matrix of this image is not available.'

/** A stored value as stored (two decimals at most, no trailing zeros). */
const num = (v: number) => String(Number(v.toFixed(2)))
const deg = (v: number) => `${num(v)} °C`
/** A rule parameter in °C as the rule documents it (1.0 °C, not 1 °C). */
const threshold = (v: number) => `${Number.isInteger(v) ? v.toFixed(1) : num(v)} °C`
const SHAPES: Record<string, string> = { rect: 'rectangle', ellipse: 'ellipse', polygon: 'polygon' }
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Text written by staff (a region's label or comment, the body region), as a summary states it: always between “ and ”, on one line (every run of
 * whitespace, line breaks included, is one space), with curly double quotes of its own made straight, and at most QUOTED_MAX characters (cut,
 * ending with an ellipsis). So it never reads as a statement of the composer or the rules, and never starts a line of its own.
 */
export function quoted(s: string): string {
  const chars = Array.from(s.replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim())
  return `“${chars.length > QUOTED_MAX ? `${chars.slice(0, QUOTED_MAX - 1).join('').trimEnd()}…` : chars.join('')}”`
}

function statsText(s: { min: number | null; max: number | null; mean: number | null; std: number | null }): string {
  const parts = [s.min !== null && `min ${deg(s.min)}`, s.max !== null && `max ${deg(s.max)}`, s.mean !== null && `mean ${deg(s.mean)}`, s.std !== null && `SD ${deg(s.std)}`].filter(Boolean)
  return parts.join(', ')
}

function wholeImage(c: SummaryCaptureInput): ThermalSummaryStatement {
  const site = c.protocol.bodySite ? BODY_SITES[c.protocol.bodySite] : null
  const where = site && site.toLowerCase() !== c.protocol.bodyRegion.trim().toLowerCase() ? `${quoted(c.protocol.bodyRegion)} (${site})` : quoted(c.protocol.bodyRegion)
  // A view from the fixed list is said in words; anything else (no version stores one) only quoted.
  const listed = (THERMAL_VIEWS as readonly string[]).includes(c.protocol.view)
  const view = !listed ? `view ${quoted(c.protocol.view)}` : c.protocol.view === 'other' ? 'other view' : `${c.protocol.view.replace(/_/g, ' ')} view`
  const pixels = c.pixelsWithReading !== null && c.pixelsWithReading !== undefined ? `${c.pixelsWithReading} of ${c.width * c.height} pixels with a reading` : `${c.width} × ${c.height} pixels`
  return { basis: 'measurement', source: 'whole image', text: `Thermal image of ${where}, ${view}, ${pixels}: whole image ${statsText({ min: c.minC, max: c.maxC, mean: c.meanC, std: c.stdC })}.` }
}

function roiStatement(r: SummaryRoiInput): ThermalSummaryStatement {
  const label = quoted(r.label)
  // A comment is what someone wrote on the region, not a measurement: said so, and quoted.
  const note = r.note?.trim() ? ` Comment on this region (written by staff; not a measurement): ${quoted(r.note)}.` : ''
  const source = `region ${label}`
  if (!r.stats.pixelCount || r.stats.mean === null) return { basis: 'measurement', source, text: `Region ${label} (${SHAPES[r.shape] ?? r.shape}): no pixel with a reading.${note}` }
  return { basis: 'measurement', source, text: `Region ${label} (${SHAPES[r.shape] ?? r.shape}, ${r.stats.pixelCount} pixels with a reading): ${statsText(r.stats)}.${note}` }
}

function pairStatement(p: ThermalPair): ThermalSummaryStatement {
  const [a, b] = [quoted(p.a), quoted(p.b)]
  const source = `regions ${a} and ${b}`
  if (p.meanDiff === null) return { basis: 'measurement', source, text: `${a} minus ${b}: no difference can be given (a region has no pixel with a reading).` }
  return { basis: 'measurement', source, text: `${a} minus ${b}: mean difference ${deg(p.meanDiff)}${p.maxDiff !== null ? `; difference of the highest values ${deg(p.maxDiff)}` : ''}.` }
}

/** Statements from the experimental rules' own output (flags), and nothing else: the composer applies no threshold of its own. */
function ruleStatements(f: ThermalFlags): ThermalSummaryStatement[] {
  const out: ThermalSummaryStatement[] = []
  const v = f.version
  const t = f.params.asymmetry_threshold_c
  const k = f.params.hotspot_k
  const minPx = f.params.hotspot_min_pixels
  const asymmetrySource = `${v}: |mean difference| ≥ ${threshold(t)}`
  const hotspotSource = `${v}: at least ${num(k)} SD above the image mean, ${minPx} pixels or more`
  const flagged = f.asymmetry.filter((a) => a.flagged)
  for (const a of flagged.slice(0, PAIRS_LISTED)) {
    out.push({ basis: 'rule', source: asymmetrySource, text: `Thermal asymmetry of ${deg(Math.abs(a.meanDiffC))} between ${quoted(a.a)} and ${quoted(a.b)} (experimental rule ${v}: flagged at ${threshold(t)} or more; not validated).` })
  }
  if (flagged.length > PAIRS_LISTED) out.push({ basis: 'rule', source: asymmetrySource, text: `${plural(flagged.length - PAIRS_LISTED, 'more pair of regions was', 'more pairs of regions were')} flagged by the same experimental rule (${v}; not validated); the image shows every flagged pair.` })
  if (f.asymmetry.length && !flagged.length) {
    out.push({ basis: 'rule', source: asymmetrySource, text: `No thermal asymmetry of ${threshold(t)} or more between the paired regions (experimental rule ${v}; not validated).` })
  }
  for (const h of f.hotspots.slice(0, HOTSPOTS_LISTED)) {
    out.push({
      basis: 'rule',
      source: hotspotSource,
      text: `Area warmer than the image average (experimental rule ${v}: at least ${num(k)} SD above the image mean of ${deg(f.image.meanC)}, ${minPx} pixels or more; not validated): ${h.pixelCount} pixels in the box at x ${num(h.x)}, y ${num(h.y)} (${num(h.width)} × ${num(h.height)} pixels), mean ${deg(h.meanC)}, highest ${deg(h.maxC)}.`,
    })
  }
  if (f.hotspots.length > HOTSPOTS_LISTED) out.push({ basis: 'rule', source: hotspotSource, text: `${f.hotspots.length - HOTSPOTS_LISTED} more areas met the same experimental rule (${v}; not validated); the image shows them.` })
  if (!f.hotspots.length) out.push({ basis: 'rule', source: hotspotSource, text: `No area at least ${num(k)} SD above the image mean over ${minPx} pixels or more (experimental rule ${v}; not validated).` })
  return out
}

function modelStatement(m: ThermalModelStatus): ThermalSummaryStatement {
  if (!m.available) return { basis: 'model', source: 'thermal model status', text: THERMAL_NO_MODEL }
  // No model output is ever part of a summary: a model that is described as installed is named, and nothing it would say is stated.
  const name = [m.modelId ?? 'unnamed model', m.version, m.kind && `(${m.kind})`].filter(Boolean).join(' ')
  return { basis: 'model', source: 'thermal model status', text: `Thermal model ${name} is installed; this summary contains no output from it.` }
}

/**
 * Composes the summary of one capture: where the numbers came from (SIMULATED or IMPORTED, first, when so), the whole-image measurement, each
 * region, each pair (A minus B), the experimental rules' findings (or that they were not run), the model statement, then the limitations.
 * Regions and pairs beyond REGIONS_LISTED and PAIRS_LISTED are counted, not listed, so that a summary can always be edited and added to the note.
 * `flags` is the thermal service's rules output for this capture (region labels as the doctor wrote them), or null when the rules were not run.
 */
export function composeThermalSummary(capture: SummaryCaptureInput, rois: SummaryRoiInput[], pairs: ThermalPair[], flags: ThermalFlags | null, modelStatus: ThermalModelStatus): ComposedThermalSummary {
  const statements: ThermalSummaryStatement[] = []
  // Where the numbers came from comes before any of them: simulated numbers are never read as a measurement of the patient.
  if (capture.simulated || capture.captureSource === 'simulator') statements.push({ basis: 'limitation', source: 'capture source', text: THERMAL_LABEL_SIMULATED })
  else if (capture.captureSource === 'gallery_import') statements.push({ basis: 'limitation', source: 'capture source', text: THERMAL_LABEL_IMPORTED })
  statements.push(wholeImage(capture))
  for (const r of rois.slice(0, REGIONS_LISTED)) statements.push(roiStatement(r))
  if (rois.length > REGIONS_LISTED) statements.push({ basis: 'limitation', source: 'regions', text: `${plural(rois.length - REGIONS_LISTED, 'more region is', 'more regions are')} not listed in this summary; the image shows every region.` })
  for (const p of pairs.slice(0, PAIRS_LISTED)) statements.push(pairStatement(p))
  if (pairs.length > PAIRS_LISTED) statements.push({ basis: 'limitation', source: 'pairs of regions', text: `${plural(pairs.length - PAIRS_LISTED, 'more pair of regions is', 'more pairs of regions are')} not listed in this summary; the image shows every pair.` })
  if (flags) statements.push(...ruleStatements(flags))
  statements.push(modelStatement(modelStatus))
  if (!flags) statements.push({ basis: 'limitation', source: 'experimental rules', text: THERMAL_RULES_NOT_RUN })
  statements.push({ basis: 'limitation', source: 'thermal imaging', text: THERMAL_LIMITATION_SURFACE })
  statements.push({ basis: 'limitation', source: 'validation', text: THERMAL_LIMITATION_VALIDATION })
  return { statements, text: statements.map((s) => s.text).join('\n'), composerVersion: THERMAL_SUMMARY_COMPOSER_VERSION, rulesVersion: flags?.version ?? null }
}

/** Pixels of a float32 little-endian matrix that hold a reading (finite values). */
export function pixelsWithReading(matrix: Buffer): number {
  let n = 0
  for (let i = 0; i + 4 <= matrix.length; i += 4) if (Number.isFinite(matrix.readFloatLE(i))) n++
  return n
}
