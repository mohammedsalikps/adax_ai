import { type APIRequestContext, expect, type Locator, request as pwRequest, test } from '@playwright/test'
import { analyzeButton, DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, llmExclusive, nurseHandsOverPatient, openModule, signIn, stepTo, uniq } from './support.ts'

// The doctor hero journey of D1, the integrated consultation workspace (in its Doctor HERO layout: five input modules in a rail on the left,
// Mana and the record on the right), from sign-in to the signed record and its audit trail: one synthetic patient, one consultation.
// Everything is real (browser, API, database) except the stand-ins this suite always uses: the local model (e2e/mock-llm.mjs), the local
// speech service (e2e/mock-speech.mjs), Chromium's synthetic microphone, and a SIMULATOR device whose "gateway" is this test posting fixed
// numbers with the device record's token. None of them is a model, a speech recogniser or a device.

const LLM = 'http://127.0.0.1:8181'

async function llm(mode: 'ok' | 'slow' | 'down' | 'invalid' | 'inject' | 'empty') {
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

/** An administrator registers a simulator band and issues its gateway token; this test then posts with the token as a gateway would. */
async function registerSimulator(admin: APIRequestContext, baseURL: string, label: string) {
  const d = await (await admin.post('/api/admin/devices', { data: { kind: 'wearable_band', label, serialNumber: `E2E-${uniq()}`, integration: 'simulator' } })).json()
  const { token } = await (await admin.post(`/api/admin/devices/${d.id}/token`)).json()
  const gateway = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}`, 'x-adaxai-csrf': '1' } })
  return {
    id: d.id as string,
    heartbeat: () => gateway.post('/api/device-ingest/heartbeat', { data: {} }),
    send: (readings: { kind: string; value: number }[]) => gateway.post('/api/device-ingest/readings', { data: { measuredAt: new Date().toISOString(), readings } }),
    dispose: () => gateway.dispose(),
  }
}

/** Keeps the gateway doing something every `ms` until stopped. Every loop started is also stopped after the test, whatever happened. */
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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One stand-in model server whose mode is set here, and a viewport of its own: the desktop project only.
test.skip(({ isMobile }) => isMobile, 'desktop project only (shared model stand-in, synthetic microphone)')
// A long journey: one action that cannot happen fails within half a minute instead of using up the whole test's time.
test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 })
llmExclusive(test)
test.beforeEach(async () => llm('ok'))

/** The patient whose visit may still be open if the journey stops before signing: its draft is discarded and the visit cancelled, as history.spec does. */
let openPatient: string | null = null
test.afterEach(async ({ baseURL }) => {
  for (const stop of loops.splice(0)) await stop()
  await llm('ok')
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

type AuditRow = { id: number; action: string; outcome: string; actorRole: string | null; entityType: string | null; patientId: string | null; details: Record<string, unknown> }

test('the doctor hero: dashboard, today’s patients, the workspace (transcript, important points, AI draft, Mana, devices, stethoscope), signing, and the audit trail', async ({ page, baseURL }) => {
  test.setTimeout(420_000)
  const tools = page.getByTestId('consultation-tools')

  // ---- 0. The nurse has registered the patient, recorded consents (recording, devices, Mana), an allergy and vital signs, and handed over. ----
  const p = await nurseHandsOverPatient(baseURL!, { name: { given: `Hero${uniq()}`, family: 'Synthetic' }, allergies: ['Penicillin'], consents: ['ai_recording', 'device_monitoring', 'ai_record_assistant'] })
  openPatient = p.patientId

  // ---- 1. LOGIN: the doctor signs in and lands on the dashboard. ----
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, 'dr.meera')
  await expect(page).toHaveURL(/\/doctor$/)

  // ---- 2. DASHBOARD: the greeting, and the patient in today's schedule, ready for the doctor. ----
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Dr\. Meera$/ })).toBeVisible()
  const schedule = page.getByRole('region', { name: 'Today’s schedule' })
  await expect(schedule.getByRole('listitem').filter({ hasText: p.name })).toContainText('Ready for doctor')

  // ---- 3. TODAY'S PATIENTS: reached from the dashboard; the patient's row is there. ----
  await schedule.getByRole('link', { name: 'View all' }).click()
  await expect(page).toHaveURL(/\/doctor\/queue$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Today’s patients' })).toBeVisible()
  const row = page.getByRole('list', { name: 'Visits' }).getByRole('listitem').filter({ hasText: p.name })
  await expect(row).toContainText('Ready for doctor')
  await expect(row).toContainText(p.mrn)

  // ---- 4. OPEN PATIENT: the name opens the patient's record; back to the list, and the consultation starts from the row. ----
  await row.getByRole('link', { name: p.name }).click()
  await expect(page).toHaveURL(new RegExp(`/doctor/patients/${p.patientId}$`))
  await expect(page.getByRole('heading', { level: 1, name: p.name })).toBeAttached()
  await expect(page.locator('main')).toContainText(p.name)
  await expect(page.locator('main')).toContainText(p.mrn)
  await page.goBack()
  await expect(page).toHaveURL(/\/doctor\/queue$/)
  await row.getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}$/)
  const encounterId = /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!

  // ---- 5. HEADER: whose consultation, that it is in progress, the banner (MRN, allergy, reason for visit) and what the consultation relies on. ----
  const header = page.getByTestId('consultation-header')
  await expect(header.getByRole('heading', { level: 1, name: new RegExp(`^Consultation: ${escape(p.name)}`) })).toBeVisible()
  await expect(header).toContainText(/in progress/i)
  const banner = page.getByTestId('patient-banner')
  await expect(banner).toContainText(`MRN ${p.mrn}`)
  await expect(banner).toContainText('Allergy: Penicillin')
  await expect(banner.getByTestId('visit-reason')).toContainText('Reason for visit:')
  await expect(banner.getByTestId('visit-reason')).toContainText('“Sore throat and fever”')
  await expect(banner).not.toContainText('Urgent visit')
  // The chips: each appears once its panel has heard from its service (the model stand-in in "ok", the speech stand-in), and nothing is attached yet.
  await expect(header.getByTestId('model-status-chip')).toHaveText('Local AI ready', { timeout: 20_000 })
  await expect(header.getByTestId('speech-status-chip')).toHaveText('Speech-to-text ready', { timeout: 20_000 })
  const deviceChip = header.getByTestId('device-status-chip')
  await expect(deviceChip).toHaveAttribute('data-state', 'none', { timeout: 15_000 })
  await expect(deviceChip).toContainText('No device attached')
  // Two panes: the inputs rail on the left; on the right Mana, then the note under it (the right-hand side is not wide enough at these sizes
  // to put them side by side). Doctor HERO: inputs, then intelligence, then action; before it the note was the whole right-hand pane.
  const note = page.getByRole('region', { name: 'Consultation note' })
  const manaArea = page.getByTestId('mana-result')
  await expect(tools).toBeVisible()
  await expect(note).toBeVisible()
  await expect(manaArea).toBeVisible()
  const twoPanes = async (label: string) => {
    const t = (await tools.boundingBox())!
    const n = (await note.boundingBox())!
    const m = (await manaArea.boundingBox())!
    expect(n.x, `${label}: the note is right of the tools`).toBeGreaterThanOrEqual(t.x + t.width)
    expect(n.x + n.width, `${label}: the note fits the screen`).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5)
    expect(m.x, `${label}: Mana is right of the tools`).toBeGreaterThanOrEqual(t.x + t.width)
    expect(m.y + m.height, `${label}: Mana is above the note`).toBeLessThanOrEqual(n.y + 0.5)
    // "Analyze with Mana" is at the foot of the rail, on the screen without scrolling.
    await expect(analyzeButton(page)).toBeInViewport()
  }
  await twoPanes('1280x800')
  await expectNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(250)
  await expectNoHorizontalOverflow(page)
  await twoPanes('1024x768')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(250)
  await expectNoAxeViolations(page)

  // ---- 6. TRANSCRIPT: recorded from the synthetic microphone; the stand-in's timed lines appear; the doctor says who spoke. ----
  // The speech chip leads to the conversation (module 1), which it opens (the "Go to" bar it used to be reached by is gone: Doctor HERO).
  await header.getByTestId('speech-status-chip').click()
  await expect(page.locator('#tools-conversation')).toBeFocused()
  await expect(page.locator('#tools-conversation')).toHaveAttribute('data-open', 'true')
  const live = page.getByRole('region', { name: 'Live transcription' })
  await expect(live.getByTestId('recording-consent')).toContainText('recorded (ongoing)')
  // The speech service is named by its model id: here the TEST-ONLY stand-in, and it says it is not validated.
  await expect(live.getByTestId('speech-status')).toContainText('Speech-to-text runs on this computer (mock-speech-e2e)')
  await expect(live.getByTestId('speech-status')).toContainText('Not clinically validated.')
  await live.getByRole('button', { name: 'Start recording' }).click()
  const recState = live.getByTestId('recording-state')
  await expect(recState).toContainText('Recording')
  await expect(recState).toContainText(/00:0[3-9]/, { timeout: 15_000 })
  await live.getByRole('button', { name: 'Stop' }).click()
  await expect(live.getByRole('button', { name: 'Start recording' })).toBeVisible({ timeout: 20_000 })
  await expect(recState).toHaveCount(0)
  const lines = live.getByTestId('raw-transcript').getByTestId('transcript-line')
  await expect(lines).toHaveCount(5, { timeout: 20_000 })
  await expect(lines.nth(0)).toContainText('I have had a cough and a fever for three days.')
  await expect(lines.nth(1)).toContainText('I am allergic to penicillin.')
  // Each line says where it starts on the recording, as mm:ss.
  for (const i of [0, 1, 4]) await expect(lines.nth(i).locator('[title^="On the recording from"]')).toHaveText(/^\d{2}:\d{2}$/)
  // Nobody assigned yet; the doctor assigns Doctor to the first line and Patient to the second, from each line's speaker menu.
  await expect(lines.nth(0).getByRole('button', { name: /^Speaker of .*: not assigned\. Change$/ })).toBeVisible()
  await lines.nth(0).getByRole('button', { name: /^Speaker of .*Change$/ }).click()
  await page.getByRole('menuitem', { name: 'Doctor', exact: true }).click()
  await expect(lines.nth(0).getByRole('button', { name: /^Speaker of .*: Doctor\. Change$/ })).toBeVisible()
  await lines.nth(1).getByRole('button', { name: /^Speaker of .*Change$/ }).click()
  await page.getByRole('menuitem', { name: 'Patient', exact: true }).click()
  await expect(lines.nth(1).getByRole('button', { name: /^Speaker of .*: Patient\. Change$/ })).toBeVisible()
  await expect(lines.nth(0)).toContainText('Doctor')
  await expect(lines.nth(1)).toContainText('Patient')
  await expect(lines.nth(2).getByRole('button', { name: /^Speaker of .*: not assigned\. Change$/ })).toBeVisible()
  // The server holds the doctor's two assignments, and the words did not change.
  const ai = (await (await page.request.get(`/api/encounters/${encounterId}/ai`)).json()) as { transcripts: { segments: { text: string; speaker: string | null; speakerSource: string }[] }[] }
  const segs = ai.transcripts.at(-1)!.segments
  expect(segs.filter((s) => s.speakerSource === 'doctor_assigned').map((s) => `${s.speaker}: ${s.text}`)).toEqual(['Doctor: I have had a cough and a fever for three days.', 'Patient: I am allergic to penicillin.'])

  // ---- 7. IMPORTANT POINTS: drafted when the recording stopped, found again with the speakers known; the doctor confirms one. ----
  const points = page.getByRole('region', { name: 'Important points' })
  const drafts = points.getByRole('region', { name: 'Extracted drafts' })
  await expect(drafts.getByTestId('important-point').first()).toBeVisible({ timeout: 20_000 })
  await expect(points.getByRole('region', { name: 'Confirmed by the doctor' })).toHaveCount(0)
  // Found again now that two speakers are known: the drafts found at Stop are replaced by new ones (so the card is looked up after the answer).
  const extracted = page.waitForResponse((r) => /\/api\/transcripts\/[^/]+\/extract$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30_000 })
  await live.getByRole('button', { name: 'Find important points' }).first().click()
  expect((await extracted).ok()).toBe(true)
  const allergyPoint = drafts.locator('[data-testid="important-point"][data-category="allergy"]').filter({ hasText: 'Patient said' }).first()
  await expect(allergyPoint).toContainText(/penicillin/i, { timeout: 20_000 })
  await expect(allergyPoint).toHaveAttribute('data-state', 'extracted')
  await expect(allergyPoint.getByTestId('speaker-changed')).toHaveCount(0)
  const tick = allergyPoint.getByLabel('I have checked this against the conversation and the record')
  if (await tick.count()) await tick.check({ timeout: 10_000 })
  await allergyPoint.getByRole('button', { name: 'Confirm', exact: true }).click()
  const confirmedPoints = points.getByRole('region', { name: 'Confirmed by the doctor' }).getByTestId('important-point')
  await expect(confirmedPoints.first()).toHaveAttribute('data-state', 'confirmed')
  await expect(confirmedPoints.first()).toContainText('Doctor confirmed')
  await expect(confirmedPoints.first()).toContainText(/penicillin/i)
  const confirmedCount = await confirmedPoints.count()
  expect(confirmedCount).toBeGreaterThanOrEqual(1)

  // ---- 8. AI DRAFT: reached from the workflow strip ("Mana analysis", which replaced the "Go to" bar); asked for with "Analyze with Mana" at
  // the foot of the inputs rail (the result card has no button of its own any more); made from the record, the note and the confirmed points;
  // each statement decided by the doctor. ----
  await stepTo(page, 'Mana analysis')
  await expect(page.locator('#mana-result [data-part-focus="mana-result"]')).toBeFocused()
  const panel = page.getByTestId('consult-panel')
  await expect(panel).toBeInViewport()
  const status = panel.getByTestId('consult-status')
  await expect(status).toContainText('NOT RUN', { timeout: 20_000 })
  await expect(panel.getByTestId('consult-inputs')).toContainText(`the ${confirmedCount} important point${confirmedCount === 1 ? '' : 's'} you confirmed`)
  await expect(panel.getByTestId('consult-inputs')).toContainText('never from the raw transcript or the audio')
  // What the analysis will read, said beside the button before it is pressed: the points the doctor confirmed, never the stethoscope.
  const reads = page.getByTestId('analysis-inputs')
  await expect(reads.locator('li[data-input="conversation"]')).toHaveAttribute('data-included', 'true')
  await expect(reads.locator('li[data-input="conversation"]')).toContainText(`${confirmedCount} point${confirmedCount === 1 ? '' : 's'} you confirmed`)
  await expect(reads.locator('li[data-input="stethoscope"]')).toHaveAttribute('data-included', 'false')
  const clicked = Date.now()
  await analyzeButton(page).click()
  await expect(status).toContainText('READY FOR REVIEW', { timeout: 30_000 })
  // Measured on this run with the suite's model stand-in: a number about this test, not the product's speed.
  test.info().annotations.push({ type: 'timing', description: `Analyze with Mana to READY FOR REVIEW: ${Date.now() - clicked} ms (mock-llm stand-in, not a product timing)` })
  // The same click ran the fixed safety rules, and the analysis' steps say so.
  const rulesStep = page.locator('[data-testid="analysis-steps"] li[data-step="rules"]')
  await expect(rulesStep).toHaveAttribute('data-state', 'done')
  await expect(rulesStep).toContainText('safety-rules-v1')
  await expect(analyzeButton(page, 'Analyze again')).toBeEnabled()
  const statements = panel.getByTestId('consult-statement')
  await expect(statements.first()).toBeVisible()
  // Every statement carries a support state, in words and as data.
  await expect(statements.first()).toHaveAttribute('data-support', /^(supported|inferred|not_found|conflicting|outdated)$/)
  await expect(panel.locator('[data-testid="consult-statement"][data-support="supported"]').first()).toContainText('SUPPORTED BY RECORD')
  const ack = async (s: Locator) => {
    const box = s.getByLabel('I have checked this against the record')
    if (await box.count()) await box.check({ timeout: 10_000 })
  }
  // Accept one.
  const accepted = panel.locator('[data-testid="consult-statement"][data-section="presenting_problem"]').first()
  await expect(accepted).toContainText('Sore throat and fever')
  await ack(accepted)
  await accepted.getByRole('button', { name: 'Accept' }).click()
  await expect(accepted).toHaveAttribute('data-decision', 'accepted')
  // Edit one (its text changes) and accept it.
  const edited = panel.locator('[data-testid="consult-statement"][data-section="observations"]').first()
  const editedText = 'Edited by the doctor (synthetic): febrile at the visit, pulse slightly fast.'
  await edited.getByRole('button', { name: 'Edit' }).click()
  await edited.getByLabel('Edit before accepting').fill(editedText)
  await ack(edited)
  await edited.getByRole('button', { name: 'Save edited text' }).click()
  await expect(edited).toHaveAttribute('data-decision', 'edited')
  await expect(edited).toContainText(editedText)
  // Reject one: it can no longer go into the note.
  const rejected = panel.locator('[data-testid="consult-statement"][data-section="potential_considerations"]').first()
  await rejected.getByRole('button', { name: 'Reject' }).click()
  await expect(rejected).toHaveAttribute('data-decision', 'rejected')
  await expect(rejected.getByRole('button', { name: 'Add to note' })).toHaveCount(0)
  // Deciding wrote nothing to the note. Adding the accepted statement is a separate act, and the section then says where its text came from.
  const hpi = page.getByLabel('History of present illness')
  const exam = page.getByLabel('Examination', { exact: true })
  await expect(hpi).toHaveValue('')
  await expect(exam).toHaveValue('')
  await expect(note.getByLabel('AI-assisted text in this section')).toHaveCount(0)
  await accepted.getByLabel('Add to note section').selectOption('history')
  await accepted.getByRole('button', { name: 'Add to note' }).click()
  await expect(accepted).toContainText('In the note', { timeout: 15_000 })
  await expect(hpi).toHaveValue(/Sore throat and fever/)
  const insertedText = (await hpi.inputValue()).trim()
  await expect(note.getByLabel('AI-assisted text in this section')).toHaveCount(1)
  await expect(note.getByLabel('AI-assisted text in this section')).toContainText('AI-assisted text from consultation draft statement')
  // The edited one too, into the examination.
  await edited.getByLabel('Add to note section').selectOption('examination')
  await edited.getByRole('button', { name: 'Add to note' }).click()
  await expect(edited).toContainText('In the note', { timeout: 15_000 })
  await expect(exam).toHaveValue(editedText)
  await expect(note.getByLabel('AI-assisted text in this section')).toHaveCount(2)
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 15_000 })
  // The AI wrote no diagnosis and no prescription.
  await expect(page.getByRole('region', { name: 'Diagnosis', exact: true })).toContainText('No diagnosis yet.')
  await expect(page.getByRole('region', { name: 'Prescription', exact: true })).toContainText('No medicines prescribed.')

  // ---- 9. MANA: Ask Mana, the last block of the Mana area (no longer a part of the tools column with a "Go to" button: Doctor HERO); asked
  // about the patient; it answers from the record, with sources, and cannot write to the note. Analyzing did not open it. ----
  const mana = page.locator('#mana-result #mana-chat').getByTestId('mana-assistant')
  await mana.scrollIntoViewIfNeeded()
  await expect(mana).toBeInViewport()
  await expect(mana).toHaveAttribute('data-open', 'false')
  await mana.getByTestId('mana-toggle').click()
  await expect(mana.getByTestId('mana-context')).toContainText(p.name)
  const manaQuestion = 'What allergies are recorded for this patient?'
  await mana.getByTestId('mana-input').fill(manaQuestion)
  await mana.getByTestId('mana-send').click()
  const answer = mana.getByTestId('mana-message').last()
  await expect(answer.getByTestId('mana-answer')).toBeVisible({ timeout: 30_000 })
  await expect(answer).toContainText('Penicillin')
  await expect(answer.getByTestId('mana-subjects')).toContainText(`About ${p.name}`)
  const chip = answer.getByTestId('mana-source-chip').first()
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(answer.getByTestId(/^mana-source-S\d+$/).first()).toContainText('Penicillin')
  await expect(mana.getByRole('button', { name: /add to note/i })).toHaveCount(0)
  await expect(mana).not.toContainText('Add to note')

  // ---- 10. DEVICES: a SIMULATOR band is registered by an administrator, attached here, and its values are watched going live, stale, disconnected. ----
  const admin = await staff(baseURL!, 'admin')
  const simLabel = `Simulator band ${uniq()}`
  const sim = await registerSimulator(admin, baseURL!, simLabel)
  // The device chip leads to the devices (module 3, "Health band & vitals"), which it opens (it used to be reached by the "Go to" bar).
  await deviceChip.click()
  await expect(page.locator('#tools-devices')).toBeFocused()
  await expect(page.locator('#tools-devices')).toHaveAttribute('data-open', 'true')
  const card = page.getByTestId('device-readings')
  await expect(card.getByTestId('device-none')).toContainText('No device is attached to this patient.')
  await card.getByRole('button', { name: 'Attach a device' }).click()
  const dlg = page.getByRole('dialog', { name: 'Attach a device' })
  const option = dlg.locator('option', { hasText: simLabel })
  await expect(option).toBeAttached()
  await dlg.getByLabel('Device').selectOption((await option.getAttribute('value'))!)
  await expect(dlg.getByText('This is a simulator, not a device.')).toBeVisible()
  await dlg.getByRole('button', { name: 'Attach' }).click()
  await expect(dlg).toBeHidden()
  const attached = card.getByTestId('attached-device')
  await expect(attached).toHaveAttribute('data-simulated', 'true')
  await expect(attached.getByTestId('simulated-badge')).toHaveText('SIMULATED')
  const heartRate = attached.locator('[data-testid="device-reading"][data-kind="heart_rate"]')
  let stopSending = every(2000, () => sim.send([{ kind: 'heart_rate', value: 131 }, { kind: 'spo2', value: 97 }]))
  await expect(attached).toHaveAttribute('data-state', 'live', { timeout: 20_000 })
  await expect(attached.getByTestId('reading-state').first()).toHaveText('LIVE')
  await expect(heartRate).toContainText('131')
  await expect(heartRate).toContainText('Simulated · not a measurement')
  // The header's chip says the same, with the SIMULATED mark.
  await expect(deviceChip).toHaveAttribute('data-state', 'live')
  await expect(deviceChip).toContainText('Device live')
  await expect(deviceChip.getByTestId('simulated-badge')).toHaveText('SIMULATED')
  // The visit's own vital signs are what the nurse measured (heart rate 92): the simulator's 131 is not among them, after a reload either.
  await page.reload()
  // What a jump opened is not remembered (only the doctor's own "Show" is): after the reload the module is closed again, and is opened.
  await expect(page.locator('#tools-devices')).toHaveAttribute('data-open', 'false')
  await openModule(page, 'Vitals')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('vitals-tiles')).toContainText('92')
  await expect(page.getByTestId('vitals-tiles')).not.toContainText('131')
  await expect(banner).not.toContainText('131')
  await expect(attached).toHaveAttribute('data-state', 'live', { timeout: 20_000 })
  await stopSending()
  // The gateway stays in contact and sends nothing more: stale.
  stopSending = every(2500, () => sim.heartbeat())
  await expect(attached).toHaveAttribute('data-state', 'stale', { timeout: 25_000 })
  await expect(attached.getByTestId('reading-state').first()).toHaveText('STALE')
  await expect(deviceChip).toHaveAttribute('data-state', 'stale')
  await stopSending()
  // Silence: disconnected, and the consultation card says so first.
  await expect(attached).toHaveAttribute('data-state', 'disconnected', { timeout: 30_000 })
  await expect(attached.getByTestId('device-reason')).toHaveText(/^Device not connected\./)
  await expect(deviceChip).toHaveAttribute('data-state', 'disconnected')
  await sim.dispose()

  // ---- 11. STETHOSCOPE: recorded in the browser from an audio input (Chromium's synthetic one), kept with this consultation, not analysed. ----
  // Module 4 since Doctor HERO (it shared the devices' part before): opened, and its summary already says that it is not analysed.
  const stethoscope = await openModule(page, 'Stethoscope')
  await expect(stethoscope.getByTestId('summary-stethoscope-honesty')).toContainText('Recorded, not analysed.')
  const recordings = page.getByRole('region', { name: 'Stethoscope recordings' })
  await expect(recordings).toContainText('No recording available.')
  await recordings.getByRole('button', { name: 'Record', exact: true }).click()
  const rec = page.getByRole('dialog', { name: 'Record from an audio input' })
  await rec.getByRole('button', { name: 'Start recording' }).click()
  await expect(rec.getByTestId('auscultation-recording')).toContainText('Recording…')
  await page.waitForTimeout(2000)
  await rec.getByRole('button', { name: 'Stop' }).click()
  await expect(rec.getByText(/Recorded \d+\.\d s\. Listen before saving:/)).toBeVisible()
  await rec.getByRole('button', { name: 'Save recording' }).click()
  await expect(rec).toBeHidden({ timeout: 15_000 })
  const recording = recordings.locator('[data-testid="auscultation"][data-capture="browser_recording"]')
  await expect(recording).toHaveCount(1)
  await expect(recordings).not.toContainText('No recording available.')
  await expect(recording.getByTestId('auscultation-capture')).toContainText('Recorded in the browser')
  await expect(recording).toContainText(/\d{1,2}:\d{2}\s?(am|pm)/i)
  await expect(recording.getByTestId('auscultation-this-consultation')).toHaveText('This consultation')
  await expect(recording.locator('audio')).toHaveAttribute('src', /^\/api\/files\//)
  // The recording's waveform is captioned "Amplitude of the recording. Not an analysis." (Doctor HERO final pass): that disclaimer is the one
  // place the word may appear; apart from it the recording claims no analysis and no finding.
  await expect(recording.getByTestId('waveform')).toContainText('Amplitude of the recording. Not an analysis.')
  expect(((await recording.textContent()) ?? '').replace('Amplitude of the recording. Not an analysis.', '')).not.toMatch(/analys|murmur|abnormal|finding/i)
  // The module's summary counts it, from the same records.
  await expect(stethoscope.getByTestId('summary-stethoscope')).toContainText('1 recording in this consultation')

  // ---- 12. FINALIZE: a diagnosis typed by the doctor, review and sign; the page becomes the signed record, with the AI-assisted text and its source. ----
  await page.getByRole('button', { name: 'Add diagnosis' }).click()
  await page.getByLabel('Diagnosis 1', { exact: true }).fill('Acute pharyngitis (synthetic)')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 15_000 })
  await page.getByTestId('consultation-actions').getByRole('button', { name: 'Complete consultation' }).click()
  const review = page.getByRole('dialog', { name: 'Review and sign' })
  await expect(review).toContainText('Acute pharyngitis (synthetic)')
  await expect(review).toContainText('AI-assisted text in this note')
  await expect(review).toContainText('consultation draft statement')
  await expect(review.getByRole('button', { name: 'Sign and complete' })).toBeDisabled()
  await review.getByLabel(/I have reviewed this record/).check()
  await review.getByRole('button', { name: 'Sign and complete' }).click()
  await expect(page.getByText(/^Signed /)).toBeVisible({ timeout: 15_000 })
  openPatient = null
  await expect(page.getByLabel('History of present illness')).toHaveCount(0)
  const signedNote = page.getByRole('region', { name: 'Consultation note' })
  await expect(signedNote).toContainText(insertedText)
  await expect(signedNote).toContainText(editedText)
  const provenance = page.getByRole('region', { name: 'AI-assisted text', exact: true })
  await expect(provenance).toContainText('History of present illness: AI-assisted text from consultation draft statement')
  await expect(provenance).toContainText('Examination: AI-assisted text from consultation draft statement')
  const history = page.getByRole('region', { name: 'Status history' })
  await history.getByRole('button', { name: 'Show' }).click()
  await expect(history.getByRole('list', { name: 'Status changes' })).toContainText('Consultation signed')

  // ---- 13. AUDIT: the journey is in the patient's audit trail, by action, and no clinical free text is in it. ----
  const events: AuditRow[] = []
  for (let before: number | null = null, pages = 0; pages < 20; pages++) {
    const res = await admin.get('/api/admin/audit-events', { params: { patientId: p.patientId, limit: 200, ...(before !== null && { before }) } })
    expect(res.ok(), await res.text()).toBe(true)
    const page_ = (await res.json()) as { events: AuditRow[]; nextBefore: number | null }
    events.push(...page_.events)
    if (page_.nextBefore === null) break
    before = page_.nextBefore
  }
  await admin.dispose()
  const actions = new Set(events.map((e) => e.action))
  const ok = (e: AuditRow) => e.outcome === 'success'
  const has = (action: string, where: (e: AuditRow) => boolean = () => true) => events.some((e) => e.action === action && ok(e) && where(e))
  const expected: [string, (e: AuditRow) => boolean][] = [
    ['encounter.start', () => true],
    ['ai.live_start', () => true],
    ['ai.audio_chunk', () => true],
    ['ai.transcription', () => true],
    ['ai.live_end', (e) => e.details.reason === 'doctor_stopped'],
    ['ai.speaker_assign', () => true],
    ['ai.extraction', () => true],
    ['ai.review', (e) => e.details.type === 'fact' && e.details.decision === 'accepted'],
    ['ai.consultation_draft_requested', () => true],
    // "Analyze with Mana" also ran the fixed safety rules.
    ['ai.safety_check', () => true],
    ['ai.consultation_draft', (e) => e.details.insufficient === false],
    ['ai.consultation_review', (e) => e.details.decision === 'accepted'],
    ['ai.consultation_review', (e) => e.details.decision === 'edited'],
    ['ai.consultation_review', (e) => e.details.decision === 'rejected'],
    ['encounter.ai_insert', (e) => e.details.subjectType === 'consultation_item' && e.details.section === 'history'],
    ['encounter.ai_insert', (e) => e.details.subjectType === 'consultation_item' && e.details.section === 'examination'],
    ['mana.question_asked', () => true],
    ['mana.answer', () => true],
    ['device.assign', (e) => e.details.simulated === true],
    ['device.ingest', (e) => e.actorRole === 'device' && e.details.simulated === true],
    ['auscultation.upload', (e) => e.details.captureMethod === 'browser_recording'],
    ['encounter.sign', () => true],
  ]
  const missing = expected.filter(([a, where]) => !has(a, where)).map(([a]) => a)
  expect(missing, `audit actions present: ${[...actions].sort().join(', ')}`).toEqual([])
  // No clinical free text: not the transcript's lines, the inserted or edited statements, the Mana question, or the diagnosis.
  const serialized = JSON.stringify(events).toLowerCase()
  for (const text of ['I am allergic to penicillin', 'I have had a cough and a fever for three days', insertedText, editedText, manaQuestion, 'Acute pharyngitis (synthetic)']) {
    expect(serialized.includes(text.toLowerCase()), `the audit log holds the free text “${text}”`).toBe(false)
  }
})
