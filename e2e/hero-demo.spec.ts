import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect, type Locator, type Page, request as pwRequest, test, type TestInfo } from '@playwright/test'
import { analyzeButton, DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, llmExclusive, signIn, stepTo, uniq } from './support.ts'

/*
 * The Doctor HERO demo journey (Step 3, the demo journey of the owner's brief), end to end in a real browser against the real API, database and thermal service: a
 * synthetic child like the one `npm run demo:hero` makes (apps/api/src/db/hero-demo.ts: an amoxicillin allergy, a salbutamol inhaler on the
 * medicine list, an earlier signed consultation, fever and a mild cough today); "Play demo consultation", which plays the demo's synthetic
 * audio (apps/web/public/demo/consultation, computer voices reading a written script) in the browser and sends each part, as it ends, as the
 * next part of a live recording; a SIMULATOR band; a stethoscope recording from Chromium's synthetic audio input; a SIMULATED thermal capture
 * and an imported public FLIR sample; the pediatric shock research view (no research model); "Analyze with Mana" with the model's progress
 * as the server reports it, and what reached the model; the doctor's review (accept, edit, reject) and the note; "Repeat a current medicine";
 * "Preview & print"; signing; and the audit trail. The page at six screen sizes, each screenshot with the WCAG 2.2 AA checks and no sideways
 * scrolling. The journey is recorded as a video. A second test covers what is missing (no allergy status, no medicine, no device, no thermal
 * image) in the words that say so, never "none".
 *
 * Everything is real except the stand-ins this suite always uses, none of them a model, a recogniser or a device: the speech service
 * (e2e/mock-speech.mjs: whatever it is sent, it returns its fixed five-line script, so the demo's parts come back as that script, not as the
 * demo's words; this test asserts that the transcript is labelled SYNTHETIC and that its lines arrive part by part, not any wording), the local
 * model (e2e/mock-llm.mjs, which streams its answer when asked to, as llama-server does, so that the progress shown is the server's real
 * report of the stand-in's pieces), Chromium's synthetic audio input, a SIMULATOR band whose "gateway" is this test posting fixed numbers with
 * the band's token, and the thermal simulator. A time measured here is the stand-ins' time, not the product's.
 */

const SAMPLES = path.resolve(import.meta.dirname, '..', 'samples', 'thermal')
const DEMO_MANIFEST = path.resolve(import.meta.dirname, '..', 'apps', 'web', 'public', 'demo', 'consultation', 'manifest.json')
const APP_ORIGIN = 'http://127.0.0.1:5273'
const LLM = 'http://127.0.0.1:8181'
/** The demo audio's own label (apps/web/src/lib/demoConsultation.ts DEMO_AUDIO_LABEL, the same words as the manifest's). */
const DEMO_AUDIO_LABEL = 'SYNTHETIC AUDIO — computer voices, not a real consultation'

/** The stand-in model's mode; a streamed answer starts after `readMs` (its "reading" time) and is spread over `streamMs` (e2e/mock-llm.mjs). */
async function llm(o: { mode: 'ok'; readMs?: number; streamMs?: number }) {
  const r = await pwRequest.newContext()
  try {
    expect((await r.post(`${LLM}/__mode`, { data: o })).ok()).toBe(true)
  } finally {
    await r.dispose()
  }
}
async function llmCalls() {
  const r = await pwRequest.newContext()
  try {
    return (await (await r.get(`${LLM}/__calls`)).json()) as { count: number; calls: { kind?: string; stream?: boolean }[] }
  } finally {
    await r.dispose()
  }
}

async function staff(baseURL: string, username: string): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username, password: DEMO_PASSWORD } })).ok()).toBe(true)
  return api
}
const ok = async (res: { ok: () => boolean; status: () => number; text: () => Promise<string> }, what: string) => expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true)

// The synthetic child of `npm run demo:hero` (apps/api/src/db/hero-demo.ts), written out here: that seed drives the API in its own process,
// this suite drives the API it started. Only the given name differs, so that runs never meet a patient of an earlier run.
const CHILD = { familyName: 'Demo-Synthetic', dateOfBirth: '2020-05-14', sex: 'female' }
const ALLERGY = { substance: 'Amoxicillin', reaction: 'Rash', severity: 'moderate' }
const MEDICINE = { drugName: 'Salbutamol inhaler', strength: '100 mcg per puff', form: 'Inhaler', dose: '2 puffs with a spacer', route: 'Inhaled', frequency: 'When needed for wheeze', reason: 'Wheeze with a chest infection' }
const EARLIER = {
  complaint: 'Cough, fever and wheeze for two days',
  note: {
    history: 'Two days of cough and fever after a cold, with wheeze at night. (Synthetic demo record.)',
    pastHistory: 'No earlier chest infections recorded. Allergy: amoxicillin (rash).',
    examination: 'Scattered wheeze on both sides, no crackles.',
    assessment: 'Lower respiratory tract infection with wheeze.',
    plan: 'Salbutamol inhaler with a spacer when needed for wheeze.',
    followUp: 'Review in one week, or sooner if worse.',
  },
  diagnoses: [{ description: 'Acute lower respiratory infection, unspecified', code: 'J22', kind: 'primary' }],
  prescription: [{ drugName: 'Salbutamol inhaler', strength: '100 mcg per puff', form: 'Inhaler', dose: '2 puffs with a spacer', route: 'Inhaled', frequency: 'When needed for wheeze, up to every 4 hours', duration: '14 days', instructions: 'Come back if needed more often than every 4 hours' }],
}
const TODAY = 'Fever for three days and mild cough'
const TODAY_VITALS = [
  { kind: 'temperature', value: 38.6 },
  { kind: 'heart_rate', value: 124 },
  { kind: 'respiratory_rate', value: 28 },
  { kind: 'spo2', value: 96 },
  { kind: 'weight', value: 20.5 },
]

/**
 * The nurse registers the child, records the consents, an allergy and (by a doctor) the medicine list and an earlier signed consultation where
 * asked, then today's visit with or without vital signs, ready for the doctor. All through the API (their screens have their own specs).
 */
async function handOverChild(baseURL: string, o: { given: string; allergy: boolean; medicine: boolean; earlier: boolean; vitals: boolean; consents: string[] }) {
  const nurse = await staff(baseURL, 'nurse.anil')
  const doctor = await staff(baseURL, 'dr.meera')
  const res = await nurse.post('/api/patients', { data: { givenName: o.given, ...CHILD, phone: `7${String(Date.now()).slice(-9)}` } })
  await ok(res, 'register the child')
  const patient = (await res.json()) as { id: string; mrn: string }
  for (const type of o.consents) await ok(await nurse.post(`/api/patients/${patient.id}/consents`, { data: { type, method: 'verbal' } }), `consent ${type}`)
  if (o.allergy) await ok(await nurse.post(`/api/patients/${patient.id}/allergies`, { data: ALLERGY }), 'allergy')
  const gen = ((await (await nurse.get('/api/departments')).json()).departments as { id: string; code: string }[]).find((d) => d.code === 'GEN')!
  if (o.earlier) {
    // An earlier consultation, signed by the doctor (today: the seed backdates it, which needs the database itself).
    const v = await (await nurse.post('/api/visits', { data: { patientId: patient.id, departmentId: gen.id, chiefComplaint: EARLIER.complaint } })).json()
    await ok(await nurse.post(`/api/visits/${v.id}/status`, { data: { status: 'ready' } }), 'earlier visit ready')
    const started = await doctor.post(`/api/visits/${v.id}/encounter`)
    await ok(started, 'earlier consultation started')
    const e = (await started.json()) as { id: string; version: number }
    const saved = await doctor.put(`/api/encounters/${e.id}/draft`, { data: { version: e.version, note: { chiefComplaint: EARLIER.complaint, ...EARLIER.note }, diagnoses: EARLIER.diagnoses, prescription: EARLIER.prescription } })
    await ok(saved, 'earlier consultation saved')
    await ok(await doctor.post(`/api/encounters/${e.id}/sign`, { data: { version: ((await saved.json()) as { version: number }).version, attestation: true } }), 'earlier consultation signed')
  }
  if (o.medicine) await ok(await doctor.post(`/api/patients/${patient.id}/medications`, { data: MEDICINE }), 'medicine list')
  const visit = await (await nurse.post('/api/visits', { data: { patientId: patient.id, departmentId: gen.id, chiefComplaint: TODAY } })).json()
  if (o.vitals) await ok(await nurse.post(`/api/visits/${visit.id}/observations`, { data: { items: TODAY_VITALS } }), 'vital signs')
  await ok(await nurse.post(`/api/visits/${visit.id}/status`, { data: { status: 'ready' } }), 'visit ready')
  await nurse.dispose()
  await doctor.dispose()
  return { name: `${o.given} ${CHILD.familyName}`, patientId: patient.id, mrn: patient.mrn }
}

/** An administrator registers a SIMULATOR band and issues its gateway token; this test then posts with the token as a gateway would. */
async function registerSimulator(admin: APIRequestContext, baseURL: string, label: string) {
  const d = await (await admin.post('/api/admin/devices', { data: { kind: 'wearable_band', label, serialNumber: `E2E-HERO-${uniq()}`, integration: 'simulator' } })).json()
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

/** Starts the consultation of the patient's ready visit from today's patients, as the doctor does. */
async function startFromQueue(page: Page, name: string) {
  await page.goto('/doctor/queue')
  await expect(page.getByRole('heading', { level: 1, name: 'Today’s patients' })).toBeVisible()
  await page.getByRole('list', { name: 'Visits' }).getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}$/)
  return /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!
}

const module_ = (page: Page, part: string) => page.locator(`#${part}`)
/** Closes a module with its own Hide button (as the doctor would), so its compact summary is what shows. */
async function closeModule(page: Page, part: string) {
  const toggle = module_(page, part).locator(`button[aria-controls="${part}-body"]`)
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click()
  await expect(module_(page, part)).toHaveAttribute('data-open', 'false')
}

/** A screenshot of the screen as it is, kept with the test's results (and named by the step and the size). */
async function shot(page: Page, info: TestInfo, name: string) {
  const v = page.viewportSize()!
  await page.screenshot({ path: info.outputPath(`hero-demo-${name}-${v.width}x${v.height}.png`) })
}

/** The six sizes of the Step 3 demo journey: laptop, desktop, wide desktop, tablet landscape, tablet portrait, phone. */
const SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1180, height: 820 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]

type AuditRow = { action: string; outcome: string; actorRole: string | null; details: Record<string, unknown> }
async function auditOf(admin: APIRequestContext, patientId: string): Promise<AuditRow[]> {
  const events: AuditRow[] = []
  for (let before: number | null = null, n = 0; n < 20; n++) {
    const res = await admin.get('/api/admin/audit-events', { params: { patientId, limit: 200, ...(before !== null && { before }) } })
    await ok(res, 'audit read')
    const body = (await res.json()) as { events: AuditRow[]; nextBefore: number | null }
    events.push(...body.events)
    if (body.nextBefore === null) break
    before = body.nextBefore
  }
  return events
}

// One stand-in model server whose mode is set here, a synthetic audio input, and sizes set here: the desktop project only.
test.skip(({ isMobile }) => isMobile, 'desktop project only (shared model stand-in, synthetic audio input; the phone size is set here)')
// Each test is recorded (test-results/<the test>/video.webm), at the laptop size the journey starts at: the journey's video is the demo's.
test.use({ actionTimeout: 30_000, navigationTimeout: 30_000, video: { mode: 'on', size: { width: 1366, height: 768 } } })
llmExclusive(test)
test.beforeEach(async () => llm({ mode: 'ok' }))

let openPatients: string[] = []
test.afterEach(async ({ baseURL }) => {
  for (const stop of loops.splice(0)) await stop()
  await llm({ mode: 'ok' })
  const ids = openPatients
  openPatients = []
  if (!ids.length) return
  const nurse = await staff(baseURL!, 'nurse.anil')
  const doctor = await staff(baseURL!, 'dr.meera')
  for (const id of ids) {
    const visits = ((await (await nurse.get(`/api/patients/${id}/visits`)).json()).visits ?? []) as { id: string; status: string; encounterId: string | null }[]
    for (const v of visits.filter((x) => ['waiting', 'in_triage', 'ready', 'in_consultation'].includes(x.status))) {
      if (v.status === 'in_consultation' && v.encounterId) {
        const e = await (await doctor.get(`/api/encounters/${v.encounterId}`)).json()
        if (e.status === 'in_progress') await doctor.post(`/api/encounters/${e.id}/discard`, { data: { version: e.version, reason: 'Test clean-up (synthetic)' } })
      }
      await nurse.post(`/api/visits/${v.id}/status`, { data: { status: 'cancelled', reason: 'Test clean-up (synthetic)' } })
    }
  }
  await nurse.dispose()
  await doctor.dispose()
})

test('the Doctor HERO demo: the synthetic demo consultation transcribed part by part, the simulator band, the stethoscope, thermal and research, Analyze with Mana with its real progress and what it read, review, the note, Repeat a current medicine, Preview & print, signing and the audit trail, at six sizes', async ({ page, baseURL }, testInfo) => {
  test.skip(!fs.existsSync(path.join(SAMPLES, 'flir_example.jpg')), 'thermal sample images not fetched (npm run setup)')
  test.skip(!fs.existsSync(DEMO_MANIFEST), 'the demo audio is not in apps/web/public/demo/consultation (node scripts/demo-audio.mjs)')
  test.setTimeout(600_000)
  const parts = (JSON.parse(fs.readFileSync(DEMO_MANIFEST, 'utf8')) as { utterances: unknown[] }).utterances.length
  // What the page asks for: only this computer's application (the demo audio included), and never Mana chat.
  const outside: string[] = []
  const manaRequests: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith(APP_ORIGIN) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url())
    if (new URL(r.url()).pathname.startsWith('/api/mana-assistant')) manaRequests.push(`${r.method()} ${new URL(r.url()).pathname}`)
  })

  // ---- 0. The synthetic child, handed over: an allergy (amoxicillin), a medicine on the list (salbutamol inhaler), an earlier signed
  // consultation, today's vital signs, and the consents (recording, devices, Mana, thermal imaging). ----
  const child = await handOverChild(baseURL!, { given: `Anaya${uniq()}`, allergy: true, medicine: true, earlier: true, vitals: true, consents: ['data_processing', 'ai_recording', 'device_monitoring', 'ai_record_assistant', 'thermal_imaging'] })
  openPatients.push(child.patientId)

  // ---- 1. Sign in, today's patients, start: on a 1366x768 laptop. ----
  await page.setViewportSize({ width: 1366, height: 768 })
  await signIn(page, 'dr.meera')
  const encounterId = await startFromQueue(page, child.name)
  const header = page.getByTestId('consultation-header')
  const banner = page.getByTestId('patient-banner')
  const conversation = module_(page, 'tools-conversation')
  const history = module_(page, 'tools-history')
  const vitals = module_(page, 'tools-devices')
  const stethoscope = module_(page, 'tools-stethoscope')
  const thermal = module_(page, 'tools-thermal')

  // The bar: who, and what to be careful of. A child's values are never flagged (the reference ranges are for adults), so the badge says only
  // that vital signs are recorded.
  await expect(header.getByRole('heading', { level: 1 })).toContainText(child.name)
  await expect(banner.getByTestId('patient-identity')).toContainText(`MRN ${child.mrn}`)
  await expect(banner.getByRole('list', { name: 'Allergies' })).toContainText('Amoxicillin')
  await expect(banner.getByTestId('vitals-alert')).toContainText('Vital signs recorded')
  await expect(header.getByTestId('model-status-chip')).toHaveText('Local AI ready', { timeout: 20_000 })
  await expect(header.getByTestId('speech-status-chip')).toHaveText('Speech-to-text ready', { timeout: 20_000 })
  // The five modules, closed, each with what it has and the one thing to do; Analyze at the rail's foot, on the screen.
  await expect(conversation.getByTestId('summary-conversation')).toContainText('Not recorded yet')
  await expect(conversation.getByTestId('module-conversation-record')).toBeVisible()
  // "Play demo consultation", offered because this deployment allows simulators and the recording consent is present, marked SYNTHETIC.
  const demoAction = conversation.getByTestId('module-conversation-demo')
  await expect(demoAction).toBeVisible({ timeout: 20_000 })
  await expect(demoAction).toHaveAccessibleName('Play demo consultation (synthetic audio: computer voices, not a real consultation)')
  await expect(demoAction).toHaveAttribute('title', DEMO_AUDIO_LABEL)
  await expect(history.getByTestId('summary-history-allergies')).toContainText('Amoxicillin')
  await expect(history.getByTestId('summary-history')).toContainText('Last consultation')
  await expect(history.getByTestId('summary-history')).toContainText('1 current medicine')
  await expect(vitals.getByTestId('summary-vitals')).toHaveAttribute('data-devices', 'none', { timeout: 15_000 })
  await expect(vitals.getByTestId('module-vitals-attach')).toBeVisible()
  await expect(stethoscope.getByTestId('summary-stethoscope')).toContainText('No recording yet')
  await expect(stethoscope.getByTestId('module-stethoscope-record')).toBeVisible()
  await expect(thermal.getByTestId('summary-thermal-images')).toHaveText('Thermal image not captured')
  await expect(thermal.getByTestId('module-thermal-capture')).toBeVisible()
  await expect(thermal.getByTestId('module-thermal-research')).toHaveAccessibleName('Pediatric shock research')
  await shot(page, testInfo, '01-open')
  // Closed modules whole on the laptop's screen when the page opens, with Analyze (the Step 3 brief asks for four). With "Play demo consultation"
  // offered, the Conversation module's actions take a second row and the fourth module's foot is cut by a few pixels at this size (measured and
  // reported below, not hidden): its title and its Record are on the screen.
  for (const m of [conversation, history, vitals]) await expect(m).toBeInViewport({ ratio: 1 })
  await expect(stethoscope.getByRole('heading', { name: 'Stethoscope' })).toBeInViewport({ ratio: 1 })
  await expect(stethoscope.getByTestId('module-stethoscope-record')).toBeInViewport({ ratio: 1 })
  await expect(analyzeButton(page)).toBeInViewport({ ratio: 1 })
  const cut = await stethoscope.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const scroller = el.closest('[data-scroller]')?.getBoundingClientRect()
    return Math.max(0, Math.round(r.bottom - Math.min(scroller?.bottom ?? innerHeight, innerHeight)))
  })
  testInfo.annotations.push({ type: 'layout', description: `1366x768 at page open, demo offered: module 4 (Stethoscope) cut by ${cut}px at the rail's foot` })
  await expectNoHorizontalOverflow(page)
  await expectNoAxeViolations(page)

  // Scrolled, the bar is one compact row that still holds the name, the MRN and the allergies.
  await page.evaluate(() => window.scrollTo(0, 600))
  await expect(header).toHaveAttribute('data-compact', 'true')
  await expect(header.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(banner.getByTestId('patient-identity')).toBeVisible()
  await expect(banner.getByRole('list', { name: 'Allergies' })).toBeVisible()
  await shot(page, testInfo, '02-compact-bar')
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(header).toHaveAttribute('data-compact', 'false')

  // ---- 2. MODULE 1: "Play demo consultation". Real synthetic audio is played in the browser and each part, as it ends, is sent as the next
  // part of a live recording; the speech stand-in transcribes each part (as its fixed script). ----
  // Watched in the page while it runs: the transcript's lines (how many, in which phase of the demo), and every text each line was drawn with.
  await page.evaluate(() => {
    const w = window as unknown as { __demoLines: { n: number; phase: string | null }[]; __lineTexts: Record<string, string[]> }
    w.__demoLines = []
    w.__lineTexts = {}
    const lines = () => document.querySelectorAll('[data-testid="transcript-section"][data-audio-origin="demo_synthetic"] [data-testid="transcript-line"]')
    setInterval(() => {
      const n = lines().length
      const phase = document.querySelector('[data-testid="demo-consultation"]')?.getAttribute('data-phase') ?? null
      const last = w.__demoLines.at(-1)
      if (!last || last.n !== n || last.phase !== phase) w.__demoLines.push({ n, phase })
    }, 50)
    new MutationObserver(() => {
      for (const li of lines()) {
        const text = li.querySelector(':scope > p')?.textContent ?? ''
        const seen = (w.__lineTexts[li.id] ??= [])
        if (seen.at(-1) !== text) seen.push(text)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  const demo = page.getByTestId('demo-consultation')
  const live = page.getByRole('region', { name: 'Live transcription' })
  // The panel's own button is ready (the demo's files are listed, the speech service is ready) before the quick action uses it.
  await expect(page.getByTestId('demo-consultation-play')).toBeEnabled({ timeout: 20_000 })
  const demoClicked = Date.now()
  await demoAction.click()
  await expect(conversation).toHaveAttribute('data-open', 'true')
  await expect(demo).toHaveAttribute('data-phase', 'playing', { timeout: 30_000 })
  await expect(demo.getByTestId('demo-audio-label')).toHaveText(DEMO_AUDIO_LABEL)
  await expect(page.getByTestId('demo-consultation-play')).toHaveCount(0)
  await expect(demo.getByRole('button', { name: 'Pause demo' })).toBeVisible()
  await expect(demo.getByRole('button', { name: 'Stop demo' })).toBeVisible()
  await expect(demo.getByTestId('demo-consultation-status')).toContainText(new RegExp(`^Playing part \\d of ${parts}`))
  // Synthetic demo audio playing is never "Recording" (the microphone's word, in red): the card and the module's chip say what it is.
  await expect(live.getByTestId('demo-audio-mark').first()).toHaveText('Synthetic demo audio')
  await expect(live.getByText('Recording', { exact: true })).toHaveCount(0)
  await expect(conversation.locator('[data-module-chip]')).toHaveAttribute('title', /^Synthetic demo playing/)
  await expect(conversation.getByTestId('summary-conversation')).toHaveAttribute('data-state', 'demo_playing')
  await expect(live).toContainText('The microphone recorder returns when the demo’s recording has ended.')
  // The first part's lines while later parts still play: the transcript is labelled as synthetic demo audio.
  const demoSection = live.locator('[data-testid="transcript-section"][data-audio-origin="demo_synthetic"]')
  await expect(demoSection.getByTestId('transcript-line').first()).toBeVisible({ timeout: 30_000 })
  await expect(demo).toHaveAttribute('data-phase', 'playing')
  await expect(demoSection.getByTestId('demo-transcript-note')).toContainText('Not a real consultation; no patient spoke.')
  await expect(demoSection.locator('summary').getByTestId('demo-audio-mark')).toHaveText('Synthetic demo audio')
  await shot(page, testInfo, '03-demo-playing')
  // The end: every part played and transcribed, the recording ended, the fixed rules' important points found.
  await expect(demo).toHaveAttribute('data-phase', 'done', { timeout: 150_000 })
  testInfo.annotations.push({ type: 'timing', description: `Play demo consultation, click to done: ${Date.now() - demoClicked} ms (${parts} parts of synthetic audio played in real time; speech stand-in, not a product timing)` })
  await expect(demo.getByTestId('demo-consultation-status')).toContainText(`Demo finished: ${parts} of ${parts} parts transcribed by the speech model.`)
  await expect(demo.getByTestId('demo-consultation-status')).toContainText('Important points found by fixed rules (extract-rules-v1), to review, are below.')
  await expect(demo.locator('[data-testid="demo-consultation-steps"] li[data-state="transcribed"]')).toHaveCount(parts)
  await expect(page.getByTestId('demo-consultation-play')).toBeVisible()
  const finalLines = await demoSection.getByTestId('transcript-line').count()
  expect(finalLines, 'every part came back with lines').toBeGreaterThanOrEqual(parts)
  // Lines arrived one part at a time while the audio played, never all at the end: the line count grew in steps during playback.
  const log = await page.evaluate(() => (window as unknown as { __demoLines: { n: number; phase: string | null }[] }).__demoLines)
  const counts = log.map((e) => e.n)
  expect(counts, 'the line count never went down').toEqual([...counts].sort((a, b) => a - b))
  const whilePlaying = [...new Set(log.filter((e) => e.phase === 'playing' || e.phase === 'paused').map((e) => e.n).filter((n) => n > 0 && n < finalLines))]
  expect(whilePlaying.length, `lines arrived part by part while the demo played (counts seen: ${counts.join(', ')})`).toBeGreaterThanOrEqual(Math.min(4, parts - 1))
  // Each new line was drawn word by word, only ever with the start of its own words (presentation of what arrived; nothing else).
  const texts = await page.evaluate(() => (window as unknown as { __lineTexts: Record<string, string[]> }).__lineTexts)
  const revealed = Object.values(texts).filter((seen) => seen.length > 1)
  expect(revealed.length, 'new lines appeared word by word').toBeGreaterThan(0)
  for (const seen of Object.values(texts)) {
    const whole = seen.at(-1)!
    expect(whole.length, 'a line ends whole').toBeGreaterThan(0)
    for (const partial of seen.slice(0, -1)) expect(whole.startsWith(partial), `“${partial}” is the start of “${whole}”`).toBe(true)
  }
  // The fixed rules' points: drafts to review, from synthetic demo audio, found by the rules (not a model). The doctor confirms one.
  const points = page.getByRole('region', { name: 'Important points' })
  const drafts = points.getByRole('region', { name: 'Extracted drafts' })
  const point = drafts.locator('[data-testid="important-point"][data-category="allergy"]').first()
  await expect(point).toBeVisible({ timeout: 20_000 })
  await expect(point.getByTestId('demo-audio-mark')).toHaveText('From synthetic demo audio')
  await expect(point.getByTestId('point-provenance')).toContainText('Found by fixed rules (extract-rules-v1), to review · Rules on this computer')
  const tick = point.getByLabel('I have checked this against the conversation and the record')
  if (await tick.count()) await tick.check()
  await point.getByRole('button', { name: 'Confirm', exact: true }).click()
  const confirmed = points.getByRole('region', { name: 'Confirmed by the doctor' }).getByTestId('important-point')
  await expect(confirmed.first()).toHaveAttribute('data-state', 'confirmed')
  const confirmedCount = await confirmed.count()
  // The module, closed: the transcript is said to be synthetic demo audio.
  await closeModule(page, 'tools-conversation')
  await expect(conversation.getByTestId('summary-conversation')).toHaveAttribute('data-demo', 'true')
  await expect(conversation.getByTestId('summary-conversation').getByTestId('demo-audio-mark').first()).toBeVisible()
  await expect(conversation.getByTestId('summary-conversation')).toContainText(`${confirmedCount} confirmed`)

  // ---- 3. MODULE 3: a SIMULATOR band, attached from the module's own "Attach device"; its values are SIMULATED, never LIVE in the summary. ----
  const admin = await staff(baseURL!, 'admin')
  const sim = await registerSimulator(admin, baseURL!, `Simulator band for the hero demo ${uniq()}`)
  await vitals.getByTestId('module-vitals-attach').click()
  const attachDlg = page.getByRole('dialog', { name: 'Attach a device' })
  const option = attachDlg.locator('option', { hasText: sim.label })
  await expect(option).toBeAttached()
  await attachDlg.getByLabel('Device').selectOption((await option.getAttribute('value'))!)
  await expect(attachDlg.getByText('This is a simulator, not a device.')).toBeVisible()
  await attachDlg.getByRole('button', { name: 'Attach' }).click()
  await expect(attachDlg).toBeHidden()
  await expect(vitals).toHaveAttribute('data-open', 'true')
  const card = page.getByTestId('device-readings')
  const attached = card.getByTestId('attached-device')
  await expect(attached).toHaveAttribute('data-simulated', 'true')
  let beat = 0
  const stopSim = every(2000, () => {
    beat += 1
    return sim.send([{ kind: 'heart_rate', value: 126 + (beat % 3) }, { kind: 'spo2', value: 95 }, { kind: 'respiratory_rate', value: 30 }])
  })
  await expect(attached).toHaveAttribute('data-state', 'live', { timeout: 20_000 })
  await expect(attached.getByTestId('simulated-badge')).toHaveText('SIMULATED')
  await expect(attached.getByTestId('device-signal-quality')).toContainText('Signal quality: not reported by the simulator')
  for (const v of await vitals.locator('[data-testid="summary-vital-value"][data-simulated="true"]').all()) {
    await expect(v).toContainText('SIMULATED')
    await expect(v).not.toContainText('LIVE')
  }
  await expect(header.getByTestId('device-status-chip').getByTestId('simulated-badge')).toHaveText('SIMULATED')
  // The band stops before the analysis: a draft made from the record is STALE as soon as a new reading arrives.
  await stopSim()
  await closeModule(page, 'tools-devices')

  // ---- 4. MODULE 4: a stethoscope recording from the browser's audio input (Chromium's synthetic one), with its waveform; not analysed. ----
  await stethoscope.getByTestId('module-stethoscope-record').click()
  const rec = page.getByRole('dialog', { name: 'Record from an audio input' })
  await rec.getByRole('button', { name: 'Start recording' }).click()
  await expect(rec.getByTestId('auscultation-recording')).toContainText('Recording…')
  await page.waitForTimeout(2000)
  await rec.getByRole('button', { name: 'Stop' }).click()
  await rec.getByRole('button', { name: 'Save recording' }).click()
  await expect(rec).toBeHidden({ timeout: 15_000 })
  const recording = page.getByRole('region', { name: 'Stethoscope recordings' }).locator('[data-testid="auscultation"][data-capture="browser_recording"]')
  await expect(recording).toHaveCount(1)
  await expect(recording.getByTestId('auscultation-provenance')).toContainText('BROWSER')
  const waveform = recording.getByTestId('waveform')
  await waveform.scrollIntoViewIfNeeded()
  await expect(waveform).toHaveAttribute('data-state', 'drawn', { timeout: 20_000 })
  await expect(waveform).toContainText('Amplitude of the recording. Not an analysis.')
  await expect(page.getByTestId('auscultation-no-analysis')).toHaveText('No clinical sound analysis: recordings are not analysed by any model.')
  await closeModule(page, 'tools-stethoscope')
  await expect(stethoscope.getByTestId('summary-stethoscope')).toContainText(/1 recording · .+ · \d+:\d{2}/)
  await expect(stethoscope.getByTestId('summary-stethoscope')).toContainText('Not analysed')

  // ---- 5. MODULE 5: "Capture thermal" opens the thermal workspace: a SIMULATED capture, and an imported public FLIR sample, approved. ----
  await thermal.getByTestId('module-thermal-capture').click()
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
  await closeModule(page, 'tools-thermal')
  // Closed: the newest image as a small picture with its temperature scale, its source, its approval and its range; Open thermal and Research.
  const newest = thermal.getByTestId('summary-thermal-newest')
  await expect(newest).toHaveAttribute('data-status', 'approved', { timeout: 15_000 })
  await expect(newest).toContainText('IMPORTED')
  await expect(newest).toContainText('Approved')
  await expect(newest).toContainText(/\d+\.\d–\d+\.\d °C/)
  await expect(thermal.getByTestId('summary-thermal-image')).toHaveAttribute('data-loaded', 'true', { timeout: 20_000 })
  await expect(thermal.getByTestId('summary-thermal-scale')).toBeVisible()
  await expect(thermal.getByTestId('summary-thermal-images')).toHaveText('Images: 2 (approved 1)')
  await expect(thermal.getByTestId('module-thermal-open')).toBeVisible()

  // ---- 6. PEDIATRIC SHOCK RESEARCH: research only; no research model; the published review is other studies' results. ----
  await thermal.getByTestId('module-thermal-research').click()
  const sheet = page.getByRole('dialog', { name: 'Pediatric shock research' })
  await expect(sheet.getByTestId('research-header')).toContainText('PEDIATRIC SHOCK — RESEARCH MODE')
  await expect(sheet.getByTestId('research-header')).toContainText('Nothing here detects, predicts or scores shock.')
  await expect(sheet.locator('[data-testid="research-pipeline"] li[data-stage="model"]')).toHaveAttribute('data-status', 'not_built')
  await expect(sheet.locator('[data-testid="research-pipeline"] li[data-stage="model"]')).toContainText('Research model unavailable.')
  await expect(sheet.getByTestId('research-image')).toHaveCount(1)
  await expect(sheet.locator('[data-testid="research-excluded"][data-reason="simulated"]')).toHaveCount(1)
  await expect(sheet.getByTestId('research-paper')).toContainText('PUBLISHED RESEARCH — NOT ADAX-AI VALIDATION')
  await shot(page, testInfo, '04-research')
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await closeModule(page, 'tools-thermal')

  // ---- 7. ANALYZE WITH MANA. The stand-in streams its answer over six seconds, after two and a half seconds of "reading": the progress
  // shown is the server's own count of what has been written, polled every second, so it is seen to advance. ----
  await llm({ mode: 'ok', readMs: 2500, streamMs: 6000 })
  const callsBefore = (await llmCalls()).count
  // Watched in the page while it runs: the progress line (its count and speed as data), the rail's line, the placeholders and the reveal.
  await page.evaluate(() => {
    type Entry = { tokens: string | null; rate: string | null; text: string; rail: string; skeleton: boolean; reveal: number }
    const w = window as unknown as { __analysis: Entry[] }
    w.__analysis = []
    setInterval(() => {
      const p = document.querySelector('[data-testid="analysis-progress"]')
      const e: Entry = {
        tokens: p?.getAttribute('data-tokens') ?? null,
        rate: p?.getAttribute('data-rate') ?? null,
        text: p?.textContent ?? '',
        rail: document.querySelector('[data-testid="analyze-progress"]')?.textContent ?? '',
        skeleton: !!document.querySelector('[data-testid="consult-skeleton"]'),
        reveal: document.querySelectorAll('[data-testid="consult-block"][data-reveal]').length,
      }
      if (JSON.stringify(w.__analysis.at(-1)) !== JSON.stringify(e)) w.__analysis.push(e)
    }, 50)
  })
  const panel = page.getByTestId('consult-panel')
  const status = panel.getByTestId('consult-status')
  await expect(status).toContainText('NOT RUN', { timeout: 20_000 })
  const analyzed = Date.now()
  await analyzeButton(page).click()
  const analysis = page.getByTestId('analysis-panel')
  await expect(analysis).toBeVisible()
  await expect(analysis.getByTestId('analysis-progress')).toBeVisible({ timeout: 20_000 })
  await shot(page, testInfo, '05-analyzing')
  await expect(status).toContainText('READY FOR REVIEW', { timeout: 60_000 })
  testInfo.annotations.push({ type: 'timing', description: `Analyze with Mana, click to READY FOR REVIEW: ${Date.now() - analyzed} ms (mock-llm stand-in streaming for 6 s after 2.5 s; not a product timing)` })
  const trace = await page.evaluate(() => (window as unknown as { __analysis: { tokens: string | null; rate: string | null; text: string; rail: string; skeleton: boolean; reveal: number }[] }).__analysis)
  const tokens = trace.map((e) => e.tokens).filter((t): t is string => t !== null).map(Number)
  // While the stand-in "read", the server's count was 0, said as such; then the count the server reported rose, value after value.
  expect(trace.some((e) => e.tokens === '0' && e.text.startsWith('Reading what was sent')), `“Reading what was sent” while the count was 0 (seen: ${tokens.join(', ')})`).toBe(true)
  const written = [...new Set(tokens.filter((n) => n > 0))]
  expect(written.length, `the token count advanced (seen: ${tokens.join(', ')})`).toBeGreaterThanOrEqual(2)
  expect(written, 'the token count only grew').toEqual([...written].sort((a, b) => a - b))
  expect(trace.some((e) => /^[\d,]+ tokens( · [\d,]+ tokens\/s)? · at most [\d,]+ tokens$/.test(e.text)), 'the count, the speed where known, and the cap').toBe(true)
  expect(trace.some((e) => e.rate !== null), 'a writing speed from two successive reports').toBe(true)
  expect(trace.some((e) => /^Writing the draft · [\d,]+ tokens · \d+:\d{2}$/.test(e.rail)), 'the rail line says the same').toBe(true)
  // Placeholders while it wrote (bars only, no words), then the sections revealed in order once the real result arrived.
  expect(trace.some((e) => e.skeleton), 'section placeholders while the model wrote').toBe(true)
  await expect(panel.getByTestId('consult-skeleton')).toHaveCount(0)
  expect(trace.some((e) => e.reveal > 0), 'the sections revealed once the result arrived').toBe(true)
  // The stand-in was asked for a stream (as llama-server is), and the draft is the stream put together.
  const draftCalls = (await llmCalls()).calls.slice(callsBefore).filter((c) => !c.kind)
  expect(draftCalls.length, 'one draft asked of the model').toBe(1)
  expect(draftCalls[0]!.stream, 'the draft was asked for as a stream').toBe(true)
  // What reached the model, as the server counted it from what it sent: the stethoscope never.
  const used = analysis.getByTestId('mana-analyzed')
  await expect(used.getByRole('heading', { name: 'Mana analyzed' })).toBeVisible()
  const input = (key: string) => used.locator(`li[data-input="${key}"]`)
  await expect(input('conversation')).toHaveAttribute('data-sent', 'true')
  await expect(input('conversation')).toContainText(`Conversation (${confirmedCount} confirmed point${confirmedCount === 1 ? '' : 's'})`)
  await expect(input('history')).toHaveAttribute('data-sent', 'true')
  await expect(input('history')).toContainText('1 allergy')
  await expect(input('history')).toContainText('1 medicine on the list')
  await expect(input('note')).toHaveAttribute('data-sent', 'true')
  await expect(input('note')).toContainText('the reason for the visit')
  await expect(input('vitals')).toHaveAttribute('data-sent', 'true')
  await expect(input('vitals')).toContainText('staff')
  // The simulator's values are never sent.
  await expect(input('vitals')).not.toContainText('device')
  await expect(input('thermal')).toHaveAttribute('data-sent', 'true')
  await expect(input('thermal')).toContainText('1 approved image')
  await expect(input('stethoscope')).toHaveAttribute('data-sent', 'false')
  await expect(input('stethoscope')).toContainText('recordings are not analysed')
  await expect(used.getByTestId('mana-analyzed-total')).toHaveText(/^\d+ sources? sent to the local model$/)
  await expect(used).not.toContainText(/\bnone\b/i)

  // ---- 8. THE DOCTOR'S REVIEW: the medication consideration beside the prescription, accepted and added to the Plan; the summary's
  // statements accepted, edited and rejected; the accepted and the edited added to the note. Nothing reaches the record without the doctor. ----
  const ack = async (s: Locator) => {
    const b = s.getByLabel('I have checked this against the record')
    if (await b.count()) await b.check({ timeout: 10_000 })
  }
  const lane = page.getByTestId('rx-ai-lane')
  await expect(lane.getByTestId('rx-no-ai')).toContainText('No AI prescription suggestions.')
  const consideration = lane.getByTestId('rx-considerations').getByTestId('consult-statement').first()
  await expect(consideration).toContainText('Check the medicines in the record against the recorded allergy before anything is added.')
  const plan = page.getByLabel('Plan', { exact: true })
  await ack(consideration)
  await consideration.getByRole('button', { name: 'Accept' }).click()
  await expect(consideration).toHaveAttribute('data-decision', 'accepted')
  await expect(plan).toHaveValue('')
  await consideration.getByRole('button', { name: 'Add to note' }).click()
  await expect(consideration).toContainText('In the note', { timeout: 15_000 })
  await expect(plan).toHaveValue(/Check the medicines in the record against the recorded allergy/)
  const statement = (section: string) => panel.locator(`[data-testid="consult-statement"][data-section="${section}"]`).first()
  const accepted = statement('presenting_problem')
  await expect(accepted).toContainText(TODAY)
  await ack(accepted)
  await accepted.getByRole('button', { name: 'Accept' }).click()
  await expect(accepted).toHaveAttribute('data-decision', 'accepted')
  const edited = statement('observations')
  const editedText = 'Edited by the doctor (synthetic): febrile, breathing a little fast, no distress.'
  await edited.getByRole('button', { name: 'Edit' }).click()
  await edited.getByLabel('Edit before accepting').fill(editedText)
  await ack(edited)
  await edited.getByRole('button', { name: 'Save edited text' }).click()
  await expect(edited).toHaveAttribute('data-decision', 'edited')
  const rejected = statement('potential_considerations')
  await rejected.getByRole('button', { name: 'Reject' }).click()
  await expect(rejected).toHaveAttribute('data-decision', 'rejected')
  await expect(rejected.getByRole('button', { name: 'Add to note' })).toHaveCount(0)
  const hpi = page.getByLabel('History of present illness')
  await accepted.getByLabel('Add to note section').selectOption('history')
  await accepted.getByRole('button', { name: 'Add to note' }).click()
  await expect(accepted).toContainText('In the note', { timeout: 15_000 })
  await expect(hpi).toHaveValue(new RegExp(TODAY))
  const insertedText = (await hpi.inputValue()).trim()
  await edited.getByLabel('Add to note section').selectOption('examination')
  await edited.getByRole('button', { name: 'Add to note' }).click()
  await expect(edited).toContainText('In the note', { timeout: 15_000 })
  await expect(page.getByLabel('Examination', { exact: true })).toHaveValue(editedText)
  // The AI wrote no diagnosis and no prescription.
  const rx = page.getByRole('region', { name: 'Prescription', exact: true })
  await expect(page.getByRole('region', { name: 'Diagnosis', exact: true })).toContainText('No diagnosis yet.')
  await expect(rx).toContainText('No medicines prescribed.')

  // ---- 9. THE DOCTOR WRITES the diagnosis, and repeats the current medicine from the medicine list (the doctor's act: the row is then the
  // doctor's own, with the duration left for the doctor). ----
  await page.getByRole('button', { name: 'Add diagnosis' }).click()
  await page.getByLabel('Diagnosis 1', { exact: true }).fill('Viral chest infection with wheeze (synthetic)')
  await rx.getByRole('button', { name: 'Repeat a current medicine' }).click()
  const repeatMenu = page.getByRole('menu', { name: 'Repeat a current medicine' })
  const salbutamol = repeatMenu.getByRole('menuitem').filter({ hasText: 'Salbutamol inhaler 100 mcg per puff Inhaler' })
  await expect(salbutamol).toContainText('2 puffs with a spacer · Inhaled · When needed for wheeze · on the list')
  await salbutamol.click()
  await expect(repeatMenu).toHaveCount(0)
  const medicine = rx.getByLabel('Medicine', { exact: true })
  await expect(medicine).toHaveValue('Salbutamol inhaler')
  await expect(medicine).toBeFocused()
  await expect(rx.getByLabel('Strength', { exact: true })).toHaveValue('100 mcg per puff')
  await expect(rx.getByLabel('Duration', { exact: true })).toHaveValue('')
  await expect(page.getByText('Medicine 1 filled from the medicine list. Check each field and add the duration.')).toBeVisible()
  await rx.getByLabel('Duration', { exact: true }).fill('5 days')
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 15_000 })
  // Chosen again, the menu says the medicine is already in this prescription.
  await rx.getByRole('button', { name: 'Repeat a current medicine' }).click()
  await expect(repeatMenu.getByRole('menuitem').filter({ hasText: 'Salbutamol inhaler' })).toContainText('already in this prescription')
  await page.keyboard.press('Escape')
  await expect(repeatMenu).toHaveCount(0)

  // ---- 10. THE PAGE AT SIX SIZES, with everything above on it: a screenshot each, no sideways scrolling, WCAG 2.2 AA. ----
  for (const size of SIZES) {
    await page.setViewportSize(size)
    await page.waitForTimeout(300)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expectNoHorizontalOverflow(page)
    await shot(page, testInfo, '06-journey')
    await expectNoAxeViolations(page)
  }
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.evaluate(() => window.scrollTo(0, 0))

  // ---- 11. PREVIEW & PRINT: saved first, then the existing print page in a new tab, a draft that is not a valid prescription. ----
  await expect(rx.getByTestId('print-preview')).toHaveAccessibleName('Preview & print the prescription (saves first, then opens in a new tab)')
  const [preview] = await Promise.all([page.context().waitForEvent('page'), rx.getByTestId('print-preview').click()])
  await preview.waitForLoadState()
  expect(new URL(preview.url()).pathname).toBe(`/print/encounters/${encounterId}`)
  await expect(preview.getByRole('note')).toHaveText('Draft — not signed · not a valid prescription')
  await expect(preview.locator('main')).toContainText('Salbutamol inhaler')
  await expect(preview.locator('main')).toContainText('Viral chest infection with wheeze (synthetic)')
  await preview.close()

  // ---- 12. SIGN: the strip's Sign leads to "Complete consultation"; the record is signed with its AI-assisted text. ----
  await stepTo(page, 'Sign')
  const complete = page.getByTestId('consultation-actions').getByRole('button', { name: 'Complete consultation' })
  await expect(complete).toBeFocused()
  await page.keyboard.press('Enter')
  const signDlg = page.getByRole('dialog', { name: 'Review and sign' })
  await expect(signDlg).toContainText('Viral chest infection with wheeze (synthetic)')
  await expect(signDlg).toContainText('Salbutamol inhaler')
  await expect(signDlg).toContainText('AI-assisted text in this note')
  await signDlg.getByLabel(/I have reviewed this record/).check()
  await signDlg.getByRole('button', { name: 'Sign and complete' }).click()
  await expect(page.getByText(/^Signed /)).toBeVisible({ timeout: 15_000 })
  openPatients = openPatients.filter((id) => id !== child.patientId)
  const signedNote = page.getByRole('region', { name: 'Consultation note' })
  await expect(signedNote).toContainText(insertedText)
  await expect(signedNote).toContainText(editedText)
  await shot(page, testInfo, '07-signed')

  // ---- 13. AUDIT: the journey by action, the demo's audio marked as synthetic in it, and no clinical free text. ----
  const events = await auditOf(admin, child.patientId)
  await sim.dispose()
  await admin.dispose()
  const has = (action: string, where: (e: AuditRow) => boolean = () => true) => events.some((e) => e.action === action && e.outcome === 'success' && where(e))
  const expected: [string, (e: AuditRow) => boolean][] = [
    ['encounter.start', () => true],
    ['ai.live_start', (e) => e.details.audioOrigin === 'demo_synthetic'],
    ['ai.audio_chunk', (e) => e.details.audioOrigin === 'demo_synthetic'],
    ['ai.transcription', () => true],
    ['ai.live_end', (e) => e.details.reason === 'doctor_stopped'],
    ['ai.extraction', () => true],
    ['ai.review', (e) => e.details.type === 'fact' && e.details.decision === 'accepted'],
    ['device.assign', (e) => e.details.simulated === true],
    ['device.ingest', (e) => e.actorRole === 'device' && e.details.simulated === true],
    ['auscultation.upload', (e) => e.details.captureMethod === 'browser_recording'],
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
  // No microphone recording was made: every live recording of this patient was the demo's.
  expect(events.filter((e) => e.action === 'ai.live_start').every((e) => e.details.audioOrigin === 'demo_synthetic')).toBe(true)
  const serialized = JSON.stringify(events).toLowerCase()
  for (const text of ['I am allergic to penicillin', 'I have had a cough and a fever for three days', insertedText, editedText, 'Check the medicines in the record', 'Viral chest infection with wheeze (synthetic)', 'Left knee (public sample image)']) {
    expect(serialized.includes(text.toLowerCase()), `the audit log holds the free text “${text}”`).toBe(false)
  }
  expect(manaRequests, 'requests to Mana chat').toEqual([])
  expect(outside, 'requests to anything but the app').toEqual([])
  testInfo.annotations.push({ type: 'video', description: testInfo.outputPath('video.webm') })
})

test('what is missing is said as missing, never as none: no allergy status, no medicine, no device, no thermal image, no recording, and what an analysis then reached', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(240_000)
  // A child with nothing recorded but today's reason for the visit: no allergy status, no medicine, no earlier consultation, no vital signs.
  const child = await handOverChild(baseURL!, { given: `Kabir${uniq()}`, allergy: false, medicine: false, earlier: false, vitals: false, consents: ['ai_recording', 'device_monitoring', 'thermal_imaging'] })
  openPatients.push(child.patientId)
  await page.setViewportSize({ width: 1366, height: 768 })
  await signIn(page, 'dr.meera')
  await startFromQueue(page, child.name)
  const banner = page.getByTestId('patient-banner')
  const conversation = module_(page, 'tools-conversation')
  const history = module_(page, 'tools-history')
  const vitals = module_(page, 'tools-devices')
  const stethoscope = module_(page, 'tools-stethoscope')
  const thermal = module_(page, 'tools-thermal')

  // The bar: the allergy status is not recorded (not "no allergies"); no vital signs, so no vital signs badge.
  await expect(banner.getByRole('list', { name: 'Allergies' })).toHaveText('Allergy status not recorded')
  await expect(banner.getByTestId('vitals-alert')).toHaveCount(0)
  // Each module says what is not there, and offers the one thing to do.
  await expect(conversation.getByTestId('summary-conversation')).toContainText('Not recorded yet')
  await expect(conversation.getByTestId('module-conversation-record')).toBeVisible()
  await expect(history.getByTestId('summary-history-allergies')).toHaveText('Allergy status not recorded')
  await expect(history.getByTestId('module-history-record-allergy')).toHaveAccessibleName('Record allergy status')
  await expect(history.getByTestId('summary-history')).toContainText('No previous consultation found · No open condition recorded · No current medicines recorded')
  await expect(vitals.getByTestId('summary-vitals')).toContainText('No vital signs recorded for this visit yet')
  await expect(vitals.getByTestId('summary-vitals')).toHaveAttribute('data-devices', 'none', { timeout: 15_000 })
  await expect(vitals.getByTestId('summary-vitals')).toContainText('No device attached')
  await expect(vitals.getByTestId('module-vitals-attach')).toBeVisible()
  await expect(stethoscope.getByTestId('summary-stethoscope')).toContainText('No recording yet')
  await expect(stethoscope.getByTestId('module-stethoscope-record')).toBeVisible()
  await expect(thermal.getByTestId('summary-thermal-images')).toHaveText('Thermal image not captured')
  await expect(thermal.getByTestId('module-thermal-capture')).toBeVisible()
  await expect(thermal.getByTestId('module-thermal-research')).toBeVisible()
  for (const key of ['conversation', 'history', 'vitals', 'stethoscope', 'thermal']) await expect(page.getByTestId(`summary-${key}`)).not.toContainText(/\bnone\b|\b0 (current medicines?|open conditions?|recordings?|images?)\b/i)
  await expectNoHorizontalOverflow(page)
  await shot(page, testInfo, 'missing-01-open')
  await expectNoAxeViolations(page)

  // The prescription's "Repeat a current medicine" offers nothing, and says why.
  const rx = page.getByRole('region', { name: 'Prescription', exact: true })
  await rx.getByRole('button', { name: 'Repeat a current medicine' }).click()
  const repeatMenu = page.getByRole('menu', { name: 'Repeat a current medicine' })
  await expect(repeatMenu.getByRole('menuitem')).toHaveCount(1)
  await expect(repeatMenu.getByRole('menuitem')).toHaveText('No current medicines recorded')
  await expect(repeatMenu.getByRole('menuitem')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(repeatMenu).toHaveCount(0)

  // "Record allergy status" opens the History module on its Allergies tab and its own "Add allergy" ("Record an allergy"); closed again
  // without a change.
  await history.getByTestId('module-history-record-allergy').click()
  await expect(history).toHaveAttribute('data-open', 'true')
  const allergyDlg = page.getByRole('dialog', { name: 'Record an allergy' })
  await expect(allergyDlg).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(allergyDlg).toBeHidden()
  await closeModule(page, 'tools-history')

  // The keyboard shortcuts, from Shift+? while not typing: a dialog listing them.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Shift+?')
  const keys = page.getByTestId('keyboard-shortcuts')
  await expect(keys).toBeVisible()
  await expect(keys.getByRole('table')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(keys).toBeHidden()

  // An analysis of this record: what reached the model is said input by input, and what did not reach it is said as not sent.
  const status = page.getByTestId('consult-panel').getByTestId('consult-status')
  await expect(status).toContainText('NOT RUN', { timeout: 20_000 })
  await analyzeButton(page).click()
  await expect(status).toContainText(/READY FOR REVIEW|PARTIALLY AVAILABLE/, { timeout: 60_000 })
  const used = page.getByTestId('analysis-panel').getByTestId('mana-analyzed')
  const input = (key: string) => used.locator(`li[data-input="${key}"]`)
  await expect(input('conversation')).toHaveAttribute('data-sent', 'false')
  await expect(input('conversation')).toContainText('no confirmed point was sent (the transcript and the audio never are)')
  await expect(input('note')).toHaveAttribute('data-sent', 'true')
  await expect(input('note')).toContainText('the reason for the visit')
  await expect(input('vitals')).toHaveAttribute('data-sent', 'false')
  await expect(input('vitals')).toContainText('no vital sign was sent')
  await expect(input('thermal')).toHaveAttribute('data-sent', 'false')
  await expect(input('thermal')).toContainText('no approved image was sent')
  await expect(input('stethoscope')).toHaveAttribute('data-sent', 'false')
  // The history: what reached the model of it is the allergy status line ("not recorded"), or nothing on allergies, said so.
  await expect(input('history')).toContainText(/the allergy status|nothing on allergies|nothing from the record was sent/)
  await expect(used).not.toContainText(/\bnone\b/i)
  // Nothing in the draft claims the child has no allergies: the record does not say so (consult-checks-v3 removes such a statement).
  await expect(page.getByTestId('consult-panel')).not.toContainText(/no known allergies|\bNKDA\b|no drug allergies/i)
  await page.evaluate(() => window.scrollTo(0, 0))
  await expectNoHorizontalOverflow(page)
  await shot(page, testInfo, 'missing-02-analyzed')
  await expectNoAxeViolations(page)
})
