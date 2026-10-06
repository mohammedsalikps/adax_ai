import { randomUUID } from 'node:crypto'
import { type APIRequestContext, expect, type Page, request as pwRequest, test } from '@playwright/test'
import { analyzeButton, DEMO_PASSWORD, llmExclusive, nurseHandsOverPatient, signIn, uniq } from './support.ts'

/*
 * "Analyze with Mana" (Doctor HERO) in a real browser, against the real API and database. One click saves the doctor's note, then runs the fixed
 * safety rules and asks the local model for the V3 draft at the same time; it never asks Mana chat. The local model is the suite's stand-in
 * (e2e/mock-llm.mjs: it copies the record items it is shown; no model runs here), so a time measured here is a time of the stand-in, never of the
 * product. What the page says about a run (its steps, its clock, how long it took) is checked against what the server and the stand-in recorded.
 */

const LLM = 'http://127.0.0.1:8181'

async function llm(mode: 'ok' | 'slow' | 'down', delayMs?: number) {
  const r = await pwRequest.newContext()
  try {
    await r.post(`${LLM}/__mode`, { data: { mode, ...(delayMs !== undefined && { delayMs }) } })
  } finally {
    await r.dispose()
  }
}
/** Empties the stand-in's call log (and puts it back in its "ok" mode). */
async function llmReset() {
  const r = await pwRequest.newContext()
  try {
    await r.post(`${LLM}/__reset`)
  } finally {
    await r.dispose()
  }
}
/** What the stand-in was asked, with the prompts; a Mana chat call says which of its two calls it was (`kind`), a draft has none. */
async function llmCalls() {
  const r = await pwRequest.newContext()
  try {
    return (await (await r.get(`${LLM}/__calls?prompts=1`)).json()) as { calls: { prompt?: string; kind?: string }[] }
  } finally {
    await r.dispose()
  }
}

async function staff(baseURL: string, username: string): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
  expect((await api.post('/api/auth/login', { data: { username, password: DEMO_PASSWORD } })).ok()).toBe(true)
  return api
}

/** A duration as the page says one (m:ss, whole seconds, minutes not capped), worked out here rather than imported from the page's code. */
const mss = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

type Draft = { id: string; status: string; phase: string | null; createdAt: string; startedAt: string | null; completedAt: string | null; latencyMs: number | null }

// One stand-in model server whose mode the tests flip, and a request log of its own: the desktop project only, holding the stand-in's lock.
test.skip(({ isMobile }) => isMobile, 'desktop project only (shared model stand-in)')
llmExclusive(test)
test.beforeEach(async () => llm('ok'))

/** The patients whose visits may still be open when a test ends: each draft is discarded and each visit cancelled, as the other specs do. */
const openPatients: string[] = []
test.afterEach(async ({ baseURL }) => {
  await llm('ok')
  const ids = openPatients.splice(0)
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

async function startConsultation(page: Page, baseURL: string) {
  const p = await nurseHandsOverPatient(baseURL, { allergies: ['Penicillin'], consents: ['ai_recording'] })
  openPatients.push(p.patientId)
  await signIn(page, 'dr.meera')
  await page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\/[0-9a-f-]{36}$/)
  return { ...p, encounterId: /\/encounters\/([0-9a-f-]{36})/.exec(page.url())![1]! }
}

const panel = (page: Page) => page.getByTestId('consult-panel')
const status = (page: Page) => panel(page).getByTestId('consult-status')
const step = (page: Page, id: 'save' | 'rules' | 'model') => page.locator(`[data-testid="analysis-steps"] li[data-step="${id}"]`)
/** The workflow strip's step 2, a button named by its label and its state. */
const analysisStep = (page: Page) => page.getByRole('navigation', { name: 'Consultation steps' }).locator('li[data-step="analysis"]').getByRole('button')

/** Every request the page makes to Mana chat. Analyze must cause none: the chat shares the one model slot and asks nothing until it is opened. */
function watchMana(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/mana-assistant')) seen.push(`${r.method()} ${u.pathname}`)
  })
  return seen
}

/** The draft the page's click asked for: the 202 answer to POST …/consultation-ai/drafts (start waiting before the click). */
const draftPosted = (page: Page, encounterId: string) =>
  page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/encounters/${encounterId}/consultation-ai/drafts`)

/**
 * The time a finished run took, as the page says it, against the server's own record of that draft (GET /api/consultation-ai/drafts/:id):
 * the request, the model's start and the end are in order, "took" is the server's latencyMs, and the wait and the writing are the gaps between
 * the server's three times. Said in the Mana area's progress panel and in the result card's "How this draft was made".
 */
async function expectServerTiming(page: Page, draftId: string) {
  const res = await page.request.get(`/api/consultation-ai/drafts/${draftId}`)
  expect(res.ok(), await res.text()).toBe(true)
  const d = (await res.json()) as Draft
  expect(['ready', 'partial']).toContain(d.status)
  expect(d.startedAt, 'the server says when the model began').not.toBeNull()
  expect(d.completedAt).not.toBeNull()
  expect(d.latencyMs).not.toBeNull()
  const created = Date.parse(d.createdAt)
  const started = Date.parse(d.startedAt!)
  const completed = Date.parse(d.completedAt!)
  expect(created, 'asked for before the model began').toBeLessThanOrEqual(started)
  expect(started, 'the model began before the end').toBeLessThanOrEqual(completed)
  const took = mss(d.latencyMs!)
  const waited = mss(started - created)
  const writing = mss(completed - started)
  // The text as written (the first letter is capitalised by the stylesheet only).
  await expect(page.getByTestId('analysis-timing')).toHaveText(`took ${took} · waited ${waited} · writing and checks ${writing}`)
  await expect(panel(page).getByTestId('draft-facts')).toContainText(`took ${took}`)
  await expect(panel(page).getByTestId('draft-timing')).toContainText(`Waited ${waited} for the local model, then ${writing} writing and checks`)
  return d
}

test('one click saves the note first, then runs the fixed safety rules and asks the local model; each step and the time it took are the server’s; Mana chat is never asked', async ({ page, baseURL }) => {
  const mana = watchMana(page)
  const p = await startConsultation(page, baseURL!)
  await expect(status(page)).toContainText('NOT RUN', { timeout: 20_000 })
  const analyze = page.getByTestId('analyze-mana')
  await expect(analyze).toHaveText('Analyze with Mana')
  await expect(analyze).toHaveAttribute('data-state', 'ready')
  await expect(analysisStep(page)).toHaveAccessibleName('Mana analysis: Not run')
  // Nothing is shown as progress before the first click.
  await expect(page.getByTestId('analysis-panel')).toHaveCount(0)
  await llmReset()

  // The order of what the click did, from the page's own network traffic: the note saved (its answer received) before either request was sent.
  const order: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (r.method() === 'POST' && path === `/api/encounters/${p.encounterId}/recommendations`) order.push('rules asked')
    if (r.method() === 'POST' && path === `/api/encounters/${p.encounterId}/consultation-ai/drafts`) order.push('model asked')
  })
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/encounters/${p.encounterId}/draft` && r.ok()) order.push('note saved')
  })
  // Typed and analysed at once, well inside the autosave's delay (1.2 s): only the click's own save can put these words on the server in time.
  // (Not the word "synthetic": it is the test patients' family name, and the server replaces the patient's name before the model sees the text.)
  const words = `Save-before-analyse check ${uniq()}: sore throat since yesterday, typed just before the click.`
  await page.getByLabel('History of present illness').fill(words)
  const posted = draftPosted(page, p.encounterId)
  order.push('clicked')
  const clicked = Date.now()
  await analyzeButton(page).click()
  const draftId = ((await (await posted).json()) as Draft).id
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 30_000 })
  // Measured on this run with the suite's stand-in for the local model: a number about this test, not the product's speed.
  test.info().annotations.push({ type: 'timing', description: `Analyze with Mana, click to READY FOR REVIEW: ${Date.now() - clicked} ms (mock-llm stand-in, not a product timing)` })

  expect(order.slice(0, 2), 'the click saved the note before anything was asked').toEqual(['clicked', 'note saved'])
  expect(order.slice(2).sort(), 'then the rules and the model, once each').toEqual(['model asked', 'rules asked'])
  // What the stand-in was shown is the saved note, with the words typed just before the click: one draft call, and no Mana chat call.
  const calls = (await llmCalls()).calls
  expect(calls.filter((c) => c.kind), 'Mana chat calls to the model').toEqual([])
  expect(calls).toHaveLength(1)
  expect(calls[0]!.prompt).toContain(words)

  // The steps, as the server answered each.
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-state', 'done')
  await expect(step(page, 'save')).toHaveAttribute('data-state', 'done')
  await expect(step(page, 'save')).toContainText(/Your note.*Saved \d{1,2}:\d{2}/)
  // The rules' step names the rules' version and counts the results of their newest run, as the server stored them.
  const encounterAi = (await (await page.request.get(`/api/encounters/${p.encounterId}/ai`)).json()) as {
    jobs: { id: string; kind: string; status: string; createdAt: string }[]
    recommendations: { jobId: string | null; source: string }[]
  }
  const runs = encounterAi.jobs.filter((j) => j.kind === 'safety_check').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  expect(runs[0]?.status).toBe('succeeded')
  const results = encounterAi.recommendations.filter((r) => r.jobId === runs[0]!.id && r.source === 'rules').length
  await expect(step(page, 'rules')).toHaveAttribute('data-state', 'done')
  await expect(step(page, 'rules')).toContainText(`${results === 0 ? 'No' : results} ${results === 1 ? 'result' : 'results'} · safety-rules-v1`)
  await expect(step(page, 'model')).toHaveAttribute('data-state', 'done')
  await expect(step(page, 'model')).toContainText('READY FOR REVIEW')
  await expectServerTiming(page, draftId)

  // The one control now offers another run, and the strip says what there is.
  await expect(analyzeButton(page, 'Analyze again')).toBeEnabled()
  await expect(analyze).toHaveAttribute('data-state', 'again')
  await expect(analysisStep(page)).toHaveAccessibleName('Mana analysis: Ready for review')
  expect(mana, 'requests to Mana chat').toEqual([])
})

test('while the local model is busy the run waits its turn, then writes, with a clock counting from the click; Cancel stops it, and “Analyze again” makes a new draft', async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const mana = watchMana(page)
  const p = await startConsultation(page, baseURL!)
  await expect(status(page)).toContainText('NOT RUN', { timeout: 20_000 })

  // Another consultation of the same doctor holds the one model slot: its draft is asked for through the API, with the stand-in slowed down.
  const other = await nurseHandsOverPatient(baseURL!, { consents: ['ai_recording'] })
  openPatients.push(other.patientId)
  const doctor = await staff(baseURL!, 'dr.meera')
  const visits = ((await (await doctor.get(`/api/patients/${other.patientId}/visits`)).json()).visits ?? []) as { id: string; status: string }[]
  const started = await doctor.post(`/api/visits/${visits.find((v) => v.status === 'ready')!.id}/encounter`)
  expect(started.ok(), await started.text()).toBe(true)
  const otherEncounter = ((await started.json()) as { id: string }).id
  await llm('slow', 8000)
  const held = await doctor.post(`/api/encounters/${otherEncounter}/consultation-ai/drafts`, { data: { idempotencyKey: randomUUID() } })
  expect(held.status(), await held.text()).toBe(202)
  const heldId = ((await held.json()) as Draft).id
  await expect.poll(async () => ((await (await doctor.get(`/api/consultation-ai/drafts/${heldId}`)).json()) as Draft).phase, { timeout: 15_000 }).toBe('running')

  const analyze = page.getByTestId('analyze-mana')
  const posted = draftPosted(page, p.encounterId)
  await analyzeButton(page).click()
  const ours = (await (await posted).json()) as Draft
  expect(ours.status).toBe('generating')
  // One control, busy and off while the run is under way.
  await expect(analyze).toHaveAttribute('data-state', 'running')
  await expect(analyze).toHaveText('Analyzing…')
  await expect(analyze).toBeDisabled()
  await expect(analyze).toHaveAttribute('aria-busy', 'true')
  await expect(status(page)).toContainText('GENERATING')
  // Waiting: the model serves one request at a time, and the other consultation's draft has it. The server says so (queued, not started).
  await expect(step(page, 'model')).toHaveAttribute('data-state', 'running')
  await expect(step(page, 'model')).toContainText('Waiting for the local model')
  await expect(analysisStep(page)).toHaveAccessibleName('Mana analysis: Waiting for the local model', { timeout: 10_000 })
  expect(((await (await page.request.get(`/api/consultation-ai/drafts/${ours.id}`)).json()) as Draft).startedAt, 'not started while it waits').toBeNull()
  // The clock counts from the click on this page's own clock, and goes on counting.
  const timing = page.getByTestId('analysis-timing')
  const seconds = async () => {
    const m = /^elapsed (\d+):(\d{2})$/.exec(((await timing.textContent()) ?? '').trim())
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1
  }
  await expect(timing).toHaveText(/^elapsed \d+:\d{2}$/)
  const first = await seconds()
  await expect.poll(seconds, { timeout: 10_000 }).toBeGreaterThanOrEqual(first + 2)
  // Then its turn: writing (the server has now said when the model began).
  await expect(step(page, 'model')).toContainText('Writing the draft', { timeout: 30_000 })
  await expect(analysisStep(page)).toHaveAccessibleName('Mana analysis: Writing')
  await expect(timing).toHaveText(/^elapsed \d+:\d{2}$/)
  const writing = await seconds()
  await expect.poll(seconds, { timeout: 10_000 }).toBeGreaterThan(writing)

  // Cancel: the result card's own, the only one on the page.
  await panel(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(status(page)).toContainText('CANCELLED', { timeout: 15_000 })
  await expect(step(page, 'model')).toHaveAttribute('data-state', 'cancelled')
  await expect(step(page, 'model')).toContainText('CANCELLED')
  await expect(page.getByTestId('analysis-panel')).toHaveAttribute('data-state', 'done')
  // A draft that never finished has no "took": the clock is gone rather than frozen at a made-up time.
  await expect(timing).toHaveCount(0)
  await expect(analysisStep(page)).toHaveAccessibleName('Mana analysis: Cancelled')
  const cancelled = (await (await page.request.get(`/api/consultation-ai/drafts/${ours.id}`)).json()) as Draft
  expect(cancelled.status).toBe('cancelled')
  expect(cancelled.startedAt, 'cancelled after the model began').not.toBeNull()
  expect(cancelled.latencyMs).toBeNull()

  // "Analyze again": a new draft, made and ready, its time the server's.
  await llm('slow', 2500)
  const again = analyzeButton(page, 'Analyze again')
  await expect(again).toBeEnabled()
  const postedAgain = draftPosted(page, p.encounterId)
  await again.click()
  const second = (await (await postedAgain).json()) as Draft
  expect(second.id).not.toBe(ours.id)
  await expect(status(page)).toContainText('GENERATING')
  await expect(status(page)).toContainText('READY FOR REVIEW', { timeout: 30_000 })
  await expect(step(page, 'model')).toHaveAttribute('data-state', 'done')
  await expectServerTiming(page, second.id)
  await expect(analyzeButton(page, 'Analyze again')).toBeEnabled()
  await expect(analysisStep(page)).toHaveAccessibleName('Mana analysis: Ready for review')
  expect(mana, 'requests to Mana chat').toEqual([])
  await doctor.dispose()
})

test('with the local model down, Analyze is off and says why in the server’s words, and the fixed rules’ overview is still there', async ({ page, baseURL }) => {
  const mana = watchMana(page)
  const p = await startConsultation(page, baseURL!)
  await expect(status(page)).toContainText('NOT RUN', { timeout: 20_000 })
  await llm('down')
  await page.reload()
  await expect(status(page)).toContainText('UNAVAILABLE', { timeout: 20_000 })
  const analyze = page.getByTestId('analyze-mana')
  await expect(analyze).toBeDisabled()
  await expect(analyze).toHaveAttribute('data-state', 'blocked')
  // The reason under the control, tied to it, is the server's own.
  const ai = (await (await page.request.get(`/api/encounters/${p.encounterId}/consultation-ai`)).json()) as { canGenerate: boolean; blockedReason: string | null }
  expect(ai.canGenerate).toBe(false)
  expect(ai.blockedReason).toBeTruthy()
  await expect(page.getByTestId('analyze-reason')).toHaveText(ai.blockedReason!)
  await expect(analyze).toHaveAccessibleDescription(ai.blockedReason!)
  await expect(analysisStep(page)).toHaveAccessibleName('Mana analysis: Unavailable')
  // The fixed rules do not need the model: the overview (with its safety rules section) is there, and says what it is.
  const overview = page.locator('#mana-result').getByTestId('consultation-overview')
  await expect(overview.getByRole('heading', { name: 'Consultation overview' })).toBeVisible()
  await expect(overview).toContainText('Fixed rules, not AI')
  await expect(overview).toContainText('Nothing here is a diagnosis or a recommendation.')
  await expect(overview.getByTestId('safety-rules')).toContainText('The safety rules run when you analyze.')
  // And beside the prescription: no draft, so no medication consideration, said as such.
  await expect(page.getByTestId('rx-considerations')).toContainText('Local AI unavailable: no draft has been made, so there is no medication consideration.')
  await expect(page.getByRole('region', { name: 'Prescription', exact: true })).toContainText('No medicines prescribed.')
  expect(mana, 'requests to Mana chat').toEqual([])
})
