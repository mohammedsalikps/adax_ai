import { request as pwRequest, expect, type APIRequestContext, test } from '@playwright/test'
import { DEMO_PASSWORD, expectNoAxeViolations, expectNoHorizontalOverflow, uniq } from './support.ts'

/** Staff side via the API: a synthetic patient with a signed consultation and a portal activation code. */
async function patientWithSignedRecord(baseURL: string, given: string) {
  const login = async (username: string) => {
    const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'x-adaxai-csrf': '1' } })
    expect((await api.post('/api/auth/login', { data: { username, password: DEMO_PASSWORD } })).ok()).toBe(true)
    return api
  }
  const nurse: APIRequestContext = await login('nurse.anil')
  const doctor: APIRequestContext = await login('dr.meera')
  const patient = await (await nurse.post('/api/patients', { data: { givenName: given, familyName: 'Synthetic', dateOfBirth: '1990-07-21', sex: 'female', phone: `6${String(Date.now()).slice(-9)}` } })).json()
  await nurse.post(`/api/patients/${patient.id}/consents`, { data: { type: 'portal_access', method: 'verbal' } })
  const depts = (await (await nurse.get('/api/departments')).json()).departments
  const visit = await (await nurse.post('/api/visits', { data: { patientId: patient.id, departmentId: depts.find((d: { code: string }) => d.code === 'GEN').id, chiefComplaint: 'Headache' } })).json()
  await nurse.post(`/api/visits/${visit.id}/observations`, { data: { items: [{ kind: 'temperature', value: 37.2 }, { kind: 'heart_rate', value: 76 }] } })
  const e = await (await doctor.post(`/api/visits/${visit.id}/encounter`)).json()
  const saved = await (
    await doctor.put(`/api/encounters/${e.id}/draft`, {
      data: {
        version: e.version,
        note: { chiefComplaint: `${given} tension headache`, history: 'Two days, no red flags.', pastHistory: '', examination: 'Normal neurological examination.', assessment: 'Tension-type headache.', plan: 'Rest, fluids.', followUp: 'Return if headache persists beyond one week.' },
        diagnoses: [{ description: 'Tension-type headache', code: 'G44.2', kind: 'primary' }],
        prescription: [{ drugName: 'Paracetamol', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Up to three times daily', duration: '3 days', instructions: 'After food' }],
      },
    })
  ).json()
  const signed = await doctor.post(`/api/encounters/${e.id}/sign`, { data: { version: saved.version, attestation: true } })
  expect(signed.ok()).toBe(true)
  // Signing no longer completes the visit, and the patient app shows a record only once its consultation is completed (DESIGN §5.6, §6):
  // the doctor's separate Complete act.
  const completed = await doctor.post(`/api/encounters/${e.id}/complete`, { data: { version: (await signed.json()).version } })
  expect(completed.ok(), await completed.text()).toBe(true)
  const code = (await (await nurse.post(`/api/patients/${patient.id}/portal-activation`)).json()).activationCode as string
  await nurse.dispose()
  await doctor.dispose()
  return { mrn: patient.mrn as string, code, recordId: e.id as string }
}

test('patient activates, sees only their own signed records on a phone-sized installable app, and patient data is never cached', async ({ page, baseURL }) => {
  const a = await patientWithSignedRecord(baseURL!, `Pa${uniq()}`)
  const b = await patientWithSignedRecord(baseURL!, `Pb${uniq()}`)

  await page.goto('/activate')
  await page.getByLabel('MRN').fill(a.mrn)
  await page.getByLabel('Activation code').fill(a.code)
  await page.getByLabel('Choose a password').fill('Synthetic-portal-pass-1')
  await page.getByLabel(/I understand this portal shows my own records/).check()
  await page.getByRole('button', { name: /Activate/ }).click()
  await expect(page).toHaveURL(/\/patient$/)
  await expect(page.getByRole('heading', { name: /^Hello, / })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Follow-up advice' })).toContainText('Return if headache persists beyond one week.')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // Records and the signed prescription.
  await page.goto('/patient/records')
  await page.getByTestId('portal-record').first().click()
  await expect(page.getByRole('region', { name: 'Prescription' })).toContainText('Paracetamol 500 mg Tablet')
  await expect(page.getByRole('region', { name: 'Consultation notes' })).toContainText('Tension-type headache (G44.2)')
  await expect(page.getByText(/Record fingerprint \(SHA-256\)/)).toBeVisible()
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  for (const [path, text] of [
    ['/patient/vitals', 'Temperature'],
    ['/patient/visits', 'View record'],
    ['/patient/consents', 'Patient portal'],
    ['/patient/profile', a.mrn],
  ] as const) {
    await page.goto(path)
    await expect(page.locator('main')).toContainText(text)
    await expectNoAxeViolations(page)
    await expectNoHorizontalOverflow(page)
  }

  // Another patient's record is not found; a staff page shows a plain "no access" page (no silent redirect, none of the staff shell) and the API refuses the data.
  await page.goto(`/patient/records/${b.recordId}`)
  await expect(page.getByRole('alert')).toContainText('Record not found')
  await page.goto('/doctor/queue')
  await expect(page).toHaveURL((u) => u.pathname === '/doctor/queue')
  await expect(page.getByRole('heading', { level: 1, name: /^This account cannot access the Doctor App$/ })).toBeVisible()
  await expect(page.getByTestId('signed-in-user')).toHaveCount(0)
  expect((await page.request.get(`/api/encounters/${b.recordId}`)).status()).toBe(403)
  expect((await page.request.get(`/api/portal/records/${b.recordId}`)).status()).toBe(404)

  // Installable: a manifest with icons; a service worker controls the page; no API response is cached.
  const manifest = await (await page.request.get('/manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' })
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512', '512x512'])
  for (const i of manifest.icons) expect((await page.request.get(i.src)).ok()).toBe(true)
  const cached = await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    const urls: string[] = []
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname)
    return urls
  })
  expect(cached).toContain('/manifest.webmanifest')
  expect(cached.filter((u) => u.startsWith('/api'))).toEqual([])
  const res = await page.request.get('/api/portal/records')
  expect(res.headers()['cache-control']).toBe('no-store')
})
