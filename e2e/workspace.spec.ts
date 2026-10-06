import { expect, type Page, test } from '@playwright/test'
import { expectNoHorizontalOverflow, nurseHandsOverPatient, openModule, signIn, stepTo } from './support.ts'

/*
 * D1, the consultation as one workspace (Doctor HERO since: the five input modules in a rail on the left, Mana and the record on the right):
 * what the layout promises beyond what each panel's own spec checks. A fault in one tool stays in that tool and opens its module; a jump to a
 * module (a status chip, the workflow strip) moves the rail, not the page; the review-and-sign step cannot be closed while the signature is
 * being recorded; and only the consultation keeps the sidebar a drawer on a tablet held sideways. Synthetic patients, through the real API.
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
  // The devices' panel is in module 3, closed when the page opens: a fault inside it opens the module by itself, so the failure and its one
  // "Try again" are seen instead of hidden behind "Show" (Doctor HERO).
  await expect(tools.getByRole('alert').filter({ hasText: 'The device readings could not be shown' })).toBeVisible()
  await expect(tools.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(page.locator('#tools-devices')).toHaveAttribute('data-open', 'true')
  // The bar's status reads the same answer: it fails in its own place too, and the patient's name, MRN and allergies are still there.
  await expect(page.getByTestId('patient-banner').getByRole('alert')).toContainText('could not be shown')
  await expect(page.getByTestId('patient-banner')).toContainText(p.mrn)
  // Everything else works: the other tools are drawn, and the note can be written and is saved. Their panels are in modules that start
  // closed, so each is opened first, as the doctor would (Doctor HERO); the modules' summaries are drawn either way.
  await expect(page.getByTestId('module-conversation')).toBeVisible()
  await expect(page.getByTestId('module-stethoscope')).toBeVisible()
  await openModule(page, 'Conversation')
  await expect(page.getByRole('region', { name: 'Live transcription' })).toBeVisible()
  await openModule(page, 'Stethoscope')
  await expect(page.getByRole('region', { name: 'Stethoscope recordings' })).toBeVisible()
  await page.getByLabel('History of present illness').fill('Two days of sore throat (synthetic).')
  await expect(page.getByTestId('save-state')).toContainText(/Saved/, { timeout: 15_000 })
  await expectNoHorizontalOverflow(page)
  await ctx.close()
})

test('a jump to a module moves the inputs rail, not the page, and takes focus to it; a jump to Mana does the same where Mana has a column of its own; "Skip to the note" goes to the note', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openConsultation(page, baseURL!)
  const tools = page.getByTestId('consultation-tools')
  await page.evaluate(() => window.scrollTo(0, 0))
  // The "Go to" bar is gone (Doctor HERO: the workflow strip and the always-visible modules replace it). What leads to a module now is a
  // status chip under the banner, which opens the module and brings it into view, and the strip's "Inputs", which leads to the rail's heading.
  for (const [label, go, id] of [
    ['the device chip', () => page.getByTestId('device-status-chip').click(), 'tools-devices'],
    ['the speech chip', () => page.getByTestId('speech-status-chip').click(), 'tools-conversation'],
    ['the strip’s Inputs', () => stepTo(page, 'Inputs'), 'consultation-inputs'],
  ] as const) {
    await go()
    await expect(page.locator(`#${id}`), label).toBeFocused()
    await expect(page.locator(`#${id}`)).toBeInViewport()
    // A module reached this way is opened, so what the chip spoke of is shown.
    if (id !== 'consultation-inputs') await expect(page.locator(`#${id}`)).toHaveAttribute('data-open', 'true')
    // The page did not move: the note beside the rail is where the doctor left it. (At this width Mana is above the note in the right-hand
    // pane, so the chief complaint is no longer on the screen when the page opens, by design; it is checked at 1920px below, where it is.)
    expect(await page.evaluate(() => window.scrollY), `${label}: the page scrolled`).toBe(0)
  }

  // On a wide screen Mana and the record stand side by side, and Mana scrolls on its own: the strip's "Mana analysis" leads to its heading
  // without moving the page, and the note is on the screen from the start (the "Go to" bar's "AI draft" did this in the tools column before).
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByLabel('Chief complaint')).toBeInViewport()
  await stepTo(page, 'Mana analysis')
  await expect(page.locator('#mana-result [data-part-focus="mana-result"]')).toBeFocused()
  await expect(page.locator('#mana-result')).toBeInViewport()
  expect(await page.evaluate(() => window.scrollY), 'Mana analysis: the page scrolled').toBe(0)
  await expect(page.getByLabel('Chief complaint')).toBeInViewport()

  // From the keyboard, the first stop in the rail is the way past it, to the note.
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
