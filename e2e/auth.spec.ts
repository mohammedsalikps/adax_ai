import { expect, test } from '@playwright/test'
import { expectNoAxeViolations, expectNoHorizontalOverflow, signIn, signOut, uniq } from './support.ts'

test('admin screens fit the screen and pass axe', async ({ page }) => {
  await signIn(page, 'admin')
  await expect(page).toHaveURL(/\/admin$/)
  for (const [path, heading] of [
    ['/admin/users', 'Users'],
    ['/admin/departments', 'Departments'],
    ['/admin/audit', 'Audit log'],
  ] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await expect(page.getByRole('table')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expectNoAxeViolations(page)
  }
})

test('anonymous visitors are sent to sign-in; the page is accessible', async ({ page }) => {
  await page.goto('/admin/users')
  // Each application's pages send a signed-out visitor to that application's own sign-in.
  await expect(page).toHaveURL(/\/login\/admin\?next=%2Fadmin%2Fusers$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Admin Portal' })).toBeVisible()
  await expectNoAxeViolations(page)
})

test('a wrong password shows an error and does not sign in', async ({ page }) => {
  await signIn(page, 'nurse.anil', 'definitely-not-the-password', { expectFailure: true })
  await expect(page.getByRole('alert')).toContainText('Invalid username or password')
  await expect(page).toHaveURL(/\/login/)
})

test('admin sees the overview with live service status', async ({ page }) => {
  await signIn(page, 'admin')
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Operational overview' })).toBeVisible()
  await expect(page.getByTestId('status-database')).toContainText('Operational')
  await expect(page.getByTestId('status-database')).toContainText('UTF8')
  await expect(page.getByTestId('status-thermal')).toContainText('Operational')
  await expectNoAxeViolations(page)
})

test('admin creates a doctor, who must replace the temporary password before using the portal', async ({ page }) => {
  const username = `dr.e2e.${uniq()}`
  await signIn(page, 'admin')
  await expect(page).toHaveURL(/\/admin$/)
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Add user' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add staff user' })
  await dialog.getByLabel('Full name').fill('Dr. E2E Test (synthetic)')
  await dialog.getByLabel('Username').fill(username)
  await dialog.getByLabel('Role').selectOption('doctor')
  await dialog.getByLabel('Department').selectOption({ label: 'General Medicine' })
  const tempPassword = await dialog.getByLabel('Temporary password').inputValue()
  await expectNoAxeViolations(page)
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(page.getByRole('row', { name: new RegExp(username) })).toContainText('Temporary password')
  await signOut(page)

  await signIn(page, username, tempPassword)
  await expect(page).toHaveURL(/\/change-password$/)
  await page.getByLabel('Current password').fill(tempPassword)
  await page.getByLabel('New password').fill('A-new-e2e-passphrase-1')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page).toHaveURL(/\/doctor$/)
  // Jury polish: the top bar shows the plain name; the data's "(synthetic)" mark is said once, subtly, in the sidebar.
  await expect(page.getByTestId('signed-in-user')).toHaveText('Dr. E2E Test')
})

test('a doctor cannot reach admin screens, and the API refuses admin data', async ({ page }) => {
  await signIn(page, 'dr.meera')
  await expect(page).toHaveURL(/\/doctor$/)
  // The page says plainly that this account has no access (it does not silently move them), and the API refuses the data regardless.
  await page.goto('/admin/users')
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.getByRole('heading', { level: 1, name: 'This account cannot access the Admin App' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Go to my workspace' })).toHaveAttribute('href', '/doctor')
  await expect(page.getByRole('table')).toHaveCount(0)
  const res = await page.request.get('/api/admin/users')
  expect(res.status()).toBe(403)
})

test('signing out ends the session server-side', async ({ page }) => {
  await signIn(page, 'nurse.anil')
  await expect(page).toHaveURL(/\/nurse$/)
  await signOut(page)
  expect((await page.request.get('/api/auth/me')).status()).toBe(401)
})

test('the skip link moves focus to the main content', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is checked on desktop')
  await signIn(page, 'admin')
  await expect(page.getByRole('heading', { level: 1, name: 'Operational overview' })).toBeVisible()
  // Start from the top of the document, as a keyboard user arriving on the page would.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main#main')).toBeFocused()
})
