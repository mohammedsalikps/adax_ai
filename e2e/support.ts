import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, request as pwRequest } from '@playwright/test'

const envFile = path.resolve(import.meta.dirname, '..', '.env')
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)

/** Password of the seeded synthetic demo users (generated into .env by `npm run setup`). */
export const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? ''
if (!DEMO_PASSWORD) throw new Error('SEED_DEMO_PASSWORD missing from .env; run `npm run setup`')

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help} — ${v.nodes[0]?.target.join(' ')}`)
  expect(summary, 'axe WCAG 2.2 AA violations').toEqual([])
}

/**
 * The page must fit the device width. On phones, Chrome silently widens the
 * layout viewport when anything overflows, which breaks taps; this catches it.
 */
export async function expectNoHorizontalOverflow(page: Page) {
  const viewport = page.viewportSize()!
  // On failure, name the outermost elements that stick out (elements inside a
  // horizontally scrolling container, such as wide tables, are not counted).
  const offenders = () =>
    page.evaluate(() => {
      const W = document.documentElement.clientWidth
      const scrolls = (el: Element | null): boolean => !!el && (['auto', 'scroll'].includes(getComputedStyle(el).overflowX) || scrolls(el.parentElement))
      return [...document.querySelectorAll('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          const parent = el.parentElement?.getBoundingClientRect()
          return r.width > 0 && r.right > W + 0.5 && (!parent || parent.right <= W + 0.5) && !scrolls(el.parentElement)
        })
        .slice(0, 5)
        .map((el) => `<${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 100)}"> right=${Math.round(el.getBoundingClientRect().right)}: ${(el.textContent ?? '').trim().slice(0, 80)}`)
    })
  await expect
    .poll(async () => {
      const width = await page.evaluate(() => document.documentElement.scrollWidth)
      return width <= viewport.width ? 'fits' : `page ${width}px wider than the ${viewport.width}px screen; overflowing: ${(await offenders()).join(' | ') || 'none found'}`
    })
    .toBe('fits')
  expect(await page.evaluate(() => innerWidth)).toBe(viewport.width)
}

export type EntryApp = 'doctor' | 'patient' | 'admin'

/** The application a demo account signs in to: administrators have their own, patients sign in by MRN, all clinical staff use the Doctor App. */
export const appFor = (username: string): EntryApp => (/^admin/i.test(username) ? 'admin' : /^ADX-/i.test(username) ? 'patient' : 'doctor')

/** Signs in through the UI, at the sign-in page of the account's application, and waits until the app has left it (unless failure is expected). */
export async function signIn(page: Page, username: string, password = DEMO_PASSWORD, opts: { expectFailure?: boolean; app?: EntryApp } = {}) {
  await page.goto(`/login/${opts.app ?? appFor(username)}`)
  await page.getByLabel(/^(Doctor username|Admin username|MRN)/).fill(username)
  await page.getByLabel(/^Password/).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  if (!opts.expectFailure) await page.waitForURL((u) => !u.pathname.startsWith('/login'))
}

export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
}

/**
 * The stand-in for the local model (e2e/mock-llm.mjs) is one process with one mode and one call log. Spec files that flip its mode or read its calls take
 * turns: each holds a lock (a directory, made atomically) from its first test to its last, so that workers running other files at the same time never see
 * its mode. A lock left by a worker that died is taken over after twenty minutes.
 */
export function llmExclusive(test: { beforeAll: (fn: () => Promise<void>) => void; afterAll: (fn: () => Promise<void>) => void; setTimeout: (ms: number) => void }) {
  const dir = path.join(os.tmpdir(), 'adaxai-e2e-llm.lock')
  const me = `${process.pid}-${Date.now()}`
  test.beforeAll(async () => {
    test.setTimeout(1_500_000)
    for (;;) {
      try {
        fs.mkdirSync(dir)
        fs.writeFileSync(path.join(dir, 'owner'), me)
        return
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        try {
          if (Date.now() - fs.statSync(dir).mtimeMs > 20 * 60_000) fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // The holder released it just now.
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  })
  test.afterAll(async () => {
    try {
      if (fs.readFileSync(path.join(dir, 'owner'), 'utf8') === me) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Already gone.
    }
  })
}

/*
 * The doctor's consultation workspace (Doctor HERO final, DESIGN §5.4-5.6). The five-module rail, the workflow strip, the "More tools" dialog
 * and "Analyze with Mana" are gone: every panel is always shown in the workspace grid (live transcription, clinical inputs with the
 * stethoscope, patient history; then the doctor notes and the thermal context), the bottom bar's one primary action is "Generate prescription"
 * (data-testid analyze-mana kept), the diagnosis, the medicines and signing are on the prescription page, and Mana is the global sheet.
 */

/**
 * The workspace's input panels by the names the tests have always used, as the element each one is (apps/web/src/lib/workspace.ts
 * WORKSPACE_PANELS and PART_SELECTORS): the stethoscope is a group inside the clinical inputs, without an element id of its own.
 */
const MODULE_PARTS = {
  Conversation: '#tools-conversation',
  History: '#tools-history',
  Vitals: '#tools-devices',
  Stethoscope: '[data-testid="stethoscope-panel"]',
  Thermal: '#tools-thermal',
} as const
export type ModuleName = keyof typeof MODULE_PARTS

/** The input panel itself (always shown in the workspace). */
export const inputModule = (page: Page, name: ModuleName) => page.locator(MODULE_PARTS[name])

/**
 * Brings an input panel into view and waits until it is shown; returns it. Panels no longer open or close. For "Vitals" the clinical inputs'
 * "Device details" (the device card: readings, attach, end) is opened too, because that card was part of the old module's full panel.
 */
export async function openModule(page: Page, name: ModuleName) {
  const panel = page.locator(MODULE_PARTS[name])
  await panel.scrollIntoViewIfNeeded()
  await expect(panel).toBeVisible()
  if (name === 'Vitals') {
    const toggle = panel.getByTestId('device-details-toggle')
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByTestId('device-details')).toBeVisible()
  }
  return panel
}

export type WorkflowStepLabel = 'Inputs' | 'Mana analysis' | 'Your review' | 'Note & prescription' | 'Sign'

/**
 * Where a step of the old workflow strip now is: "Inputs" is the workspace's first input panel (the live transcription); the analysis, the
 * review, the note's prescription and signing are on the prescription page, reached through Generate prescription (openPrescription).
 */
export async function stepTo(page: Page, label: WorkflowStepLabel) {
  if (label === 'Inputs') {
    await openModule(page, 'Conversation')
    return
  }
  await openPrescription(page)
}

/**
 * Opens the "Clinical photographs" sheet (the clinical photographs and the older AI consultation assistant; it replaced the "More tools"
 * dialog) from the header's ⋯ menu, and returns it.
 */
export async function openMoreTools(page: Page) {
  await page.getByRole('button', { name: 'More consultation actions' }).click()
  await page.getByRole('menuitem', { name: 'Clinical photographs' }).click()
  const sheet = page.getByRole('dialog', { name: 'Clinical photographs' })
  await expect(sheet).toBeVisible()
  return sheet
}

/**
 * The workspace's one primary action, in its bottom bar: "Generate prescription" (it replaced "Analyze with Mana" / "Analyze again"; the
 * data-testid analyze-mana is kept). Its words never change while it runs or after a draft exists (its data-state does), so the old second
 * argument ("Analyze again") names the same one button; it is accepted only so older calls still compile.
 */
export const analyzeButton = (page: Page, _formerLabel?: 'Analyze with Mana' | 'Analyze again') =>
  page.getByTestId('consultation-actions').getByRole('button', { name: 'Analyze & Generate Prescription', exact: true })

/**
 * Generate prescription from the workspace: the click opens "Preparing the consultation" (the checklist of real steps), which is returned. The
 * prescription page then opens by itself when Mana's summary is ready, partly ready or cannot be asked.
 */
export async function generatePrescription(page: Page) {
  const button = analyzeButton(page)
  await expect(button).toHaveAttribute('data-testid', 'analyze-mana')
  await button.click()
  const preparing = page.getByTestId('preparing-consultation')
  await expect(preparing).toBeVisible()
  return preparing
}

/**
 * From the workspace to the prescription page as the doctor goes: Generate prescription, then [Open prescription] in "Preparing the
 * consultation" (always offered) unless the page has already opened by itself. Waits until the prescription page is shown, and returns it.
 * (Use generatePrescription to check the sheet itself.)
 */
export async function openPrescription(page: Page) {
  const button = analyzeButton(page)
  await expect(button).toHaveAttribute('data-testid', 'analyze-mana')
  // Not waited for: when the model cannot be asked, the page opens at once and the sheet may never be seen.
  await button.click()
  const rx = page.getByTestId('prescription-page')
  const open = page.getByTestId('preparing-consultation').getByTestId('open-prescription')
  // The page may open by itself at any moment (a ready or unavailable model), so the button is clicked only while it is still there.
  await expect(async () => {
    if (!(await rx.isVisible()) && (await open.isVisible())) await open.click()
    await expect(rx).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}\/prescription$/)
  return rx
}

/**
 * Signs on the prescription page: [Sign & print] → "Review and sign" (the attestation) → [Sign]. The printout opens in a new tab as the
 * signature is answered; it is returned (still open) once the page shows "Prescription signed". Signing does NOT complete the consultation.
 */
export async function signPrescription(page: Page) {
  await page.getByTestId('sign-and-print').click()
  const review = page.getByRole('dialog', { name: 'Review and sign' })
  await expect(review).toBeVisible()
  await review.getByLabel(/I have reviewed this record/).check()
  const [printPage] = await Promise.all([page.context().waitForEvent('page', { timeout: 30_000 }), review.getByRole('button', { name: 'Sign', exact: true }).click()])
  await printPage.waitForLoadState()
  await expect(page.getByTestId('prescription-signed')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('prescription-signed')).toHaveText(/Prescription signed/)
  return printPage
}

/**
 * Completes a signed consultation (its prescription page, or its signed record): [Complete consultation] → "Complete this consultation?" →
 * [Complete]; the doctor is back on My consultations.
 */
export async function completeConsultation(page: Page) {
  await page.getByTestId('complete-consultation').click()
  const confirm = page.getByRole('dialog', { name: 'Complete this consultation?' })
  await confirm.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(page).toHaveURL(/\/doctor\/queue$/, { timeout: 20_000 })
  await expect(page.getByText(/^Consultation completed/).first()).toBeVisible()
}

/** Signs and then completes, from the prescription page (the old "Sign and complete" is now these two acts); the printout tab is closed. */
export async function signAndComplete(page: Page) {
  const printPage = await signPrescription(page)
  await printPage.close()
  await completeConsultation(page)
}

/** Opens the global Mana (the floating button on every doctor page) and returns its sheet; nothing is asked of Mana before it opens. */
export async function openMana(page: Page) {
  await page.getByTestId('mana-launcher').click()
  const sheet = page.getByTestId('mana-sheet')
  await expect(sheet.getByTestId('mana-assistant')).toBeVisible()
  return sheet
}

/** A unique suffix so tests can run repeatedly against the same dev database. */
export const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/** Nurse side via the API (its UI is covered by nurse-workflow.spec): register, check in, vitals, ready. */
export async function nurseHandsOverPatient(baseURL: string, opts: { allergies?: string[]; consents?: string[]; name?: { given: string; family: string } } = {}) {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username: 'nurse.anil', password: DEMO_PASSWORD } })).ok()).toBe(true)
  const given = opts.name?.given ?? `Meena${uniq()}`
  const family = opts.name?.family ?? 'Synthetic'
  const patient = await (await api.post('/api/patients', { data: { givenName: given, familyName: family, dateOfBirth: '1984-02-11', sex: 'female', phone: `7${String(Date.now()).slice(-9)}` } })).json()
  for (const substance of opts.allergies ?? []) await api.post(`/api/patients/${patient.id}/allergies`, { data: { substance, severity: 'moderate' } })
  for (const type of opts.consents ?? []) await api.post(`/api/patients/${patient.id}/consents`, { data: { type, method: 'verbal' } })
  const depts = (await (await api.get('/api/departments')).json()).departments
  const visit = await (await api.post('/api/visits', { data: { patientId: patient.id, departmentId: depts.find((d: { code: string }) => d.code === 'GEN').id, chiefComplaint: 'Sore throat and fever' } })).json()
  await api.post(`/api/visits/${visit.id}/observations`, { data: { items: [{ kind: 'temperature', value: 38.2 }, { kind: 'heart_rate', value: 92 }] } })
  await api.post(`/api/visits/${visit.id}/status`, { data: { status: 'ready' } })
  await api.dispose()
  return { name: `${given} ${family}`, given, patientId: patient.id as string, mrn: patient.mrn as string }
}

