import type { Encounter } from '@adaxai/contracts'

/**
 * The prescription of a consultation as a real PDF (jury design, screen 4), written by hand (PDF 1.4, the standard Helvetica fonts, WinAnsi
 * text, no dependency): the clinic and doctor, the patient, a short patient summary from the doctor's note and today's staff vitals, the
 * diagnoses, the medicines, advice and follow-up, and the signature. A draft is marked "DRAFT — not signed" on every page; a signed one says
 * who signed it and when. Every page's footer says the data is synthetic and the document is not a valid prescription (a development build).
 * The content is the record as stored (the same the print page shows); nothing is generated or inferred here.
 */

const PAGE_W = 595
const PAGE_H = 842
const LEFT = 48
const RIGHT = PAGE_W - 48
const BOTTOM = 72

type Font = 'R' | 'B'
type Rgb = [number, number, number]
const INK: Rgb = [0.11, 0.13, 0.16]
const MUTED: Rgb = [0.42, 0.45, 0.5]
const BRAND: Rgb = [0.05, 0.42, 0.45]
const DOWN: Rgb = [0.75, 0.13, 0.13]
const LINE: Rgb = [0.85, 0.87, 0.9]
const SOFT: Rgb = [0.955, 0.965, 0.975]
const WHITE: Rgb = [1, 1, 1]

// Helvetica and Helvetica-Bold advance widths (AFM, per 1000 em) for the printable ASCII range 32..126.
const W_R = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
const W_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]
const W_HIGH: Record<number, number> = { 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0xb0: 400, 0xb5: 556, 0xb7: 278, 0xd7: 584 }

/** The characters of WinAnsiEncoding outside Latin-1, and a few others spelled in ASCII. */
const WINANSI: Record<string, string> = { '‘': '\x91', '’': '\x92', '“': '\x93', '”': '\x94', '•': '\x95', '–': '\x96', '—': '\x97', '…': '...', '℞': 'Rx', '→': '->', '≥': '>=', '≤': '<=', '₂': '2', '\t': ' ', '\r': ' ', '\n': ' ' }

/** A string in the bytes of WinAnsiEncoding (one char per byte; what it cannot hold becomes "?"). */
export function winAnsi(s: string): string {
  let out = ''
  for (const ch of s.normalize('NFC')) {
    const mapped = WINANSI[ch]
    if (mapped !== undefined) out += mapped
    else if (ch.codePointAt(0)! <= 0xff) out += ch
    else out += '?'
  }
  return out
}

function widthOf(s: string, font: Font, size: number): number {
  const table = font === 'B' ? W_B : W_R
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    w += c >= 32 && c <= 126 ? table[c - 32]! : (W_HIGH[c] ?? 556)
  }
  return (w * size) / 1000
}

/** Breaks WinAnsi text into lines that fit `width` (long words are cut). */
function wrap(s: string, font: Font, size: number, width: number): string[] {
  const words = s.split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (let word of words) {
    while (widthOf(word, font, size) > width) {
      let cut = word.length - 1
      while (cut > 1 && widthOf(word.slice(0, cut), font, size) > width) cut--
      if (cur) lines.push(cur)
      lines.push(word.slice(0, cut))
      cur = ''
      word = word.slice(cut)
    }
    const next = cur ? `${cur} ${word}` : word
    if (widthOf(next, font, size) <= width) cur = next
    else {
      lines.push(cur)
      cur = word
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

const pdfString = (s: string) => `(${s.replace(/([\\()])/g, '\\$1')})`
const rgb = (c: Rgb) => c.map((v) => v.toFixed(3)).join(' ')

class Pages {
  pages: string[][] = []
  y = PAGE_H
  private ops: string[] = []
  constructor(private readonly onNewPage: (p: Pages, first: boolean) => void) {
    this.newPage(true)
  }
  newPage(first = false) {
    this.ops = []
    this.pages.push(this.ops)
    this.y = PAGE_H
    this.onNewPage(this, first)
  }
  /** Room for `h` points below the cursor, or a new page. */
  need(h: number) {
    if (this.y - h < BOTTOM) this.newPage()
  }
  text(x: number, y: number, s: string, opts: { font?: Font; size?: number; color?: Rgb; align?: 'left' | 'right' | 'center' } = {}) {
    const font = opts.font ?? 'R'
    const size = opts.size ?? 10
    const t = winAnsi(s)
    const w = widthOf(t, font, size)
    const at = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x
    this.ops.push(`BT /F${font === 'B' ? 2 : 1} ${size} Tf ${rgb(opts.color ?? INK)} rg ${at.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(t)} Tj ET`)
  }
  rect(x: number, y: number, w: number, h: number, fill: Rgb) {
    this.ops.push(`${rgb(fill)} rg ${x} ${y.toFixed(2)} ${w} ${h.toFixed(2)} re f`)
  }
  box(x: number, y: number, w: number, h: number, stroke: Rgb, width = 1) {
    this.ops.push(`${rgb(stroke)} RG ${width} w ${x} ${y.toFixed(2)} ${w} ${h.toFixed(2)} re S`)
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: Rgb = LINE, width = 0.8) {
    this.ops.push(`${rgb(stroke)} RG ${width} w ${x1} ${y1.toFixed(2)} m ${x2} ${y2.toFixed(2)} l S`)
  }
  /** A paragraph at the cursor, wrapped to [x, x + width]; the cursor moves below it. */
  paragraph(s: string, opts: { x?: number; width?: number; font?: Font; size?: number; color?: Rgb; leading?: number } = {}) {
    const size = opts.size ?? 10
    const leading = opts.leading ?? size * 1.4
    const x = opts.x ?? LEFT
    for (const l of wrap(winAnsi(s), opts.font ?? 'R', size, opts.width ?? RIGHT - x)) {
      this.need(leading)
      this.y -= leading
      this.ops.push(`BT /F${opts.font === 'B' ? 2 : 1} ${size} Tf ${rgb(opts.color ?? INK)} rg ${x} ${this.y.toFixed(2)} Td ${pdfString(l)} Tj ET`)
    }
  }
  heading(s: string) {
    this.need(40)
    this.y -= 22
    this.text(LEFT, this.y, s.toUpperCase(), { font: 'B', size: 9.5, color: BRAND })
    this.line(LEFT, this.y - 5, RIGHT, this.y - 5)
    this.y -= 6
  }
}

/** "2026-10-07" → "07 Oct 2026". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDay = (d: string) => {
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${day} ${MONTHS[Number(m) - 1]} ${y}`
}
const fmtMoment = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso))

const ageOn = (dob: string, on: string) => {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number]
  const [y, m, d] = on.slice(0, 10).split('-').map(Number) as [number, number, number]
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0)
}
const SEX: Record<string, string> = { male: 'Male', female: 'Female', other: 'Other', unknown: 'Unknown' }
/** Display names without the data's "(synthetic)" mark (the footer of every page says it once). */
const plain = (s: string) => s.replace(/\s*\(synthetic\)\s*$/i, '').trim()

/** Today's staff vitals in one line ("T 37.8 °C · HR 92 /min · BP 128/84 mmHg · SpO2 98 % · RR 18 /min · RBS 146 mg/dL"); simulated values are left out. */
export function vitalsLine(vitals: Encounter['vitals']): string | null {
  const latest = new Map<string, Encounter['vitals'][number]>()
  for (const v of vitals) {
    if (v.validationStatus === 'simulated') continue
    const cur = latest.get(v.kind)
    if (!cur || cur.measuredAt < v.measuredAt) latest.set(v.kind, v)
  }
  const v = (k: string) => latest.get(k)
  const parts: string[] = []
  if (v('temperature')) parts.push(`T ${v('temperature')!.value} °C`)
  if (v('heart_rate')) parts.push(`HR ${v('heart_rate')!.value} /min`)
  if (v('systolic_bp') && v('diastolic_bp')) parts.push(`BP ${v('systolic_bp')!.value}/${v('diastolic_bp')!.value} mmHg`)
  if (v('spo2')) parts.push(`SpO2 ${v('spo2')!.value} %`)
  if (v('respiratory_rate')) parts.push(`RR ${v('respiratory_rate')!.value} /min`)
  if (v('blood_glucose')) parts.push(`RBS ${v('blood_glucose')!.value} ${v('blood_glucose')!.unit}`)
  return parts.length ? parts.join(' · ') : null
}

export function prescriptionPdf(e: Encounter, opts: { timeZone: string }): Buffer {
  const signed = e.status === 'signed' && !!e.signedAt
  const clinic = plain(e.facilityName)
  const doctor = plain(e.doctor.fullName)
  const patient = plain(e.patient.fullName)
  const date = fmtDay(e.visit.visitDate)

  const doc = new Pages((p, first) => {
    if (first) {
      p.rect(0, PAGE_H - 92, PAGE_W, 92, BRAND)
      p.text(LEFT, PAGE_H - 40, clinic, { font: 'B', size: 18, color: WHITE })
      p.text(LEFT, PAGE_H - 60, 'Outpatient prescription', { size: 10, color: WHITE })
      p.text(RIGHT, PAGE_H - 40, doctor, { font: 'B', size: 12, color: WHITE, align: 'right' })
      p.text(RIGHT, PAGE_H - 56, e.visit.departmentName, { size: 9.5, color: WHITE, align: 'right' })
      if (e.doctor.registrationNumber) p.text(RIGHT, PAGE_H - 70, `Reg. No. ${e.doctor.registrationNumber}`, { size: 9.5, color: WHITE, align: 'right' })
      p.y = PAGE_H - 92
    } else {
      p.text(LEFT, PAGE_H - 40, `${clinic} · Prescription (continued)`, { font: 'B', size: 11, color: BRAND })
      p.text(RIGHT, PAGE_H - 40, `${patient} · MRN ${e.patient.mrn}`, { size: 9.5, color: MUTED, align: 'right' })
      p.line(LEFT, PAGE_H - 48, RIGHT, PAGE_H - 48)
      p.y = PAGE_H - 52
    }
    if (!signed) {
      p.y -= 26
      p.box(LEFT, p.y - 4, RIGHT - LEFT, 20, DOWN, 1.2)
      p.text(PAGE_W / 2, p.y + 2, 'DRAFT — NOT SIGNED · NOT A VALID PRESCRIPTION', { font: 'B', size: 10, color: DOWN, align: 'center' })
      p.y -= 6
    }
  })

  // The patient.
  const cells: [string, string][] = [
    ['Patient', patient],
    ['MRN', e.patient.mrn],
    ['Age / Sex', `${ageOn(e.patient.dateOfBirth, e.visit.visitDate)} y / ${SEX[e.patient.sex] ?? e.patient.sex}`],
    ['Date', date],
  ]
  doc.y -= 14
  const boxTop = doc.y
  doc.rect(LEFT, boxTop - 62, RIGHT - LEFT, 62, SOFT)
  const colW = (RIGHT - LEFT - 24) / 4
  cells.forEach(([k, v], i) => {
    const x = LEFT + 12 + i * colW
    doc.text(x, boxTop - 16, k.toUpperCase(), { size: 7.5, color: MUTED, font: 'B' })
    doc.text(x, boxTop - 30, wrap(winAnsi(v), 'B', 10.5, colW - 8)[0]!, { size: 10.5, font: 'B' })
  })
  const allergies = e.patient.activeAllergies.length ? e.patient.activeAllergies.join(', ') : e.patient.noKnownAllergies ? 'No known allergies' : 'Not recorded'
  doc.text(LEFT + 12, boxTop - 50, 'ALLERGIES', { size: 7.5, color: MUTED, font: 'B' })
  doc.text(LEFT + 70, boxTop - 50, wrap(winAnsi(allergies), 'B', 10, RIGHT - LEFT - 160)[0]!, { size: 10, font: 'B', color: e.patient.activeAllergies.length ? DOWN : INK })
  if (e.patient.phone) doc.text(RIGHT - 12, boxTop - 50, `Contact ${e.patient.phone}`, { size: 9, color: MUTED, align: 'right' })
  doc.y = boxTop - 62

  // A short summary from the doctor's note and today's staff vitals.
  const n = e.note
  const summary: [string, string][] = (
    [
      ['Chief complaint', n.chiefComplaint],
      ['History', n.history],
      ['Medical history', n.pastHistory],
      ['Vitals', vitalsLine(e.vitals) ?? ''],
      ['Findings', n.examination],
      ['Assessment', n.assessment],
    ] as [string, string][]
  ).filter(([, v]) => v.trim())
  if (summary.length) {
    doc.heading('Patient summary')
    for (const [k, v] of summary) {
      const text = v.trim().replace(/\s+/g, ' ')
      const short = text.length > 420 ? `${text.slice(0, 417)}…` : text
      doc.need(16)
      const top = doc.y
      doc.text(LEFT, top - 13, k, { font: 'B', size: 9.5, color: MUTED })
      doc.paragraph(short, { x: LEFT + 104, width: RIGHT - LEFT - 104, size: 10, leading: 13 })
      doc.y -= 3
    }
  }

  doc.heading('Diagnosis')
  if (e.diagnoses.length) e.diagnoses.forEach((d, i) => doc.paragraph(`${i + 1}. ${d.description}${d.code ? ` (${d.code})` : ''}${d.kind === 'provisional' ? ' — provisional' : ''}`, { size: 10.5, leading: 15 }))
  else doc.paragraph('No diagnosis recorded.', { color: MUTED })

  // The medicines.
  doc.heading('Rx — Medicines')
  const cols = [
    { label: '#', x: LEFT + 4, w: 16 },
    { label: 'Medicine', x: LEFT + 22, w: 190 },
    { label: 'Dose', x: LEFT + 218, w: 82 },
    { label: 'Frequency', x: LEFT + 304, w: 92 },
    { label: 'Duration', x: LEFT + 400, w: RIGHT - LEFT - 404 },
  ]
  if (e.prescription.length) {
    doc.need(22)
    doc.rect(LEFT, doc.y - 20, RIGHT - LEFT, 18, SOFT)
    for (const c of cols) doc.text(c.x, doc.y - 14, c.label, { font: 'B', size: 8.5, color: MUTED })
    doc.y -= 20
    e.prescription.forEach((p, i) => {
      const name = winAnsi([p.drugName, p.strength, p.form].filter(Boolean).join(' '))
      const nameLines = wrap(name, 'B', 10, cols[1]!.w)
      const instrLines = p.instructions ? wrap(winAnsi(p.instructions), 'R', 8.5, cols[1]!.w) : []
      const dose = wrap(winAnsi([p.dose, p.route && `(${p.route})`].filter(Boolean).join(' ')), 'R', 9.5, cols[2]!.w)
      const freq = wrap(winAnsi(p.frequency), 'R', 9.5, cols[3]!.w)
      const durText = p.durationDays ? `${p.durationDays} day${p.durationDays === 1 ? '' : 's'}${p.startDate ? ` from ${fmtDay(p.startDate)}` : ''}` : p.duration
      const dur = wrap(winAnsi(durText), 'R', 9.5, cols[4]!.w)
      const h = Math.max(nameLines.length * 13 + instrLines.length * 11, dose.length * 12, freq.length * 12, dur.length * 12) + 10
      doc.need(h)
      const top = doc.y
      doc.text(cols[0]!.x, top - 14, String(i + 1), { size: 9.5, color: MUTED })
      nameLines.forEach((l, j) => doc.text(cols[1]!.x, top - 14 - j * 13, l, { font: 'B', size: 10 }))
      instrLines.forEach((l, j) => doc.text(cols[1]!.x, top - 14 - nameLines.length * 13 - j * 11, l, { size: 8.5, color: MUTED }))
      ;[dose, freq, dur].forEach((ls, c) => ls.forEach((l, j) => doc.text(cols[c + 2]!.x, top - 14 - j * 12, l, { size: 9.5 })))
      doc.y = top - h
      doc.line(LEFT, doc.y, RIGHT, doc.y)
    })
  } else doc.paragraph('No medicines prescribed.', { color: MUTED })

  if (n.plan.trim()) {
    doc.heading('Advice')
    for (const para of n.plan.split(/\n+/).map((s) => s.trim()).filter(Boolean)) doc.paragraph(para, { size: 10, leading: 14 })
  }
  if (n.followUp.trim()) {
    doc.heading('Follow-up')
    doc.paragraph(n.followUp.trim(), { size: 10, leading: 14 })
  }
  if (e.amendments.length) {
    doc.heading('Amendments after signing')
    for (const a of e.amendments) doc.paragraph(`${fmtMoment(a.createdAt, opts.timeZone)}, ${plain(a.authorName)}: ${a.content} (reason: ${a.reason})`, { size: 9.5, leading: 13 })
  }

  // The signature.
  doc.need(78)
  doc.y -= 50
  doc.line(RIGHT - 190, doc.y, RIGHT, doc.y, INK, 0.8)
  doc.text(RIGHT, doc.y - 13, doctor, { font: 'B', size: 10, align: 'right' })
  if (signed) doc.text(RIGHT, doc.y - 26, `Signed electronically on ${fmtMoment(e.signedAt!, opts.timeZone)}`, { size: 8.5, color: MUTED, align: 'right' })
  else doc.text(RIGHT, doc.y - 26, 'Not signed', { font: 'B', size: 8.5, color: DOWN, align: 'right' })
  doc.y -= 30

  // Footers, now that the page count is known.
  const total = doc.pages.length
  doc.pages.forEach((ops, i) => {
    ops.push(`${rgb(LINE)} RG 0.8 w ${LEFT} 46 m ${RIGHT} 46 l S`)
    const note = winAnsi('ADAXAI · Synthetic data — development build, not a valid prescription.')
    ops.push(`BT /F1 8 Tf ${rgb(MUTED)} rg ${LEFT} 34 Td ${pdfString(note)} Tj ET`)
    const pg = winAnsi(`Page ${i + 1} of ${total}`)
    ops.push(`BT /F1 8 Tf ${rgb(MUTED)} rg ${(RIGHT - widthOf(pg, 'R', 8)).toFixed(2)} 34 Td ${pdfString(pg)} Tj ET`)
  })
  return assemble(doc.pages, `Prescription - ${patient} - ${date}`)
}

/** The PDF file: catalog, pages, two fonts, one content stream per page, info, cross-reference table. */
function assemble(pages: string[][], title: string): Buffer {
  const objects: string[] = []
  const add = (o: string) => objects.push(o)
  add('<< /Type /Catalog /Pages 2 0 R >>')
  const firstPage = 6
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  add(`<< /Title ${pdfString(winAnsi(title))} /Producer (ADAXAI) /Creator (ADAXAI) >>`)
  pages.forEach((ops, i) => {
    const content = ops.join('\n')
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${firstPage + i * 2 + 1} 0 R >>`)
    add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
  })
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
