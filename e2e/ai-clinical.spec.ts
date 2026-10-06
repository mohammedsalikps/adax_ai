import { expect, test } from '@playwright/test'
import { expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, openModule, openMoreTools, signIn } from './support.ts'

// The API talks to the TEST-ONLY mock of the Anthropic Messages API
// (e2e/mock-anthropic.mjs) through the real SDK. The patient is synthetic.

test('extraction with evidence and record conflicts, rule and AI recommendations, review gates, and the activity trail', async ({ page, baseURL }) => {
  const p = await nurseHandsOverPatient(baseURL!, { allergies: ['Penicillin'] })
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\//)
  // Live transcription and the important points are module 1 of the inputs rail (Doctor HERO), which starts closed.
  await openModule(page, 'Conversation')
  const live = page.getByRole('region', { name: 'Live transcription' })
  const points = page.getByRole('region', { name: 'Important points' })
  await live.getByRole('button', { name: 'Patient agrees (verbal)' }).click()
  await live.getByText('Other ways to add a transcript').click()
  await live.getByLabel('Or type or paste a transcript').fill(
    ['Doctor: What brings you in today?', 'Patient: I have a sore throat and some chest pain since yesterday.', 'Doctor: Any allergies?', 'Patient: No, no allergies.', 'Doctor: Your throat is red. Take warm saline gargles.'].join('\n'),
  )
  await live.getByRole('button', { name: 'Save typed transcript' }).click()
  await expect(live.getByTestId('transcript-line')).toHaveCount(5)

  // Important points: found by the local rules, each tied to its transcript line and checked against the record.
  await live.getByRole('button', { name: 'Find important points' }).click()
  const drafts = points.getByRole('region', { name: 'Extracted drafts' })
  await expect(drafts.getByTestId('important-point')).toHaveCount(4)
  const allergy = drafts.locator('[data-category="allergy"]')
  await expect(allergy).toContainText('Conflicts with the existing record')
  await allergy.getByText(/^Sources: S4/).click()
  await expect(allergy).toContainText('Existing record')
  await expect(allergy).toContainText('Penicillin')
  // A flagged point cannot be confirmed without an explicit tick.
  await expect(allergy.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled()
  await allergy.getByRole('button', { name: 'Set aside' }).click()
  await expect(allergy).toContainText('Extracted draft (set aside)')
  const finding = drafts.locator('[data-category="examination_finding"]')
  await expect(finding).toContainText('Doctor said')
  await finding.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(points.getByText(/^Doctor rejected \(1\)/)).toBeVisible()
  const cc = drafts.locator('[data-category="chief_complaint"]')
  await expect(cc).toContainText('Patient said')
  await cc.getByRole('button', { name: 'Confirm', exact: true }).click()
  const confirmed = points.getByRole('region', { name: 'Confirmed by the doctor' })
  await confirmed.getByRole('button', { name: 'Add to Chief complaint' }).click()
  await expect(page.getByLabel('Chief complaint')).toHaveValue(/I have a sore throat and some chest pain since yesterday/)
  await expectNoAxeViolations(page)

  // A prescription that matches the recorded allergy group, then recommendations.
  await page.getByRole('button', { name: 'Add medicine' }).click()
  await page.getByLabel('Medicine', { exact: true }).fill('Amoxicillin')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 10_000 })
  // The older assistant (its recommendations and its activity) is in the "More tools" sheet since Doctor HERO: not one of the five inputs.
  const panel = (await openMoreTools(page)).getByRole('region', { name: 'AI consultation assistant' })
  await panel.getByRole('button', { name: 'Get recommendations' }).click()
  const recs = panel.getByRole('region', { name: 'Recommendations' })
  const allergyCheck = recs.getByTestId('recommendation').filter({ hasText: 'Check Amoxicillin' })
  await expect(allergyCheck).toContainText('Rule-based check')
  await expect(allergyCheck).toContainText('Needs attention')
  await expect(allergyCheck).toContainText('safety-rules-v1')
  const redFlag = recs.getByTestId('recommendation').filter({ hasText: 'Red-flag statement' })
  await expect(redFlag).toContainText('Configured escalation instruction')
  await expect(redFlag).toContainText('Inform the duty doctor')
  const conflict = recs.getByTestId('recommendation').filter({ hasText: 'Clarify: "no allergies"' })
  await expect(conflict).toBeVisible()
  const aiRec = recs.getByTestId('recommendation').filter({ hasText: 'Consider confirming the history' })
  await expect(aiRec).toContainText('AI suggestion')
  await expect(aiRec).toContainText('recommend-v1')
  await expect(aiRec).toContainText('Duration of symptoms')
  const unsupported = recs.getByTestId('recommendation').filter({ hasText: 'Unsupported test recommendation.' })
  await expect(unsupported).toContainText('None of the data this suggestion cites could be verified')
  await expect(unsupported.getByRole('button', { name: 'Accept' })).toBeDisabled()
  await unsupported.getByRole('button', { name: 'Reject' }).click()
  await allergyCheck.getByRole('button', { name: 'Accept' }).click()
  await expect(allergyCheck).toContainText('Accepted')
  // Accepting a recommendation does not touch the note or the prescription.
  await expect(page.getByLabel('Plan', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Medicine', { exact: true })).toHaveValue('Amoxicillin')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // Activity: jobs with model and prompt/rules versions, review decisions, audit trail.
  await panel.getByRole('tab', { name: /Activity/ }).click()
  const activity = panel.getByRole('region', { name: 'AI activity' })
  await expect(activity.getByTestId('ai-job').filter({ hasText: 'Fact extraction' })).toContainText('extract-rules-v1')
  await expect(activity.getByTestId('ai-job').filter({ hasText: 'Safety rules' })).toContainText('safety-rules-v1 · rules routing-rules-v1')
  await expect(activity.getByTestId('ai-job').first()).toContainText('Synthetic data')
  await expect(activity).toContainText('Dr. Meera')
  await expect(activity).toContainText('deferred a fact')
  await activity.getByText(/^Audit trail/).click()
  await expect(activity).toContainText('ai.review')

  // Doctors can review rejected AI output across consultations.
  await page.goto('/doctor/ai-review')
  await expect(page.getByRole('heading', { name: 'AI review' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Your throat is red' }).first()).toContainText('extract-rules-v1')
  await expectNoAxeViolations(page)
})

test('administrators see AI operations as counts only', async ({ page }) => {
  await signIn(page, 'admin')
  await page.goto('/admin/ai')
  await expect(page.getByRole('heading', { name: 'AI operations' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Providers' })).toContainText('Available · anthropic · claude-opus-5-5')
  await expect(page.getByRole('region', { name: 'Providers' })).toContainText('Speech-to-text')
  const outcomes = page.getByRole('region', { name: 'Doctor review outcomes' })
  await expect(outcomes.getByRole('row').filter({ hasText: 'Extracted facts' }).first()).toContainText('extract-rules-v1')
  await expect(outcomes).toContainText('Includes synthetic')
  await expect(page.locator('main')).not.toContainText('Your throat is red')
  await outcomes.getByRole('button', { name: 'Store snapshot' }).click()
  await expect(outcomes).toContainText('ai-review-metrics-v1')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
})

test('clinical photograph in a consultation: validated upload, AI description marked unverified, doctor review before it reaches the note', async ({ page, baseURL }) => {
  const p = await nurseHandsOverPatient(baseURL!, { consents: ['clinical_photography', 'ai_image_analysis'] })
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  // The clinical photographs are in the "More tools" sheet since Doctor HERO: not one of the five inputs.
  const card = (await openMoreTools(page)).getByRole('region', { name: 'Clinical photographs' })
  await card.getByRole('button', { name: 'Add photograph' }).click()
  const dlg = page.getByRole('dialog', { name: 'Add clinical photograph' })
  // A tiny synthetic PNG (not a patient image).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  await dlg.getByLabel('Choose a file').setInputFiles({ name: 'synthetic-wound.png', mimeType: 'image/png', buffer: png })
  await dlg.getByLabel('Body site (optional)').fill('Left shin')
  await dlg.getByRole('button', { name: 'Save photograph' }).click()
  const img = card.getByTestId('clinical-image')
  await expect(img).toContainText('Wound · Left shin')
  await expect(img).toContainText('synthetic data')
  await expect(img.getByRole('img')).toHaveAttribute('alt', /Wound, Left shin/)

  await img.getByRole('button', { name: 'Describe with AI' }).click()
  const analysis = img.getByTestId('image-analysis')
  await expect(analysis).toContainText('AI-generated · unverified')
  await expect(analysis).toContainText('image-describe-v1')
  await expect(analysis).toContainText('not a diagnosis')
  // Nothing reaches the note until the doctor accepts and adds it.
  await expect(page.getByLabel('Examination')).toHaveValue('')
  await analysis.getByRole('button', { name: 'Accept' }).click()
  await analysis.getByRole('button', { name: 'Add to Examination' }).click()
  await expect(page.getByLabel('Examination')).toHaveValue(/Photograph \(Wound, Left shin\): Mock description/)
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
})
