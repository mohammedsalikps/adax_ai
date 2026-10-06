import fs from 'node:fs'
import path from 'node:path'
import { type APIRequestContext, expect, type Locator, type Page, request as pwRequest, test } from '@playwright/test'
import { DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, signIn, uniq } from './support.ts'

/*
 * PEDIATRIC SHOCK — RESEARCH MODE (Doctor HERO, thermal module 5) in a real browser, against the real API, database and thermal service. It is
 * research only and read only: it detects, predicts and scores nothing, and no research model exists (the thermal service says none is
 * installed). Each stage of the pipeline shows the status this consultation's images and the code give it; the feature set lists the values
 * stored for the approved, non-simulated images (compared here with what the capture API returns) and says why every other image is out; the
 * published review is shown as other studies' results, never ADAXAI's. NO CAMERA IS USED: the imported images are public FLIR sample files
 * (someone else's scenes, not this synthetic child's), and the simulated one is SIMULATED.
 */

const SAMPLES = path.resolve(import.meta.dirname, '..', 'samples', 'thermal')
const APP_ORIGIN = 'http://127.0.0.1:5273'

async function staff(baseURL: string, username: string): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username, password: DEMO_PASSWORD } })).ok()).toBe(true)
  return api
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * A synthetic child, registered by the nurse through the API (its UI is covered by nurse-workflow.spec) and handed over for the consultation:
 * born on the first of the month three years and three months ago, so the record's exact age is "3 years 3 months" on any day.
 */
async function nurseHandsOverChild(baseURL: string) {
  const nurse = await staff(baseURL, 'nurse.anil')
  const now = new Date()
  const given = `Child${uniq()}`
  const patient = await (await nurse.post('/api/patients', { data: { givenName: given, familyName: 'Synthetic', dateOfBirth: ymd(new Date(now.getFullYear() - 3, now.getMonth() - 3, 1)), sex: 'female', phone: `7${String(Date.now()).slice(-9)}` } })).json()
  expect((await nurse.post(`/api/patients/${patient.id}/consents`, { data: { type: 'thermal_imaging', method: 'verbal' } })).ok()).toBe(true)
  const depts = (await (await nurse.get('/api/departments')).json()).departments
  const visit = await (await nurse.post('/api/visits', { data: { patientId: patient.id, departmentId: depts.find((d: { code: string }) => d.code === 'GEN').id, chiefComplaint: 'Fever and cold hands (synthetic)' } })).json()
  await nurse.post(`/api/visits/${visit.id}/observations`, { data: { items: [{ kind: 'temperature', value: 38.4 }] } })
  await nurse.post(`/api/visits/${visit.id}/status`, { data: { status: 'ready' } })
  await nurse.dispose()
  return { name: `${given} Synthetic`, patientId: patient.id as string }
}

type Roi = { id: string; label: string; shape: string; stats: { pixelCount: number; min: number | null; max: number | null; mean: number | null; std: number | null } }
type Capture = {
  id: string
  status: string
  simulated: boolean
  width: number
  height: number
  minC: number
  maxC: number
  meanC: number
  stdC: number | null
  parameters: { emissivity: number | null; objectDistanceM: number | null }
  protocol: { bodyRegion: string; roomTempC?: number | null; acclimatisationMin?: number | null; distanceM?: number | null }
  extractor: { name: string; version: string }
  rois: Roi[]
  pairs: { a: string; b: string; meanDiff: number | null; maxDiff: number | null }[]
}

// The page's own wording of a stored value, written out here (not imported from the page's code), so what is shown is checked against the API.
const temp = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)} °C`)
const diff = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)} °C`)
const trim = (v: number) => String(Number(v.toFixed(2)))
/** The value beside a label in one of the sheet's lists of figures (a <dt> and its <dd>). */
const valueOf = (list: Locator, label: string) => list.locator('div').filter({ has: list.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')

/** Uploads a radiometric sample file as an earlier image imported for this consultation, through the API as the workspace's import does. */
async function importSample(page: Page, patientId: string, encounterId: string, file: string, protocol: Record<string, unknown>): Promise<Capture> {
  const res = await page.request.post(`/api/patients/${patientId}/thermal`, {
    headers: { 'x-adaxai-csrf': '1' },
    // The fields come before the file: the server reads the fields that precede it.
    multipart: { captureSource: 'gallery_import', encounterId, protocol: JSON.stringify(protocol), file: { name: file, mimeType: 'image/jpeg', buffer: fs.readFileSync(path.join(SAMPLES, file)) } },
  })
  expect(res.status(), await res.text()).toBe(201)
  return res.json()
}

test.beforeEach(({ isMobile }) => test.skip(isMobile, 'desktop project only (the sizes, the phone one included, are set here)'))

let openPatient: string | null = null
test.afterEach(async ({ baseURL }) => {
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

test('pediatric shock research mode: each pipeline stage’s real status, the stored features of approved real images only, no model, and the published review as other studies’ results', async ({ page, baseURL }) => {
  test.skip(!['flir_example.jpg', 'ax8.jpg'].every((f) => fs.existsSync(path.join(SAMPLES, f))), 'thermal sample images not fetched (npm run setup)')
  test.setTimeout(240_000)
  // Nothing the page asks for may leave this computer's application: no CDN, no font, no prefetch of the DOI.
  const outside: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith(APP_ORIGIN) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url())
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  const child = await nurseHandsOverChild(baseURL!)
  openPatient = child.patientId
  await signIn(page, 'dr.meera')
  await page.goto('/doctor/queue')
  await page.getByRole('list', { name: 'Visits' }).getByRole('listitem').filter({ hasText: child.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}$/)
  const encounterId = /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]!

  const thermal = page.locator('#tools-thermal')
  const sheet = page.getByRole('dialog', { name: 'Pediatric shock research' })
  const research = sheet.getByTestId('thermal-research')
  const pipeline = research.getByTestId('research-pipeline')
  const stage = (id: string) => pipeline.locator(`li[data-stage="${id}"]`)
  const statuses = () => pipeline.locator('li[data-stage]').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-stage')}:${el.getAttribute('data-status')}`))
  /** The sheet is opened from module 5's own quick action while the module is closed, or from the thermal panel once it is open: one is shown at a time. */
  const openSheet = async () => {
    await thermal.getByRole('button', { name: 'Pediatric shock research' }).click()
    await expect(sheet).toBeVisible()
    await expect(research.getByTestId('research-header')).toBeVisible()
  }

  // ---- 1. Before any image: module 5 offers the research view; the pipeline waits for data and the feature set is empty. ----
  await expect(thermal.getByTestId('summary-thermal-research')).toContainText('Research mode available')
  await expect(thermal).toHaveAttribute('data-open', 'false')
  await openSheet()
  await expect(research.getByTestId('research-header')).toContainText('PEDIATRIC SHOCK — RESEARCH MODE')
  await expect(research.getByTestId('research-header')).toContainText('Research only. Not for clinical decisions. Nothing here detects, predicts or scores shock.')
  // The exact age from the record's date of birth, with no paediatric range to read it against; the research consent as the record has it.
  const patientFacts = research.getByTestId('research-patient')
  await expect(patientFacts).toContainText('3 years 3 months')
  await expect(patientFacts).toContainText('Paediatric vital ranges are not implemented.')
  await expect(research.getByTestId('research-consent')).toHaveText('Not recorded')
  expect(await statuses()).toEqual([
    'acquisition:depends',
    'preprocessing:depends',
    'quality:not_built',
    'extraction:depends',
    'feature-set:depends',
    'model:not_built',
    'output:not_built',
    'review:not_built',
  ])
  await expect(stage('acquisition')).toContainText('No radiometric image in this consultation yet.')
  await expect(stage('acquisition')).toContainText('Not built: Live capture in a browser: FLIR ONE not connected')
  await expect(research.getByTestId('research-features-empty')).toHaveText('No approved, non-simulated image in this consultation.')
  await expect(research.getByTestId('research-image')).toHaveCount(0)
  // Escape closes it; the module it was opened from is now open, and focus is back on the panel's own button for the sheet.
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(thermal).toHaveAttribute('data-open', 'true')
  await expect(thermal.getByTestId('thermal-research-open')).toBeFocused()

  // ---- 2. Images for this consultation, through the API as the workspace makes them: a public sample imported with its capture conditions,
  // two regions drawn and paired, then approved; a second sample imported and left for review; and a SIMULATED capture. The record now has the
  // research consent as well. ----
  const approved = await importSample(page, child.patientId, encounterId, 'flir_example.jpg', { bodyRegion: 'Left knee (public sample image)', bodySite: 'knee', view: 'anterior', roomTempC: 22, acclimatisationMin: 15, distanceM: 1 })
  const w = approved.width
  const h = approved.height
  const box = { y: Math.round(h * 0.3), width: Math.round(w * 0.15), height: Math.round(h * 0.3) }
  const rois = await page.request.put(`/api/thermal/${approved.id}/rois`, {
    headers: { 'x-adaxai-csrf': '1' },
    data: {
      rois: [
        { label: 'Left region', shape: 'rect', x: Math.round(w * 0.2), ...box, pairWith: 'Right region' },
        { label: 'Right region', shape: 'rect', x: Math.round(w * 0.65), ...box },
      ],
    },
  })
  expect(rois.ok(), await rois.text()).toBe(true)
  const review = await page.request.post(`/api/thermal/${approved.id}/review`, { headers: { 'x-adaxai-csrf': '1' }, data: { decision: 'approved' } })
  expect(review.ok(), await review.text()).toBe(true)
  const waiting = await importSample(page, child.patientId, encounterId, 'ax8.jpg', { bodyRegion: 'Right knee (public sample image)', bodySite: 'knee', view: 'anterior' })
  const sim = await page.request.post(`/api/patients/${child.patientId}/thermal/simulate`, {
    headers: { 'x-adaxai-csrf': '1' },
    data: { case: 'localized_difference', seed: 7, encounterId, protocol: { bodyRegion: 'Knee (simulated)', bodySite: 'knee', view: 'anterior' } },
  })
  expect(sim.status(), await sim.text()).toBe(201)
  const simulated = (await sim.json()) as Capture
  expect(simulated.simulated).toBe(true)
  const nurse = await staff(baseURL!, 'nurse.anil')
  expect((await nurse.post(`/api/patients/${child.patientId}/consents`, { data: { type: 'research_use', method: 'verbal' } })).ok()).toBe(true)
  await nurse.dispose()
  // What the capture API holds for this consultation now: the values the sheet must show.
  const captures = ((await (await page.request.get(`/api/patients/${child.patientId}/thermal`)).json()) as { captures: (Capture & { encounterId: string | null })[] }).captures.filter((c) => c.encounterId === encounterId)
  expect(captures).toHaveLength(3)
  const stored = captures.find((c) => c.id === approved.id)!
  expect(stored.status).toBe('approved')
  expect(stored.rois).toHaveLength(2)
  expect(stored.pairs).toHaveLength(1)

  // ---- 3. Read again (the panel reads the images when the consultation opens) and opened from the module again. ----
  await page.reload()
  await expect(thermal.getByTestId('summary-thermal-images')).toHaveText('Images: 3 (approved 1)', { timeout: 20_000 })
  // What opening the sheet asks of the server: it reads the panel's images and the record from what the page holds, and writes nothing.
  const asked: string[] = []
  const onRequest = (r: { method: () => string; url: () => string }) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/')) asked.push(`${r.method()} ${u.pathname}`)
  }
  page.on('request', onRequest)
  await openSheet()
  await expect(research.getByTestId('research-consent')).toHaveText('Granted')

  // The pipeline: what is built ran on this consultation's real images; normalisation is not built (its checks that do run are named); the
  // model, its output and their review are not built, and the pipeline stops visibly at the feature set.
  expect(await statuses()).toEqual([
    'acquisition:built',
    'preprocessing:built',
    'quality:not_built',
    'extraction:built',
    'feature-set:built',
    'model:not_built',
    'output:not_built',
    'review:not_built',
  ])
  await expect(stage('acquisition')).toContainText('2 radiometric images in this consultation.')
  await expect(stage('acquisition')).toContainText('1 simulated image in this consultation: SIMULATED, excluded.')
  await expect(stage('acquisition')).toContainText('Live capture in a browser: FLIR ONE not connected')
  await expect(stage('preprocessing')).toContainText(`${stored.extractor.name} ${stored.extractor.version}`)
  await expect(stage('quality')).toContainText('Temperature normalisation is not built.')
  await expect(stage('quality')).toContainText('(1 approved, 1 awaiting, 0 rejected)')
  await expect(stage('quality')).toContainText('recorded for 1 of 2 images')
  await expect(stage('extraction')).toContainText('Region statistics: 2 regions drawn by the doctor')
  await expect(stage('extraction')).toContainText('Pairs as A minus B: 1 pair')
  await expect(stage('feature-set')).toContainText('1 approved image, below, with the values stored for it.')
  await expect(stage('model')).toContainText('The pipeline stops at the feature set')
  await expect(stage('model')).toContainText('Research model unavailable.')
  await expect(stage('model')).toContainText('Not currently available. Research pipeline ready for model integration.')
  // The model status is the thermal service's own answer (GET /api/thermal/model-status), shown as it says it.
  const modelStatus = (await (await page.request.get('/api/thermal/model-status')).json()) as { available: boolean; reason: string | null }
  expect(modelStatus.available).toBe(false)
  await expect(stage('model').getByTestId('research-model')).toContainText('MODEL UNAVAILABLE')
  await expect(stage('model').getByTestId('research-model')).toContainText(modelStatus.reason!)
  await expect(stage('output')).toContainText('None: there is no research model, so there is no research output.')

  // The feature set: only the approved, non-simulated image, with the values the capture API holds for it.
  const features = research.getByTestId('research-features')
  const images = features.getByTestId('research-image')
  await expect(images).toHaveCount(1)
  const image = images.first()
  await expect(image).toHaveAttribute('data-capture-id', approved.id)
  await expect(image.getByRole('heading', { level: 4 })).toHaveText('Knee · Left knee (public sample image)')
  const whole = image.getByTestId('research-image-whole')
  await expect(valueOf(whole, 'Min')).toHaveText(temp(stored.minC))
  await expect(valueOf(whole, 'Max')).toHaveText(temp(stored.maxC))
  await expect(valueOf(whole, 'Mean')).toHaveText(temp(stored.meanC))
  await expect(valueOf(whole, 'SD')).toHaveText(stored.stdC === null ? 'not stored' : temp(stored.stdC))
  await expect(image).toContainText(`${stored.width} × ${stored.height} px`)
  await expect(image).toContainText('Room 22.0 °C · acclimatisation 15 min · distance 1 m')
  await expect(image).toContainText(`Extractor ${stored.extractor.name} ${stored.extractor.version}`)
  const camera = [stored.parameters.emissivity === null ? null : `Emissivity ${stored.parameters.emissivity.toFixed(2)}`, stored.parameters.objectDistanceM === null ? null : `object distance ${trim(stored.parameters.objectDistanceM)} m`].filter(Boolean)
  if (camera.length) await expect(image).toContainText(`${camera.join(' · ')} (from the file)`)
  const regions = image.getByTestId('research-regions').getByRole('listitem')
  await expect(regions).toHaveCount(2)
  for (const [i, r] of stored.rois.entries()) {
    const s = r.stats
    await expect(regions.nth(i)).toHaveText(`${r.label} · Rectangle · ${s.pixelCount ? `${s.pixelCount} px` : 'no pixel with a reading'} · Min ${temp(s.min)} · Max ${temp(s.max)} · Mean ${temp(s.mean)} · SD ${temp(s.std)}`)
  }
  const pair = stored.pairs[0]!
  await expect(image.getByTestId('research-pairs').getByRole('listitem')).toHaveText(`${pair.a} minus ${pair.b}: mean ${diff(pair.meanDiff)} · max ${diff(pair.maxDiff)}`)
  // The dataset evaluation's four numbers, the largest of the stored values, each labelled; and called descriptive, not shock.
  const evaluation = image.getByTestId('research-evaluation-inputs')
  await expect(evaluation).toContainText('descriptive; no model uses them here')
  const largest = (vs: (number | null)[]) => {
    const ok = vs.filter((v): v is number => v !== null).map(Math.abs)
    return ok.length ? Math.max(...ok) : null
  }
  await expect(valueOf(evaluation, 'Largest absolute pair mean difference')).toHaveText(temp(largest(stored.pairs.map((p) => p.meanDiff))))
  await expect(valueOf(evaluation, 'Largest absolute pair maximum difference')).toHaveText(temp(largest(stored.pairs.map((p) => p.maxDiff))))
  await expect(valueOf(evaluation, 'Whole-image SD')).toHaveText(stored.stdC === null ? 'not stored' : temp(stored.stdC))
  await expect(valueOf(evaluation, 'Largest region SD')).toHaveText(temp(largest(stored.rois.map((r) => r.stats.std))))
  // Every other image of the consultation is listed with why it is out: the SIMULATED one whatever its review, the one awaiting approval.
  const excluded = features.getByTestId('research-excluded')
  await expect(excluded).toHaveCount(2)
  const simRow = features.locator(`[data-testid="research-excluded"][data-capture-id="${simulated.id}"]`)
  await expect(simRow).toHaveAttribute('data-reason', 'simulated')
  await expect(simRow).toContainText('SIMULATED, excluded')
  await expect(simRow.getByTestId('thermal-source')).toHaveAttribute('data-source', 'simulator')
  await expect(simRow.getByTestId('simulated-badge')).toBeVisible()
  const draftRow = features.locator(`[data-testid="research-excluded"][data-capture-id="${waiting.id}"]`)
  await expect(draftRow).toHaveAttribute('data-reason', 'draft')
  await expect(draftRow).toContainText('awaiting approval, not in the feature set')
  await expect(features.locator(`[data-testid="research-image"][data-capture-id="${simulated.id}"]`)).toHaveCount(0)

  // ---- 4. The published review: closed until opened, labelled as not ADAXAI's validation, its verified fields, and its figures only as the
  // cited primary studies' own. ----
  const paper = research.getByTestId('research-paper')
  await expect(paper).not.toHaveAttribute('open')
  await expect(paper.getByTestId('research-paper-line')).toBeHidden()
  await expect(paper).toContainText('PUBLISHED RESEARCH — NOT ADAX-AI VALIDATION')
  await paper.locator('summary').click()
  await expect(paper).toHaveAttribute('open', '')
  await expect(paper.getByTestId('research-paper-line')).toHaveText('A literature review. ADAXAI implements no method from it; the figures here are other studies’ published results, not ADAXAI’s.')
  await expect(paper).toContainText('Thermal Imaging Applications in Shock Detection: Technological Advancements and Clinical Implications')
  await expect(paper).toContainText('Manu Sudhi, Dasharathraj K. Shetty, Jayaraj Mymbilly Balakrishnan, Deekshith R Prabhu, Ritesh Kamath, S. Girisha')
  await expect(paper).toContainText('Engineered Science (Engineered Science Publisher), 2025, vol. 33, article 1367. Review article.')
  const doi = paper.getByRole('link', { name: /^doi:10\.30919\/es1367/ })
  await expect(doi).toHaveAttribute('href', 'https://doi.org/10.30919/es1367')
  await expect(doi).toHaveAttribute('target', '_blank')
  await expect(doi).toHaveAccessibleName('doi:10.30919/es1367 (opens in a new tab)')
  await expect(paper).toContainText('CC BY 4.0')
  await expect(paper).toContainText('No established temperature profiles for any type of shock (§6.1).')
  // Each figure belongs to a cited primary study, named with its DOI, and says where it was read; no figure stands outside a study.
  const studies = paper.getByTestId('research-study')
  await expect(studies).toHaveCount(2)
  await expect(paper.locator('[data-testid="research-study"][data-study="nagori-2019"]')).toContainText('Nagori et al. 2019')
  await expect(paper.locator('[data-testid="research-study"][data-study="vats-2022"]')).toContainText('Vats et al. 2022')
  for (const s of await studies.all()) await expect(s.getByRole('link', { name: /^doi:10\./ })).toHaveAttribute('href', /^https:\/\/doi\.org\/10\./)
  const figures = paper.locator('li[data-basis]')
  await expect(figures).toHaveCount(11)
  for (const f of await figures.all()) await expect(f).toContainText(/\(as stated by the primary paper( only)?; the review (reports it too|leaves it out)\)/)
  const unattributed = await paper.evaluate((root) => {
    const out: string[] = []
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.textContent ?? ''
      if (/\bAU(ROC|PRC|C)\b|\b0\.\d{2}\b/.test(t) && !n.parentElement?.closest('[data-testid="research-study"]')) out.push(t.trim())
    }
    return out
  })
  expect(unattributed, 'a published figure outside the study it comes from').toEqual([])
  // Outside the published review, the research sheet names no metric of a model and no score, threshold or probability. The fixed header's
  // sentence says that nothing here scores (or predicts) shock: it is the one sentence with such a word in it, so it is taken out first.
  const DISCLAIMER = 'Research only. Not for clinical decisions. Nothing here detects, predicts or scores shock.'
  const rest = await sheet.evaluate((root) => {
    const copy = root.cloneNode(true) as HTMLElement
    copy.querySelector('[data-testid="research-paper"]')?.remove()
    return copy.textContent ?? ''
  })
  expect(rest).toContain(DISCLAIMER)
  const own = rest.split(DISCLAIMER).join(' ')
  expect(own).not.toMatch(/AUC|AUROC|AUPRC/)
  expect(own).not.toMatch(/probabilit|score|threshold|predict/i)

  // ---- 5. It fits and passes the accessibility checks at the laptop size and on a phone, the review open. ----
  await expectNoHorizontalOverflow(page)
  await expectNoAxeViolations(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await expectNoHorizontalOverflow(page)
  await expectNoAxeViolations(page)
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  page.off('request', onRequest)
  // Opening it wrote nothing and read neither the images nor the record again (it reads the panel's own copies; only the model status, which
  // is not audited, may be asked for).
  expect(asked.filter((a) => !a.startsWith('GET ')), 'writes while the research sheet was open').toEqual([])
  expect(asked.filter((a) => a === `GET /api/patients/${child.patientId}/thermal` || a === `GET /api/patients/${child.patientId}`), 'reads of the images or the record while the sheet was open').toEqual([])

  // Nothing in it is a clinical result: the diagnosis and the prescription are untouched, and nothing left this computer's application.
  await expect(page.getByRole('region', { name: 'Diagnosis', exact: true })).toContainText('No diagnosis yet.')
  await expect(page.getByRole('region', { name: 'Prescription', exact: true })).toContainText('No medicines prescribed.')
  expect(outside, 'requests to anything but the app').toEqual([])
})
