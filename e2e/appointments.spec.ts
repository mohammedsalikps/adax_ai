import { expect, test } from '@playwright/test'
import { bookViaApi, clockText, hhmm, newPatient, otherContext, randomSlot, staff } from './appointments-support.ts'
import { moveAppointmentToToday } from './e2e-db.ts'
import { expectNoAxeViolations, expectNoHorizontalOverflow, signIn, uniq } from './support.ts'

test('a nurse books, is told a slot is taken, reschedules and cancels; the schedule and the history show each step', async ({ page, baseURL }) => {
  const api = await staff(baseURL!, 'nurse.anil')
  const slot = await randomSlot(api)
  const [a, b] = [await newPatient(api, `Ba${uniq()}`), await newPatient(api, `Bb${uniq()}`)]
  const doctors = (await (await api.get('/api/staff', { params: { role: 'doctor' } })).json()).staff as { id: string; fullName: string }[]
  const meera = doctors.find((d) => d.fullName.includes('Meera'))!

  await signIn(page, 'nurse.anil')
  await page.goto('/nurse/appointments')
  await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible()
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // Book for the first patient with Dr. Meera.
  const book = async (patient: { given: string; name: string }, time: string) => {
    await page.getByRole('button', { name: 'Book appointment' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Book an appointment' })
    await dialog.getByLabel('Find the patient').fill(patient.given)
    await dialog.getByRole('list', { name: 'Matching patients' }).getByRole('button', { name: new RegExp(patient.name) }).click()
    await expect(dialog.getByTestId('chosen-patient')).toContainText(patient.name)
    await dialog.getByLabel('Department').selectOption({ label: 'General Medicine' })
    await dialog.getByLabel('Doctor').selectOption({ label: meera.fullName })
    await dialog.getByLabel('Date').fill(slot.date)
    await dialog.getByLabel('Time').fill(time)
    return dialog
  }
  const first = await book(a, slot.time)
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
  await first.getByRole('button', { name: 'Book appointment' }).click()
  await expect(first).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: /^Booked / })).toBeVisible()

  // The same doctor at the same time: refused clearly, nothing moves, the dialog stays open.
  const clash = await book(b, slot.time)
  await clash.getByRole('button', { name: 'Book appointment' }).click()
  await expect(clash.getByRole('alert')).toContainText('That clinician already has an appointment at this time')
  await expect(clash.getByRole('alert')).not.toContainText(a.given)
  // Back to back is fine.
  const [h, m] = slot.time.split(':').map(Number) as [number, number]
  const next = h * 60 + m + 15
  await clash.getByLabel('Time').fill(hhmm(Math.floor(next / 60), next % 60))
  await clash.getByRole('button', { name: 'Book appointment' }).click()
  await expect(clash).toBeHidden()

  // Both are on the upcoming schedule, with their status.
  await page.getByRole('group', { name: 'Which appointments' }).getByRole('button', { name: 'Upcoming' }).click()
  const rowA = page.getByRole('listitem').filter({ hasText: a.name })
  const rowB = page.getByRole('listitem').filter({ hasText: b.name })
  await expect(rowA).toContainText('Booked')
  await expect(rowA).toContainText(meera.fullName)
  await expect(rowB).toContainText('Booked')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // Reschedule the first (from its details): the new time is booked, the old one is closed (and hidden from the schedule).
  await rowA.getByRole('button', { name: /Details/ }).click()
  await page.getByRole('dialog', { name: 'Appointment' }).getByRole('button', { name: 'Reschedule…' }).click()
  const move = page.getByRole('dialog', { name: new RegExp(`Reschedule ${a.name}`) })
  await expect(move).toContainText('A message about the new time is made available in the patient portal')
  await move.getByLabel('Time').fill('19:00')
  await move.getByLabel('Reason for moving it').fill('Patient asked for the evening')
  await expectNoAxeViolations(page)
  await move.getByRole('button', { name: 'Move appointment' }).click()
  await expect(move).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: /^Moved to / })).toBeVisible()
  await expect(rowA).toContainText('7:00 pm')
  await expect(page.getByRole('listitem').filter({ hasText: a.name })).toHaveCount(1)

  // Its detail shows where it came from, the history, and that the message could not be delivered (no portal account), in-app only.
  await rowA.getByRole('button', { name: /Details/ }).click()
  const detail = page.getByRole('dialog', { name: 'Appointment' })
  await expect(detail).toContainText('Replaces the appointment on')
  await expect(detail.getByRole('list', { name: 'Status changes' })).toContainText('Created as booked')
  await expect(detail.getByRole('list', { name: 'Status changes' })).toContainText('Rescheduled')
  await expect(detail).toContainText('Patient portal only: no SMS, email or push message is sent.')
  await expect(detail.getByTestId('notification-appointment.rescheduled')).toContainText('Not delivered')
  await expect(detail.getByTestId('notification-appointment.rescheduled')).toContainText('The patient has no active portal account.')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
  await detail.getByRole('button', { name: 'Close dialog' }).click()

  // Cancel the second (from its details), with a reason.
  await rowB.getByRole('button', { name: /Details/ }).click()
  await page.getByRole('dialog', { name: 'Appointment' }).getByRole('button', { name: 'Cancel…' }).click()
  const cancel = page.getByRole('dialog', { name: new RegExp(`Cancel ${b.name}`) })
  await cancel.getByRole('button', { name: 'Cancel appointment' }).click()
  await expect(cancel.getByText('Give a reason')).toBeVisible()
  await cancel.getByLabel('Reason').fill('Patient is travelling')
  await cancel.getByRole('button', { name: 'Cancel appointment' }).click()
  await expect(cancel).toBeHidden()
  await expect(rowB).toContainText('Cancelled')
  // A cancelled appointment offers no changes.
  await rowB.getByRole('button', { name: /Details/ }).click()
  const closed = page.getByRole('dialog', { name: 'Appointment' })
  await expect(closed).toContainText('This appointment is closed.')
  await expect(closed.getByRole('button', { name: 'Reschedule…' })).toHaveCount(0)
  await expect(closed.getByRole('button', { name: 'Cancel…' })).toHaveCount(0)
  await closed.getByRole('button', { name: 'Close dialog' }).click()

  // The patient's own record lists both, with their state.
  await page.goto(`/nurse/patients/${b.id}`)
  await expect(page.getByRole('region', { name: 'Appointments' })).toContainText('Cancelled')
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
  await api.dispose()
})

test('check-in makes the one visit and links it; the queue shows it; the appointment ends with the consultation; the doctor sees it in their schedule', async ({ page, browser, baseURL, isMobile }) => {
  const nurseApi = await staff(baseURL!, 'nurse.anil')
  const doctorApi = await staff(baseURL!, 'dr.meera')
  const slot = await randomSlot(nurseApi)
  const p = await newPatient(nurseApi, `Ci${uniq()}`)
  const appt = await bookViaApi(nurseApi, p.id, slot)
  // Booking needs a future time; this one is moved to today (e2e database only), so the test runs at any hour.
  await moveAppointmentToToday(appt.id, hhmm(6 + Math.floor(Math.random() * 16), 5 * Math.floor(Math.random() * 12)))

  await signIn(page, 'nurse.anil')
  await page.goto('/nurse/appointments')
  const row = page.getByRole('listitem').filter({ hasText: p.name })
  await expect(row).toContainText('Booked')
  await expect(row.getByRole('button', { name: 'Check in' })).toBeVisible()
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
  await row.getByRole('button', { name: 'Check in' }).click()
  await expect(page.getByRole('status').filter({ hasText: /checked in\. Token \d+/ })).toBeVisible()
  await expect(row).toContainText('Checked in')
  await expect(row.getByTestId('linked-visit')).toContainText('Visit: token')
  await expect(row.getByTestId('linked-visit')).toContainText('Waiting')
  // A checked-in appointment is closed by its visit, not by hand: no way to cancel or move it here.
  await expect(row.getByRole('button', { name: 'Check in' })).toHaveCount(0)
  await row.getByRole('button', { name: /Details/ }).click()
  const checkedIn = page.getByRole('dialog', { name: 'Appointment' })
  await expect(checkedIn).toContainText('Checked in: the visit in the queue decides how this ends.')
  await expect(checkedIn.getByRole('button', { name: 'Cancel…' })).toHaveCount(0)
  await expect(checkedIn.getByRole('button', { name: 'Reschedule…' })).toHaveCount(0)
  await checkedIn.getByRole('button', { name: 'Close dialog' }).click()

  // The same patient is in today's queue exactly once, with the appointment time; no consultation was started.
  await page.goto('/nurse')
  const queued = page.getByRole('list', { name: 'Visits' }).getByRole('listitem').filter({ hasText: p.name })
  await expect(queued).toHaveCount(1)
  await expect(queued).toContainText('appointment')
  await expect(queued).toContainText('Waiting')
  await expect(queued.getByRole('button', { name: 'Ready for doctor' })).toBeVisible()
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)

  // The doctor's own schedule shows it (unassigned in their department), with its visit; nothing is "with doctor" yet.
  const doc = await otherContext(browser, baseURL!, isMobile)
  await signIn(doc.page, 'dr.meera')
  await doc.page.goto('/doctor/appointments')
  await expect(doc.page.getByRole('button', { name: 'My schedule' })).toHaveAttribute('aria-pressed', 'true')
  const mine = doc.page.getByRole('listitem').filter({ hasText: p.name })
  await expect(mine).toContainText('Checked in')
  await expect(mine.getByTestId('linked-visit')).toContainText('Waiting')
  await expectNoAxeViolations(doc.page)
  await expectNoHorizontalOverflow(doc.page)

  // The consultation is signed and then completed (set up by API; its UI is covered elsewhere): the appointment completes by itself with its visit.
  const visits = ((await (await nurseApi.get('/api/visits')).json()).visits as { id: string; patient: { id: string } }[]).filter((v) => v.patient.id === p.id)
  expect(visits).toHaveLength(1)
  await nurseApi.post(`/api/visits/${visits[0]!.id}/status`, { data: { status: 'ready' } })
  const e = await (await doctorApi.post(`/api/visits/${visits[0]!.id}/encounter`)).json()
  const saved = await (
    await doctorApi.put(`/api/encounters/${e.id}/draft`, {
      data: { version: e.version, note: { ...e.note, chiefComplaint: 'Sore throat', assessment: 'Viral pharyngitis', plan: 'Fluids' }, diagnoses: [{ description: 'Viral pharyngitis', kind: 'provisional' }], prescription: [] },
    })
  ).json()
  expect((await doctorApi.post(`/api/encounters/${e.id}/sign`, { data: { version: saved.version, attestation: true } })).ok()).toBe(true)
  // Doctor HERO final (DESIGN §5.6, §6): signing no longer completes the visit; the doctor's explicit Complete does, and the appointment follows it.
  await doc.page.goto('/doctor/appointments')
  const signedOnly = doc.page.getByRole('listitem').filter({ hasText: p.name })
  await expect(signedOnly).toContainText('Checked in')
  await expect(signedOnly.getByTestId('linked-visit')).toContainText('With doctor')
  await expect(signedOnly).not.toContainText('Completed')
  expect((await doctorApi.post(`/api/encounters/${e.id}/complete`, { data: {} })).ok()).toBe(true)
  await doc.page.goto('/doctor/appointments')
  await expect(doc.page.getByRole('listitem').filter({ hasText: p.name })).toContainText('Completed')
  await doc.page.getByRole('listitem').filter({ hasText: p.name }).getByRole('button', { name: /Details/ }).click()
  const detail = doc.page.getByRole('dialog', { name: 'Appointment' })
  await expect(detail.getByRole('list', { name: 'Status changes' })).toContainText('Followed its visit')
  await expectNoAxeViolations(doc.page)
  await doc.ctx.close()
  await nurseApi.dispose()
  await doctorApi.dispose()
})

test('the patient is told in the portal once they have an account: undelivered at first, retried by staff, then read by the patient', async ({ page, browser, baseURL, isMobile }) => {
  const api = await staff(baseURL!, 'nurse.anil')
  const slot = await randomSlot(api)
  const p = await newPatient(api, `Po${uniq()}`)
  await api.post(`/api/patients/${p.id}/consents`, { data: { type: 'portal_access', method: 'verbal' } })
  await bookViaApi(api, p.id, slot)

  // Staff: the message could not be delivered yet.
  await signIn(page, 'nurse.anil')
  await page.goto('/nurse/appointments')
  await page.getByRole('group', { name: 'Which appointments' }).getByRole('button', { name: 'A date' }).click()
  await page.getByLabel('Date').fill(slot.date)
  const row = page.getByRole('listitem').filter({ hasText: p.name })
  await row.getByRole('button', { name: /Details/ }).click()
  const detail = page.getByRole('dialog', { name: 'Appointment' })
  const booked = detail.getByTestId('notification-appointment.booked')
  await expect(booked).toContainText('Not delivered')
  await expect(booked).toContainText('1 attempt')

  // The patient activates their portal account.
  const code = (await (await api.post(`/api/patients/${p.id}/portal-activation`)).json()).activationCode as string
  const patient = await otherContext(browser, baseURL!, isMobile)
  await patient.page.goto('/activate')
  await patient.page.getByLabel('MRN').fill(p.mrn)
  await patient.page.getByLabel('Activation code').fill(code)
  await patient.page.getByLabel('Choose a password').fill('Synthetic-portal-pass-1')
  await patient.page.getByLabel(/I understand this portal shows my own records/).check()
  await patient.page.getByRole('button', { name: /Activate/ }).click()
  await expect(patient.page).toHaveURL(/\/patient$/)

  // Staff try again: delivered, available in the portal.
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(booked).toContainText('Available in the patient portal')
  await expect(booked).toContainText('2 attempts')
  await expect(detail.getByRole('button', { name: 'Try again' })).toHaveCount(0)

  // The patient sees the message and the appointment, on the clinic's clock, and reads it.
  await patient.page.goto('/patient/appointments')
  const messages = patient.page.getByRole('region', { name: 'Messages from the clinic' })
  await expect(messages).toContainText('Appointment booked')
  await expect(messages).toContainText('General Medicine')
  await expect(messages).toContainText('The clinic does not send text messages or email from this system.')
  await expect(messages.getByText('New', { exact: true })).toBeVisible()
  // The appointment on the clinic's clock, with its department; the booking reason is staff-only and is not shown to the patient.
  const upcoming = patient.page.getByRole('region', { name: 'Upcoming appointments' })
  await expect(upcoming).toContainText(clockText(slot.time))
  await expect(upcoming).toContainText('General Medicine')
  await expect(patient.page.locator('main')).not.toContainText('Sore throat')
  await expectNoAxeViolations(patient.page)
  await expectNoHorizontalOverflow(patient.page)
  await messages.getByRole('button', { name: /Mark as read/ }).click()
  await expect(messages.getByText('New', { exact: true })).toHaveCount(0)
  // Staff then see that it was seen.
  await detail.getByRole('button', { name: 'Close dialog' }).click()
  await row.getByRole('button', { name: /Details/ }).click()
  await expect(page.getByRole('dialog', { name: 'Appointment' }).getByTestId('notification-appointment.booked')).toContainText('Seen by the patient')
  await patient.ctx.close()
  await api.dispose()
})

test('an administrator sees the facility’s schedule without patient identity, and cannot book or change anything', async ({ page, baseURL }) => {
  const api = await staff(baseURL!, 'nurse.anil')
  const slot = await randomSlot(api)
  const p = await newPatient(api, `Ad${uniq()}`)
  await bookViaApi(api, p.id, slot)

  await signIn(page, 'admin')
  await page.goto('/admin/appointments')
  await expect(page.getByRole('heading', { name: 'Appointments' })).toBeVisible()
  await expect(page.getByText('Patient names and reasons are not shown to administrators')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Book appointment' })).toHaveCount(0)
  await page.getByRole('group', { name: 'Which appointments' }).getByRole('button', { name: 'A date' }).click()
  await page.getByLabel('Date').fill(slot.date)
  const row = page.getByRole('listitem').filter({ hasText: 'Patient not shown' }).filter({ hasText: 'General Medicine' }).filter({ hasText: clockText(slot.time) }).first()
  await expect(row).toContainText('Booked')
  await expect(page.locator('main')).not.toContainText(p.given)
  await expect(page.locator('main')).not.toContainText('Sore throat')
  await expect(row.getByRole('button', { name: 'Cancel…' })).toHaveCount(0)
  await expect(row.getByRole('button', { name: /Details/ })).toHaveCount(0)
  await expectNoAxeViolations(page)
  await expectNoHorizontalOverflow(page)
  await api.dispose()
})
