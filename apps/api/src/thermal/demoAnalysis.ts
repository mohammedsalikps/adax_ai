/**
 * The thermal analysis dashboard's indices (premium design), as a DEMONSTRATION of what a future thermal intelligence module will show. There is no
 * validated thermal model: these are fixed, deterministic formulas over the temperatures recorded in the image, each 0–100, each with the number it
 * comes from. They detect, predict and diagnose nothing, and are labelled "Demo analysis — not clinically validated" wherever they are shown.
 *
 * The provider boundary (`ThermalAnalysisProvider`) is where a real, validated model would replace this one: the dashboard reads only its output.
 */

export interface ThermalIndex {
  key: 'pain_pattern' | 'thermal_asymmetry' | 'perfusion_pattern' | 'temperature_pattern' | 'thermal_stress'
  label: string
  /** 0–100, from the formula below. */
  score: number
  /** What the score was computed from, in words with the measured number ("Left–right mean difference 0.8 °C"). */
  basis: string
}

export interface ThermalAnalysis {
  engine: { name: string; version: string; validated: false; label: string }
  indices: ThermalIndex[]
  /** 5–6 sentences composed by rules from the numbers, always with the limits. */
  summary: string[]
  /** The temperature scale of the image (°C), for the dashboard's colour bar. */
  scale: { minC: number; maxC: number }
  simulated: boolean
  /** An ordinary image without temperature data (contracts THERMAL_DEMO_IMAGE_EXTRACTOR): its values were simulated from its colours. */
  demoImage: boolean
}

export interface ThermalAnalysisInput {
  width: number
  height: number
  /** °C, row-major, float32 (NaN or out-of-range values are left out). */
  matrix: Float32Array
  simulated: boolean
  /** An ordinary image analysed as a demo: its values are simulated from its colours, so they are never called measured temperatures. */
  demoImage?: boolean
}

export interface ThermalAnalysisProvider {
  analyse(input: ThermalAnalysisInput): ThermalAnalysis
}

export const DEMO_ANALYSIS_LABEL = 'Demo analysis — not clinically validated'

const clamp = (v: number) => (Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v))) : 0)

/** The value at fraction `q` (0..1) of the sorted temperatures. */
function quantile(sorted: Float32Array, q: number): number {
  if (!sorted.length) return Number.NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[i]!
}

function meanOf(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN
}

/** Readings that are temperatures a skin camera would record (−20..80 °C); anything else is no reading. */
const usable = (v: number) => Number.isFinite(v) && v > -20 && v < 80

/** Skin is warmer than its surroundings: readings at or above this are taken as the skin region (when there are enough of them). */
const SKIN_C = 30

/** The demonstration provider: fixed formulas over the skin region, no learning, no randomness (the same image gives the same numbers). */
export const demoThermalAnalysis: ThermalAnalysisProvider = {
  analyse({ width, height, matrix, simulated, demoImage = false }) {
    // A demo image's values were simulated from its colours: they are said to be simulated, never measured.
    const fmt = (v: number) => `${v.toFixed(1)} ${demoImage ? 'simulated units' : '°C'}`
    const reading = demoImage ? 'simulated value' : 'temperature'
    const all: number[] = []
    for (let i = 0; i < width * height; i++) {
      const v = matrix[i]!
      if (usable(v)) all.push(v)
    }
    // The skin region: readings at or above 30 °C when they are at least a tenth of the image; otherwise the whole image.
    const warm = all.filter((v) => v >= SKIN_C)
    const useSkin = warm.length >= all.length * 0.1
    const inRegion = (v: number) => usable(v) && (!useSkin || v >= SKIN_C)
    const region: number[] = useSkin ? warm : all
    const left: number[] = []
    const right: number[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = matrix[y * width + x]!
        if (!inRegion(v)) continue
        if (x < width / 2) left.push(v)
        else right.push(v)
      }
    }
    const sortedAll = Float32Array.from(all).sort()
    const sorted = Float32Array.from(region).sort()
    const p5 = quantile(sorted, 0.05)
    const p10 = quantile(sorted, 0.1)
    const p50 = quantile(sorted, 0.5)
    const p95 = quantile(sorted, 0.95)
    const p99 = quantile(sorted, 0.99)
    const mean = meanOf(region)
    const lr = left.length && right.length ? Math.abs(meanOf(left) - meanOf(right)) : 0
    const hotspot = p99 - p50
    const cool = p50 - p10
    const spread = p95 - p5
    const where = useSkin ? 'skin region' : 'image'

    const indices: ThermalIndex[] = [
      { key: 'pain_pattern', label: 'Pain pattern', score: clamp((hotspot / 3) * 100), basis: `Hottest 1% above the median of the ${where}: ${fmt(hotspot)} (localized warmth only; it detects no pain)` },
      { key: 'thermal_asymmetry', label: 'Thermal asymmetry', score: clamp((lr / 1.5) * 100), basis: `Left–right difference of the mean: ${fmt(lr)}` },
      { key: 'perfusion_pattern', label: 'Perfusion pattern', score: clamp(100 - (cool / 3) * 100), basis: `Coolest tenth below the median: ${fmt(cool)} (a smaller drop scores higher)` },
      { key: 'temperature_pattern', label: 'Temperature pattern', score: clamp(((mean - 30) / 6) * 100), basis: `Mean ${reading} of the ${where}: ${fmt(mean)}` },
      { key: 'thermal_stress', label: 'Thermal stress', score: clamp((spread / 5) * 100), basis: `Spread of the middle 90% of the ${where}: ${fmt(spread)}` },
    ]

    const level = (n: number) => (n < 34 ? 'low' : n < 67 ? 'moderate' : 'high')
    const asym = indices[1]!.score
    const summary = demoImage
      ? [
          'Demo thermal analysis of an ordinary image: the file has no temperature data, so its values were simulated from the image’s colours.',
          `The simulated values show ${level(asym) === 'low' ? 'little' : level(asym) === 'moderate' ? 'a mild' : 'a marked'} left–right difference between the halves of the image (${fmt(lr)}).`,
          `The warmest-coloured area stands ${fmt(hotspot)} above the median of the ${where}, and the coolest tenth ${fmt(cool)} below it.`,
          'The scores come from fixed demonstration formulas over these simulated values; they are not measurements and are not clinically validated.',
          'No clinical interpretation or diagnosis should be made from this demonstration.',
          'A radiometric thermal image from a thermal camera is needed for real temperature measurements.',
        ]
      : [
      `${simulated ? 'This SIMULATED thermal image' : 'Thermal imaging'} shows ${level(asym) === 'low' ? 'little' : level(asym) === 'moderate' ? 'a mild' : 'a marked'} left–right temperature asymmetry in the captured region (${fmt(lr)} between the halves).`,
      `Across the ${where}, temperatures range from ${fmt(p5)} to ${fmt(p95)} for most of it, with a mean of ${fmt(mean)}.`,
      `The warmest area lies ${fmt(hotspot)} above the median, and the coolest tenth ${fmt(cool)} below it.`,
      'These are skin-surface temperature patterns only, computed by fixed demonstration formulas; they do not by themselves establish any clinical finding or diagnosis.',
      simulated ? 'The image was generated by the simulator, so no interpretation should be made from it.' : 'No acute interpretation should be made from this demonstration analysis alone.',
      'Review the image and its measurements alongside the patient’s clinical findings.',
    ]
    return {
      engine: { name: 'adaxai-thermal-demo-indices', version: '1', validated: false, label: DEMO_ANALYSIS_LABEL },
      indices,
      summary,
      scale: { minC: sortedAll.length ? Math.floor(quantile(sortedAll, 0.01) * 10) / 10 : 0, maxC: sortedAll.length ? Math.ceil(quantile(sortedAll, 0.999) * 10) / 10 : 0 },
      simulated,
      demoImage,
    }
  },
}
