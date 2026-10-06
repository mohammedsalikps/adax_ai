import { expect, test } from '@playwright/test'
import { completeConsultation, expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, openPrescription, signIn } from './support.ts'

test('doctor consults, writes the note, prescribes, signs, prints and amends; nurse sees the saved record', async ({ page, browser, baseURL, isMobile }) => {
  const p = await nurseHandsOverPatient(baseURL!)

  await signIn(page, 'dr.meera')
  const row = page.getByRole('listitem').filter({ hasText: p.name })
  await expect(row).toContainText('Ready for doctor')
  await row.getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\//)
  const encounterUrl = page.url()

  // The banner identifies the patient; the complaint is prefilled from check-in. The typed note is the Keyboard tab of Doctor notes (the pen
  // is the default tab; DESIGN §5.4), with the same section labels as before.
  await expect(page.getByTestId('patient-banner')).toContainText(p.mrn)
  await page.getByTestId('doctor-notes').getByRole('tab', { name: 'Keyboard' }).click()
  await expect(page.getByLabel('Chief complaint')).toHaveValue('Sore throat and fever')
  await page.getByLabel('History of present illness').fill('Two days of sore throat and fever. No cough.')
  await page.getByLabel('Examination').fill('Tonsils enlarged, no exudate. Chest clear.')
  await page.getByLabel('Assessment').fill('Acute pharyngitis, likely viral.')
  await page.getByLabel('Plan').fill('Warm saline gargles, fluids, paracetamol for fever.')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 10_000 })

  // The diagnosis and the prescription are written on the prescription page (DESIGN §5.5-5.6), reached through Generate prescription.
  await openPrescription(page)
  const doc = page.getByTestId('prescription-document')
  await doc.getByRole('button', { name: 'Add diagnosis' }).click()
  await doc.getByLabel('Diagnosis 1', { exact: true }).fill('Acute pharyngitis')
  await doc.getByLabel('ICD-10 (optional)').fill('J02.9')
  await doc.getByRole('button', { name: 'Add medicine' }).click()
  await doc.getByLabel('Medicine', { exact: true }).fill('Paracetamol')
  await doc.getByLabel('Strength', { exact: true }).fill('500 mg')
  await doc.getByLabel('Form', { exact: true }).fill('Tablet')
  await doc.getByLabel('Dose', { exact: true }).fill('1 tablet')
  await doc.getByLabel('Frequency', { exact: true }).fill('Three times daily (TDS)')
  await doc.getByLabel('Duration', { exact: true }).fill('3 days')
  await doc.getByLabel('Instructions', { exact: true }).fill('After food')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 10_000 })
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // Autosave persisted to the database: a reload shows the same draft (the note's assessment folded under "Show the rest of the note").
  await page.reload()
  await expect(doc.getByLabel('Medicine', { exact: true })).toHaveValue('Paracetamol')
  await page.getByTestId('rx-clinical-note').getByRole('button', { name: /^Show the rest of the note/ }).click()
  await expect(page.getByLabel('Assessment')).toHaveValue('Acute pharyngitis, likely viral.')

  // Signing opens the review, which requires the attestation. Its button is now "Sign" (it no longer completes; DESIGN §5.6).
  await page.getByTestId('sign-and-print').click()
  const review = page.getByRole('dialog', { name: 'Review and sign' })
  await expect(review).toContainText('Acute pharyngitis (J02.9)')
  await expect(review.getByRole('button', { name: 'Sign', exact: true })).toBeDisabled()
  await review.getByLabel(/I have reviewed this record/).check()
  await expectNoAxeViolations(page)
  // Sign & print: the printout opens in a new tab as the signature is answered.
  const [printTab] = await Promise.all([page.context().waitForEvent('page', { timeout: 30_000 }), review.getByRole('button', { name: 'Sign', exact: true }).click()])
  await expect(printTab.getByRole('note').first()).toContainText('not a valid prescription')
  await expect(printTab.locator('main')).toContainText('Paracetamol 500 mg')
  await printTab.close()
  await expect(page.getByTestId('prescription-signed')).toBeVisible()

  // Signed: read-only, with print and amendment (the consultation's signed record).
  await page.getByRole('link', { name: 'Back to consultation' }).click()
  await expect(page).toHaveURL(encounterUrl)
  // The signed badge ("Signed 7 Oct 2026, 10:30 am"); "Signed — to complete" is the new pill beside it (asserted below).
  await expect(page.getByText(/^Signed \d/)).toBeVisible()
  await expect(page.getByLabel('Assessment')).toHaveCount(0)
  // The integrity hash is engineering detail, behind "Details" (DESIGN §1: never in the main view).
  await page.getByTestId('record-details').getByText('Details', { exact: true }).click()
  await expect(page.getByText('Integrity hash')).toBeVisible()
  await expectNoAxeViolations(page)

  await page.getByRole('link', { name: 'Print prescription' }).click()
  await expect(page.getByRole('note')).toContainText('not a valid prescription')
  await expect(page.locator('main')).toContainText(p.name)
  await expect(page.locator('main')).toContainText('Paracetamol 500 mg')
  await expect(page.locator('main')).toContainText('Electronically signed by Dr. Meera Iyer (synthetic)')
  await expectNoAxeViolations(page)
  await page.getByRole('button', { name: 'Back' }).click()

  await page.getByRole('button', { name: 'Add amendment' }).click()
  const amend = page.getByRole('dialog', { name: 'Add amendment' })
  await amend.getByLabel('Reason').fill('Clarify fever threshold')
  await amend.getByLabel('Amendment').fill('Take paracetamol only if temperature is above 38 °C.')
  await amend.getByRole('button', { name: 'Add amendment' }).click()
  await expect(page.getByRole('region', { name: 'Amendments' })).toContainText('Clarify fever threshold')

  // Signing did not complete the visit: it is still with the doctor, signed and to complete (DESIGN §5.6, §6).
  await expect(page.getByTestId('signed-to-complete')).toContainText('Signed — to complete')
  // Completing is the doctor's separate act, with a confirmation; then back to My consultations.
  await completeConsultation(page)

  // The visit left the open part of the doctor's list (waiting, in consultation) and is under Completed. My consultations' filter is
  // All · Waiting · Completed (DESIGN §5.2); "In the room" is now the row's pill, which must say Completed, not In consultation.
  const filter = page.getByRole('group', { name: 'Show' })
  const visits = page.getByRole('list', { name: 'Visits' })
  await filter.getByRole('button', { name: /^Waiting/ }).click()
  await expect(visits.getByRole('listitem').filter({ hasText: p.name })).toHaveCount(0)
  await filter.getByRole('button', { name: /^All/ }).click()
  await expect(visits.getByRole('listitem').filter({ hasText: p.name }).locator('[data-status]').first()).toHaveAttribute('data-status', 'completed')
  await filter.getByRole('button', { name: /^Completed/ }).click()
  await expect(visits.getByRole('listitem').filter({ hasText: p.name })).toHaveCount(1)

  // The nurse sees the saved record in the timeline and can read (not edit) it.
  const nurseCtx = await browser.newContext(isMobile ? { viewport: page.viewportSize()!, isMobile: true, hasTouch: true } : {})
  const nurse = await nurseCtx.newPage()
  await signIn(nurse, 'nurse.anil')
  await nurse.goto(`/nurse/patients/${p.patientId}`)
  const timeline = nurse.getByRole('region', { name: 'Timeline' })
  await expect(timeline).toContainText('Consultation')
  await expect(timeline).toContainText('Acute pharyngitis (J02.9)')
  await expect(timeline).toContainText('Paracetamol 500 mg')
  await expect(timeline).toContainText('1 amendment')
  await timeline.getByRole('link', { name: 'Open consultation' }).click()
  await expect(nurse.getByText(/^Signed /)).toBeVisible()
  await expect(nurse.getByRole('button', { name: 'Add amendment' })).toHaveCount(0)
  await nurseCtx.close()

  // Persistence check from a brand-new browser session.
  const fresh = await browser.newContext()
  const fp = await fresh.newPage()
  await signIn(fp, 'dr.meera')
  await fp.goto(encounterUrl)
  await expect(fp.getByText('Take paracetamol only if temperature is above 38 °C.')).toBeVisible()
  await fresh.close()
})
