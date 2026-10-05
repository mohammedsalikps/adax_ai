import { type ContextConflict, FACT_CATEGORIES, type FactCategory, VITALS, type VitalKind } from '@adaxai/contracts'
import { nameMatches } from '../ai/compare.ts'

/**
 * D2: the disagreements the consultation context shows the doctor (`context-conflicts-v2`). Fixed rules over records that already exist,
 * deterministic for the same inputs. A conflict is SHOWN, never resolved: both sides are stated as they are, with where each came from, and no
 * rule says which side is right, what it means clinically or what to do. Change the version when what is found, or how it is worded, changes.
 *
 * v2: an allergy said in the consultation is compared again with the record as it is now (v1 used the flags set when it was extracted, which an
 * allergy recorded since, or the doctor's edit, makes out of date); a vital sign a point disagrees with is named by where it came from (entered
 * by staff, or a device, unverified), never quoted from the comparison's note ("Measured …", also written for a device's value).
 */
export const CONFLICT_RULES_VERSION = 'context-conflicts-v2'

/**
 * A staff measurement and a device reading are compared only when taken this close together: further apart, a difference can simply be the
 * patient changing. Used by the query that pairs them (build.ts) and nowhere else.
 */
export const VITAL_PAIR_WINDOW_SECONDS = 15 * 60

/**
 * How far a device reading must be from a staff measurement of the same kind, taken within the window above, before the two are shown as
 * disagreeing. Chosen to be wider than the usual difference between two careful measurements of the same patient (a fingertip oximeter, a
 * pulse counted by hand, a thermometer), so that ordinary variation is not shown as a conflict. They are display thresholds for a reading that
 * is unverified anyway: not accuracy limits of any device, and not a statement that either value is wrong. Kinds not listed are not compared.
 */
export const VITAL_DIFFERENCE: Partial<Record<VitalKind, number>> = {
  spo2: 3,
  heart_rate: 15,
  temperature: 0.5,
  respiratory_rate: 5,
}
export const COMPARED_VITAL_KINDS = Object.keys(VITAL_DIFFERENCE) as VitalKind[]

/**
 * The flag of the record comparison (`record-compare-v1`, ai/compare.ts) that makes an important point other than an allergy disagree with the
 * record: set when the point was extracted, on the extracted text and the record as it was then, and said to be so. An allergy is not taken from
 * the flags: it is compared again with the record as it is now (rule (b)). A medicine "not in the record" is not a disagreement (it may come
 * from elsewhere): it is not shown here.
 */
const CONFLICTS_WITH_RECORD = 'conflicts_with_record'

/** Where the vital sign a point was compared with came from, as the record comparison stored it beside the conflict. */
export type ComparedSource = 'staff' | 'device' | 'unknown'

// ---- Fixed wording shared by the context, its conflicts and its summary ----

/** A short quotation of text someone said or wrote: between “ and ”, on one line, at most `max` characters (cut, ending with an ellipsis). */
export function quote(s: string, max = 80): string {
  const chars = Array.from(s.replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim())
  return `“${chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('')}”`
}

/** A vital value as stored, with the number of decimals its kind is entered with ("98 %", "37.4 °C", "72 bpm"). */
export function vitalValue(kind: VitalKind, value: number): string {
  return `${Number(value).toFixed(VITALS[kind].decimals)} ${VITALS[kind].unit}`
}
export const vitalText = (kind: VitalKind, value: number) => `${VITALS[kind].label} ${vitalValue(kind, value)}`

export interface VitalPairInput {
  staff: { itemId: string; observationId: string; kind: VitalKind; value: number; measuredAt: Date }
  /** Never a simulator's reading: the query leaves them out, and this rule refuses one that got through. */
  device: { itemId: string; observationId: string; value: number; measuredAt: Date; simulated: boolean }
}

/** Rejected points are not passed in: the doctor already set them aside. */
export interface PointInput {
  itemId: string
  factId: string
  category: string
  /** The doctor's text when edited, otherwise the extracted text. */
  text: string
  stateLabel: string
  /** The doctor edited the text: what was found on the extracted text is said to be "as extracted, before the doctor’s edit". */
  edited: boolean
  /** The flags the record comparison set when the point was extracted. */
  flags: string[]
  /** For an allergy: the substance the extraction found (null when it found none), and whether the point says there is no allergy. */
  substance: string | null
  negated: boolean
  /** For a vital sign flagged as conflicting: where each record value it was compared with came from. */
  comparedWith: ComparedSource[]
}

export interface DraftStatementInput {
  itemId: string
  statementId: string
  text: string
  support: string
}

export interface RecordAllergyInput {
  /** Active allergies on the record (substances, as recorded). */
  allergies: string[]
  noKnownAllergies: boolean
}

export interface ConflictInput {
  pairs: VitalPairInput[]
  /** Null when the viewer does not see important points (they are shown to doctors), or they could not be read. */
  points: PointInput[] | null
  /** Null when the viewer does not see the AI draft (the doctor of the consultation does), or it could not be read. */
  statements: DraftStatementInput[] | null
  /** Null when the record could not be read: nothing is compared with it then. */
  record: RecordAllergyInput | null
  /** The clock time of an instant, in the facility's time zone ("10:40"). */
  time: (d: Date) => string
}

const categoryLabel = (c: string) => FACT_CATEGORIES[c as FactCategory] ?? c

/**
 * The vital sign a point was found to differ from, by where it came from: a staff entry is "entered by staff", a device's value "a device
 * (unverified)". Not known (or both), the two places it can be looked at are named. No value is quoted: the comparison's own note calls any value
 * "measured", a device's too.
 */
function comparedVital(sources: ComparedSource[]): string {
  const known = [...new Set(sources)]
  if (known.length === 1 && known[0] === 'staff') return 'It differs from a vital sign entered by staff at this visit (see History).'
  if (known.length === 1 && known[0] === 'device') return 'It differs from a vital sign a device (unverified) sent at this visit (see Devices).'
  return 'It differs from a vital sign recorded at this visit: see History (entered by staff) and Devices (device readings, unverified).'
}

/** The four rules, in this order: staff against device, points against the record, the AI draft's own conflicts, the allergy status. */
export function findConflicts(i: ConflictInput): ContextConflict[] {
  const out: ContextConflict[] = []
  const conflict = (kind: ContextConflict['kind'], id: string, text: string, itemIds: string[]) => out.push({ id: `${kind}:${id}`, kind, text, itemIds, rule: CONFLICT_RULES_VERSION })

  // (a) A staff measurement and a device reading of the same kind, close together, that differ by at least the threshold. A simulated reading is
  // nobody's measurement: it never makes a conflict, whatever it says.
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const pairs = [...i.pairs].sort((a, b) => a.staff.measuredAt.getTime() - b.staff.measuredAt.getTime() || byText(a.staff.observationId, b.staff.observationId) || byText(a.device.observationId, b.device.observationId))
  for (const { staff, device } of pairs) {
    const limit = VITAL_DIFFERENCE[staff.kind]
    if (limit === undefined || device.simulated) continue
    if (Math.abs(device.measuredAt.getTime() - staff.measuredAt.getTime()) > VITAL_PAIR_WINDOW_SECONDS * 1000) continue
    // Compared as stored (two decimals at most): a difference of exactly the threshold counts.
    if (Math.round(Math.abs(staff.value - device.value) * 100) < Math.round(limit * 100)) continue
    conflict(
      'vital_staff_vs_device',
      `${staff.observationId}:${device.observationId}`,
      `Staff measured ${vitalText(staff.kind, staff.value)} at ${i.time(staff.measuredAt)}; a device (unverified) sent ${vitalValue(staff.kind, device.value)} at ${i.time(device.measuredAt)}.`,
      [staff.itemId, device.itemId],
    )
  }

  // (b) Important points against the record.
  //   - An allergy is compared again, here, with the record as it is NOW: its active allergies (by the record comparison's own name matching) and
  //     "no known allergies". The substance compared is the one the extraction found (none found: nothing is compared, as in the record
  //     comparison). A point the doctor EDITED is not compared: its substance and whether it says there is no allergy are known only as
  //     extracted, and the doctor wrote the edited text against the record. A record that holds no allergy status at all is rule (d)'s; a record
  //     that could not be read, nobody's.
  //   - Any other point: where the record comparison flagged it as conflicting with the record when it was extracted, said to be so; for a vital
  //     sign, with where the value it was compared with came from (entered by staff, or a device, unverified), never called "measured".
  for (const p of i.points ?? []) {
    const head = `Important point ${quote(`${categoryLabel(p.category)}: ${p.text}`)} (${p.stateLabel})`
    if (p.category === 'allergy') {
      const r = i.record
      // Not an edited point: whether it says there is no allergy, and which substance it names, are known only as extracted, and the doctor
      // wrote the edited text themselves, having been asked to check it against the record.
      if (!r || p.edited) continue
      const said = p.substance
      if (r.allergies.length) {
        const listed = r.allergies.length > 10 ? `${r.allergies.slice(0, 10).join(', ')} and ${r.allergies.length - 10} more` : r.allergies.join(', ')
        if (p.negated) conflict('point_vs_record', p.factId, `${head} says there is no allergy; allergies on the record: ${listed}.`, [p.itemId])
        else if (said && !r.allergies.some((a) => nameMatches(a, said))) conflict('point_vs_record', p.factId, `${head} names an allergy that is not on the record; allergies on the record: ${listed}.`, [p.itemId])
      } else if (r.noKnownAllergies && !p.negated && said) conflict('point_vs_record', p.factId, `${head} names an allergy; the record states no known allergies.`, [p.itemId])
      continue
    }
    if (!p.flags.includes(CONFLICTS_WITH_RECORD)) continue
    const when = p.edited ? 'as extracted, before the doctor’s edit' : 'when it was extracted'
    conflict('point_vs_record', p.factId, `${head} was flagged by the record comparison ${when}: conflicts with the existing record.${p.category === 'vital_sign' ? ` ${comparedVital(p.comparedWith)}` : ''}`, [p.itemId])
  }

  // (c) Statements of the AI draft that the server itself marked "Conflicting" (the record items they rest on disagree).
  for (const s of i.statements ?? []) {
    if (s.support !== 'conflicting') continue
    conflict('draft_conflict', s.statementId, `AI draft statement ${quote(s.text)} is marked “Conflicting”: the record items it rests on disagree.`, [s.itemId])
  }

  // (d) Allergies were talked about, and the record holds no allergy status at all: neither an allergy nor "no known allergies".
  if (i.record && !i.record.allergies.length && !i.record.noKnownAllergies) {
    const said = (i.points ?? []).filter((p) => p.category === 'allergy')
    if (said.length) {
      const quotes = said.slice(0, 3).map((p) => quote(p.text, 60))
      const more = said.length > 3 ? ` and ${said.length - 3} more` : ''
      conflict('allergy_status', said.map((p) => p.factId).sort()[0]!, `Allergies were mentioned in the consultation (${quotes.join(', ')}${more}), but the record has no allergy status: no allergy is recorded and “no known allergies” is not marked.`, said.map((p) => p.itemId))
    }
  }
  return out
}
