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
 * The doctor's consultation (Doctor HERO): the five numbered input modules of the rail, the workflow strip under the header, the "More tools"
 * sheet and the one Analyze control. A module's full panel is always mounted but hidden while the module is closed (the default for a new
 * browser), so a test opens the module before it uses the panel, as the doctor does.
 */

/** The five input modules by the names the tests use, as the element id of each (apps/web/src/lib/workspace.ts MODULES). */
const MODULE_PARTS = { Conversation: 'tools-conversation', History: 'tools-history', Vitals: 'tools-devices', Stethoscope: 'tools-stethoscope', Thermal: 'tools-thermal' } as const
export type ModuleName = keyof typeof MODULE_PARTS

/** The module itself: a group named by its heading, with its compact summary always shown. */
export const inputModule = (page: Page, name: ModuleName) => page.locator(`#${MODULE_PARTS[name]}`)

/**
 * Opens a module with its own "Show" button (named "Show <title>", aria-controls its body) unless it is open already, and waits until its
 * full panel is shown. Opened by that button, it is remembered for the doctor on this browser and stays open after a reload; a module that a
 * jump opened (a chip, the overview) is left as it is, and is not remembered.
 */
export async function openModule(page: Page, name: ModuleName) {
  const part = MODULE_PARTS[name]
  const group = page.locator(`#${part}`)
  const toggle = group.locator(`button[aria-controls="${part}-body"]`)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle).toHaveAccessibleName(/^Hide /)
  await expect(group).toHaveAttribute('data-open', 'true')
  await expect(page.locator(`#${part}-body`)).toBeVisible()
  return group
}

export type WorkflowStepLabel = 'Inputs' | 'Mana analysis' | 'Your review' | 'Note & prescription' | 'Sign'

/** Uses a step of the workflow strip under the header (a button named "<label>: <its state>"), which leads to that step's part of the page. */
export async function stepTo(page: Page, label: WorkflowStepLabel) {
  const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `)
  await page.getByRole('navigation', { name: 'Consultation steps' }).getByRole('button', { name }).click()
}

/** Opens the "More tools" sheet (the clinical photographs and the older AI assistant) from the header's menu, and returns it. */
export async function openMoreTools(page: Page) {
  await page.getByRole('button', { name: 'More consultation actions' }).click()
  await page.getByRole('menuitem', { name: 'More tools…' }).click()
  const sheet = page.getByRole('dialog', { name: 'More tools' })
  await expect(sheet).toBeVisible()
  return sheet
}

/** The one control that asks for an analysis, at the foot of the inputs rail: "Analyze with Mana" before any draft, "Analyze again" after one. */
export const analyzeButton = (page: Page, name: 'Analyze with Mana' | 'Analyze again' = 'Analyze with Mana') => page.getByRole('button', { name, exact: true })

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

