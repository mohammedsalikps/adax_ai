import { type APIRequestContext, type Browser, expect, request as pwRequest, test } from '@playwright/test'
import { newPatient, staff } from './appointments-support.ts'
import { expireSessionsOf } from './e2e-db.ts'
import { DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, signIn, signOut, uniq } from './support.ts'

/**
 * The front door: the application selector, the three sign-in pages and what
 * happens after. These journeys check what a person sees and what the API
 * does about it: the pages are the product's front door, the API is the
 * security boundary, and each test that touches one checks the other.
 */

const LOGIN_PAYLOAD = (username: string, password: string, application?: string) => ({ data: { username, password, ...(application && { application }) } })

/** A browser context without the service worker, so forced responses (page.route) are seen by the page. */
async function plainContext(browser: Browser, baseURL: string, isMobile: boolean) {
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block', ...(isMobile && { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }) })
  return { ctx, page: await ctx.newPage() }
}

/** A patient with a portal account, activated through the API; returns the MRN and the password they chose. */
async function patientWithAccount(baseURL: string) {
  const nurse = await staff(baseURL, 'nurse.anil')
  const p = await newPatient(nurse, `En${uniq()}`)
  await nurse.post(`/api/patients/${p.id}/consents`, { data: { type: 'portal_access', method: 'verbal' } })
  const code = (await (await nurse.post(`/api/patients/${p.id}/portal-activation`)).json()).activationCode as string
  const password = 'Synthetic-portal-pass-1'
  const anon = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await anon.post('/api/auth/activate', { data: { mrn: p.mrn, activationCode: code, password } })).ok()).toBe(true)
  await anon.dispose()
  await nurse.dispose()
  return { mrn: p.mrn, password, name: p.name }
}

/** A staff account the admin creates for a test (it needs its temporary password changed, which these tests never get to). */
async function throwawayDoctor(baseURL: string, fullName = 'Entry Test (synthetic)') {
  const admin = await staff(baseURL, 'admin')
  const depts = (await (await admin.get('/api/departments')).json()).departments as { id: string; code: string }[]
  const username = `dr.entry.${uniq()}`
  const res = await admin.post('/api/admin/users', { data: { username, fullName, role: 'doctor', departmentId: depts.find((d) => d.code === 'GEN')!.id, temporaryPassword: 'Temporary-pass-12345' } })
  expect(res.status(), await res.text()).toBe(201)
  const id = (await res.json()).id as string
  return { username, id, admin }
}

/** A doctor account of this test's own, past the first-sign-in password change, so ending its sessions cannot disturb tests running side by side as the shared demo doctor. */
async function ownDoctor(baseURL: string, fullName?: string) {
  const t = await throwawayDoctor(baseURL, fullName)
  const password = 'Own-doctor-pass-12345'
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', LOGIN_PAYLOAD(t.username, 'Temporary-pass-12345'))).ok()).toBe(true)
  const changed = await api.post('/api/auth/change-password', { data: { currentPassword: 'Temporary-pass-12345', newPassword: password } })
  expect(changed.status(), await changed.text()).toBe(200)
  await api.dispose()
  await t.admin.dispose()
  return { username: t.username, password }
}

const me = async (api: APIRequestContext) => (await api.get('/api/auth/me')).status()

/** The page is at exactly this path (whatever the query): a plain /\/doctor$/ would also match /login/doctor. */
const at = (path: string) => (u: URL) => u.pathname === path

test('the front door shows the three applications, and each leads to its own sign-in page and nothing of the others', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1, name: 'ADAXAI' })).toBeVisible()
  await expect(page.getByText('Connected Healthcare Intelligence Platform')).toBeVisible()
  await expect(page.getByRole('list', { name: 'ADAXAI applications' })).toBeVisible()
  await expect(page.getByTestId(/^application-/)).toHaveCount(3)
  await expect(page.getByTestId('service-status')).toContainText('Sign-in service available')

  const apps = [
    { id: 'doctor', badge: 'Doctor App', cta: 'Continue as Doctor', portal: 'Doctor Portal', label: 'Doctor username', others: ['Admin username', 'MRN'] },
    { id: 'patient', badge: 'Patient App', cta: 'Continue as Patient', portal: 'Patient Portal', label: 'MRN', others: ['Doctor username', 'Admin username'] },
    { id: 'admin', badge: 'Admin App', cta: 'Continue as Admin', portal: 'Admin Portal', label: 'Admin username', others: ['Doctor username', 'MRN'] },
  ] as const
  for (const a of apps) {
    const card = page.getByTestId(`application-${a.id}`)
    await expect(card.getByRole('heading', { level: 2, name: a.badge })).toBeVisible()
    await expect(card.getByRole('link', { name: a.cta })).toHaveAttribute('href', `/login/${a.id}`)
  }
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  for (const a of apps) {
    await page.goto('/login')
    await page.getByRole('link', { name: a.cta }).click()
    await expect(page).toHaveURL(at(`/login/${a.id}`))
    await expect(page.getByRole('heading', { level: 1, name: a.portal })).toBeVisible()
    await expect(page.getByText(a.badge, { exact: true })).toBeVisible()
    await expect(page.getByLabel(a.label)).toBeVisible()
    for (const other of a.others) await expect(page.getByLabel(other)).toHaveCount(0)
    await expect(page.getByLabel(/^Password/)).toBeVisible()
    await expectNoAxeViolations(page)
    await expectNoHorizontalOverflow(page)
    await page.getByRole('link', { name: /All applications/ }).click()
    await expect(page).toHaveURL(at('/login'))
  }
})

// One test per screen size: together they were too slow for one test under a full, parallel run (the 60 s budget was reached), and a failure now names its size.
for (const [width, height] of [
  [1440, 900],
  [1280, 800],
  [1024, 768],
  [390, 844],
] as const) {
  test(`the front door and every sign-in page fit ${width} × ${height}, with real touch targets`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto('/login')
    await expect(page.getByRole('heading', { level: 1, name: 'ADAXAI' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    // Three across from 768 px up, one above the other below it.
    const boxes = await Promise.all(['doctor', 'patient', 'admin'].map((id) => page.getByTestId(`application-${id}`).boundingBox()))
    const [d, p, a] = boxes as NonNullable<(typeof boxes)[number]>[]
    if (width >= 768) expect([d!.y === p!.y, p!.y === a!.y, d!.x < p!.x && p!.x < a!.x], `${width}: one row`).toEqual([true, true, true])
    else expect([d!.y < p!.y, p!.y < a!.y, d!.x === p!.x], `${width}: stacked`).toEqual([true, true, true])
    // Every way in is a comfortable target.
    for (const cta of await page.getByRole('link', { name: /^Continue as/ }).all()) expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expectNoAxeViolations(page)
    for (const app of ['doctor', 'patient', 'admin']) {
      await page.goto(`/login/${app}`)
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      expect((await page.getByRole('button', { name: 'Sign in' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await expectNoAxeViolations(page)
    }
  })
}

test('each application signs in its own people and sends them to the right workspace', async ({ page, baseURL }) => {
  const patient = await patientWithAccount(baseURL!)
  await signIn(page, 'dr.meera')
  await expect(page).toHaveURL(at('/doctor'))
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Dr\. Meera$/ })).toBeVisible()
  await signOut(page)
  // Nurses are clinical staff: the same front door, their own workspace.
  await signIn(page, 'nurse.anil', DEMO_PASSWORD, { app: 'doctor' })
  await expect(page).toHaveURL(at('/nurse'))
  await signOut(page)
  await signIn(page, 'admin')
  await expect(page).toHaveURL(at('/admin'))
  await signOut(page)
  await signIn(page, patient.mrn, patient.password)
  await expect(page).toHaveURL(at('/patient'))
  await expect(page.getByTestId('signed-in-user')).toContainText(patient.name.split(' ')[0]!)
  await expectNoAxeViolations(page)
})

test('wrong passwords, unknown people and switched-off accounts all get the same plain answer; a locked account is told so', async ({ page, baseURL }) => {
  const t = await throwawayDoctor(baseURL!)
  const answers: string[] = []
  for (const [username, password] of [
    ['dr.meera', 'definitely-not-the-password'],
    [`nobody.${uniq()}`, 'definitely-not-the-password'],
  ] as const) {
    await signIn(page, username, password, { expectFailure: true, app: 'doctor' })
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Invalid username or password')
    answers.push((await alert.innerText()).trim())
    await expect(page).toHaveURL(at('/login/doctor'))
  }
  expect(answers[0]).toBe(answers[1])

  // A switched-off account, with the right password, looks the same: the page does not say which usernames exist or are off.
  const off = await t.admin.patch(`/api/admin/users/${t.id}`, { data: { isActive: false } })
  expect(off.ok()).toBe(true)
  await signIn(page, t.username, 'Temporary-pass-12345', { expectFailure: true, app: 'doctor' })
  expect((await page.getByRole('alert').innerText()).trim()).toBe(answers[0])
  await t.admin.patch(`/api/admin/users/${t.id}`, { data: { isActive: true } })

  // Wrong passwords lock it (through the API, for speed; the failed attempts above count too, so a few are enough); the right password is
  // then refused with the lock's own message.
  const anon = await pwRequest.newContext({ baseURL: baseURL!, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  const statuses: number[] = []
  for (let i = 0; i < 6 && statuses.at(-1) !== 423; i++) statuses.push((await anon.post('/api/auth/login', LOGIN_PAYLOAD(t.username, 'wrong-password-12345'))).status())
  expect(statuses.at(-1), statuses.join(',')).toBe(423)
  expect(statuses.slice(0, -1).every((s) => s === 401)).toBe(true)
  await signIn(page, t.username, 'Temporary-pass-12345', { expectFailure: true, app: 'doctor' })
  const locked = page.getByRole('alert')
  await expect(locked).toContainText('This account is temporarily locked')
  await expect(locked).toContainText('Try again in 15 minutes')
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expectNoAxeViolations(page)
  await anon.dispose()
  await t.admin.dispose()
})

test('when the service is down or failing the page says so in plain words with a way to try again, never “Request failed (502)”', async ({ browser, baseURL, isMobile }) => {
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  const loginUrl = /\/api\/auth\/login$/
  const fill = async () => {
    await page.getByLabel('Doctor username').fill('dr.meera')
    await page.getByLabel(/^Password/).fill(DEMO_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await page.goto('/login/doctor')

  // A gateway answers for the API with nothing (what the dev proxy used to do), then with the dev proxy's own words.
  await page.route(loginUrl, (r) => r.fulfill({ status: 502, body: '' }))
  await fill()
  const unavailable = page.getByRole('alert').filter({ hasText: 'Sign-in is temporarily unavailable' })
  await expect(unavailable).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Request failed')
  await expect(unavailable.getByRole('button', { name: 'Try again' })).toBeVisible()
  await page.unroute(loginUrl)
  await page.route(loginUrl, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'api_unavailable', message: 'The API is not running. Start it with `npm run dev`.' }) }))
  const second = page.waitForResponse(loginUrl)
  await unavailable.getByRole('button', { name: 'Try again' }).click()
  expect((await second).status()).toBe(503)
  await expect(unavailable).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Request failed')
  await expect(page.locator('body')).not.toContainText('npm run dev')

  // A lost connection.
  await page.unroute(loginUrl)
  await page.route(loginUrl, (r) => r.abort('connectionrefused'))
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Cannot reach the sign-in service' })).toBeVisible()

  // Too many attempts, and a server error: said as they are, without a code or a trace.
  await page.unroute(loginUrl)
  await page.route(loginUrl, (r) => r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited', message: 'Too many attempts. Try again in 36 seconds.' }) }))
  await fill()
  await expect(page.getByRole('alert')).toContainText('Too many attempts. Try again in 36 seconds.')
  await page.unroute(loginUrl)
  await page.route(loginUrl, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error', message: 'Something went wrong', requestId: 'x' }) }))
  await fill()
  const server = page.getByRole('alert').filter({ hasText: 'Something went wrong on our side' })
  await expect(server).toBeVisible()
  await expect(page.locator('body')).not.toContainText('internal_error')
  await expectNoAxeViolations(page)

  // The service comes back: trying again signs in.
  await page.unroute(loginUrl)
  await server.getByRole('button', { name: 'Try again' }).click()
  await expect(page).toHaveURL(at('/doctor'))
  await ctx.close()
})

test('the front door tells you before you type when the sign-in service is down, and recovers', async ({ browser, baseURL, isMobile }) => {
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  const ready = /\/api\/ready$/
  await page.route(ready, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ status: 'not_ready' }) }))
  await page.goto('/login')
  const banner = page.getByRole('alert').filter({ hasText: 'Sign-in is temporarily unavailable' })
  await expect(banner).toBeVisible()
  await expectNoAxeViolations(page)
  await page.unroute(ready)
  await banner.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('service-status')).toContainText('Sign-in service available')
  await ctx.close()
})

test('while the sign-in request is running the form says so and cannot be sent twice', async ({ browser, baseURL, isMobile }) => {
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let requests = 0
  await page.route(/\/api\/auth\/login$/, async (route) => {
    requests++
    await gate
    await route.continue()
  })
  await page.goto('/login/admin')
  await page.getByLabel('Admin username').fill('admin')
  await page.getByLabel(/^Password/).fill(DEMO_PASSWORD)
  const button = page.getByRole('button', { name: 'Sign in' })
  await button.click()
  await expect(button).toBeDisabled()
  await expect(page.getByTestId('login-form-admin')).toHaveAttribute('aria-busy', 'true')
  await page.getByLabel(/^Password/).press('Enter')
  release()
  await expect(page).toHaveURL(at('/admin'))
  expect(requests).toBe(1)
  await ctx.close()
})

test('signing in at the wrong application is refused with no session at all, and says which door to use', async ({ page, baseURL }) => {
  const patient = await patientWithAccount(baseURL!)
  for (const [username, password, app, label] of [
    ['dr.meera', DEMO_PASSWORD, 'admin', 'Admin username'],
    ['admin', DEMO_PASSWORD, 'doctor', 'Doctor username'],
    [patient.mrn, patient.password, 'doctor', 'Doctor username'],
    ['dr.meera', DEMO_PASSWORD, 'patient', 'MRN'],
  ] as const) {
    await page.goto(`/login/${app}`)
    await page.getByLabel(label).fill(username)
    await page.getByLabel(/^Password/).fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    const refusal = page.getByRole('alert')
    await expect(refusal).toContainText(new RegExp(`cannot (use|sign in to) the ${app[0]!.toUpperCase()}${app.slice(1)} App`))
    await expect(refusal.getByRole('link', { name: 'Choose another application' })).toHaveAttribute('href', '/login')
    await expect(page).toHaveURL(at(`/login/${app}`))
    // Nothing was signed in: the browser holds no session, and the API agrees.
    expect(await me(page.request), `${username} at ${app}`).toBe(401)
    expect((await page.context().cookies()).filter((c) => c.name === 'adaxai_session')).toHaveLength(0)
  }
})

test('someone already signed in is told so at another application’s sign-in, and nothing is carried across', async ({ page }) => {
  await signIn(page, 'dr.meera')
  await expect(page).toHaveURL(at('/doctor'))
  for (const path of ['/login/admin', '/login/patient', '/login']) {
    await page.goto(path)
    const notice = page.getByTestId('signed-in-notice')
    await expect(notice).toContainText('You are signed in as Dr. Meera Iyer (synthetic) (Doctor) in the Doctor App.')
    await expect(notice.getByRole('link', { name: 'Open my workspace' })).toHaveAttribute('href', '/doctor')
    await expect(page).toHaveURL(at(path))
  }
  // Their own application's sign-in just takes them to their workspace.
  await page.goto('/login/doctor')
  await expect(page).toHaveURL(at('/doctor'))
  // Signing out from the notice gives the form back, as a different person can now sign in.
  await page.goto('/login/admin')
  await page.getByTestId('signed-in-notice').getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Admin username')).toBeVisible()
  expect(await me(page.request)).toBe(401)
  await page.getByLabel('Admin username').fill('admin')
  await page.getByLabel(/^Password/).fill(DEMO_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(at('/admin'))
  await expect(page.locator('body')).not.toContainText('Meera')
})

test('a role cannot reach another application by its address: a plain no-access page, and the API refuses the data', async ({ page, baseURL }) => {
  const patient = await patientWithAccount(baseURL!)
  type Case = { who: string; password: string; app: 'doctor' | 'patient' | 'admin'; visits: [string, string][]; api: [string, number][] }
  const cases: Case[] = [
    { who: 'dr.meera', password: DEMO_PASSWORD, app: 'doctor', visits: [['/admin/users', 'Admin App'], ['/patient/records', 'Patient App']], api: [['/api/admin/users', 403], ['/api/portal/appointments', 403]] },
    { who: 'nurse.anil', password: DEMO_PASSWORD, app: 'doctor', visits: [['/admin', 'Admin App'], ['/patient', 'Patient App']], api: [['/api/admin/users', 403], ['/api/portal/appointments', 403]] },
    { who: 'admin', password: DEMO_PASSWORD, app: 'admin', visits: [['/doctor/appointments', 'Doctor App'], ['/patient', 'Patient App']], api: [['/api/patients', 403], ['/api/appointments/options', 403]] },
    { who: patient.mrn, password: patient.password, app: 'patient', visits: [['/doctor', 'Doctor App'], ['/admin/audit', 'Admin App']], api: [['/api/patients', 403], ['/api/admin/users', 403], ['/api/appointments', 403]] },
  ]
  for (const c of cases) {
    await signIn(page, c.who, c.password, { app: c.app })
    for (const [path, appLabel] of c.visits) {
      await page.goto(path)
      await expect(page).toHaveURL(at(path))
      await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^This account cannot access the ${appLabel}$`) }), `${c.who} at ${path}`).toBeVisible()
      await expect(page.getByTestId('signed-in-user')).toHaveCount(0) // none of the other application's shell is rendered
    }
    for (const [url, status] of c.api) expect((await page.request.get(url)).status(), `${c.who} GET ${url}`).toBe(status)
    await page.goto('/')
    await signOut(page)
  }
})

test('a signed-out visitor is sent to the right sign-in and comes back to the page they asked for, but never to another role’s page', async ({ page, baseURL }) => {
  await page.goto('/doctor/appointments')
  await expect(page).toHaveURL(/\/login\/doctor\?next=%2Fdoctor%2Fappointments$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Doctor Portal' })).toBeVisible()
  await page.getByLabel('Doctor username').fill('dr.meera')
  await page.getByLabel(/^Password/).fill(DEMO_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(at('/doctor/appointments'))
  await signOut(page)
  await page.goto('/patient/visits')
  await expect(page).toHaveURL(/\/login\/patient\?next=/)
  // A destination that is not the signed-in role's own, or not on this site, is ignored.
  for (const next of ['/admin/users', '//evil.example/x', 'https://evil.example', '/patient', '/doctor/%2e%2e/admin', '/doctor%2f..%2fadmin', '/doctor%5c..%5cadmin']) {
    await page.goto(`/login/doctor?next=${encodeURIComponent(next)}`)
    await page.getByLabel('Doctor username').fill('dr.meera')
    await page.getByLabel(/^Password/).fill(DEMO_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page, next).toHaveURL(at('/doctor'))
    await signOut(page)
  }
  // Printable records are for the clinical roles: a patient's sign-in does not go there, whatever was asked.
  const patient = await patientWithAccount(baseURL!)
  await page.goto(`/login/patient?next=${encodeURIComponent('/print/encounters/abc')}`)
  await page.getByLabel('MRN').fill(patient.mrn)
  await page.getByLabel(/^Password/).fill(patient.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(at('/patient'))
})

test('a session survives a reload, ends at sign-out on the server, and when it expires the person is told and sent to sign in again', async ({ page, baseURL }) => {
  const doctor = await ownDoctor(baseURL!)
  await signIn(page, doctor.username, doctor.password, { app: 'doctor' })
  await page.reload()
  await expect(page).toHaveURL(at('/doctor'))
  await expect(page.getByTestId('signed-in-user')).toContainText('Entry Test')
  expect(await me(page.request)).toBe(200)

  // Sign-out ends it at the server; opening a workspace page again asks to sign in, and shows nothing of the old session.
  await signOut(page)
  expect(await me(page.request)).toBe(401)
  await page.goto('/doctor')
  await expect(page).toHaveURL(/\/login\/doctor\?next=%2Fdoctor$/)
  await expect(page.getByTestId('signed-in-user')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Entry Test')

  // Expiry in the middle of use: the next thing the page asks for fails, the page drops everything and sends them to sign in, with a notice.
  await signIn(page, doctor.username, doctor.password, { app: 'doctor' })
  await page.goto('/doctor/appointments')
  await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible()
  expect(await expireSessionsOf(doctor.username)).toBeGreaterThan(0)
  await page.getByRole('group', { name: 'Which appointments' }).getByRole('button', { name: 'Upcoming' }).click()
  await expect(page).toHaveURL(/\/login\/doctor\?.*reason=session_ended/)
  await expect(page.getByText('Your session ended')).toBeVisible()
  await expect(page.locator('body')).not.toContainText('Appointments to come')
  // Signing in again works and starts clean.
  await page.getByLabel('Doctor username').fill(doctor.username)
  await page.getByLabel(/^Password/).fill(doctor.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('signed-in-user')).toContainText('Entry Test')
  // After a reload with an expired session there is no notice (nothing was in use), just the sign-in.
  await expireSessionsOf(doctor.username)
  await page.reload()
  await expect(page).toHaveURL(/\/login\/doctor\?next=/)
  await expect(page.getByText('Your session ended')).toHaveCount(0)
})

test('the sign-in pages work from the keyboard: labelled fields in a sensible order, a visible focus, Enter to submit, and a password that can be shown', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard order is checked on desktop')
  await page.goto('/login')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Continue as Doctor' })).toBeFocused()
  // A focused control is plainly marked.
  expect(await page.getByRole('link', { name: 'Continue as Doctor' }).evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(at('/login/doctor'))
  // The address changes before the page does (the route loads on its first visit, slowly on a cold development server): wait for the form itself,
  // or the focus starting point is still in the page that is being replaced and the first Tab lands somewhere else.
  await expect(page.getByLabel('Doctor username')).toBeVisible()

  // From the top: the way back to the applications comes before the fields, then username, password, the toggle, Sign in.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (const name of ['Skip to main content', /ADAXAI/, /All applications/]) {
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name }).first()).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Doctor username')).toBeFocused()
  await page.keyboard.type('dr.meera')
  await page.keyboard.press('Tab')
  await expect(page.getByLabel(/^Password/)).toBeFocused()
  await page.keyboard.type(DEMO_PASSWORD)
  // The password is hidden until asked for, by a toggle that announces its state.
  const toggle = page.getByRole('button', { name: 'Show password' })
  await expect(page.getByLabel(/^Password/)).toHaveAttribute('type', 'password')
  await page.keyboard.press('Tab')
  await expect(toggle).toBeFocused()
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel(/^Password/)).toHaveAttribute('type', 'text')
  await page.keyboard.press('Space')
  await expect(page.getByLabel(/^Password/)).toHaveAttribute('type', 'password')
  // Enter in a field submits.
  await page.getByLabel(/^Password/).press('Enter')
  await expect(page).toHaveURL(at('/doctor'))
})

test('the patient page offers activation for a first visit, and a withdrawn portal is explained on the patient sign-in', async ({ page }) => {
  await page.goto('/login/patient')
  await page.getByRole('link', { name: 'Activate your account' }).click()
  await expect(page).toHaveURL(at('/activate'))
  await expect(page.getByText('Patient App', { exact: true })).toBeVisible()
  await expectNoAxeViolations(page)
  await page.goto('/login/patient?notice=portal_withdrawn')
  await expect(page.getByText('Online access switched off')).toBeVisible()
  await page.goto('/login/doctor?notice=portal_withdrawn')
  await expect(page.getByText('Online access switched off')).toHaveCount(0)
})

test('a doctor and a nurse each find the other’s workspace closed, with a plain page that says whose it is', async ({ page }) => {
  await signIn(page, 'dr.meera')
  await page.goto('/nurse')
  await expect(page).toHaveURL(at('/nurse'))
  await expect(page.getByRole('heading', { level: 1, name: 'This page is for nurses' })).toBeVisible()
  await expect(page.getByTestId('no-access')).toContainText('Dr. Meera Iyer (synthetic) (Doctor)')
  await expect(page.getByTestId('signed-in-user')).toHaveCount(0)
  await page.getByRole('link', { name: 'Go to my workspace' }).click()
  await expect(page).toHaveURL(at('/doctor'))
  await signOut(page)
  await signIn(page, 'nurse.anil')
  await page.goto('/doctor')
  await expect(page.getByRole('heading', { level: 1, name: 'This page is for doctors' })).toBeVisible()
  await expect(page.getByTestId('signed-in-user')).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(at('/login'))
})

test('what one tab does to the session is seen by the others: another tab’s sign-out, or a different person signing in, leaves nothing of the first person on screen', async ({ browser, baseURL, isMobile }) => {
  const doctor = await ownDoctor(baseURL!)
  const { ctx, page: a } = await plainContext(browser, baseURL!, isMobile)
  const b = await ctx.newPage()
  // The tab is looked at again: the browser says the page is visible, or the window gets focus (switching between two visible windows
  // fires only that); either way the session is checked once more.
  const lookAgain = (type: 'visibilitychange' | 'focus') => a.evaluate((t) => window.dispatchEvent(new Event(t)), type)

  await signIn(a, doctor.username, doctor.password, { app: 'doctor' })
  await expect(a.getByTestId('signed-in-user')).toContainText('Entry Test')
  // Another tab signs out (the cookie is shared): this tab is told when it is looked at again, and shows nothing of the person.
  await b.goto('/doctor')
  await signOut(b)
  await lookAgain('focus')
  await expect(a).toHaveURL(/\/login\/doctor\?.*reason=session_ended/)
  await expect(a.getByText('Your session ended')).toBeVisible()
  await expect(a.locator('body')).not.toContainText('Entry Test')

  // Another person signs in, in the other tab: this tab becomes that person's, and shows none of the first person's data.
  await signIn(a, doctor.username, doctor.password, { app: 'doctor' })
  await expect(a.getByTestId('signed-in-user')).toContainText('Entry Test')
  await b.goto('/doctor')
  await signOut(b)
  await signIn(b, 'admin')
  await expect(b).toHaveURL(at('/admin'))
  await lookAgain('visibilitychange')
  await expect(a.getByRole('heading', { level: 1, name: /^This account cannot access the Doctor App$/ })).toBeVisible()
  await expect(a.getByTestId('no-access')).toContainText('Asha Admin')
  await expect(a.locator('body')).not.toContainText('Entry Test')
  await expect(a.getByTestId('signed-in-user')).toHaveCount(0)
  await b.getByRole('button', { name: 'Sign out' }).click()
  await expect(b).toHaveURL(at('/login'))
  await ctx.close()
})

test('if signing out does not reach the server the person is told and stays signed in, and nothing pretends the session ended', async ({ browser, baseURL, isMobile }) => {
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  await signIn(page, 'admin')
  await expect(page).toHaveURL(at('/admin'))
  const logout = /\/api\/auth\/logout$/
  for (const failure of [(r: import('@playwright/test').Route) => r.abort('connectionrefused'), (r: import('@playwright/test').Route) => r.fulfill({ status: 502, body: '' })]) {
    await page.route(logout, failure)
    await page.getByRole('button', { name: 'Sign out' }).click()
    const told = page.getByRole('alert').filter({ hasText: 'you are still signed in' })
    await expect(told).toBeVisible()
    await expect(page).toHaveURL(at('/admin'))
    expect(await me(page.request), 'the session is still there').toBe(200)
    await page.unroute(logout)
    await page.getByRole('button', { name: 'Dismiss notification' }).click()
    await expect(told).toHaveCount(0)
  }
  // The same on every other page that signs out: the notice at another application's sign-in, the no-access page, the password page.
  for (const [path, button] of [
    ['/login/doctor', page.getByTestId('signed-in-notice').getByRole('button', { name: 'Sign out' })],
    ['/doctor', page.getByTestId('no-access').getByRole('button', { name: 'Sign out' })],
    ['/change-password', page.getByRole('button', { name: 'Sign out' })],
  ] as const) {
    await page.goto(path)
    await page.route(logout, (r) => r.abort('connectionrefused'))
    await button.click()
    await expect(page.getByRole('alert').filter({ hasText: 'you are still signed in' }), path).toBeVisible()
    await expect(page).toHaveURL(at(path))
    expect(await me(page.request), `${path}: the session is still there`).toBe(200)
    await page.unroute(logout)
  }
  await page.goto('/admin')
  await signOut(page)
  expect(await me(page.request)).toBe(401)
  await ctx.close()
})

test('if a sign-in were ever answered with a session of the wrong role, that session is ended at once and nothing of it is shown', async ({ browser, baseURL, isMobile }) => {
  const adminApi = await staff(baseURL!, 'admin')
  const adminMe = await (await adminApi.get('/api/auth/me')).json()
  await adminApi.dispose()
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  const logouts: string[] = []
  page.on('request', (r) => r.url().endsWith('/api/auth/logout') && logouts.push(r.method()))
  await page.route(/\/api\/auth\/login$/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(adminMe) }))
  await page.goto('/login/doctor')
  await page.getByLabel('Doctor username').fill('dr.meera')
  await page.getByLabel(/^Password/).fill(DEMO_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('cannot use the Doctor App')
  await expect(page).toHaveURL(at('/login/doctor'))
  expect(logouts).toEqual(['POST'])
  await expect(page.getByTestId('signed-in-notice')).toHaveCount(0)
  await expect(page.getByTestId('signed-in-user')).toHaveCount(0)
  await ctx.close()
})

test('every notice and sign-in problem fits a laptop and a phone screen and passes the accessibility checks', async ({ browser, baseURL, isMobile }) => {
  test.skip(isMobile, 'sets its own screen sizes')
  const ctx = await browser.newContext({ baseURL: baseURL!, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const loginUrl = /\/api\/auth\/login$/
  const json = (status: number, error: string, message: string) => (r: import('@playwright/test').Route) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error, message }) })
  const problems = [
    { name: 'invalid', route: json(401, 'invalid_credentials', 'Invalid username or password'), text: 'Invalid username or password' },
    { name: 'locked', route: json(423, 'account_locked', 'Too many failed sign-in attempts. Try again in 15 minutes or ask an administrator.'), text: 'temporarily locked' },
    { name: 'rate limited', route: json(429, 'rate_limited', 'Too many attempts. Try again in 36 seconds.'), text: 'Too many attempts' },
    { name: 'wrong door', route: json(403, 'wrong_application', 'This account cannot sign in to the Doctor App.'), text: 'cannot use the Doctor App' },
    { name: 'unavailable', route: (r: import('@playwright/test').Route) => r.fulfill({ status: 502, body: '' }), text: 'temporarily unavailable' },
    { name: 'lost connection', route: (r: import('@playwright/test').Route) => r.abort('connectionrefused'), text: 'Cannot reach the sign-in service' },
    { name: 'server error', route: json(500, 'internal_error', 'Something went wrong'), text: 'Something went wrong on our side' },
  ]
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height })
    for (const notice of ['/login/doctor?reason=session_ended', '/login/patient?notice=portal_withdrawn']) {
      await page.goto(notice)
      await expect(page.getByRole('status').filter({ hasText: /Your session ended|Online access switched off/ })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await expectNoAxeViolations(page)
    }
    await page.goto('/login/doctor')
    for (const problem of problems) {
      await page.route(loginUrl, problem.route)
      await page.getByLabel('Doctor username').fill('dr.meera')
      await page.getByLabel(/^Password/).fill('not-sent-anywhere-1')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('alert').filter({ hasText: problem.text }), `${width}: ${problem.name}`).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await expectNoAxeViolations(page)
      await page.unroute(loginUrl)
    }
  }
  // Signed in, at another application's pages.
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height })
    await signIn(page, 'dr.meera')
    await page.goto('/login/admin')
    await expect(page.getByTestId('signed-in-notice')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expectNoAxeViolations(page)
    await page.goto('/admin')
    await expect(page.getByTestId('no-access')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expectNoAxeViolations(page)
    await page.getByTestId('no-access').getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(at('/login'))
  }
  await ctx.close()
})

test('a different person of the same role signing in from another tab takes over the page: nothing shown or typed by the first person remains', async ({ browser, baseURL, isMobile }) => {
  const x = await ownDoctor(baseURL!, 'Entry Xavier (synthetic)')
  const y = await ownDoctor(baseURL!, 'Entry Yolanda (synthetic)')
  const { ctx, page: a } = await plainContext(browser, baseURL!, isMobile)
  const b = await ctx.newPage()
  await signIn(a, x.username, x.password, { app: 'doctor' })
  await expect(a.getByTestId('signed-in-user')).toContainText('Xavier')
  // The first person has typed something into the page (not sent).
  const search = a.getByLabel('Search patients by name, MRN or phone number')
  await search.fill('typed by xavier')

  await b.goto('/doctor')
  await signOut(b)
  await signIn(b, y.username, y.password, { app: 'doctor' })
  await a.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(a.getByTestId('signed-in-user')).toContainText('Yolanda')
  await expect(a.locator('body')).not.toContainText('Xavier')
  await expect(search).toHaveValue('')
  await b.getByRole('button', { name: 'Sign out' }).click()
  await expect(b).toHaveURL(at('/login'))
  await ctx.close()
})

test('when the session cannot be re-checked because the service is down, the person already shown keeps their page; a real refusal still ends it', async ({ browser, baseURL, isMobile }) => {
  const doctor = await ownDoctor(baseURL!)
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  await signIn(page, doctor.username, doctor.password, { app: 'doctor' })
  await expect(page.getByTestId('signed-in-user')).toContainText('Entry Test')
  const meUrl = /\/api\/auth\/me$/
  const lookAgain = () => page.evaluate(() => window.dispatchEvent(new Event('focus')))

  // The check is refused by the network, then answered by a gateway with nothing: the page stays, as it was, with no error taking it over.
  await page.route(meUrl, (r) => r.abort('connectionrefused'))
  const failed = page.waitForEvent('requestfailed', (r) => meUrl.test(r.url()))
  await lookAgain()
  await failed
  await page.unroute(meUrl)
  await page.route(meUrl, (r) => r.fulfill({ status: 502, body: '' }))
  const gateway = page.waitForResponse(meUrl)
  await lookAgain()
  expect((await gateway).status()).toBe(502)
  await expect(page).toHaveURL(at('/doctor'))
  await expect(page.getByTestId('signed-in-user')).toContainText('Entry Test')
  // Let the page render whatever the failed check might have made it show, then look for it (a "not shown" check passes on the first look otherwise).
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  await expect(page.locator('body')).not.toContainText('Cannot reach the service')
  await page.unroute(meUrl)

  // The service answers, and says there is no session: that is a refusal, and it ends the page.
  expect(await expireSessionsOf(doctor.username)).toBeGreaterThan(0)
  await lookAgain()
  await expect(page).toHaveURL(/\/login\/doctor\?.*reason=session_ended/)
  await expect(page.locator('body')).not.toContainText('Entry Test')
  await ctx.close()
})

test('edits still waiting to be saved are not sent as a different person who signed in from another tab', async ({ browser, baseURL, isMobile }) => {
  const x = await ownDoctor(baseURL!, 'Entry Xavier (synthetic)')
  const y = await ownDoctor(baseURL!, 'Entry Yolanda (synthetic)')
  const p = await nurseHandsOverPatient(baseURL!)
  const { ctx, page: a } = await plainContext(browser, baseURL!, isMobile)
  // The page's autosave timers (1.2 s after an edit, 5 s after a failed save) never fire in this tab, so the first person's edit is still unsent when the
  // other person signs in: exactly the edit that closing the page would otherwise flush.
  await a.addInitScript(() => {
    const real = window.setTimeout.bind(window)
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => (ms === 1200 || ms === 5000 ? 0 : real(fn, ms, ...args))) as typeof window.setTimeout
  })
  const b = await ctx.newPage()
  await signIn(a, x.username, x.password, { app: 'doctor' })
  await a.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(a).toHaveURL(/\/doctor\/encounters\//)
  const drafts: string[] = []
  await a.route(/\/api\/encounters\/[^/]+\/draft$/, (r) => {
    drafts.push(r.request().method())
    return r.abort('connectionrefused')
  })
  // Doctor HERO final (DESIGN §5.4): the typed note is the Keyboard tab of Doctor notes (the pen is the default tab).
  await a.getByTestId('doctor-notes').getByRole('tab', { name: 'Structured' }).click()
  await a.getByLabel('Assessment').fill('Written by Xavier, not yet saved')

  await b.goto('/doctor')
  await signOut(b)
  await signIn(b, y.username, y.password, { app: 'doctor' })
  await a.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(a.getByTestId('signed-in-user')).toContainText('Yolanda')
  await a.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  expect(drafts, 'nothing of the first person was sent under the second').toEqual([])
  await ctx.close()
})
