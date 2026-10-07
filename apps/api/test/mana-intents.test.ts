import { MANA_QUESTIONS, MANA_RULES_QUESTIONS } from '@adaxai/contracts'
import { describe, expect, it } from 'vitest'
import { proposalSummary } from '../src/mana/assistant/actions.ts'
import { commandQuestion, matchRulesIntent, orderWordsOf, parsePrescriptionCommand, parseWho, withChosenPatient } from '../src/mana/assistant/intents.ts'

// HERO final, Mana's fixed-rule questions and the medicine command (no database, no model): which words are answered by the server's own rules, which
// stay with the planner (the tests of the model path depend on that), and how an "add ..." instruction is read: completely, or not at all.

/** The words of a small service catalogue (the service passes the clinic's own, from its settings). */
const ORDER_WORDS = orderWordsOf([
  { code: 'CBC', name: 'Complete blood count (CBC)' },
  { code: 'CRP', name: 'C-reactive protein (CRP)' },
  { code: 'LIPID', name: 'Lipid profile' },
  { code: 'URINE-RE', name: 'Urine routine and microscopy' },
  { code: 'XRAY-CHEST', name: 'Chest X-ray (PA view)' },
  { code: 'CT-HEAD', name: 'CT head (plain)' },
])

describe('the questions fixed rules answer', () => {
  it('recognises the words of the screen’s buttons, each as its own question', () => {
    expect(matchRulesIntent(MANA_RULES_QUESTIONS.next_patient.text)).toEqual({ kind: 'next_patient' })
    expect(matchRulesIntent(MANA_RULES_QUESTIONS.seen_today.text)).toEqual({ kind: 'seen_today' })
    expect(matchRulesIntent(MANA_RULES_QUESTIONS.waiting_longest.text)).toEqual({ kind: 'waiting_longest', mine: true })
    expect(matchRulesIntent(MANA_RULES_QUESTIONS.nurse_triage.text)).toEqual({ kind: 'nurse_triage', who: { by: 'current' } })
    expect(matchRulesIntent(MANA_RULES_QUESTIONS.orders_status.text)).toEqual({ kind: 'orders', ask: 'pending', service: null, who: { by: 'none' } })
    expect(matchRulesIntent(MANA_RULES_QUESTIONS.allergies.text)).toEqual({ kind: 'allergies', who: { by: 'current' } })
  })

  it('recognises the owner’s own phrasings, with "Mana," and politeness taken off', () => {
    const cases: [string, unknown][] = [
      ['Mana, who is my next patient?', { kind: 'next_patient' }],
      ['Who’s next?', { kind: 'next_patient' }],
      ['Who should I see next?', { kind: 'next_patient' }],
      ['How many patients have I seen today?', { kind: 'seen_today' }],
      ['Can you tell me how many patients did I see today?', { kind: 'seen_today' }],
      ['Which patient has been waiting longest?', { kind: 'waiting_longest', mine: false }],
      ['Who has been waiting the longest for me?', { kind: 'waiting_longest', mine: true }],
      ['What time did Anita Das arrive?', { kind: 'arrival_time', who: { by: 'name', name: 'Anita Das' } }],
      ['When did she check in?', { kind: 'arrival_time', who: { by: 'current' } }],
      ['What did the nurse note during triage?', { kind: 'nurse_triage', who: { by: 'current' } }],
      ['What did the nurse record?', { kind: 'nurse_triage', who: { by: 'current' } }],
      ['What did the nurse record for Meena Kumar?', { kind: 'nurse_triage', who: { by: 'name', name: 'Meena Kumar' } }],
      ['Is the lab report ready?', { kind: 'orders', ask: 'ready', service: 'lab', who: { by: 'current' } }],
      ['Is the report ready?', { kind: 'orders', ask: 'ready', service: null, who: { by: 'current' } }],
      ['Is the CBC report ready for Anita Das?', { kind: 'orders', ask: 'ready', service: 'CBC', who: { by: 'name', name: 'Anita Das' } }],
      ['Did the lab receive the CBC request?', { kind: 'orders', ask: 'received', service: 'CBC', who: { by: 'current' } }],
      ['Which service orders are pending?', { kind: 'orders', ask: 'pending', service: null, who: { by: 'none' } }],
      ['The patient who arrived one hour ago — is the lab report ready?', { kind: 'orders', ask: 'ready', service: 'lab', who: { by: 'arrived', minutes: 60 } }],
      ['Is the lab report ready for the patient who came in half an hour ago?', { kind: 'orders', ask: 'ready', service: 'lab', who: { by: 'arrived', minutes: 30 } }],
      ['Mana, summarize this patient’s previous MRI.', { kind: 'imaging', who: { by: 'current' }, modality: 'mri' }],
      ['What did the CT show?', { kind: 'imaging', who: { by: 'current' }, modality: 'ct' }],
      ['Show the X-ray report of Rahul Sharma', { kind: 'imaging', who: { by: 'name', name: 'Rahul Sharma' }, modality: 'xray' }],
      ['What allergies does this patient have?', { kind: 'allergies', who: { by: 'current' } }],
      ['Does she have any allergies?', { kind: 'allergies', who: { by: 'current' } }],
      // Fix pass: the service named is read without the little words, and the study's words ("scan", "X ray", "blood work") are a service's.
      ['What did the nurse record on arrival?', { kind: 'nurse_triage', who: { by: 'current' } }],
      ['Is the latest CBC report ready?', { kind: 'orders', ask: 'ready', service: 'CBC', who: { by: 'current' } }],
      ['Is the chest x ray report ready?', { kind: 'orders', ask: 'ready', service: 'chest X-ray', who: { by: 'current' } }],
      ['Is the CT scan report ready?', { kind: 'orders', ask: 'ready', service: 'CT scan', who: { by: 'current' } }],
      ['Is the USG report ready?', { kind: 'orders', ask: 'ready', service: 'USG', who: { by: 'current' } }],
      ['Are the blood work results back?', { kind: 'orders', ask: 'ready', service: 'blood', who: { by: 'current' } }],
      ['Have the lipid profile results come back for P2?', { kind: 'orders', ask: 'ready', service: 'lipid profile', who: { by: 'alias', alias: 'P2' } }],
    ]
    // Fix pass (deliberate change): an order question is recognised only for a service the clinic orders, so the catalogue's words are passed, as the
    // service passes the clinic's own ("the CBC" is a service only because the catalogue has it).
    for (const [q, intent] of cases) expect(matchRulesIntent(q, ORDER_WORDS), q).toEqual(intent)
  })

  it('recognises an order question only about a service the clinic orders, or a kind of service, never about something else that has a report', () => {
    // Without the catalogue's words, only the kinds of service are known.
    expect(matchRulesIntent('Is the CBC report ready?')).toBeNull()
    expect(matchRulesIntent('Is the lab report ready?')).toEqual({ kind: 'orders', ask: 'ready', service: 'lab', who: { by: 'current' } })
    expect(matchRulesIntent('Is the CBC report ready?', ORDER_WORDS)).toEqual({ kind: 'orders', ask: 'ready', service: 'CBC', who: { by: 'current' } })
    // The words of the catalogue are its codes and the words of its names, not the little words that join them.
    const words = orderWordsOf([{ code: 'URINE-RE', name: 'Urine routine and microscopy' }])
    expect([...words].sort()).toEqual(['microscopy', 'routine', 'urine', 'urine-re'])
  })

  it('leaves every other question to the planner: the generic queue question, the record questions the model answers, refusals and requests to change a record', () => {
    for (const q of [
      'Who is waiting right now?',
      'Who is waiting?',
      'Who is\twaiting\nright now?',
      'What allergies are recorded for this patient?',
      'What are the allergies of this patient?',
      'What are Meena’s allergies?',
      'And her allergies?',
      'Allergies on record',
      'Who came in recently?',
      'What is in the queue today?',
      'What was recorded in this consultation?',
      'What still needs my review?',
      'What did the last consultation of Omkar say?',
      'Do I have appointments tomorrow?',
      'Show the visits of Rahul',
      'Prescribe amoxicillin for this patient',
      'Prescribe amoxicillin 500 mg three times a day for this patient.',
      'Please sign this consultation',
      'Delete the last note',
      'Add penicillin to her allergies',
      'I want you to add an allergy to penicillin',
      'Add up how many patients I saw today',
      'Add a note that the patient is better',
      'What was the reason for this visit?',
      'Is the patient ready?',
      // Jury polish: "Summarize the patient's previous history." is now answered by fixed rules (asserted in its own test below).
      // Fix pass: other things that have a report, a patient's name where a service would be, two services at once, a request that is not an order.
      'Is the thermal report ready?',
      'Is the AI draft report ready?',
      'Is Anita report ready?',
      'Is Anita’s report ready?',
      'Is the discharge summary report ready?',
      'Has the thermal result come back?',
      'Is the CBC and CRP report ready?',
      'Did the lab receive the referral request?',
      'Which orders are pending for everyone?',
      // ... and what the nurse said about something, or for somebody who is not a patient.
      'What did the nurse say about the dressing?',
      'What did the nurse say about fever?',
      'What did the nurse record for the dressing?',
      'What did the nurse note on the chart?',
      ...Object.values(MANA_QUESTIONS).map((x) => x.label),
    ]) {
      // Fix pass: with the catalogue's words too (stronger: none of these becomes an order question because a word is a service's).
      expect(matchRulesIntent(q), q).toBeNull()
      expect(matchRulesIntent(q, ORDER_WORDS), q).toBeNull()
    }
  })

  it('answers the jury questions about the conversation’s patient by fixed rules, and leaves a named patient to the planner (except the history summary)', () => {
    const current = { by: 'current' }
    expect(matchRulesIntent('Summarize the patient’s previous history.')).toEqual({ kind: 'record_topic', who: current, topic: 'history' })
    expect(matchRulesIntent('Summarize this patient’s previous history.')).toEqual({ kind: 'record_topic', who: current, topic: 'history' })
    expect(matchRulesIntent('Summarize Ramesh Kumar’s history.')).toEqual({ kind: 'record_topic', who: { by: 'name', name: 'Ramesh Kumar' }, topic: 'history' })
    expect(matchRulesIntent('What are his allergies?')).toEqual({ kind: 'allergies', who: current })
    expect(matchRulesIntent('What medicines is he currently taking?')).toEqual({ kind: 'record_topic', who: current, topic: 'medicines' })
    expect(matchRulesIntent('What happened in the last consultation?')).toEqual({ kind: 'last_consultation', who: current })
    expect(matchRulesIntent('Show recent lab reports')).toEqual({ kind: 'record_topic', who: current, topic: 'investigations' })
    expect(matchRulesIntent('What surgeries has he had?')).toEqual({ kind: 'surgeries', who: current })
    expect(matchRulesIntent('Summarize today’s consultation')).toEqual({ kind: 'today_consultation' })
    for (const q of ['What are Meena’s allergies?', 'What medicines is Rahul Sharma on?', 'What are the allergies of Zara Khan?', 'What are the allergies?', 'What did the last consultation of Omkar say?', 'Brief me on this patient']) expect(matchRulesIntent(q), q).toBeNull()
  })

  it('reads who a question is about without guessing: the current patient, a handle, a name, a check-in time, or nobody', () => {
    expect(parseWho('this patient')).toEqual({ by: 'current' })
    expect(parseWho('her')).toEqual({ by: 'current' })
    expect(parseWho('P3')).toEqual({ by: 'alias', alias: 'P3' })
    expect(parseWho('Mrs Meena Kumar’s')).toEqual({ by: 'name', name: 'Meena Kumar' })
    expect(parseWho('the patient who arrived about two hours ago')).toEqual({ by: 'arrived', minutes: 120 })
    expect(parseWho('the one who checked in 45 minutes ago')).toEqual({ by: 'arrived', minutes: 45 })
    expect(parseWho('the patient who arrived ages ago')).toEqual({ by: 'none' })
    expect(parseWho('everyone')).toEqual({ by: 'none' })
    expect(parseWho('')).toEqual({ by: 'none' })
    // A choice the doctor made among the patients offered settles who the same question is about.
    expect(withChosenPatient({ kind: 'nurse_triage', who: { by: 'name', name: 'Rahul' } }, 'P2')).toEqual({ kind: 'nurse_triage', who: { by: 'alias', alias: 'P2' } })
    expect(withChosenPatient({ kind: 'seen_today' }, 'P2')).toBeNull()
  })
})

describe('an instruction to add a medicine', () => {
  const read = (q: string) => {
    const intent = matchRulesIntent(q)
    return intent?.kind === 'add_medicine' ? intent.command : null
  }

  it('is complete only with the medicine, the dose, how often and for how long, in the doctor’s own words', () => {
    const c = read('add amoxicillin 500 mg three times a day for 5 days')!
    expect(c).toMatchObject({ complete: true, drugName: 'Amoxicillin', strength: '500 mg', dose: '500 mg', frequency: 'Three times daily (TDS)', frequencyWords: 'three times a day', duration: '5 days', durationDays: 5, missing: [], unclear: [] })
    expect(read('Mana, add amoxicillin 500 mg three times a day for 5 days to the prescription.')).toMatchObject({ complete: true, drugName: 'Amoxicillin', durationDays: 5 })
    expect(read('Please add paracetamol 650mg TDS x 3 days after food')).toMatchObject({ complete: true, drugName: 'Paracetamol', strength: '650 mg', frequency: 'Three times daily (TDS)', duration: '3 days', durationDays: 3, instructions: 'After food' })
    expect(read('add 1 tablet of metformin 500 mg twice daily for 2 weeks')).toMatchObject({ complete: true, drugName: 'Metformin', strength: '500 mg', dose: '1 tablet', form: 'Tablet', frequency: 'Twice daily (BD)', duration: '2 weeks', durationDays: 14 })
    expect(read('add amoxicillin 500 mg 1 capsule orally three times a day for 7 days')).toMatchObject({ complete: true, dose: '1 capsule', form: 'Capsule', route: 'Oral', durationDays: 7 })
    expect(read('add salbutamol two puffs when needed for 5 days')).toMatchObject({ complete: true, drugName: 'Salbutamol', dose: '2 puffs', form: 'Inhaler', frequency: 'When needed (SOS)' })
    expect(read('add cetirizine 10 mg at night for a week')).toMatchObject({ complete: true, frequency: 'At night (HS)', duration: '1 week', durationDays: 7 })
    expect(read('add vitamin D3 60000 IU once weekly for 8 weeks')).toMatchObject({ complete: true, drugName: 'Vitamin D3', strength: '60000 IU', frequency: 'Once weekly', durationDays: 56 })
    expect(read('add ibuprofen 400 mg 1-0-1 for 3 days')).toMatchObject({ complete: true, frequency: '1-0-1' })
    expect(read('add amoxicillin 0.5 g every 8 hours for 5 days')).toMatchObject({ complete: true, strength: '0.5 g', frequency: 'Every 8 hours' })
  })

  it('keeps no day count for a duration in months (a month is not a number of days), and says nothing it did not hear', () => {
    expect(read('add levothyroxine 50 mcg once daily for 3 months')).toMatchObject({ complete: true, strength: '50 mcg', duration: '3 months', durationDays: null, route: null, form: null, instructions: null })
  })

  it('says what is missing, and is never complete without it', () => {
    expect(read('add amoxicillin')).toMatchObject({ complete: false, drugName: 'Amoxicillin', missing: ['dose', 'frequency', 'duration'] })
    expect(read('add amoxicillin 500 mg to the prescription')).toMatchObject({ complete: false, missing: ['frequency', 'duration'] })
    expect(read('add amoxicillin 500 mg three times a day')).toMatchObject({ complete: false, missing: ['duration'] })
    expect(read('add amoxicillin 500 mg for 5 days')).toMatchObject({ complete: false, missing: ['frequency'] })
    expect(read('add amoxicillin three times a day for days')).toMatchObject({ complete: false, missing: ['dose', 'duration'] })
    expect(read('add 500 mg three times a day for 5 days')).toMatchObject({ complete: false, drugName: null })
    expect(read('add it 500 mg three times a day for 5 days')).toMatchObject({ complete: false, drugName: null })
    // "Add this medicine to the prescription" (spec §23) names no medicine: everything is asked for.
    expect(read('Add this medicine to the prescription.')).toMatchObject({ complete: false, drugName: null, missing: ['medicine', 'dose', 'frequency', 'duration'] })
  })

  it('is unclear when a part is said twice or words cannot be read, and then nothing is proposed', () => {
    expect(read('add amoxicillin 500 mg twice a day or three times a day for 5 days')).toMatchObject({ complete: false })
    expect(read('add amoxicillin 500 mg 250 mg three times a day for 5 days')!.unclear).toContain('the strength said twice')
    const c = read('add amoxicillin 500 mg three times a day for 5 days unless the culture comes back')!
    expect(c.complete).toBe(false)
    expect(c.unclear.join(' ')).toMatch(/unless the culture/)
    expect(commandQuestion(c)).toMatch(/^To add Amoxicillin to the prescription, I need the instruction without anything I could not read .*Nothing was added\.$/)
  })

  it('is not an instruction to prescribe at all when it adds something else (a note, an allergy) or is not about medicine', () => {
    for (const q of ['add penicillin to her allergies', 'add a note', 'add the diagnosis', 'add up how many patients I saw today', 'add Meena to the queue', 'add fever to the notes']) expect(parsePrescriptionCommand(q), q).toBeNull()
  })

  it('asks for the missing parts in fixed words, with the doctor’s own drug name and no example dose', () => {
    expect(commandQuestion(read('add amoxicillin')!)).toBe('To add Amoxicillin to the prescription, I need the dose, how often it is taken and for how long. Say the whole instruction again with them. Nothing was added.')
    expect(commandQuestion(read('add 500 mg three times a day for 5 days')!)).toMatch(/^To add a medicine to the prescription, I need the medicine/)
    for (const q of ['add amoxicillin', 'add amoxicillin 500 mg']) expect(commandQuestion(read(q)!)).not.toMatch(/\d/)
  })

  it('makes the card’s one line from the item and the doctor’s words for how often', () => {
    const item = { drugName: 'Amoxicillin', strength: '500 mg', form: '', dose: '500 mg', route: '', frequency: 'Three times daily (TDS)', duration: '5 days', durationDays: 5, instructions: '' }
    expect(proposalSummary(item, 'three times a day')).toBe('Add to the prescription: Amoxicillin 500 mg · three times a day · 5 days')
    expect(proposalSummary({ ...item, dose: '1 capsule' }, 'Three times daily (TDS)')).toBe('Add to the prescription: Amoxicillin 500 mg · 1 capsule · Three times daily (TDS) · 5 days')
  })
})
