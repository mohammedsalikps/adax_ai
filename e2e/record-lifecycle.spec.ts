import { expect, request as pwRequest, test } from '@playwright/test'
import { DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, signIn } from './support.ts'

/** Signs a consultation for a handed-over patient through the API (the signing UI is covered by doctor-workflow.spec). */
async function signedConsultation(baseURL: string) {
  const p = await nurseHandsOverPatient(baseURL)
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username: 'dr.meera', password: DEMO_PASSWORD } })).ok()).toBe(true)
  const visits = (await (await api.get('/api/visits')).json()).visits as { id: string; patient: { id: string } }[]
  const visit = visits.find((v) => v.patient.id === p.patientId)!
  const e = await (await api.post(`/api/visits/${visit.id}/encounter`)).json()
  const saved = await (
    await api.put(`/api/encounters/${e.id}/draft`, {
      data: {
        version: e.version,
        note: { ...e.note, assessment: 'Acute pharyngitis.', plan: 'Fluids and rest.' },
        diagnoses: [{ description: 'Acute pharyngitis', code: 'J02.9', kind: 'primary' }],
        prescription: [],
      },
    })
  ).json()
  expect((await api.post(`/api/encounters/${e.id}/sign`, { data: { version: saved.version, attestation: true } })).ok()).toBe(true)
  await api.dispose()
  return { ...p, encounterId: e.id as string }
}

test('a doctor finds an unsigned draft in their worklist and discards it with a reason; the visit goes back to the queue', async ({ page, baseURL }) => {
  const p = await nurseHandsOverPatient(baseURL!)
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\//)
  const draftUrl = page.url()
  // Doctor HERO final (DESIGN §5.4): the typed note is the Keyboard tab of Doctor notes (the pen is the default tab).
  await page.getByTestId('doctor-notes').getByRole('tab', { name: 'Keyboard' }).click()
  await page.getByLabel('History of present illness').fill('Started on the wrong patient by mistake.')
  await expect(page.getByTestId('save-state')).toContainText('Saved')

  // The worklist shows the draft with its visit and progress.
  await page.goto('/doctor/consultations')
  // Doctor HERO final (DESIGN §4): "My consultations" is today's queue (/doctor/queue); this page is now "Drafts and signed records".
  await expect(page.getByRole('heading', { level: 1, name: 'Drafts and signed records' })).toBeVisible()
  const drafts = page.getByRole('list', { name: 'Unsigned drafts' })
  const item = drafts.getByRole('listitem').filter({ hasText: p.name })
  await expect(item).toContainText('Draft, not signed')
  await expect(item).toContainText('2 of 7 note sections written')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // Discarding asks why, and says what will happen.
  await item.getByRole('button', { name: 'Discard…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Discard this draft?' })
  await expect(dialog).toContainText('It does not appear in the patient’s history')
  await expectNoAxeViolations(page)
  await dialog.getByRole('button', { name: 'Discard draft' }).click()
  await expect(dialog.getByText('Say why the draft is discarded')).toBeVisible()
  await dialog.getByLabel('Reason').fill('Started on the wrong patient')
  await dialog.getByRole('button', { name: 'Discard draft' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Draft discarded' })).toBeVisible()
  await expect(page.getByText(p.name)).toHaveCount(0)

  // Back in the queue, ready for a doctor; a new consultation can start.
  await page.goto('/doctor/queue')
  const row = page.getByRole('listitem').filter({ hasText: p.name })
  await expect(row).toContainText('Ready for doctor')
  await expect(row.getByRole('button', { name: 'Start consultation' })).toBeVisible()

  // The discarded draft stays readable, with who, when and why, and its status history.
  await page.goto(draftUrl)
  await expect(page.getByText('Discarded draft', { exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'This draft was discarded' })).toContainText('Reason: Started on the wrong patient')
  await expect(page.getByLabel('History of present illness')).toHaveCount(0)
  const history = page.getByRole('region', { name: 'Status history' })
  await history.getByRole('button', { name: 'Show' }).click()
  const changes = history.getByRole('list', { name: 'Status changes' })
  await expect(changes).toContainText('Consultation: Draft, not signed → Discarded draft')
  await expect(changes).toContainText('Visit: With doctor → Ready for doctor')
  await expect(changes).toContainText('Reason: Started on the wrong patient')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
})

test('a signed record is listed, checked against its fingerprints, and shows its status history', async ({ page, baseURL }) => {
  const p = await signedConsultation(baseURL!)
  await signIn(page, 'dr.meera')
  await page.goto('/doctor/consultations?show=signed')
  const signed = page.getByRole('list', { name: 'Signed consultations' }).getByRole('listitem').filter({ hasText: p.name })
  await signed.getByRole('link', { name: 'Open record' }).click()
  await expect(page).toHaveURL(new RegExp(`/doctor/encounters/${p.encounterId}$`))
  // The address changes before the record's page has replaced the list (which has a "Signed …" line per record): wait for the record itself.
  await expect(page.getByRole('heading', { level: 1, name: /^Consultation/ })).toBeVisible()
  // Doctor HERO final (DESIGN §5.6): signing no longer completes the visit, so the record also carries the status "Signed — to complete"
  // beside its signed badge ("Signed <date>"); these two are the only texts starting with "Signed".
  await expect(page.getByText(/^Signed \d/)).toBeVisible()
  await expect(page.getByText('Signed — to complete', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Signed /)).toHaveCount(2)

  // Nothing is claimed until the check has run.
  const card = page.getByRole('region', { name: 'Record verification' })
  await expect(card.getByTestId('verification-result')).toHaveCount(0)
  await card.getByRole('button', { name: 'Check now' }).click()
  const result = card.getByTestId('verification-result')
  await expect(result).toContainText('Matches its fingerprint')
  await expect(result.getByRole('list', { name: 'Verification checks' })).toContainText('Content matches its fingerprint')
  await expect(result).toContainText('It is not a digital signature')
  // The signed badge and the status are still the only texts starting with "Signed" (Doctor HERO final: the status pill is the second).
  await expect(page.getByText(/^Signed \d/)).toBeVisible()
  await expect(page.getByText(/^Signed /)).toHaveCount(2)

  const history = page.getByRole('region', { name: 'Status history' })
  await history.getByRole('button', { name: 'Show' }).click()
  await expect(history.getByRole('list', { name: 'Status changes' })).toContainText('Consultation signed')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // An amendment changes what is checked: the earlier result is cleared, and a new check covers it.
  await page.getByRole('button', { name: 'Add amendment' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add amendment' })
  await dialog.getByLabel('Reason').fill('Follow-up clarified')
  await dialog.getByLabel('Amendment').fill('Review in 5 days if not better.')
  await dialog.getByRole('button', { name: 'Add amendment' }).click()
  await expect(dialog).toBeHidden()
  await expect(card.getByTestId('verification-result')).toHaveCount(0)
  await card.getByRole('button', { name: 'Check now' }).click()
  await expect(card.getByTestId('verification-result')).toContainText('1 amendment(s) are linked in order to the signed record')
  await expect(card.getByTestId('verification-result')).toContainText('Matches its fingerprint')
})

test('an admin checks the audit log’s hash chain and compares it with a recorded head', async ({ page }) => {
  await signIn(page, 'admin')
  await page.goto('/admin/audit')
  const card = page.getByRole('region', { name: 'Audit log integrity' })
  await card.getByRole('button', { name: 'Check the chain' }).click()
  const result = card.getByTestId('audit-chain-result')
  await expect(result).toContainText('Chain intact')
  const head = (await result.getByText(/^Current head \(event \d+\)$/).textContent())!.match(/\d+/)![0]
  const hash = (await result.locator('p.font-mono').textContent())!.trim()
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  await card.getByLabel('Recorded event number').fill(head)
  await card.getByLabel('Recorded hash').fill(hash)
  await card.getByRole('button', { name: 'Compare' }).click()
  await expect(result).toContainText(`Recorded head ${head}: matches`)
  await card.getByLabel('Recorded hash').fill('f'.repeat(64))
  await card.getByRole('button', { name: 'Compare' }).click()
  await expect(result).toContainText(`Recorded head ${head}: does not match`)
  await expect(result).toContainText('Chain broken')
})
