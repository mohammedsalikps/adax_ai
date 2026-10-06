import {
  CONSULT_NOTE_SECTION,
  type ConsultationAi,
  type ConsultItem,
  type ConsultSection,
  type Encounter,
  NOTE_SECTIONS,
  type NoteFields,
  PRESCRIPTION_DURATION_DAYS_MAX,
  type PrescriptionItemInput,
} from '@adaxai/contracts'
import { fmtDuration } from '../../lib/analysis.ts'
import { structuredDuration } from '../../lib/prescriptionCourse.ts'
import type { HeroStatus } from '../hero/spec.ts'

/*
 * The prescription page's decisions (DESIGN §5.6), pure so they are unit-tested in node (test/prescription.test.ts): the state of the page
 * (draft, signed and to complete, completed), how the AI draft's statements are grouped and where each goes in the note, which actions a
 * statement offers, a medicine's duration (the written words, the number of days and the first day, kept together), the draft's real
 * progress, and the words of the completion toast. No React, no DOM.
 */

// --- the page's state -------------------------------------------------------------------------------------------------------------------------

/**
 * draft: the doctor's own draft, editable; readonly_draft: a draft this person cannot edit now (another doctor's, or paused); signed_to_complete:
 * signed, and this doctor can complete it; signed: signed, not completable by this person; completed: the visit is completed; discarded.
 */
export type RxPageState = 'draft' | 'readonly_draft' | 'signed_to_complete' | 'signed' | 'completed' | 'discarded'

export function rxPageState(e: Pick<Encounter, 'status' | 'canEdit' | 'canComplete' | 'completedAt'> & { visit: Pick<Encounter['visit'], 'status'> }): RxPageState {
  if (e.status === 'discarded') return 'discarded'
  if (e.status === 'signed') {
    if (e.completedAt || e.visit.status === 'completed') return 'completed'
    return e.canComplete ? 'signed_to_complete' : 'signed'
  }
  return e.canEdit ? 'draft' : 'readonly_draft'
}

/**
 * The header's pill: Draft, Signed — to complete, Completed (a discarded draft: Cancelled, said "Discarded"). Signed but not to be completed by
 * this person (another doctor's, or the visit has left the consultation): "Signed" only.
 */
export function rxStatusPill(state: RxPageState): { status: HeroStatus; label?: string } {
  switch (state) {
    case 'draft':
    case 'readonly_draft':
      return { status: 'draft' }
    case 'signed_to_complete':
      return { status: 'signed_to_complete' }
    case 'signed':
      return { status: 'signed_to_complete', label: 'Signed' }
    case 'completed':
      return { status: 'completed' }
    case 'discarded':
      return { status: 'cancelled', label: 'Discarded' }
  }
}

/**
 * How the prescription's note parts (advice and diet, follow-up) are drawn: read as a document (signed, or nothing more can be saved), a field
 * that takes no typing for now (an insertion of reviewed AI text is running: its answer replaces the whole note, so typing meanwhile would be
 * lost), or a field the doctor writes in.
 */
export function noteAreaMode(o: { editable: boolean; locked: boolean; inserting: boolean }): 'document' | 'frozen' | 'editable' {
  if (!o.editable || o.locked) return 'document'
  return o.inserting ? 'frozen' : 'editable'
}

/** The toast after Complete: what changed, and whether the patient can see the prescription (an active portal account with portal consent). */
export function completionToast(patientPortalAccess: boolean): string {
  return `Consultation completed · Patient record updated · ${patientPortalAccess ? 'Prescription available to the patient' : 'The patient has no portal access'}`
}

// --- the clinical summary: the AI draft's statements ------------------------------------------------------------------------------------------

export type SummaryGroupKey = 'presenting' | 'history' | 'findings' | 'considerations' | 'missing'

/** The groups of the clinical summary, in reading order (the record's allergies and vitals are shown with them, from the record). */
export const SUMMARY_GROUPS: readonly { key: SummaryGroupKey; title: string; sections: readonly ConsultSection[] }[] = [
  { key: 'presenting', title: 'Symptoms & presenting problem', sections: ['summary', 'presenting_problem', 'symptoms'] },
  { key: 'history', title: 'Relevant history', sections: ['relevant_history', 'medications', 'allergies'] },
  { key: 'findings', title: 'Findings & observations', sections: ['observations'] },
  { key: 'considerations', title: 'Considerations', sections: ['potential_considerations', 'potential_investigations', 'potential_medication_considerations'] },
  { key: 'missing', title: 'Missing information', sections: ['missing_information', 'uncertainties'] },
]

/** The statements of each group, in the order of the group's sections, then the model's order. Every section belongs to exactly one group. */
export function groupStatements(items: readonly ConsultItem[]): Record<SummaryGroupKey, ConsultItem[]> {
  const out = { presenting: [], history: [], findings: [], considerations: [], missing: [] } as Record<SummaryGroupKey, ConsultItem[]>
  for (const g of SUMMARY_GROUPS) {
    out[g.key] = items.filter((i) => g.sections.includes(i.section)).sort((a, b) => g.sections.indexOf(a.section) - g.sections.indexOf(b.section) || a.position - b.position)
  }
  return out
}

/** Where a statement goes in the note by default (the contract's CONSULT_NOTE_SECTION); null: a comment on the record, never note text. */
export const defaultNoteSection = (section: ConsultSection): keyof NoteFields | null => CONSULT_NOTE_SECTION[section]

/**
 * The note sections a statement may be added to: a medication consideration only to the Plan (never the prescription), a comment on the record
 * nowhere, anything else to any section (the default first).
 */
export function noteSectionChoices(section: ConsultSection): (keyof NoteFields)[] {
  const fit = defaultNoteSection(section)
  if (fit === null) return []
  if (section === 'potential_medication_considerations') return ['plan']
  return [fit, ...NOTE_SECTIONS.map((s) => s.key).filter((k) => k !== fit)]
}

/** The label of a note section ("Examination"). */
export const noteSectionLabel = (key: keyof NoteFields): string => NOTE_SECTIONS.find((s) => s.key === key)?.label ?? key

/**
 * What a statement offers the doctor now. Pending: [Add to note] (accept, then the recorded insertion: one act), [Edit] (accept the edited
 * words, then insert them), [Remove] (reject); a comment on the record: [Remove] only. Accepted elsewhere but not in the note yet: [Add to
 * note] (the insertion only). In the note, or removed: nothing more. `tick`: the server asks for "I have checked this" before accepting.
 * Nothing is offered when the consultation cannot be edited.
 */
export interface StatementActions {
  add: boolean
  edit: boolean
  remove: boolean
  tick: boolean
  state: 'pending' | 'accepted' | 'in_note' | 'removed'
}

export function statementActions(item: Pick<ConsultItem, 'section' | 'decision' | 'inNote' | 'needsConfirmation'>, o: { editable: boolean; inserted?: boolean }): StatementActions {
  const insertable = defaultNoteSection(item.section) !== null
  const inNote = item.inNote || !!o.inserted
  const state: StatementActions['state'] = item.decision === 'rejected' ? 'removed' : inNote ? 'in_note' : item.decision === 'pending' ? 'pending' : 'accepted'
  const none = { add: false, edit: false, remove: false, tick: false, state }
  if (!o.editable || state === 'removed' || state === 'in_note') return none
  if (state === 'accepted') return { ...none, add: insertable }
  return { add: insertable, edit: insertable, remove: true, tick: item.needsConfirmation && insertable, state }
}

/** The clinical summary as the page can show it now, from the consultation's AI state. */
export type SummaryView =
  | { kind: 'unread' }
  | { kind: 'unavailable' }
  | { kind: 'none'; canGenerate: boolean }
  | { kind: 'generating'; phase: 'queued' | 'running' | null }
  | { kind: 'ended'; status: 'failed' | 'cancelled' | 'unavailable'; canGenerate: boolean }
  | { kind: 'insufficient' }
  | { kind: 'shown'; items: ConsultItem[]; stale: boolean; partial: boolean }

export function summaryView(ai: Pick<ConsultationAi, 'status' | 'draft' | 'canGenerate'> | null | undefined): SummaryView {
  if (!ai) return { kind: 'unread' }
  const d = ai.draft
  if (d?.status === 'generating') return { kind: 'generating', phase: d.phase }
  if (d && (d.status === 'ready' || d.status === 'partial')) {
    if (d.insufficient) return { kind: 'insufficient' }
    return { kind: 'shown', items: d.items, stale: d.stale, partial: d.status === 'partial' }
  }
  // No draft with statements: when the model cannot be asked, the doctor writes the prescription without a summary.
  if (!ai.status.available) return { kind: 'unavailable' }
  if (!d) return { kind: 'none', canGenerate: ai.canGenerate }
  return { kind: 'ended', status: d.status as 'failed' | 'cancelled' | 'unavailable', canGenerate: ai.canGenerate }
}

/** What a screen reader hears while the model writes: the same words throughout (the clock and the token count beside it are not announced). */
export const PROGRESS_ANNOUNCEMENT = 'Mana is consolidating the consultation…'

/** The model's real progress while it writes: "812 tokens · 0:21" (tokens as the model server counted them, time since its turn came). */
export function draftProgressText(d: { progress: { generatedTokens: number; startedAt: string } | null; startedAt: string | null; createdAt: string }, now: number): string {
  const since = Date.parse(d.progress?.startedAt ?? d.startedAt ?? d.createdAt)
  const elapsed = fmtDuration(Math.max(0, now - since)) ?? '0:00'
  if (!d.progress) return d.startedAt ? `Reading the record · ${elapsed}` : `Waiting for the local model · ${elapsed}`
  const n = d.progress.generatedTokens
  return `${n} ${n === 1 ? 'token' : 'tokens'} · ${elapsed}`
}

// --- a medicine's duration ----------------------------------------------------------------------------------------------------------------------

/** Ready-made durations offered while typing (any other words may be written). */
export const DURATION_PRESETS = ['3 days', '5 days', '7 days', '10 days', '14 days', '1 month', 'When needed (SOS)', 'Until review'] as const

/** "1 day", "5 days". */
export const durationText = (days: number): string => `${days} ${days === 1 ? 'day' : 'days'}`

/**
 * The number of days the written duration says, when it says one exactly: "5", "5 days", "5 d", "1 week", "2 weeks". Null for anything else
 * ("When needed (SOS)", "Until review", "1 month": a month is not a fixed number of days), and outside 1 to 3650 days.
 */
export function daysFromText(text: string): number | null {
  const t = text.trim().toLowerCase()
  const m = /^(\d{1,4})\s*(days?|d|weeks?|wks?|w)?$/.exec(t)
  if (!m) return null
  const n = Number(m[1]) * (m[2] && m[2].startsWith('w') ? 7 : 1)
  return n >= 1 && n <= PRESCRIPTION_DURATION_DAYS_MAX ? n : null
}

/**
 * The medicine with its duration as written, and the course that goes with it: the number of days when the words say one (the first day is
 * kept; when none is set the server stores the consultation's date), else no course (durationDays and startDate null: when needed, until
 * review). Both are always written together, so the saved course never disagrees with the words.
 */
export function withDurationText<T extends PrescriptionItemInput>(item: T, text: string): T {
  const days = daysFromText(text)
  return { ...item, duration: text, durationDays: days, startDate: days === null ? null : (item.startDate ?? null) }
}

/** When the field is left: a bare number becomes "5 days" (the course is unchanged); other words are kept as written, trimmed. */
export function settleDurationText<T extends PrescriptionItemInput>(item: T): T {
  const text = (item.duration ?? '').trim()
  const days = daysFromText(text)
  return withDurationText(item, days !== null && /^\d+$/.test(text) ? durationText(days) : text)
}

/** The medicine as leaving its duration field leaves it, or null when that changes nothing (so tabbing through saves nothing). */
export function settledDuration<T extends PrescriptionItemInput>(item: T): T | null {
  const s = settleDurationText(item)
  const same = (s.duration ?? '') === (item.duration ?? '') && (s.durationDays ?? null) === (item.durationDays ?? null) && (s.startDate ?? null) === (item.startDate ?? null)
  return same ? null : s
}

/**
 * Stable keys for the medicine rows (a row's own state, such as an open "Change start", stays with its medicine): each row keeps its key, a
 * row added at the end gets a new one, and a removed row's key goes with it.
 */
export class RowKeys {
  private keys: number[] = []
  private next = 0
  /** The keys of `length` rows (a list changed elsewhere: rows added at the end get new keys, rows gone from the end lose theirs). */
  of(length: number): readonly number[] {
    while (this.keys.length < length) this.keys.push(this.next++)
    if (this.keys.length > length) this.keys.length = length
    return this.keys
  }
  /** Row `i` is being removed. */
  remove(i: number): void {
    this.keys.splice(i, 1)
  }
}

// --- the fixed rules' allergy name check --------------------------------------------------------------------------------------------------------

/** After a saved change to the medicines, the check runs this long after the last one (typing a name saves several times). */
export const ALLERGY_CHECK_DEBOUNCE_MS = 800

/** What the allergy name check reads of the prescription: the medicines' names (trimmed, any case, any order). '' when none is named. */
export function medicinesKey(items: readonly Pick<PrescriptionItemInput, 'drugName'>[]): string {
  return items
    .map((p) => (p.drugName ?? '').trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('\n')
}

/** The fixed rules' newest run on the server, as PrescriptionAiLane's allergyCheck reads it (null: not read). */
type ServerCheck = { state: 'not_run' } | { state: 'running' } | { state: 'failed'; message: string } | { state: 'done'; at: string; matches: { id: string; text: string; finalText: string | null }[] } | null

/**
 * The allergy name check as the prescription page says it. It speaks of the medicines as they are only when this page's last check was asked
 * for exactly those (written, saved and checked); otherwise it says the medicines are not checked, never that nothing matched.
 * - `none`: no medicine is named, nothing to check;
 * - `checking`: a check is under way;
 * - `unchecked`: not checked for the medicines as they are (`ever`: whether the rules have run in this consultation at all);
 * - `not_run_failed`: this page asked for a check of these medicines and the request failed (its words);
 * - `failed`: the rules ran and failed; `unread`: their result could not be read; `done`: the result, with its matches.
 */
export type AllergyCheckView =
  | { state: 'none' }
  | { state: 'checking' }
  | { state: 'unchecked'; ever: boolean }
  | { state: 'not_run_failed'; message: string }
  | { state: 'failed'; message: string }
  | { state: 'unread' }
  | { state: 'done'; at: string; matches: { id: string; text: string; finalText: string | null }[] }

export function allergyCheckView(o: {
  /** The medicines as written now (medicinesKey), saved or not. */
  draftKey: string
  /** The medicines this page's last answered check was asked for (null: none on this page). */
  checkedKey: string | null
  /** A check is under way. */
  checking: boolean
  /** This page's last check request that failed, and for which medicines. */
  failed: { key: string; message: string } | null
  server: ServerCheck
}): AllergyCheckView {
  if (!o.draftKey) return { state: 'none' }
  if (o.checking) return { state: 'checking' }
  if (o.checkedKey !== o.draftKey) {
    if (o.failed?.key === o.draftKey) return { state: 'not_run_failed', message: o.failed.message }
    return { state: 'unchecked', ever: o.checkedKey !== null || (o.server !== null && o.server.state !== 'not_run') }
  }
  if (!o.server) return { state: 'unread' }
  if (o.server.state === 'running') return { state: 'checking' }
  if (o.server.state === 'failed') return { state: 'failed', message: o.server.message }
  if (o.server.state === 'not_run') return { state: 'unchecked', ever: false }
  return { state: 'done', at: o.server.at, matches: o.server.matches }
}

/** What Review and sign says of the check before the doctor signs: a match, or that the medicines are not checked (and why); null when clear. */
export function allergyReviewNote(v: AllergyCheckView): { tone: 'error' | 'warning'; text: string } | null {
  const yourself = 'Check the medicines against the recorded allergies yourself before signing.'
  switch (v.state) {
    case 'none':
      return null
    case 'done':
      return v.matches.length ? { tone: 'error', text: `The allergy name check found: ${v.matches.map((m) => m.finalText ?? m.text).join(' ')}` } : null
    case 'not_run_failed':
    case 'failed':
      return { tone: 'warning', text: `The allergy name check could not be run: ${v.message} ${yourself}` }
    case 'unread':
      return { tone: 'warning', text: `The allergy name check’s result could not be read. ${yourself}` }
    case 'checking':
    case 'unchecked':
      return { tone: 'warning', text: `The allergy name check has not run for the medicines as they are now. ${yourself}` }
  }
}

/** The medicine with its course starting on another day (only a course in days has one). */
export function withStartDate<T extends PrescriptionItemInput>(item: T, date: string | null): T {
  return item.durationDays ? { ...item, startDate: date || null } : { ...item, startDate: null }
}

/** The first day of the course: its own, else the consultation's date (what the server stores when none is sent). Null without a course. */
export const courseStart = (item: Pick<PrescriptionItemInput, 'durationDays' | 'startDate'>, visitDate: string): string | null => (item.durationDays ? (item.startDate ?? visitDate.slice(0, 10)) : null)

/** What the duration cell says under the words: "5 days from 6 Oct 2026", that there is no fixed number of days, or nothing yet. */
export function durationReading(item: Pick<PrescriptionItemInput, 'duration' | 'durationDays' | 'startDate'>, visitDate: string): { kind: 'course' | 'open' | 'empty'; text: string } {
  const start = courseStart(item, visitDate)
  const course = structuredDuration({ durationDays: item.durationDays ?? null, startDate: start })
  if (course) return { kind: 'course', text: course }
  if ((item.duration ?? '').trim()) return { kind: 'open', text: 'No fixed number of days' }
  return { kind: 'empty', text: '' }
}

/** A new, empty medicine row (oral by default, as before). */
export const emptyRx = (): PrescriptionItemInput => ({ drugName: '', strength: '', form: '', dose: '', route: 'Oral', frequency: '', duration: '', instructions: '', durationDays: null, startDate: null })
