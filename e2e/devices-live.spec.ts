import { type APIRequestContext, expect, type Page, request as pwRequest, test } from '@playwright/test'
import { DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, signIn, uniq } from './support.ts'

// Slice V5 in a real browser, against the real API and database. NO DEVICE IS USED: the "gateway" is this test posting to the gateway API with a
// device record's token, and the values are fixed numbers written here. A record registered as a SIMULATOR is shown as SIMULATED everywhere;
// a record registered as a gateway device stands for a device a gateway would post for (its values here are test payloads, shown as unverified).
// The end-to-end API runs with short limits (playwright.config.ts: live for 6 seconds, disconnected after 14) so that the states can be watched.

const card = (page: Page) => page.getByTestId('device-readings')
const attached = (page: Page) => card(page).getByTestId('attached-device')
const tile = (page: Page, kind: string) => card(page).locator(`[data-testid="device-reading"][data-kind="${kind}"]`)
const WAV = Buffer.from('RIFF$\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0data\0\0\0\0', 'binary')
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 412, height: 915 },
  { width: 390, height: 844 },
]

async function staff(baseURL: string, username: string): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username, password: DEMO_PASSWORD } })).ok()).toBe(true)
  return api
}

/** An administrator registers a record and issues its gateway token; the token is used by this test as a gateway would use it. */
async function register(baseURL: string, o: { kind: 'wearable_band' | 'smart_stethoscope'; integration: 'gateway_api' | 'simulator'; label: string }) {
  const admin = await staff(baseURL, 'admin')
  const d = await (await admin.post('/api/admin/devices', { data: { kind: o.kind, label: o.label, serialNumber: `E2E-${uniq()}`, integration: o.integration } })).json()
  const { token } = await (await admin.post(`/api/admin/devices/${d.id}/token`)).json()
  await admin.dispose()
  const gateway = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}`, 'x-adaxai-csrf': '1' } })
  return {
    id: d.id as string,
    label: o.label,
    heartbeat: () => gateway.post('/api/device-ingest/heartbeat', { data: {} }),
    send: (readings: { kind: string; value: number }[]) => gateway.post('/api/device-ingest/readings', { data: { measuredAt: new Date().toISOString(), readings } }),
    recording: (site: string) => gateway.post('/api/device-ingest/auscultations', { multipart: { recordedAt: new Date().toISOString(), site, durationMs: '900', file: { name: 'tones.wav', mimeType: 'audio/wav', buffer: WAV } } }),
    dispose: () => gateway.dispose(),
  }
}

async function openConsultation(page: Page, patientName: string) {
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: patientName }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}/)
  await expect(card(page)).toBeVisible()
}

async function attach(page: Page, label: string) {
  await card(page).getByRole('button', { name: 'Attach a device' }).click()
  const dlg = page.getByRole('dialog', { name: 'Attach a device' })
  const option = dlg.locator('option', { hasText: label })
  await expect(option).toBeAttached()
  await dlg.getByLabel('Device').selectOption((await option.getAttribute('value'))!)
  return dlg
}

/** Keeps a gateway doing something every `ms` until stopped (so that a state holds while screenshots are taken). */
function every(ms: number, fn: () => Promise<unknown>) {
  let on = true
  const done = (async () => {
    while (on) {
      await fn().catch(() => undefined)
      await new Promise((r) => setTimeout(r, ms))
    }
  })()
  return async () => {
    on = false
    await done
  }
}

test('a simulator’s values reach the consultation marked SIMULATED: live, then stale, then disconnected; never in the visit’s vital signs; blood pressure is refused', async ({ page, baseURL, isMobile }) => {
  test.skip(isMobile, 'desktop project only')
  test.setTimeout(150_000)
  const p = await nurseHandsOverPatient(baseURL!, { consents: ['device_monitoring'] })
  const sim = await register(baseURL!, { kind: 'wearable_band', integration: 'simulator', label: `Simulator band ${uniq()}` })
  await openConsultation(page, p.name)

  // Nothing attached: said plainly, with no value anywhere.
  await expect(card(page).getByTestId('device-none')).toContainText('Unavailable. No device is attached to this patient.')
  await expect(card(page)).toContainText('Blood pressure is not accepted from devices.')

  // The doctor attaches it in the consultation, and is told what it is before doing so.
  const dlg = await attach(page, sim.label)
  await expect(dlg.getByText('This is a simulator, not a device.')).toBeVisible()
  await dlg.getByRole('button', { name: 'Attach' }).click()
  await expect(attached(page)).toHaveAttribute('data-simulated', 'true')
  await expect(attached(page).getByTestId('simulated-badge')).toHaveText('SIMULATED')
  await expect(attached(page)).toContainText('They are not measurements of this patient and are not part of the record.')

  // Never heard from: disconnected, and every kind says "No reading" rather than showing a number.
  await expect(attached(page)).toHaveAttribute('data-state', 'disconnected')
  await expect(attached(page).getByTestId('device-contact')).toHaveText('No contact from its gateway yet')
  await expect(tile(page, 'heart_rate')).toContainText('No reading')

  // In contact, nothing sent: no data.
  expect((await sim.heartbeat()).ok()).toBe(true)
  await expect(attached(page)).toHaveAttribute('data-state', 'no_data', { timeout: 15_000 })
  await expect(attached(page).getByTestId('device-reason')).toHaveText('The gateway is in contact but has sent no reading since the device was attached.')

  // Blood pressure from a device is refused, whole batch.
  const bp = await sim.send([{ kind: 'heart_rate', value: 71 }, { kind: 'systolic_bp', value: 128 }])
  expect(bp.status()).toBe(422)
  expect((await bp.json()).error).toBe('kind_not_allowed')

  // Values arrive: live, each with its time, each marked simulated; a value outside the adult range is NOT flagged, because it is not a measurement.
  const stopSending = every(2000, () => sim.send([{ kind: 'heart_rate', value: 131 }, { kind: 'spo2', value: 97 }]))
  await expect(attached(page)).toHaveAttribute('data-state', 'live', { timeout: 15_000 })
  await expect(tile(page, 'heart_rate')).toHaveAttribute('data-state', 'live')
  await expect(tile(page, 'heart_rate')).toContainText('131')
  await expect(tile(page, 'heart_rate')).toContainText('Simulated · not a measurement')
  await expect(tile(page, 'heart_rate')).toContainText(/Measured \d/)
  await expect(tile(page, 'heart_rate')).not.toContainText('High')
  await expect(tile(page, 'temperature')).toContainText('No reading')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // The visit's own vital signs are what the nurse measured (92): the simulator's 131 is not among them, here or in the banner.
  await page.reload()
  await expect(card(page)).toBeVisible()
  await expect(page.getByTestId('vitals-tiles')).toContainText('92')
  await expect(page.getByTestId('vitals-tiles')).not.toContainText('131')
  await expect(page.getByTestId('patient-banner')).not.toContainText('131')
  await expect(attached(page)).toHaveAttribute('data-state', 'live', { timeout: 15_000 })
  await stopSending()

  // The gateway stays in contact and sends nothing more: stale, the last value still shown with its time.
  const stopBeating = every(2500, () => sim.heartbeat())
  await expect(attached(page)).toHaveAttribute('data-state', 'stale', { timeout: 20_000 })
  await expect(tile(page, 'heart_rate')).toHaveAttribute('data-state', 'stale')
  await expect(tile(page, 'heart_rate')).toContainText('131')
  await expect(tile(page, 'heart_rate')).toContainText(/Last measured \d/)
  await stopBeating()

  // Silence: disconnected, and the screen says the value is the last one received.
  await expect(attached(page)).toHaveAttribute('data-state', 'disconnected', { timeout: 30_000 })
  await expect(attached(page).getByTestId('device-reason')).toContainText('Any value shown is the last one received.')
  await expect(tile(page, 'heart_rate')).toHaveAttribute('data-state', 'disconnected')

  // The doctor ends the assignment: nothing is attached, and a later value is refused.
  await attached(page).getByRole('button', { name: /^End/ }).click()
  const confirm = page.getByRole('dialog', { name: 'End this assignment?' })
  await expect(confirm).toContainText('What its gateway measures from now on is refused.')
  await confirm.getByRole('button', { name: 'End assignment' }).click()
  await expect(card(page).getByTestId('device-none')).toBeVisible()
  expect((await (await sim.send([{ kind: 'heart_rate', value: 80 }])).json()).error).toBe('outside_assignment')
  await sim.dispose()
})

test('readings posted for a gateway device are shown as unverified device values, flagged like any value, and never as simulated', async ({ page, baseURL, isMobile }) => {
  test.skip(isMobile, 'desktop project only')
  test.setTimeout(120_000)
  const p = await nurseHandsOverPatient(baseURL!, { consents: ['device_monitoring'] })
  // A record of a device a gateway would post for. No such device exists: the values below are this test's payloads.
  const band = await register(baseURL!, { kind: 'wearable_band', integration: 'gateway_api', label: `Band under test ${uniq()}` })
  await openConsultation(page, p.name)
  const dlg = await attach(page, band.label)
  await expect(dlg.getByText('This is a simulator, not a device.')).toHaveCount(0)
  await dlg.getByRole('button', { name: 'Attach' }).click()
  await expect(attached(page)).toHaveAttribute('data-simulated', 'false')
  await expect(attached(page).getByTestId('simulated-badge')).toHaveCount(0)

  const stop = every(2000, () => band.send([{ kind: 'heart_rate', value: 118 }, { kind: 'spo2', value: 96 }]))
  await expect(tile(page, 'heart_rate')).toHaveAttribute('data-state', 'live', { timeout: 15_000 })
  await expect(tile(page, 'heart_rate')).toContainText('118')
  await expect(tile(page, 'heart_rate')).toContainText('Device · unverified')
  await expect(tile(page, 'heart_rate')).toContainText('High')
  await expect(tile(page, 'spo2')).toContainText('96')
  await expectNoAxeViolations(page)

  // The visit's vital signs: the nurse measured the heart rate (92), so that stands; nobody measured oxygen saturation, so the device's value
  // stands there, and says what it is.
  await page.reload()
  const tiles = page.getByTestId('vitals-tiles')
  await expect(tiles).toContainText('92')
  await expect(tiles).not.toContainText('118')
  await expect(tiles.getByRole('listitem').filter({ hasText: 'SpO₂' })).toContainText('device, unverified')
  await expect(page.getByTestId('patient-banner')).toContainText('from a device that is not validated')
  await stop()
  await band.dispose()
})

test('a stethoscope recording is made in the browser from an audio input, and a simulator’s recording is marked SIMULATED AUDIO', async ({ page, baseURL, isMobile }) => {
  test.skip(isMobile, 'desktop project only')
  test.setTimeout(120_000)
  const p = await nurseHandsOverPatient(baseURL!, { consents: ['device_monitoring'] })
  const steth = await register(baseURL!, { kind: 'smart_stethoscope', integration: 'simulator', label: `Simulator stethoscope ${uniq()}` })
  await openConsultation(page, p.name)
  const recordings = page.getByRole('region', { name: 'Stethoscope recordings' })
  await expect(recordings).toContainText('No stethoscope has been connected to or tested with this system')

  // Recorded in the browser (Chromium's synthetic audio input stands in for an input device).
  await recordings.getByRole('button', { name: 'Record', exact: true }).click()
  const rec = page.getByRole('dialog', { name: 'Record from an audio input' })
  await expect(rec).toContainText('it cannot tell what an input is')
  await rec.getByRole('button', { name: 'Start recording' }).click()
  await expect(rec.getByTestId('auscultation-recording')).toContainText('Recording…')
  await page.waitForTimeout(1500)
  await rec.getByRole('button', { name: 'Stop' }).click()
  await expect(rec.getByText(/Recorded \d+\.\d s\. Listen before saving:/)).toBeVisible()
  await rec.getByLabel('Site').selectOption('aortic')
  await expectNoAxeViolations(page)
  await rec.getByRole('button', { name: 'Save recording' }).click()
  const mine = recordings.locator('[data-testid="auscultation"][data-capture="browser_recording"]')
  await expect(mine).toContainText('Aortic area')
  await expect(mine.getByTestId('auscultation-capture')).toContainText('Recorded in the browser')
  await expect(mine.getByTestId('auscultation-capture')).toContainText('as named by the browser')
  await expect(mine.locator('audio')).toHaveAttribute('src', /\/api\/files\//)
  await expect(mine.getByTestId('simulated-badge')).toHaveCount(0)

  // The simulator stethoscope is attached and its "gateway" sends generated audio: stored and shown as simulated, never as a recording of the patient.
  const dlg = await attach(page, steth.label)
  await dlg.getByRole('button', { name: 'Attach' }).click()
  await expect(attached(page)).toContainText('This kind of device sends no readings.')
  const sent = await steth.recording('mitral')
  expect(sent.status()).toBe(201)
  expect(await sent.json()).toMatchObject({ simulated: true })
  await page.reload()
  const simulated = page.getByRole('region', { name: 'Stethoscope recordings' }).locator('[data-testid="auscultation"][data-simulated="true"]')
  await expect(simulated.getByTestId('simulated-badge')).toHaveText('SIMULATED AUDIO')
  await expect(simulated).toContainText('Generated tones from a simulator: not a body sound')
  await expect(simulated.getByTestId('auscultation-capture')).toContainText('Sent by a device gateway')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
  await steth.dispose()
})

test('device states at five widths: none attached, simulated live, stale, disconnected, and a gateway device’s unverified values; nothing overflows', async ({ page, baseURL, isMobile }, testInfo) => {
  test.skip(isMobile, 'desktop project only')
  test.setTimeout(300_000)
  const p = await nurseHandsOverPatient(baseURL!, { consents: ['device_monitoring'] })
  const sim = await register(baseURL!, { kind: 'wearable_band', integration: 'simulator', label: 'Simulator band (states)' })
  const band = await register(baseURL!, { kind: 'wearable_band', integration: 'gateway_api', label: 'Band under test (states)' })
  await openConsultation(page, p.name)

  const shot = async (label: string) => {
    for (const size of WIDTHS) {
      await page.setViewportSize(size)
      await page.waitForTimeout(250)
      await expectNoHorizontalOverflow(page)
      // Nothing inside a reading tile sticks out of it (the longest state word in the narrowest tile).
      const sticking = await card(page).evaluate((root) =>
        [...root.querySelectorAll('[data-testid="device-reading"]')].flatMap((t) => {
          const box = t.getBoundingClientRect()
          return [...t.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > box.right + 0.5).map((el) => `${t.getAttribute('data-kind')}: ${(el.textContent ?? '').trim().slice(0, 30)}`)
        }),
      )
      expect(sticking, `${label} at ${size.width}px`).toEqual([])
      await card(page).scrollIntoViewIfNeeded()
      // The crop is taken with the page's own sticky and fixed bars (the consultation header, the action bar) out of the way: a card taller than the
      // window would otherwise have them drawn over it. The full-page screenshot below keeps them.
      await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="device-readings"]')
        for (const el of document.querySelectorAll<HTMLElement>('body *')) {
          const position = getComputedStyle(el).position
          if ((position === 'fixed' || position === 'sticky') && !el.contains(panel) && !panel?.contains(el)) {
            el.dataset.shotHidden = el.style.visibility
            el.style.visibility = 'hidden'
          }
        }
      })
      await card(page).screenshot({ path: testInfo.outputPath(`devices-${label}-${size.width}-panel.png`) })
      await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>('[data-shot-hidden]')) {
          el.style.visibility = el.dataset.shotHidden ?? ''
          delete el.dataset.shotHidden
        }
      })
    }
    await page.setViewportSize(WIDTHS[0]!)
    await page.screenshot({ path: testInfo.outputPath(`devices-${label}-1440.png`), fullPage: true })
  }

  await expect(card(page).getByTestId('device-none')).toBeVisible()
  await shot('1-none')

  await (await attach(page, sim.label)).getByRole('button', { name: 'Attach' }).click()
  await expect(attached(page)).toHaveAttribute('data-state', 'disconnected')
  await shot('2-attached-never-seen')

  let stop = every(1500, () => sim.send([{ kind: 'heart_rate', value: 74 }, { kind: 'spo2', value: 97 }, { kind: 'temperature', value: 36.8 }, { kind: 'respiratory_rate', value: 16 }]))
  await expect(attached(page)).toHaveAttribute('data-state', 'live', { timeout: 15_000 })
  await shot('3-simulated-live')
  await expectNoAxeViolations(page)
  await stop()

  stop = every(2500, () => sim.heartbeat())
  await expect(attached(page)).toHaveAttribute('data-state', 'stale', { timeout: 20_000 })
  await shot('4-simulated-stale')
  await stop()

  await expect(attached(page)).toHaveAttribute('data-state', 'disconnected', { timeout: 30_000 })
  await shot('5-simulated-disconnected')
  await expectNoAxeViolations(page)

  // A second record beside it: a gateway device, with values this test posts for it.
  await (await attach(page, band.label)).getByRole('button', { name: 'Attach' }).click()
  await expect(attached(page)).toHaveCount(2)
  stop = every(1500, () => band.send([{ kind: 'heart_rate', value: 118 }, { kind: 'spo2', value: 93 }]))
  await expect(attached(page).filter({ hasText: band.label })).toHaveAttribute('data-state', 'live', { timeout: 15_000 })
  await shot('6-gateway-device-live-beside-simulator')
  await expectNoAxeViolations(page)
  await stop()
  await sim.dispose()
  await band.dispose()
})
