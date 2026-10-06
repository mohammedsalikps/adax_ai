import { expect, type Page, request as pwRequest, test } from '@playwright/test'
import { DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, openModule, openMoreTools, signIn } from './support.ts'

// Live consultation capture, end to end: real browser (Chromium's synthetic microphone), real API, and the TEST-ONLY
// stand-in for the local speech service (e2e/mock-speech.mjs: a fixed synthetic script, no model, loopback only).
// What this proves is the plumbing and the review rules, not speech recognition: the transcription quality of the real
// model is measured separately (docs/safety/AI_MODELS.md). The patient is synthetic.

const APP_ORIGIN = 'http://127.0.0.1:5273'
const HOSTED_MOCK = 'http://127.0.0.1:4199'

/** What the mock hosted provider has been sent (counts only). */
async function hostedCalls() {
  const r = await pwRequest.newContext()
  try {
    return (await (await r.get(`${HOSTED_MOCK}/__calls`)).json()) as { calls: number; fromCapture: number }
  } finally {
    await r.dispose()
  }
}

async function startConsultation(page: Page, baseURL: string, opts: Parameters<typeof nurseHandsOverPatient>[1] = {}) {
  const p = await nurseHandsOverPatient(baseURL, opts)
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}/)
  const encounterId = /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!
  // Live transcription and the important points are module 1 of the inputs rail (Doctor HERO), which starts closed: opened, as the doctor
  // would (and remembered, so it stays open after a reload).
  await openModule(page, 'Conversation')
  return { ...p, encounterId }
}

type AiView = {
  consent: { granted: boolean }
  transcripts: { id: string; status: string; endReason: string | null; segments: { id: string; text: string; startMs: number | null; endMs: number | null; speaker: string | null; speakerSource: string }[] }[]
  facts: { id: string; status: string; category: string; text: string; sourceSegmentIds: string[] }[]
}
const aiView = async (page: Page, encounterId: string) => (await (await page.request.get(`/api/encounters/${encounterId}/ai`)).json()) as AiView

/** The nurse withdraws the patient's recording consent (the ongoing one), as at the front desk. */
async function withdrawRecordingConsent(baseURL: string, patientId: string) {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username: 'nurse.anil', password: DEMO_PASSWORD } })).ok()).toBe(true)
  const detail = await (await api.get(`/api/patients/${patientId}`)).json()
  const granted = detail.consents.find((c: { type: string; status: string }) => c.type === 'ai_recording' && c.status === 'granted')
  expect(granted, 'an active recording consent').toBeTruthy()
  expect((await api.post(`/api/patients/${patientId}/consents/${granted.id}/withdraw`, { data: { reason: 'e2e: patient changed their mind' } })).ok()).toBe(true)
  await api.dispose()
}

test('recording needs the patient’s consent first; with it, the local service is named and recording is offered', async ({ page, baseURL }) => {
  const p = await startConsultation(page, baseURL!)
  const live = page.getByRole('region', { name: 'Live transcription' })
  await expect(live.getByTestId('recording-consent')).toContainText('The patient’s consent to recording is needed')
  await expect(live.getByTestId('speech-status')).toContainText('Speech-to-text runs on this computer (mock-speech-e2e)')
  await expect(live.getByRole('button', { name: 'Start recording' })).toHaveCount(0)

  // The server refuses too: a recording cannot be opened without consent, whatever the screen shows.
  const refused = await page.request.post(`/api/encounters/${p.encounterId}/live-transcripts`, { headers: { 'x-adaxai-csrf': '1' } })
  expect(refused.status()).toBe(409)
  expect(await refused.text()).toContain('consent')
  expect((await aiView(page, p.encounterId)).transcripts).toHaveLength(0)

  await live.getByRole('button', { name: 'Patient agrees (verbal)' }).click()
  await expect(live.getByTestId('recording-consent')).toContainText('Recording consent recorded for this consultation')
  await expect(live.getByRole('button', { name: 'Start recording' })).toBeEnabled()
  // Nothing starts by itself.
  await expect(live.getByTestId('recording-state')).toHaveCount(0)
})

test('record, pause, resume and stop with the browser microphone: timed lines, doctor-assigned speakers, extracted drafts, confirm and reject', async ({ page, baseURL, isMobile }) => {
  test.skip(isMobile, 'The synthetic microphone is configured for the desktop project')
  const outside: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith(APP_ORIGIN) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url())
  })
  const p = await startConsultation(page, baseURL!)
  const live = page.getByRole('region', { name: 'Live transcription' })
  const points = page.getByRole('region', { name: 'Important points' })
  await live.getByRole('button', { name: 'Patient agrees (verbal)' }).click()

  // ---- record ----
  await live.getByRole('button', { name: 'Start recording' }).click()
  const state = live.getByTestId('recording-state')
  await expect(state).toContainText('Recording')
  await expect(live.getByText('Recording', { exact: true }).first()).toBeVisible()
  await expect(state).toContainText(/00:0[1-9]/, { timeout: 10_000 })

  // Pause sends what was recorded so far; the clock holds while paused.
  await live.getByRole('button', { name: 'Pause' }).click()
  await expect(state).toContainText('Paused')
  await page.waitForTimeout(800)
  const held = await state.textContent()
  await page.waitForTimeout(1500)
  expect(await state.textContent()).toBe(held)
  const lines = live.getByTestId('transcript-line')
  await expect(lines.first()).toBeVisible({ timeout: 15_000 })
  const afterFirstPart = await lines.count()
  expect(afterFirstPart).toBeGreaterThanOrEqual(4)

  // Resume, record a little more, stop.
  await live.getByRole('button', { name: 'Resume' }).click()
  await expect(state).toContainText('Recording')
  await page.waitForTimeout(2500)
  await live.getByRole('button', { name: 'Stop' }).click()
  await expect(live.getByRole('button', { name: 'Start recording' })).toBeVisible({ timeout: 20_000 })
  await expect(state).toHaveCount(0)
  await expect.poll(() => lines.count(), { timeout: 15_000 }).toBeGreaterThan(afterFirstPart)

  // ---- the raw transcript: timed, in order, the model's own words, language shown, nobody assigned yet ----
  const raw = live.getByTestId('raw-transcript')
  await expect(live.getByTestId('transcript-section').first()).toContainText('Raw transcript')
  await expect(raw).toContainText('I am allergic to penicillin.')
  await expect(raw.getByText('Not assigned').first()).toBeVisible()
  await expect(raw.getByText('Low model score').first()).toBeVisible()
  await expect(live.getByTestId('transcript-section').first()).toContainText('English')
  const view = await aiView(page, p.encounterId)
  const t = view.transcripts[0]!
  expect(t.status).toBe('final')
  expect(t.endReason).toBe('doctor_stopped')
  const starts = t.segments.map((s) => s.startMs!)
  expect(starts.every((s) => Number.isFinite(s) && s >= 0)).toBe(true)
  expect(starts).toEqual([...starts].sort((a, b) => a - b))
  expect(t.segments.every((s) => s.endMs! >= s.startMs!)).toBe(true)
  expect(t.segments.every((s) => s.speaker === null && s.speakerSource === 'none')).toBe(true)
  const wordsBefore = t.segments.map((s) => s.text)

  // ---- extracted drafts appear when the recording stops; nothing is confirmed, nothing is in the note ----
  const drafts = points.getByRole('region', { name: 'Extracted drafts' })
  await expect(drafts).toBeVisible({ timeout: 15_000 })
  await expect(points.getByRole('region', { name: 'Confirmed by the doctor' })).toHaveCount(0)
  const allergy = drafts.locator('[data-testid="important-point"][data-category="allergy"]').first()
  await expect(allergy).toContainText('penicillin')
  await expect(allergy).toContainText('Extracted draft')
  await expect(allergy).toHaveAttribute('data-state', 'extracted')
  await expect(allergy).toContainText('Rules on this computer')
  await expect(page.getByLabel('Medical history', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Chief complaint')).toHaveValue(/^Sore throat and fever$/)

  // Confirming a point whose speaker nobody assigned needs an explicit tick: a guess is not a clinical fact.
  await expect(allergy).toContainText('Speaker not assigned: guessed patient')
  await expect(allergy.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled()

  // ---- the doctor assigns who spoke, line by line; the words do not change ----
  const allergyLine = raw.getByTestId('transcript-line').filter({ hasText: 'I am allergic to penicillin.' }).first()
  await allergyLine.getByRole('button', { name: /^Speaker of .*Change$/ }).click()
  await page.getByRole('menuitem', { name: 'Patient', exact: true }).click()
  await expect(allergyLine).toContainText('Patient')
  const planLine = raw.getByTestId('transcript-line').filter({ hasText: 'chest X-ray' }).first()
  await planLine.getByRole('button', { name: /^Speaker of .*Change$/ }).click()
  await page.getByRole('menuitem', { name: 'Doctor', exact: true }).click()
  await expect(planLine).toContainText('Doctor')
  await expect(allergy.getByTestId('speaker-changed')).toBeVisible()
  const afterSpeakers = await aiView(page, p.encounterId)
  expect(afterSpeakers.transcripts[0]!.segments.map((s) => s.text)).toEqual(wordsBefore)
  expect(afterSpeakers.transcripts[0]!.segments.filter((s) => s.speakerSource === 'doctor_assigned').map((s) => s.speaker).sort()).toEqual(['Doctor', 'Patient'])

  // ---- find the points again with the speakers known ----
  await live.getByRole('button', { name: 'Find important points' }).first().click()
  const allergyNow = drafts.locator('[data-testid="important-point"][data-category="allergy"]').filter({ hasText: 'Patient said' }).first()
  await expect(allergyNow).toBeVisible({ timeout: 15_000 })
  await expect(allergyNow.getByTestId('speaker-changed')).toHaveCount(0)
  // Each point names the lines it came from, with their times; choosing one finds the line in the transcript.
  await allergyNow.getByRole('button', { name: /^Show line / }).first().click()
  await expect(raw.getByTestId('transcript-line').filter({ hasText: 'I am allergic to penicillin.' }).first()).toBeVisible()

  // ---- confirm one, reject one; the three kinds stay visibly apart ----
  await allergyNow.getByRole('button', { name: 'Confirm', exact: true }).click()
  const confirmed = points.getByRole('region', { name: 'Confirmed by the doctor' })
  const confirmedAllergy = confirmed.locator('[data-testid="important-point"][data-category="allergy"]').first()
  await expect(confirmedAllergy).toHaveAttribute('data-state', 'confirmed')
  await expect(confirmedAllergy).toContainText('Doctor confirmed')
  // Confirming does not write to the note.
  await expect(page.getByLabel('Medical history', { exact: true })).toHaveValue('')
  const medication = drafts.locator('[data-testid="important-point"]').filter({ hasText: /metformin/i }).first()
  await expect(medication).toBeVisible()
  await medication.getByRole('button', { name: 'Reject', exact: true }).click()
  const rejected = points.getByText(/^Doctor rejected \(\d+\)/)
  await expect(rejected).toBeVisible()
  await rejected.click()
  await expect(points.locator('[data-testid="important-point"][data-state="rejected"]').filter({ hasText: /metformin/i }).first()).toContainText('Doctor rejected')
  await expect(drafts.getByText(/metformin/i)).toHaveCount(0)
  // The raw transcript holds no draft and no confirmation: only what was heard.
  await expect(raw.getByText('Extracted draft')).toHaveCount(0)
  await expect(raw.getByText('Doctor confirmed')).toHaveCount(0)

  // Putting it into the note is a separate act.
  await confirmedAllergy.getByRole('button', { name: /^Add to / }).click()
  await expect(page.getByLabel('Medical history', { exact: true })).toHaveValue(/penicillin/i)

  // ---- it all survives a reload, and the AI-review reads the same state ----
  await page.reload()
  await expect(page.getByRole('region', { name: 'Confirmed by the doctor' }).locator('[data-testid="important-point"][data-category="allergy"]').first()).toHaveAttribute('data-state', 'confirmed')
  const raw2 = page.getByRole('region', { name: 'Live transcription' }).getByTestId('raw-transcript')
  await expect(raw2.getByTestId('transcript-line').filter({ hasText: 'I am allergic to penicillin.' }).first()).toContainText('Patient')
  const final = await aiView(page, p.encounterId)
  expect(final.facts.some((f) => f.category === 'allergy' && (f.status === 'accepted' || f.status === 'edited'))).toBe(true)
  expect(final.facts.some((f) => /metformin/i.test(f.text) && f.status === 'rejected')).toBe(true)

  // ---- privacy: the page talked only to this application, and no address carries speech ----
  expect(outside, 'requests to anything but the app').toEqual([])
  // Hosted AI is allowed in this suite (to the loopback mock), yet nothing of this consultation's capture, transcript, speakers, points or note insertion was sent to it.
  expect((await hostedCalls()).fromCapture, "requests to the hosted provider (mock) carrying this recording’s words").toBe(0)
  // The audio went to the local stand-in (it counted the parts) and the browser itself never reached it: it is not an address the page uses.
  const stand = await pwRequest.newContext()
  expect(((await (await stand.get('http://127.0.0.1:8199/__calls')).json()) as { calls: number }).calls).toBeGreaterThanOrEqual(2)
  await stand.dispose()
  const urls = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name))
  const carried = urls.filter((u) => u.includes('/api/') || new URL(u).search).map((u) => decodeURIComponent(u.replace(APP_ORIGIN, '')))
  expect(carried.length).toBeGreaterThan(0)
  expect(carried.join('\n')).not.toMatch(/penicillin|metformin|cough|fever|chest x-ray/i)
  expect(await page.title()).not.toMatch(/penicillin|metformin|cough|fever/i)
  await expectNoAxeViolations(page)
})

test('the microphone is refused: the doctor is told, nothing is recorded, and no recording is opened', async ({ page, baseURL, isMobile }) => {
  test.skip(isMobile, 'The recorder is exercised on the desktop project')
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
  })
  const p = await startConsultation(page, baseURL!, { consents: ['ai_recording'] })
  const live = page.getByRole('region', { name: 'Live transcription' })
  await live.getByRole('button', { name: 'Start recording' }).click()
  await expect(live.getByRole('alert').filter({ hasText: 'Microphone access was denied' })).toContainText('Nothing was recorded')
  await expect(live.getByRole('button', { name: 'Start recording' })).toBeEnabled()
  await expect(live.getByTestId('recording-state')).toHaveCount(0)
  expect((await aiView(page, p.encounterId)).transcripts).toHaveLength(0)
  // From the top of the page, as at line 381: opening the Conversation module scrolled the page, and the workflow strip (which is not sticky)
  // then sits half under the sticky bar, where axe measures only the uncovered part of its buttons.
  await page.evaluate(() => window.scrollTo(0, 0))
  await expectNoAxeViolations(page)
})

test('a browser without microphone recording says so and offers the other ways in', async ({ page, baseURL, isMobile }) => {
  test.skip(isMobile, 'Desktop project')
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })
  await startConsultation(page, baseURL!, { consents: ['ai_recording'] })
  const live = page.getByRole('region', { name: 'Live transcription' })
  await expect(live).toContainText('This browser cannot record from a microphone')
  await expect(live.getByRole('button', { name: 'Start recording' })).toHaveCount(0)
  await expect(live.getByText('Other ways to add a transcript')).toBeVisible()
})

test('consent withdrawn while recording stops the capture, discards what was not sent, and ends the recording with that reason', async ({ page, baseURL, isMobile }) => {
  test.skip(isMobile, 'The synthetic microphone is configured for the desktop project')
  const p = await startConsultation(page, baseURL!, { consents: ['ai_recording'] })
  const live = page.getByRole('region', { name: 'Live transcription' })
  await expect(live.getByTestId('recording-consent')).toContainText('recorded (ongoing)')
  await live.getByRole('button', { name: 'Start recording' }).click()
  await expect(live.getByTestId('recording-state')).toContainText(/00:0[1-9]/, { timeout: 10_000 })

  await withdrawRecordingConsent(baseURL!, p.patientId)

  // The recorder polls; within a few seconds the microphone is released and the doctor is told.
  await expect(live.getByRole('alert').filter({ hasText: 'Consent to recording was withdrawn' })).toBeVisible({ timeout: 15_000 })
  await expect(live.getByTestId('recording-state')).toHaveCount(0)
  await expect(live.getByRole('button', { name: 'Start recording' })).toHaveCount(0)
  await expect(live.getByTestId('recording-consent')).toContainText('The patient’s consent to recording is needed')

  const view = await aiView(page, p.encounterId)
  expect(view.consent.granted).toBe(false)
  expect(view.transcripts).toHaveLength(1)
  expect(view.transcripts[0]!.status).toBe('final')
  expect(view.transcripts[0]!.endReason).toBe('consent_withdrawn')
  // The server also refuses any further part and any new recording.
  const part = await page.request.post(`/api/transcripts/${view.transcripts[0]!.id}/chunks`, { headers: { 'x-adaxai-csrf': '1' }, multipart: { chunkIndex: '9', offsetMs: '0', file: { name: 'chunk-9.webm', mimeType: 'audio/webm', buffer: Buffer.from('not audio') } } })
  expect(part.ok()).toBe(false)
  expect((await page.request.post(`/api/encounters/${p.encounterId}/live-transcripts`, { headers: { 'x-adaxai-csrf': '1' } })).status()).toBe(409)
})

test('when the local speech service is unavailable the screen says so, recording is not offered, and nothing goes to a hosted service', async ({ browser, baseURL, isMobile }) => {
  test.skip(isMobile, 'Desktop project')
  // Service workers off so the page-level route below sees the requests.
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const unavailable = { available: false, reason: 'The local speech service is not running. Start it with "npm run dev:speech".' }
  await page.route('**/api/encounters/*/ai', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, status: { ...body.status, stt: { ...body.status.stt, ...unavailable } } } })
  })
  await page.route('**/api/encounters/*/capture', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, canRecord: false, blockedReason: unavailable.reason, speech: { ...body.speech, ...unavailable } } })
  })
  const hosted: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith(APP_ORIGIN) && !r.url().startsWith('data:')) hosted.push(r.url())
  })
  await startConsultation(page, baseURL!, { consents: ['ai_recording'] })
  const live = page.getByRole('region', { name: 'Live transcription' })
  const notice = live.getByRole('status').filter({ hasText: 'Local transcription unavailable' })
  await expect(notice).toContainText('The local speech service is not running')
  await expect(notice).toContainText('No audio is ever sent to a hosted service instead')
  await expect(live.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  // The service's reason is shown in the clinician's words: its setup instruction for whoever runs the computer ("Start it with npm run …") is
  // left out (lib/capture.ts clinicianReason), and no npm command appears anywhere in the panel.
  await expect(live.getByText('The local speech service is not running.').last()).toBeVisible()
  await expect(live).not.toContainText('npm run')
  await expect(page.getByTestId('speech-status-chip')).toContainText('Speech-to-text unavailable')
  // A typed transcript still works, and says it is not recorded speech.
  await live.getByText('Other ways to add a transcript').click()
  await live.getByLabel('Or type or paste a transcript').fill('Doctor: How long has the cough lasted?\nPatient: About three days.')
  await live.getByRole('button', { name: 'Save typed transcript' }).click()
  await expect(live.getByTestId('transcript-line').first()).toContainText('How long has the cough lasted?')
  await expect(live.getByTestId('transcript-section').first()).toContainText('Typed transcript')
  await expect(live.getByTestId('transcript-line').first()).toContainText('Doctor')
  expect(hosted).toEqual([])
  await ctx.close()
})

test('only the treating doctor’s role can use capture: nurses are refused, and so is a signed-out caller', async ({ page, baseURL, playwright }) => {
  const p = await startConsultation(page, baseURL!, { consents: ['ai_recording'] })
  const nurse = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await nurse.post('/api/auth/login', { data: { username: 'nurse.anil', password: DEMO_PASSWORD } })).ok()).toBe(true)
  for (const path of [`/api/encounters/${p.encounterId}/capture`, `/api/encounters/${p.encounterId}/ai`]) expect((await nurse.get(path)).status(), path).toBe(403)
  expect((await nurse.post(`/api/encounters/${p.encounterId}/live-transcripts`)).status()).toBe(403)
  await nurse.dispose()
  const anonymous = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  for (const path of [`/api/encounters/${p.encounterId}/capture`, `/api/encounters/${p.encounterId}/ai`]) expect((await anonymous.get(path)).status(), path).toBe(401)
  await anonymous.dispose()
})

test('layout: capture, important points and the record sit side by side on a workstation and stack on a phone, without sideways scrolling', async ({ page, baseURL, isMobile }, testInfo) => {
  const p = await startConsultation(page, baseURL!, { allergies: ['Penicillin'], consents: ['ai_recording'] })
  const live = page.getByRole('region', { name: 'Live transcription' })
  if (isMobile) {
    // No synthetic microphone on this project: a typed transcript fills the same cards.
    await live.getByText('Other ways to add a transcript').click()
    await live.getByLabel('Or type or paste a transcript').fill('Doctor: What brings you in?\nPatient: I have had a cough and a fever for three days.\nPatient: I am allergic to penicillin.\nDoctor: Let us do a chest X-ray and see you again in one week.')
    await live.getByRole('button', { name: 'Save typed transcript' }).click()
    await live.getByRole('button', { name: 'Find important points' }).first().click()
  } else {
    await live.getByRole('button', { name: 'Start recording' }).click()
    await expect(live.getByTestId('recording-state')).toContainText(/00:0[2-9]/, { timeout: 10_000 })
    await live.getByRole('button', { name: 'Stop' }).click()
    await expect(live.getByRole('button', { name: 'Start recording' })).toBeVisible({ timeout: 20_000 })
  }
  const points = page.getByRole('region', { name: 'Important points' })
  await expect(points.locator('[data-testid="important-point"]').first()).toBeVisible({ timeout: 20_000 })
  // One point confirmed (when its speaker was not assigned, the doctor first ticks that it was checked), so all kinds are on screen for the layout check.
  const first = points.locator('[data-testid="important-point"][data-state="extracted"]').first()
  const tick = first.getByLabel('I have checked this against the conversation and the record')
  if (await tick.count()) await tick.check()
  await first.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(points.locator('[data-testid="important-point"][data-state="confirmed"]').first()).toBeVisible()

  const sizes = isMobile ? [null] : [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 412, height: 915 }, { width: 390, height: 844 }]
  for (const size of sizes) {
    if (size) await page.setViewportSize(size)
    const w = size?.width ?? page.viewportSize()!.width
    await page.waitForTimeout(250)
    await expectNoHorizontalOverflow(page)
    // Looking at it: the top of the consultation as the doctor first sees it, and the capture cards on their own.
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: testInfo.outputPath(`capture-${w}-top.png`) })
    await page.getByRole('region', { name: 'Live transcription' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`capture-${w}-capture.png`) })
    await points.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await points.locator('[data-testid="important-point"]').nth(1).screenshot({ path: testInfo.outputPath(`capture-${w}-card.png`) })
    await page.screenshot({ path: testInfo.outputPath(`capture-${w}-points.png`) })
    // Every card of the consultation is reachable and inside the page width.
    for (const name of ['Live transcription', 'Important points']) {
      const box = await page.getByRole('region', { name }).boundingBox()
      expect(box, name).toBeTruthy()
      expect(box!.x, `${name} at ${w}px`).toBeGreaterThanOrEqual(-0.5)
      expect(box!.x + box!.width, `${name} at ${w}px`).toBeLessThanOrEqual(w + 0.5)
    }
  }
  if (!isMobile) {
    await page.setViewportSize({ width: 1440, height: 900 })
    // Wide enough for two panes: the transcript is in the inputs rail on the left, and the patient's record is on the right, not pushed
    // below the transcript (Doctor HERO: Mana is above the record in that pane).
    const live1 = await page.getByRole('region', { name: 'Live transcription' }).boundingBox()
    const note = await page.getByLabel('Chief complaint').boundingBox()
    expect(note!.x).toBeGreaterThan(live1!.x + live1!.width - 1)
  }
  // From the top of the page, as the five-widths test below does: on a phone the screenshots above leave the page scrolled wherever the
  // points card put it, and since Doctor HERO (the workflow strip and the rail's heading above the conversation) that can leave a point's
  // button half under the fixed action bar, which axe then measures by its uncovered part. Where the page happens to be scrolled is not a
  // state of the page.
  await page.evaluate(() => window.scrollTo(0, 0))
  await expectNoAxeViolations(page)
  expect(p.patientId).toBeTruthy()
})

test('the assistant says whether hosted AI is allowed and where text would go; with it off it says nothing leaves this computer and offers no drafting', async ({ browser, baseURL }) => {
  // Allowed in this suite, on purpose and only to the loopback mock: the badge and the disclosure say where.
  const on = await browser.newContext({ baseURL, serviceWorkers: 'block' })
  const page = await on.newPage()
  await startConsultation(page, baseURL!, { consents: ['ai_recording'] })
  // The older assistant is not one of the five inputs: it is in the "More tools" sheet (Doctor HERO), drawn while the sheet is open.
  const panel = (await openMoreTools(page)).getByRole('region', { name: 'AI consultation assistant' })
  await expect(panel.getByTestId('egress-badge')).toContainText('Hosted AI: allowed (to 127.0.0.1:4199)')
  await expect(panel.getByTestId('external-disclosure')).toContainText('not on this computer')
  await expect(panel.getByTestId('external-disclosure')).toContainText('Audio is never sent')
  // The same screen when the server has egress off (the default): the status is read from the server, so it is set here the way the server would send it.
  await page.route('**/api/encounters/*/ai', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const reason = 'Hosted AI processing is switched off on this server, so no consultation text leaves this computer. Turning it on is a server setting (ai.egress.hostedProviders in config/adaxai.yaml, or AI_EGRESS_HOSTED), not something this screen can do.'
    await route.fulfill({ response: res, json: { ...body, status: { ...body.status, egress: { hosted: false, destination: null }, llm: { available: false, provider: null, model: null, reason }, qa: { available: false, provider: null, model: null, reason }, vision: { available: false, provider: null, model: null, reason } } } })
  })
  await page.reload()
  const off = (await openMoreTools(page)).getByRole('region', { name: 'AI consultation assistant' })
  await expect(off.getByTestId('egress-badge')).toContainText('Hosted AI: off')
  await expect(off.getByTestId('egress-off-note')).toContainText('Nothing leaves this computer')
  await expect(off.getByTestId('egress-off-note')).toContainText('a server setting that this screen cannot change')
  await expect(off.getByTestId('external-disclosure')).toHaveCount(0)
  await expect(off.getByRole('button', { name: /Generate draft/ })).toHaveCount(0)
  await expectNoAxeViolations(page)
  await on.close()
})

test('states at five widths: consent needed, local transcription unavailable, and a microphone error each fit the screen and pass the accessibility check', async ({ browser, baseURL, isMobile }, testInfo) => {
  test.skip(isMobile, 'Sets its own screen sizes (the 412 px Pixel 7 size is one of them)')
  const widths = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 412, height: 915 }, { width: 390, height: 844 }]
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block', permissions: ['microphone'] })
  const page = await ctx.newPage()
  const unavailable = { available: false, reason: 'The local speech service is not running. Start it with "npm run dev:speech".' }
  let speechDown = false
  await page.route('**/api/encounters/*/ai', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: speechDown ? { ...body, status: { ...body.status, stt: { ...body.status.stt, ...unavailable } } } : body })
  })
  // Recording consent is given from the screen: the answer to that request carries the state too.
  await page.route('**/api/encounters/*/ai-consent', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: speechDown ? { ...body, status: { ...body.status, stt: { ...body.status.stt, ...unavailable } } } : body })
  })
  await page.route('**/api/encounters/*/capture', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: speechDown ? { ...body, canRecord: false, blockedReason: unavailable.reason, speech: { ...body.speech, ...unavailable } } : body })
  })
  await page.addInitScript(() => {
    // Only when a test sets window.name (it survives a reload): the browser refuses the microphone.
    const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = (c) => (window.name === 'deny-mic' ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : original!(c))
  })
  const fit = async (label: string) => {
    for (const size of widths) {
      await page.setViewportSize(size)
      await page.waitForTimeout(200)
      await expectNoHorizontalOverflow(page)
      await page.getByRole('region', { name: 'Live transcription' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${label.replace(/\W+/g, '-')}-${size.width}.png`) })
      for (const name of ['Live transcription', 'Important points']) {
        const box = await page.getByRole('region', { name }).boundingBox()
        expect(box, `${label}: ${name} at ${size.width}px`).toBeTruthy()
        expect(box!.x + box!.width, `${label}: ${name} at ${size.width}px`).toBeLessThanOrEqual(size.width + 0.5)
      }
    }
    // From the top of the page: a control the page header covers because of where the page happens to be scrolled is not a state of the page.
    await page.evaluate(() => window.scrollTo(0, 0))
    await expectNoAxeViolations(page).catch((e: Error) => {
      throw new Error(`[${label}] ${e.message}`)
    })
  }
  // 1. Consent needed.
  const first = await nurseHandsOverPatient(baseURL!)
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: first.name }).getByRole('button', { name: 'Start consultation' }).click()
  // Module 1 of the inputs rail (Doctor HERO), which starts closed; opened, it stays open after the reload below.
  await openModule(page, 'Conversation')
  const live = page.getByRole('region', { name: 'Live transcription' })
  await expect(live.getByTestId('recording-consent')).toContainText('The patient’s consent to recording is needed')
  await fit('consent needed')
  // 2. Consent recorded, local transcription unavailable.
  speechDown = true
  await live.getByRole('button', { name: 'Patient agrees (verbal)' }).click()
  await expect(live.getByRole('status').filter({ hasText: 'Local transcription unavailable' })).toBeVisible()
  await fit('local transcription unavailable')
  // 3. Service back, the microphone refused: the error is told in words.
  speechDown = false
  await page.evaluate(() => (window.name = 'deny-mic'))
  await page.reload()
  await page.getByRole('region', { name: 'Live transcription' }).getByRole('button', { name: 'Start recording' }).click()
  await expect(page.getByRole('region', { name: 'Live transcription' }).getByRole('alert').filter({ hasText: 'Microphone access was denied' })).toBeVisible()
  await fit('microphone error')
  await ctx.close()
})
