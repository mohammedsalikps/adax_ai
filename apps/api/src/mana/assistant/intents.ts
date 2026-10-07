import { neutralise } from '../../ai/llm/neutralise.ts'

/**
 * Questions Mana answers from the records by FIXED RULES (HERO final): narrow matchers, in the style of the plan checks (plan.ts), for the
 * questions a structured query answers exactly (who is next, how many I have seen, who has waited longest, when a patient arrived, what the
 * nurse recorded, where an order stands, the latest imaging report, allergies), and for one action the doctor can ask for in so many words
 * (adding a fully specified medicine to the open consultation's prescription, as a proposal the doctor approves). Anything these do not
 * recognise goes to the planner as before: they are deliberately narrow, so that a question with another meaning is never answered as one of
 * these. "Who is waiting right now?" is NOT one of them (it stays a question for the planner).
 *
 * Nothing here reads the database: the composers (rules.ts) do, with the caller's permissions and the patients' consents.
 */
export const RULES_VERSION = 'mana-rules-v1'

/** Who a question is about. `arrived`: "the patient who arrived an hour ago", found among today's check-ins. */
export type PatientRef = { by: 'current' } | { by: 'name'; name: string } | { by: 'alias'; alias: string } | { by: 'arrived'; minutes: number } | { by: 'none' }

/** The record topics a fixed-rule question may ask for (the record tool's own topics). */
export type RecordTopic = 'history' | 'medicines' | 'investigations' | 'diagnoses'
export type ImagingModality = 'mri' | 'ct' | 'xray' | 'ultrasound'
export type OrdersAsk = 'ready' | 'received' | 'pending'

export type RulesIntent =
  | { kind: 'next_patient' }
  | { kind: 'seen_today' }
  | { kind: 'waiting_longest'; mine: boolean }
  | { kind: 'arrival_time'; who: PatientRef }
  | { kind: 'nurse_triage'; who: PatientRef }
  | { kind: 'orders'; who: PatientRef; ask: OrdersAsk; service: string | null }
  | { kind: 'imaging'; who: PatientRef; modality: ImagingModality }
  | { kind: 'allergies'; who: PatientRef }
  // Jury polish: the patient's record answered by the record's own fixed rules (no model), and two small readers.
  | { kind: 'record_topic'; who: PatientRef; topic: RecordTopic }
  | { kind: 'last_consultation'; who: PatientRef }
  | { kind: 'surgeries'; who: PatientRef }
  | { kind: 'today_consultation' }
  | { kind: 'add_medicine'; command: PrescriptionCommand }

export type RulesIntentKind = RulesIntent['kind']

// --- the doctor's words, made comparable ------------------------------------------------------------------------------------------------

/** How a request may begin (a name for the assistant, fillers, a polite "can you"), and the punctuation at its end: taken off before matching. */
const LEAD = /^(?:(?:hey|hi|hello|ok|okay|so|now|please|pls|kindly|mana)\b[\s,:;.!-]*)+/i
const ASKING = /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:tell\s+me\s+|check\s+|say\s+)?|(?:please\s+)?tell\s+me\s+|i\s+(?:want|need|would\s+like)\s+to\s+know\s+)/i

export function cleanQuestion(text: string): string {
  let t = neutralise(text)
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  t = t.replace(LEAD, '').replace(ASKING, '')
  return t.replace(/[\s?.!]+$/, '').trim()
}

// --- who the question is about ----------------------------------------------------------------------------------------------------------

const CURRENT_WORDS = /^(?:(?:this|the|current|open|present)\s+patient|the\s+current\s+one|she|he|her|him|them|they)$/i
/** What a name in a question may be made of: letters (any script), digits, spaces, full stops, apostrophes and hyphens; at most five words. */
const NAME = /^\p{L}[\p{L}\p{N} .'-]{1,59}$/u
const NOT_A_NAME = /^(?:a|an|the|this|that|my|your|our|his|her|their|someone|somebody|anyone|anybody|everyone|everybody|nobody|patient|patients|it|we|you|i|me|who|which|what)\b/i
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fortyfive: 45, fifty: 50, sixty: 60, ninety: 90 }
/** "the patient who arrived (about) an hour ago", "the one who came in 30 minutes ago", "the patient who checked in half an hour ago". */
const ARRIVED = /^the\s+(?:patient|one|person|lady|man|woman|gentleman|child)\s+(?:who|that)\s+(?:arrived|came\s+in|came|checked\s+in|walked\s+in|registered)\s+(?:about\s+|around\s+|roughly\s+|some\s+|nearly\s+|almost\s+)?(half\s+an\s+hour|an?\s+hour\s+and\s+a\s+half|[a-z0-9-]+(?:\s+and\s+a\s+half)?\s+(?:hours?|hrs?|minutes?|mins?))\s+ago$/i

function amountOf(words: string): number | null {
  const w = words.toLowerCase().trim()
  if (w === 'half an hour') return 30
  if (/^an?\s+hour\s+and\s+a\s+half$/.test(w)) return 90
  const m = /^([a-z0-9-]+)(\s+and\s+a\s+half)?\s+(hours?|hrs?|minutes?|mins?)$/.exec(w)
  if (!m) return null
  const n = /^\d{1,4}$/.test(m[1]!) ? Number(m[1]) : (NUMBER_WORDS[m[1]!] ?? null)
  if (n === null || n <= 0) return null
  const hours = m[3]!.startsWith('h')
  const total = (hours ? n * 60 : n) + (m[2] ? (hours ? 30 : 0) : 0)
  return total >= 1 && total <= 24 * 60 ? total : null
}

/** Who a phrase of the question names: the current patient ("this patient", "she"), a handle the conversation showed (P2), a name, or a check-in time. */
export function parseWho(phrase: string | null | undefined): PatientRef {
  const p = (phrase ?? '').trim().replace(/['’]s$/i, '').trim()
  if (!p) return { by: 'none' }
  if (CURRENT_WORDS.test(p)) return { by: 'current' }
  const alias = /^P\s?(\d{1,2})$/i.exec(p)
  if (alias) return { by: 'alias', alias: `P${Number(alias[1])}` }
  const arrived = ARRIVED.exec(p)
  if (arrived) {
    const minutes = amountOf(arrived[1]!)
    return minutes === null ? { by: 'none' } : { by: 'arrived', minutes }
  }
  const name = p.replace(/^(?:patient|mr\.?|mrs\.?|ms\.?|miss|master|baby|shri|smt\.?)\s+/i, '').trim()
  if (NAME.test(name) && !NOT_A_NAME.test(name) && name.split(/\s+/).length <= 5) return { by: 'name', name }
  return { by: 'none' }
}

/** A patient named at the start ("The patient who arrived one hour ago — is the lab report ready?", "For Anita Das, is the CBC ready?") and the rest of the question. */
function splitLeadingPatient(t: string): { who: PatientRef; rest: string } | null {
  const m = /^(the\s+(?:patient|one|person|lady|man|woman|gentleman|child)\s+(?:who|that)\s+.+?\s+ago)\s*[,:;—–-]+\s*(.+)$/i.exec(t) ?? /^for\s+(.+?)\s*[,:;—–-]+\s*(.+)$/i.exec(t)
  if (!m) return null
  const who = parseWho(m[1])
  return who.by === 'none' ? null : { who, rest: m[2]!.trim() }
}

// --- the questions --------------------------------------------------------------------------------------------------------------------

const NEXT_PATIENT = [
  /^(?:who(?:'s|\s+is|\s+will\s+be)|which\s+patient\s+is)\s+(?:my\s+|the\s+)?next(?:\s+patient)?(?:\s+(?:for\s+me|today|now))?$/i,
  /^(?:who|which\s+patient)\s+(?:should|do)\s+i\s+see\s+next(?:\s+today)?$/i,
  /^(?:show\s+(?:me\s+)?)?(?:my|the)\s+next\s+patient$/i,
  /^next\s+patient$/i,
]
const SEEN_TODAY = [
  /^how\s+many\s+(?:patients\s+)?(?:have\s+i|did\s+i|i\s+have|i've)\s+(?:seen|see|completed|finished)(?:\s+so\s+far)?\s+today(?:\s+so\s+far)?$/i,
  /^how\s+many\s+patients\s+(?:have\s+)?i\s+(?:seen|saw)\s+today$/i,
]
const WAITING_LONGEST = [
  /^(?:who|which\s+(?:of\s+my\s+)?patients?|which\s+one)\s+(?:has|have)\s+(?:been\s+)?(?:waiting|waited)\s+(?:the\s+)?longest(?:\s+today)?(?:\s+for\s+me)?$/i,
  /^who(?:'s|\s+is)\s+(?:been\s+)?waiting\s+(?:the\s+)?longest(?:\s+today)?(?:\s+for\s+me)?$/i,
  /^(?:my\s+|the\s+)?longest[\s-]+waiting(?:\s+patient)?$/i,
]
const ARRIVAL = [
  /^(?:what\s+time|when|at\s+what\s+time)\s+did\s+(.+?)\s+(?:arrive|check\s*-?\s*in|come\s+in|come|get\s+here|reach)(?:\s+(?:today|here|this\s+morning|this\s+afternoon))?$/i,
  /^(?:what\s+time|when)\s+was\s+(.+?)\s+checked\s+in(?:\s+today)?$/i,
  /^(?:what\s+is|what's)\s+(.+?)'s\s+(?:arrival|check-?\s*in)\s+time$/i,
]
// The patient is named after "for" (or "of"): "about ..." and "on ..." name a topic as often as a patient ("what did the nurse say about the dressing?"),
// and those questions stay with the planner.
const TRIAGE = [
  /^what\s+(?:did|has)\s+(?:the\s+)?(?:triage\s+)?(?:nurse|nursing\s+staff|nurses)\s+(?:note|noted|record|recorded|write|written|wrote|say|said|enter|entered|document|documented)(?:\s+(?:(?:at|during|in)\s+(?:the\s+)?triage|on\s+arrival|at\s+check[\s-]?in))?(?:\s+for\s+(.+?))?$/i,
  /^what\s+was\s+(?:noted|recorded|written|found|done)\s+(?:at|during|in)\s+(?:the\s+)?triage(?:\s+(?:for|of)\s+(.+?))?$/i,
  /^(?:show\s+(?:me\s+)?)?(?:the\s+)?(?:nurse's\s+|nursing\s+)?triage(?:\s+(?:notes?|details|findings|summary|record))?(?:\s+(?:for|of)\s+(.+?))?$/i,
]
const GENERIC_REPORT = /^(?:reports?|results?)$/i
const ORDERS_READY = [
  /^(?:is|are)\s+(?:the\s+|her\s+|his\s+|their\s+|my\s+|this\s+patient's\s+)?(.+?)\s+(?:reports?|results?)\s+(?:ready|available|back|in|out|done)(?:\s+yet)?(?:\s+for\s+(.+?))?$/i,
  /^(?:is|are)\s+(?:the\s+|her\s+|his\s+|their\s+|my\s+)?(?:reports?|results?)\s+(?:ready|available|back|in|out|done)(?:\s+yet)?(?:\s+for\s+(.+?))?$/i,
  /^(?:is|are)\s+(?:the\s+|her\s+|his\s+|their\s+)?(lab|labs|laboratory|tests?|blood\s+tests?|investigations?)\s+(?:ready|done|back)(?:\s+yet)?(?:\s+for\s+(.+?))?$/i,
  /^(?:has|have)\s+(?:the\s+|her\s+|his\s+)?(.+?)\s+(?:reports?|results?)\s+(?:come\s+(?:back|in)|arrived)(?:\s+yet)?(?:\s+for\s+(.+?))?$/i,
]
const ORDERS_RECEIVED = [
  /^(?:did|has)\s+(?:the\s+)?(?:lab|laboratory|imaging|radiology)\s+(?:receive[d]?|get|got|accept(?:ed)?)\s+(?:the\s+|my\s+|her\s+|his\s+|their\s+)?(.+?)\s+(?:request|order)(?:\s+for\s+(.+?))?$/i,
  /^(?:was|has)\s+(?:the\s+|my\s+)?(.+?)\s+(?:request|order)\s+(?:been\s+)?(?:received|sent|placed)(?:\s+for\s+(.+?))?$/i,
]
const ORDERS_PENDING = [
  /^(?:which|what)\s+(?:service\s+|lab\s+|laboratory\s+)?(?:orders|tests|investigations|requests)\s+(?:are\s+)?(?:still\s+)?(?:pending|open|outstanding|waiting)(?:\s+for\s+(.+?))?$/i,
  /^(?:any|are\s+there\s+any)\s+(?:pending|open|outstanding)\s+(?:service\s+|lab\s+)?(?:orders|tests|requests)(?:\s+for\s+(.+?))?$/i,
  /^(?:pending|open)\s+(?:service\s+|lab\s+)?orders(?:\s+for\s+(.+?))?$/i,
  /^(?:what\s+is|what's)\s+the\s+status\s+of\s+(?:the\s+|my\s+)?(?:service\s+|lab\s+)?orders(?:\s+for\s+(.+?))?$/i,
]
const MODALITY = String.raw`(?<modality>mri|mr|ct|ct\s+scan|cat\s+scan|x-?\s?rays?|radiograph|ultrasound|usg|sonography|ultrasonography)`
const IMAGING_DETERMINER = String.raw`(?:the\s+|her\s+|his\s+|their\s+|this\s+patient's\s+|the\s+patient's\s+|(?<owner>.+?)'s\s+)?`
const WHEN_WORD = String.raw`(?:previous|last|latest|recent|most\s+recent|earlier|old|prior)?\s*`
const OF_WHOM = String.raw`(?:\s+(?:of|for|on\s+record\s+for)\s+(?<of>.+?))?`
const IMAGING = [
  new RegExp(String.raw`^(?:summari[sz]e|show(?:\s+me)?|read(?:\s+me)?|open|give\s+me|what\s+is\s+in|what's\s+in|what\s+was\s+in)\s+${IMAGING_DETERMINER}${WHEN_WORD}${MODALITY}(?:\s+(?:reports?|scans?|study|studies|findings|results?|images?))?${OF_WHOM}$`, 'i'),
  new RegExp(String.raw`^what\s+(?:did|does|do)\s+${IMAGING_DETERMINER}${WHEN_WORD}${MODALITY}(?:\s+(?:reports?|scans?|study))?\s+(?:show|say)${OF_WHOM}$`, 'i'),
  new RegExp(String.raw`^(?:is|are)\s+there\s+(?:an?|any)\s+${WHEN_WORD}${MODALITY}(?:\s+(?:reports?|scans?|study|studies|images?))?${OF_WHOM}(?:\s+on\s+record)?$`, 'i'),
]
/** Whose: "his", "her", "this patient's", "the patient's", "Ramesh Kumar's" (or nobody: the current patient). Jury polish. */
const OWNER = String.raw`(?:the\s+|his\s+|her\s+|their\s+|(?:this|the)\s+patient(?:'|’)s\s+|(?<owner>[\p{L}][\p{L}.' -]{0,58}?)(?:'|’)s\s+)?`
const OF_WHO = String.raw`(?:\s+(?:of|for|on\s+record\s+for)\s+(?<of>.+?))?`
/** OWNER without a bare "the": "What are the allergies?" names nobody, and the planner asks which patient. */
const POSSESSIVE = String.raw`(?:his\s+|her\s+|their\s+|(?:this|the)\s+patient(?:'|’)s\s+|(?<owner>[\p{L}][\p{L}.' -]{0,58}?)(?:'|’)s\s+)`
const ALLERGIES_OWNED = [
  new RegExp(String.raw`^(?:what\s+are|show(?:\s+me)?|list|tell\s+me)\s+${POSSESSIVE}(?:known\s+|recorded\s+|drug\s+)?allergies${OF_WHO}$`, 'iu'),
  new RegExp(String.raw`^(?:any|known)\s+allergies${OF_WHO}$`, 'iu'),
  /^what\s+is\s+(?<who>.+?)\s+allergic\s+to$/iu,
]
const MEDICINES = [
  /^what\s+(?:medicines?|medications?|drugs|tablets|pills)\s+(?:is|are|does|do)\s+(?<who>.+?)\s+(?:currently\s+|presently\s+|now\s+|regularly\s+)?(?:taking|take|on|using)(?:\s+(?:now|currently|at\s+present|regularly))?$/iu,
  new RegExp(String.raw`^(?:what\s+are|show(?:\s+me)?|list|tell\s+me)\s+${OWNER}(?:current\s+|active\s+|regular\s+|present\s+)?(?:medicines?|medications?|drugs|medicine\s+list)${OF_WHO}$`, 'iu'),
  new RegExp(String.raw`^(?:current|active|regular)\s+(?:medicines?|medications?)${OF_WHO}$`, 'iu'),
]
const LAST_CONSULTATION = [
  new RegExp(String.raw`^what\s+happened\s+(?:in|during|at)\s+${OWNER}(?:last|previous|most\s+recent|earlier|prior)\s+(?:consultation|visit)${OF_WHO}$`, 'iu'),
  new RegExp(String.raw`^(?:summari[sz]e|show(?:\s+me)?|tell\s+me\s+about|what\s+was)\s+${OWNER}(?:last|previous|most\s+recent|prior)\s+(?:consultation|visit)${OF_WHO}$`, 'iu'),
]
const HISTORY = [
  new RegExp(String.raw`^(?:summari[sz]e|give\s+me\s+(?:a\s+)?summary\s+of|what\s+is|show(?:\s+me)?|tell\s+me)\s+${OWNER}(?:previous\s+|past\s+|medical\s+|clinical\s+|patient\s+)?(?:history|record|records)${OF_WHO}$`, 'iu'),
  /^(?:summari[sz]e|brief\s+me\s+on)\s+(?<who>(?!this\b|the\b|today)[\p{L}][\p{L}.' -]{1,58})$/iu,
]
const LABS = [
  new RegExp(String.raw`^(?:show(?:\s+me)?|what\s+are|list|any|give\s+me)\s+${OWNER}(?:recent\s+|latest\s+|last\s+|previous\s+)?(?:lab(?:oratory)?\s+)?(?:reports|results|investigations|labs|blood\s+tests)${OF_WHO}$`, 'iu'),
]
const SURGERIES = [
  /^(?:what|which|any)\s+(?:surgeries|operations|procedures)\s+(?:has|did|have)\s+(?<who>.+?)\s+(?:had|undergone|undergo|have)$/iu,
  new RegExp(String.raw`^(?:show(?:\s+me)?|list|what\s+(?:is|are))\s+${OWNER}(?:surgical\s+history|surgeries|past\s+surgeries|operations)${OF_WHO}$`, 'iu'),
]
const TODAY_CONSULTATION = [
  /^(?:summari[sz]e|recap|give\s+me\s+(?:a\s+)?summary\s+of|what\s+(?:has|have)\s+we\s+(?:got|recorded)\s+(?:in|from))\s+(?:today'?s|this|the\s+current|the\s+present|the)\s+(?:consultation|visit)(?:\s+so\s+far)?$/iu,
]
const ALLERGIES = [
  /^(?:what|which)\s+allergies\s+(?:does|do)\s+(.+?)\s+have(?:\s+on\s+record)?$/i,
  /^does\s+(.+?)\s+have\s+(?:any\s+)?(?:known\s+|recorded\s+)?allergies$/i,
  /^is\s+(.+?)\s+allergic\s+to\s+anything$/i,
]

// --- the words an order is asked about by -------------------------------------------------------------------------------------------------

/** A service's name or a question's words, made comparable (lower case, "X ray" as "x-ray", "USG" as "ultrasound", other punctuation as spaces): the same for both. */
export const normService = (s: string): string =>
  s
    .toLowerCase()
    .replace(/x[\s-]?rays?/g, 'x-ray')
    .replace(/\b(?:usg|sonography|ultrasonography)\b/g, 'ultrasound')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Words that say what kind of service an order is: an order may always be asked about by these ("the lab report", "the blood test results"). */
const ORDER_KIND_WORDS = new Set(['lab', 'labs', 'laboratory', 'blood', 'bloods', 'investigation', 'investigations', 'test', 'tests', 'imaging', 'scan', 'scans', 'radiology', 'x-ray', 'xray', 'ct', 'mri', 'ultrasound', 'usg', 'sonography', 'ecg'])
/** Little words around a service's name in a question; they say nothing about which service it is. */
const SERVICE_FILLER = new Set(['the', 'a', 'an', 'my', 'her', 'his', 'their', 'its', 'this', 'that', 'latest', 'last', 'recent', 'most', 'new', 'report', 'reports', 'result', 'results', 'request', 'requests', 'order', 'orders'])
/** Words of a catalogue name that name nothing on their own ("Urine routine and microscopy"). */
const NAME_LINKS = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'with', 'for', 'in', 'on', 'to', 'at', 'by'])
const NO_ORDER_WORDS: ReadonlySet<string> = new Set()

/** The words of the clinic's service catalogue (its codes and the words of its names) by which a doctor names an order: passed to matchRulesIntent. */
export function orderWordsOf(catalogue: readonly { code: string; name: string }[]): ReadonlySet<string> {
  const words = new Set<string>()
  for (const e of catalogue) {
    const code = normService(e.code)
    if (code) words.add(code)
    for (const w of normService(e.name).split(' ')) if (w && !NAME_LINKS.has(w)) words.add(w)
  }
  return words
}

/**
 * The service an order question names, in the doctor's words without the little words (null: no service, "is the report ready?"), or `false` when the words
 * are not an order's at all ("the thermal report", "the AI draft report", "Anita's report"): every word must be a kind of service or a word of the catalogue.
 */
function orderService(phrase: string, words: ReadonlySet<string>): string | null | false {
  const tokens = phrase
    .replace(/\bx[\s-]?rays?\b/gi, 'X-ray')
    .replace(/\b(lab|blood)\s+work\b/gi, '$1')
    .split(/\s+/)
    .filter(Boolean)
  const meaning = (tok: string) => normService(tok).split(' ').filter((w) => w && !SERVICE_FILLER.has(w))
  const kept = tokens.filter((tok) => meaning(tok).length)
  if (!kept.length) return null
  return kept.every((tok) => meaning(tok).every((w) => ORDER_KIND_WORDS.has(w) || words.has(w))) ? kept.join(' ') : false
}

function modalityOf(w: string): ImagingModality {
  const m = w.toLowerCase().replace(/\s+/g, ' ')
  if (m === 'mri' || m === 'mr') return 'mri'
  if (m.startsWith('ct') || m === 'cat scan') return 'ct'
  if (m.startsWith('x') || m === 'radiograph') return 'xray'
  return 'ultrasound'
}

const first = (res: RegExp[], t: string): RegExpExecArray | null => {
  for (const re of res) {
    const m = re.exec(t)
    if (m) return m
  }
  return null
}

/** "my", "me", "I": the doctor's own queue. */
const SAYS_MINE = /\b(?:my|mine|me|i)\b/i

/**
 * The fixed-rule question (or action) the doctor's words are, or null for anything else (which goes to the planner). Only whole questions of the
 * shapes above are recognised: a question that merely mentions a nurse, an order or the queue is not, nor one that names somebody who is not a patient
 * ("what did the nurse record for the dressing?"), nor an order question about something that is not a service the clinic orders (`orderWords`, from
 * orderWordsOf: without them, only the kinds of service, "the lab report", are recognised).
 */
export function matchRulesIntent(text: string, orderWords: ReadonlySet<string> = NO_ORDER_WORDS): RulesIntent | null {
  const t = cleanQuestion(text)
  if (!t || t.length > 300) return null
  if (/^add\s/i.test(t)) {
    const command = parsePrescriptionCommand(t)
    return command ? { kind: 'add_medicine', command } : null
  }
  if (first(NEXT_PATIENT, t)) return { kind: 'next_patient' }
  if (first(SEEN_TODAY, t)) return { kind: 'seen_today' }
  if (first(WAITING_LONGEST, t)) return { kind: 'waiting_longest', mine: SAYS_MINE.test(t) }
  const arrival = first(ARRIVAL, t)
  if (arrival) {
    const who = parseWho(arrival[1])
    return who.by === 'none' ? null : { kind: 'arrival_time', who }
  }
  const triage = first(TRIAGE, t)
  if (triage) {
    const who: PatientRef = triage[1] ? parseWho(triage[1]) : { by: 'current' }
    return who.by === 'none' ? null : { kind: 'nurse_triage', who }
  }
  const lead = splitLeadingPatient(t)
  const body = lead?.rest.replace(/[\s?.!]+$/, '') ?? t
  const orders = ordersIn(body, orderWords)
  if (orders) return { ...orders, who: lead?.who ?? orders.who }
  if (lead) return null
  const imaging = first(IMAGING, t)
  if (imaging?.groups?.modality) {
    const named = imaging.groups.owner ?? imaging.groups.of
    const who: PatientRef = named ? parseWho(named) : { by: 'current' }
    return who.by === 'none' ? null : { kind: 'imaging', who, modality: modalityOf(imaging.groups.modality) }
  }
  const allergies = first(ALLERGIES, t)
  if (allergies) {
    const who = parseWho(allergies[1])
    return who.by === 'none' ? null : { kind: 'allergies', who }
  }
  if (first(TODAY_CONSULTATION, t)) return { kind: 'today_consultation' }
  // Jury polish: questions about one patient's record, the patient named ("Ramesh Kumar's"), or the conversation's patient ("his", "this patient's").
  const owned = (m: RegExpExecArray): PatientRef => {
    const named = m.groups?.owner ?? m.groups?.of ?? m.groups?.who
    return named ? parseWho(named) : { by: 'current' }
  }
  // A named patient ("Meena's allergies", "the allergies of Zara Khan", "what medicines is Rahul on") stays with the planner, whose name checks
  // (the same words of the name, ambiguity, a second plan) are the safety net for names; only the history summary resolves a name here.
  const tries: [RegExp[], (who: PatientRef) => RulesIntent, boolean][] = [
    [ALLERGIES_OWNED, (who) => ({ kind: 'allergies', who }), false],
    [MEDICINES, (who) => ({ kind: 'record_topic', who, topic: 'medicines' }), false],
    [LAST_CONSULTATION, (who) => ({ kind: 'last_consultation', who }), false],
    [LABS, (who) => ({ kind: 'record_topic', who, topic: 'investigations' }), false],
    [SURGERIES, (who) => ({ kind: 'surgeries', who }), false],
    [HISTORY, (who) => ({ kind: 'record_topic', who, topic: 'history' }), true],
  ]
  for (const [patterns, make, namesToo] of tries) {
    const m = first(patterns, t)
    if (!m) continue
    if (!namesToo && m.groups?.of) return null
    const who = owned(m)
    if (who.by === 'none' || (!namesToo && who.by !== 'current')) return null
    return make(who)
  }
  return null
}

/** The same question about the patient the doctor chose from the ones offered (null for a question that is not about one patient). */
export function withChosenPatient(intent: RulesIntent, alias: string): RulesIntent | null {
  return 'who' in intent ? { ...intent, who: { by: 'alias', alias } } : null
}

function ordersIn(t: string, orderWords: ReadonlySet<string>): Extract<RulesIntent, { kind: 'orders' }> | null {
  // Who the question names after "for", the current patient when it names nobody; a phrase that names no patient ("for everyone") is not this question.
  const whoOr = (s: string | undefined, none: PatientRef): PatientRef | null => {
    if (!s) return none
    const who = parseWho(s)
    return who.by === 'none' ? null : who
  }
  const ready = first(ORDERS_READY, t)
  if (ready) {
    // The second form has no service ("Is the report ready?"); the others name one ("the CBC", "the lab"), which must be a service the clinic orders.
    const generic = ORDERS_READY[1]!.exec(t)
    const service = generic || GENERIC_REPORT.test(ready[1] ?? '') ? null : orderService(ready[1] ?? '', orderWords)
    const who = whoOr(generic ? generic[1] : ready[2], { by: 'current' })
    return service === false || !who ? null : { kind: 'orders', ask: 'ready', service, who }
  }
  const received = first(ORDERS_RECEIVED, t)
  if (received) {
    const service = orderService(received[1]!, orderWords)
    const who = whoOr(received[2], { by: 'current' })
    return service === false || !who ? null : { kind: 'orders', ask: 'received', service, who }
  }
  const pending = first(ORDERS_PENDING, t)
  if (pending) {
    const who = whoOr(pending[1], { by: 'none' })
    return who ? { kind: 'orders', ask: 'pending', service: null, who } : null
  }
  return null
}

// --- "add amoxicillin 500 mg three times a day for 5 days to the prescription" ---------------------------------------------------------------

export type CommandPart = 'medicine' | 'dose' | 'frequency' | 'duration'

/** A medicine the doctor asked, in their own words, to add to the open consultation's prescription; complete only when nothing had to be guessed. */
export interface PrescriptionCommand {
  drugName: string | null
  strength: string | null
  dose: string | null
  form: string | null
  route: string | null
  /** As the prescription writes it (a preset such as "Three times daily (TDS)", or the doctor's own words when there is none). */
  frequency: string | null
  /** As the doctor said it ("three times a day"), for the summary. */
  frequencyWords: string | null
  duration: string | null
  durationDays: number | null
  instructions: string | null
  /** What a full instruction has and this one does not. */
  missing: CommandPart[]
  /** Words that could not be read as part of the instruction, or a part said twice: then nothing is proposed. */
  unclear: string[]
  complete: boolean
}

const FREQUENCIES: [RegExp, string][] = [
  [/\b(?:once\s+(?:a|per)\s+day|once\s+daily|one\s+time\s+(?:a|per)\s+day|every\s+day|daily|od|qd|o\.d\.)(?=\s|$|,)/i, 'Once daily (OD)'],
  [/\b(?:twice\s+(?:a|per)\s+day|twice\s+daily|two\s+times\s+(?:a|per)\s+day|2\s+times\s+(?:a|per)\s+day|bd|bid|b\.d\.|b\.i\.d\.)(?=\s|$|,)/i, 'Twice daily (BD)'],
  [/\b(?:three\s+times\s+(?:a|per)\s+day|three\s+times\s+daily|thrice\s+(?:a\s+day|daily)|3\s+times\s+(?:a|per)\s+day|tds|tid|t\.d\.s\.|t\.i\.d\.)(?=\s|$|,)/i, 'Three times daily (TDS)'],
  [/\b(?:four\s+times\s+(?:a|per)\s+day|four\s+times\s+daily|4\s+times\s+(?:a|per)\s+day|qid|qds|q\.i\.d\.)(?=\s|$|,)/i, 'Four times daily (QID)'],
  [/\b(?:at\s+night|at\s+bedtime|before\s+bed(?:time)?|nightly|hs|h\.s\.)(?=\s|$|,)/i, 'At night (HS)'],
  [/\b(?:when\s+needed|as\s+needed|if\s+needed|as\s+required|when\s+required|sos|prn)(?=\s|$|,)/i, 'When needed (SOS)'],
  [/\b(?:once\s+(?:a|per)\s+week|once\s+weekly|weekly|every\s+week)(?=\s|$|,)/i, 'Once weekly'],
]
const PATTERN_FREQUENCY = /\b([0-2])-([0-2])-([0-2])\b/
const EVERY_HOURS = /\bevery\s+(\d{1,2}|four|six|eight|twelve)\s+hours?\b/i
const HOURS_WORDS: Record<string, number> = { four: 4, six: 6, eight: 8, twelve: 12 }
const STRENGTH = /\b(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|gm|grams?|ml|iu|units?|%)(?=\s|$|,|\/)/i
const UNIT_DOSE = /\b(\d+(?:\.\d+)?|one|two|three|half|a|an)\s+(tablets?|tabs?|capsules?|caps?|puffs?|drops?|sachets?|teaspoons?|tsp|spoons?)\b/i
const FORM_WORD = /\b(tablets?|capsules?|syrup|suspension|injection|cream|ointment|gel|drops|inhaler|sachets?)\b/i
const DURATION = /\b(?:for|x|×|over)\s+(?:(\d{1,4}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty)\s+)?(days?|weeks?|months?)\b/i
const BARE_DURATION = /\b(\d{1,4})\s+(days?|weeks?)\b/i
const ROUTE = /\b(orally|by\s+mouth|po|oral|iv|intravenously|intravenous|im|intramuscularly|intramuscular|sc|subcutaneously|subcutaneous|topically|topical|inhaled)\b/i
const INSTRUCTIONS = /\b(after\s+(?:food|meals?|breakfast|lunch|dinner)|before\s+(?:food|meals?|breakfast|lunch|dinner)|with\s+(?:food|meals?|water|milk)|on\s+an\s+empty\s+stomach)\b/i
/** Where the doctor said the medicine goes: the prescription. Another list ("to her allergies") is not a medicine to prescribe. */
const TO_PRESCRIPTION = /\s+(?:to|into|in|on|onto)\s+(?:the\s+|this\s+|her\s+|his\s+|their\s+|my\s+|today's\s+)?(?:prescription|rx)$/i
const TO_SOMETHING_ELSE = /\s+(?:to|into|in|on|onto)\s+(?:the\s+|this\s+|her\s+|his\s+|their\s+|my\s+|today's\s+)?(?:\w+\s+){0,2}?(?:allerg\w*|notes?|records?|history|diagnos\w*|problems?|problem\s+list|medicine\s+list|medication\s+list|medicines|medications|list|chart|plan|appointments?|queue|file|summary)$/i
const DETERMINER_START = /^(?:a|an|the|this|that|these|those|some|another|new|more|my|her|his|their)\b/i
/** What a record holds and a medicine is not: "add a note", "add the diagnosis", "add up how many ...". */
const NOT_MEDICINE = /^(?:up|on|in|note|notes|allerg\w*|diagnos\w*|appointment|visit|follow[\s-]?up|reminder|referral|record|entry|vitals?|test|order|investigation|condition|problem|comment|time|everything|all|me|us)\b/i
/** Words that point at a medicine without naming it ("add it", "add this medicine to the prescription"): which one must be said. */
const STOP_DRUG = /^(?:(?:a|an|the|this|that|these|those|some|another|her|his|their|my|same)\b.*|it|them|medicines?|medications?|drugs?|something|tablets?|capsules?)$/i
const NUM_WORD: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30 }
const FORM_OF_UNIT: Record<string, string> = { tablet: 'Tablet', tab: 'Tablet', capsule: 'Capsule', cap: 'Capsule', puff: 'Inhaler', drop: 'Drops', sachet: 'Sachet' }
const ROUTE_OF: Record<string, string> = { orally: 'Oral', 'by mouth': 'Oral', po: 'Oral', oral: 'Oral', iv: 'IV', intravenously: 'IV', intravenous: 'IV', im: 'IM', intramuscularly: 'IM', intramuscular: 'IM', sc: 'SC', subcutaneously: 'SC', subcutaneous: 'SC', topically: 'Topical', topical: 'Topical', inhaled: 'Inhaled' }
/** Little words that may sit between the parts of an instruction without meaning anything else. */
const FILLER = new Set(['and', 'for', 'of', 'the', 'a', 'to', 'please', 'take', 'taken', 'given', 'give', 'it', 'dose', 'per', 'each', 'with', 'by', 'mana', 'also', 'then', 'once'])

const singular = (u: string) => u.toLowerCase().replace(/s$/, '')
const unitText = (u: string): string => {
  const x = u.toLowerCase()
  if (x === 'iu') return 'IU'
  if (x === 'ug' || x === 'µg') return 'mcg'
  if (x === 'gm' || /^grams?$/.test(x)) return 'g'
  if (/^units?$/.test(x)) return 'units'
  return x
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Reads an "add ..." command (the words after "add", or the whole question). Returns null when it is not a medicine for the prescription at all ("add a
 * note", "add penicillin to her allergies", "add up how many ..."): those are not proposals and go on as before (a request to change a record is refused).
 * Otherwise it says what was read and what is missing; a part that cannot be read, or one said twice, makes it unclear. Nothing is guessed: the drug name is
 * the doctor's own words, the frequency a preset only when the words are exactly one, a duration in months keeps no day count.
 */
export function parsePrescriptionCommand(input: string): PrescriptionCommand | null {
  let body = cleanQuestion(input).replace(/^add\s+/i, '').trim()
  if (!body) return null
  if (TO_SOMETHING_ELSE.test(body) && !TO_PRESCRIPTION.test(body)) return null
  const toPrescription = TO_PRESCRIPTION.test(body)
  body = body.replace(TO_PRESCRIPTION, '').trim()
  const unclear: string[] = []
  const taken: [number, number][] = []
  const take = (m: RegExpExecArray | null, offset = 0): RegExpExecArray | null => {
    if (!m) return null
    taken.push([m.index + offset, m.index + offset + m[0].length])
    return m
  }
  const twice = (re: RegExp, what: string) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    if ((body.match(g) ?? []).length > 1) unclear.push(`${what} said twice`)
  }

  // "1 tablet of paracetamol 500 mg ...": the dose first, then the medicine.
  let drugFrom = 0
  let dose: string | null = null
  let form: string | null = null
  const lead = /^(\d+(?:\.\d+)?|one|two|three|half|a|an)\s+(tablets?|tabs?|capsules?|caps?|puffs?|drops?|sachets?|teaspoons?|tsp|spoons?)\s+of\s+/i.exec(body)
  if (lead) {
    const n = lead[1]!.toLowerCase()
    dose = `${/^\d/.test(n) ? n : n === 'half' ? '½' : (NUM_WORD[n] ?? n)} ${lead[2]!.toLowerCase()}`
    form = FORM_OF_UNIT[singular(lead[2]!)] ?? null
    drugFrom = lead[0].length
    taken.push([0, lead[0].length])
  } else if ((DETERMINER_START.test(body) || NOT_MEDICINE.test(body)) && !toPrescription) return null

  const strength = take(STRENGTH.exec(body))
  twice(STRENGTH, 'the strength')
  const unitDose = lead ? null : take(UNIT_DOSE.exec(body))
  if (!lead) twice(UNIT_DOSE, 'the dose')
  if (unitDose) {
    const n = unitDose[1]!.toLowerCase()
    dose = `${/^\d/.test(n) ? n : n === 'half' ? '½' : (NUM_WORD[n] ?? n)} ${unitDose[2]!.toLowerCase()}`
    form = FORM_OF_UNIT[singular(unitDose[2]!)] ?? null
  }

  let frequency: string | null = null
  let frequencyWords: string | null = null
  const freqs: { m: RegExpExecArray; value: string }[] = []
  for (const [re, value] of FREQUENCIES) {
    const m = re.exec(body)
    if (m) freqs.push({ m, value })
  }
  const pattern = PATTERN_FREQUENCY.exec(body)
  if (pattern) freqs.push({ m: pattern, value: pattern[0] })
  const hours = EVERY_HOURS.exec(body)
  if (hours) freqs.push({ m: hours, value: `Every ${/^\d+$/.test(hours[1]!) ? Number(hours[1]) : HOURS_WORDS[hours[1]!.toLowerCase()]} hours` })
  // "daily" inside "twice daily" is one frequency, not two: a match inside a longer one does not count.
  const distinct = freqs.filter((f) => !freqs.some((g) => g !== f && g.m.index <= f.m.index && g.m.index + g.m[0].length >= f.m.index + f.m[0].length && g.m[0].length > f.m[0].length))
  if (distinct.length > 1) unclear.push('more than one frequency')
  if (distinct.length) {
    const f = distinct[0]!
    take(f.m)
    frequency = f.value
    frequencyWords = f.m[0].toLowerCase()
  }

  let duration: string | null = null
  let durationDays: number | null = null
  // "for 5 days", "for a week", "x 10 days", "5 days"; not "for days" (how many is not said).
  const withNumber = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(body)
    return m && m[1] !== undefined ? m : null
  }
  const d = withNumber(DURATION) ?? withNumber(BARE_DURATION)
  twice(DURATION, 'the duration')
  if (d) {
    take(d)
    const raw = d[1]!.toLowerCase()
    const n = /^\d+$/.test(raw) ? Number(raw) : (NUM_WORD[raw] ?? null)
    const unit = singular(d[2]!)
    if (n !== null && n > 0) {
      duration = `${n} ${unit}${n === 1 ? '' : 's'}`
      durationDays = unit === 'day' ? n : unit === 'week' ? n * 7 : null
      if (durationDays !== null && durationDays > 3650) {
        unclear.push('a duration longer than ten years')
        durationDays = null
      }
    }
  }

  const route = take(ROUTE.exec(body))
  const instructions = take(INSTRUCTIONS.exec(body))
  const formWord = !form ? take(FORM_WORD.exec(body)) : null
  if (formWord) form = capital(singular(formWord[1]!).replace(/^drop$/, 'drops'))

  // The medicine: the doctor's words before the first part that was read (or after "1 tablet of").
  const starts = taken.filter(([s]) => s >= drugFrom).map(([s]) => s)
  const drugEnd = starts.length ? Math.min(...starts) : body.length
  const drugWords = body.slice(drugFrom, drugEnd).replace(/[,;:]+/g, ' ').replace(/\s+/g, ' ').trim()
  let drugName: string | null = null
  // A word that only points at a medicine ("it", "this medicine") names none: which medicine is missing, not unclear.
  if (drugWords && !STOP_DRUG.test(drugWords) && /^[\p{L}][\p{L}\p{N}' -]{1,59}$/u.test(drugWords) && drugWords.split(' ').length <= 5) drugName = capital(drugWords)
  else if (drugWords && !STOP_DRUG.test(drugWords)) unclear.push(`“${drugWords.slice(0, 60)}”`)

  // Whatever else was said and could not be read as part of the instruction: nothing is proposed from words that were not understood.
  const pieces: string[] = []
  let at = 0
  for (const [s, e] of [...taken, [drugFrom, drugEnd] as [number, number]].sort((a, b) => a[0] - b[0])) {
    if (s > at) pieces.push(body.slice(at, s))
    at = Math.max(at, e)
  }
  pieces.push(body.slice(at))
  const meaningful = (piece: string) =>
    piece
      .toLowerCase()
      .replace(/[,;:.()]+/g, ' ')
      .split(/\s+/)
      .some((w) => w && !FILLER.has(w))
  const leftover = pieces.map((p) => p.replace(/[,;:]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((p) => p && meaningful(p))
  if (leftover.length) unclear.push(`“${leftover.join(' … ').slice(0, 80)}”`)

  const doseText = dose ?? (strength ? `${strength[1]} ${unitText(strength[2]!)}` : null)
  const strengthText = strength ? `${strength[1]} ${unitText(strength[2]!)}` : null
  // Not a medicine at all (no dose, no frequency, no duration, not said to be for the prescription, and more than a medicine's name): not a proposal.
  const bareName = !!drugName && !leftover.length && drugWords.split(' ').length <= 3
  if (!toPrescription && !doseText && !frequency && !duration && !bareName) return null
  const missing: CommandPart[] = []
  if (!drugName) missing.push('medicine')
  if (!doseText) missing.push('dose')
  if (!frequency) missing.push('frequency')
  if (!duration) missing.push('duration')
  return {
    drugName,
    strength: strengthText,
    dose: doseText,
    form,
    route: route ? (ROUTE_OF[route[1]!.toLowerCase().replace(/\s+/g, ' ')] ?? null) : null,
    frequency,
    frequencyWords,
    duration,
    durationDays,
    instructions: instructions ? capital(instructions[1]!.toLowerCase()) : null,
    missing,
    unclear,
    complete: missing.length === 0 && unclear.length === 0,
  }
}

const PART_WORDS: Record<CommandPart, string> = { medicine: 'the medicine', dose: 'the dose', frequency: 'how often it is taken', duration: 'for how long' }

/** What Mana asks back for an instruction it could not take as it stands (fixed words, plus the doctor's own words for what was not understood). */
export function commandQuestion(c: PrescriptionCommand): string {
  const what = c.drugName ? `To add ${c.drugName} to the prescription` : 'To add a medicine to the prescription'
  if (c.missing.length) {
    const parts = c.missing.map((p) => PART_WORDS[p])
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
    return `${what}, I need ${list}. Say the whole instruction again with them. Nothing was added.`
  }
  return `${what}, I need the instruction without anything I could not read (${c.unclear.join('; ')}). Say it again as: medicine, dose, how often, for how long. Nothing was added.`
}
