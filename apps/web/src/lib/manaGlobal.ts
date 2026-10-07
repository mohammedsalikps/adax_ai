import {
  MANA_QUESTIONS,
  MANA_VOICE_MAX_SECONDS,
  type ManaActionProposal,
  type ManaEntity,
  type ManaMessage,
  type ManaQuestion,
  type PrescriptionItemInput,
} from '@adaxai/contracts'

/**
 * The global Mana's pure rules (DESIGN §5.8), with no DOM and no React so they are unit-tested in node: which conversation a page opens
 * (scoped by the route), which one-tap questions it offers, how a spoken question is recorded and sent, which voices may read answers aloud
 * (only voices on this computer), what is read aloud (only the answer's verified statements), and how a proposed medicine is shown and becomes
 * a row of the draft prescription (the doctor's act, after Approve).
 */

/** What a conversation is about: the consultation (and its patient), a patient's record, or the clinic. Same shape as lib/manaAssistant ManaScope. */
export interface RouteScope {
  encounterId?: string
  patientId?: string
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ENCOUNTER_PAGE = new RegExp(`^/doctor/encounters/(${UUID})(?:/prescription)?/?$`, 'i')
const PATIENT_PAGE = new RegExp(`^/doctor/patients/(${UUID})/?$`, 'i')

/** The consultation workspace and its prescription page: that consultation; the doctor's patient page: that patient; anywhere else: the clinic. */
export function manaScopeForPath(pathname: string): RouteScope {
  const enc = ENCOUNTER_PAGE.exec(pathname)
  if (enc) return { encounterId: enc[1]!.toLowerCase() }
  const pat = PATIENT_PAGE.exec(pathname)
  if (pat) return { patientId: pat[1]!.toLowerCase() }
  return {}
}

/** A stable key for a scope (switching page switches conversation). */
export const scopeKey = (s: RouteScope): string => (s.encounterId ? `encounter:${s.encounterId}` : s.patientId ? `patient:${s.patientId}` : 'clinic')

// --- one-tap questions --------------------------------------------------------------------------------------------------------------------

export interface ManaChip {
  key: string
  /** The words on the button. */
  label: string
  /** The question as it is asked (and recorded). */
  text: string
  /** A suggested question with a plan the server holds (it needs the model to write the answer); absent: a question fixed rules answer. */
  suggestion?: ManaQuestion
  /** Answered by fixed rules: works while the local model is down. */
  rules: boolean
}

/** What Mana is looking at: today's clinic, one patient's record, or one consultation (and its patient). */
export type ManaContextKind = 'clinic' | 'patient' | 'consultation'

/** One group of suggested questions ("About Abdul", "This consultation", "Today's clinic"). */
export interface ManaSuggestionGroup {
  key: 'patient' | 'consultation' | 'clinic'
  title: string
  chips: ManaChip[]
}

/** How a question names the patient, from the record's sex (no guess: "this patient" when it is not male or female). */
export function pronounsFor(sex: string | null | undefined): { he: string; his: string; him: string } {
  if (sex === 'male') return { he: 'he', his: 'his', him: 'him' }
  if (sex === 'female') return { he: 'she', his: 'her', him: 'her' }
  return { he: 'this patient', his: 'this patient’s', him: 'this patient' }
}

/**
 * Premium Mana's suggested questions, grouped by what the conversation is about (the user's design): the patient (history, medicines, allergies,
 * last consultation, labs — fixed rules answer them from the record — and "What should I know before seeing him?", which the local model writes
 * from the record), the consultation (today's consultation by fixed rules; what was recorded and what still needs review, the server's own plans),
 * and today's clinic (next patient, longest wait, how many are waiting, who is in consultation, seen today, pending orders — all fixed rules, the
 * same counts as Home). A question the model must write is not offered while the model is down. The words are the questions as asked.
 */
export function manaSuggestions(o: { kind: ManaContextKind; firstName?: string | null; sex?: string | null; modelAvailable: boolean }): ManaSuggestionGroup[] {
  const p = pronounsFor(o.sex)
  const rules = (key: string, text: string, label = text): ManaChip => ({ key, label, text, rules: true })
  const groups: ManaSuggestionGroup[] = []
  if (o.kind !== 'clinic') {
    const chips: ManaChip[] = [
      rules('history_summary', 'Summarize this patient’s previous history.', 'Summarize this patient’s history'),
      rules('medicines', `What medicines is ${p.he} taking?`),
      rules('allergies', `What are ${p.his} allergies?`),
      rules('last_consultation', `What happened in ${p.his} last consultation?`),
      rules('labs', 'Show recent lab results'),
    ]
    if (o.modelAvailable) chips.push({ key: 'before_seeing', label: `What should I know before seeing ${p.him}?`, text: `What should I know before seeing ${p.him}?`, rules: false })
    groups.push({ key: 'patient', title: o.firstName ? `About ${o.firstName}` : 'About this patient', chips })
  }
  if (o.kind === 'consultation') {
    const chips: ManaChip[] = [rules('today_consultation', 'Summarize today’s consultation')]
    if (o.modelAvailable) {
      chips.push({ key: 'consultation_recorded', label: MANA_QUESTIONS.consultation_recorded.label, text: MANA_QUESTIONS.consultation_recorded.label, suggestion: 'consultation_recorded', rules: false })
      chips.push({ key: 'consultation_review', label: MANA_QUESTIONS.consultation_review.label, text: MANA_QUESTIONS.consultation_review.label, suggestion: 'consultation_review', rules: false })
    }
    groups.push({ key: 'consultation', title: 'This consultation', chips })
  }
  groups.push({
    key: 'clinic',
    title: 'Today’s clinic',
    chips: [
      rules('next_patient', 'Who is my next patient?'),
      rules('waiting_longest', 'Who has waited the longest?'),
      rules('waiting_count', 'How many patients are waiting?'),
      rules('in_consultation', 'Who is currently in consultation?'),
      rules('seen_today', 'How many patients have I seen today?'),
      rules('orders_status', 'Any pending orders?'),
    ],
  })
  return groups
}

/** A question asked from elsewhere (openMana({ask})) that is exactly a suggested question's words is asked as that suggestion (its plan is the server's own). */
export function suggestionFor(text: string, o: { hasPatient: boolean; inConsultation: boolean }): ManaQuestion | undefined {
  const t = text.trim()
  const hit = (Object.entries(MANA_QUESTIONS) as [ManaQuestion, (typeof MANA_QUESTIONS)[ManaQuestion]][]).find(([, q]) => q.label === t)
  if (!hit) return undefined
  const [key, q] = hit
  return (!q.needsPatient || o.hasPatient) && (!q.needsConsultation || o.inConsultation) ? key : undefined
}

// --- a spoken question ----------------------------------------------------------------------------------------------------------------------

/** The longest spoken question: the recorder stops by itself here (the server refuses anything longer). */
export const VOICE_LIMIT_MS = MANA_VOICE_MAX_SECONDS * 1000

/** What the browser is asked to record, best first: types the server accepts (it checks the bytes too). */
export const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'] as const

/** The first type this browser can record, or null (then the microphone button says the browser cannot record). */
export function pickRecorderType(isTypeSupported: (type: string) => boolean): string | null {
  for (const t of RECORDER_TYPES) {
    try {
      if (isTypeSupported(t)) return t
    } catch {
      // A browser that throws for a type does not support it.
    }
  }
  return null
}

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }
/** The type and file name the clip is uploaded with (the codec parameter is the recorder's business, not the upload's). */
export function uploadType(recorderType: string | null | undefined): { type: string; name: string } {
  const base = (recorderType ?? '').split(';')[0]!.trim().toLowerCase()
  const type = EXT[base] ? base : 'audio/webm'
  return { type, name: `mana-question.${EXT[type]}` }
}

/** "0:07 / 0:30": how long the doctor has spoken, against the limit. */
export function voiceClock(ms: number): string {
  const s = Math.max(0, Math.min(MANA_VOICE_MAX_SECONDS, Math.floor(ms / 1000)))
  return `0:${String(s).padStart(2, '0')} / 0:${String(MANA_VOICE_MAX_SECONDS).padStart(2, '0')}`
}

/** Why the microphone could not be used, in words a doctor can act on (the browser's error names). */
export function microphoneProblem(name: string | null | undefined): string {
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The microphone is blocked for this site. Allow it in the browser to speak to Mana. Nothing was recorded.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one and try again.'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone could not be opened (another application may be using it). Nothing was recorded.'
  if (name === 'NotSupportedError') return 'This browser cannot record audio. Type the question instead.'
  return 'The microphone could not be started. Type the question instead.'
}

// --- answers read aloud -----------------------------------------------------------------------------------------------------------------------

/** The part of a speech-synthesis voice this needs (SpeechSynthesisVoice). */
export interface VoiceLike {
  name: string
  lang: string
  localService: boolean
  default?: boolean
}

/**
 * Only voices that run on this computer may read an answer aloud: a network voice ("Google …", Edge's "Online (Natural)") would send the patient's
 * record off the machine. The voice in the configured language first, the system default next.
 */
export function pickLocalVoice<V extends VoiceLike>(voices: readonly V[], lang = 'en'): V | null {
  const local = voices.filter((v) => v.localService === true)
  if (!local.length) return null
  const want = lang.toLowerCase()
  return local.find((v) => v.lang.toLowerCase().startsWith(want) && v.default) ?? local.find((v) => v.lang.toLowerCase().startsWith(want)) ?? local.find((v) => v.default) ?? local[0]!
}

export const NO_LOCAL_VOICE = 'No voice on this computer'

/** A statement with the patients' handles (P1) written as their names, as the screen shows it. */
export function withNames(text: string, entities: readonly Pick<ManaEntity, 'alias' | 'displayName'>[]): string {
  return text.replace(/\bP\d{1,2}\b/g, (a) => entities.find((e) => e.alias === a)?.displayName ?? a)
}

/**
 * What is read aloud for a finished answer: only what the screen shows as Mana's answer (its verified statements, or the fixed notice when it did not
 * answer), never the records behind it, and nothing for an answer that could not be verified beyond saying so. Null: nothing to read.
 */
export function speakableText(m: Pick<ManaMessage, 'status' | 'answer'>): string | null {
  const a = m.answer
  if (m.status === 'unverified') return 'Mana could not safely verify that response.'
  if (!a || (m.status !== 'ready' && m.status !== 'refused')) return null
  const blocks = a.blocks.map((b) => withNames(b.text, a.entities)).join(' ')
  if (a.action) return `${withNames(a.action.summary, a.entities)}. Approve or cancel on the screen.`
  if (blocks) return blocks.slice(0, 1200)
  return a.notice ? withNames(a.notice, a.entities) : null
}

// --- a proposed medicine ------------------------------------------------------------------------------------------------------------------------

/** The proposal's card, line by line (empty parts are left out: nothing is shown that the doctor did not say). */
export function proposalLines(p: Pick<ManaActionProposal, 'item'>): { label: string; value: string }[] {
  const i = p.item
  const lines = [
    { label: 'Medicine', value: [i.drugName, i.strength, i.form].filter(Boolean).join(' · ') },
    { label: 'Dose', value: i.dose },
    { label: 'Frequency', value: i.frequency },
    // The course in days when the words were in weeks ("2 weeks (14 days)"); said once when they were already days.
    { label: 'Duration', value: i.durationDays && i.duration !== `${i.durationDays} day${i.durationDays === 1 ? '' : 's'}` ? `${i.duration} (${i.durationDays} days)` : i.duration },
    { label: 'Route', value: i.route },
    { label: 'Instructions', value: i.instructions },
  ]
  return lines.filter((l) => l.value.trim())
}

/** The row the doctor's screen adds to the unsigned draft after Approve: the proposal's item as a prescription row (the course starts with the consultation). */
export function toPrescriptionItem(p: Pick<ManaActionProposal, 'item'>): PrescriptionItemInput {
  const i = p.item
  return { drugName: i.drugName, strength: i.strength, form: i.form, dose: i.dose, route: i.route, frequency: i.frequency, duration: i.duration, instructions: i.instructions, durationDays: i.durationDays }
}

export const NO_DRAFT_OPEN = 'Open the consultation or the prescription to add it'
