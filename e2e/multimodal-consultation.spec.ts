import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect, type Locator, request as pwRequest, test } from '@playwright/test'
import { analyzeButton, DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, llmExclusive, nurseHandsOverPatient, openModule, signIn, stepTo, uniq } from './support.ts'

/*
 * D2 in a real browser, against the real API and database: one consultation in which every modality is used, and its Overview (the consultation
 * context: one read model built by the server from the records that already exist) checked after each. One synthetic patient.
 *
 * What is real and what stands in: the browser, the API, the database and the thermal service are real. The local model is the suite's stand-in
 * (e2e/mock-llm.mjs), the speech service is its stand-in (e2e/mock-speech.mjs), the microphone and the stethoscope's audio input are Chromium's
 * synthetic ones. NO DEVICE IS USED: the "band under test" is a device record whose gateway is this test posting fixed numbers with its token
 * (shown as a device reading, unverified), and the simulator band is a simulator (shown SIMULATED). NO CAMERA IS USED: the thermal simulator is
 * SIMULATED, and the imported image is a public FLIR sample file (someone else's scene, not this patient's).
 */

const SAMPLES = path.resolve(import.meta.dirname, '..', 'samples', 'thermal')
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

const SIZES = [
  { width: 1024, height: 768 },
  { width: 1180, height: 820 },
  { width: 1280, height: 800 },
  { width: 1366, height: 1024 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
]

// The model and speech stand-ins are shared: desktop project only, and this file holds the model stand-in's lock while it runs.
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

type AuditRow = { action: string; outcome: string; details: Record<string, unknown> }

test('the multimodal consultation: every modality in one consultation, its overview (evidence, review, disagreements, missing, the rules-made summary) after each, the doctor deciding, signing, and the audit trail', async ({ page, baseURL }) => {
  test.skip(!fs.existsSync(path.join(SAMPLES, 'flir_example.jpg')), 'thermal sample images not fetched (npm run setup)')
  test.setTimeout(600_000)
  const tools = page.getByTestId('consultation-tools')
  const overview = page.getByTestId('consultation-overview')
  const review = overview.getByTestId('overview-review')
  /**
   * The overview's evidence, what is missing and the summary are behind "Show evidence" in the Mana area (Doctor HERO: the overview shows
   * what waits for review and the disagreements first). Opened once; it stays open.
   */
  const showEvidence = async () => {
    const fold = overview.getByTestId('overview-fold')
    if ((await fold.getAttribute('data-open')) !== 'true') await overview.getByRole('button', { name: 'Show evidence' }).click()
    await expect(fold).toHaveAttribute('data-open', 'true')
  }
  /** The overview's evidence rows of one kind (every row listed: "Show all" is opened once and stays open). */
  const rows = async (kind: string): Promise<Locator> => {
    await showEvidence()
    const all = overview.getByTestId('evidence-show-all')
    if ((await all.count()) && (await all.getAttribute('aria-expanded')) === 'false') await all.click()
    return overview.locator(`[data-testid="evidence-item"][data-kind="${kind}"]`)
  }
  /** The overview is in the Mana area, on the right (it was the first part of the tools column, reached by the "Go to" bar, before Doctor HERO). */
  const toOverview = () => overview.scrollIntoViewIfNeeded()
  /** The overview reads the context again every 15 s (and after an insertion): a step waits for its next read. */
  const READ = { timeout: 25_000 }
  const summarySection = (key: string) => overview.getByTestId('overview-summary').locator(`[data-testid="summary-section"][data-key="${key}"]`)
  const openSummary = async () => {
    await showEvidence()
    const d = overview.getByTestId('overview-summary')
    if ((await d.getAttribute('open')) === null) await d.locator('summary').click()
  }

  // ---- 0. The nurse registered the patient (no allergy recorded, and "no known allergies" not marked), recorded the consents and the vital
  // signs (temperature 38.2, heart rate 92, and SpO₂ 98 measured by staff), and handed over. ----
  const p = await nurseHandsOverPatient(baseURL!, { name: { given: `Multi${uniq()}`, family: 'Synthetic' }, consents: ['ai_recording', 'device_monitoring', 'ai_record_assistant', 'thermal_imaging'] })
  openPatient = p.patientId
  const nurse = await staff(baseURL!, 'nurse.anil')
  const visit = (((await (await nurse.get(`/api/patients/${p.patientId}/visits`)).json()).visits ?? []) as { id: string; status: string }[]).find((v) => v.status === 'ready')!
  expect((await nurse.post(`/api/visits/${visit.id}/observations`, { data: { items: [{ kind: 'spo2', value: 98 }] } })).ok()).toBe(true)

  // ---- 1. Sign in, the dashboard, today's patients, the consultation started from the row. ----
  await page.setViewportSize({ width: 1180, height: 820 })
  await signIn(page, 'dr.meera')
  await expect(page).toHaveURL(/\/doctor$/)
  await page.getByRole('region', { name: 'Today’s schedule' }).getByRole('link', { name: 'View all' }).click()
  await expect(page).toHaveURL(/\/doctor\/queue$/)
  await page.getByRole('list', { name: 'Visits' }).getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}$/)
  const encounterId = /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!
  const note = page.getByRole('region', { name: 'Consultation note' })

  // ---- 2. THE OVERVIEW, in the Mana area with the fixed rules' checks (Doctor HERO; it was first in the tools column before, and the inputs
  // rail now starts with the conversation): the staff's vital signs (entered by staff), nothing waiting, and what is missing. ----
  const modules = tools.locator('[role="group"][data-testid^="module-"]')
  await expect(modules).toHaveCount(5)
  expect(await modules.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))).toEqual(['module-conversation', 'module-history', 'module-vitals', 'module-stethoscope', 'module-thermal'])
  await expect(page.locator('#mana-result').getByTestId('consultation-overview')).toBeVisible()
  // The workflow strip's "Your review" leads to what waits for the doctor: with no draft yet, the overview's "Needs your review".
  await expect(overview.getByRole('heading', { name: 'Consultation overview' })).toBeVisible()
  await expect(review).toContainText('Nothing is waiting for your review.')
  await stepTo(page, 'Your review')
  await expect(review.locator('[data-part-focus="mana-review"]')).toBeFocused()
  await expect(overview.getByRole('heading', { name: 'Consultation overview' })).toBeVisible()
  await expect(overview).toContainText('Nothing here is a diagnosis or a recommendation.')
  await expect(review).toContainText('Nothing is waiting for your review.')
  const staffVitals = await rows('vital_staff')
  await expect(staffVitals).toHaveCount(3)
  for (const r of await staffVitals.all()) await expect(r).toHaveAttribute('data-trust', 'clinician_entered')
  await expect(staffVitals.filter({ hasText: 'SpO₂' })).toContainText('98')
  const missing = overview.getByTestId('overview-missing')
  await expect(missing).toContainText('Allergy status not recorded')
  await expect(missing).toContainText('No conversation captured in this consultation.')
  await expect(missing).toContainText('No AI draft made in this consultation')
  await expect(missing).toContainText('No thermal image in this consultation (for information; not required).')
  // The summary is closed until opened, says what made it, and has its five sections.
  await openSummary()
  await expect(overview.getByTestId('overview-summary')).toContainText('Composed by fixed rules from this consultation\'s records, not by AI. Advisory: the doctor decides.')
  await expect(overview.getByTestId('summary-section')).toHaveCount(5)
  await expect(summarySection('patient')).toContainText('Allergy status is not recorded')
  await expect(summarySection('observations')).toContainText('SpO₂ 98')
  await expect(summarySection('observations')).toContainText('(entered by staff)')
  await expectNoAxeViolations(page)

  // ---- 3. CONVERSATION: recorded from the synthetic microphone; the important points wait for review; the doctor confirms the allergy. ----
  await openModule(page, 'Conversation')
  const live = page.getByRole('region', { name: 'Live transcription' })
  await live.getByRole('button', { name: 'Start recording' }).click()
  await expect(live.getByTestId('recording-state')).toContainText(/00:0[3-9]/, { timeout: 15_000 })
  await live.getByRole('button', { name: 'Stop' }).click()
  await expect(live.getByRole('button', { name: 'Start recording' })).toBeVisible({ timeout: 20_000 })
  await expect(live.getByTestId('raw-transcript').getByTestId('transcript-line')).toHaveCount(5, { timeout: 20_000 })
  const points = page.getByRole('region', { name: 'Important points' })
  const drafts = points.getByRole('region', { name: 'Extracted drafts' })
  await expect(drafts.getByTestId('important-point').first()).toBeVisible({ timeout: 20_000 })
  // The overview: the conversation (said in the consultation), and the extracted points waiting, leading to the conversation.
  await toOverview()
  await expect(await rows('transcript')).toHaveCount(1, READ)
  await expect((await rows('transcript')).first()).toHaveAttribute('data-trust', 'observed')
  const pendingPoints = review.locator('[data-testid="pending-review"][data-target="conversation"]')
  await expect(pendingPoints).toContainText('important point', READ)
  await pendingPoints.click()
  await expect(page.locator('#tools-conversation')).toBeFocused()
  // It leads to module 1 in the inputs rail and opens it (it is open already here; a closed one is opened: lib/workspace.ts revealPart).
  await expect(page.locator('#tools-conversation')).toHaveAttribute('data-open', 'true')
  const allergyPoint = drafts.locator('[data-testid="important-point"][data-category="allergy"]').first()
  await expect(allergyPoint).toContainText(/penicillin/i, { timeout: 20_000 })
  const tick = allergyPoint.getByLabel('I have checked this against the conversation and the record')
  if (await tick.count()) await tick.check()
  await allergyPoint.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(points.getByRole('region', { name: 'Confirmed by the doctor' }).getByTestId('important-point').first()).toHaveAttribute('data-state', 'confirmed')
  // The patient said an allergy while the record has no allergy status: the overview says the sources disagree, and resolves nothing.
  await toOverview()
  const allergyConflict = review.locator('[data-testid="context-conflict"][data-kind="allergy_status"]')
  await expect(allergyConflict).toContainText('Sources disagree.', READ)
  await expect(allergyConflict).toContainText('Not resolved: each side is shown as it was recorded.')
  await expect(allergyConflict).toContainText('context-conflicts-v2')
  await expect(await rows('point')).not.toHaveCount(0)
  await expect(overview.locator('[data-testid="evidence-item"][data-kind="point"][data-status="Doctor confirmed"]').filter({ hasText: /penicillin/i })).not.toHaveCount(0, READ)
  // A point the fixed rules found and the doctor has not decided says so: extracted, to review (not a fact, and not called AI).
  const undecided = overview.locator('[data-testid="evidence-item"][data-kind="point"][data-status="Extracted draft"]').first()
  await expect(undecided).toHaveAttribute('data-trust', 'extracted')
  await expect(undecided).toContainText('Extracted from the conversation, to review')
  // The banner still shows no allergy: nothing was written to the record.
  await expect(page.getByTestId('patient-banner')).not.toContainText('Allergy: Penicillin')

  // ---- 4. AI DRAFT: made by the (stand-in) local model, one statement accepted; the rest wait. Asked for with "Analyze with Mana" at the foot
  // of the inputs rail (the result card has no button of its own since Doctor HERO); the strip's "Mana analysis" leads to the result. ----
  await stepTo(page, 'Mana analysis')
  const consult = page.getByTestId('consult-panel')
  await analyzeButton(page).click()
  // With no allergy status on the record the draft is only partly available (V3 says so); either way its statements wait for the doctor.
  await expect(consult.getByTestId('consult-status')).toContainText(/READY FOR REVIEW|PARTIALLY AVAILABLE/, { timeout: 30_000 })
  const accepted = consult.locator('[data-testid="consult-statement"][data-section="presenting_problem"]').first()
  const ack = accepted.getByLabel('I have checked this against the record')
  if (await ack.count()) await ack.check()
  await accepted.getByRole('button', { name: 'Accept' }).click()
  await expect(accepted).toHaveAttribute('data-decision', 'accepted')
  await toOverview()
  const draftRow = (await rows('ai_draft')).first()
  await expect(draftRow).toHaveAttribute('data-trust', 'model_output', READ)
  await expect(draftRow).toContainText('AI output, to review')
  await expect(review.locator('[data-testid="pending-review"][data-target="draft"]')).toContainText('AI draft statement', READ)
  await openSummary()
  // Only what the doctor accepted is in the summary's AI section, as reviewed; what waits is counted, not stated.
  await expect(summarySection('ai')).toContainText('accepted by the doctor', READ)
  await expect(summarySection('ai')).toContainText('wait for the doctor’s review')
  await expect(page.getByLabel('History of present illness')).toHaveValue('')

  // ---- 5. DEVICES: a band under test (its gateway is this test) sends SpO₂ 94 and heart rate 88; a SIMULATOR band sends heart rate 131. ----
  const admin = await staff(baseURL!, 'admin')
  const band = await register(admin, baseURL!, 'gateway_api', `Band under test ${uniq()}`)
  const sim = await register(admin, baseURL!, 'simulator', `Simulator band ${uniq()}`)
  // Module 3 of the inputs rail ("Health band & vitals"; the "Go to" bar's "Devices" before Doctor HERO).
  await openModule(page, 'Vitals')
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
  every(2000, () => band.send([{ kind: 'spo2', value: 94 }, { kind: 'heart_rate', value: 88 }]))
  every(2000, () => sim.send([{ kind: 'heart_rate', value: 131 }]))
  await expect(card.locator('[data-testid="attached-device"][data-simulated="false"]')).toHaveAttribute('data-state', 'live', { timeout: 20_000 })
  await expect(card.locator('[data-testid="attached-device"][data-simulated="true"]')).toHaveAttribute('data-state', 'live', { timeout: 20_000 })
  await toOverview()
  // The band's values: device readings, unverified, LIVE while they arrive. The simulator's: SIMULATED, never LIVE.
  const deviceRows = await rows('vital_device')
  const bandSpo2 = deviceRows.filter({ hasText: band.label }).filter({ hasText: 'SpO₂' }).first()
  await expect(bandSpo2).toHaveAttribute('data-trust', 'measured_unverified', READ)
  await expect(bandSpo2).toContainText('94')
  await expect(bandSpo2.getByTestId('unverified-badge')).toHaveText('UNVERIFIED')
  const simRow = deviceRows.filter({ hasText: sim.label }).first()
  await expect(simRow).toHaveAttribute('data-trust', 'simulated', READ)
  await expect(simRow).toHaveAttribute('data-status', /^SIMULATED/)
  await expect(simRow).not.toHaveAttribute('data-status', /LIVE/)
  await expect(simRow.getByTestId('simulated-badge')).toBeVisible()
  // Staff measured 98, the band sent 94, within minutes: the sources disagree; both values are shown and neither is chosen.
  const vitalConflict = review.locator('[data-testid="context-conflict"][data-kind="vital_staff_vs_device"]')
  await expect(vitalConflict).toContainText('98', READ)
  await expect(vitalConflict).toContainText('94')
  await expect(review.locator('[data-testid="context-conflict"]').filter({ hasText: '131' })).toHaveCount(0)
  await openSummary()
  await expect(summarySection('observations')).toContainText('device reading, unverified', READ)
  await expect(summarySection('observations')).not.toContainText('131')
  await expect(summarySection('review')).toContainText('SIMULATED items (generated by a simulator) are listed for what they are and are not part of this summary.')
  // The visit's own vital signs are still the staff's.
  await expect(page.getByTestId('vitals-tiles')).not.toContainText('131')

  // ---- 6. MANA: the consultation's own questions, answered from the consultation context, read-only; nothing SIMULATED reaches it. Ask Mana
  // is the last block of the Mana area (Doctor HERO; a part of the tools column before). ----
  const mana = page.locator('#mana-chat').getByTestId('mana-assistant')
  await mana.scrollIntoViewIfNeeded()
  await mana.getByTestId('mana-toggle').click()
  const suggestions = mana.getByRole('group', { name: 'Suggested questions' })
  await suggestions.getByRole('button', { name: 'What was recorded in this consultation?' }).click()
  const recorded = mana.getByTestId('mana-message').last()
  await expect(recorded.getByTestId('mana-answer')).toBeVisible({ timeout: 30_000 })
  await expect(recorded.getByTestId('mana-answer')).toContainText(/Entered by staff|Device reading, unverified|Said in the consultation|Reviewed by the doctor|AI output, to review|Extracted from the conversation, to review/)
  await expect(recorded).not.toContainText('131')
  await expect(recorded.getByTestId('mana-findings')).toContainText('Mana does not use')
  await expect(recorded.getByTestId('mana-findings')).toContainText('not resolved')
  await mana.getByRole('group', { name: 'Suggested questions' }).getByRole('button', { name: 'What still needs my review?' }).click()
  const toReview = mana.getByTestId('mana-message').last()
  await expect(toReview.getByTestId('mana-answer')).toContainText('To review', { timeout: 30_000 })
  await expect(mana.getByRole('button', { name: /add to note/i })).toHaveCount(0)

  // ---- 7. STETHOSCOPE: recorded in the browser from Chromium's synthetic audio input; kept with this consultation, not analysed. Module 4 of
  // the inputs rail (it shared the "Devices" part before Doctor HERO). ----
  await openModule(page, 'Stethoscope')
  const recordings = page.getByRole('region', { name: 'Stethoscope recordings' })
  await recordings.getByRole('button', { name: 'Record', exact: true }).click()
  const rec = page.getByRole('dialog', { name: 'Record from an audio input' })
  await rec.getByRole('button', { name: 'Start recording' }).click()
  await expect(rec.getByTestId('auscultation-recording')).toContainText('Recording…')
  await page.waitForTimeout(2000)
  await rec.getByRole('button', { name: 'Stop' }).click()
  await rec.getByRole('button', { name: 'Save recording' }).click()
  await expect(rec).toBeHidden({ timeout: 15_000 })
  await toOverview()
  const steth = (await rows('stethoscope')).first()
  await expect(steth).toHaveAttribute('data-trust', 'recorded', READ)
  await expect(steth).toContainText('Recorded, not analysed')
  await expect(steth).not.toContainText(/murmur|abnormal|finding/i)
  await openSummary()
  await expect(summarySection('observations')).toContainText('recording available for clinician review; not analysed', READ)

  // ---- 8. THERMAL: a SIMULATED capture (left to review), and an imported public FLIR sample approved, summarised, accepted, added to the note.
  // Module 5 of the inputs rail. ----
  await openModule(page, 'Thermal')
  await page.getByTestId('thermal-open').click()
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
  const dlg = page.getByRole('dialog', { name: 'Import a thermal image' })
  await dlg.getByLabel(/Radiometric JPEG/).setInputFiles(path.join(SAMPLES, 'flir_example.jpg'))
  await dlg.getByLabel('Body region').fill('Left knee (public sample image)')
  await dlg.getByRole('button', { name: 'Import and extract' }).click()
  await expect(dash.getByTestId('thermal-source')).toHaveAttribute('data-source', 'gallery_import', { timeout: 30_000 })
  await ws.getByRole('button', { name: 'Approve measurements' }).click()
  await expect(ws.getByText('Approved', { exact: true })).toBeVisible()
  const thermalSummary = ws.getByRole('region', { name: 'Thermal summary' })
  await thermalSummary.getByRole('button', { name: 'Compose summary' }).click()
  await expect(thermalSummary.getByTestId('thermal-summary-statement').first()).toContainText('IMPORTED')
  await thermalSummary.getByRole('button', { name: 'Accept' }).click()
  await expect(thermalSummary.getByTestId('thermal-summary-status')).toHaveAttribute('data-status', 'accepted')
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  await expect(page.getByLabel('Examination', { exact: true })).toHaveValue('')
  await page.getByTestId('thermal-panel-study').filter({ has: page.locator('[data-source="gallery_import"]') }).click()
  await ws.getByRole('region', { name: 'Thermal summary' }).getByTestId('thermal-summary-insert').getByRole('button', { name: 'Add to Examination' }).click()
  await expect(ws.getByRole('region', { name: 'Thermal summary' }).getByTestId('thermal-summary-insert')).toContainText('In the note')
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  await expect(page.getByLabel('Examination', { exact: true })).toHaveValue(/./)
  // The overview, read again after the insertion: the imported image measured and approved, the simulated one SIMULATED and waiting, the
  // summary of fixed rules, and what is in the note (reviewed by the doctor).
  await toOverview()
  const thermalRows = await rows('thermal')
  await expect(thermalRows).toHaveCount(2, READ)
  const imported = thermalRows.filter({ has: page.locator('[data-trust="measured"]') })
  await expect(imported).toHaveAttribute('data-status', 'Approved')
  // An imported image's row time is when it was imported, and it says the date it was taken is not known.
  await expect(imported).toContainText('date taken not known')
  await expect(thermalRows.filter({ has: page.locator('[data-trust="simulated"]') })).toHaveAttribute('data-status', /^SIMULATED/)
  await expect((await rows('thermal_summary')).first()).toHaveAttribute('data-trust', 'rule_output')
  await expect((await rows('note_insertion')).first()).toHaveAttribute('data-trust', 'doctor_reviewed', READ)
  await expect(review.locator('[data-testid="pending-review"][data-target="thermal"]')).toContainText('thermal image')
  await openSummary()
  await expect(summarySection('observations')).toContainText('(approved): whole image min')
  await expect(summarySection('observations')).toContainText('IMPORTED: an earlier image chosen from the device, date taken not known.')
  await expect(summarySection('observations')).toContainText('Skin-surface temperature only.')
  await expect(missing).not.toContainText('No thermal image')
  // Diagnosis and prescription untouched by any of it.
  await expect(page.getByRole('region', { name: 'Diagnosis', exact: true })).toContainText('No diagnosis yet.')
  await expect(page.getByRole('region', { name: 'Prescription', exact: true })).toContainText('No medicines prescribed.')

  // ---- 9. The overview at the tablet, desktop and phone sizes: it fits, and the page passes the accessibility checks. ----
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.waitForTimeout(300)
    await expectNoHorizontalOverflow(page)
  }
  await page.setViewportSize({ width: 1180, height: 820 })
  // From the top of the page (as capture.spec does): since Doctor HERO the draft's statements are in the page's own flow (the Mana area), not
  // in the tools column's scroller, so wherever the sizes above left the page scrolled, a statement's small "Sources" toggle can sit half under
  // the sticky bar, and axe then measures only its uncovered part. A control covered by where the page happens to be scrolled is not a state
  // of the page.
  await page.evaluate(() => window.scrollTo(0, 0))
  await expectNoAxeViolations(page)

  // ---- 10. The doctor writes the diagnosis and the prescription, reviews and signs. ----
  await page.getByRole('button', { name: 'Add diagnosis' }).click()
  await page.getByLabel('Diagnosis 1', { exact: true }).fill('Acute pharyngitis (synthetic)')
  await page.getByRole('button', { name: 'Add medicine' }).click()
  await page.getByLabel('Medicine', { exact: true }).fill('Paracetamol')
  await page.getByLabel('Strength', { exact: true }).fill('500 mg')
  await page.getByLabel('Form', { exact: true }).fill('Tablet')
  await page.getByLabel('Dose', { exact: true }).fill('1 tablet')
  await page.getByLabel('Frequency', { exact: true }).fill('Three times daily (TDS)')
  await page.getByLabel('Duration', { exact: true }).fill('3 days')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 15_000 })
  await page.getByTestId('consultation-actions').getByRole('button', { name: 'Complete consultation' }).click()
  const sign = page.getByRole('dialog', { name: 'Review and sign' })
  await expect(sign).toContainText('Acute pharyngitis (synthetic)')
  await expect(sign).toContainText('Paracetamol')
  await sign.getByLabel(/I have reviewed this record/).check()
  await sign.getByRole('button', { name: 'Sign and complete' }).click()
  await expect(page.getByText(/^Signed /)).toBeVisible({ timeout: 15_000 })
  openPatient = null
  // The signed note holds the thermal summary as the doctor accepted it, and says where that text came from.
  await expect(note).toContainText('Thermal image of')
  await expect(page.getByRole('region', { name: 'AI-assisted text', exact: true })).toContainText(/Examination: .*thermal study summary \(thermal-summary-v1/i)

  // ---- 11. Through the API: the signed consultation's context is still readable by the nurse of the facility (what a nurse is shown is decided
  // by the server: no conversation, no AI draft); an unknown consultation is not found. (Other facilities, the patient portal and another
  // consultation's data are covered by apps/api/test/consultation-context.test.ts, cases I and J.) ----
  const asNurse = await nurse.get(`/api/encounters/${encounterId}/context`)
  expect(asNurse.ok()).toBe(true)
  const nurseView = (await asNurse.json()) as { evidence: { kind: string }[]; pending: { unread: string[] } }
  // What a nurse is not shown is not counted for them, and said so (never a 0 that reads as nothing waiting).
  expect(nurseView.pending.unread).toEqual(['points', 'draftStatements'])
  expect(nurseView.evidence.some((e) => e.kind === 'transcript' || e.kind === 'ai_draft' || e.kind === 'point')).toBe(false)
  expect(nurseView.evidence.some((e) => e.kind === 'thermal')).toBe(true)
  expect((await nurse.get('/api/encounters/00000000-0000-4000-8000-000000000000/context')).status()).toBe(404)
  await nurse.dispose()

  // ---- 12. AUDIT: the context was viewed (counts only), Mana's consultation tool ran, and no clinical free text or value is in the log. ----
  const events: AuditRow[] = []
  for (let before: number | null = null, n = 0; n < 20; n++) {
    const res = await admin.get('/api/admin/audit-events', { params: { patientId: p.patientId, limit: 200, ...(before !== null && { before }) } })
    expect(res.ok()).toBe(true)
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
    ['encounter.context_viewed', (e) => typeof e.details.kinds === 'object' && e.details.rules !== undefined],
    ['ai.transcription', () => true],
    ['ai.review', (e) => e.details.type === 'fact'],
    ['ai.consultation_draft', () => true],
    ['ai.consultation_review', (e) => e.details.decision === 'accepted'],
    ['mana.question_asked', (e) => e.details.suggestion === 'consultation_recorded'],
    ['mana.tool_run', (e) => e.details.tool === 'consultation_context'],
    ['device.assign', (e) => e.details.simulated === true],
    ['device.assign', (e) => e.details.simulated === false],
    ['auscultation.upload', () => true],
    ['thermal.upload', () => true],
    ['thermal.summary_review', () => true],
    ['encounter.ai_insert', (e) => e.details.subjectType === 'thermal_summary'],
    ['encounter.sign', () => true],
  ]
  expect(expected.filter(([a, where]) => !has(a, where)).map(([a]) => a), `audit actions: ${[...new Set(events.map((e) => e.action))].sort().join(', ')}`).toEqual([])
  const viewed = events.filter((e) => e.action === 'encounter.context_viewed')
  const serialized = JSON.stringify(viewed.map((e) => e.details))
  for (const value of ['penicillin', 'Sore throat', '98', '94', '131', 'Left knee']) expect(serialized.toLowerCase().includes(value.toLowerCase()), `the context audit holds “${value}”`).toBe(false)
  const all = JSON.stringify(events).toLowerCase()
  for (const text of ['I am allergic to penicillin', 'What was recorded in this consultation?', 'Acute pharyngitis (synthetic)']) expect(all.includes(text.toLowerCase()), `the audit log holds “${text}”`).toBe(false)
})

