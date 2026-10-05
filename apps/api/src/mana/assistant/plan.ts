import { isConsultationTopic, MANA_QUESTIONS, ManaPlan, type ManaQuestion, type ManaToolName, type PlannedCall } from '@adaxai/contracts'
import { neutralise } from '../../ai/llm/neutralise.ts'
import { MANA_PLAN_PROMPT } from '../../ai/prompts.ts'
import type { DbOrTx } from '../../db/client.ts'
import { fullName, type PatientRow } from '../../patients/service.ts'
import { searchPatients } from './entities.ts'

/**
 * Step one of a question: WHAT TO LOOK UP. The model is shown the doctor's words, the date, and the handles of the patients already shown in this
 * conversation (sex and an age band, no name), never a record; it answers with a plan in a fixed form. Nothing it says is run as it stands: the plan is
 * parsed against the contract, every field is cut back to what its tool uses, handles and dates are made to fit, and the server's own checks of the
 * caller's permissions come after that, tool by tool (tools.ts). The model chooses among registered tools; it cannot add one.
 */
export const PLAN_PROMPT = MANA_PLAN_PROMPT
export const PLAN_SCHEMA_VERSION = MANA_PLAN_PROMPT.schemaVersion
// v3 (D2): a call of `consultation_context` is about the current patient and has a consultation topic (the overview when it has none or another one).
export const PLAN_CHECKS_VERSION = 'mana-plan-checks-v3'

/** The most distinct patients one question reads. A question that needs more is a different kind of request than a doctor's work needs. */
export const MAX_PATIENTS_PER_QUESTION = 2

export interface PlanInputs {
  today: string
  weekday: string
  time: string
  /** Whether the conversation was opened for one patient (a consultation or a patient's record): then "current" is that patient. */
  hasCurrentPatient: boolean
  patients: { alias: string; line: string }[]
  focus: string | null
  /** The doctor's earlier questions in this conversation, oldest first. */
  earlier: string[]
  question: string
  /** The system's own words, when it asks the planner to look again (see `suspectPlan`). Fixed texts only: nothing of the doctor's or a record's. */
  nudge?: string | null
}

/** The user message of the planner: the situation, then the question last (nothing the doctor wrote is the last word of the prompt's structure). */
export function renderPlanMessage(i: PlanInputs): string {
  const lines = [
    `TODAY: ${i.today} (${i.weekday}); TIME: ${i.time}`,
    `CURRENT PATIENT: ${i.hasCurrentPatient ? 'yes (the open consultation or patient record; use "current")' : 'none (this conversation is not about one patient)'}`,
    `PATIENTS ALREADY SHOWN: ${i.patients.length ? i.patients.map((p) => `${p.alias} (${neutralise(p.line)})`).join('; ') : 'none yet'}`,
    `FOCUS: ${i.focus ?? 'none'}`,
  ]
  if (i.earlier.length) lines.push('EARLIER QUESTIONS (oldest first):', ...i.earlier.map((q, n) => `${n + 1}. ${neutralise(q).slice(0, 200)}`))
  lines.push('', `QUESTION: ${neutralise(i.question)}`)
  if (i.nudge) lines.push('', `NOTE FROM THE SYSTEM: ${i.nudge}`)
  lines.push('', 'Plan what to look up.')
  return lines.join('\n')
}

const BLANK: Omit<PlannedCall, 'tool'> = { patient: null, topic: null, text: null, which: null, when: null, minutes: null, date: null, mine: null, status: null }
export const blank = (tool: ManaToolName, rest: Partial<PlannedCall> = {}): PlannedCall => ({ tool, ...BLANK, ...rest })

/** The fields each tool reads. The others are cleared from the plan, so that what is stored and audited is what was used. */
export const TOOL_FIELDS: Record<ManaToolName, readonly (keyof PlannedCall)[]> = {
  get_current_context: [],
  find_patient: ['text'],
  get_patient_record: ['patient', 'topic', 'text'],
  get_patient_visits: ['patient'],
  get_consultation: ['patient', 'which', 'date'],
  get_today_queue: ['mine', 'status'],
  get_recent_visits: ['when', 'minutes', 'date', 'mine'],
  get_appointments: ['when', 'minutes', 'date', 'mine'],
  get_my_consultations: ['when', 'date'],
  get_facility_information: [],
  consultation_context: ['patient', 'topic'],
}

/** The tools that read one patient's record (the consultation tool reads the current patient's consultation: the wrong-patient check applies to it too). */
export const PATIENT_TOOLS: ReadonlySet<ManaToolName> = new Set<ManaToolName>(['get_patient_record', 'get_patient_visits', 'get_consultation', 'consultation_context'])

/**
 * The doctor's own words that make a queue or a schedule "mine": my, mine, myself; "to me", "for me", "with me"; and "I" as the one who acts ("I have seen",
 * "have I seen", "I'm"). Not "me" as in "show me who is waiting", and not the Roman numeral in "type I diabetes".
 */
const SAYS_MINE = new RegExp(
  [
    String.raw`\b(?:my|mine|myself)\b`,
    String.raw`\b(?:to|for|with|by|from)\s+me\b`,
    String.raw`\bi['’](?:m|ve|ll|d)\b`,
    String.raw`\b(?:am|was|have|had|did|do|will|shall|should|can|could|would|must)\s+i\b`,
    String.raw`\bi\s+(?:am|was|have|had|did|do|will|shall|should|can|could|would|must|need|want|saw|see|seen|examined|treated|signed|started|finished|completed|discharged|referred|prescribed|ordered|opened|closed)\b`,
  ].join('|'),
  'i',
)
/** What a name handle may be made of: letters, digits (a name such as "Baby 2" or a typed tag), spaces, full stops, apostrophes and hyphens. */
const NAME_CHARS = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{1,59}$/u

// --- what the doctor's own words settle, whatever the model planned ---------------------------------------------------------------------------

/**
 * Verbs that, opening a request, ask for a change in a hospital system and have no ordinary reading as a noun ("Prescribe ...", "Cancel my 3 pm", "Sign this").
 * Followed by a word that makes the sentence a question ABOUT something ("Sign of infection", "Discharge summary of ...", "Cancel in ...") they are reads.
 */
const STRONG_VERBS = 'prescribe|sign|co-?sign|cancel|reschedule|rebook|delete|discard|discharge|approve|submit|forward|amend|e-?mail|discontinue'
/** Verbs that ask for a change only when what follows is something a record holds ("Update the allergy list", "Add a note", "Book an appointment"). "Change in ...", "Update on ...", "Order history", "Issue date", "Mark Thomas" are reads. */
const WEAK_VERBS = 'update|change|edit|modify|add|record|write|enter|create|set|mark|assign|reassign|save|order|schedule|book|issue|send|remove|restore|renew|refill|transfer|merge'
const WRITE_OBJECTS =
  'allerg(?:y|ies)|medicines?|medications?|prescriptions?|doses?|dosage|notes?|diagnos[ei]s|appointments?|visits?|consultations?|orders?|tests?|investigations?|vitals?|results?|referrals?|reminders?|follow[\\s-]?ups?|record|entry|entries|phone(?:\\s+number)?|address|contact|e-?mail|name|date\\s+of\\s+birth|dob|sex|gender|weight|height|details|status|plan|problem\\s+list'
const ABOUT_WORDS = 'of|about|me|us|down|up|out|time|summary|summaries|date|history|list|in|on'
/** How a request may begin: fillers and a name for the assistant, then a way of asking ("can you", "I would like you to", "let's"). */
const LEAD = String.raw`^\s*(?:(?:hey|hi|hello|ok|okay|yes|and|also|then|so|now|just|please|pls|kindly|mana)\b[\s,:-]*)*(?:(?:(?:can|could|would|will)\s+you|(?:can|could|may)\s+i|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to|i['’]d\s+like\s+(?:you\s+)?to|go\s+ahead\s+and|let['’]s)\s+(?:please\s+)?)?`
const DETERMINERS = String.raw`(?:(?:a|an|the|this|that|these|those|her|his|their|my|our|new|another|more|any|some)\s+)*`
/** Where "Add penicillin to her allergies" puts something. */
const LISTS = String.raw`allerg(?:y|ies)|medicines?|medications?|prescriptions?|records?|notes?|charts?|lists?|problem\s+list|history`
/** What "Change Meena Kumar's telephone number" changes: the details and the records of a patient. */
const OF_A_PATIENT = String.raw`phone|telephone|mobile|address|e-?mail|name|date\s+of\s+birth|dob|allerg\w*|medicines?|medications?|prescriptions?|diagnos[ei]s|records?|notes?|details`
/**
 * A request to CHANGE something ("Prescribe amoxicillin for her", "Please sign this", "Can you cancel my 3 pm?", "Update the allergy list"). Only at the start of the
 * request, and only in the forms that cannot be a question about the records: a strong verb, or a weaker one followed by something a record holds. "Change in blood
 * pressure", "Update on Rahul", "Schedule for tomorrow", "Order history", "Issue date of the prescription", "Mark Thomas allergies", "Write-up of ..." are reads.
 * What this does not catch the planner may still call a request to change something; nothing can be written whichever way it goes.
 */
const WRITE_REQUEST = new RegExp(
  String.raw`${LEAD}(?:(?:${STRONG_VERBS})\b(?!\s+(?:${ABOUT_WORDS})\b)|(?:${WEAK_VERBS})\s+${DETERMINERS}(?:${WRITE_OBJECTS})\b(?!\s+(?:history|date|rate)\b)|(?:add|enter|put|append|include)\s+[^.?]{1,60}?\s+(?:to|in|into|on)\s+${DETERMINERS}(?:[a-z'’]+\s+){0,2}?(?:${LISTS})\b|(?:change|update|set|edit|modify|correct)\s+(?!(?:on|in|of|for|about|since)\b)[^.?]{1,40}?['’]s\s+(?:${OF_A_PATIENT})\b)`,
  'i',
)
const WRITE_ANYWHERE = new RegExp(String.raw`\b(?:${STRONG_VERBS}|${WEAK_VERBS}|correct)\b`, 'i')
/**
 * What a doctor's question cannot be answered with: the audit log, other clinics' records, passwords and keys, the system's settings. A plan that reads anything
 * else for these is replaced by the refusal. Only the forms that ASK for them: "another hospital" in a question about a patient's history, a "secret" allergy and a
 * "password reset" visit are about this clinic's own records.
 */
const OUT_OF_SCOPE = new RegExp(
  [
    String.raw`\baudit\s+(?:log|logs|trail|trails|events?)\b`,
    String.raw`\baccess\s+logs?\b`,
    String.raw`\b(?:all|every)\s+(?:the\s+)?(?:clinics|hospitals|facilities)\b`,
    String.raw`\b(?:show|list|give|get|read|open|see|view|pull|fetch|find|search|export)\b[^.?]{0,40}\b(?:other|another|different)\s+(?:clinics?|hospitals?|facilit(?:y|ies)|branch(?:es)?)\b`,
    String.raw`\b(?:other|another|different)\s+(?:clinics?|hospitals?|facilit(?:y|ies)|branch(?:es)?)['’]s?\s+(?:patients?|records?|queue|appointments?|data|schedule)\b`,
    String.raw`\b(?:other|another|different)\s+(?:clinics?|hospitals?|facilit(?:y|ies)|branch(?:es)?)\s+(?:record(?:ed|s)?|hold|holds|have|has|keep|keeps|kept|stor(?:e|es|ed)|say|says|said|know|knows|document(?:ed|s)?|wrote|written)\b`,
    String.raw`\bpatients?\s+(?:of|from|at|in)\s+(?:the\s+)?(?:other|another|different)\s+(?:clinics?|hospitals?|facilit(?:y|ies)|branch(?:es)?)\b`,
    String.raw`\b(?:show|give|tell|reveal|list|print|share|send|dump|export|what(?:['’]s|\s+is|\s+are))\b[^.?]{0,40}\b(?:passwords?|api[\s-]?keys?|secrets?|credentials?)\b`,
    String.raw`\b(?:system|admin(?:istrator)?)\s+(?:settings|panel|console|configuration)\b`,
    String.raw`\bconfiguration\s+(?:file|settings)\b`,
  ].join('|'),
  'i',
)
/** Signals that a refused question was about the clinic's own records. */
const RECORDS_WORDS = /\b(?:queue|waiting\s+room|appointments?|check(?:ed)?[\s-]?ins?|consultations?|departments?|my\s+(?:patients?|day|schedule|list)|today['’]?s\s+patients?)\b/i
const THIS_PATIENT = /\b(?:this|the\s+current|the\s+open)\s+patient\b|\b(?:his|her|their)\s+(?:allerg|medic|prescri|vital|blood|diagnos|history|visit|result|last)/i

/** Whether a request starts by asking for a change (prescribing, signing, cancelling ...). */
export const asksForChange = (question: string): boolean => WRITE_REQUEST.test(neutralise(question))
/** Whether a question asks for what no doctor's question can have (see OUT_OF_SCOPE). */
export const asksForWhatIsNotTheirs = (question: string): boolean => OUT_OF_SCOPE.test(neutralise(question))

/**
 * Cases where a small model's plan does not fit the question and the doctor would be told something false: it refused a question about the records (a
 * named patient, the queue ...), or called something a request to change a record when no change was asked. The caller asks the planner once more, with a
 * fixed note; if the planner then says the same, it stands. Returns the reason, or null.
 */
export function suspectPlan(plan: ManaPlan, question: string, o: { namesPatient: boolean; hasCurrentPatient: boolean }): 'refused_a_records_question' | 'change_not_asked' | 'no_calls' | null {
  const q = neutralise(question)
  if (plan.kind === 'tools') return plan.calls.length ? null : 'no_calls'
  if (plan.kind === 'write_request') return WRITE_ANYWHERE.test(q) ? null : 'change_not_asked'
  if (plan.kind === 'out_of_scope' || plan.kind === 'general_knowledge') {
    if (OUT_OF_SCOPE.test(q) || /\b(?:every|all)\s+(?:the\s+)?patients?\b/i.test(q)) return null
    return o.namesPatient || RECORDS_WORDS.test(q) || (o.hasCurrentPatient && THIS_PATIENT.test(q)) ? 'refused_a_records_question' : null
  }
  return null
}

/** The fixed words the planner is given when it is asked to look again. */
export const NUDGES: Record<NonNullable<ReturnType<typeof suspectPlan>> | 'unusable', string> = {
  refused_a_records_question:
    'Your last plan refused this question. A question that names a patient of this clinic, or that is about the queue, appointments, consultations or departments, is about the clinic’s own records and is answered with tools. Plan again; refuse only if you are sure it is not about the clinic’s records.',
  change_not_asked: 'Your last plan treated this as a request to change something, but nothing in the question asks to change a record. Plan again; use tools if it asks to read something.',
  no_calls: 'Your last plan had no calls. Plan again: choose the tool that reads what the question asks for.',
  unusable: 'Your last answer was not a usable plan. Plan again, in the required form.',
}

/** Makes the model's patient handle one of the four forms the server resolves, or nothing. A bare name is read as a name. */
export function normaliseHandle(h: string | null): string | null {
  if (h === null) return null
  const t = neutralise(h).trim()
  if (!t) return null
  if (/^(?:current|this patient|the patient|current patient|open patient)$/i.test(t)) return 'current'
  const alias = /^P\s?(\d{1,2})$/i.exec(t)
  if (alias) return `P${Number(alias[1])}`
  const mrn = /^mrn[\s:]+(\S.{1,38})$/i.exec(t)
  if (mrn) return `mrn:${mrnForm(mrn[1]!.trim())}`
  const name = /^name\s*:\s*(.+)$/i.exec(t)
  const bare = (name ? name[1]! : t).trim()
  // A pronoun is not a way to name a patient: it would be searched as a name ("He" is a surname). Who "she" is, is for the doctor to say.
  if (/^(?:he|she|him|her|his|hers|they|them|their|it|that patient|same patient|the same patient|the same one)$/i.test(bare)) return null
  // A record number written as a name ("ADX-018631", "adx 018631") is a record number: searched as a name it would not be found, or would find the wrong person.
  if (MRN_SHAPE.test(bare)) return `mrn:${mrnForm(bare)}`
  return NAME_CHARS.test(bare) ? `name:${bare}` : null
}

const MRN_SHAPE = /^[A-Za-z]{2,5}[\s-]?\d{4,}$/
/** A record number in the form the register keeps it (ADX-018631). */
const mrnForm = (s: string): string => s.replace(/^([A-Za-z]{2,5})[\s-]?(\d+)$/, (_m, p: string, d: string) => `${p.toUpperCase()}-${d}`)

/** A calendar date that exists and is within three years of today: a model that writes "2026-02-30" or "1999-01-01" has not read the date. */
function sensibleDate(d: string | null, today: string): string | null {
  if (!d) return null
  const t = Date.parse(`${d}T00:00:00Z`)
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d) return null
  return Math.abs(t - Date.parse(`${today}T00:00:00Z`)) > 3 * 366 * 86_400_000 ? null : d
}

export interface PlanCheck {
  plan: ManaPlan
  /** What of the model's plan was cut or changed, by reason (counts only). */
  adjusted: Record<string, number>
}

const bump = (r: Record<string, number>, k: string) => {
  r[k] = (r[k] ?? 0) + 1
}

/**
 * The model's plan, made safe to run. Returns null when it is not a plan at all. Every call keeps only the fields its tool reads; handles are put in
 * the forms the server resolves; free text is made one clean line; dates must exist; "mine" follows the doctor's own words; duplicates go; and a
 * question cannot read more than MAX_PATIENTS_PER_QUESTION patients. A plan of any kind but "tools" carries no calls.
 */
export function validatePlan(raw: unknown, ctx: { today: string; question?: string }): PlanCheck | null {
  const parsed = ManaPlan.safeParse(raw)
  if (!parsed.success) return null
  const adjusted: Record<string, number> = {}
  const p = parsed.data
  // What the doctor's own words settle is not left to the model: a request for the audit log, another clinic or a password is refused, and a request that
  // opens with a verb of changing something (prescribe, sign, cancel ...) is a request to change something, whatever it planned. Nothing is read for either.
  if (ctx.question !== undefined && p.kind !== 'write_request' && p.kind !== 'out_of_scope') {
    if (asksForWhatIsNotTheirs(ctx.question)) {
      bump(adjusted, 'out_of_scope_forced')
      return { plan: { kind: 'out_of_scope', calls: [], clarification: null }, adjusted }
    }
    if (asksForChange(ctx.question)) {
      bump(adjusted, 'write_request_forced')
      return { plan: { kind: 'write_request', calls: [], clarification: null }, adjusted }
    }
  }
  if (p.kind !== 'tools') {
    if (p.calls.length) bump(adjusted, 'calls_ignored')
    return { plan: { kind: p.kind, calls: [], clarification: p.kind === 'clarify' ? clarificationText(p.clarification) : null }, adjusted }
  }
  const seen = new Set<string>()
  const patients = new Set<string>()
  const calls: PlannedCall[] = []
  for (const c of p.calls) {
    const uses = new Set<keyof PlannedCall>(TOOL_FIELDS[c.tool])
    const out = blank(c.tool)
    if (uses.has('patient')) out.patient = normaliseHandle(c.patient)
    if (uses.has('topic')) out.topic = c.topic
    if (uses.has('text')) out.text = c.text ? neutralise(c.text).slice(0, 120) || null : null
    // A record read has a topic (the briefing when none is named), and words to look for only when the topic is a search: otherwise the words are noise
    // that would make two calls for the same thing look different.
    if (c.tool === 'get_patient_record') {
      out.topic ??= 'briefing'
      if (out.topic !== 'search') out.text = null
    }
    // The consultation tool reads the consultation the conversation was opened in, so its patient is "current" when none is given (another one is refused
    // by the tool), and its topic is one of the consultation's (what was recorded, when it has none or a topic of the record).
    if (c.tool === 'consultation_context') {
      out.patient ??= 'current'
      if (!isConsultationTopic(out.topic)) {
        if (out.topic) bump(adjusted, 'topic_not_for_tool')
        out.topic = 'consultation_recorded'
      }
    }
    // Finding a patient needs the words to find by, and the doctor wrote them: a plan that left them out is completed from the doctor's own question.
    if (c.tool === 'find_patient' && !out.text && ctx.question) {
      out.text = nameWordsIn(ctx.question)
      if (out.text) bump(adjusted, 'find_text_from_question')
    }
    if (uses.has('which')) out.which = c.which
    if (uses.has('when')) out.when = c.when
    if (uses.has('minutes')) out.minutes = c.minutes
    if (uses.has('date')) {
      out.date = sensibleDate(c.date, ctx.today)
      if (c.date && !out.date) bump(adjusted, 'date_not_valid')
    }
    if (uses.has('mine')) {
      // "Mine" is the doctor's own queue or schedule, and it is the doctor's words that say so ("my", "I", "me"); a model that adds or drops it is corrected.
      const says = ctx.question === undefined ? null : SAYS_MINE.test(ctx.question)
      if (says === null) out.mine = c.mine
      else if (c.mine === true && !says) {
        out.mine = false
        bump(adjusted, 'mine_not_asked')
      } else if (c.mine !== true && says) {
        out.mine = true
        bump(adjusted, 'mine_asked')
      } else out.mine = c.mine === true
    }
    if (uses.has('status')) out.status = c.status
    const key = JSON.stringify(out)
    if (seen.has(key)) {
      bump(adjusted, 'duplicate_call')
      continue
    }
    if (PATIENT_TOOLS.has(c.tool)) {
      const who = out.patient ?? '(none)'
      if (!patients.has(who) && patients.size >= MAX_PATIENTS_PER_QUESTION) {
        bump(adjusted, 'too_many_patients')
        continue
      }
      patients.add(who)
    }
    seen.add(key)
    calls.push(out)
  }
  return { plan: { kind: 'tools', calls, clarification: null }, adjusted }
}

const DEFAULT_CLARIFICATION = 'Which patient, or which time, do you mean?'

/**
 * Words a question back to the doctor has no use for. The planner is never shown a record, so anything clinical in what it writes is invented; and a claim that
 * something was done is not a question. A question that has any of them is replaced by the fixed one.
 */
const CLARIFICATION_NOT_ALLOWED =
  /\b(?:allerg\w*|prescri\w*|diagnos\w*|medicin\w*|medicat\w*|dos(?:e|es|age)|mg|tablets?|capsules?|cancel\w*|stop\w*|start\w*|warn\w*|urgent\w*|emergency|signed|delet\w*|updat\w*|ordered|booked|recommend\w*|should|must|result\w*|positive|negative|chest|pain|fever)\b/i

/**
 * A question back to the doctor, written by the model: kept only when it is ONE short question, with no digits (so no figure, handle, record number or telephone
 * number), no link or markup and none of the words above. Anything else is the fixed question. It is not checked against records, because it may not use any.
 */
export function clarificationText(raw: string | null): string {
  if (!raw) return DEFAULT_CLARIFICATION
  const t = neutralise(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*`#_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length < 8 || t.length > 160) return DEFAULT_CLARIFICATION
  if (!/^[A-Z][^.!?\d:;()[\]<>@/\\]+\?$/.test(t)) return DEFAULT_CLARIFICATION
  if (/\b(?:https?|www|ftp|mailto|javascript)\b/i.test(t) || CLARIFICATION_NOT_ALLOWED.test(t) || /\bP\s?\d/i.test(t) || /\b(?:I|we)\s+(?:have|had|will|am|ve)\b/i.test(t)) return DEFAULT_CLARIFICATION
  return t
}

/** The server's own plan for a suggested question: no model is asked what to look up. */
export function suggestionPlan(s: ManaQuestion): ManaPlan {
  const call = ((): PlannedCall => {
    switch (s) {
      case 'brief_current':
        return blank('get_patient_record', { patient: 'current', topic: 'briefing' })
      case 'allergies_current':
        return blank('get_patient_record', { patient: 'current', topic: 'allergies' })
      case 'medicines_current':
        return blank('get_patient_record', { patient: 'current', topic: 'medicines' })
      case 'vitals_current':
        return blank('get_patient_record', { patient: 'current', topic: 'vitals' })
      case 'changes_current':
        return blank('get_patient_record', { patient: 'current', topic: 'changes' })
      case 'visits_current':
        return blank('get_patient_visits', { patient: 'current' })
      case 'queue_mine':
        return blank('get_today_queue', { mine: true })
      case 'appointments_mine':
        return blank('get_appointments', { when: 'today', mine: true })
      case 'my_day':
        return blank('get_my_consultations', { when: 'today' })
      // D2: the consultation the conversation was opened in, through its context (the same read model as the consultation's Overview).
      case 'consultation_recorded':
      case 'consultation_review':
      case 'consultation_missing':
      case 'consultation_thermal':
        return blank('consultation_context', { patient: 'current', topic: s })
    }
  })()
  return { kind: 'tools', calls: [call], clarification: null }
}

export const suggestionLabel = (s: ManaQuestion): string => MANA_QUESTIONS[s].label

// --- the wrong-patient safety net ----------------------------------------------------------------------------------------------------------

const NAME_WORD = /^\p{Lu}[\p{L}'’-]+$/u
/** Capitalised words that open a question and are not names. Only a word that is also in a patient's name matters, so this list is only to spare queries. */
const NOT_NAMES = new Set(
  'what who whom whose when where which how why does did do show tell give list is are was were can could please brief any anyone and but her his the this that today tomorrow yesterday monday tuesday wednesday thursday friday saturday sunday compare summarise summarize find open we i will would should has have had get ask look check in on at it of to be by if as or no so an up us my me he she they you also then now here there yes ok okay hey mana allergies allergy medicines medicine medications vitals history results result visits visit appointments queue schedule diagnosis diagnoses notes note blood last recent latest next previous current summary mrn'.split(' '),
)
/** Titles before a name; the name after one is still a name. */
const TITLES = new Set('mr mrs ms miss master baby shri smt sri'.split(' '))
/** Words that make the name after them a colleague's: "Dr. Kumar" is a doctor of the clinic, not a patient. */
const STAFF = new Set('dr doctor nurse sister prof professor'.split(' '))
const lower = (w: string): string => w.replace(/’/g, "'").toLowerCase()

/**
 * The names a question has in it: runs of capitalised words that are not question words ("What are Rahul Sharma’s allergies?" has the run rahul + sharma;
 * "D'Souza" and "Al-Haddad" are one word each), each as lower-case words, possessive taken off. A name after a title ("Mrs Das") is a name; after "Dr" or
 * "Nurse" it is a colleague's and is left out. At most four runs.
 */
export function nameRunsIn(question: string): string[][] {
  const runs: string[][] = []
  let cur: string[] = []
  let staff = false
  let skip = false
  const close = () => {
    if (cur.length && !skip) runs.push(cur)
    cur = []
    skip = false
  }
  for (const raw of neutralise(question).replace(/[?!.,;:()"“”]/g, ' ').split(/\s+/).filter(Boolean)) {
    const w = raw.replace(/['’]s$/i, '').replace(/^['’]+|['’]+$/g, '')
    const l = lower(w)
    if (STAFF.has(l)) {
      close()
      staff = true
      continue
    }
    if (TITLES.has(l)) continue
    if (NAME_WORD.test(w) && !NOT_NAMES.has(l) && l.length >= 2) {
      if (!cur.length) skip = staff
      cur.push(l)
    } else {
      close()
      staff = false
    }
  }
  close()
  return runs.slice(0, 4)
}

/** The words of a patient's name as a question may write them: each word, and the parts of a word with an apostrophe or a hyphen ("D'Souza": d'souza, souza). */
export function nameTokens(fullName: string): Set<string> {
  const out = new Set<string>()
  for (const t of lower(fullName).split(/\s+/).filter(Boolean)) {
    out.add(t)
    for (const part of t.split(/['-]/)) if (part.length >= 2) out.add(part)
  }
  return out
}

/** Whether a name has EVERY word of a run ("Rahul Sharma" is not the name Rahul Verma, though both have Rahul). */
export const coversRun = (tokens: ReadonlySet<string>, run: readonly string[]): boolean => run.every((w) => tokens.has(w))

/** The name the doctor wrote in a question, as written: the longest run of capitalised words that are not question words ("Do we have a patient called Geeta Menon?" is "Geeta Menon"). */
export function nameWordsIn(question: string): string | null {
  const runs: string[][] = []
  let cur: string[] = []
  for (const w of neutralise(question).replace(/[?!.,;:()"“”]/g, ' ').split(/\s+/).filter(Boolean)) {
    const bare = w.replace(/['’]s$/i, '')
    if (NAME_WORD.test(bare) && !NOT_NAMES.has(lower(bare)) && !TITLES.has(lower(bare)) && !STAFF.has(lower(bare))) cur.push(bare)
    else {
      if (cur.length) runs.push(cur)
      cur = []
    }
  }
  if (cur.length) runs.push(cur)
  // The longest run; of equal ones, the later (the name comes after "Allergies of ...", "Find ...").
  const best = runs.reduce<string[] | undefined>((acc, r) => (!acc || r.length >= acc.length ? r : acc), undefined)
  return best ? best.join(' ').slice(0, 80) : null
}

/** The capitalised words of a question that could be a patient's name (lower case): "Anita’s allergies" has "anita". */
export function nameWordCandidates(question: string): string[] {
  return [...new Set(nameRunsIn(question).flat())].filter((w) => w.length >= 2).slice(0, 8)
}

/** The most patients one name word may bring up as candidates (a very common name brings up the first of them: the doctor is asked to choose, never given a guess). */
const NAMED_PER_WORD = 25

/**
 * The patients of this clinic whose name has a word that a name in the question has (a word of a run, or a part of a word with an apostrophe or a hyphen). The plan
 * chose a patient by a handle; if the doctor wrote another patient's name and the plan is about someone else, the answer would be about the wrong person, so the
 * caller checks the two against each other (with `coversRun`). Whole words only: "Mary" is not "Maryam".
 */
export async function patientsNamedIn(db: DbOrTx, facilityId: string, question: string): Promise<PatientRow[]> {
  const found = new Map<string, PatientRow>()
  for (const w of nameWordCandidates(question)) {
    const query = w.split(/['-]/).filter((x) => x.length >= 2).join(' ')
    if (!query) continue
    for (const p of await searchPatients(db, facilityId, query, NAMED_PER_WORD)) {
      if (nameTokens(fullName(p)).has(w) || w.split(/['-]/).some((x) => x.length >= 2 && nameTokens(fullName(p)).has(x))) found.set(p.id, p)
    }
  }
  return [...found.values()]
}
