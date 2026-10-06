import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect, type Locator, type Page, request as pwRequest, test } from '@playwright/test'
import { analyzeButton, DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, llmExclusive, nurseHandsOverPatient, openModule, signIn, stepTo, uniq } from './support.ts'

/*
 * The Doctor HERO jury journey, end to end: sign-in, the dashboard, today's patients, the consultation started from the row; the five inputs one
 * by one (the conversation transcribed, the patient's history, a health band and a simulator band, the stethoscope, a SIMULATED thermal capture
 * and an imported public FLIR sample); the pediatric shock research view; "Analyze with Mana"; the AI summary; the medication considerations
 * beside the prescription; the doctor's review (accept, edit, reject) and what is added to the note; the diagnosis and the prescription the
 * doctor writes; the print preview; review and sign; and the audit trail. At each step the workflow strip under the header says where the
 * consultation is. Then the page at seven screen sizes: no sideways scrolling, the WCAG 2.2 AA checks, and the panes where they belong.
 *
 * Everything is real (browser, API, database, thermal service) except the stand-ins this suite always uses: the local model (e2e/mock-llm.mjs),
 * the speech service (e2e/mock-speech.mjs), Chromium's synthetic microphone and audio input, a "band under test" whose gateway is this test
 * posting fixed numbers with the device's token, a SIMULATOR band, and the thermal simulator. None of them is a model, a recogniser or a device,
 * and a time measured here is the stand-ins' time, not the product's.
 */

const SAMPLES = path.resolve(import.meta.dirname, '..', 'samples', 'thermal')
const APP_ORIGIN = 'http://127.0.0.1:5273'
const LLM = 'http://127.0.0.1:8181'

async function llm(mode: 'ok') {
  const r = await pwRequest.newContext()
  try {
    await r.post(`${LLM}/__mode`, { data: { mode } })
  } finally {
    await r.dispose()
  }
}

async function staff(baseURL: string, username: string): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username, password: DEMO_PASSWORD } })).ok()).toBe(true)
  return api
}

/** An administrator registers a device record and issues its gateway token; this test then posts with the token as a gateway would. */
async function register(admin: APIRequestContext, baseURL: string, integration: 'gateway_api' | 'simulator', label: string) {
  const d = await (await admin.post('/api/admin/devices', { data: { kind: 'wearable_band', label, serialNumber: `E2E-${uniq()}`, integration } })).json()
  const { token } = await (await admin.post(`/api/admin/devices/${d.id}/token`)).json()
  const gateway = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}`, 'x-adaxai-csrf': '1' } })
  return {
    label,
    send: (readings: { kind: string; value: number }[]) => gateway.post('/api/device-ingest/readings', { data: { measuredAt: new Date().toISOString(), readings } }),
    dispose: () => gateway.dispose(),
  }
}

/** Keeps a gateway sending every `ms` until stopped. Every loop started is also stopped after the test, whatever happened. */
const loops: (() => Promise<void>)[] = []
function every(ms: number, fn: () => Promise<unknown>) {
  let on = true
  const done = (async () => {
    while (on) {
      await fn().catch(() => undefined)
      await new Promise((r) => setTimeout(r, ms))
    }
  })()
  const stop = async () => {
    on = false
    await done
  }
  loops.push(stop)
  return stop
}

type StepId = 'inputs' | 'analysis' | 'review' | 'record' | 'sign'
/** The workflow strip's steps, each a button named "<label>: <state>" in an item that carries the state as data. */
const stripStep = (page: Page, id: StepId) => page.getByRole('navigation', { name: 'Consultation steps' }).locator(`li[data-step="${id}"]`)
async function expectStrip(page: Page, want: Partial<Record<StepId, [name: string | RegExp, state: string]>>) {
  for (const [id, [name, state]] of Object.entries(want) as [StepId, [string | RegExp, string]][]) {
    await expect(stripStep(page, id).getByRole('button')).toHaveAccessibleName(name, { timeout: 25_000 })
    await expect(stripStep(page, id)).toHaveAttribute('data-state', state)
  }
}
/** "Your review: n to review" as a number. */
async function toReview(page: Page): Promise<number> {
  const name = (await stripStep(page, 'review').getByRole('button').getAttribute('aria-label')) ?? ''
  const m = /^Your review: (\d+) to review$/.exec(name)
  expect(m, `the review step says how many wait: “${name}”`).not.toBeNull()
  return Number(m![1])
}

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1180, height: 820 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]

const box = async (l: Locator) => (await l.boundingBox())!
/**
 * Where the panes are: from 1024px the inputs rail on the left and, right of it, the Mana area and the record; the two side by side only where
 * the right-hand side is itself wide (a 1920px screen), Mana above the record otherwise; below 1024px one column, inputs, Mana, record.
 */
async function expectPanes(page: Page, size: { width: number; height: number }) {
  const label = `${size.width}x${size.height}`
  const rail = await box(page.getByTestId('consultation-tools'))
  const mana = await box(page.getByTestId('mana-result'))
  const note = await box(page.locator('#consultation-note'))
  if (size.width >= 1024) {
    expect(rail.x + rail.width, `${label}: the inputs rail is left of the Mana area`).toBeLessThanOrEqual(mana.x + 0.5)
    expect(rail.x + rail.width, `${label}: and left of the record`).toBeLessThanOrEqual(note.x + 0.5)
    if (size.width >= 1920) {
      expect(mana.x + mana.width, `${label}: Mana and the record side by side`).toBeLessThanOrEqual(note.x + 0.5)
      expect(note.y, `${label}: the record beside Mana, not under it`).toBeLessThan(mana.y + mana.height)
    } else {
      expect(mana.y + mana.height, `${label}: the record under the Mana area`).toBeLessThanOrEqual(note.y + 0.5)
      expect(Math.abs(note.x - mana.x), `${label}: Mana and the record in one column`).toBeLessThan(1)
    }
    // The strip is one row from 1024px.
    const rows = new Set((await page.getByTestId('workflow-strip').locator('li').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))).map(String))
    expect(rows.size, `${label}: the workflow strip in one row`).toBe(1)
  } else {
    expect(rail.y + rail.height, `${label}: one column, the inputs first`).toBeLessThanOrEqual(mana.y + 0.5)
    expect(mana.y + mana.height, `${label}: then Mana, then the record`).toBeLessThanOrEqual(note.y + 0.5)
  }
}

// One stand-in model server and a synthetic microphone, and sizes set here: the desktop project only, holding the model stand-in's lock.
test.skip(({ isMobile }) => isMobile, 'desktop project only (shared model stand-in, synthetic microphone; the phone size is set here)')
test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 })
llmExclusive(test)
test.beforeEach(async () => llm('ok'))

let openPatient: string | null = null
test.afterEach(async ({ baseURL }) => {
  for (const stop of loops.splice(0)) await stop()
  const id = openPatient
  openPatient = null
  if (!id) return
  const nurse = await staff(baseURL!, 'nurse.anil')
  const doctor = await staff(baseURL!, 'dr.meera')
  const visits = ((await (await nurse.get(`/api/patients/${id}/visits`)).json()).visits ?? []) as { id: string; status: string; encounterId: string | null }[]
  for (const v of visits.filter((x) => ['waiting', 'in_triage', 'ready', 'in_consultation'].includes(x.status))) {
    if (v.status === 'in_consultation' && v.encounterId) {
      const e = await (await doctor.get(`/api/encounters/${v.encounterId}`)).json()
      if (e.status === 'in_progress') await doctor.post(`/api/encounters/${e.id}/discard`, { data: { version: e.version, reason: 'Test clean-up (synthetic)' } })
    }
    await nurse.post(`/api/visits/${v.id}/status`, { data: { status: 'cancelled', reason: 'Test clean-up (synthetic)' } })
  }
  await nurse.dispose()
  await doctor.dispose()
})

type AuditRow = { action: string; outcome: string; actorRole: string | null; details: Record<string, unknown> }

test('the Doctor HERO jury journey: five inputs, the research view, Analyze with Mana, the summary, the medication considerations, review, the note, the prescription, print preview, signing and the audit trail, at seven sizes', async ({ page, baseURL }) => {
  test.skip(!fs.existsSync(path.join(SAMPLES, 'flir_example.jpg')), 'thermal sample images not fetched (npm run setup)')
  test.setTimeout(600_000)
  // What the page asks for: only this computer's application, and never Mana chat (nothing in this journey opens it; Analyze must not ask it).
  const outside: string[] = []
  const manaRequests: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith(APP_ORIGIN) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url())
    if (new URL(r.url()).pathname.startsWith('/api/mana-assistant')) manaRequests.push(`${r.method()} ${new URL(r.url()).pathname}`)
  })
  const tools = page.getByTestId('consultation-tools')

  // ---- 0. The nurse registered the patient (allergy: penicillin), recorded the consents and the vital signs, and handed over. The patient's
  // record already lists a current medicine (a doctor recorded it before, through the history API), so the record holds an allergy and a
  // medicine: what the stand-in model needs to write a medication consideration. ----
  const p = await nurseHandsOverPatient(baseURL!, { name: { given: `Jury${uniq()}`, family: 'Synthetic' }, allergies: ['Penicillin'], consents: ['ai_recording', 'device_monitoring', 'ai_record_assistant', 'thermal_imaging'] })
  openPatient = p.patientId
  const doctorApi = await staff(baseURL!, 'dr.meera')
  const med = await doctorApi.post(`/api/patients/${p.patientId}/medications`, { data: { drugName: 'Amlodipine', strength: '5 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Once daily', reason: 'Raised blood pressure' } })
  expect(med.status(), await med.text()).toBe(201)
  await doctorApi.dispose()

  // ---- 1. LOGIN, DASHBOARD, TODAY'S PATIENTS, START: on a 1366x768 laptop. ----
  await page.setViewportSize({ width: 1366, height: 768 })
  await signIn(page, 'dr.meera')
  await expect(page).toHaveURL(/\/doctor$/)
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Dr\. Meera$/ })).toBeVisible()
  const schedule = page.getByRole('region', { name: 'Today’s schedule' })
  await expect(schedule.getByRole('listitem').filter({ hasText: p.name })).toContainText('Ready for doctor')
  await schedule.getByRole('link', { name: 'View all' }).click()
  await expect(page).toHaveURL(/\/doctor\/queue$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Today’s patients' })).toBeVisible()
  await page.getByRole('list', { name: 'Visits' }).getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}$/)
  const encounterId = /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!

  // The workspace: the rail headed with the patient and the visit, the five numbered modules, Analyze at its foot; Mana and the record right.
  await expect(tools.getByRole('heading', { level: 2, name: 'Consultation inputs' })).toBeVisible()
  await expect(tools).toContainText(p.name)
  const modules = tools.locator('[role="group"][data-testid^="module-"]')
  expect(await modules.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))).toEqual(['module-conversation', 'module-history', 'module-vitals', 'module-stethoscope', 'module-thermal'])
  await expect(analyzeButton(page)).toBeInViewport()
  await expectPanes(page, { width: 1366, height: 768 })
  // Where the consultation is: the history (an allergy and a medicine) and the staff's vital signs hold information; nothing analysed yet.
  await expect(page.getByTestId('consult-panel').getByTestId('consult-status')).toContainText('NOT RUN', { timeout: 20_000 })
  await expectStrip(page, {
    inputs: ['Inputs: 2 of 5 with information', 'some'],
    analysis: ['Mana analysis: Not run', 'not_run'],
    review: ['Your review: not yet', 'not_yet'],
    record: ['Note & prescription: No medicines · saved', 'saved'],
    sign: ['Sign: Not signed', 'unsigned'],
  })
  // The strip's Inputs leads to the rail's heading, moving the rail, not the page.
  await stepTo(page, 'Inputs')
  await expect(page.locator('#consultation-inputs')).toBeFocused()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)

  // ---- 2. MODULE 1, CONVERSATION: recorded from the synthetic microphone; the stand-in's lines; the doctor confirms the allergy point. ----
  const conversation = await openModule(page, 'Conversation')
  const live = page.getByRole('region', { name: 'Live transcription' })
  await expect(live.getByTestId('recording-consent')).toContainText('recorded (ongoing)')
  await live.getByRole('button', { name: 'Start recording' }).click()
  await expect(live.getByTestId('recording-state')).toContainText(/00:0[3-9]/, { timeout: 15_000 })
  await live.getByRole('button', { name: 'Stop' }).click()
  await expect(live.getByRole('button', { name: 'Start recording' })).toBeVisible({ timeout: 20_000 })
  await expect(live.getByTestId('raw-transcript').getByTestId('transcript-line')).toHaveCount(5, { timeout: 20_000 })
  const points = page.getByRole('region', { name: 'Important points' })
  const drafts = points.getByRole('region', { name: 'Extracted drafts' })
  const allergyPoint = drafts.locator('[data-testid="important-point"][data-category="allergy"]').first()
  await expect(allergyPoint).toContainText(/penicillin/i, { timeout: 20_000 })
  const tick = allergyPoint.getByLabel('I have checked this against the conversation and the record')
  if (await tick.count()) await tick.check()
  await allergyPoint.getByRole('button', { name: 'Confirm', exact: true }).click()
  const confirmed = points.getByRole('region', { name: 'Confirmed by the doctor' }).getByTestId('important-point')
  await expect(confirmed.first()).toHaveAttribute('data-state', 'confirmed')
  const confirmedCount = await confirmed.count()
  await expect(conversation.getByTestId('summary-conversation')).toContainText('1 transcript · 5 lines')
  await expect(conversation.getByTestId('summary-conversation')).toContainText(`${confirmedCount} confirmed`)
  await expectStrip(page, { inputs: ['Inputs: 3 of 5 with information', 'some'], review: ['Your review: not yet', 'not_yet'] })

  // ---- 3. MODULE 2, HISTORY: the record's allergy and current medicine, in the summary and the full panel. ----
  const history = await openModule(page, 'History')
  await expect(history.getByTestId('summary-history-allergies')).toContainText('Penicillin')
  await expect(history.getByTestId('summary-history')).toContainText('1 current medicine')
  await expect(history.getByTestId('past-history')).toBeVisible()

  // ---- 4. MODULE 3, HEALTH BAND: a band under test (its gateway is this test) sends respiratory rate (16 to 19) and heart rate (86 to 90); a
  // SIMULATOR band sends heart rate 131. The band's values are device readings, UNVERIFIED; the simulator's are SIMULATED, never LIVE. ----
  const admin = await staff(baseURL!, 'admin')
  const band = await register(admin, baseURL!, 'gateway_api', `Band under test ${uniq()}`)
  const sim = await register(admin, baseURL!, 'simulator', `Simulator band ${uniq()}`)
  const vitals = await openModule(page, 'Vitals')
  const card = page.getByTestId('device-readings')
  for (const label of [band.label, sim.label]) {
    await card.getByRole('button', { name: /^Attach (a|another) device$/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Attach a device' })
    const option = dlg.locator('option', { hasText: label })
    await expect(option).toBeAttached()
    await dlg.getByLabel('Device').selectOption((await option.getAttribute('value'))!)
    await dlg.getByRole('button', { name: 'Attach' }).click()
    await expect(dlg).toBeHidden()
  }
  // Not SpO₂: the local model's checks remove a statement that quotes "SpO₂ 94 %" from the record (they read the copy's "₂" as a figure 2 that the
  // record does not hold), so the draft would be only partly available for a reason that is not this journey's. Reported to be fixed in V3. The
  // values move a little from one reading to the next, as a band's do: the model stand-in copies the newest readings, and of two identical
  // copies one would be removed as a duplicate.
  let reading = 0
  const stopBand = every(2000, () => {
    reading += 1
    return band.send([{ kind: 'respiratory_rate', value: 16 + (reading % 4) }, { kind: 'heart_rate', value: 86 + (reading % 5) }])
  })
  const stopSim = every(2000, () => sim.send([{ kind: 'heart_rate', value: 131 }]))
  await expect(card.locator('[data-testid="attached-device"][data-simulated="false"]')).toHaveAttribute('data-state', 'live', { timeout: 20_000 })
  await expect(card.locator('[data-testid="attached-device"][data-simulated="true"]')).toHaveAttribute('data-state', 'live', { timeout: 20_000 })
  const rr = vitals.locator('[data-testid="summary-vital"][data-kind="respiratory_rate"] [data-testid="summary-vital-value"][data-source="device"]')
  await expect(rr).toContainText(/\b1[6-9]\s*\/min/, { timeout: 15_000 })
  await expect(rr).toHaveAttribute('data-simulated', 'false')
  await expect(rr).toContainText('UNVERIFIED')
  // Whichever of the two bands sent the newest heart rate, a simulated value says SIMULATED and is never called LIVE.
  for (const v of await vitals.locator('[data-testid="summary-vital-value"][data-simulated="true"]').all()) {
    await expect(v).toContainText('SIMULATED')
    await expect(v).not.toContainText('LIVE')
  }
  await expect(vitals).toContainText('Blood pressure is not accepted from devices.')
  await expect(page.getByTestId('vitals-tiles')).not.toContainText('131')
  await expectStrip(page, { inputs: ['Inputs: 3 of 5 with information', 'some'] })
  // The gateways stop sending here. Each new reading is a new record item that replaces the one before it, and a draft made from the record
  // is STALE as soon as the record moves on (V3); with a band sending every two seconds the draft below would be STALE at once. The readings
  // already received stay attached to the patient (and are read: the band's, not the simulator's).
  await stopBand()
  await stopSim()

  // ---- 5. MODULE 4, STETHOSCOPE: recorded in the browser from Chromium's synthetic audio input, kept with this consultation, not analysed. ----
  const stethoscope = await openModule(page, 'Stethoscope')
  await expect(stethoscope.getByTestId('summary-stethoscope-honesty')).toContainText('Recorded, not analysed.')
  const recordings = page.getByRole('region', { name: 'Stethoscope recordings' })
  await recordings.getByRole('button', { name: 'Record', exact: true }).click()
  const rec = page.getByRole('dialog', { name: 'Record from an audio input' })
  await rec.getByRole('button', { name: 'Start recording' }).click()
  await expect(rec.getByTestId('auscultation-recording')).toContainText('Recording…')
  await page.waitForTimeout(2000)
  await rec.getByRole('button', { name: 'Stop' }).click()
  await rec.getByRole('button', { name: 'Save recording' }).click()
  await expect(rec).toBeHidden({ timeout: 15_000 })
  await expect(stethoscope.getByTestId('summary-stethoscope')).toContainText('1 recording in this consultation')
  await expectStrip(page, { inputs: ['Inputs: 4 of 5 with information', 'some'] })

  // ---- 6. MODULE 5, THERMAL: opened from the module's own quick action while it is closed; a SIMULATED capture left for review, and an
  // imported public FLIR sample approved. ----
  const thermal = page.locator('#tools-thermal')
  await expect(thermal).toHaveAttribute('data-open', 'false')
  await expect(thermal.getByTestId('summary-thermal-camera')).toContainText('FLIR ONE not connected')
  // Named by its visible words first ("Open viewer"; the module's title says "Thermal imaging"), then what it opens (Doctor HERO polish, round 2).
  await thermal.getByRole('button', { name: 'Open viewer (thermal imaging)' }).click()
  const ws = page.getByTestId('thermal-workspace')
  await expect(ws.getByTestId('thermal-no-camera')).toContainText('FLIR ONE not connected')
  await ws.getByText('Simulator (development and demonstrations)').click()
  await ws.getByLabel('Case').selectOption('localized_difference')
  await ws.getByRole('button', { name: 'Use the simulator' }).click()
  await ws.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(ws.getByTestId('thermal-live')).toBeVisible()
  await ws.getByLabel('Body region').selectOption('knee')
  await ws.getByTestId('thermal-capture').click()
  const dash = ws.getByTestId('thermal-dashboard')
  await expect(dash.getByTestId('thermal-source')).toHaveAttribute('data-source', 'simulator', { timeout: 20_000 })
  await ws.getByRole('button', { name: 'Stop using the simulator' }).click()
  await ws.getByRole('button', { name: 'Import a thermal image' }).click()
  const importDlg = page.getByRole('dialog', { name: 'Import a thermal image' })
  await importDlg.getByLabel(/Radiometric JPEG/).setInputFiles(path.join(SAMPLES, 'flir_example.jpg'))
  await importDlg.getByLabel('Body region').fill('Left knee (public sample image)')
  await importDlg.getByRole('button', { name: 'Import and extract' }).click()
  await expect(dash.getByTestId('thermal-source')).toHaveAttribute('data-source', 'gallery_import', { timeout: 30_000 })
  await ws.getByRole('button', { name: 'Approve measurements' }).click()
  await expect(ws.getByText('Approved', { exact: true })).toBeVisible()
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  await expect(ws).toBeHidden()
  await expect(thermal.getByTestId('summary-thermal-images')).toHaveText('Images: 2 (approved 1)', { timeout: 15_000 })
  // Every module holds information now, none of them only simulated items.
  await expectStrip(page, { inputs: ['Inputs: 5 of 5 with information', 'all'], analysis: ['Mana analysis: Not run', 'not_run'] })

  // ---- 7. PEDIATRIC SHOCK RESEARCH VIEW: research only; the pipeline's real statuses; the approved real image in the feature set and the
  // simulated one out; no research model; the published review labelled as not ADAXAI's. ----
  await thermal.getByRole('button', { name: 'Pediatric shock research' }).click()
  const sheet = page.getByRole('dialog', { name: 'Pediatric shock research' })
  await expect(sheet.getByTestId('research-header')).toContainText('PEDIATRIC SHOCK — RESEARCH MODE')
  await expect(sheet.getByTestId('research-header')).toContainText('Nothing here detects, predicts or scores shock.')
  expect(await sheet.locator('[data-testid="research-pipeline"] li[data-stage]').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-stage')}:${el.getAttribute('data-status')}`))).toEqual([
    'acquisition:built',
    'preprocessing:built',
    'quality:not_built',
    'extraction:built',
    'feature-set:built',
    'model:not_built',
    'output:not_built',
    'review:not_built',
  ])
  await expect(sheet.locator('[data-testid="research-pipeline"] li[data-stage="model"]')).toContainText('Research model unavailable.')
  await expect(sheet.getByTestId('research-image')).toHaveCount(1)
  await expect(sheet.locator('[data-testid="research-excluded"][data-reason="simulated"]')).toHaveCount(1)
  await expect(sheet.getByTestId('research-paper')).toContainText('PUBLISHED RESEARCH — NOT ADAX-AI VALIDATION')
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // ---- 8. ANALYZE WITH MANA: what it reads from each input, said before the click; one click; the steps; the time, measured on the stand-in. ----
  const reads = page.getByTestId('analysis-inputs')
  const row = (key: string) => reads.locator(`li[data-input="${key}"]`)
  await expect(row('conversation')).toHaveAttribute('data-included', 'true')
  await expect(row('conversation')).toContainText(`${confirmedCount} point${confirmedCount === 1 ? '' : 's'} you confirmed`)
  await expect(row('history')).toHaveAttribute('data-included', 'true')
  await expect(row('history')).toContainText('The patient’s record')
  await expect(row('vitals')).toHaveAttribute('data-included', 'true')
  await expect(row('vitals')).toContainText('Staff vital signs and device readings (unverified); simulated values not read')
  await expect(row('stethoscope')).toHaveAttribute('data-included', 'false')
  await expect(row('stethoscope')).toContainText('Recordings are not analysed')
  await expect(row('thermal')).toHaveAttribute('data-included', 'true')
  await expect(row('thermal')).toContainText('1 approved image’s measurements; simulated images not read')
  await expect(page.getByTestId('analysis-coverage')).toContainText('Does not read the raw transcript, audio, stethoscope recordings')
  const panel = page.getByTestId('consult-panel')
  const status = panel.getByTestId('consult-status')
  const clicked = Date.now()
  await analyzeButton(page).click()
  await expect(page.getByTestId('analysis-panel')).toBeVisible()
  const feedback = Date.now() - clicked
  await expect(status).toContainText('READY FOR REVIEW', { timeout: 30_000 })
  // Measured on this run with the suite's stand-ins (the Vite development server, the stand-in model): numbers about this test, not the
  // product's speed.
  test.info().annotations.push({ type: 'timing', description: `Analyze with Mana, click to READY FOR REVIEW: ${Date.now() - clicked} ms (mock-llm stand-in, not a product timing)` })
  test.info().annotations.push({ type: 'timing', description: `Analyze with Mana, click to the progress panel shown: ${feedback} ms (this run, development server; not a product timing)` })
  const steps = page.getByTestId('analysis-steps')
  await expect(steps.locator('li[data-step="save"]')).toHaveAttribute('data-state', 'done')
  await expect(steps.locator('li[data-step="rules"]')).toHaveAttribute('data-state', 'done')
  await expect(steps.locator('li[data-step="rules"]')).toContainText('safety-rules-v1')
  await expect(steps.locator('li[data-step="model"]')).toContainText('READY FOR REVIEW')
  await expect(page.getByTestId('analysis-timing')).toHaveText(/^took \d+:\d{2}( · waited \d+:\d{2} · writing and checks \d+:\d{2})?$/)
  await expect(analyzeButton(page, 'Analyze again')).toBeEnabled()
  await expectStrip(page, { analysis: ['Mana analysis: Ready for review', 'ready'], review: [/^Your review: \d+ to review$/, 'waiting'] })
  // The strip's Mana analysis leads to the Mana area's heading.
  await stepTo(page, 'Mana analysis')
  await expect(page.locator('#mana-result [data-part-focus="mana-result"]')).toBeFocused()
  // The fixed safety rules ran with the same click, in the fixed rules' own card (never violet, never called AI).
  const overview = page.locator('#mana-result').getByTestId('consultation-overview')
  await expect(overview.getByTestId('safety-rules')).toHaveAttribute('data-state', 'done')
  await expect(overview.getByTestId('safety-rules-run')).toContainText('safety-rules-v1')
  await expect(overview).toContainText('Fixed rules, not AI')

  // ---- 9. THE AI SUMMARY: model output, labelled as such; the counts; the medication considerations shown with the prescription instead. ----
  for (const label of ['AI DRAFT', 'AI-GENERATED', 'REQUIRES DOCTOR REVIEW']) await expect(panel.getByText(label, { exact: true }).first()).toBeVisible()
  const summary = panel.locator('[data-testid="consult-block"][data-block="summary"]')
  await expect(summary.getByRole('heading', { name: 'AI summary' })).toBeVisible()
  await expect(summary.getByTestId('consult-statement').first()).toContainText('A draft summary of the record items shown, for the doctor to check.')
  await expect(panel.getByTestId('consult-counts')).toContainText(/\d+ statements? from the AI · \d+ to review/)
  await expect(panel.getByRole('region', { name: 'Medication considerations' })).toHaveCount(0)
  await expect(panel.getByTestId('consult-medication-elsewhere')).toContainText('Before you prescribe')

  // ---- 10. THE MEDICATION CONSIDERATIONS, beside the prescription: AI DRAFT text, never a prescription row; accepted, then added to the Plan
  // by the doctor's own act. The allergy name check is the fixed rules', and no AI prescription suggestion exists. ----
  const waitingBefore = await toReview(page)
  const lane = page.getByTestId('rx-ai-lane')
  const considerations = lane.getByTestId('rx-considerations')
  await expect(considerations).toHaveAttribute('data-state', 'shown')
  for (const label of ['AI DRAFT', 'AI-GENERATED', 'REQUIRES DOCTOR REVIEW']) await expect(considerations.getByText(label, { exact: true }).first()).toBeVisible()
  const consideration = considerations.getByTestId('consult-statement').first()
  await expect(consideration).toContainText('Check the medicines in the record against the recorded allergy before anything is added.')
  await expect(lane.getByTestId('rx-no-ai')).toContainText('No AI prescription suggestions.')
  await expect(lane.getByTestId('rx-allergy-check')).toHaveAttribute('data-state', 'done')
  await expect(lane.getByTestId('rx-allergy-check')).toContainText('Fixed rules, not AI')
  const rx = page.getByRole('region', { name: 'Prescription', exact: true })
  await expect(rx).toContainText('No medicines prescribed.')
  const ack = async (s: Locator) => {
    const b = s.getByLabel('I have checked this against the record')
    if (await b.count()) await b.check({ timeout: 10_000 })
  }
  const plan = page.getByLabel('Plan', { exact: true })
  await expect(plan).toHaveValue('')
  await ack(consideration)
  await consideration.getByRole('button', { name: 'Accept' }).click()
  await expect(consideration).toHaveAttribute('data-decision', 'accepted')
  // Accepting wrote nothing. Adding is a separate act, into the Plan only (the one place it may go).
  await expect(plan).toHaveValue('')
  await expect(consideration).toContainText('Goes into the note’s Plan section, where you can change it.')
  await consideration.getByRole('button', { name: 'Add to note' }).click()
  await expect(consideration).toContainText('In the note', { timeout: 15_000 })
  await expect(plan).toHaveValue(/Check the medicines in the record against the recorded allergy/)
  await expect(rx).toContainText('No medicines prescribed.')

  // ---- 11. THE DOCTOR'S REVIEW of the summary's statements: accept one, edit one, reject one; the accepted and the edited go into the note. ----
  const statement = (section: string) => panel.locator(`[data-testid="consult-statement"][data-section="${section}"]`).first()
  const accepted = statement('presenting_problem')
  await expect(accepted).toContainText('Sore throat and fever')
  await ack(accepted)
  await accepted.getByRole('button', { name: 'Accept' }).click()
  await expect(accepted).toHaveAttribute('data-decision', 'accepted')
  const edited = statement('observations')
  const editedText = 'Edited by the doctor (synthetic): febrile at the visit, pulse slightly fast.'
  await edited.getByRole('button', { name: 'Edit' }).click()
  await edited.getByLabel('Edit before accepting').fill(editedText)
  await ack(edited)
  await edited.getByRole('button', { name: 'Save edited text' }).click()
  await expect(edited).toHaveAttribute('data-decision', 'edited')
  const rejected = statement('potential_considerations')
  await rejected.getByRole('button', { name: 'Reject' }).click()
  await expect(rejected).toHaveAttribute('data-decision', 'rejected')
  await expect(rejected.getByRole('button', { name: 'Add to note' })).toHaveCount(0)
  // Four decisions (the consideration and these three): the strip's count goes down by four.
  const left = waitingBefore - 4
  await expectStrip(page, { review: left > 0 ? [`Your review: ${left} to review`, 'waiting'] : ['Your review: Nothing waiting', 'clear'] })
  const hpi = page.getByLabel('History of present illness')
  const exam = page.getByLabel('Examination', { exact: true })
  await expect(hpi).toHaveValue('')
  await accepted.getByLabel('Add to note section').selectOption('history')
  await accepted.getByRole('button', { name: 'Add to note' }).click()
  await expect(accepted).toContainText('In the note', { timeout: 15_000 })
  await expect(hpi).toHaveValue(/Sore throat and fever/)
  const insertedText = (await hpi.inputValue()).trim()
  await edited.getByLabel('Add to note section').selectOption('examination')
  await edited.getByRole('button', { name: 'Add to note' }).click()
  await expect(edited).toContainText('In the note', { timeout: 15_000 })
  await expect(exam).toHaveValue(editedText)
  await expect(page.getByRole('region', { name: 'Consultation note' }).getByLabel('AI-assisted text in this section')).toHaveCount(3)
  // The AI wrote no diagnosis and no prescription.
  await expect(page.getByRole('region', { name: 'Diagnosis', exact: true })).toContainText('No diagnosis yet.')
  await expect(rx).toContainText('No medicines prescribed.')

  // ---- 12. THE DOCTOR WRITES the diagnosis and the prescription. ----
  await stepTo(page, 'Note & prescription')
  await expect(page.locator('#consultation-note')).toBeFocused()
  await page.getByRole('button', { name: 'Add diagnosis' }).click()
  await page.getByLabel('Diagnosis 1', { exact: true }).fill('Acute pharyngitis (synthetic)')
  await rx.getByRole('button', { name: 'Add medicine' }).click()
  await rx.getByLabel('Medicine', { exact: true }).fill('Paracetamol')
  await rx.getByLabel('Strength', { exact: true }).fill('500 mg')
  await rx.getByLabel('Form', { exact: true }).fill('Tablet')
  await rx.getByLabel('Dose', { exact: true }).fill('1 tablet')
  await rx.getByLabel('Frequency', { exact: true }).fill('Three times daily (TDS)')
  await rx.getByLabel('Duration', { exact: true }).fill('3 days')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 15_000 })
  await expectStrip(page, { record: ['Note & prescription: 1 medicine · saved', 'saved'] })
  // What the medication considerations offered was never copied into it: the one row is the doctor's.
  await expect(rx.getByLabel('Medicine', { exact: true })).toHaveValue('Paracetamol')

  // ---- 13. THE PAGE AT SEVEN SIZES, with everything above on it: no sideways scrolling, the panes where they belong, WCAG 2.2 AA. ----
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.waitForTimeout(300)
    // From the top of the page, as the doctor opens it (a control half under a sticky bar where an earlier size left the page scrolled is not
    // a state of the page; see multimodal-consultation.spec).
    await page.evaluate(() => window.scrollTo(0, 0))
    await expectNoHorizontalOverflow(page)
    await expectPanes(page, size)
    await expectNoAxeViolations(page)
  }
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.evaluate(() => window.scrollTo(0, 0))

  // ---- 14. PRINT PREVIEW: the existing print page in a new tab, marked as a draft that is not a valid prescription, with what was saved. ----
  const [preview] = await Promise.all([page.context().waitForEvent('page'), page.getByTestId('print-preview').click()])
  await preview.waitForLoadState()
  expect(new URL(preview.url()).pathname).toBe(`/print/encounters/${encounterId}`)
  await expect(preview.getByRole('note')).toHaveText('Draft — not signed · not a valid prescription')
  await expect(preview.locator('main')).toContainText('Paracetamol')
  await expect(preview.locator('main')).toContainText('Acute pharyngitis (synthetic)')
  await preview.close()

  // ---- 15. REVIEW AND SIGN: the strip's Sign leads to "Complete consultation"; the record is signed with its AI-assisted text and sources. ----
  await stepTo(page, 'Sign')
  const complete = page.getByTestId('consultation-actions').getByRole('button', { name: 'Complete consultation' })
  await expect(complete).toBeFocused()
  await page.keyboard.press('Enter')
  const signDlg = page.getByRole('dialog', { name: 'Review and sign' })
  await expect(signDlg).toContainText('Acute pharyngitis (synthetic)')
  await expect(signDlg).toContainText('Paracetamol')
  await expect(signDlg).toContainText('AI-assisted text in this note')
  await expect(signDlg.getByRole('button', { name: 'Sign and complete' })).toBeDisabled()
  await signDlg.getByLabel(/I have reviewed this record/).check()
  await signDlg.getByRole('button', { name: 'Sign and complete' }).click()
  await expect(page.getByText(/^Signed /)).toBeVisible({ timeout: 15_000 })
  openPatient = null
  await expect(page.getByTestId('workflow-strip')).toHaveCount(0)
  const signedNote = page.getByRole('region', { name: 'Consultation note' })
  await expect(signedNote).toContainText(insertedText)
  await expect(signedNote).toContainText(editedText)
  await expect(signedNote).toContainText('Check the medicines in the record against the recorded allergy')
  await expect(page.getByRole('region', { name: 'AI-assisted text', exact: true })).toContainText('Plan: AI-assisted text from consultation draft statement')

  // ---- 16. AUDIT: the journey is in the patient's audit trail, by action, without clinical free text; and the page talked only to this
  // application and never to Mana chat. ----
  const events: AuditRow[] = []
  for (let before: number | null = null, n = 0; n < 20; n++) {
    const res = await admin.get('/api/admin/audit-events', { params: { patientId: p.patientId, limit: 200, ...(before !== null && { before }) } })
    expect(res.ok(), await res.text()).toBe(true)
    const body = (await res.json()) as { events: AuditRow[]; nextBefore: number | null }
    events.push(...body.events)
    if (body.nextBefore === null) break
    before = body.nextBefore
  }
  await band.dispose()
  await sim.dispose()
  await admin.dispose()
  const has = (action: string, where: (e: AuditRow) => boolean = () => true) => events.some((e) => e.action === action && e.outcome === 'success' && where(e))
  const expected: [string, (e: AuditRow) => boolean][] = [
    ['encounter.start', () => true],
    ['ai.live_start', () => true],
    ['ai.transcription', () => true],
    ['ai.live_end', (e) => e.details.reason === 'doctor_stopped'],
    ['ai.extraction', () => true],
    ['ai.review', (e) => e.details.type === 'fact' && e.details.decision === 'accepted'],
    ['device.assign', (e) => e.details.simulated === true],
    ['device.assign', (e) => e.details.simulated === false],
    ['device.ingest', (e) => e.actorRole === 'device' && e.details.simulated === true],
    ['device.ingest', (e) => e.actorRole === 'device' && e.details.simulated === false],
    ['auscultation.upload', (e) => e.details.captureMethod === 'browser_recording'],
    ['thermal.workspace_opened', () => true],
    ['thermal.upload', (e) => JSON.stringify(e.details).includes('"simulator"')],
    ['thermal.upload', (e) => JSON.stringify(e.details).includes('gallery_import')],
    ['thermal.review', () => true],
    ['ai.consultation_draft_requested', () => true],
    ['ai.safety_check', () => true],
    ['ai.consultation_draft', (e) => e.details.insufficient === false],
    ['ai.consultation_review', (e) => e.details.decision === 'accepted'],
    ['ai.consultation_review', (e) => e.details.decision === 'edited'],
    ['ai.consultation_review', (e) => e.details.decision === 'rejected'],
    ['encounter.ai_insert', (e) => e.details.subjectType === 'consultation_item' && e.details.section === 'history'],
    ['encounter.ai_insert', (e) => e.details.subjectType === 'consultation_item' && e.details.section === 'examination'],
    ['encounter.ai_insert', (e) => e.details.subjectType === 'consultation_item' && e.details.section === 'plan'],
    ['encounter.sign', () => true],
  ]
  const missing = expected.filter(([a, where]) => !has(a, where)).map(([a]) => a)
  expect(missing, `audit actions present: ${[...new Set(events.map((e) => e.action))].sort().join(', ')}`).toEqual([])
  const serialized = JSON.stringify(events).toLowerCase()
  for (const text of ['I am allergic to penicillin', 'I have had a cough and a fever for three days', insertedText, editedText, 'Check the medicines in the record', 'Acute pharyngitis (synthetic)', 'Left knee (public sample image)']) {
    expect(serialized.includes(text.toLowerCase()), `the audit log holds the free text “${text}”`).toBe(false)
  }
  expect(manaRequests, 'requests to Mana chat').toEqual([])
  expect(outside, 'requests to anything but the app').toEqual([])
})
