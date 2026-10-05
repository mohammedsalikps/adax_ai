// Simulator records for development and demonstration (docs/DEVICES.md). Nothing here is a device:
//   npm run demo:devices                 registers two SIMULATOR records (a band and a stethoscope), attaches the band to the synthetic demo
//                                        patient of `npm run demo:seed`, and writes their gateway tokens to .data/sim/ (git-ignored)
//   npm run demo:devices -- --new-token  issues new tokens (the old ones stop working)
// Then `npm run devices:simulate` posts generated values through the band's token, and the application shows them as SIMULATED.
// It drives the real API in-process (sign-in, registry, consent, assignment, audit), as a user would. Idempotent. The server refuses all of
// this in a clinical or production deployment.
import fs from 'node:fs'
import path from 'node:path'
import type { Device } from '@adaxai/contracts'
import type { InjectOptions } from 'fastify'
import { buildApp } from '../app.ts'
import { loadConfig, loadDotEnv, REPO_ROOT } from '../config.ts'
import { createAppPool } from '../db/pool.ts'

loadDotEnv()
const config = loadConfig()
const password = process.env.SEED_DEMO_PASSWORD
if (!password) {
  console.error('[demo-devices] SEED_DEMO_PASSWORD is not set (run `npm run setup`).')
  process.exit(2)
}
const say = (msg: string) => console.log(`[demo-devices] ${msg}`)
const newToken = process.argv.includes('--new-token')
const SIM_DIR = path.join(REPO_ROOT, '.data', 'sim')
const RECORDS = [
  { serialNumber: 'SIM-BAND-1', kind: 'wearable_band', label: 'Simulator band 1 (not a device)' },
  { serialNumber: 'SIM-STETH-1', kind: 'smart_stethoscope', label: 'Simulator stethoscope 1 (not a device)' },
] as const
const DEMO_PATIENT = 'Demo-Synthetic'

const pool = createAppPool(config.db)
const app = buildApp({ config, pool, logger: false })

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

try {
  const admin = await session('admin')
  const nurse = await session('nurse.anil')
  let list = (await admin('GET', '/api/devices')) as { devices: Device[]; simulatorAllowed: boolean }
  if (!list.simulatorAllowed) throw new Error('this deployment does not allow simulators (its data is clinical, or it runs in production). Nothing was changed.')
  fs.mkdirSync(SIM_DIR, { recursive: true })
  for (const rec of RECORDS) {
    let d = list.devices.find((x) => x.serialNumber === rec.serialNumber)
    if (d && !d.simulated) throw new Error(`a device with serial ${rec.serialNumber} exists and is not a simulator. Nothing was changed.`)
    if (!d) {
      d = (await admin('POST', '/api/admin/devices', { ...rec, integration: 'simulator', manufacturer: 'ADAXAI', model: 'device-sim-v1', notes: 'A program that generates values for development and tests. Not a device.' })) as Device
      say(`registered the simulator record “${rec.label}”`)
    }
    const file = path.join(SIM_DIR, `${rec.serialNumber}.token`)
    if (newToken || !fs.existsSync(file) || !d.hasToken) {
      const { token } = (await admin('POST', `/api/admin/devices/${d.id}/token`)) as { token: string }
      fs.writeFileSync(file, token, { mode: 0o600 })
      say(`gateway token for ${rec.serialNumber} written to ${path.relative(REPO_ROOT, file)} (git-ignored; never printed)`)
    }
  }
  list = (await admin('GET', '/api/devices')) as typeof list

  // Attach the band to the synthetic demo patient, with the consent a real assignment needs.
  const found = ((await nurse('GET', `/api/patients?q=${encodeURIComponent(DEMO_PATIENT)}`)) as { patients: { id: string; fullName: string; mrn: string }[] }).patients.find((p) => p.fullName.endsWith(DEMO_PATIENT))
  const band = ((await nurse('GET', '/api/devices')) as typeof list).devices.find((x) => x.serialNumber === 'SIM-BAND-1')!
  if (!found) say('The demo patient does not exist yet (run `npm run demo:seed`). The simulator band is registered but not attached: attach it from a consultation.')
  else if (band.assignment) say(`The simulator band is already attached${band.assignment.patientId === found.id ? ` to ${found.fullName}` : ' to another patient'}; nothing changed.`)
  else {
    const detail = (await nurse('GET', `/api/patients/${found.id}`)) as { consents: { type: string; status: string }[] }
    if (!detail.consents.some((c) => c.type === 'device_monitoring' && c.status === 'granted')) {
      await nurse('POST', `/api/patients/${found.id}/consents`, { type: 'device_monitoring', method: 'verbal' })
      say(`recorded the synthetic demo patient’s consent to device readings (${found.mrn})`)
    }
    await nurse('POST', `/api/devices/${band.id}/assignments`, { patientId: found.id })
    say(`attached the simulator band to ${found.fullName} (${found.mrn})`)
  }
  say('Next: `npm run dev`, then in another terminal `npm run devices:simulate`. Open the patient’s consultation: the Device readings card shows the values as SIMULATED.')
} catch (e) {
  console.error(`[demo-devices] ERROR ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  await app.close()
  await pool.end()
}
