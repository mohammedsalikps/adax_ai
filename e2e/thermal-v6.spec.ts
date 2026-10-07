import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect, type Locator, type Page, request as pwRequest, test } from '@playwright/test'
import { simulateThermalMatrix, thermalStats } from '../packages/contracts/src/thermalSim.ts'
import { DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, openModule, signIn } from './support.ts'

/*
 * V6 in a real browser, against the real API and database: thermal imaging inside the doctor's consultation. NO CAMERA IS USED. A browser has
 * no way to a FLIR ONE (it is reached through the ADAXAI tablet app's native bridge, which does not exist here), so the workspace must say the
 * camera is not connected and offer no preview; the simulator stands in for a camera and everything it produces is SIMULATED; the imported
 * image is a public FLIR sample file (a real radiometric file of someone else's scene, not of this synthetic patient). Synthetic patients only.
 * A summary is composed only from an approved image, so the doctor approves each image (the viewer's own review) before composing.
 */

const SAMPLES = path.resolve(import.meta.dirname, '..', 'samples', 'thermal')
const C = (v: number | null) => `${v!.toFixed(1)} °C`

async function staff(baseURL: string, username: string): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username, password: DEMO_PASSWORD } })).ok()).toBe(true)
  return api
}

async function openConsultation(page: Page, baseURL: string) {
  const p = await nurseHandsOverPatient(baseURL, { allergies: ['Penicillin'], consents: ['thermal_imaging'] })
  await signIn(page, 'dr.meera')
  await page.goto('/doctor/queue')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}/)
  return p
}

/** Opens the study's "Details" disclosure (Doctor HERO final, DESIGN §5.7: the engineering detail behind it), unless it is open already. */
async function openStudyDetails(ws: Locator) {
  const details = ws.getByTestId('thermal-details')
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
}

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'desktop project only (tablet-landscape sizes are set here)'))

test('thermal imaging in the consultation: no camera in a browser, a SIMULATED capture measured and summarised but never put in the note, and an imported FLIR image reviewed and added to the examination', async ({ page, baseURL }) => {
  test.skip(!fs.existsSync(path.join(SAMPLES, 'flir_example.jpg')), 'thermal sample images not fetched (npm run setup)')
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  const p = await openConsultation(page, baseURL!)
  const encounterId = /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!

  // Doctor HERO final (DESIGN §5.4): thermal imaging is the workspace's compact "Thermal" panel (#tools-thermal; the rail's module 5 and its
  // thermal panel are gone). Its summary says no camera can be reached in a browser (for whoever reads it alone; the camera pane says it on
  // screen, below), and that no image was captured, never "none".
  await openModule(page, 'Thermal')
  const panel = page.locator('#tools-thermal').getByTestId('thermal-context')
  await expect(panel.getByRole('heading', { name: 'Thermal', exact: true })).toBeVisible()
  await expect(panel.getByTestId('summary-thermal-camera')).toContainText('FLIR ONE not connected')
  await expect(panel.getByTestId('summary-thermal-images')).toHaveText('Thermal image not captured')
  await expect(panel.getByTestId('thermal-source')).toHaveCount(0)

  // The workspace: this patient and this consultation; the camera not connected, no preview, no LIVE, no capture.
  await page.getByTestId('thermal-open').click()
  const ws = page.getByTestId('thermal-workspace')
  await expect(ws.getByRole('heading', { name: p.name })).toBeVisible()
  await expect(ws.getByTestId('thermal-workspace-context')).toContainText(p.mrn)
  await expect(ws.getByTestId('thermal-camera-status')).toHaveAttribute('data-state', 'disconnected')
  await expect(ws.getByTestId('thermal-no-camera')).toContainText('FLIR ONE not connected')
  await expect(ws.getByTestId('thermal-live')).toHaveCount(0)
  await expect(ws.getByTestId('thermal-preview')).toHaveAttribute('data-live', 'false')
  await expect(ws.getByTestId('thermal-capture')).toBeDisabled()
  await expectNoAxeViolations(page)

  // The simulator, playing a camera that is not there: still not connected, said so, nothing stored.
  await ws.getByText('Simulator (development and demonstrations)').click()
  await ws.getByLabel('Case').selectOption('disconnected')
  await ws.getByRole('button', { name: 'Use the simulator' }).click()
  await ws.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(ws.getByRole('alert').first()).toContainText('FLIR ONE not connected (SIMULATED')
  await expect(ws.getByTestId('thermal-capture')).toBeDisabled()
  // After a failed connect, Connect is offered again.
  await expect(ws.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()

  // A simulated camera with a localized difference: LIVE only while frames arrive, and SIMULATED; capture needs the region.
  await ws.getByRole('button', { name: 'Stop using the simulator' }).click()
  await ws.getByLabel('Case').selectOption('localized_difference')
  await ws.getByRole('button', { name: 'Use the simulator' }).click()
  await ws.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(ws.getByTestId('thermal-camera-status')).toHaveAttribute('data-state', 'previewing')
  await expect(ws.getByTestId('thermal-live')).toBeVisible()
  await expect(ws.getByTestId('thermal-preview').getByTestId('simulated-badge')).toBeVisible()
  await expect(ws.getByTestId('thermal-capture')).toBeDisabled()
  // Disconnect and connect again; with the live view then stopped (as after the tablet app is paused), the camera stays connected, is not
  // called LIVE, cannot capture, and offers "Start live view", which brings the live view back.
  await ws.getByRole('button', { name: 'Disconnect' }).click()
  await expect(ws.getByTestId('thermal-camera-status')).toHaveAttribute('data-state', 'disconnected')
  await expect(ws.getByTestId('thermal-live')).toHaveCount(0)
  await ws.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(ws.getByTestId('thermal-live')).toBeVisible()
  await ws.getByRole('button', { name: 'Stop live view' }).click()
  await expect(ws.getByTestId('thermal-camera-status')).toHaveAttribute('data-state', 'connected')
  await expect(ws.getByTestId('thermal-live')).toHaveCount(0)
  await expect(ws.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
  await ws.getByLabel('Body region').selectOption('knee')
  await expect(ws.getByTestId('thermal-capture')).toBeDisabled()
  await ws.getByRole('button', { name: 'Start live view' }).click()
  await expect(ws.getByTestId('thermal-camera-status')).toHaveAttribute('data-state', 'previewing')
  await expect(ws.getByTestId('thermal-live')).toBeVisible()
  await expect(ws.getByRole('button', { name: 'Start live view' })).toHaveCount(0)
  await ws.getByLabel('Description (optional)').fill('Right knee, anterior (synthetic)')
  await expect(ws.getByTestId('thermal-capture')).toBeEnabled()
  await ws.getByTestId('thermal-capture').click()

  // The analysis: the numbers the server stored are the simulator's own (worked out here independently), labelled SIMULATED, and never
  // called a measurement.
  const expected = thermalStats(simulateThermalMatrix('localized_difference', 1))
  const dash = ws.getByTestId('thermal-dashboard')
  await expect(dash).toBeVisible({ timeout: 20_000 })
  await expect(dash.getByTestId('thermal-source')).toHaveAttribute('data-source', 'simulator')
  await expect(dash).toContainText('Knee')
  await expect(dash).toContainText(C(expected.minC))
  await expect(dash).toContainText(C(expected.maxC))
  await expect(dash).toContainText(C(expected.meanC))
  await expect(dash).toContainText(C(expected.stdC))
  await expect(dash.getByTestId('thermal-dashboard-basis')).toHaveText('SIMULATED: generated numbers, not a measurement.')
  await expect(dash).not.toContainText('Measured from the radiometric data')
  // Doctor HERO final (DESIGN §5.7): the thermal model's status and the provenance are behind the study's one "Details" disclosure.
  await openStudyDetails(ws)
  await expect(ws.getByTestId('thermal-details').getByTestId('thermal-model-status')).toHaveAttribute('data-available', 'false')
  await expect(ws.getByTestId('thermal-details').getByTestId('thermal-model-status')).toContainText('MODEL UNAVAILABLE')
  await expect(ws.getByTestId('thermal-provenance')).toBeVisible()
  // No summary of an image that awaits review: it is composed only from an approved image, whose measurements and regions are fixed.
  const summary = ws.getByRole('region', { name: 'Thermal summary' })
  await expect(summary.getByTestId('thermal-summary-unavailable')).toContainText('Approve the image first')
  await expect(summary.getByRole('button', { name: 'Compose summary' })).toHaveCount(0)
  // Regions drawn but not saved are not thrown away without asking: leaving asks first, and "Keep editing" stays.
  await ws.getByRole('button', { name: 'Add region' }).click()
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  const unsaved = page.getByRole('dialog', { name: 'Discard the unsaved regions?' })
  await expect(unsaved).toBeVisible()
  await unsaved.getByRole('button', { name: 'Keep editing' }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(ws).toBeVisible()
  await ws.getByRole('button', { name: 'Save regions' }).click()
  // The doctor approves the image (the viewer's own review), and only then composes the summary.
  await ws.getByRole('button', { name: 'Approve measurements' }).click()
  await expect(ws.getByText('Approved', { exact: true })).toBeVisible()
  await expect(summary.getByTestId('thermal-summary-unavailable')).toHaveCount(0)
  // The summary: composed by fixed rules, labelled SIMULATED first; accepted, it still cannot go into the note.
  await summary.getByRole('button', { name: 'Compose summary' }).click()
  await expect(summary.getByTestId('thermal-summary-statement').first()).toContainText('SIMULATED')
  await expect(summary.getByTestId('thermal-summary-statement').filter({ hasText: 'No trained thermal model' })).toHaveCount(1)
  // No statement claims a diagnosis, a score, a finding of swelling or fracture, or a recommendation; the only mention of what thermal imaging
  // cannot show is the fixed limitation, which says it cannot.
  for (const s of await summary.getByTestId('thermal-summary-statement').all()) {
    if ((await s.getAttribute('data-basis')) === 'limitation') continue
    await expect(s).not.toContainText(/pain|diagnos|fracture|swelling|inflammation|X-ray|recommend/i)
  }
  await expect(summary.getByTestId('thermal-summary-statement').filter({ hasText: 'does not measure pain' })).toHaveCount(1)
  await summary.getByRole('button', { name: 'Accept' }).click()
  await expect(summary.getByTestId('thermal-summary-status')).toHaveAttribute('data-status', 'accepted')
  await expect(summary.getByTestId('thermal-summary-simulated-note')).toContainText('A simulated summary cannot be added to a consultation note.')
  await expect(summary.getByTestId('thermal-summary-insert')).toHaveCount(0)
  await expectNoHorizontalOverflow(page)

  // A capture the server cannot use (the simulator's invalid case): said plainly, nothing stored.
  await ws.getByRole('button', { name: 'Stop using the simulator' }).click()
  await ws.getByLabel('Case').selectOption('invalid_capture')
  await ws.getByRole('button', { name: 'Use the simulator' }).click()
  await ws.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(ws.getByTestId('thermal-live')).toBeVisible()
  await ws.getByTestId('thermal-capture').click()
  const failed = ws.getByRole('alert').filter({ hasText: 'Capture failed' })
  await expect(failed).toContainText('Nothing was stored.')
  await expect(failed).not.toContainText('Nothing was stored. Nothing was stored.')
  // The badge goes on saying what the camera says; the failure is its own alert.
  await expect(ws.getByTestId('thermal-camera-status')).toHaveAttribute('data-state', 'previewing')
  await expect(ws.getByRole('navigation', { name: 'Thermal images in this consultation' }).getByRole('listitem')).toHaveCount(1)
  await ws.getByRole('button', { name: 'Stop using the simulator' }).click()

  // Escape in the Import dialog closes that dialog only: the workspace stays open.
  await ws.getByRole('button', { name: 'Import a thermal image' }).click()
  const dlg = page.getByRole('dialog', { name: 'Import a thermal image' })
  await expect(dlg).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await expect(ws).toBeVisible()
  await expect(ws.getByRole('heading', { name: p.name })).toBeVisible()

  // An earlier radiometric FLIR file, imported for this consultation: IMPORTED, measured from the file, approved, its summary reviewed and added.
  await ws.getByRole('button', { name: 'Import a thermal image' }).click()
  await dlg.getByLabel(/Radiometric JPEG/).setInputFiles(path.join(SAMPLES, 'flir_example.jpg'))
  // Doctor HERO final (DESIGN §5.7): the doctor's import dialog is simplified: the body region is chosen from the fixed list, with an optional note.
  await dlg.getByLabel('Body region').selectOption('knee')
  await dlg.getByLabel('Note (optional)').fill('Left knee (public sample image)')
  await dlg.getByRole('button', { name: 'Import and extract' }).click()
  await expect(dash.getByTestId('thermal-source')).toHaveAttribute('data-source', 'gallery_import', { timeout: 30_000 })
  await openStudyDetails(ws)
  await expect(ws.getByTestId('thermal-raw-sha256')).toBeVisible()
  await expect(ws.getByTestId('thermal-raw-sha256')).toHaveText(/^[0-9a-f]{64}$/)
  await expect(dash.getByTestId('thermal-dashboard-basis')).toContainText('Measured from the radiometric data')
  await expect(summary.getByRole('button', { name: 'Compose summary' })).toHaveCount(0)
  await ws.getByRole('button', { name: 'Approve measurements' }).click()
  await expect(ws.getByText('Approved', { exact: true })).toBeVisible()
  await summary.getByRole('button', { name: 'Compose summary' }).click()
  await expect(summary.getByTestId('thermal-summary-statement').first()).toContainText('IMPORTED')
  await summary.getByRole('button', { name: 'Edit' }).click()
  await summary.getByLabel('Edit the summary before accepting').fill('Thermal image (imported, public sample): skin-surface temperatures as measured; no asymmetry assessed. Reviewed by the doctor.')
  await summary.getByRole('button', { name: 'Save edited text' }).click()
  await expect(summary.getByTestId('thermal-summary-status')).toHaveAttribute('data-status', 'edited')
  // Nothing reached the note until the doctor adds it. (Doctor HERO final: the typed note is the Keyboard tab of Doctor notes.)
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  const notes = page.getByTestId('doctor-notes')
  await notes.getByRole('tab', { name: 'Structured' }).click()
  await expect(page.getByLabel('Examination')).toHaveValue('')
  // The imported image is opened again from the thermal panel (Open thermal imaging, then that image in the workspace's list of this
  // consultation's images: the panel itself shows only the newest image now).
  await panel.getByTestId('thermal-open').click()
  await ws.getByRole('navigation', { name: 'Thermal images in this consultation' }).getByRole('button').filter({ has: page.locator('[data-source="gallery_import"]') }).click()
  await expect(dash.getByTestId('thermal-source')).toHaveAttribute('data-source', 'gallery_import')
  await ws.getByRole('region', { name: 'Thermal summary' }).getByTestId('thermal-summary-insert').getByRole('button', { name: 'Add to Examination' }).click()
  await expect(ws.getByRole('region', { name: 'Thermal summary' }).getByTestId('thermal-summary-insert')).toContainText('In the note')
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  await expect(page.getByLabel('Examination')).toHaveValue(/Reviewed by the doctor\./)
  // Doctor HERO final (DESIGN §5.7): the inserted summary was composed by fixed rules, and says so ("Rule-composed text", not AI).
  await expect(notes).toContainText(/Rule-composed text from thermal study summary \(thermal-summary-v1/i)
  // Diagnosis and prescription untouched by any of it (Doctor HERO final: they are on the prescription page, so they are read from the record).
  const record = await (await page.request.get(`/api/encounters/${encounterId}`)).json()
  expect(record.diagnoses).toEqual([])
  expect(record.prescription).toEqual([])
  // The thermal panel counts this consultation's two images (both approved), and the thermal workspace lists them, each with where it came from.
  await expect(panel.getByTestId('summary-thermal-images')).toHaveText('Images: 2 (approved 2)')
  await panel.getByTestId('thermal-open').click()
  const list = ws.getByRole('navigation', { name: 'Thermal images in this consultation' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await expect(list.locator('[data-source="simulator"]')).toHaveCount(1)
  await expect(list.locator('[data-source="gallery_import"]')).toHaveCount(1)
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  await expect(ws).toHaveCount(0)
  await page.setViewportSize({ width: 1024, height: 768 })
  await expectNoHorizontalOverflow(page)
  await expectNoAxeViolations(page)

  // The audit log (administrator, through the API): each step recorded, without image bytes or the summary's words.
  const admin = await staff(baseURL!, 'admin')
  const rows: { action: string; details?: unknown }[] = []
  let before: string | undefined
  for (let i = 0; i < 5; i++) {
    const r = await admin.get('/api/admin/audit-events', { params: { patientId: p.patientId, limit: 200, ...(before ? { before } : {}) } })
    expect(r.ok()).toBe(true)
    const body = await r.json()
    rows.push(...body.events)
    if (!body.nextBefore) break
    before = body.nextBefore
  }
  const actions = new Set(rows.map((r) => r.action))
  for (const a of ['thermal.workspace_opened', 'thermal.camera_connected', 'thermal.connect_failed', 'thermal.camera_disconnected', 'thermal.capture_failed', 'thermal.upload', 'thermal.capture_refused', 'thermal.review', 'thermal.summary_generate', 'thermal.summary_review', 'encounter.ai_insert'])
    expect(actions, a).toContain(a)
  // Opening the workspace in a browser records the path that was tried (the tablet app's bridge) and that there was none, not the simulator.
  expect(rows.find((r) => r.action === 'thermal.workspace_opened')?.details).toMatchObject({ adapter: 'native_bridge', state: 'no_bridge' })
  // A failed connect is its own event; a failed capture is a capture failure.
  expect(rows.find((r) => r.action === 'thermal.connect_failed')?.details).toMatchObject({ adapter: 'simulator' })
  expect(rows.find((r) => r.action === 'thermal.capture_failed')?.details).toMatchObject({ adapter: 'simulator', state: 'server_failed' })
  const text = JSON.stringify(rows)
  expect(text).not.toContain('Reviewed by the doctor.')
  expect(text).not.toMatch(/data:image|base64/)
  expect(rows.some((r) => r.action === 'thermal.upload' && JSON.stringify(r.details).includes('"simulator"'))).toBe(true)
  expect(rows.some((r) => r.action === 'thermal.upload' && JSON.stringify(r.details).includes('gallery_import'))).toBe(true)
  await admin.dispose()
  void encounterId
})

test('an ordinary PNG is not a dead end: “Demo image detected”, then the demo analysis dashboard with the picture, five indices, a summary and both labels', async ({ page, baseURL }) => {
  const p = await nurseHandsOverPatient(baseURL!, { consents: ['thermal_imaging'] })
  await signIn(page, 'dr.meera')
  await page.goto(`/doctor/thermal?patientId=${p.patientId}`)
  await expect(page.getByTestId('thermal-patient-name')).toContainText(p.name)
  // An ordinary picture (a warm patch on a cool background), made by the browser: no FLIR radiometric data in it.
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 120
    c.height = 90
    const g = c.getContext('2d')!
    g.fillStyle = '#1e3a8a'
    g.fillRect(0, 0, 120, 90)
    g.fillStyle = '#f97316'
    g.fillRect(70, 20, 40, 50)
    return c.toDataURL('image/png')
  })
  const png = Buffer.from(dataUrl.split(',')[1]!, 'base64')
  await page.getByTestId('thermal-upload').click()
  const dlg = page.getByRole('dialog', { name: 'Upload thermal image' })
  await dlg.getByLabel(/Radiometric JPEG/).setInputFiles({ name: 'knee-photo.png', mimeType: 'image/png', buffer: png })
  await dlg.getByLabel('Body region').selectOption('knee')
  await dlg.getByRole('button', { name: 'Upload and extract' }).click()
  // PATH B: no blocking refusal; said plainly, and the doctor continues.
  const notice = dlg.getByTestId('thermal-demo-notice')
  await expect(notice).toContainText('Demo image detected')
  await expect(notice).toContainText('Temperature metadata is unavailable. Continuing with simulated thermal analysis.')
  await expect(dlg.getByRole('alert')).toHaveCount(0)
  await expectNoAxeViolations(page)
  await dlg.getByTestId('thermal-demo-continue').click()
  const sheet = page.getByTestId('thermal-analysis-sheet')
  await expect(sheet.getByTestId('thermal-analysis')).toBeVisible({ timeout: 30_000 })
  await expect(sheet).toContainText(p.name)
  await expect(sheet).toContainText(`MRN ${p.mrn}`)
  await expect(sheet.getByTestId('thermal-analysis-demo-label')).toHaveText('Demo analysis — not clinically validated')
  await expect(sheet.getByTestId('thermal-analysis-demo-image')).toHaveText('Demo thermal analysis — temperature data not available')
  // The picture itself, as uploaded.
  const img = sheet.getByTestId('thermal-analysis-image')
  await expect(img).toHaveJSProperty('complete', true)
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(120)
  await expect(sheet.getByTestId('thermal-index')).toHaveCount(5)
  for (const label of ['Pain pattern', 'Thermal asymmetry', 'Perfusion pattern', 'Temperature pattern', 'Thermal stress']) await expect(sheet.getByTestId('thermal-index').filter({ hasText: label })).toHaveCount(1)
  await expect(sheet.getByTestId('thermal-analysis-summary')).toContainText('has no temperature data, so its values were simulated')
  await expect(sheet.getByTestId('thermal-analysis-summary')).toContainText('No clinical interpretation or diagnosis should be made')
  await expect(sheet).not.toContainText('°C')
  await expectNoAxeViolations(page)
  // Stored for the patient as simulated (never as a measurement).
  const api = await staff(baseURL!, 'dr.meera')
  const captures = (await (await api.get(`/api/patients/${p.patientId}/thermal`)).json()).captures
  expect(captures.map((c: { captureSource: string; simulated: boolean; dataOrigin: string; extractor: { name: string } }) => [c.captureSource, c.simulated, c.dataOrigin, c.extractor.name])).toEqual([['simulator', true, 'synthetic', 'demo-image']])
  await api.dispose()
})
