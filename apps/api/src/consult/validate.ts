import { CONSULT_SECTION_KEYS, type ConsultSection, type DraftValidation, FACT_SECTIONS, type ItemFlag, SUGGESTION_SECTIONS, type SupportState } from '@adaxai/contracts'
import { dayOf } from '../mana/assistant/format.ts'
import type { ConsultOutput, FactStatement, SuggestionStatement } from './prompt.ts'
import type { ConsultationInputs, SourceItem } from './inputs.ts'

/**
 * The checks that run after the model and decide what the doctor is shown. They are explicit rules, not another model: every statement must rest
 * on record items that exist; every figure in it must be in the items it cites (or, failing that, in an item the model was shown, which is then
 * added to what it cites); a suggestion never carries a dose or a regimen; a medicine the record does not contain is not named; a statement that
 * reverses a "no" in its source is flagged; and the support state of each statement is set here from the cited items (never taken from the model's
 * word). What cannot be checked this way is left to the doctor and says so on the screen. These rules reduce the chance of an unsupported
 * statement reaching the doctor; they do not make a statement true.
 */

/**
 * v2: the age of a cited item is read on the facility's calendar (an item measured just after local midnight is today's, not yesterday's), and the digit of a
 * symbol such as SpO₂ is not a figure, however it is written.
 */
export const VALIDATION_VERSION = 'consult-checks-v2'

export interface ValidatedItem {
  section: ConsultSection
  position: number
  text: string
  support: SupportState
  rationale: string | null
  uncertainty: string | null
  flags: ItemFlag[]
  /** Stable keys of the record items it rests on (cited ones that exist, plus any added because a figure was found only there). */
  sourceKeys: string[]
  sourceRefs: string[]
  /** The doctor must tick "I have checked this" before accepting it. */
  needsConfirmation: boolean
}

export interface ValidationResult {
  items: ValidatedItem[]
  stats: DraftValidation
  insufficient: boolean
}

export interface ValidateOptions {
  outdatedDays: number
}

// --- text helpers --------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g
const TAGS = /<\/?[a-z][^>]*>/gi
/** What a doctor is shown of a statement, its reason and its uncertainty at most (the database holds 400 for a statement). */
const MAX_STATEMENT = 360
const MAX_RATIONALE = 240
const MAX_UNCERTAINTY = 200
export const URLS = /\b(?:https?:\/\/|www\.)\S+/i
const REF_MARKS = /[[(]\s*[A-Z]{1,2}\d{1,3}(?:\s*[,;/]\s*[A-Z]{1,2}\d{1,3})*\s*[\])]/g

/**
 * Model text without markup, control characters and source markers. A marker in square brackets is always taken out ("[A1]"); one in parentheses only
 * when it names a source the model was shown ("(A1)"), because a record's own codes look the same ("(E11)", "(J45)" are diagnosis codes, not citations).
 */
export function cleanText(raw: string, knownRefs?: ReadonlySet<string>): string {
  // Compatibility forms become plain ones (fullwidth digits and letters), and characters that only format text (zero-width spaces, soft hyphens, the
  // marks that reverse the direction of text) are taken out, so that none of them can hide a word or a figure from the checks that follow. The digit of
  // a symbol or a unit (the ₂ of SpO₂) stays as it is written: see SYMBOL_SCRIPT_DIGIT.
  const plain = asciiDigits(plainForms(raw)).replace(/\p{Cf}/gu, '')
  const withoutMarks = plain.replace(CONTROL, ' ').replace(TAGS, ' ').replace(REF_MARKS, (m) => (m.startsWith('[') || !knownRefs || (m.match(/[A-Z]{1,2}\d{1,3}/g) ?? []).every((id) => knownRefs.has(id)) ? ' ' : m))
  return withoutMarks.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim()
}

/** Superscript and subscript digits: ⁰ ¹ ² ³ ⁴ to ⁹, and ₀ to ₉. */
const SCRIPT_DIGITS = '\\u00b2\\u00b3\\u00b9\\u2070\\u2074-\\u2079\\u2080-\\u2089'
/**
 * A superscript or subscript digit that is part of a symbol or a unit, not a figure: ONE such digit right after a letter, with no digit after it (the ₂
 * of SpO₂, CO₂ or H₂O, the ² of m²). The record writes these as they are, and its figures are read without them; made plain, the model's "SpO₂ 94 %"
 * would claim a "2" that no record holds. A run of them, or one after a digit or on its own ("³⁹"), is made plain like any other digit and checked.
 */
const SYMBOL_SCRIPT_DIGIT = new RegExp(`(?<=\\p{L})[${SCRIPT_DIGITS}](?!\\p{N})`, 'gu')

/** Compatibility forms made plain (NFKC), except the digit of a symbol or a unit, which is kept as it is written (see SYMBOL_SCRIPT_DIGIT). */
function plainForms(s: string): string {
  let out = ''
  let at = 0
  for (const m of s.matchAll(SYMBOL_SCRIPT_DIGIT)) {
    out += s.slice(at, m.index).normalize('NFKC') + m[0]
    at = m.index + m[0].length
  }
  return out + s.slice(at).normalize('NFKC')
}

/**
 * The oxygen and carbon dioxide symbols written with a plain 2 (SpO2, SaO2, PaO2, FiO2, PaCO2, EtCO2, PCO2, CO2, O2), as a model or a note may write
 * them: the 2 is part of the name, not a figure. With a subscript ₂ it is no figure already (only 0 to 9 are read as figures).
 */
const GAS_SYMBOL = /\b((?:Sp|Sa|Pa|Fi|Et|P)?C?O)2(?![0-9])/gi
/**
 * A text without the digit of those symbols ("SpO2 94 %" becomes "SpO 94 %"). The consultation checks read figures from this, on the record's side and
 * on the statement's alike: a statement that writes SpO2 against a record that writes SpO₂ (or the other way round) claims only the figures it gives,
 * and no record gains a "2" for a made-up figure to rest on.
 */
export const withoutSymbolDigits = (text: string): string => text.replace(GAS_SYMBOL, '$1')

/** The first digit (zero) of the decimal digit blocks of the scripts this product is likely to meet; a digit of any other block is left as it is and refused. */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0xa620, 0xa8d0, 0xa900, 0xaa50, 0xabf0, 0xff10]
export function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (d) => {
    const cp = d.codePointAt(0)!
    if (cp < 0x80) return d
    const zero = DIGIT_ZEROS.filter((z) => z <= cp).at(-1)
    return zero !== undefined && cp - zero <= 9 ? String(cp - zero) : d
  })
}
/** A digit that is not one of 0 to 9 after the conversion above: a figure the checks cannot read. */
export const hasUnreadableDigits = (s: string): boolean => /(?![0-9])\p{Nd}/u.test(s)

/**
 * Cuts a statement the model ran on with down to `max` characters: at the end of its last whole sentence when that keeps most of it, otherwise at a
 * word, with an ellipsis. The model's own answer is allowed to be longer than what is shown, so that it is never cut in the middle of a word by the
 * runtime's grammar.
 */
export function fitText(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), /[.!?]$/.test(head) ? head.length - 1 : -1)
  if (stop >= max * 0.5) return head.slice(0, stop + 1)
  const space = head.lastIndexOf(' ')
  return `${head.slice(0, space > max * 0.5 ? space : max - 1).trimEnd()}…`
}

const WORD_NUMBERS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100' }
const WORD_NUMBER_BEFORE_UNIT = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join('|')})[\\s-]+(?=(?:day|week|month|year|hour|minute|time|tablet|capsule|dose|spoon|puff|drop)s?\\b)`, 'gi')
const TENS_WORDS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety'
const UNITS_WORDS = 'one|two|three|four|five|six|seven|eight|nine'
const TENS_AND_UNITS = new RegExp(`\\b(${TENS_WORDS})[\\s-]+(${UNITS_WORDS})\\b`, 'gi')
/** Numbers of ten and over written in words ("thirty nine", "twelve", "ninety"): ordinary prose does not use these as anything but figures. */
const BIG_WORD_NUMBER = new RegExp(`\\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|${TENS_WORDS}|hundred)\\b`, 'gi')

/** Every number in a text as a comparable token: decimals kept, leading zeros dropped ("04" and "4" are the same), "three days" counted as 3, "thirty nine" as 39. */
export function numbersIn(text: string): string[] {
  const t = text
    .replace(REF_MARKS, ' ')
    .replace(TENS_AND_UNITS, (_m, tens: string, unit: string) => ` ${Number(WORD_NUMBERS[tens.toLowerCase()]) + Number(WORD_NUMBERS[unit.toLowerCase()])} `)
    .replace(BIG_WORD_NUMBER, (_m, w: string) => ` ${WORD_NUMBERS[w.toLowerCase()]} `)
    .replace(WORD_NUMBER_BEFORE_UNIT, (_m, w: string) => `${WORD_NUMBERS[w.toLowerCase()]} `)
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')
  const out: string[] = []
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const [int, frac] = m[0].split('.')
    out.push(`${String(Number(int))}${frac !== undefined ? `.${frac.replace(/0+$/, '')}`.replace(/\.$/, '') : ''}`)
  }
  return out
}

/** Dates as the record writes them (2026-02-10, with or without a time). */
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g

/**
 * The figures of a text as comparable tokens: its numbers, and each ISO date as ONE token (and its year as a number). A date is not split into a day
 * and a month, because those small numbers would then be in the pool of every record that holds a date, and a made-up "respiratory rate 12" would
 * find a "12" to rest on.
 */
export function figureTokens(text: string): string[] {
  const dates: string[] = []
  const rest = text.replace(ISO_DATE, (_m, y: string, mo: string, d: string) => {
    dates.push(`d:${y}-${mo}-${d}`, String(Number(y)))
    return ' '
  })
  return [...numbersIn(rest), ...dates]
}

/** The patient's age band as the model was told it ("50-59", "90+"). */
const ageBandOf = (patientLine: string): string | null => /^(\d+-\d+|\d+\+)/.exec(patientLine)?.[1] ?? null

/**
 * The figures a statement claims, leaving out the age band the model was given (context, not a measurement) and the ids of sources it names in
 * passing ("as R1 says": the "1" there is not a figure).
 */
export function figuresIn(text: string, patientLine: string, knownRefs?: ReadonlySet<string>): string[] {
  const band = ageBandOf(patientLine)
  const t = text.replace(/[–—]/g, '-').replace(/\b[A-Z]{1,2}\d{1,3}\b/g, (m) => (knownRefs?.has(m) ? ' ' : m))
  return figureTokens(band ? t.split(band).join(' ') : t)
}

/** "No allergies" in any of its short forms. */
export const NO_ALLERGIES = /\b(?:(?:no|none|nil|denies|denied)\s+(?:known\s+)?(?:history\s+of\s+)?(?:drug\s+|food\s+|medicine\s+)?(?:or\s+(?:drug|food|medicine)\s+)?allerg(?:y|ies)|nkda|nka|allerg(?:y|ies)\s*(?:status)?\s*[:-]?\s*(?:nil|none|negative))\b/i
/** "Not allergic to X": a claim about one substance. */
export const NOT_ALLERGIC_TO = /\b(?:not|never)\s+allergic\s+to\s+([a-z-]{4,})/i

/** Doses, strengths and regimens: never in a suggestion unless the cited record has the same words. */
export const DOSE = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|ug|g|kg|ml|mL|l|iu|units?|tablets?|tabs?|caps?|capsules?|drops?|puffs?|sachets?|%|mmol|meq|grams?|milligrams?|micrograms?|millilit(?:re|er)s?|lit(?:re|er)s?|teaspoons?|tablespoons?|ampoules?|patch(?:es)?|sprays?|lozenges?)\b/i
export const REGIMEN = /\b(?:once|twice|thrice)\s+(?:a\s+|per\s+)?(?:daily|day|week)\b|\b(?:od|bd|bid|tds|tid|qid|qds|prn|stat|nocte|mane)\b|\bevery\s+\d+\s*(?:hours?|hrs?|days?|weeks?)\b|\b\d+\s*times?\s+(?:a|per)\s+day\b|\bfor\s+\d+\s*(?:days?|weeks?|months?)\b/i
/** What only a suggestion is held to: any way of saying how much, how often or for how long, in words as well as figures. */
const SUGGESTED_REGIMEN = /\b(?:daily|nightly|weekly|hourly|at\s+(?:bed\s?time|night)|every\s+(?:\w+\s+){0,2}(?:day|night|morning|evening|week|hour)s?|(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+times|for\s+(?:a|an|one|two|three|four|five|six|seven|\d+)\s+(?:day|week|month)s?|(?:morning|evening)\s+and\s+(?:morning|evening|night))\b/i
export const hasDoseOrRegimen = (t: string, strict = false): boolean => DOSE.test(t) || REGIMEN.test(t) || (strict && SUGGESTED_REGIMEN.test(t))

/** Words that look like the name of a medicine: a short list of common names and the endings most medicines share. A safety net, not a drug dictionary. */
const DRUG_ENDINGS = /(?:cillin|mycin|micin|floxacin|oxacin|cycline|conazole|azole|pril|sartan|olol|dipine|statin|formin|gliptin|gliflozin|glitazone|prazole|tidine|triptan|caine|zepam|zolam|oxetine|pramine|triptyline|setron|terol|solone|sone|profen|fenac|coxib|vir|parin|xaban|fibrate|phylline|lukast|barbital|codone|morphone|mectin|quine|olac|tinib|mab|navir|vudine|tadine|zolid|penem|bactam|platin|taxel|lamide|thiazide|semide|sulfa|cef[a-z]{3,}|ceph[a-z]{3,})$/i
const DRUG_NAMES = new Set(
  'paracetamol acetaminophen aspirin insulin warfarin heparin digoxin morphine codeine tramadol diazepam lorazepam amoxicillin ampicillin penicillin cephalexin cefixime ceftriaxone azithromycin erythromycin doxycycline ciprofloxacin levofloxacin metronidazole nitrofurantoin cotrimoxazole trimethoprim fluconazole metformin glimepiride gliclazide atenolol amlodipine losartan telmisartan ramipril enalapril lisinopril propranolol bisoprolol furosemide hydrochlorothiazide spironolactone atorvastatin rosuvastatin simvastatin clopidogrel omeprazole pantoprazole ranitidine famotidine domperidone ondansetron salbutamol budesonide fluticasone montelukast cetirizine loratadine chlorpheniramine prednisolone prednisone dexamethasone hydrocortisone ibuprofen diclofenac naproxen levothyroxine thyroxine amitriptyline sertraline fluoxetine escitalopram gabapentin pregabalin carbamazepine phenytoin valproate levetiracetam tamsulosin finasteride allopurinol colchicine ors zinc ivermectin hydroxychloroquine chloroquine ketorolac clindamycin gentamicin amikacin vancomycin linezolid meropenem imipenem rifampicin isoniazid pyrazinamide ethambutol albendazole mebendazole praziquantel acyclovir oseltamivir nifedipine verapamil diltiazem captopril hydralazine methyldopa clonidine prazosin labetalol carvedilol nebivolol indapamide chlorthalidone glipizide pioglitazone sitagliptin linagliptin dapagliflozin empagliflozin sulfasalazine methotrexate azathioprine tacrolimus cyclosporine tamoxifen letrozole anastrozole risperidone olanzapine quetiapine haloperidol clozapine lithium lamotrigine topiramate clonazepam alprazolam zolpidem melatonin promethazine hyoscine loperamide bisacodyl lactulose senna esomeprazole rabeprazole lansoprazole sucralfate misoprostol tranexamic ferrous cholecalciferol adrenaline epinephrine atropine ketamine propofol fentanyl oxycodone buprenorphine naloxone nicotine'.split(' '),
)
const NOT_DRUGS = new Set(['nephrol', 'routine', 'medicine', 'medicines', 'medicinal', 'vaccine', 'saline', 'baseline', 'asthma', 'lesion', 'surgery', 'allergy', 'diabetes', 'pressure', 'hypertension', 'hypotension', 'sone', 'tone', 'zone', 'bone', 'phone', 'stone', 'alone', 'done', 'none', 'gone', 'one', 'ovarian', 'vir', 'service'])

export function drugLikeWords(text: string): string[] {
  const out = new Set<string>()
  // A name cannot be hidden by a character that only formats text, or by a hyphen inside it.
  const plain = text.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase()
  for (const w of [...(plain.match(/[a-z][a-z-]{2,}/g) ?? []), ...(plain.replace(/([a-z])-(?=[a-z])/g, '$1').match(/[a-z]{3,}/g) ?? [])]) {
    if (NOT_DRUGS.has(w)) continue
    if (DRUG_NAMES.has(w) || (w.length >= 6 && DRUG_ENDINGS.test(w))) out.add(w)
  }
  return [...out]
}

const NEGATION_CUE = /\b(?:no|not|denies|denied|without|negative|nil|absent|absence|never|none|nor)\b/
/** Cues that can also come last ("Allergies: nil.", "Chest pain: negative"): then what they deny is in front of them. */
const POSTPOSED_CUE = new Set(['nil', 'none', 'negative', 'absent'])
const STOP = new Set('the and for with that this from have has had was were are been being his her their its into onto over than then also but not any all one two per for due'.split(' '))

/** "isn't" and "doesn't" are "is not" and "does not", whatever kind of apostrophe was typed. */
export const spellNegations = (text: string): string => text.toLowerCase().replace(/[’‘`]/g, "'").replace(/\b(\w+?)n't\b/g, '$1 not').replace(/\bcannot\b/g, 'can not')

/** Words of a text that sit inside the reach of a "no", "not", "denies" or "without": the things the text says are NOT so. */
export function negatedTerms(text: string): Set<string> {
  const out = new Set<string>()
  const words = spellNegations(text).replace(/[^a-z0-9\s.,;:/-]/g, ' ').split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const cue = words[i]!.replace(/[.,;:]/g, '')
    if (!NEGATION_CUE.test(cue)) continue
    // A cue that ends its clause ("Chest pain negative;") denies nothing after it.
    const closes = i === words.length - 1 || /[.;]$/.test(words[i]!)
    for (let j = i + 1; !closes && j < Math.min(words.length, i + 5); j++) {
      const w = words[j]!
      const bare = w.replace(/[.,;:]/g, '')
      if (bare.length >= 4 && !STOP.has(bare)) out.add(bare)
      // A clause ends the reach of the negation.
      if (/[.;:]$/.test(w)) break
    }
    // "Allergies: nil." ends with its cue: what it denies is the words in front of it, in the same clause.
    if (POSTPOSED_CUE.has(cue) && closes) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const bare = words[j]!.replace(/[.,;:]/g, '')
        if (bare.length >= 4 && !STOP.has(bare)) out.add(bare)
        if (/[.;]$/.test(words[j]!)) break
      }
    }
  }
  return out
}

export const contentWords = (t: string): string[] => (t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w))

/**
 * Words that make no claim of their own, so they are not looked for in the items a statement cites: the patient and the record themselves, the
 * ways a statement says where it comes from, number words and units of time (the figure checks see the numbers), and plain function words.
 */
export const GLUE = new Set(
  ('patient patients presents presenting presented history record recorded records documented noted reported reports states stated shows showing today visit current currently consultation doctor ' +
    'draft drafted listed including includes included according taking taken takes prescribed prescription measured staff during while about after before when where which what there these ' +
    'those them they will would could should might must does done same still again further details detail information ' +
    'possibly probably likely perhaps maybe appears seems suggests suggestive consistent ' +
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand ' +
    'days weeks months years hours minutes').split(' '),
)

const SUFFIXES = ['ness', 'ing', 'ed', 'es', 'ly', 's']
const stemOf = (w: string): string => {
  for (const s of SUFFIXES) if (w.length - s.length >= 4 && w.endsWith(s)) return w.slice(0, -s.length)
  return w
}
/** The same word, allowing for endings (cough, coughing, coughs; breathless, breathlessness). A long stem is also matched on its first six letters. */
export const sameWord = (a: string, b: string): boolean => {
  if (a === b) return true
  const x = stemOf(a)
  const y = stemOf(b)
  return x === y || (x.length >= 7 && y.length >= 7 && x.slice(0, 6) === y.slice(0, 6))
}

/** The words of `text` that carry a claim and are in no form in `source`. */
export function wordsNotIn(text: string, source: string): string[] {
  const have = [...new Set(source.toLowerCase().match(/[a-z]{4,}/g) ?? [])]
  return [...new Set(contentWords(text))].filter((w) => !GLUE.has(w) && !have.some((h) => sameWord(h, w)))
}

/** True when `term` occurs in `text` with a negation cue within the three words before it. */
export function negatedIn(term: string, text: string): boolean {
  const words = spellNegations(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  return words.some((w, i) => w === term && words.slice(Math.max(0, i - 3), i).some((p) => NEGATION_CUE.test(p)))
}

/**
 * What a statement that something is NOT documented asks for, and what in a record item would show that it is documented after all. The first
 * concept a statement is about is the one that counts (in "the duration of the fever" the thing missing is the duration). A short list of the things a
 * doctor asks first; a safety net for the commonest wrong "missing" (a small model listing "duration not documented" when the reason for the visit
 * says "for three days"), not a medical dictionary.
 */
const UNIT = '(?:days?|weeks?|months?|years?|hours?|minutes?)'
const DURATION_EVIDENCE = new RegExp(
  [
    `\\b(?:for|since|over|during|past|last)\\s+(?:\\w+\\s+){0,3}${UNIT}\\b`,
    `\\b(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|few|couple of)\\s*${UNIT}\\b`,
    '\\b(?:a|an)\\s+(?:week|month|year|fortnight)\\b',
    '\\bsince\\s+(?:yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this|last|childhood|birth|\\d{4})\\b',
    '\\b(?:overnight|yesterday|this morning|this evening|last night)\\b',
  ].join('|'),
  'i',
)
const ABSENCE_CONCEPTS: [RegExp, RegExp][] = [
  [/\bduration\b|\bhow long\b|\bonset\b|\bwhen (?:it|this) started\b/i, DURATION_EVIDENCE],
  [/\btemperature\b|\bfever\b/i, /\btemperature\b|°c|\bfever\b/i],
  [/\bweight\b/i, /\bweight\b|\bkg\b/i],
  [/\bblood pressure\b|\bbp\b/i, /\bblood pressure\b|\bmmhg\b/i],
  [/\bheart rate\b|\bpulse\b/i, /\bheart rate\b|\bbpm\b|\bpulse\b/i],
  // SpO2 with a plain or a subscript 2: the record writes SpO₂, and a statement keeps the ₂ it was written with (see SYMBOL_SCRIPT_DIGIT).
  [/\boxygen\b|\bspo[2₂](?![0-9])|\bsaturation\b/i, /\boxygen\b|\bsaturation\b|\bspo[2₂](?![0-9])/i],
  [/\ballerg/i, /\ballerg/i],
  [/\bmedicines?\b|\bmedications?\b|\bdrugs?\b/i, /\bmedicine\b|\bmedication\b|\btablet\b|\bcapsule\b|\binhaler\b/i],
  [/\bvital signs?\b/i, /\btemperature\b|\bblood pressure\b|\bheart rate\b|\boxygen\b|\brespiratory rate\b/i],
]

/** An item that itself says the thing is not recorded cannot contradict a statement that it is not recorded. */
export const REPORTS_ABSENCE = /\b(?:not recorded|not documented|none recorded|no [a-z ]{1,30} recorded)\b/i
/** A sentence that says something is not on record (and not a negative finding such as "no cough") has absence wording and a word about the record. */
const DOCUMENTATION_VERB = /\b(?:recorded|documented|stated|mentioned|available|specified|provided|noted)\b/i
const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+/).filter(Boolean)

/** Words of an "is not documented" statement that only say it is not documented. */
const ABSENCE_FILLER = new Set('documented recorded record noted information missing unknown unclear available known stated mentioned present this visit patient patients'.split(' '))
/** Generic nouns of such a statement: what is left of it, once these go too, is what it names (the fever, the sore throat, the blood pressure). */
const ABSENCE_GENERIC = new Set('duration onset started long main symptom symptoms problem complaint illness condition patient current reading readings value measurement result status level vital signs sign'.split(' '))

export const ASSERTIVE = /\b(?:diagnos(?:is|ed)\s+(?:is|with|of)|has\s+been\s+diagnosed|is\s+suffering\s+from|confirmed\s+(?:case|diagnosis)|definitely|certainly|without\s+(?:a\s+)?doubt|proves?|must\s+be|is\s+caused\s+by|clearly\s+has|has\s+(?:a\s+)?(?:pneumonia|infection|cancer|diabetes|asthma|tuberculosis|malaria|dengue|covid))\b/i
const CONFLICT_WORDS = /\b(?:conflict\w*|disagree\w*|contradict\w*|inconsisten\w*|discrepan\w*)\b/i

// --- the validator -------------------------------------------------------------------------------------------------------------------------

interface Candidate {
  section: ConsultSection
  text: string
  refs: string[]
  basis: 'stated' | 'inferred' | 'not_found'
  rationale: string | null
  uncertainty: string | null
}

const isFactStatement = (x: FactStatement | SuggestionStatement): x is FactStatement => 'basis' in x

function candidatesOf(out: ConsultOutput): Candidate[] {
  const list: Candidate[] = []
  for (const section of CONSULT_SECTION_KEYS) {
    const raw = out[section as keyof ConsultOutput]
    const arr = (Array.isArray(raw) ? raw : raw ? [raw] : []) as (FactStatement | SuggestionStatement)[]
    for (const s of arr) {
      list.push(
        isFactStatement(s)
          ? { section, text: s.text, refs: s.refs, basis: s.basis, rationale: null, uncertainty: s.uncertainty }
          : { section, text: s.text, refs: s.refs, basis: 'inferred', rationale: s.rationale, uncertainty: s.uncertainty },
      )
    }
  }
  return list
}

/** The text a figure or a word can be found in: what the model was shown for the item, including its date and field. */
const sourceHaystack = (i: SourceItem) => `${i.date ?? ''} ${i.field} ${i.status} ${i.text}`

const bump = (r: Record<string, number>, k: string) => {
  r[k] = (r[k] ?? 0) + 1
}

/** Wording that says something is absent. A statement the model labels "not found" must carry some: the label is not a way past the checks a claim gets. */
const ABSENCE_WORDING = /\b(?:no|not|none|nil|never|without|absent|absence|missing|unknown|unclear|lack(?:s|ing)?|undocumented|unrecorded|unavailable|unspecified)\b/i
/** Wording of the past: a statement that has it may rest on an item that is stopped, resolved or old. */
const PAST_CUE = /\b(?:stopped|discontinued|resolved|inactive|ended|previous(?:ly)?|former(?:ly)?|past|no longer|was|were|had|used to|history of)\b/i
const RELATIVE = /\b(?:father|mother|brother|sister|sibling|siblings|parent|parents|grandfather|grandmother|grandparents?|uncle|aunt|son|daughter|family)\b/i
const NOW_CUE = /\b(?:today|currently|now|at present|this visit|right now)\b/i
const itemInactive = (i: SourceItem) => /^(?:inactive|stopped|resolved|ended|discontinued)\b/i.test(i.status) || /\b(?:stopped|discontinued|resolved|ended)\b/i.test(i.text)

/**
 * The day an item is from on the facility's calendar, the calendar `inputs.today` is a day of: a date without a time is a day already; a time (stored in
 * UTC) is read in the facility's time zone. Its first ten characters are the UTC day, which in India is the day before until 05:30.
 */
const localDay = (date: string, timeZone: string): string => (date.length === 10 ? date : dayOf(new Date(date), timeZone))
/** Whole calendar days from one day to a later one (as the record rules count the age of an item). */
const daysFrom = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export function validateDraft(out: ConsultOutput, inputs: ConsultationInputs, opts: ValidateOptions): ValidationResult {
  const reasons: Record<string, number> = {}
  const byRef = new Map(inputs.items.map((i) => [i.ref, i]))
  const known = new Set(inputs.items.map((i) => i.ref))
  // Figures are read without the digit of a symbol such as SpO2, on both sides (see withoutSymbolDigits).
  const recordFigures = (t: string) => figureTokens(withoutSymbolDigits(t))
  const claimedFigures = (t: string) => figuresIn(withoutSymbolDigits(t), inputs.patientLine, known)
  const allText = inputs.items.map(sourceHaystack).join('\n')
  const allNumbers = new Set(recordFigures(allText))
  const allWords = new Set(allText.toLowerCase().match(/[a-z][a-z-]+/g) ?? [])
  const activeAllergy = inputs.items.some((i) => i.sourceType === 'allergy' && i.status === 'active')
  const conflictFindings = inputs.recordCheck.conflicts
  const conflictKeys = new Set(conflictFindings.flatMap((c) => c.keys))
  const cands = candidatesOf(out)
  const kept: ValidatedItem[] = []
  const seen = new Set<string>()
  let flagged = 0
  // The day of an item, on the facility's calendar (see localDay).
  const dayOfItem = (i: SourceItem): string | null => (i.date ? localDay(i.date, inputs.timeZone) : null)
  /** From a day before today. */
  const beforeToday = (i: SourceItem): boolean => {
    const day = dayOfItem(i)
    return day !== null && day < inputs.today
  }
  /** Older than the configured age, in whole calendar days. */
  const olderThanAllowed = (i: SourceItem): boolean => {
    const day = dayOfItem(i)
    return day !== null && daysFrom(day, inputs.today) > opts.outdatedDays
  }

  /** A reason or an uncertainty is text the doctor reads too: it is held to what a suggestion is held to, and dropped (not the statement) if it breaks a rule. */
  const vetField = (field: string): boolean => {
    if (!field || URLS.test(field) || hasUnreadableDigits(field)) return false
    if (hasDoseOrRegimen(field, true) || ASSERTIVE.test(field)) return false
    if (drugLikeWords(field).some((d) => !allWords.has(d))) return false
    return claimedFigures(field).every((n) => allNumbers.has(n))
  }

  for (const c of cands) {
    const whole = cleanText(c.text, known)
    const text = fitText(whole, MAX_STATEMENT)
    if (text !== whole) bump(reasons, 'shortened')
    if (!text) {
      bump(reasons, 'empty')
      continue
    }
    if (URLS.test(text)) {
      bump(reasons, 'link')
      continue
    }
    // A digit the checks cannot read is a figure they cannot check.
    if (hasUnreadableDigits(text)) {
      bump(reasons, 'unreadable_digits')
      continue
    }
    const fact = FACT_SECTIONS.includes(c.section) || c.section === 'missing_information' || c.section === 'uncertainties'
    const suggestion = SUGGESTION_SECTIONS.includes(c.section)
    const aboutRecord = fact && c.section !== 'missing_information' && c.section !== 'uncertainties'
    const absenceClaim = c.basis === 'not_found' || c.section === 'missing_information'
    const flags = new Set<ItemFlag>()

    // Cited items that exist. A ref the model made up is dropped, and counted.
    const valid = [...new Set(c.refs)].filter((r) => byRef.has(r))
    if (valid.length < new Set(c.refs).size) bump(reasons, 'invalid_ref')
    let cited = valid.map((r) => byRef.get(r)!)

    // "Not found" says that something is absent. A claim that wears the label to skip the checks a claim gets is not kept (what is listed as missing
    // or uncertain needs no such wording: a list of what is missing is a list of absent things).
    if (c.basis === 'not_found' && c.section !== 'missing_information' && c.section !== 'uncertainties' && !ABSENCE_WORDING.test(text)) {
      bump(reasons, 'not_found_without_absence')
      continue
    }
    if (aboutRecord && c.basis !== 'not_found' && !cited.length) {
      bump(reasons, 'no_source')
      continue
    }
    if (c.basis === 'not_found' && c.section === 'allergies' && activeAllergy) {
      // "No allergies" against a record that lists some: the record wins.
      bump(reasons, 'contradicted_by_record')
      continue
    }
    // "No (known) allergies" is a claim nobody should be left to read into a gap: against a recorded allergy the record wins, and with no cited item
    // that says it in those words, it is marked.
    const spelled = spellNegations(text)
    if (NO_ALLERGIES.test(spelled)) {
      if (activeAllergy) {
        bump(reasons, 'contradicted_by_record')
        continue
      }
      if (!cited.some((i) => NO_ALLERGIES.test(spellNegations(i.text)))) flags.add('wording_not_in_source')
    }
    const notAllergicTo = NOT_ALLERGIC_TO.exec(spelled)?.[1]?.toLowerCase()
    if (notAllergicTo) {
      // "Not allergic to penicillin" against a record that lists an allergy to it: the record wins. Against a record that says nothing about it: marked.
      if (inputs.items.some((i) => i.sourceType === 'allergy' && i.status === 'active' && sourceHaystack(i).toLowerCase().split(/[^a-z]+/).some((w) => w.length >= 4 && sameWord(w, notAllergicTo)))) {
        bump(reasons, 'contradicted_by_record')
        continue
      }
      if (!cited.some((i) => /\b(?:not|never)\s+allergic\s+to\b/i.test(spellNegations(i.text)))) flags.add('wording_not_in_source')
    }

    // Figures: each number (and each date) must be in an item the statement cites; failing that, in an item the model was shown (which is then added);
    // failing that, it is not in the record and the statement does not stay.
    const wanted = claimedFigures(text)
    if (wanted.length) {
      const citedNumbers = new Set(recordFigures(cited.map(sourceHaystack).join('\n')))
      const missing = wanted.filter((n) => !citedNumbers.has(n))
      if (missing.some((n) => !allNumbers.has(n))) {
        bump(reasons, 'figure_not_in_record')
        continue
      }
      if (missing.length) {
        const extra = inputs.items.filter((i) => !cited.includes(i) && missing.some((n) => recordFigures(sourceHaystack(i)).includes(n)))
        cited = [...cited, ...extra].slice(0, 8)
        bump(reasons, 'source_added')
        flags.add('figure_not_in_source')
      }
    }

    // Doses and regimens: allowed in a statement about the record only if the cited items say them; never in a suggestion, in figures or in words (a
    // suggestion may name the medicine the doctor drafted, and the prescription keeps its dose; a dose repeated in a "consider" reads as advice).
    if (hasDoseOrRegimen(text, suggestion)) {
      if (suggestion) {
        bump(reasons, 'dose_or_regimen')
        continue
      }
      const citedText = cited.map(sourceHaystack).join('\n')
      const regimenWords = (text.match(new RegExp(`${DOSE.source}|${REGIMEN.source}`, 'gi')) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, ' ').trim())
      const inCited = regimenWords.every((m) => citedText.toLowerCase().replace(/\s+/g, ' ').includes(m))
      if (!inCited) {
        bump(reasons, 'dose_or_regimen')
        continue
      }
    }

    // Medicines: a medicine the record does not contain is not named by a statement about the record or by a medication consideration.
    const unknownDrugs = drugLikeWords(text).filter((d) => !allWords.has(d))
    if (unknownDrugs.length) {
      if (suggestion && c.section !== 'potential_medication_considerations') flags.add('medicine_not_in_record')
      else {
        bump(reasons, 'new_medicine')
        continue
      }
    }

    // A "no" or "denies" on one side and not on the other: the statement affirms what a cited item denies, or denies what a cited item affirms.
    if (fact && cited.length) {
      if (c.basis !== 'not_found') {
        const negated = new Set(cited.flatMap((i) => [...negatedTerms(i.text)]))
        const myWords = contentWords(text).filter((w) => negated.has(w))
        if (myWords.some((w) => !negatedIn(w, text))) flags.add('negation_unverified')
      }
      const denies = negatedTerms(text)
      if (denies.size) {
        const sourceDenies = [...new Set(cited.flatMap((i) => [...negatedTerms(i.text)]))]
        const sourceWords = [...new Set(cited.map((i) => i.text).join(' ').toLowerCase().match(/[a-z]{4,}/g) ?? [])]
        if ([...denies].some((t) => !sourceDenies.some((s) => sameWord(s, t)) && sourceWords.some((w) => sameWord(w, t)))) flags.add('negation_unverified')
      }
    }

    // A fact in words that the items it cites do not contain is not what the record says, whatever the model called it. A "stated" one is shown as
    // inferred and marked (a summary is held to this less strictly: it is written from many items, so it is looked for in all of them, and one plain
    // word of its own is let through); one made mostly of such words was not drawn from what it cites at all, and is removed. An "inferred" one may go
    // beyond its sources but not have nothing of them: made mostly of words the cited items do not contain, it is marked.
    if (aboutRecord && c.basis !== 'not_found' && cited.length) {
      const summary = c.section === 'summary'
      const ground = `${inputs.patientLine}\n${(summary ? inputs.items : cited).map(sourceHaystack).join('\n')}`
      const loose = wordsNotIn(text, ground)
      const claim = new Set(contentWords(text).filter((w) => !GLUE.has(w)))
      if (c.basis === 'stated') {
        if (loose.length >= 2 && loose.length * 2 >= claim.size) {
          bump(reasons, 'claim_not_in_source')
          continue
        }
        if (loose.length >= (summary ? 2 : 1)) flags.add('wording_not_in_source')
      } else if (loose.length >= 1 && loose.length * 2 >= claim.size) flags.add('wording_not_in_source')

      // What the cited items say about the thing's state and subject: a stopped medicine is not "taken", a relative's illness is not the patient's, and
      // a reading from another day is not "today's".
      if (!summary && cited.some(itemInactive) && !PAST_CUE.test(text)) flags.add('record_status_differs')
      if (!summary && cited.some((i) => RELATIVE.test(`${i.field} ${i.text}`)) && !RELATIVE.test(text)) flags.add('record_subject_differs')
      // ("currently taking" is what a medicine list says: its age is the 180-day rule's business, not this one's.)
      if (['observations', 'symptoms', 'presenting_problem'].includes(c.section) && NOW_CUE.test(text) && cited.every(beforeToday)) flags.add('record_outdated')
    }

    // Wording that states a diagnosis as a fact, where the cited items do not.
    if ((suggestion || c.section === 'summary' || c.basis === 'inferred' || !aboutRecord) && ASSERTIVE.test(text) && !ASSERTIVE.test(cited.map((i) => i.text).join(' '))) flags.add('assertive_wording')

    // An absence the record seems to contradict: what it says is not documented is in an item the model was shown. Either every word the statement
    // is about is in one item, or the thing asked for (a duration, a temperature, a weight ...) is in an item about the same subject. The items are
    // added to what the statement cites, so the doctor sees them; an item the statement already cites counts too (it cannot be both the source and the
    // reason that it is not there). Whatever the statement was labelled, a "missing information" statement is one; and so is a SENTENCE of any other
    // statement about the record that says something is not recorded ("... and the duration of the dizziness is not recorded", in a summary).
    const absentFrom = (sentence: string): SourceItem[] => {
      const hay = (i: SourceItem) => sourceHaystack(i).toLowerCase()
      const about = contentWords(sentence).filter((w) => !ABSENCE_FILLER.has(w))
      const byWords = about.length ? inputs.items.find((i) => !REPORTS_ABSENCE.test(i.text) && about.every((w) => hay(i).includes(w))) : undefined
      // What the statement names (the fever, the sore throat, the blood pressure). A statement that names nothing in particular ("the duration is
      // not documented") is contradicted by any item that gives one.
      const topic = about.filter((w) => !ABSENCE_GENERIC.has(w))
      const concept = ABSENCE_CONCEPTS.find(([asked]) => asked.test(sentence))
      const byConcept = concept ? inputs.items.filter((i) => !REPORTS_ABSENCE.test(i.text) && concept[1].test(`${i.field} ${i.text}`) && (!topic.length || topic.some((w) => hay(i).includes(w)))) : []
      return [...new Set([...(byWords ? [byWords] : []), ...byConcept])]
    }
    const contradicting =
      absenceClaim && c.section !== 'allergies' ? absentFrom(text) : aboutRecord ? [...new Set(sentencesOf(text).filter((x) => ABSENCE_WORDING.test(x) && DOCUMENTATION_VERB.test(x)).flatMap(absentFrom))] : []
    if (contradicting.length) {
      cited = [...cited, ...contradicting.filter((i) => !cited.includes(i))].slice(0, 8)
      flags.add('absence_contradicted')
    }

    // Support, decided here.
    const keys = cited.map((i) => i.key)
    const involvedInConflict = keys.some((k) => conflictKeys.has(k))
    const askedConflict = CONFLICT_WORDS.test(text)
    let support: SupportState
    if (involvedInConflict && (c.section !== 'uncertainties' || conflictFindings.some((f) => f.keys.filter((k) => keys.includes(k)).length >= 2))) {
      support = 'conflicting'
      flags.add('record_conflict')
    } else if (c.section === 'uncertainties' && askedConflict) {
      support = 'inferred'
      flags.add('conflict_unverified')
    } else if (['observations', 'medications', 'symptoms'].includes(c.section) && cited.length && cited.every(olderThanAllowed)) {
      support = 'outdated'
      flags.add('record_outdated')
    } else if (absenceClaim) support = 'not_found'
    else if (c.section === 'uncertainties') support = 'inferred'
    else if (c.basis === 'stated' && cited.length && !['figure_not_in_source', 'negation_unverified', 'wording_not_in_source', 'record_status_differs', 'record_subject_differs'].some((f) => flags.has(f as ItemFlag))) support = flags.has('record_outdated') ? 'outdated' : 'supported'
    else support = 'inferred'

    // A suggestion that cites nothing is the model's own idea: it is shown as such and needs the doctor's explicit check.
    if (suggestion && !cited.length) flags.add('no_valid_source' as ItemFlag)

    const norm = `${c.section}|${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`
    if (seen.has(norm)) {
      bump(reasons, 'duplicate')
      continue
    }
    seen.add(norm)
    if (flags.size) flagged++
    const rationale = c.rationale ? fitText(cleanText(c.rationale, known), MAX_RATIONALE) : ''
    const uncertainty = c.uncertainty ? fitText(cleanText(c.uncertainty, known), MAX_UNCERTAINTY) : ''
    if ((rationale && !vetField(rationale)) || (uncertainty && !vetField(uncertainty))) bump(reasons, 'field_removed')
    kept.push({
      section: c.section,
      position: kept.filter((k) => k.section === c.section).length,
      text,
      support,
      rationale: rationale && vetField(rationale) ? rationale : null,
      uncertainty: uncertainty && vetField(uncertainty) ? uncertainty : null,
      flags: [...flags],
      sourceKeys: keys,
      sourceRefs: cited.map((i) => i.ref),
      needsConfirmation: flags.size > 0,
    })
  }

  const removed = Object.entries(reasons)
    .filter(([k]) => !['invalid_ref', 'source_added', 'shortened', 'field_removed'].includes(k))
    .reduce((n, [, v]) => n + v, 0)
  return {
    items: kept,
    // The model's own "too little to draft from" counts only when it also wrote nothing the checks could keep.
    insufficient: out.insufficient_information && kept.length === 0,
    stats: { produced: cands.length, kept: kept.length, removed, flagged, reasons },
  }
}
