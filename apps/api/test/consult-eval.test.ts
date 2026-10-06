import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { ReasoningModel, StructuredRequest } from '../src/ai/llm/types.ts'
import { CONSULT_PROMPT } from '../src/consult/prompt.ts'
import { type EvalCase, evaluateStored, loadCases, rawCounts, runCase, scoreCase, similarity, toInputs, toMarkdown } from '../src/eval/consult.ts'

// The evaluation of the consultation draft, tested WITHOUT a model: the case file is well-formed, the scoring notices what it must notice (a leaked
// statement, a missed fact, an uncited one), the harness records a model's failure instead of crashing, and the report claims no accuracy. The real
// model is run by the command line tool (apps/api/src/eval/consult-cli.ts), not by the automated suite.

const file = loadCases()
const byId = (prefix: string): EvalCase => file.cases.find((c) => c.id.startsWith(prefix))!
const OPTS = { maxOutputTokens: 2600, timeoutMs: 5000 }

const stub = (answer: unknown): ReasoningModel => ({
  provider: 'test',
  model: 'stub',
  local: true,
  health: async () => ({ state: 'ready', reason: null, model: null }),
  generate: (async (req: StructuredRequest<z.ZodType>) => ({ output: req.schema.parse(answer), model: 'stub', runtime: 'test', weightsSha256: null, inputTokens: 10, outputTokens: 5, finishReason: 'stop', requestId: null })) as ReasoningModel['generate'],
})
const failing = (code: string): ReasoningModel => ({
  ...stub({}),
  generate: (async () => {
    throw Object.assign(new Error('the stand-in failed'), { code })
  }) as ReasoningModel['generate'],
})

const fact = (text: string, refs: string[], basis: 'stated' | 'inferred' | 'not_found' = 'stated') => ({ text, refs, basis, uncertainty: null })
const suggestion = (text: string, refs: string[]) => ({ text, refs, rationale: 'Prompted by the record.', uncertainty: null })
const EMPTY = {
  insufficient_information: false,
  presenting_problem: [],
  symptoms: [],
  observations: [],
  relevant_history: [],
  allergies: [],
  medications: [],
  potential_considerations: [],
  potential_investigations: [],
  potential_medication_considerations: [],
  missing_information: [],
  uncertainties: [],
  summary: null,
}

describe('the case file', () => {
  it('has the shape the harness relies on', () => {
    expect(file.version).toBe('consult-eval-v1')
    expect(file.cases).toHaveLength(12)
    const ids = file.cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(file.cases.filter((c) => c.split === 'dev')).toHaveLength(5)
    expect(file.cases.filter((c) => c.split === 'test')).toHaveLength(7)
    for (const c of file.cases) {
      const refs = c.items.map((i) => i.ref)
      expect(['dev', 'test'], c.id).toContain(c.split)
      expect(c.items.length, `${c.id} has items`).toBeGreaterThan(0)
      expect(new Set(refs).size, `${c.id}: refs are unique`).toBe(refs.length)
      for (const m of c.expect.mustCover) {
        expect(m.terms.length, `${c.id}/${m.id} has terms`).toBeGreaterThan(0)
        expect(m.sections.length, `${c.id}/${m.id} has sections`).toBeGreaterThan(0)
        for (const r of m.refs) expect(refs, `${c.id}/${m.id} cites ${r}`).toContain(r)
        for (const t of m.terms) expect(() => new RegExp(t, 'i'), `${c.id}/${m.id}: ${t}`).not.toThrow()
      }
      for (const f of [...c.recordCheck.conflicts, ...c.recordCheck.outdated, ...c.recordCheck.missing]) for (const r of f.refs) expect(refs, `${c.id}: the rules cite ${r}`).toContain(r)
      for (const p of c.expect.mustNotContain) expect(() => new RegExp(p, 'i'), `${c.id}: ${p}`).not.toThrow()
      for (const g of c.expect.expectedMissing) for (const p of g) expect(() => new RegExp(p, 'i'), `${c.id}: ${p}`).not.toThrow()
      // A conflict the draft must mark has to be one the fixed rules found: the support state "conflicting" comes from them and nowhere else.
      if (c.expect.mustFlagConflict) expect(c.recordCheck.conflicts.length, `${c.id}: no rule finding to mark`).toBeGreaterThan(0)
    }
  })

  it('is fiction: no address, link, telephone number or identifier-like number in any item', () => {
    for (const c of file.cases) {
      const text = c.items.map((i) => i.text).join('\n')
      expect(text, c.id).not.toMatch(/@|https?:|www\./i)
      expect(text, c.id).not.toMatch(/\d{9,}/)
    }
  })
})

describe('what a faithful and a made-up answer score', () => {
  const c01 = byId('c01')
  const GOOD = {
    ...EMPTY,
    presenting_problem: [fact('Fever and sore throat for three days.', ['R1', 'C1'])],
    symptoms: [fact('Sore throat since Monday.', ['F1']), fact('No cough.', ['F2'])],
    observations: [fact('Temperature 38.4 °C, measured by staff.', ['V1']), fact('Heart rate 96 bpm.', ['V2'])],
    allergies: [fact('Allergy to penicillin (rash), moderate.', ['A1'])],
    medications: [fact('Amoxicillin is on today’s draft prescription.', ['P1'])],
    potential_medication_considerations: [suggestion('Check the drafted amoxicillin against the recorded penicillin allergy.', ['P1', 'A1'])],
    missing_information: [fact('Previous antibiotic use is not documented.', [], 'not_found')],
    summary: fact('Fever and sore throat for three days with a moderate penicillin allergy.', ['R1', 'A1']),
  }
  const BAD = {
    ...EMPTY,
    symptoms: [fact('The patient definitely has pneumonia.', ['R1'])],
    observations: [fact('Temperature 41.2 °C.', ['V1'])],
    allergies: [fact('No known allergies.', [], 'not_found')],
    potential_medication_considerations: [suggestion('Start amoxicillin 500 mg three times a day for 5 days.', ['P1'])],
    potential_considerations: [suggestion('Consider levofloxacin.', ['R1'])],
  }

  it('a faithful answer covers what the record says, cites it, marks the rules’ conflict and leaks nothing', async () => {
    const run = await runCase(stub(GOOD), c01, file.today, 1, OPTS)
    expect(run).toMatchObject({ id: c01.id, round: 1, error: null, model: { id: 'stub' } })
    const r = evaluateStored(c01, file.today, run)
    expect(r.valid).toBe(true)
    expect(r.coverage).toEqual({ covered: ['fever', 'sore-throat', 'allergy'], missed: [] })
    expect(r.attribution.uncited).toEqual([])
    expect(r.leaks).toEqual([])
    expect(r.conflictFlagged).toBe(true)
    expect(r.removed).toBe(0)
    expect(r.raw).toMatchObject({ withDoseOrRegimen: 0, newMedicineNamed: 0, link: 0, noValidSource: 0, inventedFigure: 0 })
  })

  it('what the model makes up is counted on its own answer, and the checks keep it out of what is kept', async () => {
    const run = await runCase(stub(BAD), c01, file.today, 1, OPTS)
    const r = evaluateStored(c01, file.today, run)
    expect(r.raw).toMatchObject({ produced: 5, withDoseOrRegimen: 1, newMedicineNamed: 1, inventedFigure: 1 })
    expect(r.removalReasons).toMatchObject({ claim_not_in_source: 1, figure_not_in_record: 1, contradicted_by_record: 1, dose_or_regimen: 1 })
    expect(r.leaks).toEqual([])
    // Nothing the model wrote here says what the record says, so nothing of what is expected is covered: a missing fact is a miss, not a pass.
    expect(r.coverage.covered).toEqual([])
    expect(r.coverage.missed).toHaveLength(3)
    expect(r.statements.map((s) => s.text)).toEqual(['Consider levofloxacin.'])
    expect(r.statements[0]!.flags).toContain('medicine_not_in_record')
  })

  it('the scoring itself notices a leaked statement, a covering statement that does not cite, and the prompt text coming back', () => {
    const item = (text: string, refs: string[]) => ({ section: 'symptoms', position: 0, text, support: 'supported', rationale: null, uncertainty: null, flags: [], sourceKeys: [], sourceRefs: refs, needsConfirmation: false })
    const stats = { produced: 3, kept: 3, removed: 0, flagged: 0, reasons: {} }
    const validated = { items: [item('Likely pneumonia, with fever.', ['F2']), item(`${CONSULT_PROMPT.text.slice(0, 120)}`, ['R1'])], insufficient: false, stats }
    const r = scoreCase(c01, { valid: true, error: null, latencyMs: 1, inputTokens: null, outputTokens: null, raw: null, validated: validated as never, systemPrompt: CONSULT_PROMPT.text })
    expect(r.leaks).toEqual(expect.arrayContaining(['pneumonia', 'system prompt text']))
    // "fever" is covered by a statement that cites F2 only, which is none of the items that state it (R1, V1, C1).
    expect(r.coverage.covered).toEqual(['fever'])
    expect(r.attribution).toEqual({ cited: [], uncited: ['fever'] })
  })

  it('missing information is counted twice: what the draft names, and what the fixed rules’ record check adds on the same screen', async () => {
    const c05 = byId('c05')
    const run = await runCase(stub({ ...EMPTY, presenting_problem: [fact('General check-up', ['R1'])] }), c05, file.today, 1, OPTS)
    const r = evaluateStored(c05, file.today, run)
    expect(r.missingInfo.found).toEqual([])
    // The case expects vital signs and allergy status to be missing; the rules say both, whatever the model did.
    expect(r.missingInfo.byRules).toHaveLength(2)
    const said = await runCase(stub({ ...EMPTY, presenting_problem: [fact('General check-up', ['R1'])], missing_information: [fact('No vital signs are documented.', [], 'not_found')] }), c05, file.today, 1, OPTS)
    const r2 = evaluateStored(c05, file.today, said)
    expect(r2.missingInfo.found).toHaveLength(1)
    expect(r2.missingInfo.byRules).toHaveLength(1)
  })

  it('counts a statement the checks should have caught in the model’s own answer', () => {
    const inputs = toInputs(c01, file.today)
    const counts = rawCounts({ ...EMPTY, symptoms: [fact('See https://example.invalid/x', ['Z9'])], observations: [fact('Temperature 41.2 °C.', ['V1'])] } as never, inputs)
    expect(counts).toMatchObject({ produced: 2, link: 1, noValidSource: 1, inventedFigure: 1 })
  })
})

describe('the harness records a failure instead of crashing', () => {
  it('a model that fails leaves a run with no answer and its reason; the case is scored as not answered', async () => {
    const c = byId('c02')
    const run = await runCase(failing('timeout'), c, file.today, 2, OPTS)
    expect(run).toMatchObject({ id: c.id, round: 2, output: null, model: { id: null } })
    expect(run.error).toMatch(/^timeout: /)
    const r = evaluateStored(c, file.today, run)
    expect(r).toMatchObject({ valid: false, kept: 0 })
    expect(r.coverage.missed).toHaveLength(c.expect.mustCover.length)
  })

  it('an answer that no longer fits the output form is refused when a record is replayed, not scored as something else', () => {
    const c = byId('c01')
    expect(() => evaluateStored(c, file.today, { latencyMs: 1, inputTokens: null, outputTokens: null, error: null, output: { not: 'a draft' } as never })).toThrow()
  })
})

describe('the report', () => {
  it('says what it is, claims no accuracy and gives counts, not percentages', async () => {
    const c01 = byId('c01')
    const run = await runCase(stub({ ...EMPTY, presenting_problem: [fact('Fever and sore throat for three days.', ['R1'])] }), c01, file.today, 1, OPTS)
    const a = evaluateStored(c01, file.today, run)
    const b = evaluateStored(c01, file.today, { ...run, round: 2 } as never)
    expect(similarity(a, b)).toBe(1)
    const md = toMarkdown('Test report', { Model: 'stub' }, [a], [c01], [b])
    expect(md).toMatch(/not a clinical validation/i)
    expect(md).toMatch(/no accuracy is claimed/i)
    // The report names the checks it applied: v3 since they gained the G6 allergy-absence rule (ML audit); v2 had brought the facility's calendar and SpO₂.
    expect(md).toContain('consult-checks-v3')
    // Everything above the statements themselves is counts: a percentage there would be an accuracy figure nobody measured.
    expect(md.split('## The kept statements')[0]).not.toMatch(/\d\s?%/)
  })

  it('two different answers are less alike than the same one twice', () => {
    const c01 = byId('c01')
    const mk = (texts: string[]) => evaluateStored(c01, file.today, { latencyMs: 1, inputTokens: null, outputTokens: null, error: null, output: { ...EMPTY, symptoms: texts.map((t) => fact(t, ['F1'])) } as never })
    const x = mk(['Sore throat since Monday.'])
    expect(similarity(x, mk(['Sore throat since Monday.']))).toBe(1)
    expect(similarity(x, mk(['Sore throat since Monday.', 'Sore throat.']))).toBeLessThan(1)
  })
})
