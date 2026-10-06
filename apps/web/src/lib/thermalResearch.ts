import { BODY_SITES, CONSENT_STATES, type ConsentSummary, DATA_ORIGIN_LABELS, type ThermalCapture, type ThermalModelStatus, type ThermalPair, type ThermalRoi } from '@adaxai/contracts'

/*
 * The pediatric shock research view of a consultation's thermal images (pure, no JSX, no request). It says what the research pipeline has in
 * this build and for this consultation, stage by stage, and lists the values already stored for the consultation's approved, non-simulated
 * images. It computes no result: nothing here detects, predicts or rates shock, and there is no research model (the thermal service says none
 * is installed). Every number comes from a stored field of a capture; the only arithmetic is the largest of stored values, for the four
 * numbers the dataset evaluation (thermal-eval-v1) reads, and those are labelled as descriptive.
 */

export const RESEARCH_TITLE = 'Pediatric shock research'
export const RESEARCH_HEADER = 'PEDIATRIC SHOCK — RESEARCH MODE'
export const RESEARCH_DISCLAIMER = 'Research only. Not for clinical decisions. Nothing here detects, predicts or scores shock.'
export const PAEDIATRIC_RANGES = 'Paediatric vital ranges are not implemented'
export const MODEL_UNAVAILABLE = 'Research model unavailable.'
export const MODEL_NOT_AVAILABLE = 'Not currently available. Research pipeline ready for model integration.'

// ---------------------------------------------------------------------------
// Which images
// ---------------------------------------------------------------------------

/** A simulator's capture, however it is marked (the database keeps the two together; either one is enough here). */
export const isSimulatedCapture = (c: Pick<ThermalCapture, 'simulated' | 'captureSource'>) => c.simulated || c.captureSource === 'simulator'

/** When the image was taken: the camera's time when it said one, otherwise when it was stored. */
export const takenAt = (c: Pick<ThermalCapture, 'capturedAt' | 'createdAt'>) => c.capturedAt ?? c.createdAt

/** The images of this consultation (images of the patient's other visits are not part of it), newest first. */
export function consultationCaptures(all: readonly ThermalCapture[], encounterId: string): ThermalCapture[] {
  return all.filter((c) => c.encounterId === encounterId).sort((a, b) => Date.parse(takenAt(b)) - Date.parse(takenAt(a)))
}

/** The image's place on the body, as the consultation panel names it: the fixed body site and the free description, once each. */
export function captureTitle(c: Pick<ThermalCapture, 'protocol'>): string {
  const site = c.protocol.bodySite ? BODY_SITES[c.protocol.bodySite] : null
  return [site, c.protocol.bodyRegion].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ')
}

export type ExclusionReason = 'simulated' | 'draft' | 'rejected'
/** Why an image of this consultation is not in the feature set. A simulator's image is excluded whatever its review says. */
export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  simulated: 'SIMULATED, excluded',
  draft: 'awaiting approval, not in the feature set',
  rejected: 'rejected, not in the feature set',
}
export function exclusionOf(c: Pick<ThermalCapture, 'simulated' | 'captureSource' | 'status'>): ExclusionReason | null {
  if (isSimulatedCapture(c)) return 'simulated'
  if (c.status === 'draft') return 'draft'
  if (c.status === 'rejected') return 'rejected'
  return null
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * `built`: code for it runs in this build and has run on this consultation's images. `depends`: the code exists but waits for an image, an
 * approval, a device or a deployment. `not_built`: there is no code for it. A stage whose name promises a part that is not built (temperature
 * normalisation) is `not_built`, and says which of its checks do run: a status never claims more than the code does.
 */
export type StageStatus = 'built' | 'depends' | 'not_built'
/** A stage's status in words: a stage that `depends` is waiting for this consultation's data. */
export const STAGE_STATUS_LABEL: Record<StageStatus, string> = { built: 'Built', depends: 'Waits for data', not_built: 'Not built' }
/** The same for one part of a stage, which may depend on a device or a deployment as well as on data. */
export const PART_STATUS_LABEL: Record<StageStatus, string> = { built: 'Built', depends: 'Depends', not_built: 'Not built' }

export type StageId = 'acquisition' | 'preprocessing' | 'quality' | 'extraction' | 'feature-set' | 'model' | 'output' | 'review'
/** One thing a stage has, or waits for, or lacks. */
export interface StagePart {
  status: StageStatus
  text: string
}
export interface ResearchStage {
  id: StageId
  n: number
  label: string
  status: StageStatus
  /** What is true for this consultation, one sentence a line. */
  detail: string[]
  parts: StagePart[]
}

/** The stages, in the order of the brief's pipeline. */
export const STAGE_LABEL: Record<StageId, string> = {
  acquisition: 'Thermal acquisition',
  preprocessing: 'Preprocessing',
  quality: 'Temperature normalisation & quality checks',
  extraction: 'Feature extraction',
  'feature-set': 'Feature set',
  model: 'Research ML model',
  output: 'Research output',
  review: 'Doctor/researcher review',
}

export interface PipelineFacts {
  /** This consultation's images (consultationCaptures), or null while they cannot be read. */
  captures: readonly ThermalCapture[] | null
  /** Whether the tablet app's camera bridge is on this page (findNativeBridge). */
  bridge: boolean
  /** What the server says about the thermal model, or null while it is not known. */
  model: ThermalModelStatus | null
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const hasConditions = (c: Pick<ThermalCapture, 'protocol'>) => c.protocol.roomTempC != null || c.protocol.acclimatisationMin != null || c.protocol.distanceM != null
const NOT_READ = 'The thermal images of this consultation could not be read just now.'
const ON_STORE = 'Runs when a radiometric image of this consultation is stored.'

/** The pipeline's eight stages, each with its status computed from this consultation's images and what the code has. */
export function researchPipeline({ captures, bridge, model }: PipelineFacts): ResearchStage[] {
  const all = captures ?? []
  const real = all.filter((c) => !isSimulatedCapture(c))
  const simulated = all.length - real.length
  const approved = real.filter((c) => c.status === 'approved')
  const awaiting = real.filter((c) => c.status === 'draft').length
  const rejected = real.filter((c) => c.status === 'rejected').length
  const has = real.length > 0
  const regions = real.reduce((n, c) => n + c.rois.length, 0)
  const pairs = real.reduce((n, c) => n + c.pairs.length, 0)
  const extractors = [...new Set(real.map((c) => `${c.extractor.name} ${c.extractor.version}`))]
  const stage = (id: StageId, n: number, status: StageStatus, detail: string[], parts: StagePart[] = []): ResearchStage => ({ id, n, label: STAGE_LABEL[id], status, detail, parts })
  const unread = captures === null

  return [
    stage(
      'acquisition',
      1,
      has ? 'built' : 'depends',
      [
        unread ? NOT_READ : has ? `${plural(real.length, 'radiometric image')} in this consultation.` : 'No radiometric image in this consultation yet.',
        ...(simulated ? [`${plural(simulated, 'simulated image')} in this consultation: ${EXCLUSION_TEXT.simulated}.`] : []),
      ],
      [
        { status: 'built', text: 'Upload or import of a radiometric FLIR image (every file is checked to be radiometric)' },
        bridge ? { status: 'depends', text: 'Live capture: the tablet app’s camera bridge is present; it needs a FLIR ONE connected' } : { status: 'not_built', text: 'Live capture in a browser: FLIR ONE not connected' },
        { status: 'depends', text: 'Simulator: development and demonstration deployments only; its images are SIMULATED and never in the feature set' },
        { status: 'not_built', text: 'Video, time series and rewarming sequences' },
      ],
    ),
    stage(
      'preprocessing',
      2,
      has ? 'built' : 'depends',
      [unread ? NOT_READ : has ? `Raw values converted to °C with each file’s own calibration (${extractors.join(', ')}).` : ON_STORE],
      [
        { status: 'built', text: 'Raw-to-°C conversion with the file’s calibration; pixels without a reading are left out' },
        { status: 'not_built', text: 'Body segmentation, background masking and image registration' },
      ],
    ),
    stage(
      'quality',
      3,
      'not_built',
      [
        'Temperature normalisation is not built.',
        unread ? NOT_READ : has ? `The checks that do run: the radiometric check, and the doctor’s approval (${approved.length} approved, ${awaiting} awaiting, ${rejected} rejected).` : 'The checks that do run (the radiometric check, the doctor’s approval) run when an image is stored.',
      ],
      [
        { status: 'built', text: 'Radiometric check: a file that is not radiometric is refused' },
        { status: has ? 'built' : 'depends', text: 'The doctor approves or rejects each image' },
        {
          status: 'depends',
          text: has
            ? `Capture conditions (room temperature, acclimatisation, distance): recorded for ${real.filter(hasConditions).length} of ${plural(real.length, 'image')}`
            : 'Capture conditions (room temperature, acclimatisation, distance): recorded by the upload form only, not by a capture in the workspace',
        },
        { status: 'not_built', text: 'Temperature normalisation' },
        { status: 'not_built', text: 'Image quality, focus or motion checks' },
      ],
    ),
    stage(
      'extraction',
      4,
      has ? 'built' : 'depends',
      [unread ? NOT_READ : has ? 'Whole-image minimum, maximum, mean and SD; region statistics; doctor-defined pairs as A minus B.' : ON_STORE],
      [
        { status: 'built', text: 'Whole-image minimum, maximum, mean and SD (SD not stored for images from before it was kept)' },
        regions ? { status: 'built', text: `Region statistics: ${plural(regions, 'region')} drawn by the doctor` } : { status: 'depends', text: 'Region statistics: the doctor draws the regions; none yet' },
        pairs ? { status: 'built', text: `Pairs as A minus B: ${plural(pairs, 'pair')}` } : { status: 'depends', text: 'Pairs as A minus B: the doctor pairs two regions; none yet' },
        { status: 'not_built', text: 'A central-to-peripheral temperature difference as a defined feature, capillary refill, perfusion index, and features over time' },
      ],
    ),
    stage(
      'feature-set',
      5,
      approved.length ? 'built' : 'depends',
      [
        unread
          ? NOT_READ
          : approved.length
            ? `${plural(approved.length, 'approved image')}, below, with the values stored for ${approved.length === 1 ? 'it' : 'them'}.`
            : awaiting
              ? `No approved image yet: ${plural(awaiting, 'image')} awaiting approval.`
              : 'No approved, non-simulated image in this consultation.',
      ],
      [
        { status: 'built', text: 'Per image, per region and per pair, from approved, non-simulated images only' },
        { status: 'not_built', text: 'Shock labels, outcomes or any reference standard' },
      ],
    ),
    stage(
      'model',
      6,
      'not_built',
      model?.available
        ? ['No research model is integrated with this pipeline.', 'The server reports an installed thermal model, described below. Nothing here runs it, and none of its outputs is shown.']
        : [MODEL_UNAVAILABLE, MODEL_NOT_AVAILABLE],
    ),
    stage('output', 7, 'not_built', ['None: there is no research model, so there is no research output.']),
    stage(
      'review',
      8,
      'not_built',
      ['No research output to review.'],
      [
        { status: 'built', text: 'The doctor approves or rejects each image, and can label an approved one (thermal-labels-v1)' },
        { status: 'not_built', text: 'Review of a research output' },
      ],
    ),
  ]
}

// ---------------------------------------------------------------------------
// The feature set
// ---------------------------------------------------------------------------

export interface Measure {
  label: string
  value: string
}
export interface RegionFeatures {
  id: string
  label: string
  shape: string
  pixels: string
  values: Measure[]
}
export interface PairFeatures {
  /** "A minus B": the doctor's pair, its difference taken in that order. */
  name: string
  meanDiff: string
  maxDiff: string
}
export interface ImageFeatures {
  id: string
  title: string
  at: string
  size: string
  /** Where the image data came from (Clinical, Synthetic / demonstration, Public sample file), as stored. */
  origin: string
  clinical: boolean
  /** Minimum, maximum, mean and SD of the whole image. */
  whole: Measure[]
  /** Emissivity and object distance from the file, when it gave them; null when it gave neither. */
  camera: string | null
  conditions: string
  extractor: string
  regions: RegionFeatures[]
  /** Empty when the doctor paired no regions ("No pair"). */
  pairs: PairFeatures[]
  /** The dataset evaluation's four numbers for this image (thermal-eval-v1). */
  evaluation: Measure[]
}

/** A stored temperature to 0.01 °C, or a dash when there is none. */
export const fmtTemp = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)} °C` : '—')
/** A stored difference with its sign, as the viewer shows paired differences. */
export const fmtDiff = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)} °C` : '—')
const trim = (v: number) => String(Number(v.toFixed(2)))

const SHAPES: Record<ThermalRoi['shape'], string> = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon' }

/** What the camera's file said about emissivity and distance, when it said either. */
export function cameraText(c: Pick<ThermalCapture, 'parameters'>): string | null {
  const { emissivity, objectDistanceM } = c.parameters
  const parts = [emissivity === null ? null : `Emissivity ${emissivity.toFixed(2)}`, objectDistanceM === null ? null : `object distance ${trim(objectDistanceM)} m`].filter((v): v is string => v !== null)
  return parts.length ? `${parts.join(' · ')} (from the file)` : null
}

/** Room temperature, acclimatisation and distance as recorded with the image; "not recorded" for each one that was not. */
export function conditionsText(c: Pick<ThermalCapture, 'protocol'>): string {
  if (!hasConditions(c)) return 'Capture conditions not recorded'
  const { roomTempC, acclimatisationMin, distanceM } = c.protocol
  return [
    `Room ${roomTempC == null ? 'not recorded' : `${roomTempC.toFixed(1)} °C`}`,
    `acclimatisation ${acclimatisationMin == null ? 'not recorded' : `${acclimatisationMin} min`}`,
    `distance ${distanceM == null ? 'not recorded' : `${trim(distanceM)} m`}`,
  ].join(' · ')
}

export function regionFeatures(r: ThermalRoi): RegionFeatures {
  const s = r.stats
  return {
    id: r.id,
    label: r.label,
    shape: SHAPES[r.shape],
    pixels: s.pixelCount ? `${s.pixelCount} px` : 'no pixel with a reading',
    values: [
      { label: 'Min', value: fmtTemp(s.min) },
      { label: 'Max', value: fmtTemp(s.max) },
      { label: 'Mean', value: fmtTemp(s.mean) },
      { label: 'SD', value: fmtTemp(s.std) },
    ],
  }
}

export const pairFeatures = (p: ThermalPair): PairFeatures => ({ name: `${p.a} minus ${p.b}`, meanDiff: fmtDiff(p.meanDiff), maxDiff: fmtDiff(p.maxDiff) })

/**
 * The four numbers the dataset evaluation reads for an image (services/thermal/app/evaluate.py FEATURES), from the stored values: the largest
 * absolute pair mean and maximum differences, the whole-image SD and the largest region SD. Where there is nothing to take them from, the
 * evaluation silently uses 0.0; here the value is null, so it is shown as missing ("no pair", "no region", "not stored"), never as a zero.
 */
export interface EvaluationInputs {
  maxAbsPairMeanDiffC: number | null
  maxAbsPairMaxDiffC: number | null
  imageStdC: number | null
  maxRoiStdC: number | null
}
const largestAbs = (vs: readonly (number | null)[]) => {
  const ok = vs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).map(Math.abs)
  return ok.length ? Math.max(...ok) : null
}
export function evaluationInputs(c: Pick<ThermalCapture, 'pairs' | 'rois' | 'stdC'>): EvaluationInputs {
  const roiStd = c.rois.map((r) => r.stats.std).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return {
    maxAbsPairMeanDiffC: largestAbs(c.pairs.map((p) => p.meanDiff)),
    maxAbsPairMaxDiffC: largestAbs(c.pairs.map((p) => p.maxDiff)),
    imageStdC: typeof c.stdC === 'number' && Number.isFinite(c.stdC) ? c.stdC : null,
    maxRoiStdC: roiStd.length ? Math.max(...roiStd) : null,
  }
}
export function evaluationMeasures(c: Pick<ThermalCapture, 'pairs' | 'rois' | 'stdC'>): Measure[] {
  const v = evaluationInputs(c)
  const pairMissing = c.pairs.length ? 'no value' : 'no pair'
  const roiMissing = c.rois.length ? 'no value' : 'no region'
  const show = (n: number | null, missing: string) => (n === null ? missing : fmtTemp(n))
  return [
    { label: 'Largest absolute pair mean difference', value: show(v.maxAbsPairMeanDiffC, pairMissing) },
    { label: 'Largest absolute pair maximum difference', value: show(v.maxAbsPairMaxDiffC, pairMissing) },
    { label: 'Whole-image SD', value: show(v.imageStdC, 'not stored') },
    { label: 'Largest region SD', value: show(v.maxRoiStdC, roiMissing) },
  ]
}

export function imageFeatures(c: ThermalCapture): ImageFeatures {
  return {
    id: c.id,
    title: captureTitle(c),
    at: takenAt(c),
    size: `${c.width} × ${c.height} px`,
    origin: DATA_ORIGIN_LABELS[c.dataOrigin],
    clinical: c.dataOrigin === 'clinical',
    whole: [
      { label: 'Min', value: fmtTemp(c.minC) },
      { label: 'Max', value: fmtTemp(c.maxC) },
      { label: 'Mean', value: fmtTemp(c.meanC) },
      { label: 'SD', value: c.stdC === null ? 'not stored' : fmtTemp(c.stdC) },
    ],
    camera: cameraText(c),
    conditions: conditionsText(c),
    extractor: `${c.extractor.name} ${c.extractor.version}`,
    regions: c.rois.map(regionFeatures),
    pairs: c.pairs.map(pairFeatures),
    evaluation: evaluationMeasures(c),
  }
}

export interface Exclusion {
  capture: ThermalCapture
  reason: ExclusionReason
  text: string
}
/** The feature set of a consultation's images (pass consultationCaptures): approved, non-simulated images in, every other image listed with why. */
export function researchFeatures(captures: readonly ThermalCapture[]): { included: { capture: ThermalCapture; features: ImageFeatures }[]; excluded: Exclusion[] } {
  const included: { capture: ThermalCapture; features: ImageFeatures }[] = []
  const excluded: Exclusion[] = []
  for (const c of captures) {
    const reason = exclusionOf(c)
    if (reason) excluded.push({ capture: c, reason, text: EXCLUSION_TEXT[reason] })
    else included.push({ capture: c, features: imageFeatures(c) })
  }
  return { included, excluded }
}

// ---------------------------------------------------------------------------
// The patient
// ---------------------------------------------------------------------------

/**
 * The exact age from a YYYY-MM-DD date of birth: years and months under 18, years from 18, months under a year. Null when the date cannot
 * be read or is after today. Nothing is classed by it: there are no paediatric ranges.
 */
export function exactAge(dob: string, today = new Date()): string | null {
  const [y, m, d] = dob.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  let months = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m)
  if (today.getDate() < d) months--
  if (!Number.isFinite(months) || months < 0) return null
  const years = Math.floor(months / 12)
  const rest = months % 12
  if (years >= 18) return plural(years, 'year')
  if (years === 0) return rest ? plural(rest, 'month') : 'under 1 month'
  return rest ? `${plural(years, 'year')} ${plural(rest, 'month')}` : plural(years, 'year')
}

/** The patient's de-identified research use consent, in the words of the patient record; "Not read" when the record is not loaded here. */
export function researchConsent(states: readonly ConsentSummary[] | null | undefined): string {
  if (!states) return 'Not read'
  const s = states.find((c) => c.type === 'research_use')
  return s ? CONSENT_STATES[s.state] : CONSENT_STATES.not_recorded
}

// ---------------------------------------------------------------------------
// Published research (held here as data; nothing is fetched)
// ---------------------------------------------------------------------------

/**
 * The review the owner named, with the fields verified on the publisher's page and PDF. It is a narrative literature review: it collects no
 * data and trains no model, so it validates nothing in ADAXAI.
 */
export const PUBLISHED_REVIEW = {
  title: 'Thermal Imaging Applications in Shock Detection: Technological Advancements and Clinical Implications',
  authors: ['Manu Sudhi', 'Dasharathraj K. Shetty', 'Jayaraj Mymbilly Balakrishnan', 'Deekshith R Prabhu', 'Ritesh Kamath', 'S. Girisha'],
  journal: 'Engineered Science',
  publisher: 'Engineered Science Publisher',
  year: 2025,
  volume: 33,
  article: 1367,
  doi: '10.30919/es1367',
  url: 'https://doi.org/10.30919/es1367',
  type: 'Review article',
  dates: [
    ['Received', '20 Oct 2024'],
    ['Revised', '13 Nov 2024'],
    ['Accepted', '26 Dec 2024'],
    ['Published online', '05 Jan 2025'],
  ],
  licence: 'CC BY 4.0',
  keywords: ['Artificial intelligence', 'Clinical monitoring', 'Non-invasive diagnostics', 'Shock detection', 'Thermal imaging'],
  objective:
    'A narrative review of thermal imaging for early, non-invasive detection and monitoring of shock: how it compares with conventional assessment, technical advances (sensors, AI), barriers to adoption, and ethics and privacy. It searched Scopus, PubMed and Web of Science (632 records, 36 included) and collects no data and trains no model of its own.',
  approaches: [
    'Random forest with thermal images in a paediatric ICU: Nagori et al. 2019 (in that paper the random forest only locates body regions; see below).',
    'Deep learning on thermal videos in a paediatric ICU: Vats et al. 2022.',
    'Proposed as future work, not built by the review: tree ensembles, LSTM, CNN and RNN models trained on large ICU datasets.',
  ],
  limitations: [
    'Needs controlled conditions, such as room temperature and lighting.',
    'Costly equipment, and no standard protocols, so results vary.',
    'Limited clinical evidence: too few trials of shock detection; large studies are needed.',
    'Reliability when conditions change, clinician training, and privacy, consent and algorithmic bias.',
    'Its abstract claims higher sensitivity and specificity, but the review reports no shock-specific sensitivity or specificity.',
  ],
  gaps: [
    'No established temperature profiles for any type of shock (§6.1).',
    'No infrared thermography studies across patients with different types of shock (§6.2).',
    'Temperature ranges for hypovolaemic, cardiogenic and septic shock are undefined (§6.3).',
  ],
} as const

/**
 * Where a published figure was read: in the primary paper and also as the review reports it, or in the primary paper only (the review leaves
 * it out). Every figure here was read in the primary paper itself (publisher's page and PubMed Central).
 */
export type FigureBasis = 'primary_and_review' | 'primary_only'
export const FIGURE_BASIS_TEXT: Record<FigureBasis, string> = {
  primary_and_review: 'as stated by the primary paper; the review reports it too',
  primary_only: 'as stated by the primary paper only; the review leaves it out',
}
export interface PublishedFigure {
  when: string
  values: string
  basis: FigureBasis
}
export interface PrimaryStudy {
  key: 'nagori-2019' | 'vats-2022'
  cite: string
  authors: string
  title: string
  journal: string
  doi: string
  url: string
  design: string
  method: string
  /** Which result the figures are, and from where in the paper. */
  figuresOf: string
  figures: PublishedFigure[]
  /** How the review's account differs from the paper. */
  reviewNote: string
}

export const PRIMARY_STUDIES: readonly PrimaryStudy[] = [
  {
    key: 'nagori-2019',
    cite: 'Nagori et al. 2019',
    authors: 'Nagori A, Dhingra LS, Bhatnagar A, Lodha R, Sethi T',
    title: 'Predicting Hemodynamic Shock from Thermal Images using Machine Learning',
    journal: 'Scientific Reports 2019; 9: 91',
    doi: '10.1038/s41598-018-36586-8',
    url: 'https://doi.org/10.1038/s41598-018-36586-8',
    design: 'Paediatric ICU, AIIMS New Delhi; 51 children aged 0.2 to 144 months; 539 thermal images, 253 with intra-arterial blood pressure at the same time; shock defined by SIPA. Prospective and longitudinal, as its Methods say.',
    method: 'A random forest on image features (HOG) only locates the abdomen and the foot. The shock results come from a mixed-effects model on the centre-to-periphery temperature difference and the pulse rate.',
    figuresOf: 'AUROC of the automated model (Abstract and Table 3)',
    figures: [
      { when: '0 h (classification)', values: 'AUROC 0.75', basis: 'primary_and_review' },
      { when: '3 h ahead (prediction)', values: 'AUROC 0.77', basis: 'primary_and_review' },
      { when: '6 h ahead (prediction)', values: 'AUROC 0.68', basis: 'primary_only' },
      { when: '12 h ahead (prediction)', values: 'AUROC 0.69', basis: 'primary_and_review' },
    ],
    reviewNote: 'The review lists this study as a random forest on thermal images and gives 75, 77 and 69 as percentages. In the paper the random forest only segments the images; the AUROCs come from the mixed-effects model.',
  },
  {
    key: 'vats-2022',
    cite: 'Vats et al. 2022',
    authors: 'Vats V, Nagori A, Singh P, Dutt R, Bandhey H, Wason M, Lodha R, Sethi T',
    title: 'Early Prediction of Hemodynamic Shock in Pediatric Intensive Care Units With Deep Learning on Thermal Videos',
    journal: 'Frontiers in Physiology 2022; 13: 862411',
    doi: '10.3389/fphys.2022.862411',
    url: 'https://doi.org/10.3389/fphys.2022.862411',
    design: 'Paediatric ICU, AIIMS New Delhi (SafeICU thermal cohort); 22 children; 406 videos (103,936 frames): 132 shock and 274 non-shock sequences; shock defined by SIPA; videos recorded over time.',
    method: 'Deep learning prepares the frames (YOLOv3 detects the person, ResNet-152 sorts covered from uncovered frames, ResUNet segments). The centre-to-periphery temperature difference over time, with the heart rate, goes into LSTM models: detection at 0 h, prediction up to 6 h ahead.',
    figuresOf: 'AUROC and AUPRC by lead time (Table 2)',
    figures: [
      { when: '0 h (detection)', values: 'AUROC 0.78 · AUPRC 0.79', basis: 'primary_only' },
      { when: '1 h ahead', values: 'AUROC 0.76 · AUPRC 0.71', basis: 'primary_only' },
      { when: '2 h ahead', values: 'AUROC 0.69 · AUPRC 0.56', basis: 'primary_only' },
      { when: '3 h ahead', values: 'AUROC 0.74 · AUPRC 0.67', basis: 'primary_only' },
      { when: '4 h ahead', values: 'AUROC 0.75 · AUPRC 0.75', basis: 'primary_only' },
      { when: '5 h ahead', values: 'AUROC 0.81 · AUPRC 0.78', basis: 'primary_and_review' },
      { when: '6 h ahead', values: 'AUROC 0.73 · AUPRC 0.66', basis: 'primary_only' },
    ],
    reviewNote: 'The review gives AUC 0.81 and AUPRC 0.78 with prediction up to 6 hours before onset. In the paper 0.81 is the best lead time (5 h); at 6 h it is 0.73 (AUPRC 0.66).',
  },
]

/** What the review cites that is not about shock, and why it is not shown. */
export const PUBLISHED_NOT_SHOWN = 'The review’s other figures (burns, knee, musculoskeletal injury, stress) are not about shock and are not shown. Both studies above come from the same group (AIIMS New Delhi).'
export const PUBLISHED_LINE = 'A literature review. ADAXAI implements no method from it; the figures here are other studies’ published results, not ADAXAI’s.'
export const PUBLISHED_BADGE = 'PUBLISHED RESEARCH — NOT ADAX-AI VALIDATION'
export const PUBLISHED_METRICS_HEADING = 'Published metrics (other studies’ results, not ADAXAI’s)'
