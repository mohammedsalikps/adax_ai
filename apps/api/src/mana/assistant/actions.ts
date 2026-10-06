import type { ManaActionProposal, ManaActionWarning, ManaAnswerBody, ManaProposedPrescriptionItem } from '@adaxai/contracts'
import { and, eq } from 'drizzle-orm'
import { nameMatches, sharedGroup } from '../../ai/compare.ts'
import { allergies, encounters, patients, prescriptionItems } from '../../db/schema.ts'
import { commandQuestion, type PrescriptionCommand } from './intents.ts'
import { consentRefusal } from './tools.ts'
import type { ManaCtx } from './types.ts'

/**
 * A medicine the doctor asked Mana to add, in their own words, made into a PROPOSAL (HERO final, spec §23): never an action. Only in a conversation
 * opened in the doctor's own consultation that is still a draft, only from a fully specified instruction (medicine, dose, how often, for how long; the
 * drug name is the doctor's own words), and with the fixed checks shown before the doctor decides: an allergy on record with the same name or in the
 * same configured group, the same medicine already on the draft prescription. The server never writes the prescription: an approved proposal is
 * added to the unsigned draft by the doctor's screen, as the doctor's act, and saved by its own autosave. Ambiguous words make a question, not a
 * proposal. "Prescribe ..." and other free requests are not this (they are refused as before).
 */

export interface Proposal {
  outcome: ManaAnswerBody['outcome']
  notice: string | null
  action: ManaActionProposal | null
  /** The sentence the answer says when there is a proposal. */
  text: string | null
  /** For the audit: counts only. */
  detail: string
  patientId: string | null
}

export const NOT_IN_CONSULTATION = 'Mana adds a medicine only to the prescription of your open consultation: ask from the consultation or its prescription page. Nothing was added.'
export const CONSULTATION_CLOSED = 'This consultation is signed or closed, so nothing can be added to its prescription.'
export const NOT_THE_AUTHOR = 'Only the doctor of this consultation can add to its prescription.'
/** The one warning of a proposal for a patient whose consent to AI help does not allow Mana to read their record: no check was made. */
export const CHECKS_NOT_MADE = 'Mana did not compare this with the allergies on record or with the medicines already on this prescription: the patient’s consent to AI help with their record does not allow it. Check both before approving.'

const stop = (outcome: ManaAnswerBody['outcome'], notice: string, detail: string): Proposal => ({ outcome, notice, action: null, text: null, detail, patientId: null })

/** How often, as the doctor said it, unless they used an abbreviation ("tds"): then as the prescription writes it. */
const sayFrequency = (c: PrescriptionCommand): string => (c.frequencyWords && /\s/.test(c.frequencyWords) ? c.frequencyWords : c.frequency!)

/** The proposal's one line ("Add to the prescription: Amoxicillin 500 mg · three times a day · 5 days") and its card (pure: unit-tested). */
export function proposalSummary(item: ManaProposedPrescriptionItem, frequencyWords: string): string {
  const what = [item.drugName, item.strength].filter(Boolean).join(' ')
  const dose = item.dose && item.dose !== item.strength ? ` · ${item.dose}` : ''
  return `Add to the prescription: ${what}${dose} · ${frequencyWords} · ${item.duration}`
}

export async function proposeMedicine(ctx: ManaCtx, c: PrescriptionCommand): Promise<Proposal> {
  const encounterId = ctx.scope.encounterId
  if (!encounterId) return stop('clarify', NOT_IN_CONSULTATION, 'not in a consultation')
  const [e] = await ctx.db
    .select({ id: encounters.id, status: encounters.status, doctorId: encounters.doctorId, patientId: encounters.patientId })
    .from(encounters)
    .where(and(eq(encounters.id, encounterId), eq(encounters.facilityId, ctx.me.facilityId)))
  if (!e || e.status !== 'in_progress') return stop('refused', CONSULTATION_CLOSED, 'consultation not in progress')
  if (e.doctorId !== ctx.me.id) return stop('refused', NOT_THE_AUTHOR, 'not the author')
  if (!c.complete || !c.drugName || !c.dose || !c.frequency || !c.duration) return { ...stop('clarify', commandQuestion(c), `incomplete: ${c.missing.length} part(s) missing, ${c.unclear.length} unclear`), patientId: e.patientId }

  const drug = c.drugName
  const warnings: ManaActionWarning[] = []
  // The fixed checks read the patient's record: the allergies (answers.ts uses the same rule: a name match, or both in one configured group) and the
  // medicines already on this consultation's prescription. The patient's consent to AI help may not allow that: then neither is read or compared (the
  // proposal is the doctor's own words and reads nothing), and the doctor is told so.
  const refusal = await consentRefusal(ctx, ctx.db, e.patientId)
  if (refusal) warnings.push({ kind: 'other', text: CHECKS_NOT_MADE })
  else {
    const rows = await ctx.db.select({ substance: allergies.substance }).from(allergies).where(and(eq(allergies.patientId, e.patientId), eq(allergies.status, 'active')))
    for (const a of rows) {
      const group = sharedGroup(drug, a.substance, ctx.settings.safety.allergyGroups)
      if (group || nameMatches(drug, a.substance)) warnings.push({ kind: 'allergy_conflict', text: `${drug} and the recorded allergy to ${a.substance} ${group ? `belong to the same configured group (“${group}”)` : 'have matching names'}. Check before approving.` })
    }
    if (!rows.length) {
      const [p] = await ctx.db.select({ nka: patients.noKnownAllergies }).from(patients).where(and(eq(patients.id, e.patientId), eq(patients.facilityId, ctx.me.facilityId)))
      if (!p?.nka) warnings.push({ kind: 'other', text: 'No allergy status is recorded for this patient. Check allergies before approving.' })
    }
    const onDraft = await ctx.db.select({ drugName: prescriptionItems.drugName, strength: prescriptionItems.strength, frequency: prescriptionItems.frequency, duration: prescriptionItems.duration }).from(prescriptionItems).where(eq(prescriptionItems.encounterId, e.id))
    for (const x of onDraft) {
      if (nameMatches(drug, x.drugName)) warnings.push({ kind: 'duplicate_medicine', text: `${x.drugName} is already on this prescription (${[x.strength, x.frequency, x.duration].filter(Boolean).join(', ') || 'no details'}).` })
    }
  }
  if (c.durationDays === null) warnings.push({ kind: 'other', text: `The course length in days is not set for “${c.duration}”: set the number of days on the prescription if it has one.` })

  const item: ManaProposedPrescriptionItem = {
    drugName: drug.slice(0, 160),
    strength: (c.strength ?? '').slice(0, 60),
    form: (c.form ?? '').slice(0, 40),
    dose: c.dose.slice(0, 60),
    route: (c.route ?? '').slice(0, 40),
    frequency: c.frequency.slice(0, 60),
    duration: c.duration.slice(0, 60),
    durationDays: c.durationDays,
    instructions: (c.instructions ?? '').slice(0, 300),
  }
  const freq = sayFrequency(c)
  ctx.disclosed.add(e.patientId)
  return {
    outcome: 'answered',
    notice: null,
    action: { kind: 'add_prescription_item', encounterId: e.id, item, summary: proposalSummary(item, freq), warnings },
    text: `I can add ${[drug, item.strength].filter(Boolean).join(' ')}${item.dose !== item.strength ? `, ${item.dose}` : ''}, ${freq} for ${item.duration}, to this consultation’s prescription. Approve to add it to the draft, or cancel: nothing is added until you approve, and nothing is signed.`,
    detail: `proposal with ${warnings.length} warning(s)`,
    patientId: e.patientId,
  }
}
