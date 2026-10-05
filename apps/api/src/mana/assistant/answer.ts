import { type EvidenceTrust, MANA_NO_ANSWER, MANA_NOT_ESTABLISHED, MANA_UNVERIFIED, MANA_WITHHELD, type ManaAnswerBlock, type ManaModelAnswer, type ManaSourceItem } from '@adaxai/contracts'
import { neutralise } from '../../ai/llm/neutralise.ts'
import { MANA_ANSWER_PROMPT } from '../../ai/prompts.ts'
import {
  cleanText,
  contentWords,
  DOSE,
  drugLikeWords,
  figureTokens,
  figuresIn,
  fitText,
  GLUE,
  hasDoseOrRegimen,
  hasUnreadableDigits,
  negatedIn,
  negatedTerms,
  NO_ALLERGIES,
  NOT_ALLERGIC_TO,
  REGIMEN,
  REPORTS_ABSENCE,
  sameWord,
  spellNegations,
  URLS,
  wordsNotIn,
} from '../../consult/validate.ts'

/**
 * Step two of a question: WRITING THE ANSWER, and step three: CHECKING IT. The model is shown the doctor's question and the FACTS the tools returned,
 * each with an id, and writes statements that cite ids. Whatever it writes is then held against those facts by explicit rules (this file), and a statement
 * that cannot be tied to the facts it cites is not shown. Findings (records that disagree, records that are old, what is not recorded) are not the
 * model's to write: the tools find them by rules and the server shows them whatever the model said. The rules reduce the chance that an unsupported
 * statement reaches the doctor; they do not make a statement true.
 */
export const ANSWER_PROMPT = MANA_ANSWER_PROMPT
export const ANSWER_SCHEMA_VERSION = MANA_ANSWER_PROMPT.schemaVersion
// v3 (D2): a statement that restates a fact of the consultation context keeps that fact's trust (see TRUST_MUST_SAY and the rules after it).
// v4: an extracted point must be said to be one; nothing is added to a recording, a thermal measurement or a simulator's output, however short the word
// (NOTHING_ADDED); "staff measured" is the staff's word, not a device's.
export const ANSWER_CHECKS_VERSION = 'mana-answer-checks-v4'

export interface AnswerFact {
  ref: string
  text: string
  /** The handle of the patient it is about. */
  patient: string | null
  items: ManaSourceItem[]
  /** How far it can be trusted, when the tool that made it says so (the consultation context does): see `checkAnswer`. */
  trust?: EvidenceTrust | null
}

export interface AnswerFinding {
  ref: string
  kind: 'conflict' | 'outdated' | 'absent' | 'untrusted'
  text: string
  items: ManaSourceItem[]
}

// --- text as it reads --------------------------------------------------------------------------------------------------------------------------

/** Compatibility forms made plain (fullwidth letters, ligatures) and the characters that only format text (zero-width, soft hyphen, direction marks) taken out. */
export const plain = (s: string): string => s.normalize('NFKC').replace(/\p{Cf}/gu, '')

/** A mark that combines with the letter before it (an underline, an accent that no single letter carries): nothing in an English clinical statement needs one. */
const hasCombining = (s: string): boolean => /\p{M}/u.test(s)

/** Letters of other scripts, and small capitals, that look like a Latin letter, written as that letter: a rule that looks for "ignore" must not be fooled by a Cyrillic "о". */
const LOOKALIKES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w', ѵ: 'v', к: 'k', м: 'm', н: 'h', т: 't', в: 'b',
  А: 'A', Е: 'E', О: 'O', Р: 'P', С: 'C', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S', К: 'K', М: 'M', Н: 'H', Т: 'T', В: 'B',
  α: 'a', ο: 'o', ν: 'v', ι: 'i', ρ: 'p', τ: 't', χ: 'x', υ: 'u', κ: 'k', Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  ı: 'i', ɪ: 'i', ɡ: 'g', ɢ: 'g', ɴ: 'n', ᴏ: 'o', ʀ: 'r', ᴇ: 'e', ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ʜ: 'h', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ᴘ: 'p', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
}
export const foldLookalikes = (s: string): string => [...s].map((c) => LOOKALIKES[c] ?? c).join('')

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' }
/** Characters that draw nothing but are not "format" characters: the Hangul fillers, the blank Braille cell, the Mongolian vowel separator. Taken out for the filter only. */
const BLANKS = new RegExp(`[${[0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x180e].map((c) => String.fromCharCode(c)).join('')}]`, 'g')
/**
 * Text as a rule that looks for words should read it: made plain, look-alike letters folded, combining marks taken out, letters that were spaced apart
 * ("I g n o r e") joined, and a digit written for a letter inside a word ("Ign0re") written as the letter. Used only to LOOK for instructions: it is never
 * what the doctor reads.
 */
export function readableForFilter(text: string): string {
  const folded = foldLookalikes(plain(text).replace(BLANKS, '').replace(/[*_`~]+/g, '')).normalize('NFKD').replace(/\p{M}/gu, '')
  const joined = folded.replace(/\b(?:\p{L}[\s._-]){3,}\p{L}\b/gu, (m) => m.replace(/[\s._-]/g, ''))
  return joined.replace(/(?<=\p{L})[013457](?=\p{L})/gu, (d) => LEET[d] ?? d)
}

// --- text that talks to the model ------------------------------------------------------------------------------------------------------------

/**
 * Record text that reads like an instruction to an AI system ("ignore the previous instructions", "you are now ...", "reveal every patient's ...", "note for
 * the assistant: ..."). A record is data, and the model is told so; but a record that tries to give orders is not shown to it at all: the fact is withheld
 * and the doctor is told that a record holds such text (and can read it where it is). This list is a first line, written for the ways such text is usually
 * phrased, and run on the text as it reads (compatibility forms made plain, invisible characters removed, look-alike letters folded, spaced-out and
 * digit-for-letter spellings joined): it cannot recognise every phrasing, so the checks on what the model writes (below) do not depend on it. It also cannot
 * tell an order to an AI from a clinical instruction in the same words in every case: a fact that trips it is withheld and the doctor is told so.
 */
/** Words for the system the text may be talking to; "assistant" followed by a job title ("assistant professor", "assistant physician") is a person, not a system. */
const AI = String.raw`(?:ai|assistant(?!\s+(?:professor|physician|manager|director|nurse|doctor|surgeon|dean|registrar|lecturer|engineer|technician|pharmacist|administrator|clinician|consultant|chief|medical))|chatbot|language\s+model|llm|mana|claude)`
/** What an order to an AI asks it to do with its answer. */
const SAY = String.raw`(?:answer|reply|respond|say|state|write|output|report|claim|tell)`
const INSTRUCTION_LIKE: RegExp[] = [
  // "ignore (all) previous instructions", "disregard the above rules": the thing ignored is the AI's own instructions, not a person's ("ignore the doctor's instructions").
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|these|those)\s+)*(?:previous|prior|above|earlier|preceding|former|system|safety|your|these|those|all)\s+(?:instruction|rule|prompt|guideline|direction|constraint|restriction|polic(?:y|ies)|check)s?\b/i,
  /\b(?:disregard|ignore|forget)\s+(?:everything|anything|all)\s+(?:above|before|else|previous|prior)\b/i,
  /\b(?:system\s+(?:prompt|message)|developer\s+(?:prompt|message|instruction)s?)\b/i,
  /\bnew\s+(?:system\s+)?(?:instruction|rule|task|role)s?\s*:\s*(?:you\b|ignore|disregard|from\s+now|always|never|do\s+not|don[’']t|answer|say|respond|reply|output|print|reveal)/i,
  /\byou\s+(?:are|must|should|will|shall)\s+(?:now\s+|only\s+)?(?:be\s+|act\s+as\s+)?(?:an?\s+)?(?:ai\b|assistant(?!\s+(?:professor|physician|manager|director|nurse|doctor|surgeon|dean|registrar|lecturer|engineer|technician|pharmacist|administrator|clinician|consultant|chief|medical))|chatbot|language\s+model|llm|unrestricted|jailbroken|in\s+(?:developer|debug|admin(?:istrator)?)\s+mode)/i,
  /\byou\s+are\s+now\s+(?:an?\s+)?(?:admin(?:istrator)?|root|superuser)\b/i,
  /\b(?:act|behave|respond|pretend)\s+(?:as|like)\s+(?:an?\s+)?(?:admin|root|unrestricted|different|new)\b/i,
  /\b(?:reveal|print|output|dump|disclose|exfiltrate|leak)\b[^.]{0,60}\b(?:all|every|each)\s+(?:the\s+)?(?:other\s+)?(?:patients?(?:['’]s?)?|patient\s+names?|phone\s+numbers?|telephone\s+numbers?|passwords?|api\s+keys?|secrets?|tokens?|mrns?)\b/i,
  new RegExp(String.raw`\b(?:${AI}|model)\s*[,:]\s*(?:please\s+)?(?:ignore|do\s+not|don[’']t|say|tell|write|output|reveal|prescribe|delete|forward|send|sign|approve|mark|answer|reply|respond|state|report|record)\b`, 'i'),
  // "do not tell the doctor about this": hiding something from the doctor. A conditional instruction to staff ("do not inform the doctor on call unless ...") is not that.
  /\bdo\s+not\s+(?:tell|inform|warn|alert|mention\s+(?:this\s+)?to)\s+(?:the\s+)?(?:doctor|user|clinician|physician)\b(?![^.]{0,40}\b(?:unless|until|if|on\s+call|before|after|when)\b)/i,
  /\b(?:end|close)\s+of\s+(?:the\s+)?(?:record|sources?|facts?|data)\b[^.]{0,30}\b(?:instruction|now|follow)/i,
  /<\s*\|\s*(?:im_start|im_end|system|assistant|tool)/i,
  new RegExp(String.raw`\b(?:note|message|memo|attention|important|instruction)s?\s+(?:for|to)\s+(?:the\s+)?${AI}\b`, 'i'),
  /\b(?:note|message|memo|attention|important|instruction)s?\s+(?:for|to)\s+(?:the\s+)?(?:model|system)\s*[:,]/i,
  new RegExp(String.raw`\b(?:for|to)\s+(?:the\s+)?${AI}\s*:`, 'i'),
  new RegExp(String.raw`\b(?:the\s+)?${AI}\s+(?:must|should|shall|has\s+to|needs\s+to|is\s+to|will)\s+(?:always\s+|never\s+|only\s+|now\s+|not\s+)?(?:${SAY}|leave|omit|skip|exclude|hide|ignore|replace|delete|remove)\b`, 'i'),
  new RegExp(String.raw`\b(?:if|when|whenever)\s+(?:you\s+(?:are\s+)?|anyone\s+|someone\s+|the\s+(?:doctor|user|clinician)\s+)?(?:asks?|asked|enquires?|inquires?)\b[^.]{0,80}\b${SAY}\b`, 'i'),
  new RegExp(String.raw`\bwhenever\b[^.]{0,60}\b(?:comes?\s+up|is\s+mentioned|is\s+raised)\b[^.]{0,40}\b${SAY}\b`, 'i'),
  /\bwhen\s+summari[sz]ing\b/i,
  /\bthe\s+correct\s+(?:answer|reply)\s+to\b/i,
  /\b(?:respond|reply|answer)\s+(?:only\s+)?with\s*(?::|the\s+(?:word|phrase|text|following)\b|[“"‘'])/i,
  /\b(?:respond|reply|answer)\s+(?:only\s+)?with\s+(?:none|nothing|yes|no)\b/i,
  /\b(?:summari[sz]e|answer|reply|respond)\s+as\s+follows\b/i,
  /\bpretend\b/i,
  /\bnew\s+(?:context|persona|session|conversation)\s*:/i,
  /\byou\s+(?:work|are\s+working)\s+for\b/i,
  /\b(?:omit|skip|leave\s+out|exclude|hide|suppress|replace|delete)\b[^.]{0,60}\b(?:from|in|with)\s+(?:your\s+(?:answer|reply|response|summary|output)|the\s+(?:answer|reply|response))\b/i,
  /\b(?:answer|reply|respond)\s+(?:only\s+)?(?:with\s+|that\s+)?(?:yes|no|none|nothing)\b[^.]{0,40}\bwhatever\s+(?:is\s+)?asked\b/i,
  new RegExp(String.raw`\bfrom\s+now\s+on\b[^.]{0,60}\b(?:${SAY}|always|never)\b`, 'i'),
  new RegExp(String.raw`\b(?:always|never)\s+${SAY}\s+that\b`, 'i'),
  /\b(?:do\s+not|don[’']t|never)\s+(?:mention|include|reveal|show|say|state|report)\b[^.]{0,60}\b(?:in\s+(?:your|the)\s+(?:answer|reply|response|summary)|to\s+the\s+(?:doctor|user))\b/i,
  /\b(?:reply|respond|answer|say|write|output|state)\s+(?:exactly|verbatim)\b/i,
  new RegExp(String.raw`\b${SAY}\b[^.]{0,40}\bin\s+your\s+(?:answer|reply|response|summary)\b`, 'i'),
  /\byour\s+(?:answer|reply|response|summary|output)\s+(?:must|should|shall|has\s+to|needs\s+to)\b/i,
  new RegExp(String.raw`\b(?:important|attention|urgent|note)\s*:\s*(?:you\b|ignore|disregard|${SAY}\b|always\s+${SAY}\b)`, 'i'),
]

export function looksLikeInstruction(text: string): boolean {
  const forms = [text, plain(text), readableForFilter(text)]
  return INSTRUCTION_LIKE.some((r) => forms.some((f) => r.test(f)))
}

// --- what the model is shown ------------------------------------------------------------------------------------------------------------------

/** One fact as the model sees it: its id, the patient's handle, then the statement the tool made, on one line. */
function factLine(f: AnswerFact): string {
  return `[${f.ref}] ${f.patient ? `(${f.patient}) ` : ''}${neutralise(f.text)}`
}

/**
 * The user message of the writer: the date, the question, the facts, any findings (so it does not contradict them), and the task last, so that nothing in a
 * record is the last word. Facts that do not fit the character budget are left out, in order, and counted.
 */
export function renderAnswerMessage(i: { today: string; question: string; facts: AnswerFact[]; findings: AnswerFinding[]; maxChars: number }): { text: string; shown: AnswerFact[]; omitted: number } {
  const findingLines = i.findings.filter((f) => f.kind !== 'untrusted').map((f) => `[${f.ref}] ${f.kind}: ${neutralise(f.text)}`)
  const head = `TODAY: ${i.today}\nQUESTION: ${neutralise(i.question)}\n\nFACTS\n`
  const tail = `${findingLines.length ? `\n\nFINDINGS (the system shows these to the doctor; do not restate them)\n${findingLines.join('\n')}` : ''}\n\nWrite the answer blocks for the doctor, from the FACTS only.`
  let budget = i.maxChars - head.length - tail.length
  const shown: AnswerFact[] = []
  const lines: string[] = []
  for (const f of i.facts) {
    const line = factLine(f)
    if (shown.length && line.length + 1 > budget) break
    budget -= line.length + 1
    lines.push(line)
    shown.push(f)
  }
  return { text: head + lines.join('\n') + tail, shown, omitted: i.facts.length - shown.length }
}

// --- what the model wrote ------------------------------------------------------------------------------------------------------------------------

const MAX_STATEMENT = 360
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The model saying that IT did something ("I have prescribed ...", "I've updated ...", "we cancelled ...", "I prescribe ..."): it cannot, and a model that says it
 * did is not keeping to the facts. First person only, and in the forms that claim an act: with "have / had / will" or a contraction, in the past ("I updated"),
 * or in the present for the verbs of ordering and cancelling ("I cancel"). "We record it as moderate" is a way of saying where something is written, not a claim.
 */
const ADVERBS = String.raw`(?:(?:just|now|already|also|hereby|successfully)\s+)*`
const STRONG_ACTIONS = 'prescrib|sign|order|cancel|delet|remov|book|discharg|approv|submit|amend|schedul|sav|sen[dt]|forward|transfer'
const ALL_ACTIONS = `${STRONG_ACTIONS}|updat|chang|creat|add|record|modif|enter|confirm|mark|assign|refer|writ`
const ACTION_CLAIM = new RegExp(
  [
    String.raw`\b(?:I|we)(?:['’]ve|['’]ll|['’]m going to|\s+(?:have|had|will|shall|am going to))\s+${ADVERBS}(?:${ALL_ACTIONS})\w*`,
    String.raw`\b(?:I|we)\s+${ADVERBS}(?:${ALL_ACTIONS})\w*ed\b`,
    String.raw`\b(?:I|we)\s+${ADVERBS}(?:wrote|sent|made|put|gave)\b`,
    String.raw`\b(?:I|we)\s+${ADVERBS}(?:${STRONG_ACTIONS})(?:e|es|s)?\b`,
  ].join('|'),
  'i',
)
/**
 * The same claim in the passive ("The allergy list has been updated.", "Allergy added.", "Done."): not the model speaking of itself, but a statement that
 * something was done. A record does say so of itself ("Amoxicillin was prescribed on ..."), so it stands when a fact the statement cites has the same verb.
 */
const PASSIVE_ACTION = /\b(?:has|have|had|was|were|is|are|been|being)\s+(?:(?:now|just|already|successfully)\s+)*(?:been\s+)?(prescribed|ordered|signed|co-?signed|updated|changed|deleted|removed|created|added|booked|cancell?ed|scheduled|sent|saved|modified|amended|approved|discharged|referred|submitted|forwarded|transferred|merged|restored|renewed|refilled|issued)\b/gi
const BARE_ACTION = /^(?:[\w-]+\s+){0,4}?(prescribed|ordered|signed|updated|changed|deleted|removed|created|added|booked|cancell?ed|scheduled|sent|saved|modified|amended|approved|discharged|referred|submitted|done)\W*$/i
/** The same at the start of a statement: "Updated the allergy list." A fact that starts so ("Signed consultation ...") supports it by having the verb itself. */
const INITIAL_ACTION = /^\s*(prescribed|ordered|signed|updated|changed|deleted|removed|created|added|booked|cancell?ed|scheduled|sent|saved|modified|amended|approved|discharged|referred|submitted|done)\b/i
/** The start of a verb of doing, as a fact would spell it ("prescribed" and "prescription" both start with "prescr"). */
const actionStem = (verb: string): string => verb.toLowerCase().replace(/ed$|d$/, '').replace(/^co-/, '').slice(0, 6)

const ADVICE = /\b(?:I|we)\s+(?:would\s+|strongly\s+)?(?:recommend|suggest|advise|propose)\b|\byou\s+(?:should|must|need\s+to|ought\s+to|could\s+consider)\b|\b(?:should|must)\s+(?:be\s+)?(?:prescrib|given|start|stopp?|avoid|refer|admit|discharg|treat)\w*|\b(?:consider|recommend)(?:ed|ing)?\s+(?:prescrib|giving|starting|stopping|admitting|referring)\w*/i
const MARKDOWN_LINK = /\]\s*\(|\b(?:javascript|vbscript):|\bdata:\s*(?:text|image|application)\/|\b(?:mailto|ftp|file):\S/i
/**
 * A record number (ADX-004779, "ADX 004779", "adx004779") or a telephone number in an answer: nothing the model was shown has either, so one in an answer is
 * the model's own, unless the doctor typed it in the question.
 */
const MRN_LIKE = /\b(?:[A-Z]{2,5}[\s-]?\d{5,}|[A-Za-z]{2,5}-\d{5,}|(?:[Aa][Dd][Xx]|[Mm][Rr][Nn])[\s-]?\d{3,})\b/g
const PHONE_RUN = /\+?\d[\d\s().-]{7,}\d/g
const ISO_DATE_TEXT = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g
const idKey = (s: string): string => s.toLowerCase().replace(/[\s-]/g, '')
const mrnsIn = (s: string): string[] => (s.match(MRN_LIKE) ?? []).map(idKey)
/** Runs of nine or more digits (a telephone number), once dates and times are set aside. */
const phonesIn = (s: string): string[] =>
  (s.replace(ISO_DATE_TEXT, ' ').match(PHONE_RUN) ?? []).map((r) => r.replace(/\D/g, '')).filter((d) => d.length >= 9)
const hasWord = (text: string, word: string): boolean => new RegExp(`\\b${escapeRe(word)}\\b`).test(text)
/** A name used as a name: written with a capital ("Will", "WILL"), so that a patient called Will does not make every "will" in an answer a name. */
const hasProperName = (text: string, word: string): boolean => {
  const esc = escapeRe(word)
  return new RegExp(`\\b(?:${esc.charAt(0).toUpperCase()}${esc.slice(1)}|${esc.toUpperCase()})\\b`).test(text)
}
/** A patient's handle (P1 ... P99), and not a code that starts the same way ("P59.9", "P07", "P2Y12"). */
const HANDLE = /(?<![\w.])P[1-9]\d?(?![\w]|\.\d)/g
const REF = /^[SF]\d{1,3}$/
/**
 * The letters of a text that are not those of English and its Latin neighbours (Basic Latin, Latin-1 and Latin Extended A and B, up to U+024F): the micro sign
 * of "µg" and the Greek of "β-blocker" are letters of another script, and so are the small capitals and phonetic letters that look like Latin ones.
 */
const foreignLetters = (s: string): string[] => [...s].filter((ch) => /\p{L}/u.test(ch) && (ch.codePointAt(0) ?? 0) > 0x24f)

/**
 * "two appointments" is a figure as much as "2 appointments", and a count is the commonest thing a small model gets wrong while sounding sure. The checks
 * of V3 read a small number written in words only before a unit of time or dose; here the words two to nine are read as the figures they are, in what the
 * model wrote and in the facts it was shown, and "one", "zero" and "no" before a thing that is counted ("one patient", "no visits") likewise. ("One" is
 * otherwise left alone: it is also a pronoun.)
 */
const SPELLED: Record<string, string> = { two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }
const COUNTED = 'patients?|visits?|appointments?|consultations?|results?|readings?|medicines?|medications?|allerg(?:y|ies)|records?|entries|items?|encounters?|people|persons?|prescriptions?'
const withSpelledNumbers = (s: string): string =>
  s
    .replace(/\b(two|three|four|five|six|seven|eight|nine)\b/gi, (w) => ` ${SPELLED[w.toLowerCase()]} `)
    .replace(new RegExp(`\\b(one|zero|no)\\s+(?=(?:more\\s+|other\\s+)?(?:${COUNTED})\\b)`, 'gi'), (_m, w: string) => (w.toLowerCase() === 'one' ? ' 1 ' : ' 0 '))

/**
 * A number with its unit of measurement or of time ("86 bpm", "38.6 °C", "142/90 mmHg", "5 days", "45-year-old"), as a comparable key. The figures of a
 * statement are checked against the facts one by one; this holds each to ITS unit, so that the heart rate and the temperature of one reading cannot swap
 * numbers, nor "2 days" stand for "2 weeks".
 */
const UNIT_PAIR = /(\d[\d,]*(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)[\s-]*(%|°\s?[cf]\b|℃|℉|(?:bpm|mm\s?hg|kg|mg|mcg|μg|ug|ng|ml|mmol|iu|cm|mm|g|l|days?|weeks?|months?|years?|yrs?|hours?|hrs?|minutes?|mins?|units?)\b)/gi
const unitKey = (u: string): string => {
  const w = u.toLowerCase().replace(/\s+/g, '')
  if (/^(?:°c|℃)$/.test(w)) return 'c'
  if (/^(?:°f|℉)$/.test(w)) return 'f'
  if (/^(?:mcg|μg|ug)$/.test(w)) return 'mcg'
  if (/^(?:yrs?|years?)$/.test(w)) return 'year'
  if (/^(?:hrs?|hours?)$/.test(w)) return 'hour'
  if (/^(?:mins?|minutes?)$/.test(w)) return 'minute'
  return w.replace(/s$/, '')
}
const unitPairsIn = (s: string): Set<string> => new Set([...s.matchAll(UNIT_PAIR)].map((m) => `${m[1]!.replace(/,/g, '')}|${unitKey(m[2]!)}`))

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' }
const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'

/** The ISO form (as a figure token) of each "28 Sep 2026" in a text, so that a date written either way finds the date the record shows. */
function isoDateTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/gi)) out.push(`d:${m[3]}-${MONTHS[m[2]!.toLowerCase()]}-${m[1]!.padStart(2, '0')}`)
  return out
}

/** The months a text names, as numbers: "4 Oct", "October 2026" and "2026-10-04" all say October. The figures alone do not tell August from December. */
function monthsIn(s: string): Set<number> {
  const out = new Set<number>()
  for (const m of s.matchAll(new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(${MONTH_NAMES})\b|\b(${MONTH_NAMES})\.?\s+\d{1,4}\b`, 'gi'))) {
    const n = Number(MONTHS[(m[1] ?? m[2] ?? '').slice(0, 3).toLowerCase()] ?? 0)
    if (n) out.add(n)
  }
  for (const m of s.matchAll(/\b\d{4}-(\d{2})-\d{2}\b/g)) out.add(Number(m[1]))
  return out
}

/** The clock times of a text with am or pm ("9:15 am", "9 pm") as comparable keys: the morning is not the evening. */
function timesIn(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of s.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/gi)) out.add(`${Number(m[1])}:${m[2] ?? '00'} ${m[3]!.toLowerCase()}m`)
  return out
}

/**
 * The words a fact DENIES: negated in one of its clauses and affirmed in none. "1 signed that day, 1 open (not signed)" denies nothing, because "signed" is
 * also affirmed in it: a statement that says "signed" restates the fact, and one that says "not signed" restates it too.
 */
function deniedWords(text: string): Set<string> {
  const negated = new Set<string>()
  const affirmed = new Set<string>()
  for (const clause of text.split(/[;,.()]| but /i)) {
    if (!clause.trim()) continue
    const neg = negatedTerms(clause)
    for (const t of neg) negated.add(t)
    for (const w of contentWords(clause)) if (!neg.has(w)) affirmed.add(w)
  }
  return new Set([...negated].filter((w) => ![...affirmed].some((a) => sameWord(a, w))))
}

/**
 * Words a statement may use to say WHERE something is in the facts ("the record lists", "the diagnoses include", "dated 4 Oct", "assessed as", "multiple
 * entries"). They make no claim about the patient, so a statement is not marked for using one that its facts do not contain (a first version of the check
 * marked a third of the statements of the evaluation, nearly all for words like these, and a mark on every statement is a mark nobody reads). A word that
 * does make a claim ("severe", "chronic", "lower", "improved", "resolved") is not here.
 */
const REPORTING_WORDS = new Set(
  ('list lists listed listing include includes included including contain contains contained containing date dated dates assess assessed show shows shown showing indicate indicates indicated ' +
    'mention mentions mentioned mentioning note notes noted report reports reported state states stated give gives given appear appears appeared multiple several entries entry ' +
    'second third fourth fifth mean means record records recorded recording').split(' '),
)

/**
 * Words that say which way a measurement went. The tools write them in their own words ("down 8 bpm", "up 3 mmHg"); a model says "lower", "higher",
 * "decreased", "went up", "rises", "above". A statement may use any of them when a cited fact says the same way, and may not when the facts say the opposite way
 * or nothing about the direction: a reading that fell is not a reading that rose, and a model that adds a direction has made a clinical claim.
 */
const UP = /\b(?:up\s+\d|higher\w*|increas\w*|rais\w*|rose|rising|risen|rises|rise|elevat\w*|went\s+up|grew|grow\w*|gain\w*|above|climb\w*|more\s+than|greater)\b/i
const DOWN = /\b(?:down\s+\d|lower\w*|decreas\w*|reduc\w*|drop\w*|fell|falling|falls|declin\w*|went\s+down|shrank|shrink\w*|below|less\s+than|loss|lost|smaller)\b/i
const directionOf = (t: string): number => (UP.test(t) ? 1 : 0) | (DOWN.test(t) ? 2 : 0)

/**
 * Wording that states a diagnosis as settled fact. "Diagnosed with ..." and "a diagnosis of ..." only restate a recorded diagnosis when a cited fact is itself
 * about diagnoses; the words of certainty ("definitely", "proves", "must be") are never a restatement of a record.
 */
const CERTAINTY = /\b(?:definitely|certainly|without\s+(?:a\s+)?doubt|proves?|must\s+be|is\s+caused\s+by|clearly\s+has|confirmed\s+(?:case|diagnosis)|is\s+suffering\s+from)\b/i
const DIAGNOSED = /\b(?:diagnos(?:is|ed)\s+(?:is|with|of)|has\s+been\s+diagnosed|has\s+(?:a\s+)?(?:pneumonia|infection|cancer|diabetes|asthma|tuberculosis|malaria|dengue|covid))\b/i

/**
 * Words that claim that nothing, or everything, or no one: "nobody is waiting", "the queue is empty", "all patients have been seen". They are claims about the
 * records as a whole, and a wrong one is the kind a hurried reader believes; so one is shown only when a cited fact uses the same word.
 */
const ABSOLUTE = /\b(?:nobody|no\s+one|everyone|everybody|nothing|none|empty|zero|never|always|clear|all\s+(?:of\s+)?(?:the\s+)?(?:patients|visits|appointments|consultations|records))\b/gi
/** A quantity in words ("several patients", "only one visit", "a single entry"): a count the figures do not show, so it is shown only when a cited fact uses the same word. "Both" is a count of two. */
const VAGUE_COUNT = /\b(several|few|many|most(?!\s+(?:recent|recently|common|commonly|likely|current|important))|majority|numerous|handful|couple|dozens?|single|sole|solely|exclusively|only|just\s+(?:one|\d+)|both)\b/gi
/** The state of a visit or an appointment, in words: a statement may not give one that no cited fact gives ("cancelled" for a visit that was completed). */
const STATUS_WORD = /\b(cancell?ed|missed|no[\s-]?show|did\s+not\s+attend|rescheduled|completed|waiting|in\s+triage|booked)\b/gi
/** What happened to a medicine ("stopped", "started", "tapered"): a change of treatment is a claim a record must make, in those words. */
const MED_STATUS = /\b(stopp?ed|discontinu\w*|ceased|restarted|started|resumed|tapered|switched|withheld|on\s+hold)\b/gi
const medStem = (w: string): string => {
  const l = w.toLowerCase().replace(/\s+/g, ' ')
  if (/^stopp?ed$/.test(l)) return 'stop'
  if (l.startsWith('discontinu')) return 'discontinu'
  if (l === 'ceased') return 'ceas'
  if (l === 'restarted') return 'restart'
  if (l === 'started') return 'start'
  if (l === 'resumed') return 'resum'
  if (l === 'tapered') return 'taper'
  if (l === 'switched') return 'switch'
  if (l === 'withheld') return 'withheld'
  return 'on hold'
}
const statusStem = (w: string): string => (/^cancel/i.test(w) ? 'cancel' : /^(?:missed|no|did)/i.test(w) ? (/^missed/i.test(w) ? 'missed' : 'no.?show|did not attend') : /^reschedul/i.test(w) ? 'reschedul' : /^complet/i.test(w) ? 'complet' : /^waiting/i.test(w) ? 'waiting' : /^in\s+triage/i.test(w) ? 'triage' : 'book')

/**
 * Allergy-free in other words: "allergy free", "free of allergies", "an empty allergy list", "nothing is recorded for allergies". Like "no known allergies" (V3's
 * pattern, used as well), it is a claim nobody should be left to read into a gap, so it is shown only when a cited fact or finding says it.
 */
const ALLERGY_ABSENCE = /\b(?:allerg\w*[\s-]*free|free\s+(?:of|from)\s+(?:any\s+)?allerg|(?:no|nil|zero|without|lacks?|lacking)\s+(?:any\s+)?(?:known\s+|recorded\s+|documented\s+|drug\s+|food\s+)*allerg|allerg\w*\s+(?:list\s+|record\s+|history\s+|status\s+)?(?:is\s+|are\s+|was\s+|were\s+)?(?:empty|none|nil|clear|negative|absent)|(?:nothing|none)\s+(?:is\s+|was\s+)?(?:recorded|documented|noted|listed)\s+(?:for|about|on|under)\s+allerg)/i

/**
 * Words that CLAIM something about the patient: how bad, how it is going, what it is (a severity, a state, a diagnosis). A statement that uses one that its
 * facts do not contain is removed, not marked: a model that adds "severe" or "hypertension" to a record that says neither has invented a clinical claim.
 */
const CLAIM_WORD =
  /^(?:severe|mild|moderate|serious|critical|fatal|urgent|emergency|chronic|acute|stable|unstable|improv\w*|worsen\w*|worse|worst|better|best|deteriorat\w*|resolved|cured|controlled|uncontrolled|normal|abnormal|elevated|raised|borderline|positive|negative|confirmed|suspected|likely|probable|possible|unlikely|definite\w*|hypertens\w*|hypotens\w*|diabet\w*|asthma\w*|pneumonia|infect\w*|sepsis|cancer\w*|tumou?r\w*|fractur\w*|stroke|an(?:a)?emi\w*|copd|tuberculosis|malaria|dengue|covid\w*|pregnan\w*|obes\w*|depress\w*|anxiety|epilep\w*|migraine|anaphyla\w*|angioedema|bronchospasm|shock|hives|urticaria|swelling|threatening|dangerous|contraindicat\w*|toxic\w*|overdos\w*|seizure\w*|arrest|bleed\w*|h(?:a)?emorrhag\w*|thrombo\w*|embol\w*|isch(?:a)?emi\w*|infarct\w*|jaundice|intoleran\w*)$|(?:itis|osis|emia|aemia|pathy|oma|algia|uria|penia|plegia|ectomy)$/i

/**
 * D2: how far a fact of the consultation context can be trusted is part of what it says, and a statement that restates it keeps it. A statement that rests on a
 * fact of one of these trusts must say so in its own words: a device's reading is "unverified", a simulator's value "SIMULATED", a stethoscope recording "not
 * analysed", a point extracted from the conversation and not yet decided by the doctor "extracted" or "to review" (or "not yet reviewed", "not confirmed"), AI
 * output is the AI's ("AI", "extracted", "draft", "to review", "Mana"). Without them it would hand the doctor the value as more than it is: it is removed. (The
 * consultation tool gives the model no SIMULATED item at all; the rule is there for any fact that ever carries that trust.)
 */
const TRUST_MUST_SAY: Partial<Record<EvidenceTrust, RegExp>> = {
  measured_unverified: /\bunverified\b/i,
  simulated: /\bsimulated\b/i,
  recorded: /\bnot\s+(?:been\s+|yet\s+)?analy[sz]ed\b/i,
  extracted: /\b(?:extracted|to\s+review|not\s+(?:yet\s+)?reviewed|not\s+confirmed)\b/i,
  model_output: /\b(?:AI|extracted|draft|to\s+review|Mana)\b/i,
}
/**
 * Words that make a device's reading or a simulator's value more than it is: "measured", "verified", "confirmed", "accurate", "real". In a statement that rests
 * on such a fact, one of them stands only where a fact it cites has the same word ("not verified" is the label itself, not a claim). "Staff measured" (or
 * "measured by staff") is the staff's measurement, and stands when the statement itself cites a fact entered by staff: the device's reading is still not.
 */
const UPGRADE = /\b(?:measured|measurements?|verified|validated|confirmed|accurate|reliable|real|actual|genuine|calibrated)\b/gi
const NOT_UPGRADE = /\b(?:not|never|un)\s*(?:been\s+|yet\s+)?(?:measured|verified|validated|confirmed|calibrated)\b/gi
const STAFF_MEASURED = /\bstaff\s+measured\b|\bmeasured\s+by\s+(?:the\s+)?staff\b/gi
/**
 * A stethoscope recording that nobody analysed, the measurements of a thermal image, and a simulator's output say all there is to say: a word a statement adds to
 * one of them is a finding that nobody made ("murmur", "crackles", "warmer", "inflamed", "asymmetric", and short ones too: "hot", "red", "rub"). A statement that
 * rests on such a fact uses only the words its facts have (every word of two letters or more, not only the longer ones the general checks read), the words that
 * say where something is in them (REPORTING_WORDS), these plain nouns, and the glue of a sentence (NOTHING_ADDED_GLUE). The words of SHORT_FINDINGS are findings
 * whatever else allows them, and stand only where a fact the statement cites has the same word.
 */
const NOTHING_ADDED: ReadonlySet<EvidenceTrust> = new Set<EvidenceTrust>(['recorded', 'measured', 'simulated'])
const PLAIN_NOUNS = new Set('measurement measurements reading readings value values temperature temperatures image images recording recordings region regions available maximum minimum average mean'.split(' '))
const NOTHING_ADDED_GLUE = new Set('is the of a an and at to it was has no not in on by with for its as or s'.split(' '))
const SHORT_FINDINGS = /\b(?:hot|red|rub|dry|wet|low|raised|cold|warm|bad|high)\b/gi

/**
 * Which side of a patient's record a medicine named in a statement is on: "allergic to X" (the allergy list) is not "takes X" (the medicines). The model is shown
 * both kinds of fact together, and a statement that cites both can swap them; the words of a statement alone ("allergic", "takes", "prescribed") say which side it
 * means, and the fact it cites must be on that side.
 */
const ALLERGY_SIDE = /^(?:allerg\w*|intoleran\w*|reactions?|anaphyla\w*|hives|urticaria)$/i
const TAKING_SIDE = /^(?:tak(?:es|ing|en)|took|prescribed|prescriptions?|medicines?|medications?|regimen|doses?|dosing|course|treated|started|given)$/i
const SIDE_WORDS = /allerg|intoleran|reaction|anaphyla/i
function drugSides(text: string): Map<string, Set<'allergy' | 'taking'>> {
  const out = new Map<string, Set<'allergy' | 'taking'>>()
  for (const sentence of text.split(/[.;!?]+\s+|\n/)) {
    const toks = [...sentence.matchAll(/[A-Za-z][A-Za-z'’-]*/g)].map((m) => m[0].toLowerCase())
    const drugs = new Set(drugLikeWords(sentence))
    toks.forEach((w, i) => {
      if (!drugs.has(w)) return
      let best: { d: number; side: 'allergy' | 'taking' } | null = null
      toks.forEach((c, j) => {
        const side = ALLERGY_SIDE.test(c) ? 'allergy' : TAKING_SIDE.test(c) ? 'taking' : null
        if (!side) return
        const d = Math.abs(i - j)
        if (d <= 6 && (!best || d < best.d || (d === best.d && j < i))) best = { d, side }
      })
      if (best) out.set(w, (out.get(w) ?? new Set()).add((best as { side: 'allergy' | 'taking' }).side))
    })
  }
  return out
}
const onSide = (drug: string, side: 'allergy' | 'taking', facts: AnswerFact[]): boolean =>
  facts.some((f) => {
    const clauses = f.text.split(/[.;\n]/)
    if (side === 'allergy') {
      return f.items.some((i) => i.kind === 'allergy' && `${i.label} ${i.excerpt}`.toLowerCase().includes(drug)) || clauses.some((c) => c.toLowerCase().includes(drug) && SIDE_WORDS.test(c))
    }
    return f.items.some((i) => i.kind === 'prescription' && `${i.label} ${i.excerpt}`.toLowerCase().includes(drug)) || clauses.some((c) => c.toLowerCase().includes(drug) && !SIDE_WORDS.test(c))
  })

const bump = (r: Record<string, number>, k: string) => {
  r[k] = (r[k] ?? 0) + 1
}

/** Reasons that make the whole answer untrusted: a statement that carries one was not written from the facts by a model that kept to them. */
const BLOCKING = new Set(['link', 'action_claim', 'unknown_handle', 'identifier'])

export interface AnswerChecks {
  blocks: ManaAnswerBlock[]
  produced: number
  removed: number
  /** Counts by reason, never text. */
  reasons: Record<string, number>
  /** Set when a statement broke a rule that means the model cannot be trusted for this answer: then no statement of it is shown. */
  blocked: string | null
}

/**
 * What the doctor is told when no statement was shown. It depends on what happened: the answer's statements were all removed or blocked (unverified); the tools
 * found nothing, so the records do not establish it; part of what was read was kept from the model, so the answer is not complete; or the records were read
 * and the model wrote nothing the checks could use (which is not the same as "not recorded").
 */
export function noticeFor(o: { unverified: boolean; blocks: number; withheld: boolean; facts: number }): string | null {
  if (o.unverified) return MANA_UNVERIFIED
  if (o.blocks > 0) return null
  if (o.withheld) return MANA_WITHHELD
  return o.facts > 0 ? MANA_NO_ANSWER : MANA_NOT_ESTABLISHED
}

export interface AnswerCheckInputs {
  question: string
  /** The facts the model was shown. */
  facts: AnswerFact[]
  /** The findings the model was shown (or all of them: only their ids and kinds are used). */
  findings: AnswerFinding[]
  /** The handles of this conversation (P1 ... Pn). */
  aliases: ReadonlySet<string>
  /** Name words of the patients of this conversation (lower case): a statement may use one only if the doctor wrote it or a fact does. */
  patientNames: readonly string[]
  today: string
  outdatedDays: number
}

const itemKey = (i: ManaSourceItem) => `${i.kind}|${i.label}|${i.date ?? ''}|${i.excerpt}`
const DATED_KINDS = new Set(['vital', 'prescription', 'signed_record', 'consultation', 'allergy', 'investigation', 'patient_record'])

export function checkAnswer(out: ManaModelAnswer, inp: AnswerCheckInputs): AnswerChecks {
  const reasons: Record<string, number> = {}
  // The facts and findings are read the way the statements are (compatibility forms made plain, invisible characters out), so that a character is compared
  // with the same character: the micro sign of "µg" is the Greek mu once it is made plain, in a statement and in the fact it restates alike.
  const facts = inp.facts.map((f) => ({ ...f, text: plain(f.text) }))
  const findings = inp.findings.map((f) => ({ ...f, text: plain(f.text) }))
  const byRef = new Map(facts.map((f) => [f.ref, f]))
  const findingByRef = new Map(findings.map((f) => [f.ref, f]))
  const known = new Set<string>([...byRef.keys(), ...findingByRef.keys(), ...inp.aliases])
  const question = plain(inp.question).toLowerCase()
  /** What the doctor typed that identifies someone (an MRN, a telephone number): an answer may repeat it. */
  const typed = new Set([...mrnsIn(question), ...phonesIn(question)])
  /** The text with the identifiers the doctor typed taken out: an identifier that was typed is not a figure that the record has to hold. */
  const withoutTyped = (t: string) => t.replace(MRN_LIKE, (m) => (typed.has(idKey(m)) ? ' ' : m)).replace(PHONE_RUN, (m) => (typed.has(m.replace(/\D/g, '')) ? ' ' : m))
  /** What a fact says, without the handles of patients (a "P1" is not a figure); codes such as "S72.0" or "F32.1" are left as they are. */
  const factText = (f: AnswerFact) => f.text.replace(HANDLE, ' ')
  const poolOf = (fs: AnswerFact[]) => new Set([...figureTokens(withSpelledNumbers(fs.map(factText).join('\n'))), ...isoDateTokens(fs.map((f) => f.text).join('\n'))])
  const allText = facts.map((f) => f.text).join('\n')
  const allWords = new Set(allText.toLowerCase().match(/[a-z][a-z-]+/g) ?? [])
  const conflictKeys = new Set(findings.filter((f) => f.kind === 'conflict').flatMap((f) => f.items.map(itemKey)))
  const conflictFindingRefs = new Set(findings.filter((f) => f.kind === 'conflict').map((f) => f.ref))
  const today = Date.parse(`${inp.today}T00:00:00Z`)
  const old = (i: ManaSourceItem) => !!i.date && DATED_KINDS.has(i.kind) && today - Date.parse(i.date.length === 10 ? `${i.date}T00:00:00Z` : i.date) > inp.outdatedDays * 86_400_000
  const dated = (i: ManaSourceItem) => !!i.date && DATED_KINDS.has(i.kind)
  const factIsOld = (f: AnswerFact) => f.items.some(dated) && f.items.filter(dated).every(old)
  const factWords = (fs: AnswerFact[]) => new Set(fs.map((f) => f.text).join(' ').toLowerCase().match(/[a-z][a-z-]+/g) ?? [])

  const kept: ManaAnswerBlock[] = []
  const seen = new Set<string>()
  let blocked: string | null = null
  // A statement that only restates a finding is not shown twice: the server already shows the finding, in its own words. It is not an unsupported statement
  // either, so it counts as neither produced nor removed.
  let restated = 0

  for (const b of out.blocks) {
    // The text as it reads: forms that only look like other characters are made plain first, so that nothing hides from the rules below.
    // A handle in parentheses or brackets is a handle ("Waiting: (P1)"), not a citation mark: it is written bare, so that it is checked as one and is not taken out.
    const readable = plain(b.text).replace(/[([]\s*(P[1-9]\d?)\s*[)\]]/g, '$1')
    const refsIn = [...new Set(b.refs.map((r) => r.replace(/[[\]\s]/g, '').toUpperCase()))].filter((r) => REF.test(r))
    const valid = refsIn.filter((r) => byRef.has(r) || findingByRef.has(r))
    let cited = valid.filter((r) => byRef.has(r)).map((r) => byRef.get(r)!)
    const citedFindings = valid.filter((r) => findingByRef.has(r)).map((r) => findingByRef.get(r)!)
    // What the cited facts and findings say, to compare words with (a statement that quotes a record that itself says "I have updated ..." is a quotation).
    const citedFlat = [...cited.map((f) => f.text), ...citedFindings.map((f) => f.text)].join('\n').toLowerCase().replace(/\s+/g, ' ')

    // Rules that make the whole answer untrusted.
    if (URLS.test(readable) || MARKDOWN_LINK.test(readable)) {
      bump(reasons, 'link')
      blocked ??= 'link'
      continue
    }
    // Handles are read from the text as the model wrote it: "(P1)" and "[P1]" are taken out of the cleaned text below, and must not hide whom a statement is about.
    const handles = readable.match(HANDLE) ?? []
    const whole = cleanText(readable, known)
      .replace(/[*`#]+/g, '')
      .replace(/^\s*[-•]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    // "I have updated ...": the model saying it did something. A record that says so in its own words ("I have updated my phone number") is quoted, not
    // claimed: the clause counts as a quotation only if a fact it cites says that very clause (whole words) AND the statement is framed as quoting ("the note
    // reads: ...", in quotation marks).
    const claims = [...whole.matchAll(new RegExp(ACTION_CLAIM.source, 'gi'))]
    const framed = /["“”‘’]|\b(?:says?|said|reads?|states?|stated|notes?|noted|wrote|written|quotes?|quoted|reason|history|plan|assessment|examination|follow[- ]?up)\b/i.test(whole)
    const quotedOnly = (m: RegExpMatchArray) => {
      const clause = whole.slice(m.index ?? 0).split(/[.;!?]/)[0]!.slice(0, 80).toLowerCase().replace(/\s+/g, ' ').trim()
      return framed && clause.length > 0 && new RegExp(`(?<![a-z0-9])${escapeRe(clause)}(?![a-z0-9])`).test(citedFlat)
    }
    if (claims.some((m) => !quotedOnly(m))) {
      bump(reasons, 'action_claim')
      blocked ??= 'action_claim'
      continue
    }
    const unknownHandle = handles.some((a) => !inp.aliases.has(a))
    // A record number or a telephone number that the doctor did not type is the model's own: nothing it was shown has one.
    const strangers = [...mrnsIn(whole), ...phonesIn(whole)].filter((id) => !typed.has(id))
    if (unknownHandle || strangers.length) {
      bump(reasons, unknownHandle ? 'unknown_handle' : 'identifier')
      blocked ??= unknownHandle ? 'unknown_handle' : 'identifier'
      continue
    }

    // Rules that remove one statement.
    const text = fitText(whole, MAX_STATEMENT)
    if (text !== whole) bump(reasons, 'shortened')
    if (!text) {
      bump(reasons, 'empty')
      continue
    }
    if (hasUnreadableDigits(text)) {
      bump(reasons, 'unreadable_digits')
      continue
    }
    // The checks read English: a statement in another script, with a combining mark, or one that hides a Latin word behind look-alike letters cannot be checked,
    // so it is not shown. A letter that a cited fact itself contains ("µg", "β-blocker") is the record's own word, not a change of script.
    // (A letter that looks like a Latin one is never the record's own word: "nо" with a Cyrillic "о" is a way of writing "no" that the rules below would not read.)
    if (hasCombining(text) || foreignLetters(text).some((ch) => LOOKALIKES[ch] !== undefined || !citedFlat.includes(ch.toLowerCase()))) {
      bump(reasons, 'not_english')
      continue
    }
    if (valid.length < new Set(b.refs).size) bump(reasons, 'invalid_ref')
    if (!cited.length && !citedFindings.length) {
      bump(reasons, 'no_source')
      continue
    }
    if (!cited.length) {
      restated++
      continue
    }
    if (ADVICE.test(text)) {
      bump(reasons, 'advice')
      continue
    }
    // A patient's name is the doctor's word or the record's, never the model's own.
    const allLower = allText.toLowerCase()
    if (inp.patientNames.some((n) => hasProperName(text, n) && !hasWord(question, n) && !hasWord(allLower, n))) {
      bump(reasons, 'name_not_given')
      continue
    }
    // Whom a statement is about: each handle in it must be the patient of a fact it cites (a statement about P1 that cites P2's row is the commonest slip of a
    // small model that is given a list of rows).
    const owners = new Set(cited.flatMap((f) => (f.patient ? [f.patient] : [])))
    if (handles.length && handles.some((h) => !owners.has(h))) {
      bump(reasons, 'wrong_patient')
      continue
    }
    // "has been updated", "Allergy added.", "Done.": something said to have been done, in the passive. A record says so of itself, so a cited fact with the
    // same verb supports it; nothing else does.
    const doneWords = [...text.matchAll(PASSIVE_ACTION)].map((m) => m[1]!).concat(BARE_ACTION.exec(text)?.[1] ?? [], INITIAL_ACTION.exec(text)?.[1] ?? [])
    if (doneWords.some((v) => !new RegExp(`\\b${escapeRe(actionStem(v))}`, 'i').test(citedFlat) && !/^done$/i.test(v)) || doneWords.some((v) => /^done$/i.test(v))) {
      bump(reasons, 'action_wording')
      continue
    }

    // Allergy wording: "no allergies" (and its paraphrases) is a claim nobody should be left to read into a gap.
    const spelled = spellNegations(text)
    const citedAll = [...cited.map((f) => f.text), ...citedFindings.map((f) => f.text)]
    if ((NO_ALLERGIES.test(spelled) || ALLERGY_ABSENCE.test(spelled)) && !citedAll.some((t) => NO_ALLERGIES.test(spellNegations(t)) || ALLERGY_ABSENCE.test(spellNegations(t)))) {
      bump(reasons, 'allergy_claim_unsupported')
      continue
    }
    const notAllergicTo = NOT_ALLERGIC_TO.exec(spelled)?.[1]?.toLowerCase()
    if (notAllergicTo && !citedAll.some((t) => /\b(?:not|never)\s+allergic\s+to\b/i.test(spellNegations(t)))) {
      bump(reasons, 'allergy_claim_unsupported')
      continue
    }
    // "Not recorded" is a claim about the record: it needs a fact or a finding that says so.
    if (REPORTS_ABSENCE.test(text) && !citedAll.some((t) => REPORTS_ABSENCE.test(t))) {
      bump(reasons, 'absence_unsupported')
      continue
    }
    // "Nobody", "the queue is empty", "all patients": a claim about everything or nothing, shown only when a cited fact uses the same word.
    const absolutes = [...text.matchAll(ABSOLUTE)].map((m) => m[0].toLowerCase().replace(/\s+/g, ' '))
    if (absolutes.some((w) => !citedFlat.includes(w))) {
      bump(reasons, 'absolute_not_in_source')
      continue
    }
    // Quantities in words: only the words a cited fact uses ("both" also when the statement is about exactly two patients).
    if ([...text.matchAll(VAGUE_COUNT)].some((m) => { const w = m[1]!.toLowerCase().replace(/\s+/g, ' '); return !citedFlat.includes(w) && !(w === 'both' && owners.size === 2) })) {
      bump(reasons, 'quantity_not_in_source')
      continue
    }
    // The state of a visit or an appointment: only one a cited fact gives.
    if ([...text.matchAll(STATUS_WORD)].some((m) => !new RegExp(statusStem(m[1]!), 'i').test(citedFlat)) || [...text.matchAll(MED_STATUS)].some((m) => !citedFlat.includes(medStem(m[1]!)))) {
      bump(reasons, 'status_not_in_source')
      continue
    }

    // Figures: each must be in a fact the statement cites; failing that, in another fact ABOUT THE SAME PATIENT (or about no patient) that the model was shown
    // (which is then added to what it cites, and the statement is marked: a figure that belongs to another record than the one cited is how a date and a reading
    // get mixed). A fact about another patient is never added: a time or a token number of P2 is not a time or a token number of P1.
    let sourcesAdded = false
    /** The facts the statement itself cites (before any is added for a figure). */
    const ownRefs = new Set(cited.map((f) => f.ref))
    const wanted = figuresIn(withSpelledNumbers(withoutTyped(text)), '', known)
    if (wanted.length) {
      const citedPool = poolOf(cited)
      const missing = wanted.filter((n) => !citedPool.has(n))
      if (missing.length) {
        const patients = new Set(cited.flatMap((f) => (f.patient ? [f.patient] : [])))
        const candidates = facts.filter((f) => !cited.includes(f) && (f.patient === null || patients.size === 0 || patients.has(f.patient)))
        const covered = new Set(candidates.flatMap((f) => [...poolOf([f])]))
        if (missing.some((n) => !covered.has(n))) {
          bump(reasons, 'figure_not_in_record')
          continue
        }
        const extra = candidates.filter((f) => missing.some((n) => poolOf([f]).has(n)))
        cited = [...cited, ...extra].slice(0, 8)
        bump(reasons, 'source_added')
        sourcesAdded = true
      }
    }
    // The months and the mornings and evenings: "4 Oct" is not "4 Sep" and "9:15 pm" is not "9:15 am", though the figures alone are the same.
    const citedText = cited.map((f) => f.text).join('\n')
    const pairsWanted = unitPairsIn(text)
    if (pairsWanted.size) {
      const have = unitPairsIn(citedText)
      if ([...pairsWanted].some((k) => !have.has(k))) {
        bump(reasons, 'unit_not_in_record')
        continue
      }
    }
    const monthsWanted = monthsIn(text)
    if (monthsWanted.size) {
      const have = monthsIn(citedText)
      if ([...monthsWanted].some((n) => !have.has(n))) {
        bump(reasons, 'month_not_in_record')
        continue
      }
    }
    const timesWanted = timesIn(text)
    if (timesWanted.size) {
      const have = timesIn(citedText)
      if ([...timesWanted].some((t) => !have.has(t))) {
        bump(reasons, 'time_not_in_record')
        continue
      }
    }

    // D2: the trust of the facts a statement rests on (those it cites, and any added above for a figure) is kept: said in its words, never raised, and nothing
    // added to a recording, a thermal measurement or a simulator's output (see TRUST_MUST_SAY, UPGRADE and NOTHING_ADDED).
    const trusts = new Set(cited.flatMap((f) => (f.trust ? [f.trust] : [])))
    if ([...trusts].some((t) => TRUST_MUST_SAY[t] && !TRUST_MUST_SAY[t]!.test(text))) {
      bump(reasons, 'trust_not_said')
      continue
    }
    if (trusts.has('measured_unverified') || trusts.has('simulated')) {
      const citedLower = citedText.toLowerCase()
      // "Staff measured" only for a statement that itself cites what staff entered (a fact added above for a figure does not count).
      const staffCited = cited.some((f) => ownRefs.has(f.ref) && f.trust === 'clinician_entered')
      const raised = [...(staffCited ? text.replace(STAFF_MEASURED, ' ') : text).replace(NOT_UPGRADE, ' ').matchAll(UPGRADE)].map((m) => m[0].toLowerCase())
      if (raised.some((w) => !new RegExp(`\\b${escapeRe(w)}\\b`).test(citedLower))) {
        bump(reasons, 'trust_raised')
        continue
      }
    }
    if ([...trusts].some((t) => NOTHING_ADDED.has(t))) {
      const citedLower = citedText.toLowerCase()
      const have = [...new Set(citedLower.match(/[a-z]{2,}/g) ?? [])]
      const added = [...new Set(text.toLowerCase().match(/[a-z]{2,}/g) ?? [])].filter(
        (w) => !NOTHING_ADDED_GLUE.has(w) && !REPORTING_WORDS.has(w) && !PLAIN_NOUNS.has(w) && !inp.patientNames.some((n) => sameWord(n, w)) && !have.some((h) => sameWord(h, w)),
      )
      const short = [...text.matchAll(SHORT_FINDINGS)].map((m) => m[0].toLowerCase()).filter((w) => !new RegExp(`\\b${w}\\b`).test(citedLower))
      if (added.length || short.length) {
        bump(reasons, 'finding_not_in_source')
        continue
      }
    }

    // Doses and regimens: only the ones a cited fact says, in the same words, and as whole numbers ("5 mg" is not in "15 mg").
    if (hasDoseOrRegimen(text)) {
      const citedLower = citedText.toLowerCase().replace(/\s+/g, ' ')
      const asWritten = (text.match(new RegExp(`${DOSE.source}|${REGIMEN.source}`, 'gi')) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, ' ').trim())
      if (!asWritten.every((m) => new RegExp(`(?<![\\d.,])${escapeRe(m)}(?!\\d)`).test(citedLower))) {
        bump(reasons, 'dose_or_regimen')
        continue
      }
    }

    // Medicines: a medicine is named only when a cited fact names it. (One that only another fact names is a statement that cites the wrong record, and the
    // record it cites is what the doctor opens: it is removed, not repaired.)
    const citedWords = factWords(cited)
    const looseDrugs = drugLikeWords(text).filter((d) => !citedWords.has(d))
    if (looseDrugs.length) {
      bump(reasons, looseDrugs.some((d) => !allWords.has(d)) ? 'new_medicine' : 'medicine_not_cited')
      continue
    }

    // "Allergic to X" needs X on the allergy side of a cited fact, "takes X" on the medicines side.
    if ([...drugSides(text)].some(([drug, sides]) => [...sides].some((side) => !onSide(drug, side, cited)))) {
      bump(reasons, 'medicine_side_mismatch')
      continue
    }

    // A "no" on one side and not the other: the statement affirms what a cited fact denies, or denies what one affirms.
    const denied = new Set(cited.flatMap((f) => [...deniedWords(f.text)]))
    if (contentWords(text).filter((w) => denied.has(w)).some((w) => !negatedIn(w, text))) {
      bump(reasons, 'negation_mismatch')
      continue
    }
    const denies = negatedTerms(text)
    if (denies.size) {
      const sourceDenies = [...new Set(cited.flatMap((f) => [...negatedTerms(f.text)]))]
      const sourceWords = [...new Set(cited.map((f) => f.text).join(' ').toLowerCase().match(/[a-z]{4,}/g) ?? [])]
      if ([...denies].some((t) => !sourceDenies.some((s) => sameWord(s, t)) && sourceWords.some((w) => sameWord(w, t)))) {
        bump(reasons, 'negation_mismatch')
        continue
      }
    }

    // Wording, held against the cited facts ALONE (the doctor's question is not a source: a statement that repeats a word of the question is not thereby
    // true). A statement with nothing in it that the facts say ("No.", "Ok.", "None.") says nothing that can be checked and is not shown; one that uses a word
    // that claims something (a severity, a state, a diagnosis) that its facts do not contain, or is made mostly of words they do not contain, was not drawn
    // from them and is removed; one that adds a plain word of its own is shown, marked.
    const flags: ManaAnswerBlock['flags'] = []
    const ground = citedText
    // A patient's name is the doctor's word or the record's (checked above, with the names of the patients); a word that says which way a reading went is
    // checked against the facts' own direction (below).
    const own = [...new Set(contentWords(text))].filter((w) => !GLUE.has(w))
    const looseWords = wordsNotIn(text, ground).filter((w) => !REPORTING_WORDS.has(w) && !UP.test(w) && !DOWN.test(w) && !inp.patientNames.some((n) => sameWord(n, w)))
    // (Also true of a statement with no content words at all: `every` is true of an empty list.)
    if (own.every((w) => wordsNotIn(w, ground).length > 0)) {
      bump(reasons, 'no_content')
      continue
    }
    const claim = new Set(contentWords(text).filter((w) => !GLUE.has(w)))
    if (looseWords.some((w) => CLAIM_WORD.test(w)) || (looseWords.length >= 2 && looseWords.length * 2 >= claim.size)) {
      bump(reasons, 'claim_not_in_source')
      continue
    }
    // Which way something went: only the way the cited facts say.
    if (directionOf(text) & ~directionOf(ground)) {
      bump(reasons, 'direction_not_in_source')
      continue
    }
    if (looseWords.length >= 1) flags.push('wording_differs')
    // Wording that states a diagnosis as a fact, where the facts do not.
    if ((CERTAINTY.test(text) && !CERTAINTY.test(ground)) || (DIAGNOSED.test(text) && !DIAGNOSED.test(ground) && !/diagnos/i.test(ground))) {
      bump(reasons, 'assertive_wording')
      continue
    }

    if (cited.some((f) => f.items.some((i) => conflictKeys.has(itemKey(i)))) || citedFindings.some((f) => conflictFindingRefs.has(f.ref))) flags.push('involves_conflict')
    if (cited.length && cited.every(factIsOld)) flags.push('record_outdated')
    if (sourcesAdded) flags.push('sources_added')

    const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (seen.has(norm)) {
      bump(reasons, 'duplicate')
      continue
    }
    seen.add(norm)
    kept.push({ text, refs: [...cited.map((f) => f.ref), ...citedFindings.map((f) => f.ref)], flags: [...new Set(flags)] })
  }

  const produced = out.blocks.length - restated
  const removed = Object.entries(reasons)
    .filter(([k]) => !['invalid_ref', 'source_added', 'shortened'].includes(k))
    .reduce((n, [, v]) => n + v, 0)
  // A blocking reason empties the answer: the statements that were fine are not shown either (the model was not keeping to the facts).
  const blockedReason = blocked ?? (Object.keys(reasons).find((r) => BLOCKING.has(r)) ?? null)
  return { blocks: blockedReason ? [] : kept, produced, removed: blockedReason ? produced : removed, reasons, blocked: blockedReason }
}
