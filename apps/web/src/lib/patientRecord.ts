import {
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_GROUPS,
  DOCUMENT_MODALITY_LABELS,
  type DocumentCategory,
  type DocumentModality,
  IMAGING_DOCUMENT_CATEGORIES,
  type Observation,
  type PatientDocument,
  type PatientHistory,
  type PatientProcedure,
} from '@adaxai/contracts'

/*
 * The patient's record in a few compact lines ("From the record"), the same words in the consultation's history panel and on the doctor's
 * patient page, built only from the history the screen already read (GET /api/patients/:id/history). Fixed rules, never AI. Missing is not
 * none: a list that was read and is empty is "Not recorded"; a part the server did not send (an older server) is "Not available yet"; neither
 * is ever "none", "0" or a bare dash. Pure functions (no React, no DOM, no clock of their own), unit-tested in node.
 */

export const NOT_RECORDED = 'Not recorded'
export const NOT_AVAILABLE = 'Not available yet'

/** How many names a line lists before "+n". */
const NAMED = 3

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The calendar day (YYYY-MM-DD) of a date or an instant: a YYYY-MM-DD date is that day; an ISO instant is its day on this device's clock
 * (the clock `localToday` reads), never the UTC day its text starts with (a reading at 01:30 in India is that day, not the day before).
 */
export function localDay(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? value.slice(0, 10) : localToday(at)
}

/** "04 Oct" for a date this year, "04 Oct 2025" otherwise (YYYY-MM-DD, or an ISO instant read on this device's clock; `today` is YYYY-MM-DD). */
export function shortDate(date: string, today: string): string {
  const [y, m, d] = localDay(date).split('-')
  const month = MONTHS[Number(m) - 1]
  if (!y || !month || !d) return date
  return `${d} ${month}${y === today.slice(0, 4) ? '' : ` ${y}`}`
}

/** "2022", "Mar 2022", or "date not recorded" (never a guess). */
export function procedureWhen(p: Pick<PatientProcedure, 'performedYear' | 'performedMonth'>): string {
  if (p.performedYear == null) return 'date not recorded'
  const month = p.performedMonth ? MONTHS[p.performedMonth - 1] : null
  return month ? `${month} ${p.performedYear}` : String(p.performedYear)
}

/** "A, B, C +2". */
function named(items: string[]): string {
  return `${items.slice(0, NAMED).join(', ')}${items.length > NAMED ? ` +${items.length - NAMED}` : ''}`
}

const person = (name: string | null) => name?.replace(/\s*\(synthetic\)$/i, '') ?? null

export type RecordLineKey = 'allergies' | 'conditions' | 'surgeries' | 'medicines' | 'results' | 'imaging' | 'lastConsultation' | 'lastVitals'

export interface RecordLine {
  key: RecordLineKey
  label: string
  /** What the line says; when `missing`, it says what is missing ("Not recorded", "Not available yet", "Allergy status not recorded"). */
  text: string
  /** down: a severe allergy; warn: something a doctor must know is not recorded (allergy status, a severity); neutral otherwise. */
  tone: 'down' | 'warn' | 'neutral'
  missing: boolean
}

const line = (key: RecordLineKey, label: string, text: string | null, missingText = NOT_RECORDED, tone: RecordLine['tone'] = 'neutral'): RecordLine =>
  text ? { key, label, text, tone, missing: false } : { key, label, text: missingText, tone: 'neutral', missing: true }

const SEVERITY: Record<string, string> = { severe: 'severe', moderate: 'moderate', mild: 'mild', unknown: 'severity not recorded' }

export function allergyLine(h: Pick<PatientHistory, 'allergies' | 'noKnownAllergies'>): RecordLine {
  const list = h.allergies ?? []
  if (list.length) {
    const tone = list.some((a) => a.severity === 'severe') ? 'down' : list.some((a) => a.severity === 'unknown') ? 'warn' : 'neutral'
    return { key: 'allergies', label: 'Allergies', text: named(list.map((a) => `${a.substance} (${SEVERITY[a.severity] ?? SEVERITY.unknown})`)), tone, missing: false }
  }
  if (h.noKnownAllergies) return { key: 'allergies', label: 'Allergies', text: 'No known allergies (recorded)', tone: 'neutral', missing: false }
  return { key: 'allergies', label: 'Allergies', text: 'Allergy status not recorded', tone: 'warn', missing: true }
}

/** A recent result: a typed investigation (with its value, and its flag in words when it is not normal) or a laboratory report document. */
export interface RecentItem {
  text: string
  date: string
}

const FLAG_WORDS: Record<string, string | null> = { normal: null, high: 'high', low: 'low', abnormal: 'abnormal', unknown: 'not compared with a range' }

/**
 * The newest results: the latest of each typed test (an old value is not today's picture of a test done since) and the laboratory reports
 * on the record, newest first. A result never reads as normal unless it was compared: "not compared with a range" is said.
 */
export function recentResults(h: Pick<PatientHistory, 'investigations' | 'documents'>, today: string, limit = NAMED): RecentItem[] {
  const seen = new Set<string>()
  const items: (RecentItem & { at: string })[] = []
  for (const r of h.investigations ?? []) {
    const k = r.testName.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    const flag = FLAG_WORDS[r.flag] ?? null
    items.push({ text: `${r.testName} ${r.valueText}${r.unit ? ` ${r.unit}` : ''}${flag ? ` (${flag})` : ''} — ${shortDate(r.collectedOn, today)}`, date: r.collectedOn, at: r.enteredAt })
  }
  for (const d of h.documents?.latest ?? []) {
    if (d.category !== 'lab_report') continue
    const date = documentDate(d)
    items.push({ text: `${d.title} — ${shortDate(date, today)}`, date, at: d.createdAt })
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at))
  return items.slice(0, limit).map(({ text, date }) => ({ text, date }))
}

/** "MRI brain": the modality's name before the title, unless the title already says it. */
export function imagingTitle(d: { title: string; modality: DocumentModality | null }): string {
  if (!d.modality || d.modality === 'other') return d.title
  const label = DOCUMENT_MODALITY_LABELS[d.modality]
  return d.title.toLowerCase().includes(label.toLowerCase()) ? d.title : `${label} ${d.title}`
}

const isImaging = (c: DocumentCategory) => IMAGING_DOCUMENT_CATEGORIES.includes(c)

/** The imaging line: the newest imaging documents ("MRI brain — 21 Sep"); older ones only counted; null when there is none. */
export function recentImaging(h: Pick<PatientHistory, 'documents'>, today: string): string | null {
  const docs = h.documents
  if (!docs) return null
  const shown = docs.latest
    .filter((d) => isImaging(d.category))
    .sort((a, b) => documentDate(b).localeCompare(documentDate(a)) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, NAMED)
  const total = docs.byCategory.imaging_report + docs.byCategory.imaging_image
  if (!shown.length) return total ? `${total} imaging document${total === 1 ? '' : 's'} on the record` : null
  const text = shown.map((d) => `${imagingTitle(d)} — ${shortDate(documentDate(d), today)}`).join(', ')
  return total > shown.length ? `${text} +${total - shown.length}` : text
}

const VITAL_ORDER = ['heart_rate', 'systolic_bp', 'spo2', 'temperature', 'respiratory_rate'] as const
const VITAL_SHORT: Record<string, { label: string; unit: string; decimals: number }> = {
  heart_rate: { label: 'HR', unit: '', decimals: 0 },
  spo2: { label: 'SpO₂', unit: '%', decimals: 0 },
  temperature: { label: 'Temp', unit: '°C', decimals: 1 },
  respiratory_rate: { label: 'RR', unit: '', decimals: 0 },
}

/**
 * "HR 82 · BP 118/76 · SpO₂ 98% · Temp 37.2°C — 04 Oct": the latest staff-recorded value of each vital sign (the read model never includes
 * a simulator's output). The latest of each kind can come from different visits, so the line's date is the newest day a value was measured
 * on (this device's clock), and a value measured on an earlier day carries its own date ("Temp 38.6°C (12 Mar 2025)"): an old value never
 * reads as a current one. A device's unverified reading is marked. Systolic and diastolic are paired only when measured on the same day.
 * Null when none is recorded.
 */
export function vitalsText(vitals: Observation[] | undefined, today: string): string | null {
  const latest = new Map<string, Observation>()
  for (const o of vitals ?? []) {
    if (o.enteredInError || o.validationStatus === 'simulated') continue
    const prev = latest.get(o.kind)
    if (!prev || o.measuredAt > prev.measuredAt) latest.set(o.kind, o)
  }
  const parts: { text: string; day: string; device: boolean }[] = []
  const part = (text: string, ...from: Observation[]) =>
    parts.push({ text, day: localDay(from[0]!.measuredAt), device: from.some((o) => o.validationStatus === 'device_unverified') })
  const sys = latest.get('systolic_bp')
  const dia = latest.get('diastolic_bp')
  const paired = !!sys && !!dia && localDay(sys.measuredAt) === localDay(dia.measuredAt)
  for (const kind of VITAL_ORDER) {
    const o = latest.get(kind)
    if (kind === 'systolic_bp') {
      // A pressure is one reading: without a diastolic value from the same day, each half is said as what it is (systolic, diastolic) with
      // its own date, never paired with another day's value and never with a dash for the missing half.
      if (paired) part(`BP ${Math.round(sys!.value)}/${Math.round(dia!.value)}`, sys!, dia!)
      else {
        if (sys) part(`SBP ${Math.round(sys.value)}`, sys)
        if (dia) part(`DBP ${Math.round(dia.value)}`, dia)
      }
      continue
    }
    if (!o) continue
    const spec = VITAL_SHORT[kind]!
    part(`${spec.label} ${o.value.toFixed(spec.decimals)}${spec.unit}`, o)
  }
  if (!parts.length) return null
  const newest = parts.reduce((day, p) => (p.day > day ? p.day : day), '')
  const said = parts.map((p) => {
    const notes = [p.device ? 'device, unverified' : null, p.day === newest ? null : shortDate(p.day, today)].filter(Boolean)
    return notes.length ? `${p.text} (${notes.join(', ')})` : p.text
  })
  return `${said.join(' · ')} — ${shortDate(newest, today)}`
}

/**
 * The compact lines of the record, in the design's order: Allergies; Conditions; Surgeries; Medicines; Recent results; Recent imaging; Last
 * consultation (and, with `vitals`, Last vitals). Each says what is missing instead of "none".
 */
export function recordLines(h: PatientHistory, today: string, opts: { vitals?: boolean } = {}): RecordLine[] {
  const open = (h.conditions ?? []).filter((c) => c.status !== 'resolved' && c.status !== 'entered_in_error')
  const current = (h.medications ?? []).filter((m) => m.status === 'current')
  const last = (h.consultations ?? [])[0]
  const results = recentResults(h, today)
  const procedures = h.procedures
  const lines: RecordLine[] = [
    allergyLine(h),
    line('conditions', 'Conditions', open.length ? named(open.map((c) => c.name)) : null),
    procedures === undefined
      ? line('surgeries', 'Surgeries', null, NOT_AVAILABLE)
      : line('surgeries', 'Surgeries', procedures.length ? named(procedures.map((p) => `${p.name} — ${procedureWhen(p)}`)) : null),
    line('medicines', 'Medicines', current.length ? named(current.map((m) => [m.drugName, m.strength].filter(Boolean).join(' '))) : null),
    line('results', 'Recent results', results.length ? results.map((r) => r.text).join(', ') : null),
    h.documents === undefined ? line('imaging', 'Recent imaging', null, NOT_AVAILABLE) : line('imaging', 'Recent imaging', recentImaging(h, today)),
    line('lastConsultation', 'Last consultation', last ? [shortDate(last.date, today), person(last.doctorName), last.chiefComplaint || null].filter(Boolean).join(' · ') : null),
  ]
  if (opts.vitals) lines.push(line('lastVitals', 'Last vitals', vitalsText(h.latestVitals, today)))
  return lines
}

// --- Documents ---------------------------------------------------------------------------------------------------------------------------------

/** The day a document is about: the study's own date, else the day it was added (on this device's clock). */
export const documentDate = (d: Pick<PatientDocument, 'studyDate' | 'createdAt'>) => d.studyDate ?? localDay(d.createdAt)

export interface DocumentGroup {
  label: string
  categories: DocumentCategory[]
  documents: PatientDocument[]
}

/** The Documents tab's groups (Lab reports · Imaging · Other), each newest first by the study date (or the day it was added). Empty groups are kept. */
export function groupDocuments(docs: PatientDocument[]): DocumentGroup[] {
  return DOCUMENT_GROUPS.map((g) => ({
    label: g.label,
    categories: g.categories,
    documents: docs.filter((d) => g.categories.includes(d.category)).sort((a, b) => documentDate(b).localeCompare(documentDate(a)) || b.createdAt.localeCompare(a.createdAt)),
  }))
}

export const isImageDocument = (d: Pick<PatientDocument, 'mimeType'>) => d.mimeType === 'image/jpeg' || d.mimeType === 'image/png'

/** A document's file: GET /api/files/:id serves the original (up to DOCUMENT_MAX_BYTES), never cached, and audits every read. */
export const documentFileUrl = (d: Pick<PatientDocument, 'fileId'>) => `/api/files/${d.fileId}`

/**
 * The file a document row shows in place, if any. Rows show an icon tile, never a thumbnail of the original (the only copy, up to 15 MB,
 * read and audited on every request), so opening the Documents tab reads no file: an image is fetched only once the doctor opens it in its
 * row (`opened`), and a PDF never shows in place (it opens in a new tab).
 */
export function documentInlineSrc(d: Pick<PatientDocument, 'fileId' | 'mimeType'>, opened: boolean): string | null {
  return opened && isImageDocument(d) ? documentFileUrl(d) : null
}

/** "1.2 MB", "340 KB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** One muted line under a document's title: what it is, when the study was done (or that it is not recorded), the file. */
export function documentMeta(d: PatientDocument, today: string): string {
  const kind = d.modality ? `${DOCUMENT_CATEGORY_LABELS[d.category]} · ${DOCUMENT_MODALITY_LABELS[d.modality]}` : DOCUMENT_CATEGORY_LABELS[d.category]
  const when = d.studyDate ? `Study ${shortDate(d.studyDate, today)}` : 'Study date not recorded'
  const file = `${d.mimeType === 'application/pdf' ? 'PDF' : d.mimeType === 'image/png' ? 'PNG' : 'JPEG'} · ${fileSize(d.sizeBytes)}`
  return `${kind} · ${when} · ${file}`
}

/** The allergy chip of a patient row: the first allergy's name and how many more; null when none is listed (no chip, never "none"). */
export function allergyChip(activeAllergies: string[] | undefined): string | null {
  const list = activeAllergies ?? []
  if (!list.length) return null
  return `${list[0]}${list.length > 1 ? ` +${list.length - 1}` : ''}`
}

/** Today (YYYY-MM-DD) on this device's clock: only for choosing how a date reads ("04 Oct" or "04 Oct 2025"), never to decide anything. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
