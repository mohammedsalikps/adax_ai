import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect, type Page, request as pwRequest, test } from '@playwright/test'
import { simulateThermalMatrix, thermalStats } from '../packages/contracts/src/thermalSim.ts'
import { DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, signIn } from './support.ts'

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

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'desktop project only (tablet-landscape sizes are set here)'))

test('thermal imaging in the consultation: no camera in a browser, a SIMULATED capture measured and summarised but never put in the note, and an imported FLIR image reviewed and added to the examination', async ({ page, baseURL }) => {
  test.skip(!fs.existsSync(path.join(SAMPLES, 'flir_example.jpg')), 'thermal sample images not fetched (npm run setup)')
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  const p = await openConsultation(page, baseURL!)
  const encounterId = /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!

  // The tools column has a Thermal part; in a browser it says plainly that no camera can be reached.
  await page.getByRole('navigation', { name: 'Go to' }).getByRole('button', { name: 'Thermal' }).click()
  await expect(page.locator('#tools-thermal')).toBeFocused()
  const panel = page.getByTestId('thermal-panel')
  await expect(page.getByTestId('thermal-panel-camera')).toContainText('FLIR ONE not connected')
  await expect(panel).toContainText('No thermal image in this consultation.')

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
  await expect(dash.getByTestId('thermal-model-status')).toHaveAttribute('data-available', 'false')
  await expect(dash.getByTestId('thermal-model-status')).toContainText('MODEL UNAVAILABLE')
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
  await dlg.getByLabel('Body region').fill('Left knee (public sample image)')
  await dlg.getByRole('button', { name: 'Import and extract' }).click()
  await expect(dash.getByTestId('thermal-source')).toHaveAttribute('data-source', 'gallery_import', { timeout: 30_000 })
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
  // Nothing reached the note until the doctor adds it.
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  await expect(page.getByLabel('Examination')).toHaveValue('')
  await page.getByTestId('thermal-panel-study').filter({ has: page.locator('[data-source="gallery_import"]') }).click()
  await ws.getByRole('region', { name: 'Thermal summary' }).getByTestId('thermal-summary-insert').getByRole('button', { name: 'Add to Examination' }).click()
  await expect(ws.getByRole('region', { name: 'Thermal summary' }).getByTestId('thermal-summary-insert')).toContainText('In the note')
  await ws.getByRole('button', { name: 'Back to the consultation' }).click()
  await expect(page.getByLabel('Examination')).toHaveValue(/Reviewed by the doctor\./)
  await expect(page.getByRole('region', { name: 'Consultation note' })).toContainText(/thermal study summary \(thermal-summary-v1/i)
  // Diagnosis and prescription untouched by any of it.
  await expect(page.getByText('No diagnosis yet.')).toBeVisible()
  await expect(page.getByText('No medicines prescribed.')).toBeVisible()
  // The panel lists this consultation's two images, each with where it came from.
  await expect(page.getByTestId('thermal-panel-study')).toHaveCount(2)
  await expect(panel.locator('[data-source="simulator"]')).toHaveCount(1)
  await expect(panel.locator('[data-source="gallery_import"]')).toHaveCount(1)
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
