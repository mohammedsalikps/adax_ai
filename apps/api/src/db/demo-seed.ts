// Synthetic demonstration patient for the AI-assisted consultation demo
// (docs/DEMO.md). Everything here is fictional. Run after `npm run db:seed`:
//   npm run demo:seed               (once; does nothing if the demo patient exists)
//   npm run demo:seed -- --fresh    (another demo patient, e.g. for a clean re-run)
// It drives the real API in-process (sign-in, registration, consent,
// signing, audit), so the data is created exactly as a user would create it.
// Idempotent: if the demo patient already exists, nothing is changed.
import type { InjectOptions } from 'fastify'
import { buildApp } from '../app.ts'
import { loadConfig, loadDotEnv } from '../config.ts'
import { createAppPool } from './pool.ts'

loadDotEnv()
const config = loadConfig()
const password = process.env.SEED_DEMO_PASSWORD
if (!password) {
  console.error('[demo-seed] SEED_DEMO_PASSWORD is not set (run `npm run setup`).')
  process.exit(2)
}

const fresh = process.argv.includes('--fresh')
const suffix = fresh ? `-${Date.now().toString(36).slice(-4).toUpperCase()}` : ''
const DEMO = { givenName: 'Ravi', familyName: `Demo-Synthetic${suffix}`, dateOfBirth: '1971-03-14', sex: 'male', phone: fresh ? `90000 ${String(Date.now()).slice(-5)}` : '90000 00071', city: 'Synthetic City', confirmNotDuplicate: fresh }

const pool = createAppPool(config.db)
// The thermal service is not needed for this seed.
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
  const nurse = await session('nurse.anil')
  const doctor = await session('dr.meera')
  const existing = await nurse('GET', `/api/patients?q=${encodeURIComponent(DEMO.familyName)}`)
  if ((existing.patients as { fullName: string }[]).some((x) => x.fullName === `${DEMO.givenName} ${DEMO.familyName}`)) {
    console.log('[demo-seed] The demo patient already exists; nothing changed.')
  } else {
    const p = await nurse('POST', '/api/patients', DEMO)
    for (const type of ['data_processing', 'ai_recording', 'ai_record_assistant', 'clinical_photography', 'ai_image_analysis', 'research_use']) await nurse('POST', `/api/patients/${p.id}/consents`, { type, method: 'verbal', notes: 'Synthetic demo consent' })
    await nurse('POST', `/api/patients/${p.id}/allergies`, { substance: 'Penicillin', reaction: 'Rash', severity: 'moderate' })
    const depts = (await nurse('GET', '/api/departments')).departments as { id: string; code: string }[]
    const gen = depts.find((d) => d.code === 'GEN')!.id

    // An earlier consultation: diabetes on metformin (signed by the doctor).
    const v1 = await nurse('POST', '/api/visits', { patientId: p.id, departmentId: gen, chiefComplaint: 'Diabetes review' })
    await nurse('POST', `/api/visits/${v1.id}/observations`, { items: [{ kind: 'blood_glucose', value: 182 }, { kind: 'systolic_bp', value: 132 }, { kind: 'diastolic_bp', value: 84 }] })
    const e1 = await doctor('POST', `/api/visits/${v1.id}/encounter`)
    const saved = await doctor('PUT', `/api/encounters/${e1.id}/draft`, {
      version: e1.version,
      note: {
        chiefComplaint: 'Routine diabetes review (synthetic demo record).',
        history: 'Known type 2 diabetes for 4 years. No hypoglycaemic episodes.',
        pastHistory: 'Type 2 diabetes. Allergy: penicillin (rash).',
        examination: 'Well. BP 132/84.',
        assessment: 'Type 2 diabetes, fair control.',
        plan: 'Continue metformin. Diet advice. HbA1c at next visit.',
        followUp: 'Review in 3 months.',
      },
      diagnoses: [{ description: 'Type 2 diabetes mellitus without complications', code: 'E11.9', kind: 'primary' }],
      prescription: [{ drugName: 'Metformin', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Twice daily (BD)', duration: '90 days', instructions: 'After food' }],
    })
    await doctor('POST', `/api/encounters/${e1.id}/sign`, { version: saved.version, attestation: true })
    // Signing no longer completes the visit (HERO final): the doctor completes the consultation, so today's visit below can be made.
    await doctor('POST', `/api/encounters/${e1.id}/complete`, {})

    // Today's visit, ready for the doctor: fever, cough and chest pain on coughing.
    const v2 = await nurse('POST', '/api/visits', { patientId: p.id, departmentId: gen, chiefComplaint: 'Fever and cough for 3 days, chest pain when coughing' })
    await nurse('POST', `/api/visits/${v2.id}/observations`, {
      items: [
        { kind: 'temperature', value: 38.4 },
        { kind: 'heart_rate', value: 98 },
        { kind: 'systolic_bp', value: 138 },
        { kind: 'diastolic_bp', value: 86 },
        { kind: 'spo2', value: 95 },
      ],
    })
    await nurse('POST', `/api/visits/${v2.id}/status`, { status: 'ready' })
    console.log(`[demo-seed] Created ${DEMO.givenName} ${DEMO.familyName} (${p.mrn}): allergy, consents, one signed earlier consultation, and today's visit ready for Dr. Meera.`)
    console.log('[demo-seed] Sample transcript: demo/consultation-transcript.txt')
  }
} catch (e) {
  console.error(`[demo-seed] ERROR ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  await app.close()
  await pool.end()
}
