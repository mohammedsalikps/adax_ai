import { type APIRequestContext, expect, type Page, request as pwRequest, test } from '@playwright/test'
import { DEMO_PASSWORD, expectNoHorizontalOverflow, llmExclusive, nurseHandsOverPatient, signIn, uniq } from './support.ts'

// The final Doctor HERO journey (the owner's master specification §34 and §17A–E), end to end in a real browser against the real API and
// database: Home (Today / Week / Month from the server's counts) → My consultations → Start consultation → recording starts by itself →
// live transcription → important points found by the fixed rules → clinical inputs, patient history, the digital pen → Mana (a fixed-rule
// answer) → Generate prescription → the prescription page → the doctor edits, adds a statement to the note, prescribes → Sign & print (which
// does NOT complete) → Complete consultation → My consultations shows Completed → the record, the audit trail and the patient app.
// The stand-ins this suite always uses: the local model (e2e/mock-llm.mjs), the local speech service (e2e/mock-speech.mjs) and Chromium's
// synthetic microphone. None of them is a model, a recogniser or a device; nothing here is a claim about model quality.

const LLM = 'http://127.0.0.1:8181'

async function llm(mode: 'ok' | 'down') {
  const r = await pwRequest.newContext()
  try {
    expect((await r.post(`${LLM}/__mode`, { data: { mode } })).ok()).toBe(true)
  } finally {
    await r.dispose()
  }
}

async function staff(baseURL: string, username: string): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username, password: DEMO_PASSWORD } })).ok()).toBe(true)
  return api
}

/** A row of a doctor's list (Home's "Today's patients" or My consultations' "Visits"): the list item holding the patient's name. */
const rowOf = (page: Page, list: string, name: string) => page.getByRole('list', { name: list }).getByRole('listitem').filter({ hasText: name })

test.skip(({ isMobile }) => isMobile, 'desktop project (synthetic microphone; the phone layout is checked at the end by size)')
llmExclusive(test)
test.beforeEach(async () => llm('ok'))

test('the final Doctor HERO journey: Home → My consultations → Start (recording starts) → five inputs → Mana → Generate prescription → prescription page → Sign & print → Complete → patient app', async ({ page, baseURL, context }) => {
  test.setTimeout(420_000)
  const p = await nurseHandsOverPatient(baseURL!, { allergies: ['Penicillin'], consents: ['ai_recording', 'portal_access', 'ai_record_assistant'] })
  const nurse = await staff(baseURL!, 'nurse.anil')
  const admin = await staff(baseURL!, 'admin')

  // ---- 1. HOME: Today / Week / Month, every number the server's. ----
  await signIn(page, 'dr.meera')
  await expect(page).toHaveURL(/\/doctor$/)
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Dr\./ })).toBeVisible()
  // No development banner across the application (spec §1); the doctor's navigation is four items (spec §2).
  await expect(page.getByText(/^Development build\./)).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: 'Doctor navigation' })
  await expect(nav.getByRole('link')).toHaveText([/Home/, /My consultations/i, /Patients/, /Thermal/])
  const period = page.getByRole('group', { name: /Period/ })
  for (const which of ['today', 'week', 'month'] as const) {
    await period.getByRole('button', { name: new RegExp(`^${which}$`, 'i') }).click()
    await expect(page).toHaveURL(new RegExp(which === 'today' ? '/doctor(\\?period=today)?$' : `period=${which}`))
    const day = await (await page.request.get(`/api/doctor/day?period=${which}`)).json()
    await expect(page.getByTestId('day-seen')).toContainText(String(day.counts.seen))
    if (which === 'today') {
      await expect(page.getByTestId('day-waiting')).toContainText(String(day.counts.waiting))
      await expect(page.getByTestId('day-total')).toContainText(String(day.counts.total))
    } else {
      await expect(page.getByTestId('day-consultations')).toContainText(String(day.counts.consultations))
      await expect(page.getByTestId('doctor-day-trend')).toBeVisible()
    }
  }
  await period.getByRole('button', { name: /^today$/i }).click()
  await expect(rowOf(page, 'Today’s patients', p.name)).toContainText('Waiting')

  // ---- 2. MY CONSULTATIONS: today's queue, chronological, Start consultation is the main action. ----
  await nav.getByRole('link', { name: /My consultations/i }).click()
  await expect(page).toHaveURL(/\/doctor\/queue$/)
  await expect(page.getByRole('heading', { level: 1, name: 'My consultations' })).toBeVisible()
  const row = rowOf(page, 'Visits', p.name)
  await expect(row).toContainText('Waiting')
  await row.getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}$/)
  const encounterId = /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!
  const ws = page.getByTestId('consultation-workspace')
  await expect(ws).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(p.name)

  // ---- 3. INPUT 1, LIVE TRANSCRIPTION: recording began with Start (the patient's recording consent is on record). ----
  const live = page.getByTestId('live-transcription')
  await expect(page.getByTestId('recording-state').first()).toContainText(/Recording/, { timeout: 20_000 })
  // The first 10-second part reaches the stand-in speech service and comes back as lines; no speaker is identified by any model.
  await expect(live.getByTestId('transcript-line').first()).toBeVisible({ timeout: 60_000 })
  await expect(live).not.toContainText(/Doctor:|Patient:/)
  // Important points are found by the fixed rules after a part, without a click, and wait for the doctor (never auto-confirmed).
  await expect(live.getByTestId('important-point').first()).toBeVisible({ timeout: 60_000 })
  await expect(live.getByTestId('important-point').first()).toHaveAttribute('data-state', /extracted|pending/)

  // ---- 4. INPUTS 2 and 3, CLINICAL INPUTS and STETHOSCOPE: the nurse's measurements, honestly labelled; no sound analysis. ----
  const inputs = page.locator('#tools-devices')
  await expect(inputs).toContainText('38.2')
  await expect(inputs).toContainText('92')
  await expect(inputs).toContainText(/Staff/)
  await expect(page.getByText('No clinical sound analysis: recordings are not analysed by any model.')).toBeVisible()

  // ---- PATIENT HISTORY inside the consultation: compact, from the record. ----
  await expect(page.locator('#tools-history')).toContainText('Penicillin')

  // ---- INPUT 4, DIGITAL NOTES: the pen writes and the strokes are saved by themselves. ----
  const notes = page.getByTestId('doctor-notes')
  // Jury polish: the typed note (Keyboard) is the default tab; the pen is the "Handwriting" tab beside it.
  await notes.getByRole('tab', { name: /Handwriting/ }).click()
  const surface = notes.getByTestId('handwriting-surface')
  await expect(surface).toBeVisible()
  // The pad is taller than the screen: the pointer is brought onto the writing surface itself (scrolled into view, not under the sticky header
  // or the bottom bar) before the stroke starts, and the stroke is drawn from where the surface then is.
  await surface.hover({ position: { x: 60, y: 80 } })
  const box = (await surface.boundingBox())!
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 60 + i * 18, box.y + 80 + (i % 3) * 10, { steps: 2 })
  await page.mouse.up()
  await expect(notes.getByTestId('handwriting-save-state')).toContainText(/Saved/, { timeout: 20_000 })
  const ink = await (await page.request.get(`/api/encounters/${encounterId}/handwriting`)).json()
  expect(ink.version).toBeGreaterThanOrEqual(1)
  expect(ink.strokeCount).toBeGreaterThanOrEqual(1)
  // Typed notes too (the Keyboard tab keeps the note's sections).
  await notes.getByRole('tab', { name: /Keyboard/ }).click()
  await page.getByLabel('History of present illness').fill('Sore throat and fever for two days (synthetic).')

  // ---- MANA, persistently available: a deterministic question answered from the records by fixed rules (no model). ----
  await page.getByTestId('mana-launcher').click()
  const sheet = page.getByTestId('mana-sheet')
  await expect(sheet.getByTestId('mana-assistant')).toBeVisible()
  await sheet.getByTestId('mana-input').fill('How many patients have I seen today?')
  await sheet.getByTestId('mana-send').click()
  const answer = sheet.getByTestId('mana-message').last()
  await expect(answer).toContainText('From the records (fixed rules)', { timeout: 30_000 })
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // ---- GENERATE PRESCRIPTION: one primary action; the checklist reflects real steps; the prescription page opens when the draft is ready. ----
  const generate = page.getByTestId('analyze-mana')
  await expect(generate).toHaveText(/Analyze & Generate Prescription/)
  await generate.click()
  const preparing = page.getByTestId('preparing-consultation')
  await expect(preparing).toBeVisible()
  await expect(preparing.getByTestId('preparing-line').first()).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/doctor/encounters/${encounterId}/prescription$`), { timeout: 90_000 })

  // ---- PRESCRIPTION PAGE: clinical summary left (AI DRAFT, the doctor decides), the prescription right. ----
  // It opens its editor only once the workspace's last save is stored and the consultation read again ("Opening the latest version…"),
  // which can take a few seconds on a loaded machine.
  const rx = page.getByTestId('prescription-page')
  await expect(rx).toBeVisible({ timeout: 20_000 })
  const summary = page.getByTestId('clinical-summary')
  await expect(summary).toContainText('Penicillin')
  // The button's accessible name also says where the text goes ("Add to note (History of present illness)"), and once added the statement
  // has no such button any more: it is found again by its own words (data-state in_note, "In the note").
  const addToNote = page.getByRole('button', { name: /^Add to note\b/ })
  const statement = summary.getByTestId('rx-statement').filter({ has: addToNote }).first()
  await expect(statement).toBeVisible({ timeout: 60_000 })
  await expect(statement).toContainText(/AI DRAFT/)
  const words = (await statement.locator('p').first().innerText()).trim()
  expect(words.length).toBeGreaterThan(0)
  const tick = statement.getByLabel('I have checked this against the record')
  if (await tick.count()) await tick.check()
  await statement.getByRole('button', { name: /^Add to note\b/ }).click()
  const added = summary.locator('[data-testid="rx-statement"][data-state="in_note"]').filter({ hasText: words })
  await expect(added.first()).toContainText('In the note', { timeout: 15_000 })
  // The doctor's act is recorded on the consultation: the inserted text, with the statement it came from.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/encounters/${encounterId}`)).json()).aiInsertions as unknown[]).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)

  const doc = page.getByTestId('prescription-document')
  await doc.getByRole('button', { name: 'Add diagnosis' }).click()
  await doc.getByLabel('Diagnosis 1', { exact: true }).fill('Acute pharyngitis (synthetic)')
  await doc.getByRole('button', { name: 'Add medicine' }).click()
  const meds = doc.getByTestId('rx-medicines')
  await meds.getByLabel('Medicine', { exact: true }).last().fill('Paracetamol')
  await meds.getByLabel('Dose', { exact: true }).last().fill('500 mg')
  await meds.getByLabel('Frequency', { exact: true }).last().fill('Three times a day')
  await meds.getByLabel('Duration', { exact: true }).last().fill('5 days')
  await meds.getByLabel('Duration', { exact: true }).last().blur()
  await expect(meds.getByTestId('rx-course').last()).toContainText(/5 days from/)
  await doc.getByLabel('Advice / diet').fill('Warm fluids, rest (synthetic).')
  await expect(page.getByTestId('save-state')).toContainText(/Saved/, { timeout: 20_000 })

  // ---- SIGN & PRINT: the doctor signs; the print page opens; printing does NOT complete the consultation. ----
  await page.getByTestId('sign-and-print').click()
  const review = page.getByRole('dialog', { name: /Review and sign/ })
  await expect(review).toBeVisible()
  await review.getByLabel(/I have reviewed this record/).check()
  const [printPage] = await Promise.all([context.waitForEvent('page', { timeout: 30_000 }), review.getByRole('button', { name: 'Sign', exact: true }).click()])
  await printPage.waitForLoadState()
  await expect(printPage.getByRole('note').first()).toContainText('not a valid prescription')
  await expect(printPage.locator('main, body').first()).toContainText('Paracetamol')
  await printPage.close()
  await expect(page.getByTestId('prescription-signed')).toBeVisible({ timeout: 20_000 })
  const signed = await (await page.request.get(`/api/encounters/${encounterId}`)).json()
  expect(signed.status).toBe('signed')
  expect(signed.visit.status).toBe('in_consultation')
  expect(signed.canComplete).toBe(true)
  const item = signed.prescription.find((x: { drugName: string }) => x.drugName === 'Paracetamol')
  expect(item.durationDays).toBe(5)
  expect(item.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  // ---- COMPLETE CONSULTATION: a separate, explicit act with a confirmation; then back to My consultations, marked Completed. ----
  await page.getByTestId('complete-consultation').click()
  const confirm = page.getByRole('dialog', { name: 'Complete this consultation?' })
  await confirm.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(page).toHaveURL(/\/doctor\/queue$/, { timeout: 20_000 })
  await expect(page.getByText(/Consultation completed/)).toBeVisible()
  await expect(rowOf(page, 'Visits', p.name)).toContainText('Completed')
  const done = await (await page.request.get(`/api/encounters/${encounterId}`)).json()
  expect(done.visit.status).toBe('completed')
  expect(done.completedAt).toBeTruthy()
  expect(done.canComplete).toBe(false)

  // ---- AUDIT: the acts are in the patient's audit trail; no clinical free text in it. ----
  const events: { action: string; outcome: string; details: Record<string, unknown> }[] = []
  for (let before: number | null = null, n = 0; n < 20; n++) {
    const res = await admin.get('/api/admin/audit-events', { params: { patientId: p.patientId, limit: 200, ...(before !== null && { before }) } })
    expect(res.ok(), await res.text()).toBe(true)
    const pg = (await res.json()) as { events: typeof events; nextBefore: number | null }
    events.push(...pg.events)
    if (pg.nextBefore === null) break
    before = pg.nextBefore
  }
  const actions = new Set(events.filter((e) => e.outcome === 'success').map((e) => e.action))
  for (const a of ['encounter.start', 'ai.live_start', 'ai.audio_chunk', 'ai.extraction', 'encounter.handwriting_save', 'ai.consultation_draft_requested', 'encounter.sign', 'encounter.complete']) expect(actions.has(a), `audit has ${a}: ${[...actions].sort().join(', ')}`).toBe(true)
  const serialized = JSON.stringify(events).toLowerCase()
  for (const text of ['sore throat and fever for two days', 'warm fluids', 'acute pharyngitis']) expect(serialized.includes(text), `audit holds “${text}”`).toBe(false)

  // ---- PATIENT APP: the same canonical record — today's prescription with its course. ----
  const code = (await (await nurse.post(`/api/patients/${p.patientId}/portal-activation`)).json()).activationCode as string
  await nurse.dispose()
  await admin.dispose()
  const patient = await context.browser()!.newContext({ baseURL })
  const pp = await patient.newPage()
  await pp.goto('/activate')
  await pp.getByLabel('MRN').fill(p.mrn)
  await pp.getByLabel('Activation code').fill(code)
  await pp.getByLabel('Choose a password').fill(`Synthetic-portal-${uniq()}`)
  await pp.getByLabel(/I understand this portal shows my own records/).check()
  await pp.getByRole('button', { name: /Activate/ }).click()
  await expect(pp).toHaveURL(/\/patient$/)
  const today = pp.getByTestId('portal-current-prescription')
  await expect(today).toContainText('Today’s prescription')
  await expect(today).toContainText('Paracetamol')
  await expect(today).toContainText('Acute pharyngitis (synthetic)')
  await expect(today).toContainText('Warm fluids, rest (synthetic).')
  await expect(today.getByTestId('portal-course').first()).toContainText(/Day 1 of 5/)
  await patient.close()
})

test('the doctor app holds together at the specification sizes: Home, My consultations, the workspace and the prescription page, without horizontal overflow', async ({ page, baseURL }) => {
  test.setTimeout(240_000)
  const p = await nurseHandsOverPatient(baseURL!, { consents: ['ai_recording'] })
  await signIn(page, 'dr.meera')
  await page.goto('/doctor/queue')
  await rowOf(page, 'Visits', p.name).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}$/)
  const encounterUrl = new URL(page.url()).pathname
  await expect(page.getByTestId('consultation-workspace')).toBeVisible()
  for (const size of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 1180, height: 820 },
    { width: 768, height: 1024 },
    // The phone size of the specification (DESIGN §8), so the phone layout is checked too.
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    for (const path of ['/doctor', '/doctor/queue', encounterUrl, `${encounterUrl}/prescription`]) {
      await page.goto(path)
      await expect(page.locator('main')).toBeVisible()
      await expectNoHorizontalOverflow(page)
    }
    // In the workspace the one primary action stays on screen.
    await page.goto(encounterUrl)
    await expect(page.getByTestId('analyze-mana')).toBeInViewport()
  }
})
