// SYNTHETIC jury demo clinic for the Doctor HERO (every person and record here is fictional).
//   npm run demo:jury     on a freshly migrated and seeded database (npm run db:migrate && npm run db:seed), on the day of the demo
//
// What it makes, through the real API in-process (sign-in, registration, consents, history entries, signing, completing, appointments, the
// device registry, audit), so the data is made exactly as staff would make it; only the dates of past visits are moved back (as hero-demo does):
//   - a small clinic for Dr. Meera Iyer (General Medicine): 20 fictional patients with ordinary Indian names (marked synthetic in the data);
//   - the primary demo patient, Ramesh Kumar (45, male, MRN ADX-001245 on a fresh database): hypertension and type 2 diabetes, a penicillin
//     allergy, three regular medicines, an appendectomy, four earlier consultations (signed and completed) with their vital signs, laboratory
//     results, a CBC report and a chest X-ray report (small synthetic PDFs), and today's visit, checked in and ready for Dr. Meera, with the
//     nurse's vital signs and a triage note;
//   - today's queue: 5 consultations completed, 1 in consultation (with a pending SIMULATED laboratory order), 6 waiting, 8 booked and not yet
//     arrived — times relative to when the seed runs (so run it on the morning of the demo);
//   - four weeks of earlier consultations, so the Week and Month views have real counts;
//   - a SIMULATOR band (attached to Ramesh for today) and a SIMULATOR stethoscope: programs that generate values, never devices;
//   - a patient-app activation code for Ramesh, written to .data/sim/jury-portal.txt (git-ignored; never printed).
// It refuses to run in production, outside a synthetic deployment, outside the synthetic facility, or beside records marked as clinical, and it
// stops without changes when the jury clinic already has today's queue.
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

const DOCTOR = 'dr.meera'
const CONSENTS = ['data_processing', 'ai_recording', 'device_monitoring', 'ai_record_assistant', 'thermal_imaging', 'clinical_photography', 'portal_access'] as const
const BAND = { serialNumber: 'SIM-BAND-JURY-1', kind: 'wearable_band', label: 'Simulator band (jury demo; not a device)' } as const
const STETH = { serialNumber: 'SIM-STETH-JURY-1', kind: 'smart_stethoscope', label: 'Simulator stethoscope (jury demo; not a device)' } as const
const RAMESH_MRN_NUMBER = 1245

type Sex = 'male' | 'female'
interface PersonSpec {
  given: string
  family: string
  dob: string
  sex: Sex
  phone: string
  blood?: string
  allergies?: { substance: string; reaction: string; severity: 'mild' | 'moderate' | 'severe' }[]
  conditions?: { name: string; code?: string; sinceYear: number; status?: 'active' | 'controlled' }[]
  medicines?: { drugName: string; strength: string; form: string; dose: string; route: string; frequency: string; reason: string }[]
}

/** The primary demo patient. Everything about him is coherent: no penicillin is ever prescribed to him. */
export const RAMESH: PersonSpec & { city: string; emergency: { name: string; phone: string } } = {
  given: 'Ramesh',
  family: 'Kumar',
  dob: '1981-03-12',
  sex: 'male',
  phone: '9876543210',
  blood: 'B+',
  city: 'Chennai',
  emergency: { name: 'Sunita Kumar (spouse)', phone: '9876567890' },
  allergies: [{ substance: 'Penicillin', reaction: 'Rash', severity: 'moderate' }],
  conditions: [
    { name: 'Essential hypertension', code: 'I10', sinceYear: 2019, status: 'controlled' },
    { name: 'Type 2 diabetes mellitus', code: 'E11.9', sinceYear: 2020, status: 'active' },
  ],
  medicines: [
    { drugName: 'Metformin', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: '1-0-1 (twice daily after food)', reason: 'Type 2 diabetes' },
    { drugName: 'Amlodipine', strength: '5 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: '1-0-0 (once daily, morning)', reason: 'Hypertension' },
    { drugName: 'Atorvastatin', strength: '10 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: '0-0-1 (once daily, night)', reason: 'Cardiovascular risk reduction' },
  ],
}

/** The rest of the clinic (ordinary names; each has a small coherent record). */
const OTHERS: PersonSpec[] = [
  { given: 'Priya', family: 'Sharma', dob: '1998-06-21', sex: 'female', phone: '9840011201', blood: 'O+', conditions: [{ name: 'Asthma', code: 'J45.909', sinceYear: 2012, status: 'controlled' }] },
  { given: 'Abdul', family: 'Rahman', dob: '1974-01-09', sex: 'male', phone: '9840011202', blood: 'A+', conditions: [{ name: 'Essential hypertension', code: 'I10', sinceYear: 2016, status: 'controlled' }], medicines: [{ drugName: 'Telmisartan', strength: '40 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: '1-0-0', reason: 'Hypertension' }] },
  { given: 'Lakshmi', family: 'N', dob: '1990-11-02', sex: 'female', phone: '9840011203', blood: 'B+', conditions: [{ name: 'Migraine', code: 'G43.909', sinceYear: 2015 }] },
  { given: 'Suresh', family: 'Babu', dob: '1966-04-15', sex: 'male', phone: '9840011204', blood: 'O+', conditions: [{ name: 'Type 2 diabetes mellitus', code: 'E11.9', sinceYear: 2011 }], medicines: [{ drugName: 'Glimepiride', strength: '1 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: '1-0-0', reason: 'Type 2 diabetes' }] },
  { given: 'Ananya', family: 'Rao', dob: '2002-08-30', sex: 'female', phone: '9840011205', blood: 'A-' },
  { given: 'Arjun', family: 'Mehta', dob: '1992-02-18', sex: 'male', phone: '9840011206', blood: 'AB+' },
  { given: 'Fatima', family: 'Begum', dob: '1979-07-07', sex: 'female', phone: '9840011207', blood: 'O+', conditions: [{ name: 'Hypothyroidism', code: 'E03.9', sinceYear: 2018, status: 'controlled' }], medicines: [{ drugName: 'Levothyroxine', strength: '50 mcg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: '1-0-0 (empty stomach)', reason: 'Hypothyroidism' }] },
  { given: 'Vikram', family: 'Singh', dob: '1987-12-12', sex: 'male', phone: '9840011208', blood: 'B-', allergies: [{ substance: 'Sulfa drugs', reaction: 'Itching', severity: 'mild' }] },
  { given: 'Meena', family: 'Pillai', dob: '1971-03-25', sex: 'female', phone: '9840011209', blood: 'A+', conditions: [{ name: 'Osteoarthritis of knee', code: 'M17.9', sinceYear: 2021 }] },
  { given: 'Karthik', family: 'Raj', dob: '1995-09-14', sex: 'male', phone: '9840011210', blood: 'O-' },
  { given: 'Divya', family: 'Nair', dob: '1999-05-05', sex: 'female', phone: '9840011211', blood: 'B+' },
  { given: 'Mohammed', family: 'Irfan', dob: '1984-10-22', sex: 'male', phone: '9840011212', blood: 'A+', allergies: [{ substance: 'Ibuprofen', reaction: 'Gastric upset', severity: 'mild' }] },
  { given: 'Sneha', family: 'Reddy', dob: '1993-01-27', sex: 'female', phone: '9840011213', blood: 'O+' },
  { given: 'Ravi', family: 'Shankar', dob: '1961-06-03', sex: 'male', phone: '9840011214', blood: 'AB-', conditions: [{ name: 'Chronic obstructive pulmonary disease', code: 'J44.9', sinceYear: 2017 }] },
  { given: 'Kavya', family: 'Iyer', dob: '1997-04-11', sex: 'female', phone: '9840011215', blood: 'A+' },
  { given: 'Harish', family: 'Menon', dob: '1976-08-19', sex: 'male', phone: '9840011216', blood: 'B+', conditions: [{ name: 'Dyslipidaemia', code: 'E78.5', sinceYear: 2020 }] },
  { given: 'Nandini', family: 'Das', dob: '1988-12-01', sex: 'female', phone: '9840011217', blood: 'O+' },
  { given: 'Gopal', family: 'Krishnan', dob: '1968-02-08', sex: 'male', phone: '9840011218', blood: 'A-', conditions: [{ name: 'Essential hypertension', code: 'I10', sinceYear: 2014, status: 'controlled' }] },
  { given: 'Rekha', family: 'Varma', dob: '1982-09-09', sex: 'female', phone: '9840011219', blood: 'B+' },
]

/** A consultation's content (note, diagnosis, prescription, vitals). */
interface ConsultSpec {
  complaint: string
  vitals: { kind: string; value: number }[]
  note: { history: string; pastHistory?: string; examination: string; assessment: string; plan: string; followUp: string }
  diagnoses: { description: string; code?: string; kind: 'primary' | 'secondary' }[]
  prescription: { drugName: string; strength: string; form: string; dose: string; route: string; frequency: string; duration: string; durationDays?: number; instructions: string }[]
}

const rx = (drugName: string, strength: string, dose: string, frequency: string, days: number, instructions: string, form = 'Tablet') => ({ drugName, strength, form, dose, route: 'Oral', frequency, duration: `${days} days`, durationDays: days, instructions })

/** Ramesh's earlier consultations (newest first): days ago, the hour of day, and the content. */
const RAMESH_PAST: { daysAgo: number; hour: number; c: ConsultSpec }[] = [
  {
    daysAgo: 12,
    hour: 10,
    c: {
      complaint: 'Fever and sore throat for two days',
      vitals: [
        { kind: 'temperature', value: 37.9 },
        { kind: 'heart_rate', value: 84 },
        { kind: 'systolic_bp', value: 130 },
        { kind: 'diastolic_bp', value: 86 },
        { kind: 'spo2', value: 98 },
        { kind: 'respiratory_rate', value: 18 },
        { kind: 'blood_glucose', value: 152 },
      ],
      note: {
        history: 'Fever and sore throat for two days, mild dry cough. No breathlessness. Taking his regular medicines.',
        examination: 'Throat congested, no exudate. Chest clear. No lymphadenopathy.',
        assessment: 'Acute upper respiratory tract infection (viral).',
        plan: 'Symptomatic treatment. Warm fluids, rest. Continue regular medicines. Review if fever beyond 3 days.',
        followUp: 'Review if not better in 3 days.',
      },
      diagnoses: [{ description: 'Acute upper respiratory infection, unspecified', code: 'J06.9', kind: 'primary' }],
      prescription: [rx('Paracetamol', '500 mg', '1 tablet', '1-1-1 (when needed for fever)', 3, 'After food'), rx('Cetirizine', '10 mg', '1 tablet', '0-0-1', 3, 'At night')],
    },
  },
  {
    daysAgo: 58,
    hour: 11,
    c: {
      complaint: 'Blood pressure follow-up',
      vitals: [
        { kind: 'temperature', value: 36.7 },
        { kind: 'heart_rate', value: 76 },
        { kind: 'systolic_bp', value: 128 },
        { kind: 'diastolic_bp', value: 84 },
        { kind: 'spo2', value: 98 },
        { kind: 'blood_glucose', value: 138 },
      ],
      note: {
        history: 'Routine follow-up for hypertension. No headache, chest pain or breathlessness. Adherent to amlodipine.',
        examination: 'BP 128/84 mmHg. Heart sounds normal. No pedal oedema.',
        assessment: 'Essential hypertension, controlled on current treatment.',
        plan: 'Continue amlodipine 5 mg once daily. Salt restriction, daily walk 30 minutes.',
        followUp: 'Review in 2 months with fasting blood sugar and lipid profile.',
      },
      diagnoses: [{ description: 'Essential (primary) hypertension', code: 'I10', kind: 'primary' }],
      prescription: [rx('Amlodipine', '5 mg', '1 tablet', '1-0-0', 60, 'Morning, after breakfast')],
    },
  },
  {
    daysAgo: 116,
    hour: 9,
    c: {
      complaint: 'Diabetes review',
      vitals: [
        { kind: 'temperature', value: 36.6 },
        { kind: 'heart_rate', value: 74 },
        { kind: 'systolic_bp', value: 126 },
        { kind: 'diastolic_bp', value: 82 },
        { kind: 'spo2', value: 99 },
        { kind: 'blood_glucose', value: 146 },
        { kind: 'weight', value: 78 },
      ],
      note: {
        history: 'Diabetes review. Occasional evening snacks. No hypoglycaemic episodes. HbA1c 7.1 %.',
        examination: 'Weight 78 kg. Feet: pulses present, no ulcers, sensation intact.',
        assessment: 'Type 2 diabetes mellitus, fair control (HbA1c 7.1 %).',
        plan: 'Continue metformin 500 mg twice daily. Diet counselling: reduce refined carbohydrates. Add atorvastatin 10 mg at night.',
        followUp: 'Review in 3 months with HbA1c.',
      },
      diagnoses: [{ description: 'Type 2 diabetes mellitus without complications', code: 'E11.9', kind: 'primary' }],
      prescription: [rx('Metformin', '500 mg', '1 tablet', '1-0-1', 90, 'After food'), rx('Atorvastatin', '10 mg', '1 tablet', '0-0-1', 90, 'At night')],
    },
  },
  {
    daysAgo: 172,
    hour: 10,
    c: {
      complaint: 'Cough and cold for four days',
      vitals: [
        { kind: 'temperature', value: 37.4 },
        { kind: 'heart_rate', value: 80 },
        { kind: 'systolic_bp', value: 130 },
        { kind: 'diastolic_bp', value: 84 },
        { kind: 'spo2', value: 97 },
        { kind: 'blood_glucose', value: 140 },
      ],
      note: {
        history: 'Cough with cold for four days, low-grade fever on the first day. Non-smoker.',
        examination: 'Chest: few scattered rhonchi, no crackles. Throat mildly congested.',
        assessment: 'Acute bronchitis.',
        plan: 'Steam inhalation, warm fluids. Cough syrup at night. Return if breathless or high fever.',
        followUp: 'Review in 5 days if not improving.',
      },
      diagnoses: [{ description: 'Acute bronchitis, unspecified', code: 'J20.9', kind: 'primary' }],
      prescription: [rx('Dextromethorphan syrup', '10 mg/5 mL', '10 mL', '0-0-1', 5, 'At night', 'Syrup'), rx('Paracetamol', '500 mg', '1 tablet', '1-1-1 (when needed)', 3, 'After food')],
    },
  },
]

/** Ramesh's laboratory results (staff-entered, synthetic). */
const RAMESH_RESULTS = (dayOf: (daysAgo: number) => string) => [
  { testName: 'HbA1c', valueText: '7.1', valueNumber: 7.1, unit: '%', refText: '< 5.7', collectedOn: dayOf(118), resultedOn: dayOf(117) },
  { testName: 'Fasting blood sugar', valueText: '142', valueNumber: 142, unit: 'mg/dL', refLow: 70, refHigh: 100, collectedOn: dayOf(118), resultedOn: dayOf(117) },
  { testName: 'Haemoglobin', valueText: '14.2', valueNumber: 14.2, unit: 'g/dL', refLow: 13, refHigh: 17, collectedOn: dayOf(12), resultedOn: dayOf(12) },
  { testName: 'Total leucocyte count', valueText: '8600', valueNumber: 8600, unit: '/µL', refLow: 4000, refHigh: 11000, collectedOn: dayOf(12), resultedOn: dayOf(12) },
  { testName: 'Platelet count', valueText: '2.6', valueNumber: 2.6, unit: 'lakh/µL', refLow: 1.5, refHigh: 4.5, collectedOn: dayOf(12), resultedOn: dayOf(12) },
  { testName: 'Total cholesterol', valueText: '196', valueNumber: 196, unit: 'mg/dL', refHigh: 200, refLow: 0, collectedOn: dayOf(60), resultedOn: dayOf(59) },
  { testName: 'LDL cholesterol', valueText: '118', valueNumber: 118, unit: 'mg/dL', refLow: 0, refHigh: 100, collectedOn: dayOf(60), resultedOn: dayOf(59) },
  { testName: 'Serum creatinine', valueText: '0.9', valueNumber: 0.9, unit: 'mg/dL', refLow: 0.7, refHigh: 1.3, collectedOn: dayOf(60), resultedOn: dayOf(59) },
]

/** Reasons and short consultations for the rest of the clinic (rotated deterministically). */
const COMMON: ConsultSpec[] = [
  {
    complaint: 'Cough for one week',
    vitals: [{ kind: 'temperature', value: 37.2 }, { kind: 'heart_rate', value: 82 }, { kind: 'systolic_bp', value: 122 }, { kind: 'diastolic_bp', value: 78 }, { kind: 'spo2', value: 98 }],
    note: { history: 'Dry cough for a week after a cold. No fever now.', examination: 'Chest clear. Throat mildly congested.', assessment: 'Post-viral cough.', plan: 'Warm fluids, steam inhalation. Cough syrup at night.', followUp: 'Review if not better in a week.' },
    diagnoses: [{ description: 'Cough', code: 'R05', kind: 'primary' }],
    prescription: [rx('Dextromethorphan syrup', '10 mg/5 mL', '10 mL', '0-0-1', 5, 'At night', 'Syrup')],
  },
  {
    complaint: 'Lower back pain',
    vitals: [{ kind: 'temperature', value: 36.8 }, { kind: 'heart_rate', value: 76 }, { kind: 'systolic_bp', value: 124 }, { kind: 'diastolic_bp', value: 80 }, { kind: 'spo2', value: 99 }],
    note: { history: 'Lower back pain for 5 days after lifting. No leg weakness or numbness.', examination: 'Paraspinal tenderness. Straight leg raise negative.', assessment: 'Mechanical low back pain.', plan: 'Rest, heat, back exercises. Analgesic when needed.', followUp: 'Review in 2 weeks if persistent.' },
    diagnoses: [{ description: 'Low back pain', code: 'M54.5', kind: 'primary' }],
    prescription: [rx('Paracetamol', '650 mg', '1 tablet', '1-0-1 (when needed)', 5, 'After food')],
  },
  {
    complaint: 'Headache for three days',
    vitals: [{ kind: 'temperature', value: 36.9 }, { kind: 'heart_rate', value: 78 }, { kind: 'systolic_bp', value: 118 }, { kind: 'diastolic_bp', value: 76 }, { kind: 'spo2', value: 99 }],
    note: { history: 'Throbbing headache, worse with light. No vomiting, no weakness.', examination: 'Neurological examination normal.', assessment: 'Migraine without aura.', plan: 'Analgesic at onset. Sleep hygiene, avoid triggers.', followUp: 'Review if more than 4 episodes a month.' },
    diagnoses: [{ description: 'Migraine without aura', code: 'G43.009', kind: 'primary' }],
    prescription: [rx('Paracetamol', '500 mg', '1 tablet', 'At onset, up to 3 times a day', 3, 'After food')],
  },
  {
    complaint: 'Fever for two days',
    vitals: [{ kind: 'temperature', value: 38.2 }, { kind: 'heart_rate', value: 94 }, { kind: 'systolic_bp', value: 120 }, { kind: 'diastolic_bp', value: 78 }, { kind: 'spo2', value: 98 }],
    note: { history: 'Fever with body ache for two days. No cough, no urinary symptoms.', examination: 'Throat normal. Chest clear. No rash.', assessment: 'Acute febrile illness, likely viral.', plan: 'Antipyretic, fluids, rest. Return if fever beyond 3 days.', followUp: 'Review in 3 days if fever persists.' },
    diagnoses: [{ description: 'Fever, unspecified', code: 'R50.9', kind: 'primary' }],
    prescription: [rx('Paracetamol', '500 mg', '1 tablet', '1-1-1', 3, 'After food')],
  },
  {
    complaint: 'Knee pain',
    vitals: [{ kind: 'temperature', value: 36.7 }, { kind: 'heart_rate', value: 74 }, { kind: 'systolic_bp', value: 132 }, { kind: 'diastolic_bp', value: 84 }, { kind: 'spo2', value: 98 }],
    note: { history: 'Right knee pain on climbing stairs for a month.', examination: 'Crepitus right knee, no effusion.', assessment: 'Osteoarthritis of the right knee.', plan: 'Quadriceps exercises, weight reduction, analgesic when needed.', followUp: 'Review in 4 weeks.' },
    diagnoses: [{ description: 'Osteoarthritis of knee', code: 'M17.9', kind: 'primary' }],
    prescription: [rx('Paracetamol', '650 mg', '1 tablet', '1-0-1 (when needed)', 10, 'After food')],
  },
  {
    complaint: 'Thyroid follow-up',
    vitals: [{ kind: 'temperature', value: 36.6 }, { kind: 'heart_rate', value: 72 }, { kind: 'systolic_bp', value: 118 }, { kind: 'diastolic_bp', value: 76 }, { kind: 'spo2', value: 99 }],
    note: { history: 'Hypothyroidism follow-up. Feeling well. TSH 3.2 last month.', examination: 'No goitre. Pulse regular.', assessment: 'Hypothyroidism, controlled.', plan: 'Continue levothyroxine 50 mcg.', followUp: 'TSH in 6 months.' },
    diagnoses: [{ description: 'Hypothyroidism, unspecified', code: 'E03.9', kind: 'primary' }],
    prescription: [rx('Levothyroxine', '50 mcg', '1 tablet', '1-0-0 (empty stomach)', 90, '30 minutes before breakfast')],
  },
]

/** A tiny valid PDF (synthetic report): Helvetica text lines on one A4 page. */
export function syntheticReportPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')
  const content = ['BT', '/F1 11 Tf', '14 TL', '56 780 Td', ...lines.flatMap((l, i) => (i === 0 ? [`/F1 15 Tf (${esc(l)}) Tj`, '/F1 11 Tf', 'T*', 'T*'] : [`(${esc(l)}) Tj`, 'T*'])), 'ET'].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Holds the clock the API reads at one moment while `fn` runs (its requests only), then puts it back (as hero-demo.ts). */
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

/** A small deterministic generator, so every run makes the same history. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export interface JuryDemoResult {
  skipped: boolean
  ramesh: { patientId: string; mrn: string; visitId: string } | null
  today: { completed: number; inConsultation: number; waiting: number; yetToSee: number }
  pastConsultations: number
  patients: number
}

export async function seedJuryDemo(opts: { config?: Config; password?: string; log?: (m: string) => void; simDir?: string; historyDays?: number } = {}): Promise<JuryDemoResult> {
  const log = opts.log ?? ((m: string) => console.log(`[jury-demo] ${m}`))
  if (!opts.config) loadDotEnv()
  const config = opts.config ?? loadConfig()
  const password = opts.password ?? process.env.SEED_DEMO_PASSWORD
  if (!password) throw new Error('SEED_DEMO_PASSWORD is not set (run `npm run setup`).')
  if (config.env === 'production') throw new Error('Refusing: this is a production deployment.')
  if (config.dataOrigin !== 'synthetic') throw new Error('Refusing: DATA_ORIGIN is not "synthetic". The jury demo is fictional and is only seeded into a synthetic deployment.')
  const simDir = opts.simDir ?? path.join(REPO_ROOT, '.data', 'sim')
  const historyDays = opts.historyDays ?? 27

  const pool = createAppPool(config.db)
  const app = buildApp({ config, pool, logger: false })
  const db = createDb(pool)
  const admin = createAdminClient(config.db)
  await admin.connect()
  try {
    const facility = await db.query.facilities.findFirst({ where: eq(facilities.code, 'DEMO-OPD-01') })
    if (!facility) throw new Error('The synthetic facility is missing. Run `npm run db:seed` first.')
    if (!facility.name.endsWith('(synthetic)')) throw new Error('Refusing: the facility is not marked synthetic.')
    const [clinical] = await db.select({ n: sql<number>`count(*)::int` }).from(patients).where(eq(patients.dataOrigin, 'clinical'))
    if (clinical!.n > 0) throw new Error('Refusing: this database holds patients marked as clinical.')
    const doctorRow = await db.query.users.findFirst({ where: eq(users.username, DOCTOR) })
    if (!doctorRow || doctorRow.facilityId !== facility.id) throw new Error(`Refusing: ${DOCTOR} is not an account of the synthetic facility.`)
    const doctorId = doctorRow.id

    async function session(username: string) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-adaxai-csrf': '1' }, payload: { username, password } })
      if (res.statusCode !== 200) throw new Error(`sign-in as ${username} failed (${res.statusCode}). Run npm run db:seed first.`)
      const cookie = res.cookies.find((c) => c.name === 'adaxai_session')!
      const headers = { cookie: `adaxai_session=${cookie.value}`, 'x-adaxai-csrf': '1' }
      const call = async (method: InjectOptions['method'], url: string, payload?: unknown) => {
        const r = await app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as InjectOptions['payload'] }) })
        if (r.statusCode >= 400) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body.slice(0, 300)}`)
        return r.body ? r.json() : null
      }
      const upload = async (url: string, fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) => {
        const boundary = `----jury${Math.random().toString(16).slice(2)}`
        const parts: Buffer[] = []
        for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`))
        const r = await app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) })
        if (r.statusCode >= 400) throw new Error(`POST ${url}: ${r.statusCode} ${r.body.slice(0, 300)}`)
        return r.json()
      }
      return { call, upload }
    }
    const nurse = await session('nurse.anil')
    const doctor = await session(DOCTOR)
    const registry = await session('admin')
    const gen = ((await nurse.call('GET', '/api/departments')).departments as { id: string; code: string }[]).find((d) => d.code === 'GEN')
    if (!gen) throw new Error('The GEN department is missing. Run `npm run db:seed` first.')
    const today = ((await nurse.call('GET', '/api/appointments/options')) as { today: string }).today
    const dayOf = (daysAgo: number) => new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) - daysAgo)).toISOString().slice(0, 10)

    // Already seeded today: stop without changes.
    const existing = ((await nurse.call('GET', `/api/patients?q=${encodeURIComponent('Ramesh Kumar')}&limit=20`)).patients as { id: string; fullName: string; dateOfBirth: string; mrn: string; lastVisitDate: string | null }[]).find(
      (p) => p.fullName === 'Ramesh Kumar' && p.dateOfBirth === RAMESH.dob,
    )
    // Any visit of his today (waiting, with the doctor or already completed) means the queue was made: the visits themselves are read, not a summary date.
    const visitedToday =
      !!existing &&
      (existing.lastVisitDate === today || ((await nurse.call('GET', `/api/patients/${existing.id}/visits`)).visits as { visitDate: string }[]).some((v) => v.visitDate === today))
    if (visitedToday) {
      log(`The jury clinic already has today's queue (Ramesh Kumar, ${existing.mrn}). Nothing changed. For a fresh demo, recreate the development database and run it again.`)
      return { skipped: true, ramesh: null, today: { completed: 0, inConsultation: 0, waiting: 0, yetToSee: 0 }, pastConsultations: 0, patients: 0 }
    }

    // Display names in this DEV database only (the "(synthetic)" marks stay; the app shows them subtly).
    await admin.query(`UPDATE facilities SET name = 'ADAXAI Clinic (synthetic)' WHERE id = $1`, [facility.id])
    await admin.query(`UPDATE users SET registration_number = COALESCE(registration_number, 'TNMC-123456') WHERE id = $1`, [doctorId])
    // The nurse's family name is not shared with the jury's primary patient (Ramesh Kumar), so Mana's patient-name guard never masks it.
    await admin.query(`UPDATE users SET full_name = 'Anil Menon (synthetic)' WHERE username = 'nurse.anil' AND facility_id = $1`, [facility.id])

    // ---- patients ------------------------------------------------------------------------------------------------
    const ids = new Map<string, { id: string; mrn: string; spec: PersonSpec }>()
    const keyOf = (p: PersonSpec) => `${p.given} ${p.family}`
    async function ensurePatient(p: PersonSpec, extra: Record<string, unknown> = {}) {
      const name = keyOf(p)
      const found = ((await nurse.call('GET', `/api/patients?q=${encodeURIComponent(name)}&limit=20`)).patients as { id: string; fullName: string; dateOfBirth: string; mrn: string }[]).find(
        (x) => x.fullName === name && x.dateOfBirth === p.dob,
      )
      if (found) {
        ids.set(name, { id: found.id, mrn: found.mrn, spec: p })
        return { id: found.id, created: false }
      }
      const created = (await nurse.call('POST', '/api/patients', {
        givenName: p.given,
        familyName: p.family,
        dateOfBirth: p.dob,
        sex: p.sex,
        phone: p.phone,
        bloodGroup: p.blood ?? null,
        city: 'Chennai',
        preferredLanguage: 'English',
        confirmNotDuplicate: true,
        ...extra,
      })) as { id: string; mrn: string }
      ids.set(name, { id: created.id, mrn: created.mrn, spec: p })
      for (const type of CONSENTS) await nurse.call('POST', `/api/patients/${created.id}/consents`, { type, method: 'verbal', notes: 'Synthetic demo consent' })
      if (p.allergies?.length) for (const a of p.allergies) await nurse.call('POST', `/api/patients/${created.id}/allergies`, a)
      else await nurse.call('PUT', `/api/patients/${created.id}/no-known-allergies`, { noKnownAllergies: true })
      for (const c of p.conditions ?? []) await doctor.call('POST', `/api/patients/${created.id}/conditions`, { name: c.name, code: c.code, sinceYear: c.sinceYear, status: c.status ?? 'active' })
      for (const m of p.medicines ?? []) await doctor.call('POST', `/api/patients/${created.id}/medications`, { ...m, startedOn: dayOf(120) })
      return { id: created.id, created: true }
    }

    // Ramesh first, with MRN ADX-001245 on a fresh database.
    const seq = await admin.query(`SELECT last_value::int AS v, is_called FROM patient_mrn_seq`)
    const next = seq.rows[0].is_called ? seq.rows[0].v + 1 : seq.rows[0].v
    if (next < RAMESH_MRN_NUMBER) await admin.query(`SELECT setval('patient_mrn_seq', $1, true)`, [RAMESH_MRN_NUMBER - 1])
    const r = await ensurePatient(RAMESH, { emergencyContactName: RAMESH.emergency.name, emergencyContactPhone: RAMESH.emergency.phone, addressLine: '12, 4th Cross Street, Anna Nagar', state: 'Tamil Nadu' })
    if (r.created) await doctor.call('POST', `/api/patients/${r.id}/procedures`, { name: 'Appendectomy (laparoscopic)', performedYear: 2015, performedMonth: 6, note: 'Uneventful recovery.' })
    for (const p of OTHERS) await ensurePatient(p)
    const ramesh = ids.get('Ramesh Kumar')!

    // ---- consultations, past and today -------------------------------------------------------------------------------
    const backdate = async (visitId: string, encounterId: string | null, at: Date, visitDate: string) => {
      await admin.query('BEGIN')
      try {
        await admin.query('SET LOCAL session_replication_role = replica')
        await admin.query(
          `UPDATE visits SET visit_date = $2::date, checked_in_at = $3, status_changed_at = GREATEST(status_changed_at, $3),
             token_number = CASE WHEN visit_date = $2::date THEN token_number ELSE (SELECT coalesce(max(v2.token_number), 0) + 1 FROM visits v2 WHERE v2.facility_id = visits.facility_id AND v2.visit_date = $2::date) END
           WHERE id = $1`,
          [visitId, visitDate, new Date(at.getTime() - 25 * 60_000).toISOString()],
        )
        if (encounterId) await admin.query('UPDATE encounters SET started_at = $2 WHERE id = $1', [encounterId, new Date(at.getTime() - 12 * 60_000).toISOString()])
        await admin.query('COMMIT')
      } catch (err) {
        await admin.query('ROLLBACK').catch(() => undefined)
        throw err
      }
    }
    async function consultation(patientId: string, at: Date, visitDate: string, c: ConsultSpec, opts2: { complete: boolean } = { complete: true }) {
      const v = await nurse.call('POST', '/api/visits', { patientId, departmentId: gen!.id, assignedDoctorId: doctorId, chiefComplaint: c.complaint })
      await nurse.call('POST', `/api/visits/${v.id}/observations`, { items: c.vitals, measuredAt: new Date(at.getTime() - 20 * 60_000).toISOString() })
      await nurse.call('POST', `/api/visits/${v.id}/status`, { status: 'ready' })
      const e = await doctor.call('POST', `/api/visits/${v.id}/encounter`)
      await backdate(v.id, e.id, at, visitDate)
      const saved = await doctor.call('PUT', `/api/encounters/${e.id}/draft`, {
        version: e.version,
        note: { chiefComplaint: c.complaint, pastHistory: '', ...c.note },
        diagnoses: c.diagnoses,
        prescription: c.prescription.map((p) => ({ ...p, startDate: visitDate })),
      })
      if (opts2.complete) {
        await withClockAt(at, () => doctor.call('POST', `/api/encounters/${e.id}/sign`, { version: saved.version, attestation: true }))
        await withClockAt(new Date(at.getTime() + 2 * 60_000), () => doctor.call('POST', `/api/encounters/${e.id}/complete`, {}))
      }
      return { visitId: v.id as string, encounterId: e.id as string }
    }
    const atDaysAgo = (daysAgo: number, hour: number, minute = 0) => {
      const d = new Date(Date.now() - daysAgo * 86_400_000)
      d.setHours(hour, minute, 0, 0)
      return d
    }

    // Ramesh's history (only when he was created in this run).
    let pastConsultations = 0
    if (r.created) {
      for (const p of [...RAMESH_PAST].reverse()) {
        await consultation(ramesh.id, atDaysAgo(p.daysAgo, p.hour), dayOf(p.daysAgo), p.c)
        pastConsultations++
      }
      for (const res of RAMESH_RESULTS(dayOf)) await doctor.call('POST', `/api/patients/${ramesh.id}/investigations`, res)
      const cbc = syntheticReportPdf([
        'ADAXAI Clinic Laboratory - Complete blood count (SYNTHETIC REPORT)',
        `Patient: Ramesh Kumar   MRN: ${ramesh.mrn}   Collected: ${dayOf(12)}`,
        'Haemoglobin 14.2 g/dL (13-17)',
        'Total leucocyte count 8600 /uL (4000-11000)',
        'Neutrophils 68 %   Lymphocytes 26 %',
        'Platelet count 2.6 lakh/uL (1.5-4.5)',
        'Impression: within normal limits.',
        'Synthetic document for a software demonstration. Not a real laboratory report.',
      ])
      await nurse.upload(`/api/patients/${ramesh.id}/documents`, { category: 'lab_report', title: 'Complete blood count (CBC)', studyDate: dayOf(12), reportText: 'Haemoglobin 14.2 g/dL; TLC 8600/µL; platelets 2.6 lakh/µL. Within normal limits.' }, { name: 'cbc-report.pdf', type: 'application/pdf', data: cbc })
      const cxr = syntheticReportPdf([
        'ADAXAI Clinic Imaging - Chest X-ray PA view (SYNTHETIC REPORT)',
        `Patient: Ramesh Kumar   MRN: ${ramesh.mrn}   Study date: ${dayOf(172)}`,
        'Findings: lung fields clear. No consolidation or effusion.',
        'Cardiac silhouette within normal limits. Costophrenic angles clear.',
        'Impression: no active lung lesion.',
        'Synthetic document for a software demonstration. Not a real radiology report.',
      ])
      await nurse.upload(`/api/patients/${ramesh.id}/documents`, { category: 'imaging_report', modality: 'xray', title: 'Chest X-ray (PA view)', studyDate: dayOf(172), reportText: 'Lung fields clear. No consolidation or effusion. Cardiac silhouette normal. Impression: no active lung lesion.' }, { name: 'chest-xray-report.pdf', type: 'application/pdf', data: cxr })
    }

    // Four weeks of the clinic's earlier consultations (not Sundays), from the other patients, deterministic.
    const others = OTHERS.map((p) => ids.get(keyOf(p))!)
    const rand = rng(20261007)
    for (let d = historyDays; d >= 1; d--) {
      const day = atDaysAgo(d, 9)
      if (day.getDay() === 0) continue
      const n = 3 + Math.floor(rand() * 4)
      const used = new Set<string>()
      for (let i = 0; i < n; i++) {
        let p = others[Math.floor(rand() * others.length)]!
        for (let t = 0; t < 5 && used.has(p.id); t++) p = others[Math.floor(rand() * others.length)]!
        if (used.has(p.id)) continue
        used.add(p.id)
        // A thyroid follow-up only for the patient who has hypothyroidism; the other visits are short, ordinary complaints.
        const spec = p.spec.given === 'Fatima' && rand() < 0.5 ? COMMON[5]! : COMMON[Math.floor(rand() * 5)]!
        await consultation(p.id, atDaysAgo(d, 9 + i, Math.floor(rand() * 4) * 15), dayOf(d), spec)
        pastConsultations++
      }
    }

    // ---- today's queue (times relative to now, on 5-minute marks) ------------------------------------------------------
    const now = new Date(Math.floor(Date.now() / (5 * 60_000)) * 5 * 60_000)
    const minus = (m: number) => new Date(now.getTime() - m * 60_000)
    const byName = (n: string) => ids.get(n)!
    const completedToday: [string, number, ConsultSpec][] = [
      ['Priya Sharma', 150, COMMON[0]!],
      ['Arjun Mehta', 130, COMMON[1]!],
      ['Fatima Begum', 110, COMMON[5]!],
      ['Vikram Singh', 90, COMMON[2]!],
      ['Meena Pillai', 70, COMMON[4]!],
    ]
    for (const [name, ago, c] of completedToday) await consultation(byName(name).id, minus(ago), today, c)

    // In consultation: Abdul Rahman (BP follow-up), Dr. Meera's draft, with a pending SIMULATED laboratory order.
    const abdul = byName('Abdul Rahman')
    const av = await nurse.call('POST', '/api/visits', { patientId: abdul.id, departmentId: gen.id, assignedDoctorId: doctorId, chiefComplaint: 'BP follow-up' })
    await nurse.call('POST', `/api/visits/${av.id}/observations`, { items: [{ kind: 'systolic_bp', value: 138 }, { kind: 'diastolic_bp', value: 88 }, { kind: 'heart_rate', value: 80 }, { kind: 'spo2', value: 98 }, { kind: 'temperature', value: 36.8 }] })
    await nurse.call('POST', `/api/visits/${av.id}/status`, { status: 'ready' })
    const ae = await doctor.call('POST', `/api/visits/${av.id}/encounter`)
    await backdate(av.id, ae.id, minus(40), today)
    await doctor.call('PUT', `/api/encounters/${ae.id}/draft`, { version: ae.version, note: { chiefComplaint: 'BP follow-up', history: 'Occasional morning headache. Adherent to telmisartan.', pastHistory: '', examination: '', assessment: '', plan: '', followUp: '' }, diagnoses: [], prescription: [] })
    await doctor.call('POST', `/api/encounters/${ae.id}/service-orders`, { serviceCode: 'LIPID', note: 'Annual cardiovascular risk review', idempotencyKey: crypto.randomUUID() })

    // Waiting: Ramesh first (ready), then the others (ready / in triage / waiting).
    const rv = await nurse.call('POST', '/api/visits', { patientId: ramesh.id, departmentId: gen.id, assignedDoctorId: doctorId, chiefComplaint: 'Fever and cough for 3 days' })
    await nurse.call('POST', `/api/visits/${rv.id}/observations`, {
      items: [
        { kind: 'temperature', value: 37.8 },
        { kind: 'heart_rate', value: 92 },
        { kind: 'systolic_bp', value: 128 },
        { kind: 'diastolic_bp', value: 84 },
        { kind: 'spo2', value: 98 },
        { kind: 'respiratory_rate', value: 18 },
        { kind: 'blood_glucose', value: 146 },
        { kind: 'weight', value: 77 },
      ],
    })
    await nurse.call('PUT', `/api/visits/${rv.id}/triage-note`, { note: 'Fever for 3 days with mild productive cough. No chest pain. Mild breathlessness on climbing stairs. Known diabetic and hypertensive, on regular medicines. Penicillin allergy (rash).' })
    await nurse.call('POST', `/api/visits/${rv.id}/status`, { status: 'ready' })
    await backdate(rv.id, null, minus(5), today)
    const waiting: [string, number, string, 'ready' | 'in_triage' | 'waiting', { kind: string; value: number }[]][] = [
      ['Lakshmi N', 25, 'Headache', 'ready', [{ kind: 'temperature', value: 36.9 }, { kind: 'heart_rate', value: 78 }, { kind: 'systolic_bp', value: 118 }, { kind: 'diastolic_bp', value: 76 }, { kind: 'spo2', value: 99 }]],
      ['Suresh Babu', 20, 'Diabetes review', 'waiting', []],
      ['Ananya Rao', 15, 'Fever', 'in_triage', []],
      ['Karthik Raj', 10, 'Sore throat', 'waiting', []],
      ['Divya Nair', 5, 'Skin rash', 'waiting', []],
    ]
    for (const [name, ago, reason, status, vitals] of waiting) {
      const v = await nurse.call('POST', '/api/visits', { patientId: byName(name).id, departmentId: gen.id, assignedDoctorId: doctorId, chiefComplaint: reason })
      if (vitals.length) await nurse.call('POST', `/api/visits/${v.id}/observations`, { items: vitals })
      if (status !== 'waiting') await nurse.call('POST', `/api/visits/${v.id}/status`, { status })
      await backdate(v.id, null, minus(ago - 25), today)
    }

    // Yet to see: booked appointments later today.
    const booked: [string, number, string][] = [
      ['Mohammed Irfan', 20, 'Acidity'],
      ['Sneha Reddy', 35, 'Follow-up'],
      ['Ravi Shankar', 50, 'Breathlessness review'],
      ['Kavya Iyer', 65, 'Fever'],
      ['Harish Menon', 80, 'Lipid review'],
      ['Nandini Das', 95, 'Joint pain'],
      ['Gopal Krishnan', 110, 'BP check'],
      ['Rekha Varma', 125, 'General check-up'],
    ]
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    let yetToSee = 0
    for (const [name, inMin, reason] of booked) {
      const at = new Date(now.getTime() + inMin * 60_000)
      if (at.toDateString() !== now.toDateString()) continue // past midnight: not today
      await nurse.call('POST', '/api/appointments', { patientId: byName(name).id, departmentId: gen.id, doctorId, date: today, time: hhmm(at), reason, idempotencyKey: crypto.randomUUID() })
      yetToSee++
    }

    // ---- simulators (programs, never devices) and the patient app ---------------------------------------------------------
    let list = (await registry.call('GET', '/api/devices')) as { devices: Device[]; simulatorAllowed: boolean }
    if (list.simulatorAllowed) {
      for (const spec of [BAND, STETH]) {
        if (!list.devices.some((d) => d.serialNumber === spec.serialNumber)) await registry.call('POST', '/api/admin/devices', { ...spec, integration: 'simulator', manufacturer: 'ADAXAI', model: 'device-sim-v1', notes: 'A program that generates values for the synthetic jury demo. Not a device.' })
      }
      list = (await nurse.call('GET', '/api/devices')) as typeof list
      const band = list.devices.find((d) => d.serialNumber === BAND.serialNumber)!
      if (!band.assignment) await nurse.call('POST', `/api/devices/${band.id}/assignments`, { patientId: ramesh.id, visitId: rv.id })
    }
    const code = ((await nurse.call('POST', `/api/patients/${ramesh.id}/portal-activation`)) as { activationCode: string }).activationCode
    fs.mkdirSync(simDir, { recursive: true })
    fs.writeFileSync(path.join(simDir, 'jury-portal.txt'), `Patient app (synthetic): MRN ${ramesh.mrn}\nActivation code: ${code}\n`, { mode: 0o600 })

    const result: JuryDemoResult = {
      skipped: false,
      ramesh: { patientId: ramesh.id, mrn: ramesh.mrn, visitId: rv.id },
      today: { completed: completedToday.length, inConsultation: 1, waiting: waiting.length + 1, yetToSee },
      pastConsultations,
      patients: ids.size,
    }
    log(`ADAXAI Clinic (synthetic): ${ids.size} fictional patients; ${pastConsultations} earlier consultations (signed and completed).`)
    log(`Ramesh Kumar (${ramesh.mrn}): hypertension, type 2 diabetes, penicillin allergy, 3 medicines, appendectomy, 4 earlier consultations, results, 2 reports; today's visit ready for Dr. Meera.`)
    log(`Today: ${result.today.completed} completed, 1 in consultation, ${result.today.waiting} waiting, ${yetToSee} booked (total ${result.today.completed + 1 + result.today.waiting + yetToSee}).`)
    log(`Simulator band ${BAND.serialNumber} attached to Ramesh for today; simulator stethoscope ${STETH.serialNumber} registered (SIMULATORS, not devices).`)
    log(`Patient-app activation for Ramesh written to ${path.relative(REPO_ROOT, path.join(simDir, 'jury-portal.txt')).split(path.sep).join('/')} (git-ignored; never printed).`)
    return result
  } finally {
    await admin.end()
    await app.close()
    await pool.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await seedJuryDemo()
  } catch (e) {
    console.error(`[jury-demo] ERROR ${(e as Error).message}`)
    process.exitCode = 1
  }
}
