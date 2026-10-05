import { type APIRequestContext, type Browser, expect, test } from '@playwright/test'
import { newPatient, staff } from './appointments-support.ts'
import { expectNoAxeViolations, expectNoHorizontalOverflow, nurseHandsOverPatient, signIn, uniq } from './support.ts'

/**
 * The first slice of the Doctor App as one workflow: the doctor's day (dashboard, today's patients), starting a consultation, and having the
 * patient's real history in front of them (past history, profile), with the doctor able to add, stop and correct entries.
 * Data is made through the real API; each test uses patients of its own (the two Playwright projects share one database).
 */

/** A browser context without the service worker, so forced responses (page.route) are seen by the page. */
async function plainContext(browser: Browser, baseURL: string, isMobile: boolean) {
  const ctx = await browser.newContext({ baseURL, serviceWorkers: 'block', ...(isMobile && { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }) })
  return { ctx, page: await ctx.newPage() }
}

/** One signed-in API session per account and worker: every sign-in counts against the account's rate limit, and this spec makes many calls. */
const sessions = new Map<string, Promise<APIRequestContext>>()
function session(baseURL: string, username: string) {
  let s = sessions.get(username)
  if (!s) {
    s = staff(baseURL, username)
    sessions.set(username, s)
  }
  return s
}
test.afterAll(async () => {
  for (const s of sessions.values()) await (await s).dispose()
  sessions.clear()
})

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

/**
 * The two Playwright projects and every spec share one database, and the doctor's Home always lists every patient who is ready or in
 * the room (however many) ahead of the rest of the day. A test that leaves its patients there makes other specs' expectations about the
 * schedule depend on how many tests ran before them. So each test closes its patients' open visits afterwards: a draft is discarded
 * (the visit returns to the queue) and the visit is cancelled, through the same API the screens use.
 */
const opened: string[] = []
test.afterEach(async ({ baseURL }) => {
  const ids = opened.splice(0)
  if (!ids.length) return
  const nurse = await session(baseURL!, 'nurse.anil')
  const doctor = await session(baseURL!, 'dr.meera')
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
})

/** A patient with a ready visit and a history: allergy, conditions, medicines (one stopped), results, and one earlier signed consultation. */
async function patientWithHistory(baseURL: string) {
  const nurse = await session(baseURL, 'nurse.anil')
  const doctor = await session(baseURL, 'dr.meera')
  const given = `Hx${uniq()}`
  const p = await newPatient(nurse, given)
  opened.push(p.id)
  await nurse.post(`/api/patients/${p.id}/allergies`, { data: { substance: 'Penicillin', reaction: 'Rash and breathing difficulty', severity: 'severe' } })
  const post = async (api: APIRequestContext, url: string, data: unknown) => {
    const r = await api.post(url, { data })
    expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300)
    return r.json()
  }
  await post(doctor, `/api/patients/${p.id}/conditions`, { name: 'Type 2 diabetes mellitus', code: 'E11.9', sinceYear: 2019, sinceMonth: 3 })
  await post(doctor, `/api/patients/${p.id}/conditions`, { name: 'Hypertension', code: 'I10', sinceYear: 2018, status: 'controlled' })
  await post(doctor, `/api/patients/${p.id}/medications`, { drugName: 'Metformin', strength: '500 mg', form: 'Tablet', dose: '1 tablet', frequency: 'Twice daily', startedOn: '2019-04-01', reason: 'Type 2 diabetes' })
  const old = await post(doctor, `/api/patients/${p.id}/medications`, { drugName: 'Glimepiride', strength: '1 mg', dose: '1 tablet', frequency: 'Once daily', startedOn: '2021-01-01' })
  await post(doctor, `/api/patients/${p.id}/medications/${old.id}/status`, { status: 'stopped', stoppedOn: '2022-01-15', reason: 'Low blood sugar episodes' })
  await post(doctor, `/api/patients/${p.id}/investigations`, { testName: 'HbA1c', valueText: '7.2', valueNumber: 7.2, unit: '%', refLow: 4, refHigh: 5.6, collectedOn: daysAgo(30), resultedOn: daysAgo(30) })

  // An earlier consultation, signed.
  const depts = (await (await nurse.get('/api/departments')).json()).departments as { id: string; code: string }[]
  const gen = depts.find((d) => d.code === 'GEN')!.id
  const visit = await post(nurse, '/api/visits', { patientId: p.id, departmentId: gen, chiefComplaint: 'Diabetes review' })
  await post(nurse, `/api/visits/${visit.id}/status`, { status: 'ready' })
  const e = await post(doctor, `/api/visits/${visit.id}/encounter`, undefined)
  const saved = await (
    await doctor.put(`/api/encounters/${e.id}/draft`, {
      data: {
        version: e.version,
        note: { chiefComplaint: 'Diabetes review', history: 'No new symptoms.', pastHistory: '', examination: 'Well.', assessment: 'Type 2 diabetes, fair control.', plan: 'Continue metformin.', followUp: 'Review in 3 months.' },
        diagnoses: [{ description: 'Type 2 diabetes mellitus without complications', code: 'E11.9', kind: 'primary' }],
        prescription: [{ drugName: 'Metformin', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Twice daily', duration: '90 days', instructions: 'After food' }],
      },
    })
  ).json()
  await post(doctor, `/api/encounters/${e.id}/sign`, { version: saved.version, attestation: true })

  // Today's visit, ready for the doctor.
  const today = await post(nurse, '/api/visits', { patientId: p.id, departmentId: gen, chiefComplaint: 'Blurred vision for two weeks' })
  await post(nurse, `/api/visits/${today.id}/observations`, { items: [{ kind: 'heart_rate', value: 78 }, { kind: 'systolic_bp', value: 128 }, { kind: 'diastolic_bp', value: 82 }, { kind: 'blood_glucose', value: 176 }] })
  await post(nurse, `/api/visits/${today.id}/status`, { status: 'ready' })
  return { ...p, doctor }
}

async function startFromQueue(page: import('@playwright/test').Page, name: string) {
  await page.goto('/doctor/queue')
  const row = page.getByRole('listitem').filter({ hasText: name }).filter({ hasText: 'Ready for doctor' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\//)
}

test('the doctor starts a consultation from today’s patients and has the patient’s real history in front of them', async ({ page, baseURL }) => {
  const p = await patientWithHistory(baseURL!)
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)

  // The header: where you are, that it is in progress and for how long.
  const header = page.getByTestId('consultation-header')
  await expect(header.getByRole('heading', { level: 1, name: /^Consultation/ })).toBeVisible()
  await expect(header).toContainText(/in progress/i)
  await expect(header.getByRole('link', { name: 'Back to today’s patients' })).toBeVisible()
  await expect(header.getByRole('button', { name: 'Complete consultation' })).toBeVisible()

  // The banner: the allergy with its severity, and the known conditions, from the record.
  const banner = page.getByTestId('patient-banner')
  await expect(banner).toContainText(p.mrn)
  await expect(banner).toContainText('Allergy: Penicillin (Severe)')
  await expect(banner).toContainText('Type 2 diabetes mellitus')
  await expect(banner).toContainText('Hypertension')
  await expect(banner).toContainText('Synthetic')

  // Vital signs say when they were recorded and by whom; a value outside the adult range says so in words.
  const tiles = page.getByTestId('vitals-tiles')
  await expect(tiles).toContainText('128/82')
  await expect(tiles).toContainText('entered by staff')
  await expect(tiles.getByText('High')).toBeVisible()

  // Past history, Summary.
  const history = page.getByTestId('past-history')
  await expect(history.getByRole('tab', { name: /^Summary/ })).toHaveAttribute('aria-selected', 'true')
  const conditions = history.getByRole('region', { name: 'Known conditions' })
  await expect(conditions).toContainText('Type 2 diabetes mellitus')
  await expect(conditions).toContainText('Since Mar 2019')
  await expect(conditions).toContainText('Controlled')
  // Every entry says who typed it in, and when.
  await expect(conditions).toContainText(/Entered by Dr\. Meera Iyer, \d{1,2} \w{3} \d{4}/)
  const allergies = history.getByRole('region', { name: 'Allergies' })
  await expect(allergies).toContainText('Penicillin')
  await expect(allergies).toContainText('Severe')
  await expect(history.getByRole('region', { name: 'Current medications' })).toContainText('Metformin 500 mg')
  await expect(history.getByRole('region', { name: 'Current medications' })).not.toContainText('Glimepiride')
  await expect(history.getByRole('region', { name: 'Recent investigations' })).toContainText('HbA1c')
  await expect(history.getByRole('region', { name: 'Recent investigations' })).toContainText('High')

  // The tabs work from the keyboard (arrows, Home, End), and each shows its own content.
  await history.getByRole('tab', { name: /^Summary/ }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(history.getByRole('tab', { name: /^Consultations/ })).toBeFocused()
  const earlier = history.getByTestId('history-consultation')
  await expect(earlier).toHaveCount(1)
  await expect(earlier).toContainText('Diabetes review')
  await expect(earlier).toContainText('Type 2 diabetes mellitus without complications')
  await earlier.locator('summary').click()
  await expect(earlier).toContainText('Prescribed in this consultation')
  await expect(earlier).toContainText('not a record of what the patient takes')
  await expect(earlier.getByRole('link', { name: /Open the signed record/ })).toBeVisible()
  await history.getByRole('tab', { name: /^Consultations/ }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(history.getByRole('tabpanel', { name: /^Medications/ })).toContainText('Glimepiride')
  await expect(history.getByRole('tabpanel', { name: /^Medications/ })).toContainText('Stopped')
  await expect(history.getByRole('tabpanel', { name: /^Medications/ })).toContainText('Low blood sugar episodes')
  await expect(history.getByRole('tabpanel', { name: /^Medications/ })).toContainText('Prescribed in earlier consultations')
  await page.keyboard.press('End')
  await expect(history.getByRole('tab', { name: /^Investigations/ })).toBeFocused()
  await expect(history.getByRole('tabpanel', { name: /^Investigations/ })).toContainText('range 4–5.6 %')
  await page.keyboard.press('Home')
  await expect(history.getByRole('tab', { name: /^Summary/ })).toHaveAttribute('aria-selected', 'true')

  // What is not built says so, and nothing pretends.
  // The writing pad is not built, so the workspace does not offer it (D1: no card for a feature that does not exist).
  await expect(page.getByTestId('writing-pad')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Stethoscope recordings' })).toContainText('No stethoscope has been connected to or tested with this system')

  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
})

test('the patient profile opens beside the consultation, summarises the record without AI and says what it is based on, and closes back to where it was opened', async ({ page, baseURL }) => {
  const p = await patientWithHistory(baseURL!)
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  const open = page.getByRole('button', { name: 'View profile' })
  await open.click()
  const drawer = page.getByTestId('patient-profile-drawer')
  await expect(drawer.getByRole('heading', { name: 'Patient profile' })).toBeVisible()
  await expect(drawer).toContainText(p.name)
  const summary = drawer.getByTestId('record-summary')
  await expect(summary).toContainText('From the record, not AI-generated')
  await expect(summary).toContainText('Known conditions:')
  await expect(summary).toContainText('Penicillin (severe)')
  await expect(summary).toContainText('Metformin 500 mg')
  await expect(summary).toContainText('HbA1c')
  await expect(summary).toContainText('Based on entries typed in by staff')
  await drawer.getByRole('tab', { name: 'Full history' }).click()
  await expect(drawer.getByTestId('past-history')).toContainText('Known conditions')
  // A row's menu opens inside the sheet, against its button, and its action works (a menu drawn outside a modal dialog would be inert).
  const hypertension = drawer.getByTestId('history-condition').filter({ hasText: 'Hypertension' })
  const menuButton = hypertension.getByRole('button', { name: /^Actions for Hypertension/ })
  await menuButton.click()
  const menu = page.getByRole('menu', { name: /^Actions for Hypertension/ })
  await expect(menu).toBeVisible()
  const m = (await menu.boundingBox())!
  const b = (await menuButton.boundingBox())!
  expect(m.x, 'menu starts inside the screen').toBeGreaterThanOrEqual(0)
  expect(m.x + m.width, 'menu ends inside the screen').toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(Math.abs(m.x + m.width - (b.x + b.width)), 'menu is against its button').toBeLessThanOrEqual(24)
  await expect(hypertension).toContainText('Controlled')
  await page.getByRole('menuitem', { name: 'Mark active' }).click()
  await expect(hypertension).not.toContainText('Controlled')
  await drawer.getByRole('tab', { name: 'Documents' }).click()
  await expect(drawer.getByRole('region', { name: 'Stethoscope recordings' })).toBeVisible()
  await expectNoAxeViolations(page)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(open).toBeFocused()
})

test('a doctor adds, stops and corrects history entries; each says who entered it and the dialogs say which entry they change', async ({ page, baseURL }) => {
  const p = await patientWithHistory(baseURL!)
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  const history = page.getByTestId('past-history')

  // A condition: added, changed, marked as an error with a reason (and then gone from the list).
  await history.getByRole('button', { name: 'Add condition' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a known condition' })
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByText('Required').first()).toBeVisible()
  await dialog.getByLabel(/^Condition/).fill('Asthma')
  await dialog.getByLabel(/^Since \(year\)/).fill('2012')
  await dialog.getByLabel('ICD-10 code (optional)').fill('j45.9')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  const asthma = history.getByTestId('history-condition').filter({ hasText: 'Asthma' })
  await expect(asthma).toContainText('J45.9')
  await expect(asthma).toContainText('Since 2012')
  await expect(asthma).toContainText(/Entered by Dr\. Meera Iyer/)
  await asthma.getByRole('button', { name: /^Actions for Asthma/ }).click()
  await page.getByRole('menuitem', { name: 'Mark controlled' }).click()
  await expect(asthma).toContainText('Controlled')
  await asthma.getByRole('button', { name: /^Actions for Asthma/ }).click()
  await page.getByRole('menuitem', { name: 'Entered in error…' }).click()
  const err = page.getByRole('dialog', { name: /Mark “Asthma” as entered in error/ })
  // The dialog names the exact entry (two entries can share a name): what it says, since when, its status and who entered it.
  await expect(err.getByTestId('reason-entry')).toContainText(/Asthma, since 2012, controlled; entered by Dr\. Meera Iyer on \d{1,2} \w{3} \d{4}/)
  await err.getByRole('button', { name: 'Mark as entered in error' }).click()
  await expect(err.getByText('Give a short reason')).toBeVisible()
  await err.getByLabel(/^Reason/).fill('Entered on the wrong patient')
  await err.getByRole('button', { name: 'Mark as entered in error' }).click()
  await expect(err).toBeHidden()
  await expect(history.getByTestId('history-condition').filter({ hasText: 'Asthma' })).toHaveCount(0)

  // A medicine: added, stopped with a reason.
  await history.getByRole('tab', { name: /^Medications/ }).click()
  await history.getByRole('button', { name: 'Add medicine' }).click()
  const med = page.getByRole('dialog', { name: /Add a medicine/ })
  await med.getByLabel(/^Medicine/).fill('Atorvastatin')
  await med.getByLabel(/^Strength/).fill('10 mg')
  await med.getByLabel(/^Dose/).fill('1 tablet')
  await med.getByLabel(/^Frequency/).fill('Once daily at night')
  await med.getByRole('button', { name: 'Save' }).click()
  await expect(med).toBeHidden()
  const medicines = history.getByRole('tabpanel', { name: /^Medications/ })
  const statin = medicines.getByTestId('history-medication').filter({ hasText: 'Atorvastatin' })
  await expect(statin).toContainText('Once daily at night')
  await statin.getByRole('button', { name: /^Actions for Atorvastatin/ }).click()
  await page.getByRole('menuitem', { name: 'Stop…' }).click()
  const stop = page.getByRole('dialog', { name: /Stop “Atorvastatin 10 mg”/ })
  await expect(stop.getByTestId('reason-entry')).toContainText(/Atorvastatin 10 mg, 1 tablet, Once daily at night, current; entered by Dr\. Meera Iyer/)
  await stop.getByLabel(/^Reason/).fill('Muscle aches')
  await stop.getByRole('button', { name: 'Stop medicine' }).click()
  await expect(stop).toBeHidden()
  await expect(statin).toContainText('Stopped')
  await expect(statin).toContainText('Muscle aches')
  // A stopped medicine offers no stop again, only the correction of a mistake.
  await statin.getByRole('button', { name: /^Actions for Atorvastatin/ }).click()
  await expect(page.getByRole('menuitem', { name: 'Stop…' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Entered in error…' })).toBeVisible()
  await page.keyboard.press('Escape')

  // A result: flagged from its numbers.
  await history.getByRole('tab', { name: /^Investigations/ }).click()
  await history.getByRole('button', { name: 'Add result' }).click()
  const res = page.getByRole('dialog', { name: 'Add an investigation result' })
  await res.getByLabel(/^Test/).fill('LDL cholesterol')
  await res.getByLabel('Result as it reads').fill('160')
  await res.getByLabel('Unit').fill('mg/dL')
  await res.getByLabel('Upper limit').fill('100')
  // There is no second "number" to disagree with the result: a plain number is compared with the range.
  await expect(res.getByLabel(/^Number/)).toHaveCount(0)
  await res.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Result added' })).toBeVisible()
  await expect(res).toBeHidden()
  const ldl = history.getByRole('tabpanel', { name: /^Investigations/ }).getByTestId('history-result').filter({ hasText: 'LDL cholesterol' })
  await expect(ldl).toContainText('160 mg/dL')
  await expect(ldl).toContainText('High')
  await expect(ldl).toContainText(/Entered by Dr\. Meera Iyer/)

  // The corrected entry has left the history. That the row itself is kept in the database, marked as an error with its reason, is tested in the API tests.
  const all = await (await p.doctor.get(`/api/patients/${p.id}/history`)).json()
  expect(all.conditions.map((c: { name: string }) => c.name)).not.toContain('Asthma')
})

test('the dashboard greets the doctor, counts today from the queue and the schedule, and starts the consultation of a patient who is ready', async ({ page, baseURL }) => {
  const nurse = await nurseHandsOverPatient(baseURL!)
  opened.push(nurse.patientId)
  await signIn(page, 'dr.meera')
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Dr\. Meera$/ })).toBeVisible()
  const glance = page.getByRole('list', { name: 'Today at a glance' })
  for (const label of ['In the queue', 'With a doctor', 'Completed today', 'Appointments to come']) await expect(glance).toContainText(label)
  const schedule = page.getByRole('region', { name: 'Today’s schedule' })
  const row = schedule.getByRole('listitem').filter({ hasText: nurse.name })
  await expect(row).toContainText('Ready for doctor')
  await expect(page.getByRole('region', { name: 'Quick actions' }).getByRole('link', { name: 'Register patient' })).toHaveAttribute('href', '/doctor/register')
  await expectNoAxeViolations(page)
  await row.getByRole('button', { name: 'Start consultation' }).click()
  await expect(page).toHaveURL(/\/doctor\/encounters\//)
})

test('today’s patients: tabs with counts filter the list, the day can be changed, and quieter actions are in a menu', async ({ page, baseURL }) => {
  const ready = await nurseHandsOverPatient(baseURL!)
  const nurse = await session(baseURL!, 'nurse.anil')
  const waiting = await newPatient(nurse, `Wt${uniq()}`)
  opened.push(ready.patientId, waiting.id)
  const depts = (await (await nurse.get('/api/departments')).json()).departments as { id: string; code: string }[]
  await nurse.post('/api/visits', { data: { patientId: waiting.id, departmentId: depts.find((d) => d.code === 'GEN')!.id, chiefComplaint: 'Cough' } })
  await signIn(page, 'dr.meera')
  await page.goto('/doctor/queue')
  await expect(page.getByRole('heading', { level: 1, name: 'Today’s patients' })).toBeVisible()
  const list = page.getByRole('list', { name: 'Visits' })
  await expect(list).toContainText(ready.name)
  await expect(list).toContainText(waiting.name)

  const tabs = page.getByRole('tablist', { name: 'Which patients' })
  await tabs.getByRole('tab', { name: /^Waiting/ }).click()
  await expect(page.getByRole('list', { name: 'Visits' })).toContainText(waiting.name)
  await expect(page.getByRole('list', { name: 'Visits' })).toContainText(ready.name) // ready patients wait for the doctor too
  await tabs.getByRole('tab', { name: /^In the room/ }).click()
  // (When nobody is in the room the list gives way to an empty message, so assert on the patient, not on the list.)
  await expect(page.getByText(waiting.name)).toHaveCount(0)
  await tabs.getByRole('tab', { name: /^Completed/ }).click()
  await expect(page.getByText(ready.name)).toHaveCount(0)
  // Counts are real numbers.
  expect(Number((await tabs.getByRole('tab', { name: /^All/ }).innerText()).match(/\d+/)?.[0])).toBeGreaterThanOrEqual(2)
  await tabs.getByRole('tab', { name: /^All/ }).click()

  // The row's menu holds the quieter actions and works from the keyboard.
  const row = page.getByRole('listitem').filter({ hasText: waiting.name })
  const menuButton = row.getByRole('button', { name: new RegExp(`^More actions for ${waiting.name}`) })
  await menuButton.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Record vitals' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Routing…' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(menuButton).toBeFocused()

  // Another day: that day's record, with no live queue.
  await page.getByLabel('Day').fill('2020-01-01')
  await expect(page.getByText('is not today')).toBeVisible()
  await expect(page.getByText('No patients that day')).toBeVisible()
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
})

for (const [width, height, panes] of [
  [1920, 1080, 2],
  [1536, 900, 2],
  [1440, 900, 2],
  [1366, 1024, 2],
  [1280, 800, 2],
  [1180, 820, 2],
  [1024, 768, 2],
  [768, 1024, 1],
  [390, 844, 1],
] as const) {
  test(`the workspace at ${width}x${height} is ${panes === 2 ? 'the tools beside the note' : 'one column'}, nothing overflows and the editors stay usable`, async ({ page, baseURL, isMobile }) => {
    test.skip(isMobile, 'sets its own screen sizes')
    const p = await patientWithHistory(baseURL!)
    await page.setViewportSize({ width, height })
    await signIn(page, 'dr.meera')
    await startFromQueue(page, p.name)
    await page.getByRole('button', { name: 'Add diagnosis' }).click()
    await page.getByRole('button', { name: 'Add medicine' }).click()
    await page.getByLabel('Diagnosis 1', { exact: true }).fill('Type 2 diabetes mellitus without complications')
    await expect(page.getByTestId('past-history')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    const visit = await page.getByRole('region', { name: 'This visit' }).boundingBox()
    const past = await page.getByRole('region', { name: 'Past history' }).first().boundingBox()
    const mana = await page.getByRole('region', { name: 'Mana AI' }).boundingBox()
    const note = await page.getByRole('region', { name: 'Consultation note' }).boundingBox()
    expect(visit && past && mana && note, `${width}`).toBeTruthy()
    // The tools (the visit, the history, Mana) are one column; the note is beside them from 1024px, under them below.
    expect(new Set([visit!.x, past!.x, mana!.x].map((x) => Math.round(x))).size, `${width}px wide: the tools are one column`).toBe(1)
    if (panes === 2) expect(note!.x, `${width}px wide: the note is beside the tools`).toBeGreaterThan(visit!.x + visit!.width)
    else expect(Math.round(note!.x), `${width}px wide: one column`).toBe(Math.round(visit!.x))
    // From 1024px the consultation bar (name, allergies, Complete consultation) and the note are both on the screen when the page opens.
    if (panes === 2) {
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect(page.getByTestId('patient-banner')).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Complete consultation' })).toBeInViewport()
      await expect(page.getByLabel('Chief complaint')).toBeInViewport()
    }
    // The consultation is a workspace: below 1280px the navigation is a drawer behind the menu button, so the whole width is the consultation's.
    const nav = page.getByRole('navigation', { name: 'Doctor navigation' })
    if (width < 1280) {
      await expect(nav).toBeHidden()
      await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible()
    } else await expect(nav).toBeVisible()
    // The fields of the diagnosis and the medicine are readable (not squeezed to a sliver) and stay inside their cards.
    for (const card of ['Diagnosis', 'Prescription']) {
      const region = page.getByRole('region', { name: card, exact: true })
      const outer = (await region.boundingBox())!
      for (const input of await region.locator('input:visible, select:visible').all()) {
        const box = (await input.boundingBox())!
        expect(box.width, `${width}px: a ${card} field is too narrow`).toBeGreaterThanOrEqual(110)
        expect(box.x + box.width, `${width}px: a ${card} field leaves its card`).toBeLessThanOrEqual(outer.x + outer.width + 1)
      }
      for (const button of await region.getByRole('button', { name: /^Remove/ }).all()) {
        const box = (await button.boundingBox())!
        expect(box.x + box.width, `${width}px: a Remove button leaves its card`).toBeLessThanOrEqual(outer.x + outer.width + 1)
      }
    }
    await expectNoAxeViolations(page)
  })
}

test('when the history cannot be loaded the panel says so and retries, and the allergies are still on the banner', async ({ browser, baseURL, isMobile }) => {
  // Two waits for the data layer's own retry back-off (1 s and 2 s each) are part of what this test is about: 24 s alone, so it gets a budget for a loaded run.
  test.setTimeout(120_000)
  const p = await patientWithHistory(baseURL!)
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  await signIn(page, 'dr.meera')
  await page.route(/\/api\/patients\/[^/]+\/history$/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error', message: 'Something went wrong' }) }))
  await startFromQueue(page, p.name)
  const history = page.getByTestId('past-history')
  // The error state arrives after the data layer's own retries (1 s and 2 s), which is longer than the default wait.
  await expect(history).toContainText('The patient’s history could not be loaded', { timeout: 20_000 })
  // The banner still shows the allergy (from the consultation itself).
  await expect(page.getByTestId('patient-banner')).toContainText('Allergy: Penicillin')
  await page.unroute(/\/api\/patients\/[^/]+\/history$/)
  // The banner's allergies are polled from the same data, so on a busy machine the panel can recover by itself between un-routing and this click (the
  // button then detaches: seen in a trace). Both ways end in the loaded panel, which is what is asserted; the button is clicked when it is still there.
  await history.getByRole('button', { name: 'Try again' }).click({ timeout: 3_000 }).catch(() => undefined)
  await expect(history.getByRole('tab', { name: /^Summary/ })).toBeVisible()
  await expect(page.getByTestId('patient-banner')).toContainText('Allergy: Penicillin (Severe)')
  await ctx.close()
})

/** A patient with today's visit ready and the vital signs given in the order they were measured (oldest first). */
async function readyWithVitals(baseURL: string, batches: { items: { kind: string; value: number }[]; minutesAgo: number }[], allergy?: { substance: string; severity: string }) {
  const nurse = await session(baseURL, 'nurse.anil')
  const p = await newPatient(nurse, `Vt${uniq()}`)
  opened.push(p.id)
  if (allergy) await nurse.post(`/api/patients/${p.id}/allergies`, { data: allergy })
  const depts = (await (await nurse.get('/api/departments')).json()).departments as { id: string; code: string }[]
  const visit = await (await nurse.post('/api/visits', { data: { patientId: p.id, departmentId: depts.find((d) => d.code === 'GEN')!.id, chiefComplaint: 'Check-up' } })).json()
  for (const b of batches) await nurse.post(`/api/visits/${visit.id}/observations`, { data: { items: b.items, measuredAt: new Date(Date.now() - b.minutesAgo * 60_000).toISOString() } })
  await nurse.post(`/api/visits/${visit.id}/status`, { data: { status: 'ready' } })
  return p
}

test('the vitals badge reflects the latest reading of each kind, not one that was superseded, and says what it rests on', async ({ page, baseURL }) => {
  const p = await readyWithVitals(baseURL!, [
    { items: [{ kind: 'systolic_bp', value: 170 }, { kind: 'diastolic_bp', value: 100 }, { kind: 'heart_rate', value: 72 }], minutesAgo: 30 },
    { items: [{ kind: 'systolic_bp', value: 122 }, { kind: 'diastolic_bp', value: 80 }], minutesAgo: 10 },
  ])
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  const banner = page.getByTestId('patient-banner')
  // The re-check is normal: the earlier 170/100 is history, not today's status.
  await expect(banner).toContainText('Latest vitals within the reference range')
  await expect(banner).not.toContainText('outside the reference range')
  await expect(banner).toContainText('adult range, a display aid')
  await expect(page.getByTestId('vitals-tiles')).toContainText('122/80')
  await expect(page.getByTestId('vitals-tiles')).not.toContainText('170')
  await expectNoHorizontalOverflow(page)
})

test('a high reading is named in words in the banner', async ({ page, baseURL }) => {
  const p = await readyWithVitals(baseURL!, [{ items: [{ kind: 'systolic_bp', value: 182 }, { kind: 'diastolic_bp', value: 96 }, { kind: 'spo2', value: 97 }], minutesAgo: 5 }])
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  const banner = page.getByTestId('patient-banner')
  await expect(banner).toContainText('outside the reference range')
  // Named as the screen names them everywhere else, once each ("spo2" or a repeated name would be a bug).
  await expect(banner).toContainText(/Systolic/i)
  await expect(banner).not.toContainText('spo2')
})

test('the allergies stay in front of the prescriber: after scrolling, while prescribing, and at signing', async ({ page, baseURL, isMobile }) => {
  const p = await readyWithVitals(baseURL!, [{ items: [{ kind: 'heart_rate', value: 70 }], minutesAgo: 5 }], { substance: 'Penicillin', severity: 'severe' })
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  await expect(page.getByTestId('patient-banner')).toContainText('Allergy: Penicillin (Severe)')
  await expect(page.getByTestId('patient-strip')).toHaveCount(0)
  // Scrolled to the prescription, the name, MRN and allergies stay with the consultation bar: from 1024px the banner itself is part of the
  // bar and never leaves the screen; on a phone the strip takes its place once the banner has scrolled away.
  await page.getByRole('button', { name: 'Add medicine' }).click()
  await page.getByTestId('prescription-allergies').scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  if (isMobile) {
    const strip = page.locator('[data-testid="patient-strip"]:visible')
    await expect(strip).toContainText(p.name)
    await expect(strip).toContainText('Allergy: Penicillin (Severe)')
  } else {
    const banner = page.getByTestId('patient-banner')
    await expect(banner).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('consultation-header').getByRole('heading', { level: 1 })).toContainText(p.name)
    await expect(banner).toContainText(p.mrn)
    await expect(banner).toContainText('Allergy: Penicillin (Severe)')
    await expect(page.locator('[data-testid="patient-strip"]:visible')).toHaveCount(0)
  }
  // The save state and "Complete consultation" are never scrolled away, on a desktop or a phone.
  const actions = page.getByTestId('consultation-actions')
  await expect(actions.getByRole('button', { name: 'Complete consultation' })).toBeInViewport()
  await expect(actions.getByTestId('save-state')).toBeInViewport()
  // Where the medicines are chosen.
  await expect(page.getByTestId('prescription-allergies')).toContainText('Penicillin')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
  // And at signing.
  await actions.getByRole('button', { name: 'Complete consultation' }).click()
  await expect(page.getByTestId('review-allergies')).toContainText('Penicillin')
})

test('the header menu opens against its button, inside the screen, and discarding asks first', async ({ page, baseURL }) => {
  const p = await readyWithVitals(baseURL!, [{ items: [{ kind: 'heart_rate', value: 70 }], minutesAgo: 5 }])
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  const button = page.getByRole('button', { name: 'More consultation actions' })
  await button.click()
  const menu = page.getByRole('menu', { name: 'More consultation actions' })
  await expect(menu).toBeVisible()
  const m = (await menu.boundingBox())!
  const b = (await button.boundingBox())!
  const viewport = page.viewportSize()!
  expect(m.x, 'menu starts inside the screen').toBeGreaterThanOrEqual(0)
  expect(m.x + m.width, 'menu ends inside the screen').toBeLessThanOrEqual(viewport.width)
  expect(m.y + m.height, 'menu ends inside the screen').toBeLessThanOrEqual(viewport.height)
  // Right-aligned with its button, not stranded elsewhere (above it on a phone, where the bar is at the bottom).
  if (m.x > 9) expect(Math.abs(m.x + m.width - (b.x + b.width)), 'menu is under its button').toBeLessThanOrEqual(24)
  expect(m.y + m.height <= b.y + 1 || m.y >= b.y + b.height - 1, 'menu does not cover its button').toBe(true)
  await page.getByRole('menuitem', { name: 'Discard draft…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Discard this draft?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep the draft' }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/doctor\/encounters\//)
})

test('an allergy added during the consultation reaches the banner; if the list cannot be refreshed the banner says so and keeps what it had', async ({ browser, baseURL, isMobile }) => {
  // Two waits for the data layer's own retry back-off (1 s and 2 s each) are part of what this test is about: 24 s alone, so it gets a budget for a loaded run.
  test.setTimeout(120_000)
  const p = await readyWithVitals(baseURL!, [{ items: [{ kind: 'heart_rate', value: 70 }], minutesAgo: 5 }], { substance: 'Penicillin', severity: 'severe' })
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  const banner = page.getByTestId('patient-banner')
  const history = page.getByTestId('past-history')
  await history.getByRole('tab', { name: /^Allergies/ }).click()
  await history.getByRole('button', { name: 'Add allergy' }).click()
  const dialog = page.getByRole('dialog', { name: 'Record an allergy' })
  await dialog.getByLabel(/^Substance/).fill('Sulfonamide antibiotics')
  await dialog.getByLabel('Severity').selectOption('moderate')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(banner).toContainText('Allergy: Sulfonamide antibiotics (Moderate)')
  await expect(banner).toContainText('Allergy: Penicillin (Severe)')
  await expect(banner).not.toContainText('may be out of date')

  // The record can no longer be read: an allergy added now cannot appear, and the banner must not look current.
  await page.route(/\/api\/patients\/[^/]+\/history$/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error', message: 'Something went wrong' }) }))
  await history.getByRole('button', { name: 'Add allergy' }).click()
  await dialog.getByLabel(/^Substance/).fill('Latex')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(banner).toContainText('Allergy list may be out of date', { timeout: 20_000 })
  await expect(banner).toContainText('Allergy: Penicillin (Severe)')
  await ctx.close()
})

test('a failed change leaves no stale error behind, and Enter pressed twice saves once', async ({ browser, baseURL, isMobile }) => {
  const p = await patientWithHistory(baseURL!)
  const { ctx, page } = await plainContext(browser, baseURL!, isMobile)
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  const history = page.getByTestId('past-history')

  // A change that fails (shown as a message), then a correction dialog: it opens clean.
  let failed = 0
  await page.route(/\/api\/patients\/[^/]+\/conditions\/[^/]+\/status$/, (r) => {
    if (failed++ === 0) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error', message: 'Something went wrong' }) })
    return r.continue()
  })
  const diabetes = history.getByTestId('history-condition').filter({ hasText: 'Type 2 diabetes mellitus' })
  await diabetes.getByRole('button', { name: /^Actions for Type 2 diabetes mellitus/ }).click()
  await page.getByRole('menuitem', { name: 'Mark resolved' }).click()
  await expect(page.getByText('The change was not saved')).toBeVisible()
  await diabetes.getByRole('button', { name: /^Actions for Type 2 diabetes mellitus/ }).click()
  await page.getByRole('menuitem', { name: 'Entered in error…' }).click()
  const err = page.getByRole('dialog', { name: /as entered in error/ })
  await expect(err).toBeVisible()
  await expect(err).not.toContainText('Something went wrong')
  await expect(err.getByRole('alert')).toHaveCount(0)
  await err.getByRole('button', { name: 'Cancel' }).click()

  // Enter twice while the first save is under way: one request.
  const posts: string[] = []
  await page.route(/\/api\/patients\/[^/]+\/conditions$/, async (r) => {
    if (r.request().method() === 'POST') {
      posts.push(r.request().url())
      await new Promise((done) => setTimeout(done, 700))
    }
    return r.continue()
  })
  await history.getByRole('button', { name: 'Add condition' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a known condition' })
  await dialog.getByLabel(/^Condition/).fill('Migraine')
  await dialog.getByLabel(/^Since \(year\)/).fill('2015')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(posts).toHaveLength(1)
  await expect(history.getByTestId('history-condition').filter({ hasText: 'Migraine' })).toHaveCount(1)
  await ctx.close()
})

test('a result the system could not compare with a range says so, in the list and in the summary, and is never shown as normal', async ({ page, baseURL }) => {
  const p = await patientWithHistory(baseURL!)
  // Typed with its unit inside the result and no limits: nothing to compare it with.
  const r = await p.doctor.post(`/api/patients/${p.id}/investigations`, { data: { testName: 'Ferritin', valueText: '8 ng/mL', collectedOn: daysAgo(3) } })
  expect(r.status(), await r.text()).toBe(201)
  expect((await r.json()).flag).toBe('unknown')
  await signIn(page, 'dr.meera')
  await startFromQueue(page, p.name)
  const history = page.getByTestId('past-history')
  await history.getByRole('tab', { name: /^Investigations/ }).click()
  const row = history.getByRole('tabpanel', { name: /^Investigations/ }).getByTestId('history-result').filter({ hasText: 'Ferritin' })
  await expect(row).toContainText('8 ng/mL')
  await expect(row).toContainText('Not compared with a range')
  // A result that was compared and is normal-or-high keeps its own chip.
  await expect(history.getByRole('tabpanel', { name: /^Investigations/ }).getByTestId('history-result').filter({ hasText: 'HbA1c' })).toContainText('High')
  // The record summary (in the profile, beside the consultation) says the same, and lists the high one only once, as the latest of its test.
  await page.getByRole('button', { name: 'View profile' }).click()
  const summary = page.getByTestId('patient-profile-drawer').getByTestId('record-summary')
  await expect(summary).toContainText('Results not compared with a range: Ferritin 8 ng/mL')
  await expect(summary).toContainText('Results outside range: HbA1c')
})
