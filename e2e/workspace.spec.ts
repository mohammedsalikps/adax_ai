import { expect, type Page, test } from '@playwright/test'
import { expectNoHorizontalOverflow, nurseHandsOverPatient, signIn } from './support.ts'

/*
 * D1, the consultation as one workspace: what the layout promises beyond what each panel's own spec checks. A fault in one tool stays in that
 * tool; the bar of the tools column moves that column, not the page; the review-and-sign step cannot be closed while the signature is being
 * recorded; and only the consultation keeps the sidebar a drawer on a tablet held sideways. Synthetic patients, through the real API.
 */

async function openConsultation(page: Page, baseURL: string) {
  const p = await nurseHandsOverPatient(baseURL)
  await signIn(page, 'dr.meera')
  await page.goto('/doctor/queue')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}/)
  await expect(page.getByTestId('consultation-tools')).toBeVisible()
  return p
}

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'sets its own screen sizes'))

test('a tool that fails to draw says so in its own place; the note, the other tools and the bar keep working', async ({ browser, baseURL }) => {
  // Without the service worker, so that the forced answer below is the one the page sees.
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  // The device readings answer with something the screen cannot draw (a list that is not a list).
  await page.route('**/api/patients/*/device-readings', (route) => route.fulfill({ json: { serverTime: new Date().toISOString(), thresholds: { liveSeconds: 6, disconnectedSeconds: 14 }, consent: 'granted', devices: 'not a list' } }))
  const p = await openConsultation(page, baseURL!)
  const tools = page.getByTestId('consultation-tools')
  await expect(tools.getByRole('alert').filter({ hasText: 'The device readings could not be shown' })).toBeVisible()
  await expect(tools.getByRole('button', { name: 'Try again' })).toBeVisible()
  // The bar's status reads the same answer: it fails in its own place too, and the patient's name, MRN and allergies are still there.
  await expect(page.getByTestId('patient-banner').getByRole('alert')).toContainText('could not be shown')
  await expect(page.getByTestId('patient-banner')).toContainText(p.mrn)
  // Everything else works: the other tools are drawn, and the note can be written and is saved.
  await expect(page.getByRole('region', { name: 'Live transcription' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Stethoscope recordings' })).toBeVisible()
  await page.getByLabel('History of present illness').fill('Two days of sore throat (synthetic).')
  await expect(page.getByTestId('save-state')).toContainText(/Saved/, { timeout: 15_000 })
  await expectNoHorizontalOverflow(page)
  await ctx.close()
})

test('the bar of the tools column moves that column, not the page, and takes focus to the part; "Skip to the note" goes to the note', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openConsultation(page, baseURL!)
  const tools = page.getByTestId('consultation-tools')
  await page.evaluate(() => window.scrollTo(0, 0))
  const goTo = tools.getByRole('navigation', { name: 'Go to' })
  for (const [label, id] of [
    ['Devices', 'tools-devices'],
    ['AI draft', 'tools-draft'],
    ['Conversation', 'tools-conversation'],
  ] as const) {
    await goTo.getByRole('button', { name: label }).click()
    await expect(page.locator(`#${id}`)).toBeFocused()
    await expect(page.locator(`#${id}`)).toBeInViewport()
    // The page did not move: the note beside the tools is where the doctor left it.
    expect(await page.evaluate(() => window.scrollY), `${label}: the page scrolled`).toBe(0)
    await expect(page.getByLabel('Chief complaint')).toBeInViewport()
  }
  // The device chip in the bar leads to the devices the same way.
  await page.getByTestId('device-status-chip').click()
  await expect(page.locator('#tools-devices')).toBeFocused()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  // From the keyboard, the first stop in the tools column is the way past it, to the note.
  await tools.getByRole('button', { name: 'Skip to the note' }).focus()
  await expect(tools.getByRole('button', { name: 'Skip to the note' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('#consultation-note')).toBeFocused()
})

test('the review-and-sign step cannot be closed while the signature is being recorded', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openConsultation(page, baseURL!)
  await page.getByRole('button', { name: 'Add diagnosis' }).click()
  await page.getByLabel('Diagnosis 1', { exact: true }).fill('Acute pharyngitis (synthetic)')
  await expect(page.getByTestId('save-state')).toContainText(/Saved/, { timeout: 15_000 })
  // The signature takes a few seconds to be recorded.
  await page.route('**/api/encounters/*/sign', async (route) => {
    await new Promise((r) => setTimeout(r, 3000))
    await route.continue()
  })
  await page.getByTestId('consultation-actions').getByRole('button', { name: 'Complete consultation' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review and sign' })
  await dialog.getByLabel(/I have reviewed this record/).check()
  await dialog.getByRole('button', { name: 'Sign and complete' }).click()
  await expect(dialog.getByRole('button', { name: 'Back to editing' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  // And it completes.
  await expect(page.getByText(/^Signed /)).toBeVisible({ timeout: 20_000 })
})

test('only the consultation keeps the sidebar a drawer on a tablet held sideways; other pages keep it', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1180, height: 820 })
  await openConsultation(page, baseURL!)
  const nav = page.getByRole('navigation', { name: 'Doctor navigation' })
  await expect(nav).toBeHidden()
  // The menu button opens it as a drawer, Escape closes it and focus goes back to the button.
  const menu = page.getByRole('button', { name: 'Open menu' })
  await menu.click()
  await expect(nav).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(nav).toBeHidden()
  await expect(menu).toBeFocused()
  // Today's patients, at the same size, has the sidebar as before.
  await page.goto('/doctor/queue')
  await expect(nav).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden()
})
