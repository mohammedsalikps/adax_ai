import { expect, type Page, request as pwRequest, test } from '@playwright/test'
import { expectNoAxeViolations, expectNoHorizontalOverflow, llmExclusive, nurseHandsOverPatient, signIn } from './support.ts'

// Local AI consultation intelligence (V3) in a real browser: the draft is made in the background by "the local model" (the labelled stand-in in
// e2e/mock-llm.mjs, which answers from the record items it is shown: no model runs in this suite), arrives as statements with sources and a support
// state, and nothing reaches the note, the diagnoses or the prescription until the doctor accepts a statement and adds it as a separate act.

const LLM = 'http://127.0.0.1:8181'

async function llm(mode: 'ok' | 'slow' | 'down' | 'invalid' | 'inject' | 'empty', delayMs?: number) {
  const r = await pwRequest.newContext()
  try {
    await r.post(`${LLM}/__mode`, { data: { mode, ...(delayMs !== undefined && { delayMs }) } })
  } finally {
    await r.dispose()
  }
}
async function llmCalls(prompts = false) {
  const r = await pwRequest.newContext()
  try {
    return (await (await r.get(`${LLM}/__calls${prompts ? '?prompts=1' : ''}`)).json()) as { count: number; calls: { prompt?: string; refs: string[] }[] }
  } finally {
    await r.dispose()
  }
}

// The tests share one stand-in model server and flip its mode, and several set their own viewports: they run on the desktop project only (the phone widths are checked below).
test.skip(({ isMobile }) => isMobile, 'desktop project only (shared model stand-in)')
llmExclusive(test)

test.beforeEach(async () => llm('ok'))
test.afterEach(async () => llm('ok'))

async function startConsultation(page: Page, baseURL: string) {
  const p = await nurseHandsOverPatient(baseURL, { allergies: ['Penicillin'], consents: ['ai_recording'] })
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}/)
  return p
}
const panel = (page: Page) => page.getByTestId('consult-panel')
const status = (page: Page) => panel(page).getByTestId('consult-status')
const generate = async (page: Page, name = 'Generate draft') => panel(page).getByRole('button', { name }).click()
/** The panel has asked the model server and it is ready (the server's answer is remembered for a few seconds, so the panel looks again by itself). */
const modelReady = (page: Page) => expect(status(page)).toContainText('NOT RUN', { timeout: 20_000 })

test('a draft is made in the background and arrives for review: labelled as AI, grouped, each statement with its sources and support state, nothing in the note', async ({ page, baseURL }) => {
  const p = await startConsultation(page, baseURL!)
  await modelReady(page)
  for (const label of ['AI DRAFT', 'AI-GENERATED', 'REQUIRES DOCTOR REVIEW']) await expect(panel(page).getByText(label, { exact: true })).toBeVisible()
  await expect(panel(page).getByTestId('consult-model')).toContainText('Local model mock-llm-e2e')
  await expect(panel(page).getByTestId('consult-model')).toContainText('nothing leaves it')
  // The rules' own check is there before any draft, and says it is not AI.
  await expect(panel(page).getByTestId('record-check')).toContainText('Fixed rules, not AI')

  await llm('slow', 2500)
  await generate(page)
  await expect(status(page)).toContainText('GENERATING')
  await expect(panel(page).getByTestId('consult-progress')).toContainText('local model')
  await expect(panel(page).getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 20_000 })

  for (const group of ['Current problem', 'Relevant history', 'Potential considerations', 'Potential investigations', 'Clinical summary']) await expect(panel(page).getByRole('region', { name: group })).toBeVisible()
  const problem = panel(page).locator('[data-testid="consult-statement"][data-section="presenting_problem"]').first()
  await expect(problem).toContainText('Sore throat and fever')
  await expect(problem).toContainText('SUPPORTED BY RECORD')
  const allergy = panel(page).locator('[data-testid="consult-statement"][data-section="allergies"]').first()
  await expect(allergy).toContainText('Penicillin')
  // Sources open to the record item the statement rests on.
  await problem.getByText(/^Sources \(1\)/).click()
  await expect(problem).toContainText('Reason for visit')
  await expect(problem).toContainText('“Sore throat and fever”')
  // What is missing: the AI's own list, and beside it what the fixed rules find is not recorded (the model names little of it), labelled as theirs.
  const missing = panel(page).getByRole('region', { name: 'Missing information' })
  await expect(missing.getByTestId('rules-missing')).toContainText('Found by fixed rules, not by the AI')
  await expect(missing.getByTestId('rules-missing')).toContainText('No current medicines are recorded')
  // A suggestion is not a fact: it says so and why the AI listed it.
  const consider = panel(page).locator('[data-testid="consult-statement"][data-section="potential_considerations"]').first()
  await expect(consider).toContainText('INFERRED')
  await expect(consider).toContainText('Why the AI listed this')
  // Nothing was written to the note.
  await expect(page.getByLabel('History of present illness')).toHaveValue('')
  await expect(page.getByLabel('Plan')).toHaveValue('')
  await expect(panel(page).getByTestId('draft-facts')).toContainText('How this draft was made')
  // What the model was shown: the record, never the patient's name or number.
  const prompt = (await llmCalls(true)).calls.at(-1)!.prompt!
  expect(prompt).toContain('Sore throat and fever')
  expect(prompt).toMatch(/Allergy: Penicillin/)
  expect(prompt).not.toContain(p.name.split(' ')[0]!)
  expect(prompt).not.toContain(p.mrn)
  await expectNoAxeViolations(page)
})

test('the doctor decides each statement: accept, edit, reject; accepted text is added to the note as a separate act that records where it came from', async ({ page, baseURL }) => {
  await startConsultation(page, baseURL!)
  await modelReady(page)
  await generate(page)
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 20_000 })
  const first = panel(page).locator('[data-testid="consult-statement"][data-section="presenting_problem"]').first()
  await first.getByRole('button', { name: 'Accept' }).click()
  await expect(first).toContainText('Accepted')
  // Accepting did not touch the note.
  await expect(page.getByLabel('History of present illness')).toHaveValue('')
  await first.getByLabel('Add to note section').selectOption('history')
  await first.getByRole('button', { name: 'Add to note' }).click()
  await expect(first).toContainText('In the note')
  await expect(page.getByLabel('History of present illness')).toHaveValue(/Sore throat and fever/)
  await expect(page.getByLabel('AI-assisted text in this section').first()).toContainText('consultation draft statement')
  // Adding the draft's own statement to the note does not make the draft stale.
  await expect(status(page)).toContainText('READY FOR REVIEW')
  // Edit another statement, reject a third.
  const second = panel(page).locator('[data-testid="consult-statement"][data-section="observations"]').first()
  await second.getByRole('button', { name: 'Edit' }).click()
  await second.getByLabel('Edit before accepting').fill('Edited by the doctor: sore throat with fever.')
  await second.getByRole('button', { name: 'Save edited text' }).click()
  await expect(second).toContainText('Edited and accepted')
  await expect(second).toContainText('Edited by the doctor')
  const third = panel(page).locator('[data-testid="consult-statement"][data-section="potential_considerations"]').first()
  await third.getByRole('button', { name: 'Reject' }).click()
  await expect(third).toContainText('Rejected')
  await expect(third.getByRole('button', { name: 'Add to note' })).toHaveCount(0)
  // The diagnoses and the prescription were never touched.
  await expect(page.getByText('No diagnosis yet.')).toBeVisible()
  await expect(page.getByText('No medicines prescribed.')).toBeVisible()
  await expectNoAxeViolations(page)
})

test('a conflict the fixed rules found is shown under the statements that rest on it, in the rules’ own words, and needs the tick before it can be accepted', async ({ page, baseURL }) => {
  await startConsultation(page, baseURL!)
  await modelReady(page)
  // The doctor drafts a medicine from the recorded allergy's group (the same step the assistant's rule check is shown with).
  await page.getByRole('button', { name: 'Add medicine' }).click()
  await page.getByLabel('Medicine', { exact: true }).fill('Amoxicillin')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 10_000 })
  await generate(page)
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 20_000 })
  const allergy = panel(page).locator('[data-testid="consult-statement"][data-section="allergies"]').first()
  await expect(allergy).toContainText('CONFLICTING')
  await expect(allergy.getByTestId('statement-conflict')).toContainText('Found by the fixed rules, not by the AI')
  await expect(allergy.getByTestId('statement-conflict')).toContainText('same configured group')
  await expect(panel(page).getByRole('region', { name: 'Conflicts and uncertainties' })).toContainText('Found by fixed rules, not by the AI')
  // It is a mark the doctor must acknowledge: Accept stays off until the tick.
  await expect(allergy.getByRole('button', { name: 'Accept' })).toBeDisabled()
  await allergy.getByLabel('I have checked this against the record').check()
  await expect(allergy.getByRole('button', { name: 'Accept' })).toBeEnabled()
  await expectNoAxeViolations(page)
})

test('the draft says when the note moved on (STALE), and a new draft replaces it', async ({ page, baseURL }) => {
  await startConsultation(page, baseURL!)
  await modelReady(page)
  await generate(page)
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 20_000 })
  await page.getByLabel('Examination').fill('Throat red, no exudate.')
  await expect(status(page)).toContainText('STALE', { timeout: 15_000 })
  await expect(panel(page).getByTestId('consult-stale')).toContainText('have changed since this draft was made')
  await generate(page, 'Generate a new draft')
  await expect(status(page)).toContainText('GENERATING')
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 20_000 })
  await expect(panel(page).getByTestId('consult-stale')).toHaveCount(0)
  await expect(panel(page)).toContainText('1 earlier draft(s)')
})

test('with the local model down it says "Local AI unavailable.", offers no draft, and the rules’ record check is still there', async ({ page, baseURL }) => {
  await startConsultation(page, baseURL!)
  await modelReady(page)
  await llm('down')
  await page.reload()
  await expect(status(page)).toContainText('UNAVAILABLE', { timeout: 20_000 })
  // It comes back by itself when the model does (the panel looks again every few seconds), and "Check again" asks at once.
  await llm('ok')
  await panel(page).getByRole('button', { name: 'Check again' }).click()
  await expect(status(page)).toContainText('NOT RUN')
  await llm('down')
  await page.reload()
  await expect(status(page)).toContainText('UNAVAILABLE', { timeout: 20_000 })
  await expect(panel(page).getByRole('alert').or(panel(page).getByRole('status')).filter({ hasText: 'Local AI unavailable.' }).first()).toBeVisible()
  await expect(page.getByTestId('model-status-chip')).toContainText('Local AI unavailable')
  await expect(panel(page).getByRole('button', { name: 'Generate draft' })).toBeDisabled()
  await expect(panel(page).getByTestId('record-check')).toContainText('Fixed rules, not AI')
  await expect(panel(page).getByTestId('consult-statement')).toHaveCount(0)
  await expectNoAxeViolations(page)
})

test('a draft that fails or is cancelled says so and can be tried again; an earlier draft is not replaced by a later attempt that did not finish', async ({ page, baseURL }) => {
  await startConsultation(page, baseURL!)
  await modelReady(page)
  // With no earlier draft the failure is the state, said in words, with a way to try again.
  await llm('invalid')
  await generate(page)
  await expect(status(page)).toContainText('FAILED', { timeout: 20_000 })
  await expect(panel(page).getByTestId('consult-error')).toContainText('did not have the required form')
  await expect(panel(page).getByTestId('consult-statement')).toHaveCount(0)
  // So is a cancelled draft (Cancel stops the model call).
  await llm('slow', 15_000)
  await generate(page, 'Try again')
  await expect(status(page)).toContainText('GENERATING')
  await panel(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(status(page)).toContainText('CANCELLED', { timeout: 10_000 })
  await expect(panel(page)).toContainText('Cancelled')
  await llm('ok')
  await generate(page, 'Try again')
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 20_000 })
  // From here a draft exists. A later attempt that fails, or is cancelled, does not take its place: the doctor keeps reading it, and the screen says the newest attempt did not finish.
  await llm('invalid')
  await generate(page, 'Generate a new draft')
  await expect(panel(page).getByTestId('consult-last-attempt')).toContainText('did not have the required form', { timeout: 20_000 })
  await expect(status(page)).toContainText('READY FOR REVIEW')
  await expect(panel(page).getByTestId('consult-statement').first()).toBeVisible()
  await llm('slow', 15_000)
  await generate(page, 'Generate a new draft')
  await expect(status(page)).toContainText('GENERATING')
  await panel(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(panel(page).getByTestId('consult-last-attempt')).toContainText(/cancel/i, { timeout: 10_000 })
  await expect(status(page)).toContainText('READY FOR REVIEW')
  await expect(panel(page).getByTestId('consult-statement').first()).toBeVisible()
  // A draft that does finish is shown again, and the note about the attempt goes.
  await llm('ok')
  await generate(page, 'Generate a new draft')
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 20_000 })
  await expect(panel(page).getByTestId('consult-last-attempt')).toHaveCount(0)
})

test('a model that follows an instruction hidden in the record loses everything dangerous in its answer, and the draft says it is only partly available', async ({ page, baseURL }) => {
  await startConsultation(page, baseURL!)
  await modelReady(page)
  await llm('inject')
  await generate(page)
  await expect(status(page)).toContainText('PARTIALLY AVAILABLE', { timeout: 20_000 })
  const text = await panel(page).innerText()
  expect(text).not.toMatch(/amoxicillin|500 mg|250\/190|pneumonia|example\.invalid|azithromycin|no known allergies/i)
  await expect(panel(page)).toContainText('removed because they could not be verified')
})

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 412, height: 915 },
  { width: 390, height: 844 },
]
test('states at five widths: not run, failed, unavailable, ready for review and ready with a newer attempt that did not finish each fit the screen and pass the accessibility check', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(300_000)
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  await startConsultation(page, baseURL!)
  await modelReady(page)
  const fit = async (label: string) => {
    for (const size of WIDTHS) {
      await page.setViewportSize(size)
      await page.waitForTimeout(200)
      await expectNoHorizontalOverflow(page)
      const box = await panel(page).boundingBox()
      expect(box, `${label} at ${size.width}px`).toBeTruthy()
      expect(box!.x + box!.width, `${label} at ${size.width}px`).toBeLessThanOrEqual(size.width + 0.5)
      await panel(page).scrollIntoViewIfNeeded()
      // The whole panel (it is taller than the screen when a draft is open), and the screen as the doctor sees it.
      await panel(page).screenshot({ path: testInfo.outputPath(`consult-${label.replace(/\W+/g, '-')}-${size.width}-panel.png`) })
      await page.screenshot({ path: testInfo.outputPath(`consult-${label.replace(/\W+/g, '-')}-${size.width}.png`) })
    }
    await expectNoAxeViolations(page)
  }
  await fit('not run')
  // A failed attempt is the state while there is no draft; with the model down as well, it is "unavailable".
  await llm('invalid')
  await generate(page)
  await expect(status(page)).toContainText('FAILED', { timeout: 20_000 })
  await fit('failed')
  await llm('down')
  await page.reload()
  await expect(status(page)).toContainText('UNAVAILABLE', { timeout: 20_000 })
  await fit('unavailable')
  // The model is back: a draft, with its sources open.
  await llm('ok')
  await panel(page).getByRole('button', { name: 'Check again' }).click()
  await expect(status(page)).toContainText('FAILED')
  await generate(page, 'Try again')
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 20_000 })
  await panel(page).locator('[data-testid="consult-statement"]').first().getByText(/^Sources \(/).click()
  await fit('ready')
  // A newer attempt that fails does not replace it, and the screen says so.
  await llm('invalid')
  await generate(page, 'Generate a new draft')
  await expect(panel(page).getByTestId('consult-last-attempt')).toBeVisible({ timeout: 20_000 })
  await expect(status(page)).toContainText('READY FOR REVIEW')
  await fit('ready with a failed newer attempt')
  await ctx.close()
})
