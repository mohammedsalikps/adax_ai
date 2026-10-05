import {
  type ConsultationContext,
  type ContextConflict,
  type SummarySection,
  EVIDENCE_KINDS,
  EVIDENCE_TRUST,
  type EvidenceItem,
  type EvidenceKind,
  type EvidenceTrust,
  MANA_SOURCE_KINDS,
  type ManaConsultationTopic,
  type ManaSourceItem,
  type ManaSourceKind,
  PENDING_KINDS,
} from '@adaxai/contracts'
import { cap, dayLabel, dayOf, freeText, timeLabel } from './format.ts'
import type { ToolFact, ToolFinding } from './types.ts'

/**
 * D2: the consultation context (consultation-context/build.ts, the read model the consultation's Overview shows) as Mana's facts. Nothing is read here: the
 * tool reads the context for the doctor (tools.ts) and this turns it into the sentences the model may restate, one topic at a time.
 *
 * Each fact says how far it can be trusted, in the screen's own words (EVIDENCE_TRUST: "Entered by staff", "Device reading, unverified", "Recorded, not
 * analysed", "Extracted from the conversation, to review", "AI output, to review", "Fixed rules, not AI", "Reviewed by the doctor"), and carries that trust
 * for the answer checks (answer.ts), which then hold a statement that restates it to it.
 *
 * SIMULATED items are not given to the model at all, not even labelled: a simulator's value is nobody's measurement, and a value in a fact can be restated
 * without its label. The doctor is told, in a finding made by the server, how many there are and where they are shown. Conflicts are findings too (the
 * server shows them, both sides, whatever the model writes; nothing resolves them). What is missing is a fact, in the context's own words.
 *
 * What the patient's consents keep out is not read at all (see `readable`): the thermal images once consent to thermal imaging is withdrawn, the conversation
 * and its important points unless consent to recording and AI assistance is in place for this consultation. A point the doctor rejected is never a fact.
 */

type PendingKind = (typeof PENDING_KINDS)[number]

/** What the patient's consents keep out of what Mana reads of a consultation (the tool reads them, tools.ts). */
export interface Withheld {
  /** The patient withdrew consent to thermal imaging: no thermal image or thermal summary is read (as the patient's record leaves them out, record.ts). */
  thermal: boolean
  /**
   * Consent to recording and AI assistance is not in place for this consultation in its current wording: its conversation and important points are not read
   * (the consultation draft is refused without it, consult/service.ts).
   */
  conversation: boolean
}

/** The most facts one call gives (the same bound as the other tools): the newest first. */
const MAX_FACTS = 24
const FACT_CHARS = 400
/** A thermal image's measurements are one statement (whole image, then each region): it is not cut in the middle of a figure unless it is very long. */
const MEASUREMENT_CHARS = 700

export interface ContextView {
  encounterId: string
  /** The patient's handle in this conversation (P1 ...). */
  alias: string
  /** Replaces the patient's own identifiers, and any telephone or record number, in free text. */
  scrub: (t: string) => string
  timeZone: string
  today: string
  /** The consultation is signed: what it holds is a signed record's. */
  signed: boolean
  /** The reader is the consultation's doctor (its AI draft is shown to that doctor only, so only that doctor's context counts it). */
  isAuthor: boolean
  withheld: Withheld
}

export interface ContextFacts {
  facts: ToolFact[]
  findings: ToolFinding[]
  /** The tool's line in the details: counts and rule versions, never clinical text. */
  detail: string
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const sentence = (s: string) => {
  const t = s.trim()
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

/** "at 10:44 am", and the day too when it is not today (a consultation left open overnight). */
function when(iso: string, v: ContextView): string {
  const d = new Date(iso)
  return dayOf(d, v.timeZone) === v.today ? `at ${timeLabel(d, v.timeZone)}` : `at ${timeLabel(d, v.timeZone)} on ${dayLabel(d, v.timeZone)}`
}

const kindOf = (e: EvidenceItem, v: ContextView): ManaSourceKind => (e.kind === 'vital_staff' || e.kind === 'vital_device' ? 'vital' : v.signed ? 'signed_record' : 'consultation')

/** What the doctor opens for an item: the consultation, with what the item is, its state, its trust and where it came from. */
function sourceItem(e: EvidenceItem, v: ContextView): ManaSourceItem {
  const kind = kindOf(e, v)
  return {
    kind,
    label: [...new Set<string>([MANA_SOURCE_KINDS[kind], EVIDENCE_KINDS[e.kind], `${dayLabel(e.at, v.timeZone)} ${timeLabel(e.at, v.timeZone)}`])].join(' · '),
    date: e.at,
    status: e.status,
    excerpt: cap(v.scrub(`${e.title}${e.detail ? ` (${e.detail})` : ''}; ${EVIDENCE_TRUST[e.trust]}; ${e.source}`), 400),
    link: { to: 'encounter', id: v.encounterId },
  }
}

/** One item as a fact: what it is, how far it can be trusted, its state, when, where it came from, and its detail line. */
function evidenceFact(e: EvidenceItem, v: ContextView): ToolFact {
  const label = EVIDENCE_KINDS[e.kind]
  const what = e.title.toLowerCase().startsWith(label.toLowerCase()) ? e.title : `${label}: ${e.title}`
  const text = `${sentence(what)} ${EVIDENCE_TRUST[e.trust]}. ${e.status}, ${when(e.at, v)}, ${e.source}.${e.detail ? ` ${sentence(e.detail)}` : ''}`
  return { text: freeText(text, FACT_CHARS, v.scrub), patient: v.alias, items: [sourceItem(e, v)], trust: e.trust }
}

const CONVERSATION: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['transcript', 'point'])
const THERMAL: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['thermal', 'thermal_summary'])
/**
 * The conflicts that rest on what was said in the conversation: an important point against the record, allergies talked about with no allergy
 * status; and those that quote the AI draft's statements, which may rest on the conversation's points (the draft's counts stay).
 */
const CONVERSATION_CONFLICTS: ReadonlySet<ContextConflict['kind']> = new Set<ContextConflict['kind']>(['point_vs_record', 'allergy_status', 'draft_conflict'])
/** A statement of the summary that quotes the AI draft's text (what the doctor accepted or edited), which may rest on the conversation's points. */
const quotesDraft = (st: SummarySection['statements'][number]) => st.trust === 'doctor_reviewed' && st.itemIds.some((id) => id.startsWith('ai_draft:'))
/** What waits for review, in words (one, several). */
const PENDING_WORDS: Record<PendingKind, [string, string]> = {
  points: ['important point', 'important points'],
  draftStatements: ['AI draft statement', 'AI draft statements'],
  thermalImages: ['thermal image', 'thermal images'],
  thermalSummaries: ['thermal summary', 'thermal summaries'],
}
const WITHHELD_CONVERSATION =
  'The conversation and its important points, and the words of the AI draft that may rest on them, are not read by Mana: the patient’s consent to consultation recording and AI assistance is not in place for this consultation. The consultation screen shows them.'
const WITHHELD_THERMAL = 'The thermal images of this consultation are not read by Mana: the patient has withdrawn consent to thermal imaging. The consultation screen shows them.'

/** "a", "a or b", "a, b or c" (and with "and"). */
const series = (words: string[], last: 'or' | 'and') => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} ${last} ${words[words.length - 1]!}`)

/**
 * The context as Mana may read it. Left out, with what rests on them (the conflicts, the summary's statements, the counts of what waits):
 *   - a point the doctor rejected (set aside by the doctor: never a fact, whatever the context holds);
 *   - the conversation and its important points, when consent to recording is not in place (also the conflicts that rest on what was said, the
 *     important points that wait, which are then not counted, and the AI draft's words quoted in a conflict or in the summary, since a statement
 *     of the draft may rest on a confirmed point; the draft's counts stay);
 *   - the thermal images and thermal summaries (SIMULATED ones too), when the patient withdrew consent to thermal imaging.
 * `withheld` lists the kinds of what waits that a consent left uncounted, and `notes` says so for the doctor; both only when there was something to leave out.
 */
function readable(c: ConsultationContext, v: ContextView): { c: ConsultationContext; withheld: PendingKind[]; notes: string[] } {
  const rejected = (e: EvidenceItem) => e.kind === 'point' && /^rejected\b/i.test(e.status)
  const kept = (e: EvidenceItem) => !rejected(e) && !(v.withheld.conversation && CONVERSATION.has(e.kind)) && !(v.withheld.thermal && THERMAL.has(e.kind))
  const gone = new Set(c.evidence.filter((e) => !kept(e)).map((e) => e.id))
  const restsOnGone = (ids: string[]) => ids.some((id) => gone.has(id))
  const withheld: PendingKind[] = []
  const notes: string[] = []
  const pending = { ...c.pending }
  const holds = (kinds: ReadonlySet<EvidenceKind>) => c.evidence.some((e) => kinds.has(e.kind))
  const quotedDraft = c.summary.sections.some((s) => s.statements.some(quotesDraft))
  if (v.withheld.conversation && (holds(CONVERSATION) || c.pending.points > 0 || quotedDraft || c.conflicts.some((x) => CONVERSATION_CONFLICTS.has(x.kind)))) {
    pending.points = 0
    withheld.push('points')
    notes.push(WITHHELD_CONVERSATION)
  }
  if (v.withheld.thermal && (holds(THERMAL) || c.pending.thermalImages > 0 || c.pending.thermalSummaries > 0)) {
    pending.thermalImages = 0
    pending.thermalSummaries = 0
    withheld.push('thermalImages', 'thermalSummaries')
    notes.push(WITHHELD_THERMAL)
  }
  return {
    c: {
      ...c,
      evidence: c.evidence.filter(kept),
      conflicts: c.conflicts.filter((x) => !restsOnGone(x.itemIds) && !(v.withheld.conversation && CONVERSATION_CONFLICTS.has(x.kind))),
      summary: { ...c.summary, sections: c.summary.sections.map((s) => ({ ...s, statements: s.statements.filter((st) => !restsOnGone(st.itemIds) && !(v.withheld.conversation && quotesDraft(st))) })) },
      pending,
    },
    withheld,
    notes,
  }
}

/**
 * The context as Mana's facts for one topic (of what it may read, `readable`):
 *   consultation_recorded  every item that is not SIMULATED (newest first, at most MAX_FACTS), with its trust;
 *   consultation_review    what waits for the doctor (counts), and the records that disagree (findings);
 *   consultation_missing   what a consultation usually has and this one does not (the context's own lines);
 *   consultation_thermal   the measurements of the approved thermal images that are not SIMULATED (the summary's statements), and the thermal items.
 */
export function contextFacts(context: ConsultationContext, topic: ManaConsultationTopic, v: ContextView): ContextFacts {
  const { c, withheld, notes } = readable(context, v)
  const byId = new Map(c.evidence.map((e) => [e.id, e]))
  const itemsOf = (ids: string[]) => ids.flatMap((id) => (byId.has(id) ? [sourceItem(byId.get(id)!, v)] : [])).slice(0, 6)
  const real = c.evidence.filter((e) => e.trust !== 'simulated')
  const simulated = c.evidence.filter((e) => e.trust === 'simulated')
  const facts: ToolFact[] = []
  const findings: ToolFinding[] = []

  /** The consultation itself, as what a statement made by the rules about it rests on (the doctor opens the consultation). */
  const kind: ManaSourceKind = v.signed ? 'signed_record' : 'consultation'
  const consultationItem = (text: string): ManaSourceItem => ({ kind, label: `${MANA_SOURCE_KINDS[kind]} · consultation context (${c.rules.summary})`, date: c.generatedAt, status: null, excerpt: cap(v.scrub(text), 400), link: { to: 'encounter', id: v.encounterId } })
  const ruled = (text: string, items: ManaSourceItem[] = [], trust: EvidenceTrust = 'rule_output'): ToolFact => {
    const t = freeText(`${sentence(text)} ${EVIDENCE_TRUST[trust]}.`, FACT_CHARS, v.scrub)
    return { text: t, patient: v.alias, items: items.length ? items : [consultationItem(t)], trust }
  }
  const absent = (text: string): ToolFinding => ({ kind: 'absent', text: freeText(text, 400, v.scrub), items: [] })
  const conflicts = (): ToolFinding[] => c.conflicts.map((x) => ({ kind: 'conflict', text: freeText(`Found by fixed rules (${x.rule}), not resolved: ${x.text}`, 400, v.scrub), items: itemsOf(x.itemIds) }))
  const leftOut = (list: EvidenceItem[], what = 'item'): ToolFinding[] =>
    list.length ? [absent(`${plural(list.length, `SIMULATED ${what} is`, `SIMULATED ${what}s are`)} in this consultation (made by a simulator, not measurements). Mana does not use ${list.length === 1 ? 'it' : 'them'}; the consultation screen shows ${list.length === 1 ? 'it' : 'them'}, marked SIMULATED.`)] : []
  const unread = c.missing.filter((m) => /could not be (?:read|compared) just now/.test(m))
  const hidden = v.isAuthor ? [] : [absent('The AI draft of this consultation is shown to its doctor only, so it is not part of what Mana read.')]
  const keptOut = notes.map(absent)

  switch (topic) {
    case 'consultation_recorded': {
      const shown = real.slice(0, MAX_FACTS)
      facts.push(...shown.map((e) => evidenceFact(e, v)))
      if (real.length > shown.length) findings.push(absent(`Only the newest ${MAX_FACTS} of the ${real.length} items of this consultation are given here; the consultation screen shows them all.`))
      if (!real.length && !unread.length && !withheld.length) findings.push(absent(simulated.length ? 'Nothing but SIMULATED items is recorded in this consultation yet.' : 'Nothing is recorded in this consultation yet.'))
      findings.push(...conflicts(), ...leftOut(simulated), ...unread.map(absent), ...keptOut, ...hidden)
      break
    }
    case 'consultation_review': {
      const p = c.pending
      const waiting = (k: EvidenceItem['kind'], status: (s: string) => boolean) => c.evidence.filter((e) => e.kind === k && status(e.status))
      const simulatedOf = (list: EvidenceItem[]) => list.filter((e) => e.trust === 'simulated').length
      const ofThem = (n: number) => (n ? ` (${n} of them SIMULATED)` : '')
      // A point not yet decided is one the doctor has not reviewed (a rejected one is not here at all: `readable`).
      const points = c.evidence.filter((e) => e.kind === 'point' && e.trust !== 'doctor_reviewed')
      const draft = waiting('ai_draft', (s) => s === 'To review')
      const images = waiting('thermal', (s) => s.endsWith('Draft'))
      const summaries = waiting('thermal_summary', (s) => s.endsWith('To review'))
      if (p.points) facts.push(ruled(`To review: ${plural(p.points, 'important point', 'important points')} extracted from the conversation, not yet decided by the doctor`, itemsOf(points.map((e) => e.id))))
      if (p.draftStatements) facts.push(ruled(`To review: ${plural(p.draftStatements, 'AI draft statement', 'AI draft statements')}, not yet decided by the doctor`, itemsOf(draft.map((e) => e.id))))
      if (p.thermalImages) facts.push(ruled(`To review: ${plural(p.thermalImages, 'thermal image', 'thermal images')}, not yet approved or rejected${ofThem(simulatedOf(images))}`, itemsOf(images.map((e) => e.id))))
      if (p.thermalSummaries) facts.push(ruled(`To review: ${plural(p.thermalSummaries, 'thermal summary', 'thermal summaries')}, not yet decided by the doctor${ofThem(simulatedOf(summaries))}`, itemsOf(summaries.map((e) => e.id))))
      // That nothing waits is said only of what was counted. A kind that could not be read (`pending.unread`) has a count of 0 that says nothing: then no kind
      // is said to have nothing waiting, and the doctor is told which could not be read. A kind a consent kept out is not named (its note says why), nor the AI
      // draft for anyone but its doctor (shown to that doctor only: `hidden`).
      const notShown = (k: PendingKind) => k === 'draftStatements' && !v.isAuthor
      const failed = PENDING_KINDS.filter((k) => p.unread.includes(k) && !notShown(k) && !withheld.includes(k))
      const counted = PENDING_KINDS.filter((k) => !notShown(k) && !withheld.includes(k) && !failed.includes(k))
      if (failed.length) findings.push(absent(`What waits for review is not known for the ${series(failed.map((k) => PENDING_WORDS[k][1]), 'and')} of this consultation: they could not be read just now.`))
      else if (counted.length && counted.every((k) => !p[k])) facts.push(ruled(`No ${series(counted.map((k) => PENDING_WORDS[k][0]), 'or')} of this consultation waits for review`))
      if (c.conflicts.length) facts.push(ruled(`Records of this consultation that disagree, found by fixed rules and not resolved: ${c.conflicts.length}`, c.conflicts.flatMap((x) => itemsOf(x.itemIds)).slice(0, 6)))
      findings.push(...conflicts(), ...unread.map(absent), ...keptOut, ...hidden)
      break
    }
    case 'consultation_missing': {
      for (const m of c.missing) facts.push(ruled(m))
      if (!c.missing.length) facts.push(ruled('The fixed rules found nothing missing in this consultation'))
      findings.push(...hidden)
      break
    }
    case 'consultation_thermal': {
      // Kept out by the patient's withdrawal of consent to thermal imaging: the note says so, and nothing is said of what there is or is not.
      if (withheld.includes('thermalImages')) {
        findings.push(absent(WITHHELD_THERMAL))
        break
      }
      const thermal = real.filter((e) => e.kind === 'thermal' || e.kind === 'thermal_summary')
      const images = real.filter((e) => e.kind === 'thermal')
      // The measurements are the summary's own statements: only of an approved image that is not SIMULATED (approval froze them), stated as stored.
      const measured = (c.summary.sections.find((s) => s.key === 'observations')?.statements ?? []).filter((s) => s.trust === 'measured' && s.itemIds.some((id) => byId.get(id)?.kind === 'thermal' && byId.get(id)?.trust === 'measured'))
      for (const s of measured) facts.push({ text: freeText(`${sentence(s.text)} ${EVIDENCE_TRUST.measured}.`, MEASUREMENT_CHARS, v.scrub), patient: v.alias, items: itemsOf(s.itemIds), trust: 'measured' })
      facts.push(...thermal.slice(0, MAX_FACTS - facts.length).map((e) => evidenceFact(e, v)))
      const simulatedThermal = simulated.filter((e) => e.kind === 'thermal' || e.kind === 'thermal_summary')
      if (!images.length) findings.push(absent(simulatedThermal.length ? 'No thermal image of this consultation other than SIMULATED ones.' : (c.missing.find((m) => m.startsWith('No thermal image')) ?? 'No thermal image in this consultation.')))
      else if (!measured.length) findings.push(absent('No thermal image of this consultation is approved yet, so no measurement is stated: measurements are stated only for an approved image.'))
      findings.push(...leftOut(simulatedThermal, 'thermal item'), ...unread.filter((m) => /thermal/i.test(m)).map(absent))
      break
    }
  }
  const detail = `${topic.replace('consultation_', '')}: ${facts.length} fact(s), ${findings.length} finding(s); ${real.length} item(s), ${simulated.length} SIMULATED left out; ${c.conflicts.length} conflict(s), ${c.missing.length} missing; ${c.rules.conflicts}, ${c.rules.summary}`
  return { facts: facts.slice(0, MAX_FACTS), findings, detail }
}
