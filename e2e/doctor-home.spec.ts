import { expect, test } from '@playwright/test'
import { bookViaApi, clockText, hhmm, newPatient, randomSlot, staff } from './appointments-support.ts'
import { moveAppointmentToToday } from './e2e-db.ts'
import { expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, signIn, uniq } from './support.ts'

/**
 * The application shell and the doctor's Home. These journeys check what is on
 * screen against what the API holds (nothing is invented), the shell's own
 * behaviour (patient search, the phone drawer), and the loading, error and
 * denied states of the schedule.
 */

test('the doctor’s Home shows how the day stands from real data, and its shortcuts lead to real pages', async ({ page, baseURL }) => {
  const nurse = await staff(baseURL!, 'nurse.anil')
  const slot = await randomSlot(nurse)
  const booked = await newPatient(nurse, `Ho${uniq()}`)
  // Unassigned in the doctor's department, so it is in their schedule without taking the doctor's slot (parallel runs book the same doctor).
  const appt = await bookViaApi(nurse, booked.id, slot)
  // The first hour of today, so it is among the first rows of the schedule card (which lists the earliest few) whatever else was
  // booked by other tests; the database move to today is e2e-only.
  const time = hhmm(0, 5 * Math.floor(Math.random() * 12))
  await moveAppointmentToToday(appt.id, time)
  // With an allergy on record: the Home row shows an allergy chip only when there is one (DESIGN §5.1), so the chip can be checked.
  const ready = await nurseHandsOverPatient(baseURL!, { allergies: ['Penicillin'] })

  await signIn(page, 'dr.meera')
  await expect(page).toHaveURL(/\/doctor$/)
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Dr\. Meera$/ })).toBeVisible()
  await expect(page.getByTestId('signed-in-user')).toContainText('Meera')

  // Four numbers, each a real count (not a placeholder), with their names. Premium Home: Completed · Waiting · In consultation · Upcoming (the
  // number first, then its name), the day's total beside Today's patients; each the server's own count (GET /api/doctor/day), read again until
  // both agree (the page polls every 30 s).
  const glance = page.getByRole('list', { name: 'Today at a glance' })
  const tiles = [
    ['Completed', 'day-seen', 'seen'],
    ['Waiting', 'day-waiting', 'waiting'],
    ['In consultation', 'day-in-consultation', 'inConsultation'],
    ['Upcoming', 'day-yet-to-see', 'yetToSee'],
  ] as const
  for (const [label, testId] of tiles) {
    await expect(glance.getByRole('listitem').filter({ hasText: label })).toHaveAttribute('data-testid', testId)
    await expect(glance.getByTestId(testId)).toContainText(/\d/)
  }
  await expect(glance.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect
    .poll(
      async () => {
        const counts = (await (await page.request.get('/api/doctor/day?period=today')).json()).counts as Record<string, number>
        const shown = await Promise.all(tiles.map(async ([, testId]) => Number((await glance.getByTestId(testId).locator('p').nth(0).innerText()).trim())))
        const total = Number(/^(\d+)/.exec((await page.getByTestId('day-total').innerText()).trim())?.[1])
        return JSON.stringify([...shown, total]) === JSON.stringify([...tiles.map(([, , key]) => counts[key]), counts.total]) ? 'same' : `shown ${JSON.stringify([...shown, total])}, server ${JSON.stringify(counts)}`
      },
      { timeout: 35_000 },
    )
    .toBe('same')

  // Today's patients (redesign: one list instead of the schedule card). The booked appointment is there at its time, yet to see, and offers
  // nothing (no check-in on the doctor's Home, DESIGN §5.1); the patient who was handed over is ready for the doctor, in the same list.
  const todays = page.getByRole('list', { name: 'Today’s patients' })
  const row = todays.locator(`[data-row-key="appointment:${appt.id}"]`)
  await expect(row).toContainText(booked.name)
  await expect(row).toContainText(clockText(time))
  await expect(row.locator('[data-status="yet_to_see"]')).toHaveText('Yet to see')
  await expect(row.getByRole('button')).toHaveCount(0)
  const readyRow = todays.getByRole('listitem').filter({ hasText: ready.name })
  await expect(readyRow).toContainText('Ready for doctor')
  // Whoever is one click from a consultation is identified as precisely as in the queue: MRN, age and sex, allergy.
  await expect(readyRow).toContainText(ready.mrn)
  await expect(readyRow).toContainText(/\d+ y · Female/)
  await expect(readyRow).toContainText('Allergy: Penicillin')
  await expect(readyRow.getByRole('button', { name: 'Start consultation' })).toBeVisible()
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // The shortcuts are links to pages that exist. Redesign (DESIGN §4-5.1): Home has no quick actions; the doctor's four places are the
  // navigation, "View all" leads to My consultations, and its quiet link to the drafts and signed records.
  await expect(page.getByRole('region', { name: 'Quick actions' })).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: 'Doctor navigation' })
  for (const [name, url, heading] of [
    ['Patients', /\/doctor\/patients$/, 'Patients'],
    ['Thermal', /\/doctor\/thermal$/, 'Thermal'],
    ['My consultations', /\/doctor\/queue$/, 'My consultations'],
  ] as const) {
    await page.goto('/doctor')
    await nav.getByRole('link', { name }).click()
    await expect(page).toHaveURL(url)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  }
  await page.getByRole('link', { name: 'Drafts and signed records' }).click()
  await expect(page).toHaveURL(/\/doctor\/consultations$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Drafts and signed records' })).toBeVisible()
  await page.goto('/doctor')
  await page.getByRole('link', { name: 'View all' }).click()
  await expect(page).toHaveURL(/\/doctor\/queue$/)
  await expect(page.getByRole('heading', { level: 1, name: 'My consultations' })).toBeVisible()
  await nurse.dispose()
})

test('patient search from the top bar: offered to doctors and nurses only, and the term never goes into the address', async ({ page, browser, baseURL }) => {
  const nurse = await staff(baseURL!, 'nurse.anil')
  const p = await newPatient(nurse, `Se${uniq()}`)

  await signIn(page, 'dr.meera')
  await expect(page.getByRole('search')).toBeVisible()
  await page.getByLabel('Search patients by name, MRN or phone number').fill(p.given)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/doctor\/patients$/)
  // The term is not in the address (so not in the history or a shared link), and the page has already searched for it.
  expect(page.url()).not.toContain(p.given)
  await expect(page.getByLabel('Search patients', { exact: true })).toHaveValue(p.given)
  await expect(page.getByRole('link', { name: p.name })).toBeVisible()
  await expectNoAxeViolations(page)

  // The term was taken once and cleared from the history entry: a reload does not repeat the search.
  expect(await page.evaluate(() => (history.state as { usr?: unknown } | null)?.usr ?? null)).toBeNull()

  // One character, or spaces, is not a search: the browser refuses to submit, so the top bar keeps what was typed and the
  // Patients page keeps what it had.
  const topBar = page.getByLabel('Search patients by name, MRN or phone number')
  for (const typed of ['a', 'a ', '  ']) {
    await topBar.fill(typed)
    await page.keyboard.press('Enter')
    await expect(topBar).toHaveValue(typed)
    // The browser, not just our handler, refuses it: the field is invalid for each of these, and valid for a real term.
    expect(await topBar.evaluate((el: HTMLInputElement) => el.validity.valid), JSON.stringify(typed)).toBe(false)
  }
  await topBar.fill('ab')
  expect(await topBar.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true)
  await topBar.fill('')
  await expect(page.getByLabel('Search patients', { exact: true })).toHaveValue(p.given)

  // A new search from the top bar, made while already on the Patients page, replaces the term and searches for it.
  const other = await newPatient(nurse, `Sf${uniq()}`)
  await page.getByLabel('Search patients by name, MRN or phone number').fill(other.given)
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Search patients', { exact: true })).toHaveValue(other.given)
  await expect(page.getByRole('link', { name: other.name })).toBeVisible()
  await expect(page.getByRole('link', { name: p.name })).toHaveCount(0)

  // An administrator has no patient search.
  const admin = await browser.newContext({ baseURL })
  const adminPage = await admin.newPage()
  await signIn(adminPage, 'admin')
  await expect(adminPage.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(adminPage.getByRole('search')).toHaveCount(0)
  await admin.close()
  await nurse.dispose()
})

test('on a phone the menu is a drawer: focus moves in, Escape closes it and focus returns, choosing a page closes it', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the drawer exists below the desktop breakpoint')
  await signIn(page, 'dr.meera')
  const open = page.getByRole('button', { name: 'Open menu' })
  await expect(page.getByRole('navigation', { name: 'Doctor navigation' })).toBeHidden()
  await open.click()
  const nav = page.getByRole('navigation', { name: 'Doctor navigation' })
  await expect(nav).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused()
  // The page behind cannot be reached while the drawer is open (it is inert), and can again afterwards.
  const behindIsInert = () => open.evaluate((el) => !!el.closest('[inert]'))
  expect(await behindIsInert()).toBe(true)
  await page.keyboard.press('Escape')
  await expect(nav).toBeHidden()
  await expect(open).toBeFocused()
  expect(await behindIsInert()).toBe(false)

  await open.click()
  await page.getByRole('button', { name: 'Close menu' }).click()
  await expect(nav).toBeHidden()

  // Choosing a page closes the drawer and moves focus to the new page (for a keyboard or screen-reader user, not the top of the document).
  // Appointments is no longer in the doctor's navigation (DESIGN §4: Home · My consultations · Patients · Thermal), so My consultations (a
  // page without a field that takes focus by itself, as Appointments was) is chosen.
  await open.click()
  await nav.getByRole('link', { name: 'My consultations' }).click()
  await expect(page).toHaveURL(/\/doctor\/queue$/)
  await expect(nav).toBeHidden()
  await expect(page.locator('#main')).toBeFocused()
  // Choosing the page you are already on also closes it.
  await open.click()
  await nav.getByRole('link', { name: 'My consultations' }).click()
  await expect(nav).toBeHidden()

  // The dimmed page behind the drawer closes it too, and the page does not scroll while it is open.
  await open.click()
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
  await page.mouse.click(395, 600)
  await expect(nav).toBeHidden()
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden')

  // Growing to the desktop layout with the drawer open makes it the permanent sidebar and leaves the page usable.
  await open.click()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(nav).toBeVisible()
  await expect(page.locator('[inert]')).toHaveCount(0)
  await page.setViewportSize({ width: 412, height: 915 })
  await expect(nav).toBeHidden()
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
})

test('the schedule shows loading, failure with a retry, and refusal without one', async ({ browser, baseURL, isMobile }) => {
  // The service worker would answer for the page; blocked here so the forced responses are seen.
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block', ...(isMobile && { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }) })
  const page = await ctx.newPage()
  await signIn(page, 'dr.meera')
  const schedule = /\/api\/appointments\?/

  // Loading: placeholders, announced as a status, until the answer comes.
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  await page.route(schedule, async (route) => {
    await gate
    await route.continue()
  })
  await page.goto('/doctor/appointments')
  await expect(page.getByRole('status').filter({ hasText: 'Loading the schedule…' })).toBeAttached()
  release()
  await expect(page.getByRole('status').filter({ hasText: 'Loading the schedule…' })).toHaveCount(0)
  await page.unroute(schedule)

  // Failure: what happened and a way to try again, which works once the server answers.
  await page.route(schedule, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error', message: 'Something went wrong' }) }))
  await page.goto('/doctor/appointments')
  const failed = page.getByRole('alert').filter({ hasText: 'Cannot load the schedule' })
  await expect(failed).toBeVisible({ timeout: 20_000 })
  await expectNoAxeViolations(page)
  await page.unroute(schedule)
  await failed.getByRole('button', { name: 'Try again' }).click()
  await expect(failed).toBeHidden()
  await expect(page.getByRole('group', { name: 'Filter by status' })).toBeVisible()

  // Refusal: said plainly, with nothing to retry.
  await page.route(schedule, (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden', message: 'Your role cannot do this.' }) }))
  await page.goto('/doctor/appointments')
  const denied = page.getByRole('alert').filter({ hasText: 'You do not have access to this' })
  await expect(denied).toBeVisible()
  await expect(denied.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expectNoAxeViolations(page)
  await ctx.close()
})

test('the schedule is a table where there is room (1280 px and up) and cards below it, with no overflow at tablet and laptop widths', async ({ page, baseURL, isMobile }) => {
  test.skip(isMobile, 'widths are set explicitly here')
  const nurse = await staff(baseURL!, 'nurse.anil')
  const slot = await randomSlot(nurse)
  const p = await newPatient(nurse, `Tb${uniq()}`)
  await bookViaApi(nurse, p.id, slot)
  await signIn(page, 'nurse.anil')
  await page.goto('/nurse/appointments')
  await page.getByRole('group', { name: 'Which appointments' }).getByRole('button', { name: 'A date' }).click()
  await page.getByLabel('Date').fill(slot.date)
  const row = page.getByTestId(/^appointment-/).filter({ hasText: p.name })
  await expect(row).toBeVisible()
  const header = page.getByText('Clinician', { exact: true })
  for (const [width, table] of [
    [1440, true],
    [1280, true],
    [1024, false],
    [768, false],
  ] as const) {
    await page.setViewportSize({ width, height: 800 })
    // The column header exists only in the table layout; in both, the row is complete and nothing overflows.
    await expect(header).toBeVisible({ visible: table })
    await expect(row).toContainText('Booked')
    await expectNoHorizontalOverflow(page)
  }
  await nurse.dispose()
})

test('a dialog whose request is still running cannot be dismissed, not even by a repeated Escape, and shows the outcome', async ({ browser, baseURL, isMobile }) => {
  const nurse = await staff(baseURL!, 'nurse.anil')
  const slot = await randomSlot(nurse)
  const p = await newPatient(nurse, `Dd${uniq()}`)
  await bookViaApi(nurse, p.id, slot)
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block', ...(isMobile && { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }) })
  const page = await ctx.newPage()
  await signIn(page, 'nurse.anil')
  await page.goto('/nurse/appointments')
  await page.getByRole('group', { name: 'Which appointments' }).getByRole('button', { name: 'A date' }).click()
  await page.getByLabel('Date').fill(slot.date)
  const row = page.getByTestId(/^appointment-/).filter({ hasText: p.name })
  await row.getByRole('button', { name: /Details/ }).click()
  await page.getByRole('dialog', { name: 'Appointment' }).getByRole('button', { name: 'Cancel…' }).click()
  const dialog = page.getByRole('dialog', { name: new RegExp(`Cancel ${p.name}`) })
  await dialog.getByLabel('Reason').fill('Patient is travelling')

  // The cancellation request is held back, then answered with a failure.
  let answer!: (status: number) => void
  const held = new Promise<number>((r) => (answer = r))
  await page.route(/\/api\/appointments\/[^/]+\/cancel$/, async (route) => {
    const status = await held
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'stale_appointment', message: 'The appointment was changed by someone else. Refresh and try again.' }) })
  })
  await dialog.getByRole('button', { name: 'Cancel appointment' }).click()
  await expect(dialog.getByRole('button', { name: 'Cancel appointment' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeDisabled()

  // The failure is said inside the dialog, which can then be closed.
  answer(409)
  await expect(dialog.getByRole('alert')).toContainText('The appointment was changed by someone else')
  await dialog.getByRole('button', { name: 'Keep the appointment' }).click()
  await expect(dialog).toBeHidden()
  await ctx.close()
  await nurse.dispose()
})
