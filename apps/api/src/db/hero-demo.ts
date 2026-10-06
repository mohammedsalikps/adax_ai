// SYNTHETIC demo for the Doctor HERO consultation (docs/adr/0022). Everything here is fictional.
//   npm run demo:hero                  after `npm run db:seed` (and `npm run db:migrate`)
//   npm run demo:hero -- --no-attach   the same, but the simulator band is left unattached (attach it from the consultation instead)
//
// What it makes, through the real API in-process (sign-in, registration, consent, history entries, signing, the device registry, audit), so the
// data is made exactly as a user would make it:
//   - Anaya Demo-Synthetic, a fictional girl of 6: consents to data processing, recording, device readings, the record assistant and thermal
//     imaging; an allergy to amoxicillin (rash, moderate); a salbutamol inhaler as a current medicine; one earlier SIGNED consultation about two
//     months ago (a chest infection with wheeze) with its note and prescription. She is found again by name and date of birth, and each of these
//     is added only if it is not there yet.
//   - On every run, a NEW visit for today ("Fever for three days and mild cough") with the nurse's vital signs, ready for Dr. Meera. A visit of
//     today that nobody has started is cancelled first, with a reason; one with a consultation the doctor has started is left alone, and the run
//     stops and says what to do.
//   - A SIMULATOR band record (registered once; a program that generates values, never a device), attached to her, with its gateway token in
//     .data/sim/ (git-ignored, never printed), for `npm run devices:simulate`.
// The record matches the script of the synthetic demo audio (scripts/demo-audio.ps1): fever for three days, a mild cough, wheeze at night, a similar
// chest infection two months ago, salbutamol, a rash with amoxicillin. What the speech model transcribes from that audio can be checked against it.
// It refuses to run in production, outside a synthetic deployment, outside the synthetic facility, or beside records marked as clinical.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Device } from '@adaxai/contracts'
import { eq, sql } from 'drizzle-orm'
import type { InjectOptions } from 'fastify'
import { buildApp } from '../app.ts'
import { type Config, loadConfig, loadDotEnv, REPO_ROOT } from '../config.ts'
import { createDb } from './client.ts'
import { createAdminClient, createAppPool } from './pool.ts'
import { facilities, patients, users } from './schema.ts'

export const HERO_PATIENT = { givenName: 'Anaya', familyName: 'Demo-Synthetic', dateOfBirth: '2020-05-14', sex: 'female', phone: '5000190006', city: 'Synthetic City', bloodGroup: 'O+', preferredLanguage: 'English' } as const
export const HERO_CONSENTS = ['data_processing', 'ai_recording', 'device_monitoring', 'ai_record_assistant', 'thermal_imaging'] as const
export const HERO_ALLERGY = { substance: 'Amoxicillin', reaction: 'Rash', severity: 'moderate' } as const
export const HERO_TODAY_COMPLAINT = 'Fever for three days and mild cough'
export const HERO_BAND = { serialNumber: 'SIM-BAND-HERO-1', kind: 'wearable_band', label: 'Simulator band for the hero demo (not a device)' } as const
const DOCTOR = 'dr.meera'
const PAST_DAYS_AGO = 60

/** The earlier consultation: a chest infection with wheeze, about two months before the day the seed runs. No penicillin: she is allergic to amoxicillin. */
export const HERO_PAST = {
  complaint: 'Cough, fever and wheeze for two days',
  vitals: [
    { kind: 'temperature', value: 38.1 },
    { kind: 'heart_rate', value: 118 },
    { kind: 'respiratory_rate', value: 30 },
    { kind: 'spo2', value: 96 },
    { kind: 'weight', value: 20 },
  ],
  note: {
    history: 'Two days of cough and fever after a cold, with wheeze at night. Drinking well, eating a little less. Brought by her father. (Synthetic demo record.)',
    pastHistory: 'No earlier chest infections recorded. Allergy: amoxicillin (rash).',
    examination: 'Alert and playful. Breathing a little fast. Scattered wheeze on both sides, no crackles, no chest indrawing.',
    assessment: 'Lower respiratory tract infection with wheeze.',
    plan: 'Salbutamol inhaler with a spacer when needed for wheeze. Paracetamol for fever. Plenty of fluids. Come back at once if breathing becomes hard, the lips look blue, or she cannot drink.',
    followUp: 'Review in one week, or sooner if worse.',
  },
  diagnoses: [
    { description: 'Acute lower respiratory infection, unspecified', code: 'J22', kind: 'primary' },
    { description: 'Wheezing', code: 'R06.2', kind: 'secondary' },
  ],
  prescription: [
    { drugName: 'Salbutamol inhaler', strength: '100 mcg per puff', form: 'Inhaler', dose: '2 puffs with a spacer', route: 'Inhaled', frequency: 'When needed for wheeze, up to every 4 hours', duration: '14 days', instructions: 'Come back if needed more often than every 4 hours' },
    { drugName: 'Paracetamol', strength: '250 mg/5 mL', form: 'Oral suspension', dose: '5 mL', route: 'Oral', frequency: 'Every 6 hours when needed for fever', duration: '3 days', instructions: 'No more than 4 doses in 24 hours' },
  ],
} as const

/** The medicine she takes now, started at the earlier consultation. */
export const HERO_MEDICATION = { drugName: 'Salbutamol inhaler', strength: '100 mcg per puff', form: 'Inhaler', dose: '2 puffs with a spacer', route: 'Inhaled', frequency: 'When needed for wheeze', reason: 'Wheeze with a chest infection' } as const

/** The nurse's vital signs today. A child's values are not flagged by the product (its reference ranges are for adults). */
export const HERO_TODAY_VITALS = [
  { kind: 'temperature', value: 38.6 },
  { kind: 'heart_rate', value: 124 },
  { kind: 'respiratory_rate', value: 28 },
  { kind: 'spo2', value: 96 },
  { kind: 'weight', value: 20.5 },
] as const

export interface HeroDemoResult {
  patientId: string
  mrn: string
  createdPatient: boolean
  /** Consents, the allergy, the earlier consultation and the medicine added in this run (0 when she was already complete). */
  historyAdded: number
  visit: { id: string; token: number }
  /** Today's visit that nobody had started, cancelled to make way for the new one. */
  replacedVisit: { id: string; token: number } | null
  band: {
    id: string
    registered: boolean
    /** attached: in this run; reattached: hers from an earlier run, attached again for today's visit; elsewhere: another patient's (not moved); skipped: --no-attach. */
    attachment: 'attached' | 'reattached' | 'elsewhere' | 'skipped'
    /** Where the gateway token was written in this run (absolute), or null when the existing one was kept. */
    tokenWritten: string | null
    tokenFile: string
  }
}

const addDays = (date: string, n: number) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + n)).toISOString().slice(0, 10)

/** Holds the clock the API reads at one moment while `fn` runs (its requests only), then puts it back. The same as in hospital-seed.ts. */
async function withClockAt<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date
  const fixed = at.getTime()
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args) => (args.length ? Reflect.construct(target, args) : new target(fixed)),
    get: (target, prop, receiver) => (prop === 'now' ? () => fixed : Reflect.get(target, prop, receiver)),
  })
  try {
    return await fn()
  } finally {
    globalThis.Date = RealDate
  }
}

export async function seedHeroDemo(
  opts: {
    config?: Config
    password?: string
    log?: (m: string) => void
    /** Where the simulator band's gateway token is written (default .data/sim at the repository root). */
    simDir?: string
    /** Attach the simulator band to the patient (default true). */
    attachBand?: boolean
  } = {},
): Promise<HeroDemoResult> {
  const log = opts.log ?? ((m: string) => console.log(`[hero-demo] ${m}`))
  if (!opts.config) loadDotEnv()
  const config = opts.config ?? loadConfig()
  const password = opts.password ?? process.env.SEED_DEMO_PASSWORD
  if (!password) throw new Error('SEED_DEMO_PASSWORD is not set (run `npm run setup`).')
  if (config.env === 'production') throw new Error('Refusing: this is a production deployment. The synthetic hero demo is never seeded into one.')
  if (config.dataOrigin !== 'synthetic') throw new Error('Refusing: DATA_ORIGIN is not "synthetic". The hero demo is fictional and is only seeded into a synthetic deployment.')
  const simDir = opts.simDir ?? path.join(REPO_ROOT, '.data', 'sim')
  const attachBand = opts.attachBand ?? true

  const pool = createAppPool(config.db)
  const app = buildApp({ config, pool, logger: false })
  const db = createDb(pool)
  const admin = createAdminClient(config.db)
  await admin.connect()
  try {
    // --- where it is allowed to write ----------------------------------------------------------------------------------
    const facility = await db.query.facilities.findFirst({ where: eq(facilities.code, 'DEMO-OPD-01') })
    if (!facility) throw new Error('The synthetic facility is missing. Run `npm run db:seed` first.')
    if (!facility.name.endsWith('(synthetic)')) throw new Error('Refusing: the facility is not marked synthetic.')
    const [clinical] = await db.select({ n: sql<number>`count(*)::int` }).from(patients).where(eq(patients.dataOrigin, 'clinical'))
    if (clinical!.n > 0) throw new Error('Refusing: this database holds patients marked as clinical. The synthetic demo is not seeded beside real records.')
    for (const username of ['admin', 'nurse.anil', DOCTOR]) {
      const u = await db.query.users.findFirst({ where: eq(users.username, username) })
      if (!u || u.facilityId !== facility.id) throw new Error(`Refusing: ${username} is not an account of the synthetic facility. Run \`npm run db:seed\` first.`)
    }
    const doctorId = (await db.query.users.findFirst({ where: eq(users.username, DOCTOR) }))!.id

    // --- sessions --------------------------------------------------------------------------------------------------
    async function session(username: string) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-adaxai-csrf': '1' }, payload: { username, password } })
      if (res.statusCode !== 200) throw new Error(`sign-in as ${username} failed (${res.statusCode}). Run npm run db:seed first.`)
      const cookie = res.cookies.find((c) => c.name === 'adaxai_session')!
      return async (method: InjectOptions['method'], url: string, payload?: unknown) => {
        const r = await app.inject({ method, url, headers: { cookie: `adaxai_session=${cookie.value}`, 'x-adaxai-csrf': '1' }, ...(payload !== undefined && { payload: payload as InjectOptions['payload'] }) })
        if (r.statusCode >= 400) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body.slice(0, 300)}`)
        return r.json()
      }
    }
    const nurse = await session('nurse.anil')
    const doctor = await session(DOCTOR)
    const registry = await session('admin')
    const gen = ((await nurse('GET', '/api/departments')).departments as { id: string; code: string }[]).find((d) => d.code === 'GEN')
    if (!gen) throw new Error('The GEN department is missing. Run `npm run db:seed` first.')
    const today = ((await nurse('GET', '/api/appointments/options')) as { today: string }).today

    // --- the patient -----------------------------------------------------------------------------------------------
    const fullName = `${HERO_PATIENT.givenName} ${HERO_PATIENT.familyName}`
    const found = ((await nurse('GET', `/api/patients?q=${encodeURIComponent(fullName)}&limit=50`)).patients as { id: string; fullName: string; dateOfBirth: string; mrn: string }[]).find(
      (p) => p.fullName === fullName && p.dateOfBirth === HERO_PATIENT.dateOfBirth,
    )
    const created = found ? null : ((await nurse('POST', '/api/patients', { ...HERO_PATIENT, confirmNotDuplicate: true })) as { id: string; mrn: string })
    const patientId = found?.id ?? created!.id
    const mrn = found?.mrn ?? created!.mrn

    // --- her history: each step only if it is not there yet -----------------------------------------------------------
    let historyAdded = 0
    const detail = await nurse('GET', `/api/patients/${patientId}`)
    const granted = new Set((detail.consents as { type: string; status: string }[]).filter((c) => c.status === 'granted').map((c) => c.type))
    for (const type of HERO_CONSENTS) {
      if (granted.has(type)) continue
      await nurse('POST', `/api/patients/${patientId}/consents`, { type, method: 'verbal', notes: 'Synthetic demo consent (given by the parent)' })
      historyAdded++
    }
    if (!(detail.allergies as { substance: string; status: string }[]).some((a) => a.status === 'active' && a.substance.toLowerCase() === HERO_ALLERGY.substance.toLowerCase())) {
      await nurse('POST', `/api/patients/${patientId}/allergies`, HERO_ALLERGY)
      historyAdded++
    }
    const pastDate = addDays(today, -PAST_DAYS_AGO)
    // Found among all her visits (the history read model returns only the newest consultations, and every demo signed today is one more).
    const visitsOf = async () => (await nurse('GET', `/api/patients/${patientId}/visits`)).visits as { id: string; visitDate: string; status: string; tokenNumber: number; chiefComplaint: string | null; encounterId: string | null }[]
    const earlier = (await visitsOf()).filter((v) => v.chiefComplaint === HERO_PAST.complaint && v.status !== 'cancelled' && v.status !== 'no_show')
    const statusOf = async (encounterId: string | null) => (encounterId ? ((await doctor('GET', `/api/encounters/${encounterId}`)) as { status: string }).status : null)
    const unfinished = earlier.some((v) => v.status === 'completed') ? undefined : earlier[0]
    if (unfinished && (await statusOf(unfinished.encounterId)) === 'signed') {
      // A run that stopped between signing and completing the earlier consultation: its record is whole, only the seed's last step is left.
      await doctor('POST', `/api/encounters/${unfinished.encounterId}/complete`, {})
      historyAdded++
    } else if (!earlier.some((v) => v.status === 'completed')) {
      // A run that stopped inside the earlier consultation leaves its visit (and perhaps an unsigned draft) behind: a person decides about that, not the seed.
      if (unfinished) throw new Error(`An earlier run stopped inside the demo's earlier consultation (visit of ${unfinished.visitDate}, ${unfinished.status}). Discard that draft and cancel the visit in the app, then run again.`)
      const at = new Date(Date.now() - PAST_DAYS_AGO * 86_400_000)
      const v = await nurse('POST', '/api/visits', { patientId, departmentId: gen.id, chiefComplaint: HERO_PAST.complaint })
      await nurse('POST', `/api/visits/${v.id}/observations`, { items: HERO_PAST.vitals, measuredAt: new Date(at.getTime() - 20 * 60_000).toISOString() })
      await nurse('POST', `/api/visits/${v.id}/status`, { status: 'ready' })
      const e = await doctor('POST', `/api/visits/${v.id}/encounter`)
      // The visit gets its historical date (and the next free token that day) before it is signed, so the signed record carries it. The audit log
      // still shows the day the seed ran, which is true.
      await admin.query('BEGIN')
      try {
        await admin.query('SET LOCAL session_replication_role = replica')
        await admin.query(
          `UPDATE visits SET visit_date = $2::date, token_number = (SELECT coalesce(max(v2.token_number), 0) + 1 FROM visits v2 WHERE v2.facility_id = visits.facility_id AND v2.visit_date = $2::date) WHERE id = $1`,
          [v.id, pastDate],
        )
        await admin.query('UPDATE encounters SET started_at = $2 WHERE id = $1', [e.id, new Date(at.getTime() - 15 * 60_000).toISOString()])
        await admin.query('COMMIT')
      } catch (err) {
        await admin.query('ROLLBACK').catch(() => undefined)
        throw err
      }
      const saved = await doctor('PUT', `/api/encounters/${e.id}/draft`, { version: e.version, note: { chiefComplaint: HERO_PAST.complaint, ...HERO_PAST.note }, diagnoses: HERO_PAST.diagnoses, prescription: HERO_PAST.prescription })
      await withClockAt(at, () => doctor('POST', `/api/encounters/${e.id}/sign`, { version: saved.version, attestation: true }))
      // Signing no longer completes the visit (HERO final): the doctor completes the consultation, as in the app.
      await withClockAt(at, () => doctor('POST', `/api/encounters/${e.id}/complete`, {}))
      historyAdded++
    }
    // Any entry of that medicine counts, current or stopped: one a doctor stopped during a demo is not added again.
    const history = await nurse('GET', `/api/patients/${patientId}/history`)
    if (!(history.medications as { drugName: string }[]).some((m) => m.drugName.toLowerCase() === HERO_MEDICATION.drugName.toLowerCase())) {
      await doctor('POST', `/api/patients/${patientId}/medications`, { ...HERO_MEDICATION, startedOn: pastDate })
      historyAdded++
    }

    // --- today's visit: a new one on every run ------------------------------------------------------------------------
    const open = (await visitsOf()).find((v) => v.visitDate === today && ['waiting', 'in_triage', 'ready', 'in_consultation'].includes(v.status))
    if (open?.encounterId) {
      // Signed but not completed (HERO final: completing is the doctor's own step): the doctor completes it, not the seed.
      if ((await statusOf(open.encounterId)) === 'signed') throw new Error(`Today's demo visit (token ${open.tokenNumber}) has a signed consultation that is not completed yet. Complete it in the app (as ${DOCTOR}), then run again for a new visit.`)
      throw new Error(`Today's demo visit (token ${open.tokenNumber}) has a consultation that is not signed yet. Sign or discard it in the app (as ${DOCTOR}), then run again for a new visit.`)
    }
    let replacedVisit: HeroDemoResult['replacedVisit'] = null
    if (open) {
      await nurse('POST', `/api/visits/${open.id}/status`, { status: 'cancelled', reason: 'Replaced by a new visit of the synthetic hero demo (npm run demo:hero)' })
      replacedVisit = { id: open.id, token: open.tokenNumber }
    }
    const visit = await nurse('POST', '/api/visits', { patientId, departmentId: gen.id, assignedDoctorId: doctorId, chiefComplaint: HERO_TODAY_COMPLAINT })
    await nurse('POST', `/api/visits/${visit.id}/observations`, { items: HERO_TODAY_VITALS })
    await nurse('POST', `/api/visits/${visit.id}/status`, { status: 'ready' })

    // --- the simulator band ----------------------------------------------------------------------------------------
    let list = (await registry('GET', '/api/devices')) as { devices: Device[]; simulatorAllowed: boolean }
    if (!list.simulatorAllowed) throw new Error('This deployment does not allow simulators (its data is clinical, or it runs in production). The band was not registered.')
    let band = list.devices.find((d) => d.serialNumber === HERO_BAND.serialNumber)
    if (band && !band.simulated) throw new Error(`A device with serial ${HERO_BAND.serialNumber} exists and is not a simulator. It was left alone.`)
    const registered = !band
    if (!band) band = (await registry('POST', '/api/admin/devices', { ...HERO_BAND, integration: 'simulator', manufacturer: 'ADAXAI', model: 'device-sim-v1', notes: 'A program that generates values for the synthetic hero demo. Not a device.' })) as Device
    const tokenFile = path.join(simDir, `${HERO_BAND.serialNumber}.token`)
    let tokenWritten: string | null = null
    if (registered || !band.hasToken || !fs.existsSync(tokenFile)) {
      const { token } = (await registry('POST', `/api/admin/devices/${band.id}/token`)) as { token: string }
      fs.mkdirSync(simDir, { recursive: true })
      fs.writeFileSync(tokenFile, token, { mode: 0o600 })
      tokenWritten = tokenFile
    }
    let attachment: HeroDemoResult['band']['attachment'] = 'skipped'
    if (attachBand) {
      list = (await nurse('GET', '/api/devices')) as typeof list
      const a = list.devices.find((d) => d.id === band!.id)!.assignment
      if (a && a.patientId !== patientId) attachment = 'elsewhere'
      else {
        // Attached to her in an earlier run: that assignment ends and a new one names today's visit.
        if (a) await nurse('POST', `/api/device-assignments/${a.id}/end`, { reason: 'Attached again for a new visit of the synthetic hero demo' })
        await nurse('POST', `/api/devices/${band.id}/assignments`, { patientId, visitId: visit.id })
        attachment = a ? 'reattached' : 'attached'
      }
    }

    // --- what was done, and what to do next ---------------------------------------------------------------------------
    const tokenRel = path.relative(REPO_ROOT, tokenFile).split(path.sep).join('/')
    const what = 'consents, amoxicillin allergy, earlier signed consultation, salbutamol inhaler'
    log(`${fullName} (${mrn}), a fictional girl of 6, synthetic: ${created ? 'created' : 'found'}; ${historyAdded ? `${historyAdded} history entr${historyAdded === 1 ? 'y' : 'ies'} added (${what})` : `her history was already complete (${what})`}.`)
    log(`Today's visit: token ${visit.tokenNumber}, "${HERO_TODAY_COMPLAINT}", vital signs recorded, ready for Dr. Meera.${replacedVisit ? ` (Today's unused visit, token ${replacedVisit.token}, was cancelled to make way for it.)` : ''}`)
    log(
      `Simulator band ${HERO_BAND.serialNumber} (a SIMULATOR record, not a device): ${registered ? 'registered' : 'already registered'}; ${
        {
          attached: `attached to ${fullName}`,
          reattached: `attached to ${fullName} again, for today's visit`,
          elsewhere: 'attached to another patient, not moved (end that assignment to use it here)',
          skipped: 'its attachment left as it was (--no-attach)',
        }[attachment]
      }; gateway token ${tokenWritten ? 'written to' : 'kept in'} ${tokenRel} (git-ignored; never printed).`,
    )
    log('Next:')
    log(`  1. Sign in as ${DOCTOR} (the demo password is SEED_DEMO_PASSWORD in .env) and start the consultation for ${fullName} from today's queue.`)
    log(`  2. Optional, in another terminal: npm run devices:simulate -- --token-file ${tokenRel} --scenario fever   (generated values, shown as SIMULATED)`)
    log('  3. In the Conversation module: "Play demo consultation" (SYNTHETIC AUDIO: computer voices, transcribed by the local speech model).')
    return {
      patientId,
      mrn,
      createdPatient: !!created,
      historyAdded,
      visit: { id: visit.id, token: visit.tokenNumber },
      replacedVisit,
      band: { id: band.id, registered, attachment, tokenWritten, tokenFile },
    }
  } finally {
    await admin.end()
    await app.close()
    await pool.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await seedHeroDemo({ attachBand: !process.argv.includes('--no-attach') })
  } catch (e) {
    console.error(`[hero-demo] ERROR ${(e as Error).message}`)
    process.exitCode = 1
  }
}
