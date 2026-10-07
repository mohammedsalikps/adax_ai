import type { DiagnosisInput, PrescriptionItemInput } from '@adaxai/contracts'
import type { Draft } from './draftSaver.ts'

/**
 * DEMO / SEED prescription (final demo polish) — not clinical decision support, and not AI. For the demonstration consultations, a fixed
 * keyword table turns what the consultation says into a DRAFT prescription: a diagnosis, a medicine, advice and a follow-up. It is used only
 * when the doctor runs Analyze & Generate Prescription, only in a deployment that allows simulators (synthetic data), and only on an empty
 * prescription; the doctor reviews and edits every part, the allergy check and the signing checks are unchanged, and nothing here signs or
 * completes. A real clinical decision support module replaces `demoPrescriptionFor` (the one entry point) later.
 */

export type DemoCase = 'stomach' | 'fever' | 'headache'

export interface DemoPrescription {
  case: DemoCase
  diagnoses: DiagnosisInput[]
  prescription: PrescriptionItemInput[]
  advice: string
  followUp: string
}

/** What the consultation says, in the order it is trusted: the doctor's chief complaint first, the conversation last. */
export interface DemoContext {
  chiefComplaint: string
  /** The reason for the visit, as recorded at registration. */
  reasonForVisit: string | null
  history: string
  assessment: string
  /** The conversation's transcript text, if any. */
  transcript: string[]
}

export const DEMO_PRESCRIPTION_NOTICE = 'Demo draft filled from this consultation by fixed demonstration rules (not AI, not a clinical recommendation). Review and edit every part before signing.'

const tablet = (drugName: string, strength: string, frequency: string, days: number, instructions: string): PrescriptionItemInput => ({
  drugName,
  strength,
  form: 'Tablet',
  dose: '1 tablet',
  route: 'Oral',
  frequency,
  duration: `${days} days`,
  durationDays: days,
  instructions,
})

const CASES: { case: DemoCase; match: RegExp; rx: Omit<DemoPrescription, 'case'> }[] = [
  {
    case: 'stomach',
    match: /\b(stomach|abdominal|abdomen|tummy|epigastri\w*|gastri\w*|acidity|dyspepsia|indigestion|heartburn)\b/i,
    rx: {
      diagnoses: [{ description: 'Acute gastritis / dyspepsia', kind: 'primary' }],
      prescription: [tablet('Pantoprazole', '40 mg', 'Once daily (OD)', 5, 'Before food')],
      advice: 'Avoid heavy/spicy meals. Maintain hydration.',
      followUp: 'Review after 5 days or earlier if symptoms worsen.',
    },
  },
  {
    case: 'fever',
    match: /\b(fever\w*|febrile|pyrexia)\b/i,
    rx: {
      diagnoses: [{ description: 'Viral fever (acute febrile illness)', kind: 'primary' }],
      prescription: [tablet('Paracetamol', '500 mg', '1-1-1 (when needed for fever)', 3, 'After food')],
      advice: 'Rest and plenty of oral fluids. Light, easily digestible meals.',
      followUp: 'Review after 3 days or earlier if the fever persists or new symptoms appear.',
    },
  },
  {
    case: 'headache',
    match: /\b(headaches?|head ache|migraine)\b/i,
    rx: {
      diagnoses: [{ description: 'Tension-type headache', kind: 'primary' }],
      prescription: [tablet('Paracetamol', '500 mg', 'When needed (SOS), up to 3 times a day', 3, 'After food')],
      advice: 'Regular sleep and meals, adequate hydration, short breaks from screens.',
      followUp: 'Review after 1 week or earlier if the headache is severe, sudden or comes with other symptoms.',
    },
  },
]

/** The case a text speaks of first (the earliest mention wins: "stomach pain with mild fever" is the stomach case), or null. */
function caseIn(text: string): (typeof CASES)[number] | null {
  let best: { at: number; c: (typeof CASES)[number] } | null = null
  for (const c of CASES) {
    const m = c.match.exec(text)
    if (m && (!best || m.index < best.at)) best = { at: m.index, c }
  }
  return best?.c ?? null
}

/** The demo draft for what the consultation says (each source in turn, most trusted first), or null when it speaks of none of the cases. */
export function demoPrescriptionFor(ctx: DemoContext): DemoPrescription | null {
  for (const text of [ctx.chiefComplaint, ctx.reasonForVisit ?? '', ctx.history, ctx.assessment, ctx.transcript.join(' ')]) {
    const c = text.trim() ? caseIn(text) : null
    if (c) return { case: c.case, ...structuredClone(c.rx) }
  }
  return null
}

/** Whether the draft's prescription is still empty: no diagnosis written and no medicine named (the only time the demo draft fills it). */
export const prescriptionEmpty = (d: Draft) => !d.diagnoses.some((x) => x.description?.trim()) && !d.prescription.some((x) => x.drugName?.trim())

/**
 * The draft with the demo prescription in it: the diagnosis and the medicine (only into an empty prescription), the advice and follow-up only
 * where the doctor wrote none, and the chief complaint from the visit's reason only when the note has none. Anything the doctor wrote stays.
 */
export function applyDemoPrescription(d: Draft, demo: DemoPrescription, reasonForVisit: string | null): Draft {
  if (!prescriptionEmpty(d)) return d
  return {
    ...d,
    note: {
      ...d.note,
      chiefComplaint: d.note.chiefComplaint.trim() ? d.note.chiefComplaint : (reasonForVisit?.trim() ?? ''),
      plan: d.note.plan.trim() ? d.note.plan : demo.advice,
      followUp: d.note.followUp.trim() ? d.note.followUp : demo.followUp,
    },
    diagnoses: demo.diagnoses,
    prescription: demo.prescription,
  }
}

/** The mark that this consultation's draft was filled by the demo rules (this browser tab), so that the prescription page says so. */
const markKey = (encounterId: string) => `adaxai.demo-prescription.${encounterId}`

export function markDemoPrescription(encounterId: string, c: DemoCase): void {
  try {
    sessionStorage.setItem(markKey(encounterId), c)
  } catch {
    // Storage unavailable: the draft is filled all the same; only the notice is not shown.
  }
}

export function demoPrescriptionMark(encounterId: string): DemoCase | null {
  try {
    const v = sessionStorage.getItem(markKey(encounterId))
    return v === 'stomach' || v === 'fever' || v === 'headache' ? v : null
  } catch {
    return null
  }
}
