import { expect, test } from '@playwright/test'
import { expectNoAxeViolations, nurseHandsOverPatient, openModule, openMoreTools, signIn } from './support.ts'

// In this suite the API talks to a TEST-ONLY mock of the Anthropic Messages API (e2e/mock-anthropic.mjs) through the real SDK, and
// to the TEST-ONLY stand-in for the local speech service (e2e/mock-speech.mjs). Recording itself is covered by capture.spec.ts.

test('doctor records consent, saves a transcript, reviews AI suggestions and signs only reviewed text', async ({ page, baseURL }) => {
  const p = await nurseHandsOverPatient(baseURL!)
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\//)

  // Live transcription is module 1 of the inputs rail (Doctor HERO), which starts closed; the older assistant is in the "More tools" sheet,
  // opened below once there is a transcript (it is drawn while the sheet is open).
  await openModule(page, 'Conversation')
  const live = page.getByRole('region', { name: 'Live transcription' })
  await expect(live.getByTestId('speech-status')).toContainText('Speech-to-text runs on this computer')

  // Nothing can be recorded or drafted before consent.
  await expect(live.getByRole('button', { name: 'Start recording' })).toHaveCount(0)
  await live.getByRole('button', { name: 'Patient agrees (verbal)' }).click()
  await expect(live.getByTestId('recording-consent')).toContainText('Recording consent recorded for this consultation')

  await live.getByText('Other ways to add a transcript').click()
  await live.getByLabel('Or type or paste a transcript').fill(
    ['Doctor: What brings you in today?', 'Patient: My throat hurts and I have had fever for two days.', 'Doctor: Your throat is red. Take warm saline gargles and plenty of fluids.'].join('\n'),
  )
  await live.getByRole('button', { name: 'Save typed transcript' }).click()
  const lines = live.getByTestId('transcript-line')
  await expect(lines).toHaveCount(3)
  await expect(lines.nth(1)).toContainText('My throat hurts')
  await expect(lines.nth(1)).toContainText('Patient')

  const sheet = await openMoreTools(page)
  const panel = sheet.getByRole('region', { name: 'AI consultation assistant' })
  await expect(panel).toContainText('AI drafting: available')
  await panel.getByRole('button', { name: 'Generate draft' }).click()
  const suggestions = panel.getByRole('region', { name: 'Suggestions to review' })
  await expect(suggestions).toContainText('3 pending')
  await expectNoAxeViolations(page)

  // Nothing has reached the note yet.
  await expect(page.getByLabel('Plan', { exact: true })).toHaveValue('')

  // Accept the chief complaint: accepting does not touch the note; the separate "Add to Chief complaint" appends it to the note field.
  const cc = suggestions.getByRole('listitem').filter({ hasText: 'Reports: My throat hurts' })
  const insertions: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/encounters\/[^/]+\/insertions$/.test(new URL(r.url()).pathname)) insertions.push(r.url())
  })
  await cc.getByRole('button', { name: 'Accept' }).click()
  await expect(cc.getByRole('button', { name: 'Add to Chief complaint' })).toBeVisible()
  // Give an insertion that would follow the acceptance time to be sent: none is.
  await page.waitForTimeout(1500)
  expect(insertions, 'accepting sends nothing into the note').toHaveLength(0)
  await expect(page.getByLabel('Chief complaint')).not.toHaveValue(/Reports: My throat hurts/)
  await cc.getByRole('button', { name: 'Add to Chief complaint' }).click()
  await expect.poll(() => insertions.length).toBe(1)
  await expect(page.getByLabel('Chief complaint')).toHaveValue(/Sore throat and fever\nReports: My throat hurts and I have had fever for two days\./)

  // Edit the plan before adding it.
  const plan = suggestions.getByRole('listitem').filter({ hasText: 'Doctor advised:' }).or(suggestions.getByRole('listitem').filter({ has: page.getByLabel('Edit the suggestion') }))
  await plan.getByRole('button', { name: 'Edit' }).click()
  await plan.getByLabel('Edit the suggestion').fill('Warm saline gargles; oral fluids.')
  await plan.getByRole('button', { name: 'Save edited text' }).click()
  // The edited text is accepted, not yet in the note: "Add to Plan" puts it there.
  const addPlan = suggestions.getByRole('button', { name: 'Add to Plan' })
  await expect(addPlan).toBeVisible()
  await expect(page.getByLabel('Plan', { exact: true })).toHaveValue('')
  await addPlan.click()
  await expect(page.getByLabel('Plan', { exact: true })).toHaveValue('Warm saline gargles; oral fluids.')

  // The unsourced suggestion cannot be accepted without explicit confirmation; reject it.
  const unsourced = suggestions.getByRole('listitem').filter({ hasText: 'Unsourced test suggestion.' })
  await expect(unsourced).toContainText('Not linked to any part of the transcript')
  await expect(unsourced.getByRole('button', { name: 'Accept' })).toBeDisabled()
  await unsourced.getByRole('button', { name: 'Reject' }).click()
  await expect(unsourced).toContainText('Rejected')
  await expect(page.getByLabel('Assessment')).toHaveValue('')
  // Back to the consultation (the sheet is a modal dialog; Escape closes it).
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // Sign: the signed record contains exactly what the doctor accepted.
  await page.getByRole('button', { name: 'Add diagnosis' }).click()
  await page.getByLabel('Diagnosis 1', { exact: true }).fill('Acute pharyngitis')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Complete consultation' }).click()
  const review = page.getByRole('dialog', { name: 'Review and sign' })
  await expect(review).toContainText('Warm saline gargles; oral fluids.')
  await expect(review).not.toContainText('Unsourced test suggestion.')
  await review.getByLabel(/including any AI-assisted text/).check()
  await review.getByRole('button', { name: 'Sign and complete' }).click()
  await expect(page.getByText(/^Signed /)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Consultation note' })).toContainText('Warm saline gargles; oral fluids.')
})
